"""
Local server that ties the three parts together.

    upload PDF  ->  deck_reader.outline_deck()  ->  list of examples   (fast)
    pick one    ->  deck_reader.write_code()    ->  Python for that example only
                ->  tracer.trace(example)       ->  frames
    frames      ->  renderer/index.html

Run from the repo root:
    python3 server.py
then open http://localhost:8000
"""
import hashlib
import importlib.util
import json
import os
import time
import traceback

from flask import Flask, abort, jsonify, redirect, request, send_from_directory

import deck_reader

ROOT = os.path.dirname(os.path.abspath(__file__))
RENDERER_DIR = os.path.join(ROOT, "renderer")
DECKS_DIR = os.path.join(ROOT, "decks")          # one folder per uploaded PDF

app = Flask(__name__)
os.makedirs(DECKS_DIR, exist_ok=True)


# ---------- loading the tracer ----------


def load_tracer():
    """
    The tracer lives in tracer.py (tracer teammate). It must provide:

        trace(example: dict) -> list[dict]

    where `example` is one entry from examples.json and each returned dict is
    one frame: {"step", "total_steps", "state", "explanation", "quiz"}.

    By the time trace() is called, the example has (from deck_reader.write_code):
        python_code, function_name, args (a real Python list of arguments),
        call_label, original_code, expected_result
    so the tracer runs: function_name(*args) inside python_code.
    Returns None if tracer.py doesn't exist yet.
    """
    path = os.path.join(ROOT, "tracer.py")
    if not os.path.exists(path):
        return None
    spec = importlib.util.spec_from_file_location("tracer", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


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


@app.post("/api/decks/<deck_id>/examples/<int:index>/trace")
def trace_example(deck_id, index):
    """Run the tracer on one example and save a frames file the viewer can load."""
    deck_dir = os.path.join(DECKS_DIR, deck_id)
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
    if not os.path.exists(frames_path):
        tracer = load_tracer()
        if tracer is None:
            return jsonify(error="The tracer isn't connected yet (no tracer.py in the repo)."), 501
        try:
            frames = tracer.trace(example)
        except Exception as e:
            traceback.print_exc()
            return jsonify(error=f"Tracing failed: {e}"), 500

        data = {
            "example_id": f"{deck_id}-{index}",
            "title": example["title"],
            "slide_start": example["slide_start"],
            "slide_end": example["slide_end"],
            "visualizer": example["visualizer"],
            "original_code": example["original_code"],
            "frames": frames,
        }
        with open(frames_path, "w") as f:
            json.dump(data, f, indent=2)

    return jsonify(
        data_url=f"/decks/{deck_id}/{frames_name}",
        slides_url=f"/decks/{deck_id}/slides",
    )


if __name__ == "__main__":
    app.run(port=int(os.environ.get("PORT", 8000)), debug=True)
