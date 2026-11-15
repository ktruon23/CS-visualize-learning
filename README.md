# Lecture Visualizer

Upload a CS lecture deck (PDF). The app finds the worked examples on the slides
and turns each one into a step-by-step animation using the **professor's own
example, version of the algorithm, and notation**, shown next to the original slide.

Every animation comes from **actually running the code**, not from the model
describing it, and it's checked against the slide before it's shown.

---

## Run it locally

Requires Python 3.10+ and a Gemini API key. Linux, macOS, or WSL is best, since
the tracer's CPU and memory limits use Unix features.

```bash
git clone git@github.com:ktruon23/CS-visualize-learning.git
cd CS-visualize-learning
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

Create a `.env` in the repo root (it's gitignored, never commit it):

```
GEMINI_API_KEY=your-key-here
# optional overrides (defaults are in deck_reader.py)
# GEMINI_OUTLINE_MODEL=...
# GEMINI_CODE_MODEL=...
```

Start the server and open the app:

```bash
python3 server.py          # http://localhost:8000
```

Use `PORT=9000 python3 server.py` to run on a different port.

### No API key? View a sample

The viewer can load a saved frames file directly, with no Gemini call:

```
http://localhost:8000/renderer/index.html?data=samples/fib3.json
```

Other samples: `haskell_sum.json`, `dict_lookup.json`, `dict_missing.json`.

---

## Features

- **Upload any CS deck.** Gemini lists the sections and every example that can be
  animated. Ones it can't animate are listed with the reason.
- **Slide beside animation.** The whole deck scrolls on the left. The example's
  slides are outlined, and the animation plays on the right.
- **Three visualizers:**
  - **Tree:** recursion as a call tree. Each call appears, waits on its children,
    then fills in its return value.
  - **Array:** sorting and searching. Shows cells, pointers (`i`, `j`, `lo`, `hi`, ...),
    the active `lo..hi` range, other variables (`best`, `key`, ...), and swaps that
    slide into place.
  - **Dict:** recursion over a list of key/value pairs, with each call lined up
    against the row it's checking.
- **Matches the class.** The animation uses the slide's input, the slide's version
  of the algorithm, and the slide's notation (Haskell slides show `sum [3,1,4]`, not Python).
- **Step controls:** Next/Back, arrow keys, and Play for autoplay. Each step has a
  one-line explanation built from the recorded values.
- **Quiz pauses:** "What does this return?" before the answer is shown. Next waits
  until the student answers or reveals it.

---

## How it works

```
upload PDF ──► deck_reader.outline_deck()   Gemini lists sections + examples (fast)
                        │
click an example ──► deck_reader.write_code()   Gemini writes Python for that example only
                        │
                        ▼
                tracer/tracer.py            runs the Python in an isolated process,
                        │                   records every step, checks vs. the slide
                        ▼
                renderer/                   draws the frames, step by step
```

1. **Outline (on upload).** Gemini reads the PDF and returns the examples it found,
   with slide ranges and which visualizer fits each one. This step is kept short so
   upload is quick.
2. **Write code (on click).** Gemini looks at only that example's slides and writes an
   equivalent Python function, the input to run it on, and a label pattern in the
   slide's notation (e.g. `fib({n})`).
3. **Trace.** The tracer runs that Python in a **separate Python process** with a time
   limit, a step cap, and CPU/memory limits, and records the state at each step:
   - tree/dict: one frame when a call starts, one when it returns
   - array: one frame whenever the array, a pointer, or a variable changes
   - inputs that are too large are shrunk automatically ("fib(30) is too large, showing fib(7)")
4. **Check.** If the slide states an answer, the traced result must match it.
   A mismatch means the translation was wrong, so the example is **not shown**.
5. **Render.** The viewer draws one frame at a time. Every frame holds the full
   state, so Back just shows the previous frame.

**Gemini never decides what the code does.** It translates the slide; our code
runs it and records what actually happened.

**Caching.** Each upload gets an id from a hash of the PDF and is saved in
`decks/<id>/` (slides, `examples.json`, `frames_N.json`). Uploading the same PDF
again is instant, which is handy for demos. Delete that folder to force a fresh run.

---

## Project layout

| Path | What it is |
|---|---|
| `server.py` | Flask server: upload, deck, and trace API, and serves the pages |
| `deck_reader.py` | The two Gemini calls (outline, write code) and their prompts and schemas |
| `tracer/tracer_core.py` | Runs one example and records frames (tree and array tracers) |
| `tracer/tracer.py` | Runs examples in an isolated process, shrinks large inputs, checks results |
| `tracer/tracer_test.py` | Edge-case tests: timeouts, wrong translations, blocked builtins, ... |
| `tracer/fixtures/` | Sample `examples.json` and its generated `frames.json` |
| `renderer/upload.*` | Upload page |
| `renderer/index.html`, `viewer.js` | Viewer page: deck strip, stepping, autoplay, quiz |
| `renderer/tree.js`, `array.js`, `dict.js` | The three visualizers (`layoutX()` once, `drawX()` per frame) |
| `renderer/samples/` | Ready-made frames files for testing the viewer |
| `speed_check.py` | Times Gemini calls to find slow or hanging models |
| `test_api_call.py` | Original standalone Gemini test script |

---

## Dev tasks

```bash
python3 tracer/tracer_test.py      # tracer edge-case tests (should print 15/15 passed)
python3 tracer/tracer.py           # fixtures/examples.json -> output/frames.json
python3 speed_check.py [MODEL]     # check Gemini latency
```

**After changing the frame format,** regenerate the fixture and tell the renderer side:

```bash
python3 tracer/tracer.py tracer/fixtures/examples.json tracer/fixtures/frames.json
```

**After changing the tracer,** delete cached traces so they're rebuilt:
`rm decks/*/frames_*.json`

**Adding a visualizer:** have the tracer emit frames with a new `visualizer` name,
write `renderer/<name>.js` with `layout<Name>(frames)` and `draw<Name>(svg, frame, layout)`,
load it in `index.html` before `viewer.js`, and add a branch in `viewer.js`
(`showFrames` for the layout, `render` for the drawing).

---

## Limits

- Supported: ordinary recursion, array algorithms, and key/value lookups. Not
  supported: examples that depend on lazy evaluation, reduction order, types, or monads.
- The process isolation is a safety net for a demo, not a hardened sandbox.
  Run this locally, not as a public service.
- Each run is capped at about 500 steps and 3 seconds per example (constants at the top of `tracer/tracer.py`).