// The class diagram of a task's C# changes (the model comes from
// src/csharp.js): one box per type the task added, changed or removed, with
// just its name, in a package box per namespace, and arrows for how the types
// depend on each other. The dependencies flow from left to right: a type
// stands left of the types it uses. Drag to move around, Ctrl+wheel (or the
// buttons) to zoom; in the full-window view the wheel zooms by itself. Point
// at a box for its changed members; click it to open its diff.

const SVG_NS = 'http://www.w3.org/2000/svg';
const UML_FONT = '600 13px Nunito, "Segoe UI", sans-serif';
const UML_SMALL = '11px Nunito, "Segoe UI", sans-serif';
const UML_BOX_H = 38;

function svgEl(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

let measureCtx = null;
function textWidth(text, font) {
  measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

const CHANGE_SIGN = { new: '+', mod: '~', del: '−' };
const KIND_WORDS = { interface: 'interface', enum: 'enum', struct: 'struct', class: 'class' };

// "Refresh()", "Count: int", "Load(string, int): Task", for the tooltips.
function memberLabel(m) {
  if (m.kind === 'value') return m.name;
  if (m.kind === 'method' || m.kind === 'ctor') {
    const params = (m.params || '').split(',').map(p => p.trim().replace(/\s*=.*$/, '').split(/\s+/).slice(0, -1).join(' ').replace(/^(this|ref|out|in|params) /, '')).filter(Boolean);
    const args = params.join(', ');
    const sig = `${m.name}(${args.length > 40 ? '…' : args})`;
    return m.type && m.type !== 'void' ? `${sig}: ${m.type}` : sig;
  }
  return m.type ? `${m.name}: ${m.type}` : m.name;
}

// Only the types the task added, changed or removed. Two parts of one type
// (a partial class, or the same type read twice) become one box.
function changedModel(model) {
  const byKey = new Map();
  const idOf = new Map();
  for (const n of model.nodes || []) {
    if (!['new', 'mod', 'del'].includes(n.status)) continue;
    const key = `${n.namespace}|${n.name}`;
    const prev = byKey.get(key);
    if (prev) {
      prev.members.push(...n.members);
      if (prev.status !== n.status) prev.status = 'mod';
      idOf.set(n.id, prev.id);
      continue;
    }
    const copy = { ...n, members: [...n.members] };
    byKey.set(key, copy);
    idOf.set(n.id, copy.id);
  }
  const edges = new Map();
  for (const e of model.edges || []) {
    const from = idOf.get(e.from);
    const to = idOf.get(e.to);
    if (!from || !to || from === to) continue;
    const key = `${from}>${to}`;
    const prev = edges.get(key);
    if (!prev || (prev.kind === 'uses' && e.kind !== 'uses')) edges.set(key, { ...e, from, to, fresh: e.fresh || !!prev?.fresh });
  }
  return { nodes: [...byKey.values()], edges: [...edges.values()] };
}

// ---------- layout ----------

// Layers in the order of the dependencies: a type comes before the types it
// uses. Cycles are broken by ignoring the arrows that close them. Layers
// longer than maxLength (in sizeOf units, with gap between) are split.
function layout(nodes, edges, { maxLength = 1400, sizeOf = () => 200, gap = 44 } = {}) {
  const ids = nodes.map(n => n.id);
  const out = new Map(ids.map(id => [id, []]));
  for (const e of edges) out.get(e.from)?.push(e.to);
  // Arrows that close a cycle (found by a depth-first walk) do not rank.
  const state = new Map();
  const back = new Set();
  const visit = id => {
    state.set(id, 1);
    for (const to of out.get(id) || []) {
      if (state.get(to) === 1) back.add(`${id}>${to}`);
      else if (!state.has(to)) visit(to);
    }
    state.set(id, 2);
  };
  for (const id of ids) if (!state.has(id)) visit(id);
  const forward = edges.filter(e => !back.has(`${e.from}>${e.to}`) && out.has(e.to) && out.has(e.from));
  const rank = new Map(ids.map(id => [id, 0]));
  // Longest path from the start: repeat until nothing moves (the graph is small).
  for (let pass = 0; pass < ids.length; pass++) {
    let moved = false;
    for (const e of forward) {
      if (rank.get(e.to) < rank.get(e.from) + 1) { rank.set(e.to, rank.get(e.from) + 1); moved = true; }
    }
    if (!moved) break;
  }
  // A type that only uses others sits right before the nearest of them.
  for (const id of ids) {
    const targets = forward.filter(e => e.from === id).map(e => rank.get(e.to));
    const sources = forward.filter(e => e.to === id);
    if (!sources.length && targets.length) rank.set(id, Math.max(rank.get(id), Math.min(...targets) - 1));
  }
  const layers = [];
  for (const id of ids) (layers[rank.get(id)] = layers[rank.get(id)] || []).push(id);
  const filled = layers.filter(Boolean);
  // Fewer crossings: each type moves toward the middle of its neighbours.
  const neighbours = new Map(ids.map(id => [id, []]));
  for (const e of edges) { neighbours.get(e.from)?.push(e.to); neighbours.get(e.to)?.push(e.from); }
  for (let sweep = 0; sweep < 8; sweep++) {
    const order = new Map();
    filled.forEach(layer => layer.forEach((id, i) => order.set(id, i / Math.max(1, layer.length - 1))));
    const list = sweep % 2 ? [...filled].reverse() : filled;
    for (const layer of list) {
      const key = id => {
        const ns = neighbours.get(id).filter(n => order.has(n));
        return ns.length ? ns.reduce((s, n) => s + order.get(n), 0) / ns.length : order.get(id);
      };
      layer.sort((a, b) => key(a) - key(b));
      layer.forEach((id, i) => order.set(id, i / Math.max(1, layer.length - 1)));
    }
  }
  const result = [];
  for (const layer of filled) {
    let part = [];
    let length = 0;
    for (const id of layer) {
      const s = sizeOf(id);
      if (part.length && length + gap + s > maxLength) { result.push(part); part = []; length = 0; }
      length += (part.length ? gap : 0) + s;
      part.push(id);
    }
    if (part.length) result.push(part);
  }
  return result;
}

// Puts the layers side by side as columns, each one centred top to bottom;
// sets x and y (relative) on the items and returns the size.
function placeColumns(columns, size, gapX, gapY) {
  const heights = columns.map(col => col.reduce((s, id) => s + size(id).h, 0) + gapY * (col.length - 1));
  const height = Math.max(0, ...heights);
  let x = 0;
  columns.forEach((col, c) => {
    const width = Math.max(...col.map(id => size(id).w));
    let y = (height - heights[c]) / 2;
    for (const id of col) {
      const s = size(id);
      s.x = x + (width - s.w) / 2;
      s.y = y;
      y += s.h + gapY;
    }
    x += width + gapX;
  });
  return { width: Math.max(0, x - gapX), height };
}

// ---------- drawing ----------

// An arrow from the type that uses to the type it uses: from the right side
// of the one to the left side of the other, or around when they stand in the
// same column. Ends are spread along each side (slots).
function drawEdge(a, b, edge, slots) {
  const at = (box, side) => {
    const list = slots.get(`${box.id}|${side}`) || [];
    return (list.indexOf(`${edge.from}>${edge.to}`) + 1) / (list.length + 1);
  };
  let d;
  const side = edgeSides(a, b);
  if (side === 'right') {
    const sx = a.x + a.w;
    const sy = a.y + a.h * at(a, 'right');
    const tx = b.x;
    const ty = b.y + b.h * at(b, 'left');
    const dx = Math.max(40, (tx - sx) / 2);
    d = `M${sx},${sy} C${sx + dx},${sy} ${tx - dx},${ty} ${tx},${ty}`;
  } else if (side === 'left') {
    const sx = a.x;
    const sy = a.y + a.h * at(a, 'left');
    const tx = b.x + b.w;
    const ty = b.y + b.h * at(b, 'right');
    const dx = Math.max(40, (sx - tx) / 2);
    d = `M${sx},${sy} C${sx - dx},${sy} ${tx + dx},${ty} ${tx},${ty}`;
  } else if (side === 'down') {
    const sx = a.x + a.w * at(a, 'bottom');
    const sy = a.y + a.h;
    const tx = b.x + b.w * at(b, 'top');
    const ty = b.y;
    const dy = Math.max(20, (ty - sy) / 2);
    d = `M${sx},${sy} C${sx},${sy + dy} ${tx},${ty - dy} ${tx},${ty}`;
  } else {
    const sx = a.x + a.w * at(a, 'top');
    const sy = a.y;
    const tx = b.x + b.w * at(b, 'bottom');
    const ty = b.y + b.h;
    const dy = Math.max(20, (sy - ty) / 2);
    d = `M${sx},${sy} C${sx},${sy - dy} ${tx},${ty + dy} ${tx},${ty}`;
  }
  const g = svgEl('g', { class: `uml-edge ${edge.kind}${edge.fresh ? ' fresh' : ''}`, 'data-from': edge.from, 'data-to': edge.to });
  g.appendChild(svgEl('path', { d, 'marker-end': `url(#uml-${edge.kind === 'uses' ? 'arrow' : 'triangle'}${edge.fresh ? '-fresh' : ''})` }));
  const words = { inherits: 'inherits from', implements: 'implements', uses: 'uses' };
  g.appendChild(svgEl('title', {}, `${edge.fromName} ${words[edge.kind]} ${edge.toName}${edge.fresh ? ' (new in this task)' : ''}`));
  return g;
}

function edgeSides(a, b) {
  if (b.x >= a.x + a.w + 8) return 'right';
  if (b.x + b.w <= a.x - 8) return 'left';
  return b.y > a.y ? 'down' : 'up';
}

// A namespace shown in the space there is: its last parts, with … in front.
function fitLabel(text, width) {
  let label = text;
  while (textWidth(label, UML_SMALL) > width && label.includes('.')) {
    const rest = label.startsWith('…') ? label.slice(1) : label;
    label = '…' + rest.slice(rest.indexOf('.') + 1);
  }
  return label;
}

// Draws the diagram into container. Returns { fit, zoom, svg, width,
// height, order, elementOf }. onOpen(node, line) runs when a box is clicked,
// with the line of its first change.
function drawUml(container, model, { onOpen, wheelZooms = false } = {}) {
  const boxes = new Map();
  for (const n of model.nodes) {
    const name = n.name + (n.generic || '');
    const w = Math.min(Math.max(Math.ceil(textWidth(name, UML_FONT)) + 40, 110), 340);
    boxes.set(n.id, { id: n.id, node: n, name, w, h: UML_BOX_H });
  }
  const GAP_X = 96;     // room for the arrows between columns
  const GAP_Y = 18;
  const PAD = 18;
  const TITLE = 28;
  const GROUP_GAP_X = 120;
  const GROUP_GAP_Y = 40;
  const aspect = container.clientWidth && container.clientHeight ? container.clientWidth / container.clientHeight : 1.8;

  // One group per namespace, laid out on its own: columns of types.
  const groups = new Map();
  for (const n of model.nodes) {
    const key = n.namespace || '(no namespace)';
    if (!groups.has(key)) groups.set(key, { id: key, ids: [] });
    groups.get(key).ids.push(n.id);
  }
  for (const g of groups.values()) {
    const inGroup = new Set(g.ids);
    const nodes = g.ids.map(id => boxes.get(id).node);
    const area = g.ids.reduce((s, id) => s + (boxes.get(id).w + GAP_X) * (UML_BOX_H + GAP_Y), 0);
    const columns = layout(nodes, model.edges.filter(e => inGroup.has(e.from) && inGroup.has(e.to)), {
      maxLength: Math.max(4 * (UML_BOX_H + GAP_Y), Math.sqrt(area / 2)),
      sizeOf: () => UML_BOX_H,
      gap: GAP_Y,
    });
    const size = placeColumns(columns, id => boxes.get(id), GAP_X, GAP_Y);
    g.w = Math.max(size.width, Math.min(textWidth(g.id, UML_SMALL) + 24, 260)) + PAD * 2;
    g.h = size.height + TITLE + PAD;
    g.inner = size;
  }
  // Then the groups, the same way: a namespace stands left of the ones it uses.
  const groupEdges = new Map();
  for (const e of model.edges) {
    const a = boxes.get(e.from)?.node.namespace || '(no namespace)';
    const b = boxes.get(e.to)?.node.namespace || '(no namespace)';
    if (a !== b) groupEdges.set(`${a}>${b}`, { from: a, to: b });
  }
  const groupArea = [...groups.values()].reduce((s, g) => s + (g.w + GROUP_GAP_X) * (g.h + GROUP_GAP_Y), 0);
  const groupColumns = layout([...groups.values()], [...groupEdges.values()], {
    maxLength: Math.max(...[...groups.values()].map(g => g.h), Math.sqrt(groupArea / aspect) * 1.1),
    sizeOf: id => groups.get(id).h,
    gap: GROUP_GAP_Y,
  });
  const total = placeColumns(groupColumns, id => groups.get(id), GROUP_GAP_X, GROUP_GAP_Y);
  for (const g of groups.values()) {
    const offsetX = g.x + PAD + (g.w - PAD * 2 - g.inner.width) / 2;
    for (const id of g.ids) {
      const b = boxes.get(id);
      b.x += offsetX;
      b.y += g.y + TITLE;
    }
  }
  const maxW = total.width;
  const totalH = total.height;

  const svg = svgEl('svg', { class: 'uml-svg' });
  const defs = svgEl('defs');
  for (const fresh of ['', '-fresh']) {
    const tri = svgEl('marker', { id: `uml-triangle${fresh}`, viewBox: '0 0 12 12', refX: 11, refY: 6, markerWidth: 12, markerHeight: 12, orient: 'auto-start-reverse', markerUnits: 'userSpaceOnUse' });
    tri.appendChild(svgEl('path', { d: 'M1,1 L11,6 L1,11 Z', class: `uml-marker-triangle${fresh}` }));
    const arrow = svgEl('marker', { id: `uml-arrow${fresh}`, viewBox: '0 0 12 12', refX: 11, refY: 6, markerWidth: 10, markerHeight: 10, orient: 'auto-start-reverse', markerUnits: 'userSpaceOnUse' });
    arrow.appendChild(svgEl('path', { d: 'M1,1 L11,6 L1,11', class: `uml-marker-arrow${fresh}` }));
    defs.append(tri, arrow);
  }
  svg.appendChild(defs);
  const world = svgEl('g', { class: 'uml-world' });
  svg.appendChild(world);

  // The package boxes, behind everything else.
  const groupLayer = svgEl('g', { class: 'uml-groups' });
  for (const g of groups.values()) {
    const box = svgEl('g', { class: 'uml-group', transform: `translate(${g.x},${g.y})` });
    box.appendChild(svgEl('rect', { width: g.w, height: g.h, rx: 14 }));
    box.appendChild(svgEl('text', { x: 14, y: 19 }, fitLabel(g.id, g.w - 28)));
    box.appendChild(svgEl('title', {}, `namespace ${g.id}\n${g.ids.length} changed type${g.ids.length === 1 ? '' : 's'}`));
    groupLayer.appendChild(box);
  }
  world.appendChild(groupLayer);

  // Arrow ends spread along each side, ordered by where the other end is.
  const edges = model.edges.filter(e => boxes.has(e.from) && boxes.has(e.to))
    .map(e => ({ ...e, fromName: boxes.get(e.from).name, toName: boxes.get(e.to).name }));
  const slots = new Map();
  const add = (box, side, key, other, vertical) => {
    const k = `${box.id}|${side}`;
    if (!slots.has(k)) slots.set(k, []);
    slots.get(k).push({ key, pos: vertical ? other.y + other.h / 2 : other.x + other.w / 2 });
  };
  const OPPOSITE = { right: 'left', left: 'right', down: 'top', up: 'bottom' };
  const FROM_SIDE = { right: 'right', left: 'left', down: 'bottom', up: 'top' };
  for (const e of edges) {
    const a = boxes.get(e.from);
    const b = boxes.get(e.to);
    const side = edgeSides(a, b);
    const vertical = side === 'right' || side === 'left';
    add(a, FROM_SIDE[side], `${e.from}>${e.to}`, b, vertical);
    add(b, OPPOSITE[side], `${e.from}>${e.to}`, a, vertical);
  }
  for (const [k, list] of slots) slots.set(k, list.sort((p, q) => p.pos - q.pos).map(s => s.key));
  const edgeLayer = svgEl('g', { class: 'uml-edges' });
  // A type that uses many others (a composer, a factory) would cover the
  // diagram in arrows: its arrows stay faint until you point at it.
  const outgoing = new Map();
  for (const e of edges) outgoing.set(e.from, (outgoing.get(e.from) || 0) + 1);
  for (const e of edges) {
    const g = drawEdge(boxes.get(e.from), boxes.get(e.to), e, slots);
    if (outgoing.get(e.from) > 8 && !e.fresh) g.classList.add('faint');
    edgeLayer.appendChild(g);
  }
  world.appendChild(edgeLayer);

  // The boxes: a stripe in the color of the change, and the name.
  for (const b of boxes.values()) {
    const n = b.node;
    const g = svgEl('g', { class: `uml-node status-${n.status} kind-${n.kind}`, transform: `translate(${b.x},${b.y})`, 'data-id': n.id });
    g.appendChild(svgEl('rect', { class: 'uml-box', width: b.w, height: b.h, rx: 8 }));
    g.appendChild(svgEl('rect', { class: 'uml-band', width: 4, height: b.h - 12, x: 6, y: 6, rx: 2 }));
    g.appendChild(svgEl('text', { class: 'uml-name', x: b.w / 2 + 3, y: b.h / 2 + 4.5 }, b.name));
    const changed = n.members.filter(m => m.change).map(m => `${CHANGE_SIGN[m.change]} ${memberLabel(m)}`);
    const words = { new: 'New', mod: 'Changed', del: 'Deleted' };
    const shown = changed.slice(0, 20);
    if (changed.length > 20) shown.push(`… and ${changed.length - 20} more`);
    g.appendChild(svgEl('title', {}, `${KIND_WORDS[n.kind] || n.kind} ${n.namespace ? n.namespace + '.' : ''}${b.name}\n${words[n.status]} in this task${shown.length ? `\n\n${shown.join('\n')}` : ''}\n\n${n.file}\nClick to open the diff`));
    world.appendChild(g);
  }
  container.appendChild(svg);

  // ---------- moving around ----------
  const view = { x: 0, y: 0, k: 1 };
  const apply = () => world.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
  // readable: never smaller than a size where the names can be read; a
  // bigger diagram then starts at its left, and you drag to the rest (Fit
  // shows it all).
  const fit = ({ readable = false } = {}) => {
    const w = container.clientWidth || 800;
    const h = container.clientHeight || 400;
    // Room for the buttons above and the legend below.
    const top = 44;
    const bottom = 40;
    view.k = Math.min(1.15, (w - 48) / Math.max(1, maxW), (h - top - bottom) / Math.max(1, totalH));
    if (readable) view.k = Math.max(view.k, 0.7);
    view.x = Math.max(24, (w - maxW * view.k) / 2);
    view.y = top + Math.max(0, (h - top - bottom - totalH * view.k) / 2);
    apply();
  };
  const zoomAt = (factor, cx, cy) => {
    const k = Math.min(3, Math.max(0.15, view.k * factor));
    view.x = cx - (cx - view.x) * (k / view.k);
    view.y = cy - (cy - view.y) * (k / view.k);
    view.k = k;
    apply();
  };
  const zoom = factor => zoomAt(factor, (container.clientWidth || 800) / 2, (container.clientHeight || 400) / 2);

  let drag = null;
  svg.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, target: e.target.closest('.uml-node') };
    try { svg.setPointerCapture(e.pointerId); } catch { /* not a real pointer */ }
  });
  svg.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    svg.classList.add('dragging');
    view.x = drag.vx + dx;
    view.y = drag.vy + dy;
    apply();
  });
  svg.addEventListener('pointerup', () => {
    const d = drag;
    drag = null;
    svg.classList.remove('dragging');
    // The diff opens at the type's first change.
    if (d && !d.moved && d.target) {
      const node = boxes.get(d.target.dataset.id).node;
      const first = node.members.filter(m => m.change).sort((a, b) => a.line - b.line)[0];
      onOpen?.(node, first?.line ?? node.line);
    }
  });
  svg.addEventListener('wheel', e => {
    if (!wheelZooms && !e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  // Pointing at a box lights up its arrows and the types at their other end.
  svg.addEventListener('pointerover', e => {
    const node = e.target.closest('.uml-node');
    if (!node || drag) return;
    const id = node.dataset.id;
    const linked = new Set([id]);
    for (const g of edgeLayer.children) {
      const on = g.dataset.from === id || g.dataset.to === id;
      g.classList.toggle('lit', on);
      if (on) { linked.add(g.dataset.from); linked.add(g.dataset.to); }
    }
    for (const g of world.querySelectorAll('.uml-node')) g.classList.toggle('dim', !linked.has(g.dataset.id));
    edgeLayer.classList.add('focus');
  });
  svg.addEventListener('pointerout', e => {
    if (e.relatedTarget?.closest?.('.uml-node') === e.target.closest('.uml-node')) return;
    for (const g of world.querySelectorAll('.dim')) g.classList.remove('dim');
    for (const g of edgeLayer.querySelectorAll('.lit')) g.classList.remove('lit');
    edgeLayer.classList.remove('focus');
  });

  requestAnimationFrame(() => fit({ readable: true }));
  // The boxes in reading order (group by group, left to right, top to
  // bottom), for stepping from one type's diff to the next.
  const order = [...groups.values()].sort((a, b) => a.x - b.x || a.y - b.y)
    .flatMap(g => g.ids.map(id => boxes.get(id)).sort((a, b) => a.x - b.x || a.y - b.y).map(b => b.id));
  const elementOf = id => world.querySelector(`.uml-node[data-id="${CSS.escape(id)}"]`);
  return { fit, zoom, svg, width: maxW, height: totalH, order, elementOf };
}

// The legend under the diagram.
function umlLegend() {
  const legend = el('div', 'uml-legend');
  const item = (cls, text) => {
    const i = el('span', 'uml-legend-item');
    i.append(el('span', `uml-swatch ${cls}`), document.createTextNode(text));
    legend.appendChild(i);
  };
  item('new', 'New');
  item('mod', 'Changed');
  item('del', 'Deleted');
  item('edge-inherits', 'Inherits');
  item('edge-implements', 'Implements');
  item('edge-uses', 'Uses');
  item('edge-fresh', 'New dependency');
  return legend;
}

// ---------- a type's diff, grown out of its box ----------

// Clicking a box grows it into a panel over the diagram with that file's
// diff, at the type's first change (like an agent's tile growing into its
// chat). Back, or Esc, shrinks it into the box again. ‹ › (or ← →) step to
// the previous or next type. The diagram stays dimmed underneath.
let activeDetail = null;

function openDetail(panel, api, model, node, line, { files, onReview }) {
  activeDetail?.close(true);
  const ids = api.order;
  const box = el('div', 'uml-detail');
  const head = el('div', 'uml-detail-head');
  const body = el('div', 'uml-detail-body');
  box.append(head, body);
  panel.appendChild(box);

  const rectOf = id => {
    const g = api.elementOf(id)?.querySelector('.uml-box');
    const p = panel.getBoundingClientRect();
    const r = g ? g.getBoundingClientRect() : { left: p.left + p.width / 2 - 60, top: p.top + p.height / 2 - 20, width: 120, height: 40 };
    return { left: r.left - p.left, top: r.top - p.top, width: r.width, height: r.height };
  };
  const place = r => Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });

  let current = node;
  const fill = (n, at) => {
    current = n;
    head.innerHTML = '';
    body.innerHTML = '';
    const file = files.find(f => f.path === n.file);
    const step = (text, title, delta) => {
      const b = el('button', 'uml-detail-step', text);
      b.type = 'button';
      b.title = title;
      const i = ids.indexOf(n.id);
      b.disabled = i < 0 || !ids[i + delta];
      b.onclick = () => go(delta);
      return b;
    };
    const kind = { new: 'New', mod: 'Edited', del: 'Deleted' }[n.status] || '';
    const title = el('div', 'uml-detail-title');
    title.append(el('span', `change-badge ${n.status}`, kind), el('span', 'uml-detail-name', n.name + (n.generic || '')));
    const where = el('div', 'uml-detail-where', `${n.namespace ? n.namespace + ' · ' : ''}${n.file}`);
    const text = el('div', 'uml-detail-text');
    text.append(title, where);
    const review = el('button', null, 'Review');
    review.type = 'button';
    review.title = 'Open all changes in the whole window, at this type';
    review.onclick = () => onReview?.(n, at);
    const back = el('button', 'uml-detail-back', 'Back');
    back.type = 'button';
    back.title = 'Back to the diagram (Esc)';
    back.onclick = () => close();
    head.append(step('‹', 'Previous type (←)', -1), step('›', 'Next type (→)', 1), text, review, back);
    if (!file) {
      body.appendChild(el('div', 'uml-detail-empty', 'No diff for this type.'));
      return;
    }
    const diff = renderDiff(file, { maxLines: 20000 });
    body.appendChild(diff);
    // To the change: the diff line nearest to it, marked for a moment.
    requestAnimationFrame(() => {
      const no = row => Number(row.dataset.newLine ?? row.dataset.oldLine);
      let best = null;
      for (const row of diff.querySelectorAll('.diff-line[data-new-line], .diff-line[data-old-line]')) {
        if (!best || Math.abs(no(row) - at) < Math.abs(no(best) - at)) best = row;
      }
      if (!best) return;
      body.scrollTop = Math.max(0, best.offsetTop - body.clientHeight / 3);
      best.classList.add('flash');
      setTimeout(() => best.classList.remove('flash'), 1600);
    });
  };
  const go = delta => {
    const next = model.nodes.find(n => n.id === ids[ids.indexOf(current.id) + delta]);
    if (!next) return;
    window.uiSound?.('tick');
    box.classList.remove('shown');
    setTimeout(() => {
      const first = next.members.filter(m => m.change).sort((a, b) => a.line - b.line)[0];
      fill(next, first?.line ?? next.line);
      box.classList.add('shown');
    }, 120);
  };

  // Grow: from the box to the whole panel.
  place(rectOf(node.id));
  box.classList.add('morphing');
  panel.classList.add('detail-open');
  void box.offsetWidth;
  const inset = 12;
  place({ left: inset, top: inset, width: panel.clientWidth - inset * 2, height: panel.clientHeight - inset * 2 });
  fill(node, line);
  setTimeout(() => { box.classList.add('shown'); box.classList.remove('morphing'); Object.assign(box.style, { width: '', height: '', right: `${inset}px`, bottom: `${inset}px` }); }, 380);
  window.uiSound?.('open');

  // Shrink: back into the box of the type on screen.
  const close = (instant = false) => {
    if (activeDetail?.box !== box) return;
    activeDetail = null;
    panel.classList.remove('detail-open');
    if (instant) { box.remove(); return; }
    window.uiSound?.('close');
    box.classList.remove('shown');
    const from = box.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    Object.assign(box.style, { right: '', bottom: '' });
    place({ left: from.left - p.left, top: from.top - p.top, width: from.width, height: from.height });
    box.classList.add('morphing');
    void box.offsetWidth;
    place(rectOf(current.id));
    box.classList.add('closing');
    setTimeout(() => box.remove(), 360);
  };
  activeDetail = { box, close, step: go };
}

