// The class diagram of a task's C# changes (the model comes from
// src/csharp.js): one box per type the task added, changed or removed, with
// just its name, in a box per namespace, and arrows for how the types depend
// on each other. The lower levels stand on top: a type stands below the types
// it uses (its arrows point up), and a namespace below the namespaces it
// uses. Inside a namespace,
// each folder has a lane of its own, under its name. Drag to move around, Ctrl+wheel (or the
// buttons) to zoom; in the full-window view the wheel zooms by itself. Point
// at a box for its changed members; click it to open its diff.

const SVG_NS = 'http://www.w3.org/2000/svg';
const UML_FONT = '600 13px Nunito, "Segoe UI", sans-serif';
const UML_SMALL = '11px Nunito, "Segoe UI", sans-serif';
const UML_BOX_H = 38;
const COMPOSER_H = 40;
const COMPOSER_W = 40;       // the composer's bar down the left of its namespace
const COMPOSER_MIN_H = 220;

// "⚙ StarterBonusSystemComposer"
function composerLabel(b) {
  return `⚙ ${b.name}`;
}

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

// An arrow from the type that uses to the type it uses: a curve from a side
// of the one to the facing side of the other. Ends are spread along each
// side (slots).
function drawEdge(a, b, edge, slots) {
  const at = (box, side) => {
    const list = slots.get(`${box.id}|${side}`) || [];
    return (list.indexOf(`${edge.from}>${edge.to}`) + 1) / (list.length + 1);
  };
  let d;
  const side = edgeSides(a, b);
  if (side === 'right' || side === 'left') {
    const right = side === 'right';
    const sx = right ? a.x + a.w : a.x;
    const sy = a.y + a.h * at(a, right ? 'right' : 'left');
    const tx = right ? b.x : b.x + b.w;
    const ty = b.y + b.h * at(b, right ? 'left' : 'right');
    const dx = Math.max(40, Math.abs(tx - sx) / 2) * (right ? 1 : -1);
    d = `M${sx},${sy} C${sx + dx},${sy} ${tx - dx},${ty} ${tx},${ty}`;
  } else {
    const down = side === 'down';
    const sx = a.x + a.w * at(a, down ? 'bottom' : 'top');
    const sy = down ? a.y + a.h : a.y;
    const tx = b.x + b.w * at(b, down ? 'top' : 'bottom');
    const ty = down ? b.y : b.y + b.h;
    const dy = Math.max(30, Math.abs(ty - sy) / 2) * (down ? 1 : -1);
    d = `M${sx},${sy} C${sx},${sy + dy} ${tx},${ty - dy} ${tx},${ty}`;
  }
  const g = svgEl('g', { class: `uml-edge ${edge.kind}${edge.fresh ? ' fresh' : ''}`, 'data-from': edge.from, 'data-to': edge.to });
  g.appendChild(svgEl('path', { d, 'marker-end': `url(#uml-${edge.kind === 'uses' ? 'arrow' : 'triangle'}${edge.fresh ? '-fresh' : ''})` }));
  const words = { inherits: 'inherits from', implements: 'implements', uses: 'uses' };
  g.appendChild(svgEl('title', {}, `${edge.fromName} ${words[edge.kind]} ${edge.toName}${edge.fresh ? ' (new in this task)' : ''}`));
  return g;
}

function edgeSides(a, b) {
  if (a.composer) return 'right';
  // Between rows (and from a composer) the arrow goes down or up; in a row, sideways.
  if (a.lane !== b.lane || a.row !== b.row) return b.y > a.y ? 'down' : 'up';
  if (b.x >= a.x + a.w + 8) return 'right';
  if (b.x + b.w <= a.x - 8) return 'left';
  return b.y > a.y ? 'down' : 'up';
}

// Each type's folder, relative to the folder all the changed files share:
// "StarterBonus/Model", "StarterBonusUI/MainView". When they all share one
// folder, its own name.
function folderLabels(nodes) {
  const split = p => (p || '').split(/[\\/]/).filter(Boolean);
  const dirs = nodes.map(n => split(n.folder));
  let common = dirs.length ? dirs[0].length : 0;
  for (const d of dirs) {
    let i = 0;
    while (i < common && i < d.length && d[i] === dirs[0][i]) i++;
    common = i;
  }
  return n => {
    const parts = split(n.folder);
    return parts.slice(common).join('/') || parts[parts.length - 1] || n.namespace || '';
  };
}

