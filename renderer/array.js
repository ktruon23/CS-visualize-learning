// Array visualizer: layout + drawing.
//
// layoutArray() works out the size of every cell and where every index goes.
// Call it once with ALL frames of an example, so cells never move or resize
// while stepping. drawArray() then draws any single frame using that layout.
//
// Frame state (from the tracer):
//   { array: [2, 7, 9, 4], pointers: {lo: 0, hi: 3, i: -1, j: 1},
//     highlight: [1, 3], py_line: 13 }
//
// Pointer values can be out of range (e.g. i = -1 in Lomuto partition, or
// j = len after a loop). Those are drawn in a dashed "ghost" slot just
// outside the array instead of being dropped.
//
// Suggested CSS (match colors to the tree visualizer):
//   .cell rect          { fill: #fff; stroke: #888; stroke-width: 1.5; }
//   .cell text          { font: 16px monospace; text-anchor: middle; }
//   .cell               { transition: transform 0.35s ease; }
//   .cell.changed rect  { fill: #fff3b0; stroke: #e0a800; stroke-width: 2.5; }
//   .cell.new           { animation: pop 0.35s ease; }
//   @keyframes pop      { from { opacity: 0; } to { opacity: 1; } }
//   .ghost rect         { fill: none; stroke: #bbb; stroke-dasharray: 4 3; }
//   .index              { font: 12px monospace; fill: #888; text-anchor: middle; }
//   .range              { fill: #e8f0ff; }
//   .pointer line, .pointer polygon { stroke: #3367d6; fill: #3367d6; }
//   .pointer text       { font: bold 13px monospace; fill: #3367d6; text-anchor: middle; }
//   .vars               { font: 14px monospace; fill: #444; }
//   .vars .changed      { font-weight: bold; fill: #b07a00; }

const ARR_CELL_H = 44;        // cell height (px)
const ARR_MIN_CELL_W = 48;    // narrowest a cell can be (px)
const ARR_CHAR_W = 9.6;       // approx width of one monospace character at 16px
const ARR_GAP = 6;            // space between cells (px)
const ARR_PAD = 30;           // padding around the whole drawing
const ARR_INDEX_SPACE = 22;   // row above the cells for index numbers
const ARR_ARROW_SPACE = 22;   // room for the pointer arrows under the cells
const ARR_POINTER_ROW = 18;   // height of each stacked pointer label
const ARR_VARS_ROW = 30;      // row under everything for "best = 4   idx = 2"

// If both names of a pair are pointers, the subarray between them is shaded
// (e.g. the part quicksort is currently working on). First match wins.
const ARR_RANGE_PAIRS = [["lo", "hi"], ["low", "high"], ["left", "right"], ["l", "r"]];

function arrVarsText(vars) {
  return Object.entries(vars || {}).map(([k, v]) => `${k} = ${arrFormat(v)}`).join("   ");
}

function arrFormat(v) {
  return typeof v === "string" || typeof v === "number" ? String(v) : JSON.stringify(v);
}

// Clamp a pointer to the slots we draw: -1 .. length (one ghost slot each side).
function arrClampIndex(p, length) {
  return Math.max(-1, Math.min(p, length));
}

// Group pointer names by the (clamped) index they point at, keeping the
// tracer's order so labels always stack the same way.
function arrGroupPointers(pointers, length) {
  const groups = new Map();
  for (const [name, value] of Object.entries(pointers || {})) {
    const idx = arrClampIndex(value, length);
    if (!groups.has(idx)) groups.set(idx, []);
    groups.get(idx).push({ name, value, outOfRange: value < 0 || value >= length });
  }
  return groups;
}

