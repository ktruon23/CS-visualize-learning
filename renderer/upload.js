// Upload page: send a PDF to the server, list the examples it finds,
// and open the viewer for the one the student picks.

const $ = id => document.getElementById(id);
const input = $("pdf-input");
const button = $("upload-btn");
const status = $("status");
const drop = $("drop");

const VISUALIZER_NAMES = { tree: "Recursion tree", array: "Array" };

// ---------- choosing a file (click or drag) ----------

function fileChosen() {
  const file = input.files[0];
  button.disabled = !file;
  drop.classList.toggle("has-file", Boolean(file));
  $("drop-title").textContent = file ? file.name : "Choose a lecture PDF";
  $("drop-hint").textContent = file ? "Click to choose a different file" : "or drag it here";
}
input.onchange = fileChosen;
["dragenter", "dragover"].forEach(ev =>
  drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("dragging"); }));
["dragleave", "drop"].forEach(ev =>
  drop.addEventListener(ev, () => drop.classList.remove("dragging")));
drop.addEventListener("drop", e => {
  e.preventDefault();
  if (e.dataTransfer.files.length) {
    input.files = e.dataTransfer.files;
    fileChosen();
  }
});

button.onclick = upload;

// Coming back from the viewer: show the last deck's results again.
try {
  const saved = JSON.parse(sessionStorage.getItem("lastDeck"));
  if (saved) showResults(saved);
} catch (e) {}

function setStatus(text, isError = false) {
  status.textContent = text;
  status.className = isError ? "error" : "";
}

// ---------- reading the deck ----------

async function upload() {
  const file = input.files[0];
  if (!file) return;

  button.disabled = true;
  $("results").hidden = true;

  // Reading a deck can take a while, so show a running timer.
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 1000);
  setStatus("Reading the slides…");
  const timer = setInterval(() => setStatus(`Reading the slides… ${seconds()}s`), 500);

  try {
    const form = new FormData();
    form.append("pdf", file);
    const res = await fetch("/api/decks", { method: "POST", body: form });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `The server answered ${res.status}.`);
    body.file_name = file.name;
    try { sessionStorage.setItem("lastDeck", JSON.stringify(body)); } catch (e) {}
    showResults(body);
    const n = body.examples.length;
    setStatus(`Found ${n} example${n === 1 ? "" : "s"} in ${seconds()}s.`);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    clearInterval(timer);
    button.disabled = false;
  }
}

function slideRange(item) {
  return item.slide_start === item.slide_end
    ? `Slide ${item.slide_start}`
    : `Slides ${item.slide_start}–${item.slide_end}`;
}

function showResults({ deck_id, examples, sections, file_name }) {
  $("deck-name").textContent = file_name || "";

  const list = $("example-list");
  list.innerHTML = "";

  if (!examples.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No functions we can animate were found in this deck. Try a lecture on recursion, sorting, or searching.";
    list.appendChild(li);
  }

  // Supported examples first, then the ones we can't show yet.
  const ordered = examples
    .map((ex, i) => ({ ex, i }))
    .sort((a, b) => Number(b.ex.supported) - Number(a.ex.supported));

  ordered.forEach(({ ex, i }) => {
    const li = document.createElement("li");
    li.className = "example" + (ex.supported ? "" : " unsupported");

    const info = document.createElement("div");
    const title = document.createElement("div");
    title.className = "ex-title";
    title.textContent = ex.title;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = ex.supported
      ? `${slideRange(ex)}, ${(VISUALIZER_NAMES[ex.visualizer] || ex.visualizer).toLowerCase()}`
      : `${slideRange(ex)}. Can't animate yet: ${ex.unsupported_reason || "unsupported example"}`;
    const err = document.createElement("div");
    err.className = "error";
    info.append(title, meta, err);
    li.appendChild(info);

    if (ex.supported) {
      const btn = document.createElement("button");
      btn.textContent = "Visualize";
      btn.onclick = () => openExample(deck_id, i, btn, err);
      li.appendChild(btn);
    }
    list.appendChild(li);
  });

  const secList = $("section-list");
  secList.innerHTML = "";
  sections.forEach(s => {
    const li = document.createElement("li");
    li.className = "section-item";
    const range = document.createElement("span");
    range.className = "range";
    range.textContent = slideRange(s);
    const body = document.createElement("div");
    const t = document.createElement("strong");
    t.textContent = s.title;
    const sum = document.createElement("span");
    sum.className = "summary";
    sum.textContent = s.summary;
    body.append(t, sum);
    li.append(range, body);
    secList.appendChild(li);
  });

  $("results").hidden = false;
}

// ---------- opening one example ----------

async function openExample(deckId, index, btn, errBox) {
  btn.disabled = true;
  btn.textContent = "Preparing…";
  errBox.textContent = "";
  try {
    const res = await fetch(`/api/decks/${deckId}/examples/${index}/trace`, { method: "POST" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `The server answered ${res.status}.`);
    const q = new URLSearchParams({ data: body.data_url, slides: body.slides_url });
    location.href = `index.html?${q}`;
  } catch (e) {
    errBox.textContent = e.message;
    btn.disabled = false;
    btn.textContent = "Visualize";
  }
}