// A name shown in the space there is: its last parts, with … in front.
function fitLabel(text, width) {
  let label = text;
  while (textWidth(label, UML_SMALL) > width && /[./]/.test(label.replace(/^…/, ''))) {
    const rest = label.startsWith('…') ? label.slice(1) : label;
    label = '…' + rest.slice(rest.search(/[./]/) + 1);
  }
  return label;
}

// Two kinds of type have a role of their own in these projects:
// - a SystemComposer creates and wires the types of its feature, so it uses
//   almost all of them. It is a bar down the left side of its namespace, and
//   its wiring arrows show only while you point at it.
// - a Facade (and its I…Facade interface) is the API other domains use. It
//   has an "API" tag, the interface stands on a row of its own at the bottom
//   of its namespace (where the other domains come in), and arrows into it
//   from other namespaces stand out.
function isComposer(n) {
  return /Composer$/.test(n.name) || (n.bases || []).some(b => /SystemComposer$/.test(b));
}
function isFacade(n) {
  return /Facade$/.test(n.name);
}

// Draws the diagram into container. Returns { fit, zoom, svg, width,
// height, order, elementOf }. onOpen(node, line) runs when a box is clicked,
// with the line of its first change.
function drawUml(container, model, { onOpen, wheelZooms = false } = {}) {
  // A box with many arrows on one side is wider, so their ends spread out.
  const ins = new Map();
  const outs = new Map();
  for (const e of model.edges) {
    outs.set(e.from, (outs.get(e.from) || 0) + 1);
    ins.set(e.to, (ins.get(e.to) || 0) + 1);
  }
  const boxes = new Map();
  for (const n of model.nodes) {
    const name = n.name + (n.generic || '');
    const w = Math.max(Math.min(Math.max(Math.ceil(textWidth(name, UML_FONT)) + 40, 110), 340), 18 * (Math.max(ins.get(n.id) || 0, outs.get(n.id) || 0) + 1));
    const h = UML_BOX_H;
    const composer = isComposer(n);
    boxes.set(n.id, { id: n.id, node: n, name, w, h: composer ? COMPOSER_H : h, composer, facade: !composer && isFacade(n) });
  }
  for (const e of model.edges) {
    const b = boxes.get(e.from);
    if (b?.composer) b.wires = (b.wires || 0) + 1;
  }
  const GAP_X = 36;     // between the boxes of a row
  const GAP_Y = 84;     // room for the arrows between rows
  const LANE_GAP = 56;  // between the folder lanes of a namespace
  const LABEL = 26;     // the folder names over their lanes
  const COMPOSER_GAP = 40;
  const PAD = 18;
  const TITLE = 30;     // the namespace's name
  const GROUP_GAP = 56;
  // The width that shows at a readable size: wider rows wrap.
  const maxWidth = Math.max(700, ((container.clientWidth || 1100) - 48) / 0.85);

  // A folder name for each type, relative to the folder all changes share.
  const labelOf = folderLabels(model.nodes);
  for (const b of boxes.values()) b.folder = labelOf(b.node);

  // One box per namespace, laid out on its own.
  const groups = new Map();
  for (const n of model.nodes) {
    const key = n.namespace || '(no namespace)';
    if (!groups.has(key)) groups.set(key, { id: key, ids: [] });
    groups.get(key).ids.push(n.id);
  }
  const folderLanes = [];   // { folder, x, right, y } for the lane names
  // How many types of other namespaces use a type (composers do not count).
  const externalUsers = id => new Set(model.edges
    .filter(e => e.to === id && !boxes.get(e.from)?.composer && boxes.get(e.from)?.node.namespace !== boxes.get(id).node.namespace)
    .map(e => e.from)).size;
  for (const g of groups.values()) {
    // Rows: a type above the types it uses. The composer and the facade's
    // interface have places of their own (see below).
    const composers = g.ids.map(id => boxes.get(id)).filter(b => b.composer);
    const entries = g.ids.map(id => boxes.get(id)).filter(b => b.node.kind === 'interface' && (b.facade || externalUsers(b.id) >= 2));
    const types = g.ids.map(id => boxes.get(id).node).filter(n => !boxes.get(n.id).composer && !entries.includes(boxes.get(n.id)));
    const typeIds = new Set(types.map(n => n.id));
    const composerSpace = composers.length ? composers.length * (COMPOSER_W + 12) + 28 : 0;
    const rows = layout(types, model.edges.filter(e => typeIds.has(e.from) && typeIds.has(e.to)), {
      maxLength: maxWidth - PAD * 2 - composerSpace,
      sizeOf: id => boxes.get(id).w,
      gap: GAP_X,
    });
    // From the top: the rows from the lowest level up (the types the others
    // use first), then the entry points on a row of their own at the bottom:
    // facade interfaces and seams, the interfaces several types of other
    // namespaces depend on. That is where the other domains come in.
    rows.reverse();
    if (entries.length) rows.push(entries.map(b => b.id));
    // Each folder has a lane, the same strip in every row; the folders in
    // the order their types come on average, so the arrows cross little.
    const place = new Map();
    for (const row of rows) row.forEach((id, i) => place.set(id, i / Math.max(1, row.length - 1)));
    const sums = new Map();
    for (const [id, p] of place) {
      const f = boxes.get(id).folder;
      const v = sums.get(f) || { sum: 0, n: 0 };
      v.sum += p;
      v.n++;
      sums.set(f, v);
    }
    const folders = [...sums.keys()].sort((a, b) => sums.get(a).sum / sums.get(a).n - sums.get(b).sum / sums.get(b).n);
    const runWidth = ids => ids.reduce((sum, id) => sum + boxes.get(id).w, 0) + GAP_X * Math.max(0, ids.length - 1);
    const laneWidth = new Map(folders.map(f => [f, Math.max(
      Math.min(textWidth(f, UML_SMALL) + 8, 240),
      ...rows.map(row => runWidth(row.filter(id => boxes.get(id).folder === f))),
    )]));
    const lanesWidth = folders.reduce((sum, f) => sum + laneWidth.get(f), 0) + LANE_GAP * Math.max(0, folders.length - 1);
    const innerWidth = composerSpace + Math.max(lanesWidth, Math.min(textWidth(g.id, UML_SMALL) + 24, 280));
    const laneX = new Map();
    let x0 = composerSpace + (innerWidth - composerSpace - lanesWidth) / 2;
    for (const f of folders) {
      laneX.set(f, x0);
      x0 += laneWidth.get(f) + LANE_GAP;
    }
    let y = 0;
    const lanesTop = y;
    if (folders.length) y += LABEL;
    rows.forEach((row, r) => {
      for (const f of folders) {
        const ids = row.filter(id => boxes.get(id).folder === f);
        let x = laneX.get(f) + (laneWidth.get(f) - runWidth(ids)) / 2;
        for (const id of ids) {
          Object.assign(boxes.get(id), { x, y, row: `${g.id}|${r}` });
          x += boxes.get(id).w + GAP_X;
        }
      }
      y += UML_BOX_H + GAP_Y;
    });
    const height = rows.length ? y - GAP_Y : Math.max(COMPOSER_MIN_H, 0);
    g.lanes = folders.map(f => ({ folder: f, x: laneX.get(f), right: laneX.get(f) + laneWidth.get(f), y: lanesTop, bottom: height }));
    // The composer: a bar down the left side, as tall as the namespace's
    // types; its wiring goes out to the right.
    composers.forEach((b, i) => {
      // As tall as the namespace, and at least as long as its name.
      Object.assign(b, { x: i * (COMPOSER_W + 12), y: 0, w: COMPOSER_W, h: Math.max(COMPOSER_MIN_H, height, textWidth(composerLabel(b), UML_FONT) + 40), lane: `composer|${g.id}`, row: `composer|${g.id}` });
    });
    g.inner = { width: innerWidth, height: Math.max(height, ...composers.map(b => b.h)) };
    g.w = innerWidth + PAD * 2;
    g.h = g.inner.height + TITLE + PAD;
  }
  // The namespaces under each other, a namespace below the ones it uses
  // (a composer's wiring does not count).
  const groupEdges = new Map();
  for (const e of model.edges) {
    if (boxes.get(e.from)?.composer) continue;
    const a = boxes.get(e.from)?.node.namespace || '(no namespace)';
    const b = boxes.get(e.to)?.node.namespace || '(no namespace)';
    if (a !== b) groupEdges.set(`${a}>${b}`, { from: a, to: b });
  }
  const groupOrder = layout([...groups.values()], [...groupEdges.values()], { maxLength: Infinity, sizeOf: () => 1, gap: 0 }).flat().reverse();
  const maxW = Math.max(0, ...[...groups.values()].map(g => g.w));
  let groupY = 0;
  for (const id of groupOrder) {
    const g = groups.get(id);
    g.x = (maxW - g.w) / 2;
    g.y = groupY;
    groupY += g.h + GROUP_GAP;
    const dx = g.x + PAD;
    const dy = g.y + TITLE;
    for (const boxId of g.ids) {
      const b = boxes.get(boxId);
      b.x += dx;
      b.y += dy;
    }
    for (const lane of g.lanes) folderLanes.push({ folder: lane.folder, x: lane.x + dx, right: lane.right + dx, y: lane.y + dy, bottom: lane.bottom + dy, single: g.lanes.length === 1 });
  }
  const totalH = Math.max(0, groupY - GROUP_GAP);

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

  // The namespace boxes, behind everything else.
  const groupLayer = svgEl('g', { class: 'uml-groups' });
  for (const g of groups.values()) {
    const box = svgEl('g', { class: 'uml-group', transform: `translate(${g.x},${g.y})` });
    box.appendChild(svgEl('rect', { width: g.w, height: g.h, rx: 14 }));
    box.appendChild(svgEl('text', { x: 14, y: 20 }, fitLabel(g.id, g.w - 28)));
    box.appendChild(svgEl('title', {}, `namespace ${g.id}\n${g.ids.length} changed type${g.ids.length === 1 ? '' : 's'}`));
    groupLayer.appendChild(box);
  }
  world.appendChild(groupLayer);

  // Each folder lane: its name and a faint strip behind its types.
  const folderLayer = svgEl('g', { class: 'uml-folders' });
  for (const lane of folderLanes) {
    const g = svgEl('g', { class: 'uml-folder' });
    g.appendChild(svgEl('rect', { class: 'uml-lane', x: lane.x - 10, y: lane.y - 4, width: lane.right - lane.x + 20, height: lane.bottom - lane.y + 14, rx: 10 }));
    g.appendChild(svgEl('text', { x: lane.x, y: lane.y + 13 }, fitLabel(lane.folder, Math.max(60, lane.right - lane.x))));
    g.appendChild(svgEl('title', {}, `folder ${lane.folder}`));
    folderLayer.appendChild(g);
  }
  world.appendChild(folderLayer);

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
    const a = boxes.get(e.from);
    const b = boxes.get(e.to);
    const g = drawEdge(a, b, e, slots);
    // The composer's wiring: only while you point at the composer.
    if (a.composer) g.classList.add('composition');
    else if (outgoing.get(e.from) > 5) g.classList.add('faint');
    // Another domain using this one's API.
    if (b.facade && !a.composer && a.node.namespace !== b.node.namespace) g.classList.add('api-call');
    edgeLayer.appendChild(g);
  }
  world.appendChild(edgeLayer);

  // The boxes: a stripe in the color of the change, and the name.
  for (const b of boxes.values()) {
    const n = b.node;
    const role = b.composer ? ' composer' : b.facade ? ' facade' : '';
    const g = svgEl('g', { class: `uml-node status-${n.status} kind-${n.kind}${role}`, transform: `translate(${b.x},${b.y})`, 'data-id': n.id });
    g.appendChild(svgEl('rect', { class: 'uml-box', width: b.w, height: b.h, rx: b.composer ? 10 : 8 }));
    g.appendChild(svgEl('rect', { class: 'uml-band', width: 4, height: b.h - 12, x: 6, y: 6, rx: 2 }));
    if (b.composer) {
      g.appendChild(svgEl('text', { class: 'uml-name', x: b.w / 2 + 3, y: b.h / 2 + 4.5, transform: `rotate(-90 ${b.w / 2 + 3} ${b.h / 2})` }, composerLabel(b)));
    } else {
      g.appendChild(svgEl('text', { class: 'uml-name', x: b.w / 2 + 3, y: b.h / 2 + 4.5 }, b.name));
    }
    if (b.facade) {
      g.appendChild(svgEl('rect', { class: 'uml-api-tag', x: b.w - 34, y: -9, width: 30, height: 16, rx: 8 }));
      g.appendChild(svgEl('text', { class: 'uml-api-text', x: b.w - 19, y: 3 }, 'API'));
    }
    const changed = n.members.filter(m => m.change).map(m => `${CHANGE_SIGN[m.change]} ${memberLabel(m)}`);
    const words = { new: 'New', mod: 'Changed', del: 'Deleted' };
    const shown = changed.slice(0, 20);
    if (changed.length > 20) shown.push(`… and ${changed.length - 20} more`);
    const roleText = b.composer ? '\nCreates and wires the types of its feature (point at it to see the wiring)' : b.facade ? '\nFacade: the API other domains use' : '';
    g.appendChild(svgEl('title', {}, `${KIND_WORDS[n.kind] || n.kind} ${n.namespace ? n.namespace + '.' : ''}${b.name}${roleText}\n${words[n.status]} in this task${shown.length ? `\n\n${shown.join('\n')}` : ''}\n\n${n.file}\nClick to open the diff`));
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
    if (readable) view.k = Math.max(view.k, 0.8);
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
  // The boxes in reading order (top to bottom, left to right), for stepping
  // from one type's diff to the next.
  const readingOrder = [...boxes.values()].sort((a, b) => a.y - b.y || a.x - b.x).map(b => b.id);
  const elementOf = id => world.querySelector(`.uml-node[data-id="${CSS.escape(id)}"]`);
  return { fit, zoom, svg, width: maxW, height: totalH, order: readingOrder, elementOf };
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
  item('role-composer', 'Composer');
  item('role-facade', 'Facade (API)');
  return legend;
}

