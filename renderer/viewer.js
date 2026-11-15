// Viewer: the whole deck on the left, one example's animation on the right.
//
// Two ways to open it:
//   index.html?deck=<id>&example=<n>   a real uploaded deck (from the upload page)
//   index.html?data=samples/fib3.json  a single frames file (samples, testing)
//
// Frames file shape (see samples/fib3.json):
// { example_id, title, slide_start, slide_end, visualizer, original_code, note,
//   frames: [ { step, total_steps, state, explanation, quiz }, ... ] }

const params = new URLSearchParams(location.search);
const DECK_ID = params.get("deck");
const SAMPLE_URL = params.get("data") || "samples/fib3.json";
let slideDir = params.get("slides") || "../output/slides";

const state = {
  deck: null,            // { examples, num_slides } when viewing an uploaded deck
  exampleIndex: null,    // which deck example is on the right
  data: null,            // the frames file for that example
  current: 0,            // index into data.frames
  layout: null,          // computed once from the last frame
  answered: new Set(),   // frame indexes whose quiz has been answered
  direction: 0,          // +1 after Next, -1 after Back, 0 otherwise (array slide animation)
};

const $ = id => document.getElementById(id);
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- starting up ----------

async function start() {
  if (DECK_ID) {
    try {
      const res = await fetch(`/api/decks/${DECK_ID}`);
      if (!res.ok) throw new Error(`The server answered ${res.status}.`);
      state.deck = await res.json();
    } catch (err) {
      showError(`Couldn't load this deck (${err.message}). Go back and upload it again.`);
      return;
    }
    slideDir = `/decks/${DECK_ID}/slides`;
    buildSlideStrip(state.deck.num_slides);
    buildExamplePicker();
    const first = Number(params.get("example"));
    const firstSupported = state.deck.examples.findIndex(e => e.supported);
    await openExample(Number.isInteger(first) && state.deck.examples[first] ? first : firstSupported);
  } else {
    // Single sample file: no deck, so no picker and only one slide to show.
    $("example-picker").hidden = true;
    try {
      const res = await fetch(SAMPLE_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      buildSlideStrip(data.slide_end || data.slide_start || 1, data.slide_start);
      showFrames(data);
    } catch (err) {
      showError(`Couldn't load ${SAMPLE_URL} (${err.message}). Start the server from the repo folder with: python3 server.py`);
    }
  }
}

// ---------- left: the deck ----------

// One image per slide. `from` lets the sample view show just its own slide.
function buildSlideStrip(numSlides, from = 1) {
  const strip = $("slides");
  strip.innerHTML = "";
  for (let n = from; n <= numSlides; n++) {
    const fig = document.createElement("figure");
    fig.className = "slide";
    fig.id = `slide-${n}`;

    const img = document.createElement("img");
    img.alt = `Slide ${n}`;
    img.src = `${slideDir}/slide_${n}.png`;
    img.onerror = () => {
      const missing = document.createElement("div");
      missing.className = "slide-missing";
      missing.textContent = `Slide ${n} isn't available.`;
      img.replaceWith(missing);
    };

    const cap = document.createElement("figcaption");
    const num = document.createElement("span");
    num.className = "slide-num";
    num.textContent = n;
    cap.appendChild(num);

    // Buttons for examples that start on this slide.
    (state.deck?.examples || []).forEach((ex, i) => {
      if (ex.slide_start !== n || !ex.supported) return;
      const b = document.createElement("button");
      b.className = "slide-example";
      b.dataset.index = i;
      b.textContent = `Animate ${ex.title}`;
      b.onclick = () => openExample(i);
      cap.appendChild(b);
    });

    fig.append(img, cap);
    strip.appendChild(fig);
  }
}

// Outline the slides this example comes from and bring them into view.
function highlightSlides(start, end) {
  document.querySelectorAll(".slide.active").forEach(el => el.classList.remove("active"));
  for (let n = start; n <= end; n++) $(`slide-${n}`)?.classList.add("active");
  document.querySelectorAll(".slide-example").forEach(b =>
    b.classList.toggle("current", Number(b.dataset.index) === state.exampleIndex));
  scrollToSlide(start);
}

// Slides above the target need their real heights before we can scroll to
// it, so wait for those images to finish loading first.
let scrollRequest = 0;
async function scrollToSlide(n) {
  const request = ++scrollRequest;
  const above = [...document.querySelectorAll(".slide img")].filter(img => {
    const num = Number(img.closest(".slide").id.replace("slide-", ""));
    return num <= n && !img.complete;
  });
  await Promise.all(above.map(img => new Promise(done => {
    img.addEventListener("load", done, { once: true });
    img.addEventListener("error", done, { once: true });
  })));
  if (request !== scrollRequest) return;   // a newer example was picked meanwhile
  $(`slide-${n}`)?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
}

// ---------- right: picking an example ----------

function buildExamplePicker() {
  const select = $("example-select");
  select.innerHTML = "";
  state.deck.examples.forEach((ex, i) => {
    const opt = document.createElement("option");
    opt.value = i;
    const slides = ex.slide_start === ex.slide_end
      ? `slide ${ex.slide_start}` : `slides ${ex.slide_start}–${ex.slide_end}`;
    opt.textContent = ex.supported ? `${ex.title} (${slides})` : `${ex.title} (can't animate yet)`;
    opt.disabled = !ex.supported;
    select.appendChild(opt);
  });
  select.onchange = () => openExample(Number(select.value));
}

async function openExample(i) {
  if (i < 0 || !state.deck.examples[i]) {
    showError("This deck has no examples we can animate yet.");
    return;
  }
  const ex = state.deck.examples[i];
  state.exampleIndex = i;
  $("example-select").value = i;
  $("title").textContent = ex.title;
  highlightSlides(ex.slide_start, ex.slide_end);
  history.replaceState(null, "", `?deck=${DECK_ID}&example=${i}`);

  showLoading("Preparing this example…");
  try {
    // Writes the code and traces it the first time; instant after that (saved).
    const res = await fetch(`/api/decks/${DECK_ID}/examples/${i}/trace`, { method: "POST" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `The server answered ${res.status}.`);
    const frames = await (await fetch(body.data_url)).json();
    if (state.exampleIndex !== i) return;   // the student picked another one meanwhile
    showFrames(frames);
  } catch (err) {
    if (state.exampleIndex === i) showError(err.message);
  }
}

function showFrames(data) {
  state.data = data;
  state.current = 0;
  state.answered = new Set();
  state.layout = data.visualizer === "tree"
    ? layoutTree(data.frames[data.frames.length - 1].state.nodes)
    : data.visualizer === "array"
    ? layoutArray(data.frames)
    : null;

  $("title").textContent = data.title || data.example_id;
  $("note").hidden = !data.note;
  $("note").textContent = data.note || "";
  $("code").hidden = !data.original_code;
  $("code").textContent = data.original_code || "";
  if (!state.deck) highlightSlides(data.slide_start, data.slide_end || data.slide_start);
  render();
}

function showLoading(text) {
  state.data = null;
  $("note").hidden = true;      // clear what belonged to the previous example
  $("code").hidden = true;
  $("viz").innerHTML = "";
  $("quiz").hidden = true;
  $("explanation").textContent = text;
  $("progress").textContent = "";
  $("back").disabled = $("next").disabled = true;
  document.querySelector("#progress-bar span").style.width = "0";
}

function showError(text) {
  showLoading("");
  $("explanation").textContent = text;
  $("explanation").classList.add("error");
}

// ---------- drawing one step ----------

function render() {
  const frames = state.data.frames;
  const frame = frames[state.current];
  $("explanation").classList.remove("error");

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

// Same idea for arrays: say what changed since the previous step.
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

// ---------- quiz ----------

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

// ---------- controls ----------

function step(delta) {
  if (!state.data) return;
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
  if (e.target.tagName === "SELECT") return;   // arrows change the dropdown there
  if (e.key === "ArrowRight") step(1);
  if (e.key === "ArrowLeft") step(-1);
});

start();