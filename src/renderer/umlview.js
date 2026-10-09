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
// grouped: the box sits in its namespace's package box, so it does not
// repeat the namespace.
function boxFor(node, compact = false, grouped = false) {
  const lines = [];
  const top = [];
  if (STEREOTYPES[node.kind]) top.push(STEREOTYPES[node.kind]);
  if (node.record) top.push('«record»');
  const head = { stereo: top.join(' '), name: node.name + (node.generic || ''), sub: node.package || (grouped && node.status !== 'context' ? '' : node.namespace || '') };
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
// Types are grouped by where they live in the code: the changed ones by
// folder (types in the same folder belong together, even when the whole
// feature shares one namespace), the others by package or namespace. Each
// group is laid out on its own, then the groups are laid out the same way,
// by how they depend on each other.
function groupKey(node) {
  // Types the task only uses live all over the project: one group for them.
  if (node.status === 'context') return 'ns:Used, not changed';
  return `dir:${node.folder || node.namespace || 'Other'}`;
}

// The group's title: a folder relative to the folder all changes share
// ("Placements", "Views/Dialogs"), or the package or namespace.
function groupLabels(nodes) {
  const split = p => p.split(/[\\/]/).filter(Boolean);
  const dirs = [...new Set(nodes.filter(n => n.status !== 'context' && n.folder).map(n => n.folder))].map(split);
  let common = dirs.length ? dirs[0].length : 0;
  for (const d of dirs) {
    let i = 0;
    while (i < common && i < d.length && d[i] === dirs[0][i]) i++;
    common = i;
  }
  // Keep the last shared folder in the title, so one folder still has a name.
  const keep = Math.max(0, common - 1);
  return key => {
    if (key.startsWith('ns:')) return key.slice(3);
    const parts = split(key.slice(4));
    return parts.slice(keep).join('/') || parts[parts.length - 1] || key.slice(4);
  };
}

// Puts rows of ids under each other, centred; sets x and y (relative) on the
// items and returns the size. size(id) gives { w, h }.
function placeRows(rows, size, gapX, gapY) {
  const widths = rows.map(row => row.reduce((s, id) => s + size(id).w, 0) + gapX * (row.length - 1));
  const width = Math.max(0, ...widths);
  let y = 0;
  rows.forEach((row, r) => {
    let x = (width - widths[r]) / 2;
    const h = Math.max(...row.map(id => size(id).h));
    for (const id of row) {
      const s = size(id);
      s.x = x;
      s.y = y;
      x += s.w + gapX;
    }
    y += h + gapY;
  });
  return { width, height: Math.max(0, y - gapY) };
}

function drawUml(container, model, { onOpen, wheelZooms = false, compact = false } = {}) {
  const boxes = new Map();
  for (const n of model.nodes) boxes.set(n.id, { id: n.id, node: n, ...boxFor(n, compact, true) });
  for (const b of boxes.values()) { b.w = b.width; b.h = b.height; }
  const GAP_X = 36;
  const GAP_Y = 56;
  const PAD = 18;
  const TITLE = 30;
  const GROUP_GAP = 60;
  const aspect = container.clientWidth && container.clientHeight ? container.clientWidth / container.clientHeight : 1.6;

  // Each group on its own: its types in layers, rows of a sensible width.
  const labelOf = groupLabels(model.nodes);
  const groups = new Map();
  for (const n of model.nodes) {
    const key = groupKey(n);
    if (!groups.has(key)) groups.set(key, { id: key, ids: [] });
    groups.get(key).ids.push(n.id);
  }
  for (const g of groups.values()) {
    const inGroup = new Set(g.ids);
    const nodes = g.ids.map(id => boxes.get(id).node);
    const area = g.ids.reduce((s, id) => s + (boxes.get(id).w + GAP_X) * (boxes.get(id).h + GAP_Y), 0);
    const rows = layout(nodes, model.edges.filter(e => inGroup.has(e.from) && inGroup.has(e.to)), {
      maxRowWidth: Math.max(420, Math.sqrt(area * Math.max(1.2, aspect)) * 1.1),
      widthOf: id => boxes.get(id).w,
      gap: GAP_X,
    });
    const size = placeRows(rows, id => boxes.get(id), GAP_X, GAP_Y);
    g.label = labelOf(g.id);
    g.namespaces = [...new Set(nodes.map(n => n.namespace).filter(Boolean))];
    g.context = nodes.every(n => n.status === 'context');
    g.w = Math.max(size.width, Math.min(textWidth(g.label, UML_SMALL) + 24, 420)) + PAD * 2;
    g.h = size.height + TITLE + PAD;
    g.inner = size;
  }
  // Then the groups: a group that uses another stands above it.
  const groupEdges = new Map();
  for (const e of model.edges) {
    const a = groupKey(boxes.get(e.from)?.node || {});
    const b = groupKey(boxes.get(e.to)?.node || {});
    if (a !== b && groups.has(a) && groups.has(b)) groupEdges.set(`${a}>${b}`, { from: a, to: b });
  }
  const groupArea = [...groups.values()].reduce((s, g) => s + (g.w + GROUP_GAP) * (g.h + GROUP_GAP), 0);
  const groupRows = layout([...groups.values()], [...groupEdges.values()], {
    maxRowWidth: Math.max(900, Math.sqrt(groupArea * aspect) * 1.1),
    widthOf: id => groups.get(id).w,
    gap: GROUP_GAP,
  });
  // Groups in a row line up at the top.
  const total = placeRows(groupRows, id => groups.get(id), GROUP_GAP, GROUP_GAP);
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
    const box = svgEl('g', { class: `uml-group${g.context ? ' context' : ''}`, transform: `translate(${g.x},${g.y})` });
    box.appendChild(svgEl('rect', { width: g.w, height: g.h, rx: 14 }));
    // A long namespace shows its last parts; the full name is in the tooltip.
    let label = g.label;
    while (textWidth(label, UML_SMALL) > g.w - 28 && label.includes('.')) label = '…' + label.slice(label.indexOf('.', label.startsWith('…') ? 2 : 1));
    box.appendChild(svgEl('text', { x: 14, y: 20 }, label));
    const ns = g.namespaces.length ? `\nnamespace ${g.namespaces.join(', ')}` : '';
    box.appendChild(svgEl('title', {}, `${g.label}${ns}\n${g.ids.length} type${g.ids.length === 1 ? '' : 's'}`));
    groupLayer.appendChild(box);
  }
  world.appendChild(groupLayer);

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
  // readable: never smaller than a size where the boxes can be read; a
  // bigger diagram then starts at its top, centred, and you drag to the rest
  // (Fit shows it all).
  const fit = ({ readable = false } = {}) => {
    const w = container.clientWidth || 800;
    const h = container.clientHeight || 400;
    // Room for the buttons above and the legend below.
    const top = 44;
    const bottom = 40;
    view.k = Math.min(1.1, (w - 48) / Math.max(1, maxW), (h - top - bottom) / Math.max(1, totalH));
    if (readable) view.k = Math.max(view.k, 0.62);
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
      onOpen?.(node, d.member ? Number(d.member.dataset.line) : first?.line ?? node.line, d.target);
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
  // The boxes in reading order (group by group, top to bottom), for stepping
  // from one type's diff to the next.
  const order = [...groups.values()].sort((a, b) => a.y - b.y || a.x - b.x)
    .flatMap(g => g.ids.map(id => boxes.get(id)).sort((a, b) => a.y - b.y || a.x - b.x).map(b => b.id));
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
  item('context', 'Not changed');
  item('edge-inherits', 'Inherits');
  item('edge-implements', 'Implements');
  item('edge-uses', 'Uses');
  item('edge-fresh', 'New dependency');
  return legend;
}

// ---------- a type's diff, grown out of its box ----------

// Clicking a box grows it into a panel over the diagram with that file's
// diff, at the member you clicked (like an agent's tile growing into its
// chat). Back, or Esc, shrinks it into the box again. ‹ › (or ← →) step to
// the previous or next changed type. The diagram stays dimmed underneath.
let activeDetail = null;

function openDetail(panel, api, model, node, line, { files, onReview }) {
  activeDetail?.close(true);
  const changedIds = api.order.filter(id => model.nodes.find(n => n.id === id && ['new', 'mod', 'del'].includes(n.status)));
  const box = el('div', 'uml-detail');
  const head = el('div', 'uml-detail-head');
  const body = el('div', 'uml-detail-body');
  box.append(head, body);
  panel.appendChild(box);

  const rectOf = id => {
    const g = api.elementOf(id)?.querySelector('.uml-box');
    const p = panel.getBoundingClientRect();
    const r = g ? g.getBoundingClientRect() : { left: p.left + p.width / 2 - 60, top: p.top + p.height / 2 - 30, width: 120, height: 60 };
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
      const i = changedIds.indexOf(n.id);
      b.disabled = i < 0 || !changedIds[i + delta];
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
    // To the member: the diff line nearest to it, marked for a moment.
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
    const i = changedIds.indexOf(current.id);
    const next = model.nodes.find(n => n.id === changedIds[i + delta]);
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
// onReview(node, line) opens the review at a type; onContext(node) is for a
// type the task did not change (it opens in your editor).
function umlPanel(model, { files = [], onReview, onContext, onFull = null, full = false } = {}) {
  const panel = el('div', `uml-panel${full ? ' full' : ' wide'}`);
  const onOpen = (node, line) => {
    if (node.status === 'context' || !files.some(f => f.path === node.file)) onContext?.(node);
    else if (api) openDetail(panel, api, model, node, line, { files, onReview });
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
  // panel then takes the diagram's height at the width it has (up to most
  // of the window's height), so the boxes show at a readable size.
  const draw = () => {
    if (api || !stage.isConnected || !stage.clientWidth) return false;
    api = drawUml(stage, model, { onOpen, wheelZooms: full, compact });
    if (!full) {
      const scale = Math.min(1.1, (stage.clientWidth - 48) / Math.max(1, api.width));
      const wanted = Math.round(api.height * Math.max(scale, 0.6) + 120);
      panel.style.height = `${Math.round(Math.min(window.innerHeight * 0.82, Math.max(380, wanted)))}px`;
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