// frames: every frame of ONE example.
// Returns { cellW, minIdx, maxIdx, cellsTop, pointersTop, varsTop, width, height, xOf }.
function layoutArray(frames) {
  let minIdx = 0, maxIdx = 0, maxStack = 0, maxChars = 1, maxVarsChars = 0;

  for (const f of frames) {
    const { array, pointers, vars } = f.state;
    maxIdx = Math.max(maxIdx, array.length - 1);
    maxVarsChars = Math.max(maxVarsChars, arrVarsText(vars).length);
    for (const v of array) maxChars = Math.max(maxChars, arrFormat(v).length);
    for (const [idx, list] of arrGroupPointers(pointers, array.length)) {
      minIdx = Math.min(minIdx, idx);
      maxIdx = Math.max(maxIdx, idx);
      maxStack = Math.max(maxStack, list.length);
      for (const p of list) maxChars = Math.max(maxChars, p.outOfRange ? `${p.name}=${p.value}`.length : 1);
    }
  }

  const cellW = Math.max(ARR_MIN_CELL_W, maxChars * ARR_CHAR_W + 20);
  const slots = maxIdx - minIdx + 1;
  const cellsTop = ARR_PAD + ARR_INDEX_SPACE;
  const pointersTop = cellsTop + ARR_CELL_H + ARR_ARROW_SPACE;
  const varsTop = pointersTop + maxStack * ARR_POINTER_ROW + (maxVarsChars ? 12 : 0);
  const cellsWidth = 2 * ARR_PAD + slots * (cellW + ARR_GAP) - ARR_GAP;
  const varsWidth = 2 * ARR_PAD + maxVarsChars * 8.4;

  return {
    cellW, minIdx, maxIdx, cellsTop, pointersTop, varsTop,
    width: Math.max(cellsWidth, varsWidth),
    height: varsTop + (maxVarsChars ? ARR_VARS_ROW : 0) + ARR_PAD,
    // Left edge of the cell at index i (works for ghost slots -1 and length too).
    xOf: i => ARR_PAD + (i - minIdx) * (cellW + ARR_GAP),
  };
}

// Small helper to create SVG elements (own name so it can't clash with the tree file).
function arrSvgEl(tag, attrs = {}, text = null) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text !== null) el.textContent = text;
  return el;
}

// Where did the value now at index i come from in the previous frame?
// Prefers other highlighted indices (so a swap pairs up correctly), then the
// nearest match. Returns null if the value didn't exist before.
function arrFindSource(prevArray, value, i, highlight) {
  const key = JSON.stringify(value);
  let best = null, bestScore = Infinity;
  for (let k = 0; k < prevArray.length; k++) {
    if (k === i || JSON.stringify(prevArray[k]) !== key) continue;
    const score = Math.abs(k - i) + (highlight.includes(k) ? 0 : 1000);
    if (score < bestScore) { best = k; bestScore = score; }
  }
  return best;
}

