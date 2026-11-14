"""
Tracer core: runs ONE example's Python code and records its state, step by step.

Stdlib only and no imports from sibling files, so it can run either:
  - as an isolated worker process:  python -I trace_core.py < example.json
    (this is what tracer.py does: separate process + time limit + resource limits)
  - in the browser with Pyodide: import this file and call run_example(example)
    (no subprocess there; use a Web Worker you can terminate for the time limit)

Two tracers:
  tree  - wraps the recursive function so every call and every return becomes a frame
  array - uses sys.settrace to snapshot the array and pointer variables on every line,
          keeping only the steps where something visible changed
"""

import builtins
import copy
import inspect
import io
import json
import math
import sys

MAX_TRACE_STEPS = 500        # max frames recorded per example
MAX_RECURSION_DEPTH = 200    # max depth of the recursion tree
MAX_LINE_EVENTS = 200_000    # array tracer: catches loops that never change visible state

# Builtins removed from the example's namespace. NOT a real sandbox: the real
# protection is the separate process, the timeout, and the resource limits.
BLOCKED_BUILTINS = {
    "open", "__import__", "eval", "exec", "compile", "input",
    "breakpoint", "exit", "quit", "help",
}


class TraceLimit(BaseException):
    """Raised when an example is too big to trace.

    Subclasses BaseException (not Exception) so an `except Exception:` inside
    the example's code can't swallow it.
    """


# ---------------------------------------------------------------- formatting

def fmt(v):
    """Format a value the way it would appear on a slide: [3,1,4], not [3, 1, 4]."""
    if isinstance(v, list):
        return "[" + ",".join(fmt(x) for x in v) + "]"
    if isinstance(v, tuple):
        return "(" + ",".join(fmt(x) for x in v) + ")"
    if isinstance(v, str):
        return json.dumps(v)
    return repr(v)


def make_label(pattern, fn_name, bound_args):
    """Fill a call_label pattern like 'sum {xs}' or 'fib({n})' with formatted values.

    Falls back to 'fn(arg, arg)' if the pattern is empty or uses unknown names.
    """
    vals = {k: fmt(v) for k, v in bound_args.items()}
    if pattern:
        try:
            return pattern.format_map(vals)
        except (KeyError, IndexError, ValueError):
            pass
    return f"{fn_name}(" + ", ".join(vals.values()) + ")"


def to_jsonable(v):
    """Convert a Python value into something json.dumps (and JS JSON.parse) accepts."""
    if v is None or isinstance(v, (bool, int, str)):
        return v
    if isinstance(v, float):
        return v if math.isfinite(v) else str(v)
    if isinstance(v, (list, tuple)):
        return [to_jsonable(x) for x in v]
    if isinstance(v, dict):
        return {str(k): to_jsonable(x) for k, x in v.items()}
    if isinstance(v, (set, frozenset)):
        return [to_jsonable(x) for x in sorted(v, key=repr)]
    return repr(v)


# ---------------------------------------------------------------- loading

def load_function(code, fn_name):
    """Exec the example's code in a fresh namespace and return (namespace, function)."""
    safe_builtins = {k: v for k, v in vars(builtins).items() if k not in BLOCKED_BUILTINS}
    ns = {"__builtins__": safe_builtins, "__name__": "example"}
    exec(compile(code, "<example>", "exec"), ns)
    fn = ns.get(fn_name)
    if not callable(fn):
        raise ValueError(f"function {fn_name!r} is not defined in the example code")
    return ns, fn


# ---------------------------------------------------------------- tree tracer

def trace_tree(code, fn_name, args, call_label, max_steps=MAX_TRACE_STEPS):
    """Trace a recursive function. One frame when a call starts, one when it returns.

    Node status:
      active   - the call currently running
      waiting  - on the stack, waiting for a child call to return
      returned - finished; `returned` holds its value
    """
    ns, original = load_function(code, fn_name)
    sig = inspect.signature(original)
    nodes = []
    stack = []
    states = []

    def snapshot(current):
        if len(states) >= max_steps:
            raise TraceLimit(f"more than {max_steps} steps")
        states.append({"nodes": [dict(n) for n in nodes], "current": current})

    def wrapper(*a, **kw):
        try:
            bound = sig.bind(*a, **kw)
            bound.apply_defaults()
            bound_args = dict(bound.arguments)
        except TypeError:
            bound_args = {f"arg{i}": v for i, v in enumerate(a)}

        node_id = len(nodes)
        parent = stack[-1] if stack else None
        if parent is not None:
            nodes[parent]["status"] = "waiting"
        nodes.append({
            "id": node_id,
            "parent": parent,
            "label": make_label(call_label, fn_name, bound_args),
            "status": "active",
            "returned": None,
        })
        stack.append(node_id)
        if len(stack) > MAX_RECURSION_DEPTH:
            raise TraceLimit(f"recursion deeper than {MAX_RECURSION_DEPTH}")
        snapshot(node_id)

        result = original(*a, **kw)

        stack.pop()
        nodes[node_id]["status"] = "returned"
        nodes[node_id]["returned"] = to_jsonable(result)
        if parent is not None:
            nodes[parent]["status"] = "active"
        snapshot(node_id)
        return result

    # Recursive calls look the function up by name in the namespace, so
    # replacing it there routes every recursive call through the wrapper.
    ns[fn_name] = wrapper
    result = wrapper(*copy.deepcopy(args))
    return result, states