// A diagram with its buttons, for the Changes card or the full window.
// Returns the element. files: the card's files, for the diffs of the boxes;
// onReview(node, line) opens the review at a type.
function umlPanel(fullModel, { files = [], onReview, onFull = null, full = false } = {}) {
  const model = changedModel(fullModel);
  const panel = el('div', `uml-panel${full ? ' full' : ' wide'}`);
  const onOpen = (node, line) => {
    if (api && files.some(f => f.path === node.file)) openDetail(panel, api, model, node, line, { files, onReview });
  };
  const stage = el('div', 'uml-stage');
  const tools = el('div', 'uml-tools');
  const button = (text, title, fn) => {
    const b = el('button', null, text);
    b.type = 'button';
    b.title = title;
    b.onclick = e => { e.stopPropagation(); fn(); };
    tools.appendChild(b);
    return b;
  };
  panel.append(stage, tools, umlLegend());
  let api = null;
  button('−', 'Zoom out', () => api?.zoom(1 / 1.25));
  button('+', 'Zoom in', () => api?.zoom(1.25));
  button('Fit', 'Show the whole diagram', () => api?.fit());
  if (onFull) button('⤢', 'Open in the whole window', onFull);
  if (!full) panel.appendChild(el('div', 'uml-hint', 'Drag to move · Ctrl+wheel to zoom · point at a box for its changes, click it for its diff'));
  // Drawn once the panel is in the page and has a size. In the chat, the
  // panel then takes the diagram's height at the width it has (within
  // limits), so the names show at a readable size.
  const draw = () => {
    if (api || !stage.isConnected || !stage.clientWidth) return false;
    api = drawUml(stage, model, { onOpen, wheelZooms: full });
    if (!full) {
      const scale = Math.min(1.15, (stage.clientWidth - 48) / Math.max(1, api.width));
      const wanted = Math.round(api.height * Math.max(scale, 0.7) + 120);
      panel.style.height = `${Math.round(Math.min(window.innerHeight * 0.82, Math.max(300, wanted)))}px`;
      requestAnimationFrame(() => api.fit({ readable: true }));
    }
    return true;
  };
  const observer = new ResizeObserver(() => { if (!draw()) return; });
  observer.observe(stage);
  panel.redraw = () => { stage.innerHTML = ''; api = null; draw(); };
  return panel;
}