// ---------- a type's diff, grown out of its box ----------

// Clicking a box grows it into a panel with that file's diff, at the type's
// first change (like an agent's tile growing into its chat). The panel pops
// up over the chat, as tall as the code needs, up to the whole chat area;
// the chat dims behind it. Back, Esc or a click beside it shrinks it into
// the box again. ‹ › (or ← →) step to the previous or next type. Click a
// line to comment on it.
let activeDetail = null;

function openDetail(panel, api, model, node, line, { files, comments }) {
  activeDetail?.close(true);
  const ids = api.order;
  const host = document.getElementById('main');
  const backdrop = el('div', 'uml-detail-backdrop');
  const box = el('div', 'uml-detail');
  const head = el('div', 'uml-detail-head');
  const body = el('div', 'uml-detail-body');
  box.append(head, body);
  host.append(backdrop, box);

  const relative = r => {
    const h = host.getBoundingClientRect();
    return { left: r.left - h.left, top: r.top - h.top, width: r.width, height: r.height };
  };
  const rectOf = id => {
    const g = api.elementOf(id)?.querySelector('.uml-box');
    const p = panel.getBoundingClientRect();
    return relative(g ? g.getBoundingClientRect() : { left: p.left + p.width / 2 - 60, top: p.top + p.height / 2 - 20, width: 120, height: 40 });
  };
  // Over the chat: its width (up to a readable one), as tall as the code.
  const target = () => {
    const area = relative(document.getElementById('views').getBoundingClientRect());
    const margin = 16;
    const width = Math.min(area.width - margin * 2, 1400);
    const needed = head.offsetHeight + body.scrollHeight + 2;
    const height = Math.min(Math.max(needed, 160), area.height - margin * 2);
    return { left: area.left + (area.width - width) / 2, top: area.top + (area.height - height) / 2, width, height };
  };
  const place = r => Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });

  let current = node;
  let unwatch = null;
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
    // Click a line to comment on it; Send puts the comments into the
    // message box and goes back to the chat.
    const send = el('button', 'comments-send hidden');
    send.type = 'button';
    send.title = 'Put the comments into the message box, as one message to the agent';
    send.onclick = () => { comments?.send(); close(); };
    const refresh = c => {
      send.classList.toggle('hidden', !c);
      send.textContent = `Send ${c} comment${c === 1 ? '' : 's'}`;
    };
    refresh(comments?.count() || 0);
    unwatch?.();
    unwatch = comments?.onChange(refresh);
    const back = el('button', 'uml-detail-back', 'Back');
    back.type = 'button';
    back.title = 'Back to the diagram (Esc)';
    back.onclick = () => close();
    head.append(step('‹', 'Previous type (←)', -1), step('›', 'Next type (→)', 1), text, send, back);
    if (!file) {
      body.appendChild(el('div', 'uml-detail-empty', 'No diff for this type.'));
      return;
    }
    // Changes, Full file or Side by side (see fileViews in diffview.js).
    const views = fileViews(file, comments?.cwd, () => (comments ? comments.diff(file, { maxLines: 20000 }) : renderDiff(file, { maxLines: 20000 })));
    const diff = views;
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
      // The new type's code may need another height.
      box.classList.add('morphing');
      place(target());
      setTimeout(() => box.classList.remove('morphing'), 200);
      box.classList.add('shown');
    }, 60);
  };
  const onResize = () => { if (activeDetail?.box === box) place(target()); };
  window.addEventListener('resize', onResize);
  backdrop.onclick = () => close();

  // Grow: from the box to its place over the chat.
  fill(node, line);
  place(rectOf(node.id));
  box.classList.add('morphing');
  void box.offsetWidth;
  backdrop.classList.add('shown');
  place(target());
  setTimeout(() => box.classList.add('shown'), 120);
  setTimeout(() => box.classList.remove('morphing'), 200);
  window.uiSound?.('open');

  // Shrink: back into the box of the type in the diagram.
  const close = (instant = false) => {
    if (activeDetail?.box !== box) return;
    activeDetail = null;
    unwatch?.();
    window.removeEventListener('resize', onResize);
    if (instant) { box.remove(); backdrop.remove(); return; }
    window.uiSound?.('close');
    box.classList.remove('shown');
    backdrop.classList.remove('shown');
    box.classList.add('morphing');
    void box.offsetWidth;
    place(rectOf(current.id));
    box.classList.add('closing');
    setTimeout(() => { box.remove(); backdrop.remove(); }, 190);
  };
  activeDetail = { box, panel, close, step: go };
}

