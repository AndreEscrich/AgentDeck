// The class diagram of a task's C# changes (the model comes from
// src/csharp.js): one box per type, with the members the task added (+),
// changed (~) or removed (−), and arrows for how the types depend on each
// other. Types that use others stand above the types they use, so the
// dependencies flow down. Drag to move around, Ctrl+wheel (or the buttons)
// to zoom; in the full-window view the wheel zooms by itself. Click a box to
// open its diff; a faded box is a type the task did not change.

const SVG_NS = 'http://www.w3.org/2000/svg';
const UML_FONT = '600 13px Nunito, "Segoe UI", sans-serif';
const UML_MONO = '12px "Fira Code", Consolas, monospace';
const UML_SMALL = '11px Nunito, "Segoe UI", sans-serif';
const UML_LINE = 18;
const UML_MAX_MEMBERS = 8;

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

const STEREOTYPES = { interface: '«interface»', enum: '«enum»', struct: '«struct»' };
const CHANGE_SIGN = { new: '+', mod: '~', del: '−' };

// "Refresh()", "Count: int", "Load(string, int): Task".
function memberLabel(m) {
  if (m.kind === 'value') return m.name;
  if (m.kind === 'method' || m.kind === 'ctor') {
    const params = (m.params || '').split(',').map(p => p.trim().replace(/\s*=.*$/, '').split(/\s+/).slice(0, -1).join(' ').replace(/^(this|ref|out|in|params) /, '')).filter(Boolean);
    const args = params.join(', ');
    const sig = `${m.name}(${args.length > 34 ? '…' : args})`;
    return m.type && m.type !== 'void' ? `${sig}: ${m.type}` : sig;
  }
  return m.type ? `${m.name}: ${m.type}` : m.name;
}

// The box of one type: its lines and size.
// compact: only how many members changed ("+5 ~2 −1"), for big diagrams.
function boxFor(node, compact = false) {
  const lines = [];
  const top = [];
  if (STEREOTYPES[node.kind]) top.push(STEREOTYPES[node.kind]);
  if (node.record) top.push('«record»');
  const head = { stereo: top.join(' '), name: node.name + (node.generic || ''), sub: node.package || node.namespace || '' };
  const changed = node.members.filter(m => m.change);
  const others = node.members.length - changed.length;
  if (compact) {
    const count = kind => changed.filter(m => m.change === kind).length;
    const parts = ['new', 'mod', 'del'].filter(k => count(k)).map(k => `${CHANGE_SIGN[k]}${count(k)}`);
    if (parts.length) lines.push({ text: `${parts.join(' ')} member${changed.length === 1 ? '' : 's'}`, change: changed.some(m => m.change === 'new') && !changed.some(m => m.change !== 'new') ? 'new' : 'mod', line: changed[0].line });
  }
  for (const m of compact ? [] : changed.slice(0, UML_MAX_MEMBERS)) lines.push({ text: `${CHANGE_SIGN[m.change]} ${memberLabel(m)}`, change: m.change, line: m.line });
  if (!compact && changed.length > UML_MAX_MEMBERS) lines.push({ text: `+${changed.length - UML_MAX_MEMBERS} more changed`, faint: true });
  if (!compact && others > 0 && node.status !== 'context') lines.push({ text: `${others} unchanged member${others === 1 ? '' : 's'}`, faint: true });
  let width = Math.max(textWidth(head.name, UML_FONT), head.stereo ? textWidth(head.stereo, UML_SMALL) : 0, head.sub ? textWidth(head.sub, UML_SMALL) : 0);
  for (const l of lines) width = Math.max(width, textWidth(l.text, l.faint ? UML_SMALL : UML_MONO));
  width = Math.min(Math.max(Math.ceil(width) + 28, 150), 360);
  const headHeight = 14 + (head.stereo ? 14 : 0) + 18 + (head.sub ? 15 : 0) + 6;
  const height = headHeight + (lines.length ? 8 + lines.length * UML_LINE + 4 : 0);
  return { head, lines, width, height, headHeight };
}

// ---------- layout ----------

