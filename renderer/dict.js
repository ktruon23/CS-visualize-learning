// Dictionary visualizer: recursion over a list of key/value pairs.
//
// Example (Haskell slide):
//   f _ []   = 0
//   f x ((k,v) : ps) | x == k    = v
//                    | otherwise = f x ps
//
// The frames come from the tree tracer (one per call start / return), with each
// node's real arguments in `node.args`. We draw:
//   left:  the dictionary as a table of (key, value) rows
//   right: each recursive call, lined up with the row it is checking
// Each call receives a shorter list, so the row a call checks is
//   original length - length of the list it received.
//
// layoutDict() runs once with ALL frames (so nothing moves while stepping);
// drawDict() draws one frame.

const DICT_ROW_H = 40;      // row height (px)
const DICT_ROW_GAP = 10;    // space between rows
const DICT_PAD = 28;        // padding around the drawing
const DICT_HEAD_H = 46;     // room for "Looking up ..." at the top
const DICT_GUTTER = 56;     // space between the table and the calls
const DICT_CHAR_W = 8.4;    // approx width of one monospace character at 14px

// ---------- reading the trace ----------

function dictIsPairList(v) {
  return Array.isArray(v) && v.every(p => Array.isArray(p) && p.length === 2);
}

// "b" for strings, 1 for numbers, ("a",1) for pairs, [..] for lists.
function dictShow(v) {
  if (dictIsPairList(v)) return "[" + v.map(dictShow).join(",") + "]";
  if (Array.isArray(v) && v.length === 2 && !Array.isArray(v[0])) return `(${dictShow(v[0])},${dictShow(v[1])})`;
  if (Array.isArray(v)) return "[" + v.map(dictShow).join(",") + "]";
  return typeof v === "string" ? JSON.stringify(v) : String(v);
}

