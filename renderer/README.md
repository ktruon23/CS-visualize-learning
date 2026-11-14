# Renderer

The viewer page: original slide on the left, step-by-step visualization on the right.

## Run it

The page loads JSON with `fetch`, which browsers block on `file://`, so serve the repo:

```
cd CS-visualize-learning
python3 -m http.server 8000
```

Then open http://localhost:8000/renderer/

- `?data=path/to/frames.json` loads a different frames file (default: `samples/fib3.json`).
- `?slides=path/to/folder` changes where slide images come from (default: `../output/slides`, which is where `test_apicall` saves `slide_N.png`).
- Arrow keys step forward and back.

## Files

- `tree.js`: `layoutTree()` works out node positions once from the last frame, so nodes never move as the tree grows. `drawTree()` draws one frame.
- `viewer.js`: loads the data, tracks the current step, handles Next/Back and the quiz.
- `samples/fib3.json`: hand-checked fib(3) trace, 10 frames, with quizzes on steps 6 and 9.

## Frames file format

```
{
  "example_id", "title", "slide_start", "slide_end", "visualizer", "original_code",
  "frames": [
    {
      "step", "total_steps",
      "state": { "nodes": [ {"id", "parent", "label", "status", "returned"} ], "current" },
      "explanation",
      "quiz": null or { "question", "choices": [...], "answer_index" }
    }
  ]
}
```

`status` is `"waiting"` (yellow) or `"returned"` (green). `current` gets the blue outline.
A frame with a quiz blocks Next until the student answers or clicks "Show answer".
