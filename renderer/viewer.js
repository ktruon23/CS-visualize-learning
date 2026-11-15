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
  resumeAfterQuiz: false, // autoplay stopped at a quiz; continue once it's answered
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
    : data.visualizer === "dict"
    ? layoutDict(data.frames)
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
  pause();
  state.resumeAfterQuiz = false;
  state.data = null;
  $("note").hidden = true;      // clear what belonged to the previous example
  $("code").hidden = true;
  $("viz").innerHTML = "";
  $("quiz").hidden = true;
  $("explanation").textContent = text;
  $("progress").textContent = "";
  $("back").disabled = $("next").disabled = true;
  updatePlayButton();
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

  // Only animate when moving forward one step (Next / autoplay). Back is instant.
  const prev = state.direction === 1 ? frames[state.current - 1] : null;
  if (prev) {
    replayAnimation($("explanation"), "appear");
    if (frame.quiz) setTimeout(() => replayAnimation($("quiz"), "appear"), 0);
  }

  if (state.data.visualizer === "tree") {
    drawTree($("viz"), frame, state.layout, prev);
  } else if (state.data.visualizer === "array") {
    drawArray($("viz"), frame, state.layout, prev);
  } else if (state.data.visualizer === "dict") {
    drawDict($("viz"), frame, state.layout, prev);
  } else {
    $("viz").innerHTML = "";
    $("explanation").textContent = `The "${state.data.visualizer}" visualizer isn't built yet.`;
  }
  state.direction = 0;

  renderQuiz(frame);

  $("back").disabled = state.current === 0;
  $("next").disabled = state.current === frames.length - 1 || quizBlocking();

  // Autoplay stopped for a quiz: carry on once it's answered.
  if (state.resumeAfterQuiz && !quizBlocking()) {
    state.resumeAfterQuiz = false;
    play();
  }
  updatePlayButton();
}

// Until the Gemini explanation pass exists, describe each step from the
// trace itself. Built only from recorded values, so it can't be wrong.
function describeStep(frame) {
  if (state.data.visualizer === "array") return describeArrayStep(frame);
  if (state.data.visualizer === "dict") return describeDictStep(frame, state.layout);
  if (state.data.visualizer !== "tree") return "";
  const { nodes, current } = frame.state;
  const node = nodes.find(n => n.id === current);
  if (!node) return "";
  const show = v => JSON.stringify(v);
  const parent = nodes.find(n => n.id === node.parent);

  // Recursion that splits a list in two (quicksort, merge sort): say how.
  const split = node.status === "returned" ? listSplit(node) : parent && listSplit(parent);
  if (split) {
    const { left, right, pivot, byPivot, kids } = split;
    if (node.status !== "returned" && node.id === kids[0].id) {
      const how = byPivot && !left.length && !right.length
        ? `picks ${show(pivot)} as the pivot, and nothing else is left to split`
        : byPivot
        ? `picks ${show(pivot)} as the pivot. The rest splits into ${show(left)} (≤ ${show(pivot)}) and ${show(right)} (> ${show(pivot)})`
        : pivot !== null
        ? `keeps ${show(pivot)} aside and splits the rest into ${show(left)} and ${show(right)}`
        : `splits its list into ${show(left)} and ${show(right)}`;
      return `${parent.label} ${how}. First the left part: ${node.label}.`;
    }
    if (node.status !== "returned" && node.id === kids[1].id) {
      return `Left part done. Now the right part: ${node.label}.`;
    }
    if (node.status === "returned") {
      const [l, r] = kids.map(k => nodes.find(n => n.id === k.id)?.returned);
      const joined = pivot !== null ? [...(l || []), pivot, ...(r || [])] : null;
      const result = node.returned;
      const isSorted = xs => Array.isArray(xs) && xs.every((x, i) => i === 0 || xs[i - 1] <= x);
      const done = node.parent === null && isSorted(result) ? " The whole list is sorted." : "";
      if (joined && show(joined) === show(result)) {
        return `${node.label} joins ${show(l)} ++ [${show(pivot)}] ++ ${show(r)} = ${show(result)}.` + done;
      }
      // Merge sort: the answer is both sorted halves interleaved in order.
      const sameItems = (a, b) => show([...a].sort()) === show([...b].sort());
      if (pivot === null && Array.isArray(l) && Array.isArray(r) && isSorted(result) && sameItems([...l, ...r], result)) {
        return `${node.label} merges ${show(l)} and ${show(r)} into ${show(result)}.` + done;
      }
    }
  }

  if (node.status === "returned") {
    const kids = nodes.filter(n => n.parent === node.id && n.status === "returned");
    if (kids.length) {
      const parts = kids.map(k => `${k.label} = ${show(k.returned)}`).join(" and ");
      return `With ${parts}, ${node.label} returns ${show(node.returned)}.`;
    }
    return `${node.label} returns ${show(node.returned)} directly. This is a base case.`;
  }
  if (node.parent === null) return `Start: call ${node.label}.`;
  return `${parent.label} calls ${node.label} and waits for its answer.`;
}

