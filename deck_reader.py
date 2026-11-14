"""
Reads a lecture deck with Gemini in two steps, so the student isn't stuck
waiting for everything at once:

  1. outline_deck()  runs on upload. It only LISTS the sections and examples
     (titles, slide ranges, which visualizer). Short output, so it's fast.

  2. write_code()    runs when the student clicks Visualize. It looks at only
     that example's slides and writes the runnable Python for it.

Step explanations and quiz questions are NOT asked of Gemini here: they come
from the tracer, built from the real trace.

Based on the teammate's test_apicall (same idea and schema), split for speed.
"""
import json
import os
import time

import fitz  # pymupdf
from dotenv import load_dotenv
from google import genai
from google.genai import errors, types
from pydantic import BaseModel

load_dotenv()

# gemini-3.8-flash hung on every request when we tested (Nov 14), so default to
# gemini-3.6-flash, which answered in ~2s. Flash-Lite (gemini-3.5-flash-lite) is
# faster but missed obvious examples when listing a deck.
# Override in .env to try others: GEMINI_OUTLINE_MODEL=..., GEMINI_CODE_MODEL=...
OUTLINE_MODEL = os.environ.get("GEMINI_OUTLINE_MODEL", "gemini-3.6-flash")
CODE_MODEL = os.environ.get("GEMINI_CODE_MODEL", "gemini-3.6-flash")
THINKING_LEVEL = os.environ.get("GEMINI_THINKING_LEVEL", "LOW")  # MINIMAL / LOW / MEDIUM / HIGH

# Give up instead of hanging forever. Seconds per request, and how many tries.
TIMEOUT_S = int(os.environ.get("GEMINI_TIMEOUT_S", "90"))
ATTEMPTS = 2

SUPPORTED_VISUALIZERS = {"tree", "array"}

# Bump this whenever the prompts change, so the server re-reads decks it has
# already saved results for instead of reusing results from the old prompt.
CACHE_VERSION = "2"

_client = None


def client():
    global _client
    if _client is None:
        _client = genai.Client(
            api_key=os.environ["GEMINI_API_KEY"],
            http_options=types.HttpOptions(
                timeout=TIMEOUT_S * 1000,  # the SDK takes milliseconds
                retry_options=types.HttpRetryOptions(attempts=ATTEMPTS),
            ),
        )
    return _client


# ---------- Schemas ----------

class Section(BaseModel):
    slide_start: int
    slide_end: int
    title: str
    summary: str


class ExampleOutline(BaseModel):
    slide_start: int
    slide_end: int
    title: str
    visualizer: str               # "tree", "array", or "none"
    supported: bool
    unsupported_reason: str | None


class DeckOutline(BaseModel):
    sections: list[Section]
    examples: list[ExampleOutline]


class ExampleCode(BaseModel):
    original_code: str            # the code/pseudocode exactly as on the slide
    python_code: str              # self-contained, runnable
    function_name: str            # which function in python_code to call
    args_json: str                # JSON list of arguments, e.g. "[[3, 1, 4]]" or "[3]"
    call_label: str               # how a call looks in the slide's notation, e.g. "sum {xs}"
    expected_result: str | None   # the answer the slide states, if it states one


# ---------- Prompts ----------

OUTLINE_PROMPT = """
You are reading a CS lecture deck. Be brief: this is a quick index, not an explanation.
We will animate how a function runs, step by step, for a student.

1. Group consecutive slides on the same topic into sections. One short title and a
   one-sentence summary each.
2. List every slide (or run of slides) that DEFINES a function we could run and
   animate. The slide does NOT need to show it being run on an input; we will pick
   a small input ourselves. Include:
   - any recursive function (e.g. sum n = n + sum (n - 1), factorial, fib,
     length of a list, map/filter written recursively, tree traversals)
   - any function that processes an array or list step by step (sorting,
     searching, accumulating)
   If the same function appears on several slides (e.g. two ways to write it),
   list it ONCE with slide_start and slide_end. Don't skip simple examples:
   simple ones are the best to animate.
3. visualizer: "tree" for recursion, "array" for sorting/searching over an array,
   "none" if it fits neither.
4. supported=false (with a one-line reason) ONLY if running it as ordinary Python
   would show the wrong thing: it depends on lazy evaluation or infinite lists,
   evaluation/reduction order, type-level ideas, monads/IO, or concurrency.
   Type signatures alone (e.g. "length :: [t] -> Int") with no definition are not
   examples; leave them out.

Only use what is on the slides. Do not write any code yet.
"""

