"""
Local server that ties the three parts together.

    upload PDF  ->  deck_reader.outline_deck()  ->  list of examples   (fast)
    pick one    ->  deck_reader.write_code()    ->  Python for that example only
                ->  tracer/tracer.py            ->  runs it, records frames, checks vs slide
    frames      ->  renderer/index.html

Run from the repo root:
    python3 server.py
then open http://localhost:8000
"""
import ast
import hashlib
import importlib.util
import re
import json
import os
import sys
import time
import traceback

from flask import Flask, abort, jsonify, redirect, request, send_from_directory

import deck_reader

ROOT = os.path.dirname(os.path.abspath(__file__))
RENDERER_DIR = os.path.join(ROOT, "renderer")
DECKS_DIR = os.path.join(ROOT, "decks")          # one folder per uploaded PDF

app = Flask(__name__)
os.makedirs(DECKS_DIR, exist_ok=True)


# ---------- the tracer (tracer/tracer.py, tracer teammate) ----------

TRACER_DIR = os.path.join(ROOT, "tracer")
_tracer = None


def load_tracer():
    """Import tracer/tracer.py. It imports tracer_core from its own folder, so
    that folder has to be on the import path first."""
    global _tracer
    if _tracer is None:
        path = os.path.join(TRACER_DIR, "tracer.py")
        if not os.path.exists(path):
            return None
        if TRACER_DIR not in sys.path:
            sys.path.insert(0, TRACER_DIR)
        spec = importlib.util.spec_from_file_location("tracer_driver", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _tracer = module
    return _tracer


def run_tracer(tracer, example):
    """Hand one example to the tracer and return its result.

    deck_reader gives us `args` as a real list; the tracer reads `args_json`
    (a JSON string), so convert. Its normalize_example() handles the rest
    (e.g. expected_result -> expected_result_json).
    """
    ex = dict(example)
    if "args_json" not in ex and "args" in ex:
        ex["args_json"] = json.dumps(ex["args"])
    ex["visualizer"] = pick_visualizer(ex)
    result = tracer.process_example(ex)
    result["visualizer"] = ex["visualizer"]
    return result


# ---------- checking Gemini's choice of visualizer ----------

def calls_itself(code, fn_name):
    """True if fn_name's body calls fn_name (read from the source, not run)."""
    try:
        for node in ast.walk(ast.parse(code)):
            if isinstance(node, ast.FunctionDef) and node.name == fn_name:
                return any(isinstance(c, ast.Call) and isinstance(c.func, ast.Name)
                           and c.func.id == fn_name for c in ast.walk(node))
    except SyntaxError:
        pass
    return False


def is_pair_list(value):
    """[["a", 1], ["b", 2]] (or tuples): a list of key/value pairs."""
    return (isinstance(value, (list, tuple)) and len(value) > 0
            and all(isinstance(p, (list, tuple)) and len(p) == 2 for p in value))


def pick_visualizer(ex):
    """Gemini labels each example, but the label can be wrong (it called a
    dictionary lookup "array"). Decide from the code and the input instead:
    a function that calls itself on a list of key/value pairs is a dict lookup."""
    args = ex.get("args")
    if args is None:
        try:
            args = json.loads(ex.get("args_json") or "[]")
        except json.JSONDecodeError:
            args = []
    if calls_itself(ex.get("python_code") or "", ex.get("function_name") or "") \
            and any(is_pair_list(a) for a in args):
        return "dict"
    return ex.get("visualizer")


# ---------- pages and static files ----------

@app.route("/")
def home():
    return redirect("/renderer/upload.html")


@app.route("/renderer/<path:path>")
def renderer_files(path):
    return send_from_directory(RENDERER_DIR, path)


@app.route("/decks/<path:path>")
def deck_files(path):
    return send_from_directory(DECKS_DIR, path)


# ---------- API ----------

@app.post("/api/decks")
def upload_deck():
    """Upload a PDF. Returns its sections and examples.

    The deck id is a hash of the file, so uploading the same PDF again
    reuses the saved result instantly. Useful for the demo.
    """
    file = request.files.get("pdf")
    if file is None or not file.filename.lower().endswith(".pdf"):
        return jsonify(error="Please upload a .pdf file."), 400

    data = file.read()
    # Same PDF + same prompt version -> same id -> reuse the saved result.
    deck_id = hashlib.sha256(data + deck_reader.CACHE_VERSION.encode()).hexdigest()[:12]
    deck_dir = os.path.join(DECKS_DIR, deck_id)
    examples_path = os.path.join(deck_dir, "examples.json")

    if not os.path.exists(examples_path):
        os.makedirs(deck_dir, exist_ok=True)
        pdf_path = os.path.join(deck_dir, "lecture.pdf")
        with open(pdf_path, "wb") as f:
            f.write(data)
        try:
            t0 = time.time()
            deck_reader.outline_deck(pdf_path, deck_dir)
            print(f"[upload] done in {time.time() - t0:.1f}s")
        except Exception as e:
            traceback.print_exc()
            return jsonify(error=f"Reading the deck failed: {e}"), 500

    with open(examples_path) as f:
        result = json.load(f)
    return jsonify(deck_id=deck_id, **result)


def deck_dir_for(deck_id):
    """Deck ids come from the URL, so only accept the 12-hex-character ids we make."""
    if not re.fullmatch(r"[0-9a-f]{12}", deck_id):
        abort(404)
    return os.path.join(DECKS_DIR, deck_id)


@app.get("/api/decks/<deck_id>")
def get_deck(deck_id):
    """Everything the viewer needs to show the whole deck: examples + slide count."""
    deck_dir = deck_dir_for(deck_id)
    examples_path = os.path.join(deck_dir, "examples.json")
    if not os.path.exists(examples_path):
        abort(404)
    with open(examples_path) as f:
        result = json.load(f)
    slides = os.listdir(os.path.join(deck_dir, "slides"))
    num_slides = sum(1 for name in slides if re.fullmatch(r"slide_\d+\.png", name))
    return jsonify(deck_id=deck_id, num_slides=num_slides, **result)


@app.post("/api/decks/<deck_id>/examples/<int:index>/trace")
def trace_example(deck_id, index):
    """Run the tracer on one example and save a frames file the viewer can load."""
    deck_dir = deck_dir_for(deck_id)
    examples_path = os.path.join(deck_dir, "examples.json")
    if not os.path.exists(examples_path):
        abort(404)
    with open(examples_path) as f:
        deck = json.load(f)
    examples = deck["examples"]
    if not 0 <= index < len(examples):
        abort(404)
    example = examples[index]

    if not example.get("supported"):
        return jsonify(error=example.get("unsupported_reason") or "This example isn't supported."), 400

    # Step 2: write the Python for just this example (saved, so it only happens once).
    if not example.get("python_code"):
        try:
            deck_reader.write_code(deck_dir, example)
        except Exception as e:
            traceback.print_exc()
            return jsonify(error=f"Writing code for this example failed: {e}"), 500
        with open(examples_path, "w") as f:
            json.dump(deck, f, indent=2)

    frames_name = f"frames_{index}.json"
    frames_path = os.path.join(deck_dir, frames_name)
    if os.path.exists(frames_path):
        # A saved result with no steps is a past failure, not a real result: redo it.
        with open(frames_path) as f:
            if not json.load(f).get("frames"):
                os.remove(frames_path)
    if not os.path.exists(frames_path):
        tracer = load_tracer()
        if tracer is None:
            return jsonify(error="The tracer isn't connected yet (no tracer/tracer.py in the repo)."), 501
        try:
            t0 = time.time()
            result = run_tracer(tracer, example)
            print(f"[trace] '{example['title']}': {result['status']}, "
                  f"{result['total_steps']} frames in {time.time() - t0:.1f}s")
        except Exception as e:
            traceback.print_exc()
            return jsonify(error=f"Tracing failed: {e}"), 500

        # The tracer's contract: only show "ok" (matches the slide) or
        # "unchecked" (nothing to compare against). A mismatch means the code
        # Gemini wrote doesn't do what the slide says, so don't show it.
        if result["status"] not in ("ok", "unchecked"):
            reasons = {
                "mismatch": "The animation didn't match the slide, so it isn't shown.",
                "error": "Running this example failed.",
                "unsupported": "This example isn't supported.",
            }
            msg = reasons.get(result["status"], "This example couldn't be animated.")
            if result.get("note"):
                msg += f" {result['note']}"
            return jsonify(error=msg), 422
        if not result["frames"]:
            return jsonify(error="The tracer ran this example but recorded no steps to show."), 422

        data = {
            "example_id": f"{deck_id}-{index}",
            "title": example["title"],
            "slide_start": example["slide_start"],
            "slide_end": example["slide_end"],
            "visualizer": result["visualizer"],   # may differ from Gemini's label
            "original_code": example["original_code"],
            "status": result["status"],
            # Only worth telling the student when the input was shrunk,
            # e.g. "fib(30) is too large to animate, showing fib(7)."
            "note": result.get("note") if result.get("shrunk") else None,
            "frames": result["frames"],
        }
        with open(frames_path, "w") as f:
            json.dump(data, f, indent=2)

    return jsonify(
        data_url=f"/decks/{deck_id}/{frames_name}",
        slides_url=f"/decks/{deck_id}/slides",
    )


if __name__ == "__main__":
    app.run(port=int(os.environ.get("PORT", 8000)), debug=True)
