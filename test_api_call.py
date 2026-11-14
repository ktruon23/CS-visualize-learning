import os
import sys
import fitz  # pymupdf
from dotenv import load_dotenv
from google import genai
from google.genai import types
from pydantic import BaseModel

load_dotenv()
client = genai.Client(vertexai=True, api_key=os.environ["GEMINI_API_KEY"])

MODEL = "gemini-2.5-flash"   # if "model not found", use the name from the hackathon docs


# ---------- Schema ----------
class QuizQuestion(BaseModel):
    question: str
    choices: list[str]
    answer_index: int

class Example(BaseModel):
    slide_start: int
    slide_end: int
    title: str
    visualizer: str              # "tree", "array", or "none"
    supported: bool
    unsupported_reason: str | None
    original_code: str
    python_code: str
    call_label: str
    input: str
    expected_result: str | None
    step_explanations: list[str]
    quiz: list[QuizQuestion]

class Section(BaseModel):
    slide_start: int
    slide_end: int
    title: str
    summary: str

class DeckResult(BaseModel):
    sections: list[Section]
    examples: list[Example]


# ---------- Prompt ----------
PROMPT = """
You are reading a CS lecture deck.

1. Group consecutive slides that cover the same topic into one section,
   with a short title and a 1-2 sentence summary.
2. Find worked examples that show a computation step by step (recursion,
   sorting, searching). If one example is built up across several slides,
   output it as ONE example using slide_start and slide_end. Only create
   separate examples when the code or input is actually different.
3. Return at most 8 examples. Prefer the clearest recursion and array ones.
4. For each example, write an equivalent Python function in python_code.
   The function must be self-contained and runnable, with no input() calls
   and no imports. Keep step_explanations to one short line each, and
   write at most 2 quiz questions.
5. call_label is a pattern for how a call should be displayed in the
   slide's own notation, using the argument name in braces,
   e.g. "sum {xs}" or "fib({n})".
6. Set supported=false (with a reason) if the example depends on lazy
   evaluation, reduction order, types, or monads. Use visualizer="tree"
   for recursion, "array" for sorting/searching, "none" if unsupported.

Only use information from the slides. Do not invent examples.
"""


# ---------- PDF to slide images ----------
def pdf_to_images(pdf_path, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    doc = fitz.open(pdf_path)
    for i, page in enumerate(doc, start=1):
        page.get_pixmap(dpi=100).save(f"{out_dir}/slide_{i}.png")
    return len(doc)


# ---------- Gemini call (with one retry) ----------
def call_gemini(pdf_path, retries=1):
    with open(pdf_path, "rb") as f:
        pdf_part = types.Part.from_bytes(data=f.read(), mime_type="application/pdf")

    for attempt in range(retries + 1):
        response = client.models.generate_content(
            model=MODEL,
            contents=[pdf_part, PROMPT],
            config={
                "response_mime_type": "application/json",
                "response_schema": DeckResult,
            },
        )
        if response.parsed is not None:
            return response.parsed
        print(f"Parse failed (attempt {attempt + 1}), retrying...")
    raise RuntimeError("Gemini returned unparseable output twice. Output may be truncated.")


# ---------- Clean up ----------
SUPPORTED_VISUALIZERS = {"tree", "array"}

def clamp(start, end, num_pages):
    start = max(1, min(start, num_pages))
    end = max(start, min(end, num_pages))
    return start, end

def clean(result, num_pages):
    for ex in result.examples:
        ex.slide_start, ex.slide_end = clamp(ex.slide_start, ex.slide_end, num_pages)
        if ex.supported and not ex.python_code.strip():
            ex.supported = False
            ex.unsupported_reason = "No code generated"
        if ex.visualizer not in SUPPORTED_VISUALIZERS:
            ex.supported = False
            ex.unsupported_reason = ex.unsupported_reason or "Visualizer not built yet"
    for s in result.sections:
        s.slide_start, s.slide_end = clamp(s.slide_start, s.slide_end, num_pages)
    return result


# ---------- Main ----------
def process_deck(pdf_path, out_dir="output"):
    num_pages = pdf_to_images(pdf_path, f"{out_dir}/slides")
    result = clean(call_gemini(pdf_path), num_pages)
    with open(f"{out_dir}/examples.json", "w") as f:
        f.write(result.model_dump_json(indent=2))
    return result

if __name__ == "__main__":
    pdf = sys.argv[1] if len(sys.argv) > 1 else "lecture.pdf"
    r = process_deck(pdf)
    print(f"{len(r.sections)} sections, {len(r.examples)} examples.")
    print("Saved output/examples.json and output/slides/")
