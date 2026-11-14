"""
Tracer driver: Example JSON in, Frame JSON out.

For every example in examples.json:
  1. skip it if Gemini marked it unsupported
  2. run it in an isolated worker process (tracer_core.py) with a time limit
  3. if it's too big, shrink the input and retry ("fib(30) is too large, showing fib(7)")
  4. check the result against what the slide says (expected_result_json)
  5. wrap each recorded state into a frame for the renderer

Usage:
  python tracer.py                          # examples.json -> frames.json
  python tracer.py in.json out.json

The renderer should only show examples whose status is "ok" or "unchecked".
"""

import ast
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from tracer_core import fmt, make_label

MAX_TRACE_STEPS = 500        # frames per example before we shrink the input
TIMEOUT_SECONDS = 3          # wall-clock limit per worker run
MAX_SHRINK_ATTEMPTS = 6      # how many times we halve the input before giving up

WORKER = Path(__file__).resolve().with_name("tracer_core.py")


# ---------------------------------------------------------------- running

def run_worker(example, max_steps=MAX_TRACE_STEPS):
    """Run one example in a separate, isolated Python process."""
    payload = dict(example, _max_steps=max_steps)
    env = {"PATH": os.environ.get("PATH", "")}
    if "SYSTEMROOT" in os.environ:                 # Windows needs this to start Python
        env["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
    with tempfile.TemporaryDirectory() as tmp:     # empty working directory
        try:
            proc = subprocess.run(
                [sys.executable, "-I", str(WORKER)],   # -I: ignore env vars, user site, cwd
                input=json.dumps(payload),
                capture_output=True, text=True,
                timeout=TIMEOUT_SECONDS, cwd=tmp, env=env,
            )
        except subprocess.TimeoutExpired:
            return {"error": "timeout", "message": f"stopped after {TIMEOUT_SECONDS}s"}
    if proc.returncode != 0 or not proc.stdout.strip():
        tail = (proc.stderr or "").strip()[-500:] or f"worker exited with code {proc.returncode}"
        return {"error": "crash", "message": tail}
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {"error": "crash", "message": "worker returned invalid JSON"}


# ---------------------------------------------------------------- shrinking

def shrink_args(args):
    """Make the input smaller: halve integers, halve lists (keeping at least 2 items).

    Returns None when nothing can shrink further.
    """
    changed = False

    def shrink(v):
        nonlocal changed
        if isinstance(v, bool):
            return v
        if isinstance(v, int) and abs(v) > 1:
            changed = True
            return v // 2 if v > 0 else -(-v // 2)
        if isinstance(v, list) and len(v) > 2:
            changed = True
            return v[: max(2, len(v) // 2)]
        return v

    new = [shrink(a) for a in args]
    return new if changed else None


def param_names(code, fn_name):
    """Parameter names of fn_name, read from the source without running it."""
    try:
        for node in ast.walk(ast.parse(code)):
            if isinstance(node, ast.FunctionDef) and node.name == fn_name:
                return [a.arg for a in node.args.args]
    except SyntaxError:
        pass
    return []


def call_text(ex, args):
    """How a call with these args reads in the slide's notation, e.g. 'fib(30)'."""
    names = param_names(ex["python_code"], ex["function_name"])
    bound = dict(zip(names, args)) if len(names) >= len(args) else {
        f"arg{i}": a for i, a in enumerate(args)}
    return make_label(ex.get("call_label") or "", ex["function_name"], bound)


# ---------------------------------------------------------------- checking

def same_value(a, b):
    if json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True):
        return True
    # Gemini sometimes gives "8" for 8, or "[1,2,3]" as a string
    return fmt(a) == fmt(b) or str(a) == str(b)


def check(ex, out, shrunk):
    """Compare the traced result with the slide's stated answer."""
    if shrunk:
        return "unchecked", "Input was shrunk, so the slide's answer doesn't apply."
    expected_raw = ex.get("expected_result_json")
    if not expected_raw:
        return "unchecked", "The slide doesn't state a result to check against."
    try:
        expected = json.loads(expected_raw)
    except json.JSONDecodeError:
        return "unchecked", "Couldn't read the slide's expected result."

    actual = out.get("result")
    # In-place sorts often return None; the final array is the real answer.
    if actual is None and ex.get("visualizer") == "array" and out.get("states"):
        actual = out["states"][-1]["array"]

    if same_value(actual, expected):
        return "ok", None
    return "mismatch", f"Trace gives {fmt(actual)} but the slide says {fmt(expected)}."

# ---------------------------------------------------------------- old-format adapter

COMMON_POINTERS = ["i", "j", "k", "lo", "hi", "low", "high", "left", "right", "mid", "l", "r", "p"]

def _parse_value(s):
    """Parse a value Gemini wrote as a string: JSON first, then Python literal."""
    try:
        return json.loads(s)
    except (json.JSONDecodeError, TypeError):
        pass
    try:
        return ast.literal_eval(s)
    except (ValueError, SyntaxError):
        return None


def _first_function(code):
    try:
        for node in ast.parse(code).body:
            if isinstance(node, ast.FunctionDef):
                return node.name
    except SyntaxError:
        pass
    return None


def _assigned_names(code):
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return set()
    names = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store)}
    names |= {a.arg for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) for a in n.args.args}
    return names


