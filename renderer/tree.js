// Tree visualizer: layout + drawing.
//
// layoutTree() works out WHERE every node goes. Call it once, on the LAST
// frame (where the whole tree exists), so nodes never jump around as the
// tree grows. drawTree() then draws any single frame using those positions.

const LEVEL_GAP = 90;   // vertical distance between depths (px)
const NODE_H = 34;      // node height (px)
const CHAR_W = 8.4;     // approx width of one monospace character at 14px
const PAD = 30;         // padding around the whole drawing
const VALUE_SPACE = 26; // room under each node for its "= value" text

function nodeWidth(label) {
  return Math.max(64, label.length * CHAR_W + 24);
}

// nodes: the "nodes" list from the final frame.
// Returns { positions: Map(id -> {x, y}), width, height }.
function layoutTree(nodes) {
  // Build parent -> children lists. Children are sorted by id, which is call
  // order, so the first recursive call is drawn on the left.
  const children = new Map();
  let root = null;
  for (const n of nodes) {
    if (n.parent === null) {
      root = n.id;
    } else {
      if (!children.has(n.parent)) children.set(n.parent, []);
      children.get(n.parent).push(n.id);
    }
  }
  for (const list of children.values()) list.sort((a, b) => a - b);

  // Every node gets the same horizontal slot width: the widest label + a gap.
  const slotW = Math.max(...nodes.map(n => nodeWidth(n.label))) + 20;

  // Leaves take the next free slot, left to right. A parent sits halfway
  // between its first and last child, which centers it over them.
  const slots = new Map();
  let nextSlot = 0;
  let maxDepth = 0;
  function place(id, depth) {
    maxDepth = Math.max(maxDepth, depth);
    const kids = children.get(id) || [];
    let slot;
    if (kids.length === 0) {
      slot = nextSlot++;
    } else {
      const kidSlots = kids.map(k => place(k, depth + 1));
      slot = (kidSlots[0] + kidSlots[kidSlots.length - 1]) / 2;
    }
    slots.set(id, { slot, depth });
    return slot;
  }
  if (root !== null) place(root, 0);

  // Convert slot/depth numbers into pixel coordinates (center of each node).
  const positions = new Map();
  for (const [id, s] of slots) {
    positions.set(id, {
      x: PAD + slotW / 2 + s.slot * slotW,
      y: PAD + NODE_H / 2 + s.depth * LEVEL_GAP,
    });
  }
  return {
    positions,
    width: 2 * PAD + Math.max(1, nextSlot) * slotW,
    height: 2 * PAD + NODE_H + maxDepth * LEVEL_GAP + 24, // +24 for "= value" text
  };
}

// Small helper to create SVG elements.
function svgEl(tag, attrs = {}, text = null) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text !== null) el.textContent = text;
  return el;
}

// What's new since the previous frame, so only that gets animated.
//   entered: calls that appear in this frame
//   settled: calls that returned in this frame
// prevFrame is null when we shouldn't animate (going Back, jumping, first draw).
function frameChanges(frame, prevFrame) {
  const entered = new Set(), settled = new Set();
  if (!prevFrame) return { entered, settled };
  const before = new Map(prevFrame.state.nodes.map(n => [n.id, n]));
  for (const n of frame.state.nodes) {
    const old = before.get(n.id);
    if (!old) entered.add(n.id);
    else if (n.status === "returned" && old.status !== "returned") settled.add(n.id);
  }
  return { entered, settled };
}

// Draw one frame. svg: the <svg> element. layout: result of layoutTree().
// prevFrame (optional): the frame just before, to animate what changed.
function drawTree(svg, frame, layout, prevFrame = null) {
  const { nodes, current } = frame.state;
  const pos = layout.positions;
  const changes = frameChanges(frame, prevFrame);

  svg.innerHTML = "";
  svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
  // Small trees shouldn't be blown up to fill the panel: cap the zoom at ~1.3x.
  // Big trees shouldn't shrink below ~0.85x either: the panel scrolls instead.
  svg.style.maxWidth = `${Math.round(layout.width * 1.3)}px`;
  svg.style.minWidth = `${Math.round(layout.width * 0.85)}px`;
  svg.style.minHeight = `${Math.round(layout.height * 0.85)}px`;

  const byId = new Map(nodes.map(n => [n.id, n]));

  // 1. Edges first, so nodes are drawn on top of the lines.
  for (const n of nodes) {
    if (n.parent === null || !byId.has(n.parent)) continue;
    const parent = byId.get(n.parent);
    const a = pos.get(n.parent), b = pos.get(n.id);
    // Once the parent shows its "= value", start the line below that text.
    const hasValue = parent.returned !== null && parent.returned !== undefined;
    const isNew = changes.entered.has(n.id);
    svg.appendChild(svgEl("line", {
      x1: a.x, y1: a.y + NODE_H / 2 + (hasValue ? VALUE_SPACE : 0),
      x2: b.x, y2: b.y - NODE_H / 2,
      class: isNew ? "edge enter" : "edge",
      ...(isNew ? { pathLength: 1 } : {}),   // lets CSS "draw" the line in
    }));
  }

  // 2. Nodes.
  for (const n of nodes) {
    const p = pos.get(n.id);
    const w = nodeWidth(n.label);
    const classes = ["node", n.status];
    if (n.id === current) classes.push("current");
    if (changes.entered.has(n.id)) classes.push("enter");
    if (changes.settled.has(n.id)) classes.push("settle");

    const g = svgEl("g", { class: classes.join(" ") });
    g.appendChild(svgEl("rect", {
      x: p.x - w / 2, y: p.y - NODE_H / 2, width: w, height: NODE_H, rx: 8,
    }));
    g.appendChild(svgEl("text", { x: p.x, y: p.y + 5, class: "label" }, n.label));

    if (n.returned !== null && n.returned !== undefined) {
      g.appendChild(svgEl("text", {
        x: p.x, y: p.y + NODE_H / 2 + 18, class: "returned",
      }, `= ${JSON.stringify(n.returned)}`));
    }
    svg.appendChild(g);
  }

  scrollToCurrent(svg, layout, pos.get(current));
}

// When the tree is bigger than the panel, keep the current call in view.
function scrollToCurrent(svg, layout, p) {
  const wrap = svg.parentElement;
  if (!p || !wrap || wrap.scrollWidth <= wrap.clientWidth && wrap.scrollHeight <= wrap.clientHeight) return;
  const scale = Math.min(svg.clientWidth / layout.width, svg.clientHeight / layout.height);
  const offsetX = (svg.clientWidth - layout.width * scale) / 2;   // the drawing is centered
  const offsetY = (svg.clientHeight - layout.height * scale) / 2;
  wrap.scrollLeft = offsetX + p.x * scale - wrap.clientWidth / 2;
  wrap.scrollTop = offsetY + p.y * scale - wrap.clientHeight / 2;
}