CODE_PROMPT = """
These slides show one worked example from a CS lecture: "{title}".

Write:
- original_code: the code or pseudocode exactly as shown on the slides.
- python_code: an equivalent, self-contained Python function. No imports, no input(),
  no print(). Follow the slide's version of the algorithm exactly (same base cases,
  same order of recursive calls, same variable names where possible).
- function_name: the name of the function the example calls.
- args_json: the example's input as a JSON list of arguments for that function,
  e.g. "[3]" for fib(3) or "[[3, 1, 4]]" for sum [3,1,4]. Use the input from the
  slides if they show one. If they don't, choose a small input that makes a short,
  clear animation (about 4 to 15 calls), e.g. "[4]" for sum n or "[[3, 1, 4]]"
  for a list function.
- call_label: how one call should be displayed in the slide's own notation, using
  parameter names in braces, e.g. "fib({{n}})" or "sum {{xs}}".
- expected_result: the final answer if the slides state it, otherwise null.
"""


# ---------- Gemini call helper ----------

def _generate(model, contents, schema):
    """Call Gemini, turning a hang into a clear error message."""
    try:
        return _generate_inner(model, contents, schema)
    except Exception as e:
        if "timeout" in type(e).__name__.lower() or "timed out" in str(e).lower():
            raise RuntimeError(f"{model} didn't answer within {TIMEOUT_S}s. Try another model in .env.") from e
        raise


def _generate_inner(model, contents, schema):
    """Call Gemini with structured output and low thinking. If the model rejects
    the thinking setting, retry once without it."""
    config = {
        "response_mime_type": "application/json",
        "response_schema": schema,
        "thinking_config": {"thinking_level": THINKING_LEVEL},
    }
    print(f"[gemini] calling {model}…")
    try:
        response = client().models.generate_content(model=model, contents=contents, config=config)
    except errors.ClientError as e:
        if "think" not in str(e).lower():
            raise
        print("Model rejected the thinking setting; retrying without it.")
        config.pop("thinking_config")
        response = client().models.generate_content(model=model, contents=contents, config=config)

    if response.parsed is None:
        raise RuntimeError("Gemini's reply couldn't be parsed (it may have been cut off).")
    return response.parsed


def _clamp(start, end, num_pages):
    start = max(1, min(start, num_pages))
    end = max(start, min(end, num_pages))
    return start, end


# ---------- Step 1: on upload ----------

def outline_deck(pdf_path, out_dir):
    """Render slide images and list sections + examples. Writes out_dir/examples.json."""
    t0 = time.time()
    os.makedirs(f"{out_dir}/slides", exist_ok=True)
    doc = fitz.open(pdf_path)
    for i, page in enumerate(doc, start=1):
        page.get_pixmap(dpi=100).save(f"{out_dir}/slides/slide_{i}.png")
    num_pages = len(doc)
    print(f"[outline] rendered {num_pages} slides in {time.time() - t0:.1f}s")

    t1 = time.time()
    with open(pdf_path, "rb") as f:
        pdf_part = types.Part.from_bytes(data=f.read(), mime_type="application/pdf")
    outline = _generate(OUTLINE_MODEL, [pdf_part, OUTLINE_PROMPT], DeckOutline)
    print(f"[outline] Gemini took {time.time() - t1:.1f}s, found {len(outline.examples)} examples")

    result = outline.model_dump()
    for s in result["sections"]:
        s["slide_start"], s["slide_end"] = _clamp(s["slide_start"], s["slide_end"], num_pages)
    for ex in result["examples"]:
        ex["slide_start"], ex["slide_end"] = _clamp(ex["slide_start"], ex["slide_end"], num_pages)
        if ex["visualizer"] not in SUPPORTED_VISUALIZERS:
            ex["supported"] = False
            ex["unsupported_reason"] = ex["unsupported_reason"] or "Visualizer not built yet"

    with open(f"{out_dir}/examples.json", "w") as f:
        json.dump(result, f, indent=2)
    return result


# ---------- Step 2: when the student clicks Visualize ----------

def write_code(deck_dir, example):
    """Look at only this example's slides and add its code fields to `example`.
    Returns the updated example (also mutates it in place)."""
    if example.get("python_code"):
        return example  # already done earlier

    t0 = time.time()
    parts = []
    for n in range(example["slide_start"], example["slide_end"] + 1):
        with open(f"{deck_dir}/slides/slide_{n}.png", "rb") as f:
            parts.append(types.Part.from_bytes(data=f.read(), mime_type="image/png"))
    parts.append(CODE_PROMPT.format(title=example["title"]))

    code = _generate(CODE_MODEL, parts, ExampleCode).model_dump()
    try:
        code["args"] = json.loads(code.pop("args_json"))
    except json.JSONDecodeError:
        raise RuntimeError(f"Gemini gave arguments that aren't valid JSON for '{example['title']}'.")
    if not code["python_code"].strip():
        raise RuntimeError(f"Gemini didn't write code for '{example['title']}'.")

    example.update(code)
    print(f"[code] '{example['title']}' took {time.time() - t0:.1f}s")
    return example
