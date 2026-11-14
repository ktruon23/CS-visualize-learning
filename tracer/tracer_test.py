"""
Edge-case tests for the tracer. Run:  python test_tracer.py

Each case is an Example JSON plus the status (and sometimes frame count) we expect.
These cover what Gemini-written code can do wrong: bad translations, infinite
loops, swallowed errors, printing, blocked builtins, and inputs that are too big.
"""

import json
import sys

from tracer import process_example

FIB = ("def fib(n):\n    if n < 2:\n        return n\n"
       "    return fib(n - 1) + fib(n - 2)\n")


def ex(**kw):
    base = {
        "slide_start": 1, "slide_end": 1, "title": "test", "visualizer": "tree",
        "supported": True, "unsupported_reason": None, "original_code": "",
        "python_code": FIB, "function_name": "fib", "args_json": "[3]",
        "call_label": "fib({n})", "expected_result_json": None,
        "array_var": None, "pointer_vars": [],
    }
    base.update(kw)
    return base


CASES = [
    # (name, example, expected status, expected frame count or None)
    ("fib(3) matches the plan's fixture: 5 calls, 10 frames",
     ex(expected_result_json="2"), "ok", 10),

    ("fib(4): 9 calls, 18 frames",
     ex(args_json="[4]", expected_result_json="3"), "ok", 18),

    ("wrong translation is caught by the check",
     ex(python_code="def fact(n):\n    if n == 0:\n        return 0\n    return n * fact(n - 1)\n",
        function_name="fact", args_json="[5]", call_label="{n}!",
        expected_result_json="120"), "mismatch", None),

    ("no expected result on the slide -> unchecked",
     ex(), "unchecked", 10),

    ("expected result given as a string still matches",
     ex(expected_result_json='"2"'), "ok", 10),

    ("too large -> shrunk and marked unchecked",
     ex(args_json="[30]", expected_result_json="832040"), "unchecked", None),

    ("infinite loop -> timeout error",
     ex(python_code="def spin(n):\n    while True:\n        n += 1\n",
        function_name="spin", args_json="[0]"), "error", None),

    ("array loop that never changes state -> caught by line-event cap",
     ex(visualizer="array", python_code="def stuck(A):\n    while True:\n        pass\n",
        function_name="stuck", args_json="[[1, 2]]", array_var="A"), "error", None),

    ("except Exception can't swallow the step limit",
     ex(python_code=("def fib(n):\n    try:\n        if n < 2:\n            return n\n"
                     "        return fib(n - 1) + fib(n - 2)\n"
                     "    except Exception:\n        return 0\n"),
        args_json="[25]"), "unchecked", None),

    ("printing doesn't corrupt the output",
     ex(python_code=("def fib(n):\n    print('calling', n)\n    if n < 2:\n        return n\n"
                     "    return fib(n - 1) + fib(n - 2)\n"),
        expected_result_json="2"), "ok", 10),

    ("open() is blocked",
     ex(python_code="def f(n):\n    open('/etc/passwd')\n    return n\n",
        function_name="f", args_json="[1]"), "error", None),

    ("runtime error -> error status, not a crash",
     ex(python_code="def f(n):\n    return n / 0\n", function_name="f",
        args_json="[1]"), "error", None),

    ("missing function name -> error",
     ex(function_name="nope"), "error", None),

    ("unsupported example passes through untouched",
     ex(supported=False, unsupported_reason="laziness", visualizer="none"),
     "unsupported", 0),

    ("in-place sort returning None is checked on the final array",
     ex(visualizer="array",
        python_code=("def bubble(A):\n    n = len(A)\n    for i in range(n):\n"
                     "        for j in range(n - 1 - i):\n"
                     "            if A[j] > A[j + 1]:\n"
                     "                A[j], A[j + 1] = A[j + 1], A[j]\n"),
        function_name="bubble", args_json="[[3, 1, 2]]", array_var="A",
        pointer_vars=["i", "j"], expected_result_json="[1, 2, 3]"), "ok", None),
]


def main():
    failures = 0
    for name, example, want_status, want_frames in CASES:
        r = process_example(example)
        ok = r["status"] == want_status and (want_frames is None or r["total_steps"] == want_frames)
        failures += not ok
        mark = "PASS" if ok else "FAIL"
        detail = f"status={r['status']} frames={r['total_steps']}"
        if r.get("note"):
            detail += f" note={r['note']!r}"
        print(f"{mark}  {name}\n      {detail}")
    print(f"\n{len(CASES) - failures}/{len(CASES)} passed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()