// A diagram with its buttons, for the Changes card or the full window.
// Returns the element. files: the card's files, for the diffs of the boxes;
// comments: the card's line comments (see lineComments in diffview.js).
function umlPanel(fullModel, { files = [], comments = null, onFull = null, full = false } = {}) {
  const model = changedModel(fullModel);
  const panel = el('div', `uml-panel${full ? ' full' : ' wide'}`);
  const onOpen = (node, line) => {
    if (api && files.some(f => f.path === node.file)) openDetail(panel, api, model, node, line, { files, comments });
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
  // panel then grows to the diagram's whole height at the width it has (the
  // diagram folds to that width, see drawUml), so all of it shows at a
  // readable size without moving around; the chat scrolls past it.
  const draw = () => {
    if (api || !stage.isConnected || !stage.clientWidth) return false;
    api = drawUml(stage, model, { onOpen, wheelZooms: full });
    if (!full) {
      const scale = Math.min(1.15, (stage.clientWidth - 48) / Math.max(1, api.width));
      panel.style.height = `${Math.max(260, Math.round(api.height * scale + 90))}px`;
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
  if (activeDetail && umlFullEl?.contains(activeDetail.panel)) activeDetail.close(true);
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

// Esc (or Alt+←) closes a type's diff first, then the full-window diagram; a
// review on top of them closes by itself first. ← → step through the types' diffs.
document.addEventListener('keydown', e => {
  // Keys in a comment box stay there (Esc cancels the comment).
  const typing = e.target.closest?.('input, textarea, [contenteditable="true"]');
  if (typing && e.key === 'Escape') return;
  const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
  if (e.key === 'Escape' && activeDetail) { stop(); activeDetail.close(); return; }
  if (e.key === 'Escape' && umlFullEl) { stop(); closeUmlFull(); return; }
  // Alt+← ("back") does the same, before it leaves the agent (see app.js).
  // (On macOS, Option+← in a comment box moves the cursor a word instead.)
  const back = e.key === 'ArrowLeft' && e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey
    && !(typing && /Mac/.test(navigator.platform));
  if (back && activeDetail) { stop(); activeDetail.close(); return; }
  if (back && umlFullEl) { stop(); closeUmlFull(); return; }
  if (activeDetail && !typing && !e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    stop();
    activeDetail.step(e.key === 'ArrowRight' ? 1 : -1);
  }
}, true);

window.umlPanel = umlPanel;
window.openUmlFull = openUmlFull;
window.closeUmlFull = closeUmlFull;