// For a call that splits one list into two recursive calls (quicksort, merge
// sort): the two parts, and what was left over (quicksort's pivot). Uses the
// finished trace, so the whole split is known as soon as the first part starts.
// Every claim (left <= pivot < right) is checked against the recorded values.
function listSplit(node) {
  const all = state.data.frames[state.data.frames.length - 1].state.nodes;
  const listOf = n => {
    const vals = Object.values(n.args || {});
    return vals.length === 1 && Array.isArray(vals[0]) && vals[0].every(x => !Array.isArray(x)) ? vals[0] : null;
  };
  const whole = listOf(node);
  if (!whole) return null;
  const kids = all.filter(n => n.parent === node.id);
  if (kids.length !== 2 || kids.some(k => !listOf(k))) return null;
  const rest = [...whole];
  for (const k of kids) {
    for (const x of listOf(k)) {
      const at = rest.findIndex(y => JSON.stringify(y) === JSON.stringify(x));
      if (at < 0) return null;   // the parts aren't pieces of this list
      rest.splice(at, 1);
    }
  }
  const [left, right] = kids.map(listOf);
  const pivot = rest.length === 1 ? rest[0] : null;
  const byPivot = typeof pivot === "number" && left.every(x => x <= pivot) && right.every(x => x > pivot);
  return { left, right, pivot, byPivot, kids };
}

// Same idea for arrays: say what changed since the previous step.
function describeArrayStep(frame) {
  const i = state.current;
  const { array, pointers = {}, highlight = [] } = frame.state;
  if (i === 0) return `Start with [${array.join(", ")}].`;
  const prev = state.data.frames[i - 1].state;
  // Only describe a change from the old value if the old value existed
  // (the array can grow between steps, which used to print "undefined").
  const had = k => k < prev.array.length;
  if (highlight.length === 2 && had(highlight[0]) && had(highlight[1])) {
    const [a, b] = highlight;
    return `Swap positions ${a} and ${b}: ${prev.array[a]} and ${prev.array[b]} trade places.`;
  }
  if (highlight.length === 1) {
    const k = highlight[0];
    return had(k)
      ? `Position ${k} changes from ${prev.array[k]} to ${array[k]}.`
      : `Position ${k} becomes ${array[k]}.`;
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

// Restart a CSS animation on an element that's already on the page.
function replayAnimation(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;   // forces the browser to notice the removal
  el.classList.add(cls);
}

// ---------- controls ----------

// Back / Next / arrow keys: a manual step always stops autoplay.
function step(delta) {
  pause();
  state.resumeAfterQuiz = false;
  advance(delta);
}

function advance(delta) {
  if (!state.data) return false;
  const next = state.current + delta;
  if (next < 0 || next >= state.data.frames.length) return false;
  if (delta > 0 && quizBlocking()) return false;
  state.current = next;
  state.direction = delta;
  render();
  return true;
}

// ---------- autoplay ----------

const PLAY_DELAY_MS = 1100;   // time on each step while playing
let playTimer = null;

const isPlaying = () => playTimer !== null;
const atEnd = () => state.data && state.current === state.data.frames.length - 1;

function play() {
  if (!state.data || state.data.frames.length < 2 || isPlaying()) return;
  if (atEnd()) {             // "Replay": start over from the first step
    state.current = 0;
    state.answered = new Set();
    render();
  }
  playTimer = setInterval(tick, PLAY_DELAY_MS);
  updatePlayButton();
}

function pause() {
  clearInterval(playTimer);
  playTimer = null;
  updatePlayButton();
}

function tick() {
  if (!advance(1)) { pause(); return; }
  if (atEnd()) { pause(); return; }
  if (quizBlocking()) {      // let the student answer before moving on
    pause();
    state.resumeAfterQuiz = true;
  }
}

function updatePlayButton() {
  const btn = $("play");
  const playing = isPlaying();
  btn.textContent = playing ? "Pause" : atEnd() ? "Replay" : "Play";
  btn.setAttribute("aria-pressed", String(playing));
  btn.classList.toggle("playing", playing);
  btn.disabled = !state.data || state.data.frames.length < 2 || (!playing && quizBlocking());
}

// Going back to the upload page keeps its results if we came from there.
$("back-link").onclick = e => {
  if (document.referrer.includes("upload.html")) { e.preventDefault(); history.back(); }
};

$("next").onclick = () => step(1);
$("back").onclick = () => step(-1);
$("play").onclick = () => (isPlaying() ? pause() : play());
document.addEventListener("keydown", e => {
  if (e.target.tagName === "SELECT") return;   // arrows change the dropdown there
  if (e.key === "ArrowRight") step(1);
  if (e.key === "ArrowLeft") step(-1);
  // Space always toggles autoplay, even when Back/Next has focus after a click.
  if (e.key === " " && !["INPUT", "TEXTAREA"].includes(e.target.tagName)) {
    e.preventDefault();
    if (!e.repeat) isPlaying() ? pause() : play();
  }
});
// A focused button would also "click" itself when Space is released; stop that.
document.addEventListener("keyup", e => {
  if (e.key === " " && e.target.tagName === "BUTTON") e.preventDefault();
});

start();