// Draw one frame. svg: the <svg> element. layout: result of layoutArray().
// prevFrame (optional): the frame before this one. Pass it when stepping
// forward and changed cells will slide in from where their value came from.
function drawArray(svg, frame, layout, prevFrame = null) {
  const { array, pointers = {}, highlight = [] } = frame.state;
  const { cellW, cellsTop, pointersTop, xOf } = layout;

  svg.innerHTML = "";
  svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
  // Same sizing rules as the tree: don't blow small arrays up past ~1.3x,
  // don't shrink big ones below ~0.85x (the panel scrolls instead).
  svg.style.maxWidth = `${Math.round(layout.width * 1.3)}px`;
  svg.style.minWidth = `${Math.round(layout.width * 0.85)}px`;
  svg.style.minHeight = `${Math.round(layout.height * 0.85)}px`;

  const groups = arrGroupPointers(pointers, array.length);

  // 1. Shaded range between lo/hi (or similar), behind everything else.
  for (const [a, b] of ARR_RANGE_PAIRS) {
    if (!(a in pointers) || !(b in pointers)) continue;
    const lo = Math.max(0, pointers[a]), hi = Math.min(array.length - 1, pointers[b]);
    if (lo <= hi) {
      svg.appendChild(arrSvgEl("rect", {
        x: xOf(lo) - ARR_GAP / 2, y: cellsTop - 4,
        width: xOf(hi) - xOf(lo) + cellW + ARR_GAP, height: ARR_CELL_H + 8,
        rx: 6, class: "range",
      }));
    }
    break;
  }

  // 2. Ghost slots, only where a pointer currently points outside the array.
  for (const idx of groups.keys()) {
    if (idx >= 0 && idx < array.length) continue;
    const g = arrSvgEl("g", { class: "ghost" });
    g.appendChild(arrSvgEl("rect", { x: xOf(idx), y: cellsTop, width: cellW, height: ARR_CELL_H, rx: 6 }));
    svg.appendChild(g);
  }

  // 3. Cells with their index numbers above them.
  const animate = prevFrame && prevFrame.step === frame.step - 1;
  const toSettle = [];
  for (let i = 0; i < array.length; i++) {
    const x = xOf(i);
    svg.appendChild(arrSvgEl("text", { x: x + cellW / 2, y: cellsTop - 8, class: "index" }, String(i)));

    const changed = highlight.includes(i);
    const g = arrSvgEl("g", { class: changed ? "cell changed" : "cell" });
    g.appendChild(arrSvgEl("rect", { x, y: cellsTop, width: cellW, height: ARR_CELL_H, rx: 6 }));
    g.appendChild(arrSvgEl("text", { x: x + cellW / 2, y: cellsTop + ARR_CELL_H / 2 + 6 }, arrFormat(array[i])));

    if (animate && changed) {
      const k = arrFindSource(prevFrame.state.array, array[i], i, highlight);
      if (k !== null) {
        // Start drawn at the old position, then let the CSS transition slide it home.
        g.style.transition = "none";
        g.style.transform = `translate(${xOf(k) - x}px, 0)`;
        toSettle.push(g);
      } else {
        g.classList.add("new");   // value didn't exist before (e.g. the insertion key)
      }
    }
    svg.appendChild(g);
  }
  if (toSettle.length) {
    // Two frames: one so the browser paints the start position, one to release it.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      for (const g of toSettle) { g.style.transition = ""; g.style.transform = ""; }
    }));
  }

  // 4. Pointers: an arrow up to the cell, names stacked underneath.
  for (const [idx, list] of groups) {
    const cx = xOf(idx) + cellW / 2;
    const g = arrSvgEl("g", { class: "pointer" });
    const tipY = cellsTop + ARR_CELL_H + 3;
    g.appendChild(arrSvgEl("line", { x1: cx, y1: pointersTop - 4, x2: cx, y2: tipY + 6 }));
    g.appendChild(arrSvgEl("polygon", {
      points: `${cx},${tipY} ${cx - 5},${tipY + 8} ${cx + 5},${tipY + 8}`,
    }));
    list.forEach((p, row) => {
      const label = p.outOfRange ? `${p.name}=${p.value}` : p.name;
      g.appendChild(arrSvgEl("text", { x: cx, y: pointersTop + 10 + row * ARR_POINTER_ROW }, label));
    });
    svg.appendChild(g);
  }

  // 5. Other variables (accumulators, the insertion key, ...) on one line,
  // with the ones that just changed in bold.
  const vars = frame.state.vars || {};
  if (Object.keys(vars).length) {
    const before = (prevFrame && prevFrame.state.vars) || null;
    const text = arrSvgEl("text", { x: ARR_PAD, y: layout.varsTop + 18, class: "vars" });
    Object.entries(vars).forEach(([k, v], n) => {
      const changed = before !== null && JSON.stringify(before[k]) !== JSON.stringify(v);
      const span = arrSvgEl("tspan", changed ? { class: "changed" } : {},
        `${n ? "   " : ""}${k} = ${arrFormat(v)}`);
      span.setAttribute("xml:space", "preserve");
      text.appendChild(span);
    });
    text.setAttribute("xml:space", "preserve");
    svg.appendChild(text);
  }

  // Keep the action in view: the first changed cell, else the first pointer.
  const focus = highlight.length ? highlight[0] : (groups.size ? [...groups.keys()][0] : null);
  if (focus !== null) arrScrollTo(svg, layout, xOf(focus) + cellW / 2);
}

// When the array is wider than the panel, scroll so x (drawing units) is centered.
function arrScrollTo(svg, layout, x) {
  const wrap = svg.parentElement;
  if (!wrap || wrap.scrollWidth <= wrap.clientWidth) return;
  const scale = Math.min(svg.clientWidth / layout.width, svg.clientHeight / layout.height);
  const offsetX = (svg.clientWidth - layout.width * scale) / 2;   // the drawing is centered
  wrap.scrollLeft = offsetX + x * scale - wrap.clientWidth / 2;
}

// Lets Node tests require() this file; ignored in the browser.
if (typeof module !== "undefined") module.exports = { layoutArray, drawArray };