// Layers from top to bottom: a type stands above the types it uses.
// Cycles are broken by ignoring the arrows that close them.
function layout(nodes, edges, { maxRowWidth = 1400, widthOf = () => 200, gap = 44 } = {}) {
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
  const forward = edges.filter(e => !back.has(`${e.from}>${e.to}`) && out.has(e.to));
  const rank = new Map(ids.map(id => [id, 0]));
  // Longest path from the top: repeat until nothing moves (the graph is small).
  for (let pass = 0; pass < ids.length; pass++) {
    let moved = false;
    for (const e of forward) {
      if (rank.get(e.to) < rank.get(e.from) + 1) { rank.set(e.to, rank.get(e.from) + 1); moved = true; }
    }
    if (!moved) break;
  }
  // A type that only uses others sits right above the highest of them.
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
  for (let sweep = 0; sweep < 6; sweep++) {
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
  // Layers wider than maxRowWidth wrap into several rows.
  const rows = [];
  for (const layer of filled) {
    let row = [];
    let width = 0;
    for (const id of layer) {
      const w = widthOf(id);
      if (row.length && width + gap + w > maxRowWidth) { rows.push(row); row = []; width = 0; }
      width += (row.length ? gap : 0) + w;
      row.push(id);
    }
    if (row.length) rows.push(row);
  }
  return rows;
}

// ---------- drawing ----------

function drawEdge(a, b, edge, slots) {
  // From the bottom of the user to the top of the type it uses; when the
  // target is not below, around the side.
  const below = b.y > a.y + a.h - 1;
  const above = b.y + b.h < a.y + 1;
  const slot = (box, side, key) => {
    const list = slots.get(`${box.id}|${side}`) || [];
    const i = list.indexOf(key);
    return (i + 1) / (list.length + 1);
  };
  let d;
  const key = `${edge.from}>${edge.to}`;
  if (below) {
    const sx = a.x + a.w * slot(a, 'bottom', key);
    const sy = a.y + a.h;
    const tx = b.x + b.w * slot(b, 'top', key);
    const ty = b.y;
    const dy = Math.max(30, (ty - sy) / 2);
    d = `M${sx},${sy} C${sx},${sy + dy} ${tx},${ty - dy} ${tx},${ty}`;
  } else if (above) {
    const sx = a.x + a.w * slot(a, 'top', key);
    const sy = a.y;
    const tx = b.x + b.w * slot(b, 'bottom', key);
    const ty = b.y + b.h;
    const dy = Math.max(30, (sy - ty) / 2);
    d = `M${sx},${sy} C${sx},${sy - dy} ${tx},${ty + dy} ${tx},${ty}`;
  } else {
    const right = b.x > a.x;
    const sx = right ? a.x + a.w : a.x;
    const tx = right ? b.x : b.x + b.w;
    const sy = a.y + a.h / 2;
    const ty = b.y + b.h / 2;
    const dx = Math.max(30, Math.abs(tx - sx) / 2) * (right ? 1 : -1);
    d = `M${sx},${sy} C${sx + dx},${sy} ${tx - dx},${ty} ${tx},${ty}`;
  }
  const cls = `uml-edge ${edge.kind}${edge.fresh ? ' fresh' : ''}`;
  const g = svgEl('g', { class: cls, 'data-from': edge.from, 'data-to': edge.to });
  g.appendChild(svgEl('path', { d, 'marker-end': `url(#uml-${edge.kind === 'uses' ? 'arrow' : 'triangle'}${edge.fresh ? '-fresh' : ''})` }));
  const words = { inherits: 'inherits from', implements: 'implements', uses: 'uses' };
  g.appendChild(svgEl('title', {}, `${edge.fromName} ${words[edge.kind]} ${edge.toName}${edge.fresh ? ' (new in this task)' : ''}`));
  return g;
}

// Draws the diagram into container. Returns { fit, zoom, destroy }.
// onOpen(node, line) runs when a box is clicked: line is the member clicked,
// or the box's first changed member.
function drawUml(container, model, { onOpen, wheelZooms = false, compact = false } = {}) {
  const boxes = new Map();
  for (const n of model.nodes) boxes.set(n.id, { id: n.id, node: n, ...boxFor(n, compact) });
  // Positions: rows centred under each other. A row is at most about as wide
  // as the view (a bit wider in the chat, where you can zoom and drag).
  const GAP_X = 44;
  const GAP_Y = 70;
  // Rows as wide as it takes for the whole diagram to have about the shape
  // of the view (the chat panel grows to fit, so there it aims for 16:10).
  const area = [...boxes.values()].reduce((s, b) => s + (b.width + GAP_X) * (b.height + GAP_Y), 0);
  const aspect = wheelZooms && container.clientHeight ? container.clientWidth / container.clientHeight : 1.6;
  const rows = layout(model.nodes, model.edges, {
    maxRowWidth: Math.max(900, Math.sqrt(area * aspect) * 1.2),
    widthOf: id => boxes.get(id).width,
    gap: GAP_X,
  });
  let y = 0;
  let maxW = 0;
  for (const row of rows) {
    const w = row.reduce((s, id) => s + boxes.get(id).width, 0) + GAP_X * (row.length - 1);
    maxW = Math.max(maxW, w);
  }
  for (const row of rows) {
    const w = row.reduce((s, id) => s + boxes.get(id).width, 0) + GAP_X * (row.length - 1);
    let x = (maxW - w) / 2;
    const h = Math.max(...row.map(id => boxes.get(id).height));
    for (const id of row) {
      const b = boxes.get(id);
      Object.assign(b, { x, y, w: b.width, h: b.height });
      x += b.width + GAP_X;
    }
    y += h + GAP_Y;
  }
  const totalH = y - GAP_Y;

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

  // Arrow ends spread along each side, ordered by where the other end is.
  const slots = new Map();
  const edges = model.edges.filter(e => boxes.has(e.from) && boxes.has(e.to)).map(e => ({ ...e, fromName: boxes.get(e.from).node.name, toName: boxes.get(e.to).node.name }));
  const add = (box, side, key, other) => {
    const k = `${box.id}|${side}`;
    if (!slots.has(k)) slots.set(k, []);
    slots.get(k).push({ key, x: other.x + other.w / 2 });
  };
  for (const e of edges) {
    const a = boxes.get(e.from);
    const b = boxes.get(e.to);
    const key = `${e.from}>${e.to}`;
    if (b.y > a.y + a.h - 1) { add(a, 'bottom', key, b); add(b, 'top', key, a); }
    else if (b.y + b.h < a.y + 1) { add(a, 'top', key, b); add(b, 'bottom', key, a); }
  }
  for (const [k, list] of slots) slots.set(k, list.sort((p, q) => p.x - q.x).map(s => s.key));
  const edgeLayer = svgEl('g', { class: 'uml-edges' });
  for (const e of edges) edgeLayer.appendChild(drawEdge(boxes.get(e.from), boxes.get(e.to), e, slots));
  world.appendChild(edgeLayer);

  for (const b of boxes.values()) {
    const n = b.node;
    const g = svgEl('g', { class: `uml-node status-${n.status}`, transform: `translate(${b.x},${b.y})`, 'data-id': n.id });
    g.appendChild(svgEl('rect', { class: 'uml-box', width: b.w, height: b.h, rx: 8 }));
    g.appendChild(svgEl('rect', { class: 'uml-band', width: b.w, height: 4, rx: 2 }));
    let ty = 14;
    if (b.head.stereo) { g.appendChild(svgEl('text', { class: 'uml-stereo', x: b.w / 2, y: ty + 9 }, b.head.stereo)); ty += 14; }
    g.appendChild(svgEl('text', { class: 'uml-name', x: b.w / 2, y: ty + 13 }, b.head.name));
    ty += 18;
    if (b.head.sub) g.appendChild(svgEl('text', { class: 'uml-sub', x: b.w / 2, y: ty + 10 }, b.head.sub));
    if (b.lines.length) {
      g.appendChild(svgEl('line', { class: 'uml-divider', x1: 0, x2: b.w, y1: b.headHeight, y2: b.headHeight }));
      b.lines.forEach((l, i) => {
        const t = svgEl('text', { class: `uml-member${l.change ? ` ${l.change}` : ''}${l.faint ? ' faint' : ''}`, x: 12, y: b.headHeight + 8 + i * UML_LINE + 13 }, l.text);
        if (l.line) t.dataset.line = String(l.line);
        g.appendChild(t);
      });
    }
    const words = { new: 'New in this task', mod: 'Changed in this task', del: 'Deleted in this task', same: 'Not changed, but connected to the changes', context: 'Not changed: a type the changes use' };
    const changed = n.members.filter(m => m.change).map(m => `${CHANGE_SIGN[m.change]} ${memberLabel(m)}`);
    const where = n.status === 'context' ? `${n.file}\nClick to open the file in your editor` : `${n.file}:${n.line}\nClick to open the diff`;
    g.appendChild(svgEl('title', {}, `${n.kind} ${n.namespace ? n.namespace + '.' : ''}${n.name}\n${words[n.status]}${changed.length ? `\n\n${changed.join('\n')}` : ''}\n\n${where}`));
    world.appendChild(g);
  }
  container.appendChild(svg);

  // ---------- moving around ----------
  const view = { x: 0, y: 0, k: 1 };
  const apply = () => world.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
  const fit = () => {
    const w = container.clientWidth || 800;
    const h = container.clientHeight || 400;
    // Room for the buttons above and the legend below.
    const top = 44;
    const bottom = 40;
    view.k = Math.min(1.1, (w - 48) / Math.max(1, maxW), (h - top - bottom) / Math.max(1, totalH));
    view.x = (w - maxW * view.k) / 2;
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
    drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, target: e.target.closest('.uml-node'), member: e.target.closest('.uml-member[data-line]') };
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
    // A member opens the diff at that member; the rest of the box at its first change.
    if (d && !d.moved && d.target) {
      const node = boxes.get(d.target.dataset.id).node;
      const first = node.members.filter(m => m.change).sort((a, b) => a.line - b.line)[0];
      onOpen?.(node, d.member ? Number(d.member.dataset.line) : first?.line ?? node.line);
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

  requestAnimationFrame(fit);
  return { fit, zoom, svg, width: maxW, height: totalH };
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
  item('context', 'Not changed');
  item('edge-inherits', 'Inherits');
  item('edge-implements', 'Implements');
  item('edge-uses', 'Uses');
  item('edge-fresh', 'New dependency');
  return legend;
}

// A diagram with its buttons, for the Changes card or the full window.
// Returns the element; onOpen(node) opens a box's diff.
function umlPanel(model, { onOpen, onFull = null, full = false } = {}) {
  const panel = el('div', `uml-panel${full ? ' full' : ''}`);
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
  // Big diagrams start with compact boxes; this shows the members again.
  let compact = model.nodes.filter(n => ['new', 'mod', 'del'].includes(n.status)).length > 16;
  const membersBtn = button('Members', 'Show or hide the changed members in the boxes', () => {
    compact = !compact;
    membersBtn.classList.toggle('active', !compact);
    panel.redraw();
  });
  membersBtn.classList.toggle('active', !compact);
  if (onFull) button('⤢', 'Open in the whole window', onFull);
  if (!full) panel.appendChild(el('div', 'uml-hint', 'Drag to move · Ctrl+wheel to zoom · click a box for its diff'));
  // Drawn once the panel is in the page and has a size. In the chat, the
  // panel then takes the diagram's height (within limits), so it shows at
  // close to full size.
  const draw = () => {
    if (api || !stage.isConnected || !stage.clientWidth) return false;
    api = drawUml(stage, model, { onOpen, wheelZooms: full, compact });
    if (!full) {
      const scale = Math.min(1, (stage.clientWidth - 48) / Math.max(1, api.width));
      const wanted = Math.round(api.height * Math.max(scale, 0.75) + 96);
      panel.style.height = `${Math.min(620, Math.max(240, wanted))}px`;
      requestAnimationFrame(() => api.fit());
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
  umlFullEl?.remove();
  umlFullEl = null;
}

function openUmlFull(model, { onOpen, title }) {
  closeUmlFull();
  umlFullEl = el('div', 'uml-full');
  umlFullEl.tabIndex = -1;
  const bar = el('div', 'review-bar');
  const close = el('button', null, 'Close (Esc)');
  close.onclick = closeUmlFull;
  bar.append(el('span', 'review-title', title), el('span', 'hint', 'Wheel to zoom · drag to move · click a box for its diff'), close);
  umlFullEl.append(bar, umlPanel(model, { onOpen, full: true }));
  document.getElementById('main').appendChild(umlFullEl);
  umlFullEl.focus();
}

// Esc closes the full-window diagram, unless a review opened from it is on
// top (that one closes first, back to the diagram).
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !umlFullEl || document.querySelector('.review')) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  closeUmlFull();
}, true);

window.umlPanel = umlPanel;
window.openUmlFull = openUmlFull;
window.closeUmlFull = closeUmlFull;