def normalize_example(ex):
    """Accept the old API-call schema (input / expected_result, no function_name)
    and fill in the fields the tracer needs. New-format examples pass through unchanged."""
    ex = dict(ex)
    code = ex.get("python_code") or ""

    if not ex.get("function_name"):
        ex["function_name"] = _first_function(code) or ""

    if "args_json" not in ex and "input" in ex:
        val = _parse_value(ex["input"]) if isinstance(ex["input"], str) else ex["input"]
        params = param_names(code, ex["function_name"])
        if len(params) > 1 and isinstance(val, (list, tuple)) and len(val) == len(params):
            args = list(val)          # "[2, 3]" for power(b, e)
        else:
            args = [val]              # "[3,1,4]" for sum_list(xs)
        ex["args_json"] = json.dumps(args)

    if "expected_result_json" not in ex:
        raw = ex.get("expected_result")
        if raw in (None, ""):
            ex["expected_result_json"] = None
        else:
            val = _parse_value(raw) if isinstance(raw, str) else raw
            ex["expected_result_json"] = json.dumps(val if val is not None else raw)

    if ex.get("visualizer") == "array":
        params = param_names(code, ex["function_name"])
        if not ex.get("array_var") and params:
            ex["array_var"] = params[0]   # sorts almost always take the array first
        if not ex.get("pointer_vars"):
            assigned = _assigned_names(code)
            ex["pointer_vars"] = [p for p in COMMON_POINTERS if p in assigned]

    return ex


# ---------------------------------------------------------------- one example

def example_id(ex):
    return f"slide{ex.get('slide_start', 0)}-{ex.get('function_name') or 'example'}"


def process_example(ex):
    ex = normalize_example(ex)
    base = {
        "example_id": example_id(ex),
        "slide_start": ex.get("slide_start"),
        "slide_end": ex.get("slide_end"),
        "title": ex.get("title"),
        "visualizer": ex.get("visualizer"),
        "original_code": ex.get("original_code"),
    }

    if not ex.get("supported"):
        return {**base, "status": "unsupported",
                "note": ex.get("unsupported_reason") or "Not supported yet.",
                "total_steps": 0, "frames": []}

    try:
        original_args = json.loads(ex["args_json"])
    except (KeyError, json.JSONDecodeError):
        return {**base, "status": "error", "note": "Bad args_json.",
                "total_steps": 0, "frames": []}

    args, shrunk = original_args, False
    out = run_worker(ex)
    attempts = 0
    while out.get("error") == "limit" and attempts < MAX_SHRINK_ATTEMPTS:
        smaller = shrink_args(args)
        if smaller is None:
            break
        args, shrunk, attempts = smaller, True, attempts + 1
        out = run_worker({**ex, "args_json": json.dumps(args)})

    if "error" in out:
        return {**base, "status": "error", "note": out["message"],
                "total_steps": 0, "frames": []}

    status, note = check(ex, out, shrunk)
    if shrunk:
        note = (f"{call_text(ex, original_args)} is too large to animate, "
                f"showing {call_text(ex, args)}.")

    states = out["states"]
    total = len(states)
    frames = [{
        "example_id": base["example_id"],
        "step": i,
        "total_steps": total,
        "visualizer": ex["visualizer"],
        "state": state,
        "explanation": None,   # filled in by the Gemini explain pass
        "quiz": None,          # filled in by the Gemini explain pass
        "slide_line": None,    # optional: line on the slide this step matches
    } for i, state in enumerate(states)]

    return {**base, "status": status, "note": note,
            "args": args, "shrunk": shrunk,
            "result": out.get("result"),
            "expected": ex.get("expected_result_json"),
            "printed": out.get("printed"),
            "total_steps": total, "frames": frames}


# ---------------------------------------------------------------- main

def trace_deck(examples_path, frames_path):
    data = json.loads(Path(examples_path).read_text())
    examples = data["examples"] if isinstance(data, dict) else data
    results = [process_example(ex) for ex in examples]
    out = {"max_trace_steps": MAX_TRACE_STEPS, "examples": results}
    Path(frames_path).parent.mkdir(parents=True, exist_ok=True)
    Path(frames_path).write_text(json.dumps(out, indent=2))
    return results


if __name__ == "__main__":
    here = Path(__file__).resolve().parent
    src = sys.argv[1] if len(sys.argv) > 1 else here / "fixtures" / "examples.json"
    dst = sys.argv[2] if len(sys.argv) > 2 else here.parent / "output" / "frames.json"
    for r in trace_deck(src, dst):
        note = f"  ({r['note']})" if r.get("note") else ""
        print(f"{r['example_id']:<28} {r['status']:<12} {r['total_steps']:>4} frames{note}")
    print(f"Wrote {dst}")