// The diagram in the whole window, over the chat (Esc closes it).
let umlFullEl = null;
function closeUmlFull() {
  if (activeDetail && umlFullEl?.contains(activeDetail.box)) activeDetail.close(true);
  umlFullEl?.remove();
  umlFullEl = null;
}

function openUmlFull(model, { title, ...options }) {
  closeUmlFull();
  umlFullEl = el('div', 'uml-full');
  umlFullEl.tabIndex = -1;
  const bar = el('div', 'review-bar');
  const close = el('button', null, 'Close (Esc)');
  close.onclick = closeUmlFull;
  bar.append(el('span', 'review-title', title), el('span', 'hint', 'Wheel to zoom · drag to move · click a box for its diff'), close);
  umlFullEl.append(bar, umlPanel(model, { ...options, full: true }));
  document.getElementById('main').appendChild(umlFullEl);
  umlFullEl.focus();
}

// Esc closes a type's diff first, then the full-window diagram; a review on
// top of them closes by itself first. ← → step through the types' diffs.
document.addEventListener('keydown', e => {
  if (document.querySelector('.review')) return;
  const typing = e.target.closest?.('input, textarea, [contenteditable="true"]');
  const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
  if (e.key === 'Escape' && activeDetail) { stop(); activeDetail.close(); return; }
  if (e.key === 'Escape' && umlFullEl) { stop(); closeUmlFull(); return; }
  if (activeDetail && !typing && !e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    stop();
    activeDetail.step(e.key === 'ArrowRight' ? 1 : -1);
  }
}, true);

window.umlPanel = umlPanel;
window.openUmlFull = openUmlFull;
window.closeUmlFull = closeUmlFull;
