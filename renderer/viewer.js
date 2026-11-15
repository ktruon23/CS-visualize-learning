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
  direction: 0,
};

const $ = id => document.getElementById(id);

async function load() {
  try {
    const res = await fetch(DATA_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
  } catch (err) {
    $("explanation").textContent =
      `Couldn't load ${DATA_URL} (${err.message}). Start the server from the repo folder with: python3 server.py`;
    return;
  }

  const { frames, visualizer } = state.data;
  if (visualizer === "tree") {
    state.layout = layoutTree(frames[frames.length - 1].state.nodes);
  } else if (visualizer === "array") {
    state.layout = layoutArray(frames);
  }

  $("title").textContent = state.data.title || state.data.example_id;
  $("note").hidden = !state.data.note;
  $("note").textContent = state.data.note || "";
  $("code").textContent = state.data.original_code || "";
  showSlide(state.data.slide_start);
  render();
}

function showSlide(n) {
  const img = $("slide-img");
  img.onerror = () => {
    img.hidden = true;
    $("slide-placeholder").hidden = false;
    $("slide-placeholder").textContent = `Slide ${n} isn't available. Upload the deck to see it here.`;
  };
  img.hidden = false;
  $("slide-placeholder").hidden = true;
  img.src = `${SLIDE_DIR}/slide_${n}.png`;
}

function render() {
  const frames = state.data.frames;
  const frame = frames[state.current];

  $("progress").textContent = `Step ${state.current + 1} of ${frames.length}`;
  document.querySelector("#progress-bar span").style.width =
    `${((state.current + 1) / frames.length) * 100}%`;
  $("explanation").textContent = frame.explanation || describeStep(frame);

    if (state.data.visualizer === "tree") {
    drawTree($("viz"), frame, state.layout);
  } else if (state.data.visualizer === "array") {
    const prev = state.direction === 1 ? frames[state.current - 1] : null;
    drawArray($("viz"), frame, state.layout, prev);
  } else {
    $("viz").innerHTML = "";
    $("explanation").textContent = `The "${state.data.visualizer}" visualizer isn't built yet.`;
  }
  state.direction = 0;

  renderQuiz(frame);

  $("back").disabled = state.current === 0;
  $("next").disabled = state.current === frames.length - 1 || quizBlocking();
}

// Until the Gemini explanation pass exists, describe each step from the
// trace itself. Built only from recorded values, so it can't be wrong.
function describeStep(frame) {
  if (state.data.visualizer === "array") return describeArrayStep(frame);
  if (state.data.visualizer !== "tree") return "";
  const { nodes, current } = frame.state;
  const node = nodes.find(n => n.id === current);
  if (!node) return "";
  const show = v => JSON.stringify(v);
  if (node.status === "returned") {
    const kids = nodes.filter(n => n.parent === node.id && n.status === "returned");
    if (kids.length) {
      const parts = kids.map(k => `${k.label} = ${show(k.returned)}`).join(" and ");
      return `With ${parts}, ${node.label} returns ${show(node.returned)}.`;
    }
    return `${node.label} returns ${show(node.returned)} directly. This is a base case.`;
  }
  if (node.parent === null) return `Start: call ${node.label}.`;
  const parent = nodes.find(n => n.id === node.parent);
  return `${parent.label} calls ${node.label} and waits for its answer.`;
}


function describeArrayStep(frame) {
  const i = state.current;
  const { array, pointers = {}, highlight = [] } = frame.state;
  if (i === 0) return `Start with [${array.join(", ")}].`;
  const prev = state.data.frames[i - 1].state;
  if (highlight.length === 2) {
    const [a, b] = highlight;
    return `Swap positions ${a} and ${b}: ${prev.array[a]} and ${prev.array[b]} trade places.`;
  }
  if (highlight.length === 1) {
    const k = highlight[0];
    return `Position ${k} changes from ${prev.array[k]} to ${array[k]}.`;
  }
    const parts = Object.keys(pointers)
    .filter(p => pointers[p] !== (prev.pointers || {})[p])
    .map(p => `${p} moves to ${pointers[p]}`);
  const vars = frame.state.vars || {}, prevVars = prev.vars || {};
  for (const k of Object.keys(vars)) {
    if (JSON.stringify(vars[k]) !== JSON.stringify(prevVars[k])) parts.push(`${k} becomes ${JSON.stringify(vars[k])}`);
  }
  return parts.length ? parts.join(", ") + "." : "";
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
  state.direction = delta;
  render();
}

// Going back to the upload page keeps its results if we came from there.
$("back-link").onclick = e => {
  if (document.referrer.includes("upload.html")) { e.preventDefault(); history.back(); }
};

$("next").onclick = () => step(1);
$("back").onclick = () => step(-1);
document.addEventListener("keydown", e => {
  if (e.key === "ArrowRight") step(1);
  if (e.key === "ArrowLeft") step(-1);
});

load();
