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

// Draw one frame. svg: the <svg> element. layout: result of layoutTree().
function drawTree(svg, frame, layout) {
  const { nodes, current } = frame.state;
  const pos = layout.positions;

  svg.innerHTML = "";
  svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
  // Small trees shouldn't be blown up to fill the panel: cap the zoom at ~1.3x.
  svg.style.maxWidth = `${Math.round(layout.width * 1.3)}px`;

  const byId = new Map(nodes.map(n => [n.id, n]));

  // 1. Edges first, so nodes are drawn on top of the lines.
  for (const n of nodes) {
    if (n.parent === null || !byId.has(n.parent)) continue;
    const parent = byId.get(n.parent);
    const a = pos.get(n.parent), b = pos.get(n.id);
    // Once the parent shows its "= value", start the line below that text.
    const hasValue = parent.returned !== null && parent.returned !== undefined;
    svg.appendChild(svgEl("line", {
      x1: a.x, y1: a.y + NODE_H / 2 + (hasValue ? VALUE_SPACE : 0),
      x2: b.x, y2: b.y - NODE_H / 2, class: "edge",
    }));
  }

  // 2. Nodes.
  for (const n of nodes) {
    const p = pos.get(n.id);
    const w = nodeWidth(n.label);
    const classes = ["node", n.status];
    if (n.id === current) classes.push("current");

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
}
