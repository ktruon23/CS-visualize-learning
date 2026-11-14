// Upload page: send a PDF to the server, list the examples it finds,
// and open the viewer for the one the student picks.

const $ = id => document.getElementById(id);
const input = $("pdf-input");
const button = $("upload-btn");
const status = $("status");

input.onchange = () => { button.disabled = !input.files.length; };
button.onclick = upload;

// Coming back from the viewer: show the last deck's results again.
try {
  const saved = JSON.parse(sessionStorage.getItem("lastDeck"));
  if (saved) {
    $("deck-name").textContent = saved.file_name || "";
    showResults(saved);
  }
} catch (e) {}

function setStatus(text, isError = false) {
  status.textContent = text;
  status.className = isError ? "error" : "";
}

async function upload() {
  const file = input.files[0];
  if (!file) return;

  button.disabled = true;
  $("results").hidden = true;
  $("deck-name").textContent = file.name;

  // Reading a deck can take a while, so show a running timer.
  const started = Date.now();
  const timer = setInterval(() => {
    const s = Math.round((Date.now() - started) / 1000);
    setStatus(`Reading the deck with Gemini… ${s}s`);
  }, 500);

  try {
    const form = new FormData();
    form.append("pdf", file);
    const res = await fetch("/api/decks", { method: "POST", body: form });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    body.file_name = file.name;
    try { sessionStorage.setItem("lastDeck", JSON.stringify(body)); } catch (e) {}
    showResults(body);
    setStatus(`Found ${body.examples.length} examples in ${Math.round((Date.now() - started) / 1000)}s.`);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    clearInterval(timer);
    button.disabled = false;
  }
}

function slideRange(item) {
  return item.slide_start === item.slide_end
    ? `slide ${item.slide_start}`
    : `slides ${item.slide_start}–${item.slide_end}`;
}

function showResults({ deck_id, examples, sections }) {
  const list = $("example-list");
  list.innerHTML = "";

  if (!examples.length) {
    list.innerHTML = "<li>No worked examples found in this deck.</li>";
  }

  examples.forEach((ex, i) => {
    const li = document.createElement("li");
    li.className = "example" + (ex.supported ? "" : " unsupported");

    const info = document.createElement("div");
    const title = document.createElement("div");
    title.textContent = ex.title;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = ex.supported
      ? `${slideRange(ex)} · ${ex.visualizer}`
      : `${slideRange(ex)} · not supported yet: ${ex.unsupported_reason || "unknown reason"}`;
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
    li.innerHTML = `<strong></strong> <span class="meta"></span><div></div>`;
    li.querySelector("strong").textContent = s.title;
    li.querySelector(".meta").textContent = `(${slideRange(s)})`;
    li.querySelector("div").textContent = s.summary;
    secList.appendChild(li);
  });

  $("results").hidden = false;
}

async function openExample(deckId, index, btn, errBox) {
  btn.disabled = true;
  btn.textContent = "Preparing…";
  errBox.textContent = "";
  try {
    const res = await fetch(`/api/decks/${deckId}/examples/${index}/trace`, { method: "POST" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    const q = new URLSearchParams({ data: body.data_url, slides: body.slides_url });
    location.href = `index.html?${q}`;
  } catch (e) {
    errBox.textContent = e.message;
    btn.disabled = false;
    btn.textContent = "Visualize";
  }
}