# ---------------------------------------------------------------- array tracer

def trace_array(code, fn_name, args, array_var, pointer_vars, max_steps=MAX_TRACE_STEPS):
    """Trace an array algorithm by snapshotting `array_var` and `pointer_vars` each line.

    A frame is recorded only when the array contents or a pointer value changes.
    `highlight` lists the indices whose values changed since the previous frame.
    """
    ns, fn = load_function(code, fn_name)
    pointer_vars = list(pointer_vars or [])
    states = []
    counters = {"events": 0, "last_key": None}

    def record(frame):
        counters["events"] += 1
        if counters["events"] > MAX_LINE_EVENTS:
            raise TraceLimit(f"more than {MAX_LINE_EVENTS} line events")

        loc = frame.f_locals
        arr = loc.get(array_var)
        if isinstance(arr, (list, tuple)):
            arr_state = to_jsonable(list(arr))
        elif states:
            arr_state = states[-1]["array"]   # e.g. inside a helper with other names
        else:
            return                            # array not visible yet

        pointers = {
            p: loc[p] for p in pointer_vars
            if isinstance(loc.get(p), int) and not isinstance(loc.get(p), bool)
        }

        key = json.dumps([arr_state, pointers], sort_keys=True)
        if key == counters["last_key"]:
            return
        counters["last_key"] = key

        prev = states[-1]["array"] if states else arr_state
        changed = [i for i in range(len(arr_state))
                   if i >= len(prev) or arr_state[i] != prev[i]]

        if len(states) >= max_steps:
            raise TraceLimit(f"more than {max_steps} steps")
        states.append({
            "array": arr_state,
            "pointers": pointers,
            "highlight": changed,
            "py_line": frame.f_lineno,
        })

    def tracer(frame, event, arg):
        if frame.f_code.co_filename != "<example>":
            return None              # don't trace anything outside the example
        if event in ("line", "return"):
            record(frame)            # 'line' = before a line runs; 'return' = final state
        return tracer

    sys.settrace(tracer)
    try:
        result = fn(*copy.deepcopy(args))
    finally:
        sys.settrace(None)
    return result, states


# ---------------------------------------------------------------- entry points

def run_example(ex, max_steps=MAX_TRACE_STEPS):
    """Trace one example dict (Example JSON). Never raises; errors come back as data.

    Returns {"result": ..., "states": [...]}
         or {"error": "limit" | "exception" | "unsupported", "message": "..."}
    """
    try:
        args = json.loads(ex["args_json"])
        if not isinstance(args, list):
            return {"error": "exception", "message": "args_json must be a JSON list"}
        vis = ex.get("visualizer")
        if vis == "tree":
            result, states = trace_tree(
                ex["python_code"], ex["function_name"], args,
                ex.get("call_label") or "", max_steps)
        elif vis == "array":
            if not ex.get("array_var"):
                return {"error": "exception", "message": "array example has no array_var"}
            result, states = trace_array(
                ex["python_code"], ex["function_name"], args,
                ex["array_var"], ex.get("pointer_vars"), max_steps)
        else:
            return {"error": "unsupported", "message": f"no tracer for visualizer {vis!r}"}
        return {"result": to_jsonable(result), "states": states}
    except TraceLimit as e:
        return {"error": "limit", "message": str(e)}
    except RecursionError:
        return {"error": "limit", "message": "recursion too deep"}
    except Exception as e:
        return {"error": "exception", "message": f"{type(e).__name__}: {e}"}


def _apply_resource_limits():
    """CPU and memory caps for the worker process (Linux/macOS; skipped elsewhere)."""
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_CPU, (3, 3))
        mem = 512 * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (mem, mem))
    except Exception:
        pass


def _worker_main():
    _apply_resource_limits()
    real_stdout = sys.stdout
    ex = json.load(sys.stdin)
    # Anything the example prints must not corrupt the JSON we write to stdout.
    sys.stdout = io.StringIO()
    try:
        out = run_example(ex, ex.get("_max_steps", MAX_TRACE_STEPS))
    finally:
        printed = sys.stdout.getvalue()
        sys.stdout = real_stdout
    if printed:
        out["printed"] = printed[-2000:]
    real_stdout.write(json.dumps(out))


if __name__ == "__main__":
    _worker_main()