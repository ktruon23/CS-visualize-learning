// Viewer: loads one example's frames, keeps track of the current step,
// and redraws everything on each step.
//
// Data file shape (see samples/fib3.json):
// { example_id, title, slide_start, slide_end, visualizer, original_code,
//   frames: [ { step, total_steps, state, explanation, quiz }, ... ] }
//
// Open with ?data=path/to/file.json to load something other than the sample.

const params = new URLSearchParams(location.search);
const DATA_URL = params.get("data") || "samples/fib3.json";
const SLIDE_DIR = params.get("slides") || "../output/slides"; // where the Gemini script saves slide_N.png

const state = {
  data: null,
  current: 0,            // index into data.frames
  layout: null,          // computed once from the last frame
  answered: new Set(),   // frame indexes whose quiz has been answered
};

const $ = id => document.getElementById(id);

async function load() {
  try {
    const res = await fetch(DATA_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
  } catch (err) {
    $("explanation").textContent =
      `Couldn't load ${DATA_URL} (${err.message}). Run a local server from the repo root: python3 -m http.server`;
    return;
  }

  const { frames, visualizer } = state.data;
  if (visualizer === "tree") {
    state.layout = layoutTree(frames[frames.length - 1].state.nodes);
  }

  $("title").textContent = state.data.title || state.data.example_id;
  $("code").textContent = state.data.original_code || "";
  showSlide(state.data.slide_start);
  render();
}

function showSlide(n) {
  const img = $("slide-img");
  img.onerror = () => {
    img.hidden = true;
    $("slide-placeholder").hidden = false;
    $("slide-placeholder").textContent = `Slide ${n} (image not found in ${SLIDE_DIR})`;
  };
  img.hidden = false;
  $("slide-placeholder").hidden = true;
  img.src = `${SLIDE_DIR}/slide_${n}.png`;
}

function render() {
  const frames = state.data.frames;
  const frame = frames[state.current];

  $("progress").textContent = `Step ${state.current + 1} of ${frames.length}`;
  $("explanation").textContent = frame.explanation || "";

  if (state.data.visualizer === "tree") {
    drawTree($("viz"), frame, state.layout);
  } else {
    $("viz").innerHTML = "";
    $("explanation").textContent = `The "${state.data.visualizer}" visualizer isn't built yet.`;
  }

  renderQuiz(frame);

  $("back").disabled = state.current === 0;
  $("next").disabled = state.current === frames.length - 1 || quizBlocking();
}

// A frame with an unanswered quiz blocks Next until the student answers.
function quizBlocking() {
  const frame = state.data.frames[state.current];
  return Boolean(frame.quiz) && !state.answered.has(state.current);
}

function renderQuiz(frame) {
  const box = $("quiz");
  box.innerHTML = "";
  if (!frame.quiz) { box.hidden = true; return; }
  box.hidden = false;

  const q = frame.quiz;
  const done = state.answered.has(state.current);

  const h = document.createElement("p");
  h.className = "quiz-question";
  h.textContent = q.question;
  box.appendChild(h);

  const feedback = document.createElement("p");
  feedback.className = "quiz-feedback";

  q.choices.forEach((choice, i) => {
    const b = document.createElement("button");
    b.textContent = choice;
    b.className = "choice";
    if (done && i === q.answer_index) b.classList.add("correct");
    b.disabled = done;
    b.onclick = () => {
      if (i === q.answer_index) {
        state.answered.add(state.current);
        render();
      } else {
        b.classList.add("wrong");
        feedback.textContent = "Not quite. Look at the values the children returned.";
      }
    };
    box.appendChild(b);
  });

  if (done) {
    feedback.textContent = "Correct. Press Next to see it happen.";
  } else {
    const reveal = document.createElement("button");
    reveal.textContent = "Show answer";
    reveal.className = "reveal";
    reveal.onclick = () => { state.answered.add(state.current); render(); };
    box.appendChild(reveal);
  }
  box.appendChild(feedback);
}

function step(delta) {
  const next = state.current + delta;
  if (next < 0 || next >= state.data.frames.length) return;
  if (delta > 0 && quizBlocking()) return;
  state.current = next;
  render();
}

$("next").onclick = () => step(1);
$("back").onclick = () => step(-1);
document.addEventListener("keydown", e => {
  if (e.key === "ArrowRight") step(1);
  if (e.key === "ArrowLeft") step(-1);
});

load();