// Which argument is the list of pairs, and which (if any) is the key we look for.
function dictReadRoot(frames) {
  const root = frames[0].state.nodes.find(n => n.parent === null);
  const names = Object.keys(root.args || {});
  const pairsArg = names.find(n => dictIsPairList(root.args[n]) && root.args[n].length > 0)
    ?? names.find(n => dictIsPairList(root.args[n]));
  const keyArg = names.find(n => n !== pairsArg);
  const fnName = (root.label.match(/^[A-Za-z_][\w']*/) || ["f"])[0];
  return { pairs: root.args[pairsArg] || [], pairsArg, keyArg,
           key: keyArg !== undefined ? root.args[keyArg] : undefined, fnName };
}

// The row this call is checking (pairs.length means "the empty list").
function dictRowOf(node, info) {
  const rest = (node.args || {})[info.pairsArg] || [];
  return info.pairs.length - rest.length;
}

function dictSame(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// Short call label in the slide's style: f "b" [("b",2),("c",3)]
function dictCallLabel(node, info) {
  const rest = (node.args || {})[info.pairsArg] || [];
  const shown = rest.length > 3 ? rest.slice(0, 2).map(dictShow).join(",") + ",…" : rest.map(dictShow).join(",");
  const keyPart = info.keyArg !== undefined ? ` ${dictShow(node.args[info.keyArg])}` : "";
  return `${info.fnName}${keyPart} [${shown}]`;
}

// ---------- layout (once per example) ----------

function layoutDict(frames) {
  const info = dictReadRoot(frames);
  const allNodes = frames[frames.length - 1].state.nodes;

  const keyW = Math.max(70, ...info.pairs.map(p => dictShow(p[0]).length * DICT_CHAR_W + 28));
  const valW = Math.max(70, ...info.pairs.map(p => dictShow(p[1]).length * DICT_CHAR_W + 28));
  const callW = Math.max(120, ...allNodes.map(n => dictCallLabel(n, info).length * DICT_CHAR_W + 28));

  const tableX = DICT_PAD;
  const callX = tableX + keyW + valW + DICT_GUTTER;
  const rowY = i => DICT_PAD + DICT_HEAD_H + i * (DICT_ROW_H + DICT_ROW_GAP);
  const rows = info.pairs.length + 1;   // + the "end of list" slot

  return {
    info, keyW, valW, callW, tableX, callX, rowY,
    width: callX + callW + 80 + DICT_PAD,                 // +80 for "= value"
    height: rowY(rows) + DICT_PAD,
  };
}

// ---------- drawing one frame ----------

function drawDict(svg, frame, layout, prevFrame = null) {
  const { info, keyW, valW, callW, tableX, callX, rowY } = layout;
  const { nodes, current } = frame.state;
  const changes = frameChanges(frame, prevFrame);   // from tree.js
  const el = svgEl;   // helper from tree.js

  svg.innerHTML = "";
  svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
  svg.style.maxWidth = `${Math.round(layout.width * 1.3)}px`;
  svg.style.minWidth = `${Math.round(layout.width * 0.85)}px`;
  svg.style.minHeight = `${Math.round(layout.height * 0.85)}px`;

  // What each row has been through so far in this frame.
  const visited = new Map();   // row -> node that checked it
  for (const n of nodes) visited.set(dictRowOf(n, info), n);
  const currentNode = nodes.find(n => n.id === current);
  const currentRow = currentNode ? dictRowOf(currentNode, info) : -1;

  // Heading: what we're looking for.
  if (info.keyArg !== undefined) {
    svg.appendChild(el("text", { x: tableX, y: DICT_PAD + 18, class: "dict-heading" },
      `Looking up ${info.keyArg} = ${dictShow(info.key)}`));
  }
  svg.appendChild(el("text", { x: tableX + 12, y: DICT_PAD + DICT_HEAD_H - 8, class: "dict-col" }, "key"));
  svg.appendChild(el("text", { x: tableX + keyW + 12, y: DICT_PAD + DICT_HEAD_H - 8, class: "dict-col" }, "value"));

  // Rows of the dictionary.
  info.pairs.forEach(([k, v], i) => {
    const y = rowY(i);
    const checker = visited.get(i);
    const isMatch = info.keyArg !== undefined && dictSame(k, info.key);
    const cls = ["dict-row"];
    if (checker) cls.push(isMatch ? "match" : "miss");
    if (i === currentRow) cls.push("current");
    if (checker && isMatch && checker.status === "returned") cls.push("found");
    if (checker && isMatch && changes.settled.has(checker.id)) cls.push("settle");

    const g = el("g", { class: cls.join(" ") });
    g.appendChild(el("rect", { x: tableX, y, width: keyW, height: DICT_ROW_H, rx: 6, class: "dict-key" }));
    g.appendChild(el("rect", { x: tableX + keyW, y, width: valW, height: DICT_ROW_H, rx: 6, class: "dict-val" }));
    g.appendChild(el("text", { x: tableX + keyW / 2, y: y + DICT_ROW_H / 2 + 5, class: "dict-text" }, dictShow(k)));
    g.appendChild(el("text", { x: tableX + keyW + valW / 2, y: y + DICT_ROW_H / 2 + 5, class: "dict-text" }, dictShow(v)));
    svg.appendChild(g);
  });

  // The "end of the list" slot, used when a call receives [].
  const endY = rowY(info.pairs.length);
  const endCls = ["dict-end"];
  if (visited.has(info.pairs.length)) endCls.push("reached");
  if (currentRow === info.pairs.length) endCls.push("current");
  const endG = el("g", { class: endCls.join(" ") });
  endG.appendChild(el("rect", { x: tableX, y: endY, width: keyW + valW, height: DICT_ROW_H, rx: 6 }));
  endG.appendChild(el("text", { x: tableX + (keyW + valW) / 2, y: endY + DICT_ROW_H / 2 + 5, class: "dict-text" }, "[]  end of list"));
  svg.appendChild(endG);

  // Calls, each beside the row it checks, joined to the call that made it.
  for (const n of nodes) {
    const row = dictRowOf(n, info);
    const y = rowY(row);
    const parent = nodes.find(p => p.id === n.parent);
    if (parent) {
      const py = rowY(dictRowOf(parent, info));
      const isNew = changes.entered.has(n.id);
      svg.appendChild(el("line", {
        x1: callX + 16, y1: py + DICT_ROW_H, x2: callX + 16, y2: y,
        class: isNew ? "edge enter" : "edge", ...(isNew ? { pathLength: 1 } : {}),
      }));
    }
    // A short pointer from the call to the row it's looking at.
    svg.appendChild(el("line", {
      x1: tableX + keyW + valW + 6, y1: y + DICT_ROW_H / 2, x2: callX - 6, y2: y + DICT_ROW_H / 2,
      class: "dict-link" + (n.id === current ? " current" : "") + (changes.entered.has(n.id) ? " enter" : ""),
    }));

    const cls = ["node", n.status];
    if (n.id === current) cls.push("current");
    if (changes.entered.has(n.id)) cls.push("enter");
    if (changes.settled.has(n.id)) cls.push("settle");
    const g = el("g", { class: cls.join(" ") });
    g.appendChild(el("rect", { x: callX, y, width: callW, height: DICT_ROW_H, rx: 8 }));
    g.appendChild(el("text", { x: callX + callW / 2, y: y + DICT_ROW_H / 2 + 5, class: "label" }, dictCallLabel(n, info)));
    if (n.returned !== null && n.returned !== undefined) {
      g.appendChild(el("text", { x: callX + callW + 12, y: y + DICT_ROW_H / 2 + 5, class: "returned dict-ret" },
        `= ${dictShow(n.returned)}`));
    }
    svg.appendChild(g);
  }

  if (currentNode) {
    scrollToCurrent(svg, layout, { x: callX, y: rowY(currentRow) + DICT_ROW_H / 2 });
  }
}

// ---------- the sentence under the drawing ----------

// Built only from the recorded arguments and return values, so it can't be wrong.
function describeDictStep(frame, layout) {
  const info = layout.info;
  const { nodes, current } = frame.state;
  const node = nodes.find(n => n.id === current);
  if (!node) return "";
  const row = dictRowOf(node, info);
  const call = dictCallLabel(node, info);
  const atEnd = row >= info.pairs.length;
  const lookup = info.keyArg !== undefined;
  const target = lookup ? dictShow(info.key) : "";

  if (node.status !== "returned") {
    if (atEnd) return lookup
      ? `${call}: the list is empty, so ${target} was never found.`
      : `${call}: the list is empty.`;
    const [k, v] = info.pairs[row];
    if (!lookup) return `${call} looks at the pair (${dictShow(k)}, ${dictShow(v)}).`;
    return dictSame(k, info.key)
      ? `${call} checks the pair (${dictShow(k)}, ${dictShow(v)}): the key ${dictShow(k)} matches ${target}.`
      : `${call} checks the pair (${dictShow(k)}, ${dictShow(v)}): ${dictShow(k)} isn't ${target}, so it searches the rest of the list.`;
  }

  const value = dictShow(node.returned);
  if (atEnd) return `Empty list: the base case returns ${value}.`;
  if (lookup && dictSame(info.pairs[row][0], info.key)) {
    return node.parent === null ? `Found it: the lookup returns ${value}.` : `Found it: returns ${value}.`;
  }
  return node.parent === null
    ? `${call} passes ${value} back. The lookup of ${target} returns ${value}.`
    : `${call} passes ${value} back up to the call that made it.`;
}
