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
// The fonts the diagram's text is drawn in (styles.css: .uml-name, and
// .uml-group / .uml-folder text). They use the theme's --font, so boxes are
// measured in it too: the retro theme's monospace is much wider than the
// default look's Nunito, and names measured in Nunito ran out of their box.
const UML_FONT = 'name';
const UML_SMALL = 'small';
const UML_STYLES = { name: '600 13px', small: '600 11px' };
const UML_BOX_H = 38;
const COMPOSER_H = 40;
const COMPOSER_W = 40;       // the composer's bar down the left of its namespace

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

// Measured on a hidden element in the page, not on a canvas: a canvas does
// not know the theme's font names (such as ui-monospace) and would measure
// in a fallback font.
let measureEl = null;
const measured = new Map();
function textWidth(text, kind) {
  const family = getComputedStyle(document.documentElement).getPropertyValue('--font').trim() || 'sans-serif';
  const font = `${UML_STYLES[kind] || kind} ${family}`;
  const key = `${font}|${text}`;
  if (measured.has(key)) return measured.get(key);
  if (!measureEl) {
    measureEl = document.createElement('span');
    Object.assign(measureEl.style, { position: 'absolute', left: '-10000px', top: '0', visibility: 'hidden', whiteSpace: 'pre', textTransform: 'none', letterSpacing: '0' });
    document.body.appendChild(measureEl);
  }
  measureEl.style.font = font;
  measureEl.textContent = text;
  const width = measureEl.getBoundingClientRect().width;
  measured.set(key, width);
  return width;
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
  // In a cycle some arrows must point the other way. Which ones: an order
  // that leaves as few (by weight: how many arrows of types an arrow between
  // folders stands for) pointing back as it can (Eades, Lin and Smyth's
  // greedy order: take the types nothing uses first, those that use nothing
  // last, else the one that uses most more than it is used). Arrows that go
  // back in that order do not rank.
  const weight = new Map();
  for (const e of edges) {
    if (!out.has(e.from) || !out.has(e.to) || e.from === e.to) continue;
    const k = `${e.from}>${e.to}`;
    weight.set(k, (weight.get(k) || 0) + (e.weight || 1));
  }
  const left = new Set(ids);
  const inW = id => { let w = 0; for (const [k, v] of weight) { const [a, b] = k.split('>'); if (b === id && left.has(a)) w += v; } return w; };
  const outW = id => { let w = 0; for (const [k, v] of weight) { const [a, b] = k.split('>'); if (a === id && left.has(b)) w += v; } return w; };
  const head = [];
  const tail = [];
  while (left.size) {
    let moved = true;
    while (moved) {
      moved = false;
      for (const id of [...left]) {
        if (outW(id) === 0) { tail.unshift(id); left.delete(id); moved = true; }
        else if (inW(id) === 0) { head.push(id); left.delete(id); moved = true; }
      }
    }
    if (!left.size) break;
    let best = null;
    let bestScore = -Infinity;
    for (const id of left) {
      const score = outW(id) - inW(id);
      if (score > bestScore) { bestScore = score; best = id; }
    }
    head.push(best);
    left.delete(best);
  }
  const position = new Map([...head, ...tail].map((id, i) => [id, i]));
  const forward = edges.filter(e => out.has(e.to) && out.has(e.from) && position.get(e.from) < position.get(e.to));
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
  // The arrowhead is at the start, on the type that depends on the other:
  // the arrow points from what is used to what uses it (the markers turn
  // round there, see auto-start-reverse).
  g.appendChild(svgEl('path', { d, 'marker-start': `url(#uml-${edge.kind === 'uses' ? 'arrow' : 'triangle'}${edge.fresh ? '-fresh' : ''})` }));
  const words = { inherits: 'inherits from', implements: 'implements', uses: 'uses' };
  g.appendChild(svgEl('title', {}, `${edge.fromName} ${words[edge.kind]} ${edge.toName}${edge.fresh ? ' (new in this task)' : ''}`));
  return g;
}

function edgeSides(a, b) {
  if (a.composer) return 'right';
  // In a row, sideways.
  if (a.lane === b.lane && a.row === b.row) {
    if (b.x >= a.x + a.w + 8) return 'right';
    if (b.x + b.w <= a.x - 8) return 'left';
  }
  // Otherwise by where the other box is: sideways when it is beside this
  // one (its card is next to this one's), else down or up.
  const gap = b.y >= a.y + a.h ? b.y - a.y - a.h : a.y >= b.y + b.h ? a.y - b.y - b.h : -1;
  if (gap < 16) {
    if (b.x >= a.x + a.w) return 'right';
    if (b.x + b.w <= a.x) return 'left';
  }
  return b.y + b.h / 2 > a.y + a.h / 2 ? 'down' : 'up';
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
// Types declared inside another changed type (a widget's or a view's Data)
// are drawn inside their owner's box, as small boxes under its name, not as
// boxes of their own. Their arrows go to the owner's box; the arrow between
// a type and its own nested type goes away. Returns { model, owners }:
// owners: owner id -> [nested node] (a nested type in a nested type goes
// into the outermost one shown).
function nestTypes(model) {
  const byName = new Map(model.nodes.map(n => [`${n.file}|${n.namespace}|${n.name}`, n]));
  const ownerId = new Map();
  for (const n of model.nodes) {
    let owner = n.outer ? byName.get(`${n.file}|${n.namespace}|${n.outer}`) : null;
    const seen = new Set([n.id]);
    while (owner?.outer && byName.get(`${owner.file}|${owner.namespace}|${owner.outer}`) && !seen.has(owner.id)) {
      seen.add(owner.id);
      owner = byName.get(`${owner.file}|${owner.namespace}|${owner.outer}`);
    }
    if (owner && owner.id !== n.id && !isComposer(owner)) ownerId.set(n.id, owner.id);
  }
  const owners = new Map();
  for (const n of model.nodes) {
    if (!ownerId.has(n.id)) continue;
    if (!owners.has(ownerId.get(n.id))) owners.set(ownerId.get(n.id), []);
    owners.get(ownerId.get(n.id)).push(n);
  }
  const to = id => ownerId.get(id) || id;
  const edges = new Map();
  for (const e of model.edges) {
    const from = to(e.from);
    const target = to(e.to);
    if (from === target) continue;
    const key = `${from}>${target}`;
    const prev = edges.get(key);
    if (!prev || (prev.kind === 'uses' && e.kind !== 'uses')) edges.set(key, { ...e, from, to: target });
  }
  return { model: { ...model, nodes: model.nodes.filter(n => !ownerId.has(n.id)), edges: [...edges.values()] }, owners };
}

const INNER_H = 26;     // a nested type's small box
const INNER_GAP = 6;

// collapsed: the keys of collapsed namespaces ("ns:<namespace>") and folders
// ("f:<namespace>|<part>|<folder>"); onToggle(key) runs when you click one's
// name or its box. view: where to look ({ x, y, k }) instead of fitting.
function drawUml(container, model, { onOpen, onToggle, collapsed = new Set(), view: startView = null, wheelZooms = false } = {}) {
  const nesting = nestTypes(model);
  model = nesting.model;

  // Parts: in a namespace with several composers, each type belongs to the
  // composer that wires it (an arrow from it), and to a shared part when none
  // or several do. Composers talk to each other through facade interfaces,
  // which go on each part's entry row.
  const comp = new Map();
  const composersIn = new Map();
  for (const n of model.nodes) {
    if (!isComposer(n)) continue;
    const k = n.namespace || '(no namespace)';
    if (!composersIn.has(k)) composersIn.set(k, []);
    composersIn.get(k).push(n);
  }
  for (const n of model.nodes) {
    const list = composersIn.get(n.namespace || '(no namespace)') || [];
    if (list.length < 2) comp.set(n.id, 'main');
    else if (isComposer(n)) comp.set(n.id, n.id);
    else {
      const wiring = list.filter(c => model.edges.some(e => e.from === c.id && e.to === n.id));
      comp.set(n.id, wiring.length === 1 ? wiring[0].id : 'shared');
    }
  }
  // Each type's folder, relative to the folder all the changes share.
  const labelOf = folderLabels(model.nodes);
  const folderOf = new Map(model.nodes.map(n => [n.id, labelOf(n)]));
  // Collapsed namespaces and folders: their types become one box, and their
  // arrows go to that box.
  {
    const proxyOf = new Map();
    const proxies = new Map();
    for (const n of model.nodes) {
      const ns = n.namespace || '(no namespace)';
      const folderKey = `f:${ns}|${comp.get(n.id)}|${folderOf.get(n.id)}`;
      let key = null;
      let label = null;
      if (collapsed.has(`ns:${ns}`)) { key = `ns:${ns}`; label = ns.split('.').pop(); }
      else if (!isComposer(n) && collapsed.has(folderKey)) { key = folderKey; label = folderOf.get(n.id).split('/').pop(); }
      if (!key) continue;
      proxyOf.set(n.id, key);
      if (!proxies.has(key)) {
        proxies.set(key, {
          id: `proxy:${key}`, name: label, kind: 'collapsed', namespace: n.namespace, folder: n.folder, file: '', line: 0,
          members: [], proxy: key, count: 0, statuses: new Set(),
          comp: key.startsWith('ns:') ? 'main' : comp.get(n.id), folderLabel: key.startsWith('ns:') ? '' : folderOf.get(n.id),
        });
      }
      const p = proxies.get(key);
      p.count++;
      p.statuses.add(n.status);
    }
    if (proxies.size) {
      for (const p of proxies.values()) {
        p.status = p.statuses.size === 1 ? [...p.statuses][0] : 'mod';
        p.name = `${p.name} · ${p.count} type${p.count === 1 ? '' : 's'}`;
        comp.set(p.id, p.comp);
        folderOf.set(p.id, p.folderLabel);
      }
      const to = id => (proxyOf.has(id) ? `proxy:${proxyOf.get(id)}` : id);
      const merged = new Map();
      for (const e of model.edges) {
        const from = to(e.from);
        const target = to(e.to);
        if (from === target) continue;
        const k = `${from}>${target}`;
        const prev = merged.get(k);
        if (!prev || (prev.kind === 'uses' && e.kind !== 'uses')) merged.set(k, { ...e, from, to: target, fresh: e.fresh || !!prev?.fresh });
      }
      model = { ...model, nodes: [...model.nodes.filter(n => !proxyOf.has(n.id)), ...proxies.values()], edges: [...merged.values()] };
    }
  }
  // An interface with only one implementation among the changed types (in
  // its namespace) is drawn with it, as one box: the interface on top, the
  // class under it. Their arrows are the box's. Facades are the usual case.
  const pairOf = new Map();   // class id -> its interface's node
  {
    const byId = new Map(model.nodes.map(n => [n.id, n]));
    const implementers = new Map();
    for (const e of model.edges) {
      const c = byId.get(e.from);
      const i = byId.get(e.to);
      if (e.kind !== 'implements' || !c || !i || i.kind !== 'interface' || c.kind === 'interface' || isComposer(c) || c.proxy || i.proxy) continue;
      if (!implementers.has(i.id)) implementers.set(i.id, new Set());
      implementers.get(i.id).add(c.id);
    }
    for (const [iid, set] of implementers) {
      if (set.size !== 1) continue;
      const c = byId.get([...set][0]);
      const i = byId.get(iid);
      if ((i.namespace || '') !== (c.namespace || '')) continue;
      // A class with several such interfaces keeps the one named after it.
      const prev = pairOf.get(c.id);
      if (prev && prev.name === `I${c.name}`) continue;
      pairOf.set(c.id, i);
    }
    if (pairOf.size) {
      const ifaceOf = new Map([...pairOf].map(([cid, i]) => [i.id, cid]));
      const to = id => ifaceOf.get(id) || id;
      const merged = new Map();
      for (const e of model.edges) {
        const from = to(e.from);
        const target = to(e.to);
        if (from === target) continue;
        const k = `${from}>${target}`;
        const prev = merged.get(k);
        if (!prev || (prev.kind === 'uses' && e.kind !== 'uses')) merged.set(k, { ...e, from, to: target, fresh: e.fresh || !!prev?.fresh });
      }
      model = { ...model, nodes: model.nodes.filter(n => !ifaceOf.has(n.id)), edges: [...merged.values()] };
    }
  }
  const IFACE_H = 30;   // a paired interface's strip at the top of its class's box

  const innerBoxes = new Map();   // nested type id -> { node, owner }
  // A box with many arrows on one side is wider, so their ends spread out.
  const ins = new Map();
  const outs = new Map();
  for (const e of model.edges) {
    outs.set(e.from, (outs.get(e.from) || 0) + 1);
    ins.set(e.to, (ins.get(e.to) || 0) + 1);
  }
  const boxes = new Map();
  for (const n of model.nodes) {
    // A nested type shown without its owner says whose it is: Owner.Data.
    const name = (n.outer ? `${n.outer}.` : '') + n.name + (n.generic || '');
    let w = Math.max(Math.min(Math.max(Math.ceil(textWidth(name, UML_FONT)) + 40, 110), 340), 18 * (Math.max(ins.get(n.id) || 0, outs.get(n.id) || 0) + 1));
    let h = UML_BOX_H;
    const composer = isComposer(n);
    // Its nested types, as small boxes under its name.
    const inner = nesting.owners.get(n.id) || [];
    for (const c of inner) {
      w = Math.max(w, Math.min(Math.ceil(textWidth(c.name + (c.generic || ''), UML_FONT)) + 44, 340));
      innerBoxes.set(c.id, { id: c.id, node: c, owner: n.id });
    }
    if (inner.length) h = 34 + inner.length * (INNER_H + INNER_GAP) + 4;
    const pair = pairOf.get(n.id) || null;
    if (pair) {
      w = Math.max(w, Math.min(Math.ceil(textWidth(pair.name + (pair.generic || ''), UML_FONT)) + 40, 340));
      h += IFACE_H;
      innerBoxes.set(pair.id, { id: pair.id, node: pair, owner: n.id });
    }
    boxes.set(n.id, { id: n.id, node: n, name, w, h: composer ? COMPOSER_H : h, composer, facade: !composer && (isFacade(n) || (pair && isFacade(pair))), inner, pair });
  }
  for (const e of model.edges) {
    const b = boxes.get(e.from);
    if (b?.composer) b.wires = (b.wires || 0) + 1;
  }
  // Each box's folder and part (see above).
  for (const b of boxes.values()) {
    b.folder = folderOf.get(b.id) ?? '';
    b.comp = comp.get(b.id) || 'main';
  }
  const GAP_X = 28;      // between the boxes of a row
  const GAP_Y = 56;      // room for the arrows between the rows of a folder
  const CARD_PAD = 14;   // inside a folder's card
  const CARD_LABEL = 24; // the folder's name at the top of its card
  const CARD_GAP = 22;   // between folder cards
  const COMP_LABEL = 24; // a composer's part: its name at the top
  const COMP_GAP = 26;   // between the parts of a namespace
  const COMPOSER_GAP = 28;
  const PAD = 18;
  const TITLE = 30;      // the namespace's name
  const GROUP_GAP = 56;
  // The width that shows at a readable size: wider rows wrap. A large
  // diagram gets about the shape of the window instead, so it does not turn
  // into a tall column (its area, with room around the boxes, spread at the
  // window's width-to-height).
  const area = [...boxes.values()].reduce((s, b) => s + (b.w + GAP_X) * (b.h + GAP_Y), 0) * 1.8;
  const aspect = Math.max(1, (container.clientWidth || 1600) / Math.max(1, container.clientHeight || 900));
  const maxWidth = Math.max(700, ((container.clientWidth || 1100) - 48) / 0.85, Math.sqrt(area * aspect));
  const CARD_MAX = Math.max(420, Math.min(900, maxWidth * 0.55));   // a card's rows wrap at this width

  // Dependencies flow downwards at every level: what is used sits above
  // what uses it, so the arrows (from the used to the user) run down. items:
  // [{ id, w, h }]; uses: [{ from, to }], from uses to. Returns the rows from
  // the top: one per level of dependency, a level wrapping onto more rows
  // when it is wider than width. merge: a level that fits whole in what is
  // left of the row above continues that row, to the right (dependencies
  // then run down and to the right), so a chain of small items does not
  // take a row each.
  const levelRows = (items, uses, width, gap, { merge = false } = {}) => {
    const byId = new Map(items.map(it => [it.id, it]));
    const rows = [];
    let row = [];
    let used = 0;
    for (const level of layout(items, uses, { maxLength: Infinity, sizeOf: () => 1, gap: 0 }).reverse()) {
      const levelW = level.reduce((sum, id) => sum + byId.get(id).w, 0) + gap * 2 * level.length;
      if (row.length && !(merge && used + levelW <= width)) { rows.push(row); row = []; used = 0; }
      for (const id of level) {
        const it = byId.get(id);
        if (row.length && used + gap + it.w > width) { rows.push(row); row = []; used = 0; }
        used += (row.length ? gap : 0) + it.w;
        row.push(it);
      }
    }
    if (row.length) rows.push(row);
    return rows;
  };
  // Places such rows under each other, each one centred; sets x and y
  // (relative) and returns the size.
  const placeRows = (rows, gapX, gapY) => {
    const rowW = row => row.reduce((s, it) => s + it.w, 0) + gapX * Math.max(0, row.length - 1);
    const w = Math.max(0, ...rows.map(rowW));
    let y = 0;
    rows.forEach((row, r) => {
      let x = (w - rowW(row)) / 2;
      for (const it of row) {
        it.x = x;
        it.y = y;
        x += it.w + gapX;
      }
      y += Math.max(...row.map(it => it.h)) + (r < rows.length - 1 ? gapY : 0);
    });
    return { w, h: rows.length ? y : 0 };
  };
  // The "uses" between the boxes in ids, as pairs of the keys keyOf gives
  // them (a composer's wiring does not count: it uses everything).
  const usesBetween = keyOf => {
    const pairs = new Map();
    for (const e of model.edges) {
      if (boxes.get(e.from)?.composer) continue;
      const a = keyOf(e.from);
      const b = keyOf(e.to);
      if (a == null || b == null || a === b) continue;
      const k = `${a}>${b}`;
      if (!pairs.has(k)) pairs.set(k, { from: a, to: b, weight: 0 });
      pairs.get(k).weight++;
    }
    return [...pairs.values()];
  };

  // One box per namespace; in it one part per composer when it has several
  // (the types each one wires, see compartmentOf), and in each part a card
  // per folder.
  const groups = new Map();
  for (const n of model.nodes) {
    const key = n.namespace || '(no namespace)';
    if (!groups.has(key)) groups.set(key, { id: key, ids: [] });
    groups.get(key).ids.push(n.id);
  }
  for (const g of groups.values()) {
    g.collapsed = collapsed.has(`ns:${g.id}`);
    // Parts: by compartment (one per composer, or one for all).
    const parts = new Map();
    for (const id of g.ids) {
      const b = boxes.get(id);
      const key = b.comp || 'main';
      if (!parts.has(key)) parts.set(key, { key, ids: [] });
      parts.get(key).ids.push(id);
    }
    const partList = [...parts.values()];
    const several = partList.length > 1;
    for (const part of partList) {
      const members = part.ids.map(id => boxes.get(id));
      const composers = members.filter(b => b.composer);
      part.composer = composers[0] || null;
      part.label = part.key === 'shared' ? 'Shared by its composers' : part.composer ? composerLabel(part.composer) : '';
      // The facade (the class and its I…Facade interface) is the part's way
      // out to the namespaces that use it, which come below: it goes at the
      // bottom of the part, under the types it reaches into. Other interfaces
      // go in their folder's card. A collapsed namespace's one box goes there too.
      const entries = g.collapsed ? members : members.filter(b => b.facade);
      const rest = g.collapsed ? [] : members.filter(b => !b.composer && !entries.includes(b));
      // A card per folder: its types in rows, a type above the types it uses.
      const byFolder = new Map();
      for (const b of rest) {
        if (!byFolder.has(b.folder)) byFolder.set(b.folder, []);
        byFolder.get(b.folder).push(b);
      }
      part.cards = [...byFolder].map(([folder, list]) => {
        const ids = new Set(list.map(b => b.id));
        // One row per level of dependency (the used types on top), a level
        // wrapping when it is wider than the card: about as wide as the card
        // is tall, so the card stays compact.
        const sumW = list.reduce((s2, b) => s2 + b.w + GAP_X, 0);
        const target = Math.min(CARD_MAX - CARD_PAD * 2, Math.max(Math.max(...list.map(b => b.w)), Math.sqrt(sumW * (UML_BOX_H + GAP_Y) * 1.6)));
        const rows = levelRows(list, model.edges.filter(e => ids.has(e.from) && ids.has(e.to)), target, GAP_X).map(row => row.map(b => b.id));
        const rowWidth = row => row.reduce((s, id) => s + boxes.get(id).w, 0) + GAP_X * Math.max(0, row.length - 1);
        const innerW = Math.max(Math.min(textWidth(folder, UML_SMALL) + 24, 260), ...rows.map(rowWidth));
        let y = CARD_LABEL;
        const key = `f:${g.id}|${part.key}|${folder}`;
        rows.forEach((row, r) => {
          let x = CARD_PAD + (innerW - rowWidth(row)) / 2;
          for (const id of row) {
            Object.assign(boxes.get(id), { cx: x, cy: y, lane: key, row: `${key}|${r}` });
            x += boxes.get(id).w + GAP_X;
          }
          y += Math.max(UML_BOX_H, ...row.map(id => boxes.get(id).h)) + (r < rows.length - 1 ? GAP_Y : 0);
        });
        return { key, folder, ids: list.map(b => b.id), w: innerW + CARD_PAD * 2, h: y + CARD_PAD, collapsed: list.length === 1 && list[0].node.proxy === key };
      });
      // The cards, by dependency between their types; the entry row above them.
      const left = part.composer ? COMPOSER_W + COMPOSER_GAP : 0;
      const top = several ? COMP_LABEL : 0;
      const cardOf = new Map();
      for (const card of part.cards) { card.id = card.key; for (const cid of card.ids) cardOf.set(cid, card.key); }
      const packed = placeRows(levelRows(part.cards, usesBetween(id => cardOf.get(id)), maxWidth - PAD * 2 - left - (several ? CARD_PAD * 2 : 0), CARD_GAP, { merge: true }), CARD_GAP, CARD_GAP + 12);
      let height = packed.h;
      let width = packed.w;
      // The facade is the part's bottom edge: a bar as wide as the part (with
      // its interface on top when paired), where the parts and namespaces
      // that use it connect. Several facades share the width.
      if (entries.length && !g.collapsed) {
        const naturalW = entries.reduce((s2, b) => s2 + b.w, 0) + GAP_X * (entries.length - 1);
        width = Math.max(width, naturalW);
        const each = (width - GAP_X * (entries.length - 1)) / entries.length;
        let x = 0;
        const y = height + (height ? GAP_Y : 0);
        for (const b of entries) {
          Object.assign(b, { w: each, bar: true, px: x, py: y, lane: `entries|${g.id}|${part.key}`, row: `entries|${g.id}|${part.key}` });
          x += each + GAP_X;
        }
        height = y + Math.max(...entries.map(b => b.h));
      } else if (entries.length) {
        const ids = new Set(entries.map(b => b.id));
        const rows = levelRows(entries, model.edges.filter(e => ids.has(e.from) && ids.has(e.to)), maxWidth - PAD * 2 - left, GAP_X);
        const rowW = row => row.reduce((s2, b) => s2 + b.w, 0) + GAP_X * (row.length - 1);
        width = Math.max(width, ...rows.map(rowW));
        let y = height + (height ? GAP_Y : 0);
        rows.forEach((row, r) => {
          let x = (width - rowW(row)) / 2;
          for (const b of row) {
            Object.assign(b, { px: x, py: y, lane: `entries|${g.id}|${part.key}`, row: `entries|${g.id}|${part.key}|${r}` });
            x += b.w + GAP_X;
          }
          y += Math.max(...row.map(b => b.h)) + (r < rows.length - 1 ? GAP_Y : 0);
        });
        height = y;
      }
      part.entries = entries;
      // A part with a composer is at least as tall as its bar's name.
      const innerH = Math.max(height, part.composer ? Math.max(120, textWidth(composerLabel(part.composer), UML_FONT) + 40) : 0);
      part.left = left;
      part.top = top;
      part.w = left + width + (several ? CARD_PAD * 2 : 0);
      part.h = top + innerH + (several ? CARD_PAD : 0);
      part.innerH = innerH;
    }
    // The parts, by dependency between their types: the shared part, which
    // the others use, comes on top.
    for (const part of partList) part.id = part.key;
    const partOf = id => (g.ids.includes(id) ? boxes.get(id).comp || 'main' : null);
    const packed = placeRows(levelRows(partList, usesBetween(partOf), maxWidth - PAD * 2, COMP_GAP, { merge: true }), COMP_GAP, COMP_GAP + 12);
    g.parts = partList;
    g.several = several;
    g.inner = { width: Math.max(packed.w, Math.min(textWidth(g.id, UML_SMALL) + 40, 320)), height: packed.h };
    g.w = g.inner.width + PAD * 2;
    g.h = g.inner.height + TITLE + PAD;
  }

  // The namespaces under each other, a namespace below the ones it uses
  // (a composer's wiring does not count).
  const groupEdges = new Map();
  for (const e of model.edges) {
    if (boxes.get(e.from)?.composer) continue;
    const a = boxes.get(e.from)?.node.namespace || '(no namespace)';
    const b = boxes.get(e.to)?.node.namespace || '(no namespace)';
    if (a === b) continue;
    // Weighted by how many arrows it stands for: when two namespaces use each
    // other, the direction with more arrows wins (91 against 1, not a tie).
    const k = `${a}>${b}`;
    if (!groupEdges.has(k)) groupEdges.set(k, { from: a, to: b, weight: 0 });
    groupEdges.get(k).weight++;
  }
  // One row per level: a namespace that uses another always comes below it;
  // namespaces of the same level sit side by side while they fit.
  const rowLimit = Math.max(maxWidth, ...[...groups.values()].map(g => g.w));
  const groupRows = levelRows([...groups.values()], [...groupEdges.values()], rowLimit, GROUP_GAP);
  const groupOrder = groupRows.flat().map(g => g.id);
  const rowWidthOf = row => row.reduce((sum, g) => sum + g.w, 0) + GROUP_GAP * (row.length - 1);
  const maxW = Math.max(0, ...groupRows.map(rowWidthOf));
  let groupY = 0;
  for (const row of groupRows) {
    let x = (maxW - rowWidthOf(row)) / 2;
    for (const g of row) {
      g.x = x;
      g.y = groupY;
      x += g.w + GROUP_GAP;
    }
    groupY += Math.max(...row.map(g => g.h)) + GROUP_GAP;
  }
  for (const id of groupOrder) {
    const g = groups.get(id);
    // Absolute places: namespace, then part, then card or entry row.
    for (const part of g.parts) {
      part.ax = g.x + PAD + part.x;
      part.ay = g.y + TITLE + part.y;
      const inset = g.several ? CARD_PAD : 0;
      const ox = part.ax + inset + part.left;
      const oy = part.ay + part.top;
      for (const card of part.cards) {
        card.ax = ox + card.x;
        card.ay = oy + card.y;
        for (const cid of card.ids) {
          const b = boxes.get(cid);
          b.x = card.ax + b.cx;
          b.y = card.ay + b.cy;
        }
      }
      for (const b of part.entries) {
        b.x = ox + b.px;
        b.y = oy + b.py;
      }
      // The composer: a bar down the left side of its part.
      if (part.composer) {
        const c = part.composer;
        Object.assign(c, {
          x: part.ax + inset, y: oy, w: COMPOSER_W,
          h: Math.max(part.innerH, textWidth(composerLabel(c), UML_FONT) + 40),
          lane: `composer|${g.id}|${part.key}`, row: `composer|${g.id}|${part.key}`,
        });
        part.h = Math.max(part.h, part.top + c.h + (g.several ? CARD_PAD : 0));
      }
      // The facade fused with the container's bottom edge: as wide as the
      // container (its part, or the namespace when it has one part), its
      // bottom on the container's border. It is the gate into this domain.
      const bars = part.entries.filter(b => b.bar);
      if (bars.length) {
        const box = g.several ? { x: part.ax, y: part.ay, w: part.w, h: part.h, r: 12 } : { x: g.x, y: g.y, w: g.w, h: g.h, r: 14 };
        const each = box.w / bars.length;
        bars.forEach((b, i) => {
          Object.assign(b, { x: box.x + i * each, w: each, y: box.y + box.h - b.h, fuse: { r: box.r, left: i === 0, right: i === bars.length - 1 } });
        });
        // The composer's bar stops above it.
        if (part.composer) part.composer.h = Math.max(COMPOSER_H, Math.min(part.composer.h, bars[0].y - part.composer.y - 10));
      }
    }
  }
  const totalH = Math.max(0, groupY - GROUP_GAP);

  const svg = svgEl('svg', { class: 'uml-svg' });
  const defs = svgEl('defs');
  for (const fresh of ['', '-fresh']) {
    const tri = svgEl('marker', { id: `uml-triangle${fresh}`, viewBox: '0 0 12 12', refX: 11, refY: 6, markerWidth: 12, markerHeight: 12, orient: 'auto-start-reverse', markerUnits: 'userSpaceOnUse' });
    tri.appendChild(svgEl('path', { d: 'M1,1 L11,6 L1,11 Z', class: `uml-marker-triangle${fresh}` }));
    const arrow = svgEl('marker', { id: `uml-arrow${fresh}`, viewBox: '0 0 12 12', refX: 11, refY: 6, markerWidth: 14, markerHeight: 14, orient: 'auto-start-reverse', markerUnits: 'userSpaceOnUse' });
    arrow.appendChild(svgEl('path', { d: 'M1,1 L11,6 L1,11', class: `uml-marker-arrow${fresh}` }));
    defs.append(tri, arrow);
  }
  svg.appendChild(defs);
  const world = svgEl('g', { class: 'uml-world' });
  svg.appendChild(world);

  // The namespace boxes, their parts and their folder cards, behind
  // everything else. A namespace's or folder's name (▾) collapses it into
  // one box (▸); clicking it again opens it.
  const groupLayer = svgEl('g', { class: 'uml-groups' });
  for (const g of groups.values()) {
    const box = svgEl('g', { class: 'uml-group', transform: `translate(${g.x},${g.y})` });
    box.appendChild(svgEl('rect', { width: g.w, height: g.h, rx: 14 }));
    const title = svgEl('text', { class: 'uml-toggle', x: 14, y: 20, 'data-toggle': `ns:${g.id}` }, `${g.collapsed ? '▸' : '▾'} ${fitLabel(g.id, g.w - 44)}`);
    box.appendChild(title);
    box.appendChild(svgEl('title', {}, `namespace ${g.id}\n${g.collapsed ? 'Click its name to open it' : 'Click its name to collapse it'}`));
    groupLayer.appendChild(box);
    for (const part of g.parts) {
      if (g.several) {
        const p = svgEl('g', { class: `uml-part${part.key === 'shared' ? ' shared' : ''}`, transform: `translate(${part.ax},${part.ay})` });
        p.appendChild(svgEl('rect', { width: part.w, height: part.h, rx: 12 }));
        p.appendChild(svgEl('text', { x: 12, y: 16 }, fitLabel(part.label, part.w - 24)));
        p.appendChild(svgEl('title', {}, part.key === 'shared' ? 'Types that no composer of this namespace wires, or several do' : `What ${part.label} wires`));
        groupLayer.appendChild(p);
      }
      for (const card of part.cards) {
        const c = svgEl('g', { class: `uml-card${card.collapsed ? ' collapsed' : ''}`, transform: `translate(${card.ax},${card.ay})` });
        c.appendChild(svgEl('rect', { width: card.w, height: card.h, rx: 10 }));
        c.appendChild(svgEl('text', { class: 'uml-toggle', x: 10, y: 16, 'data-toggle': card.key }, `${card.collapsed ? '▸' : '▾'} ${fitLabel(card.folder, card.w - 30)}`));
        c.appendChild(svgEl('title', {}, `folder ${card.folder}\n${card.collapsed ? 'Click its name to open it' : 'Click its name to collapse it'}`));
        groupLayer.appendChild(c);
      }
    }
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
  // The "uses" arrows flow (styles.css, uml-flow). Each flowing arrow is
  // drawn again every frame, so in a large diagram only the arrows of the box
  // you point at flow: 280 flowing arrows took the frame rate from 170 to 52.
  // A large diagram also draws its arrows solid (dashes cost two to three
  // times as much to draw); the arrowheads still tell "uses" from
  // "implements", and the arrows you light up are dashed and flow.
  const FLOW_LIMIT = 40;
  const flowing = edges.filter(e => e.kind === 'uses').length <= FLOW_LIMIT;
  const edgeLayer = svgEl('g', { class: flowing ? 'uml-edges flow' : 'uml-edges' });
  // A large diagram: pointing at a box changes only what it is linked to
  // (see pointerover), so the window does not draw everything again.
  if (!flowing) svg.classList.add('large');
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
    const role = (b.composer ? ' composer' : b.facade ? ' facade' : n.proxy ? ' proxy' : '') + (b.bar ? ' facade-bar' : '') + (b.pair ? ' paired' : '');
    const g = svgEl('g', { class: `uml-node status-${n.status} kind-${n.kind}${role}`, transform: `translate(${b.x},${b.y})`, 'data-id': n.id });
    if (b.fuse) {
      // Square on top, rounded like its container at the bottom corners.
      const { r, left, right } = b.fuse;
      const rl = left ? r : 0;
      const rr = right ? r : 0;
      g.appendChild(svgEl('path', { class: 'uml-box', d: `M0,0 H${b.w} V${b.h - rr} Q${b.w},${b.h} ${b.w - rr},${b.h} H${rl} Q0,${b.h} 0,${b.h - rl} Z` }));
    } else {
      g.appendChild(svgEl('rect', { class: 'uml-box', width: b.w, height: b.h, rx: b.composer ? 10 : 8 }));
    }
    g.appendChild(svgEl('rect', { class: 'uml-band', width: 4, height: b.h - 12 - (b.pair ? IFACE_H : 0), x: 6, y: 6 + (b.pair ? IFACE_H : 0), rx: 2 }));
    if (b.composer) {
      g.appendChild(svgEl('text', { class: 'uml-name', x: b.w / 2 + 3, y: b.h / 2 + 4.5, transform: `rotate(-90 ${b.w / 2 + 3} ${b.h / 2})` }, composerLabel(b)));
    } else {
      // A name longer than the widest box (340px) is squeezed to fit inside it.
      const room = b.w - 26;
      const squeeze = textWidth(b.name, UML_FONT) > room ? { textLength: room, lengthAdjust: 'spacingAndGlyphs' } : {};
      // A paired interface: a strip across the top, clickable for its own diff.
      const top = b.pair ? IFACE_H : 0;
      if (b.pair) {
        const p = b.pair;
        const ig = svgEl('g', { class: `uml-node uml-inner uml-iface status-${p.status} kind-interface`, 'data-id': p.id });
        ig.appendChild(svgEl('rect', { class: 'uml-iface-box', x: 1, y: 1, width: b.w - 2, height: IFACE_H - 1, rx: b.fuse ? 0 : 7 }));
        ig.appendChild(svgEl('text', { class: 'uml-name uml-iface-name', x: b.w / 2 + 3, y: IFACE_H / 2 + 5 }, p.name + (p.generic || '')));
        ig.appendChild(svgEl('title', {}, `interface ${p.namespace ? p.namespace + '.' : ''}${p.name}, implemented by ${n.name} only\nClick to open its diff`));
        g.appendChild(ig);
        g.appendChild(svgEl('line', { class: 'uml-iface-line', x1: 0, x2: b.w, y1: IFACE_H, y2: IFACE_H }));
      }
      // With nested types, the name sits at the top and they go under it.
      const nameY = top + (b.inner?.length ? 22 : (b.h - top) / 2 + 4.5);
      g.appendChild(svgEl('text', { class: 'uml-name', x: b.w / 2 + 3, y: nameY, ...squeeze }, b.name));
      (b.inner || []).forEach((c, i) => {
        const cw = b.w - 26;
        const cg = svgEl('g', { class: `uml-node uml-inner status-${c.status} kind-${c.kind}`, transform: `translate(16,${top + 34 + i * (INNER_H + INNER_GAP)})`, 'data-id': c.id });
        cg.appendChild(svgEl('rect', { class: 'uml-box', width: cw, height: INNER_H, rx: 6 }));
        cg.appendChild(svgEl('rect', { class: 'uml-band', width: 3, height: INNER_H - 10, x: 5, y: 5, rx: 1.5 }));
        cg.appendChild(svgEl('text', { class: 'uml-name uml-inner-name', x: cw / 2 + 2, y: INNER_H / 2 + 4 }, c.name + (c.generic || '')));
        cg.appendChild(svgEl('title', {}, `${KIND_WORDS[c.kind] || c.kind} ${n.name}.${c.name}, nested in ${n.name}\nClick to open the diff`));
        g.appendChild(cg);
      });
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
    if (n.proxy) {
      g.appendChild(svgEl('title', {}, `${n.count} changed type${n.count === 1 ? '' : 's'}, collapsed\nClick to open`));
      world.appendChild(g);
      continue;
    }
    g.appendChild(svgEl('title', {}, `${KIND_WORDS[n.kind] || n.kind} ${n.namespace ? n.namespace + '.' : ''}${b.name}${roleText}\n${words[n.status]} in this task${shown.length ? `\n\n${shown.join('\n')}` : ''}\n\n${n.file}\nClick to open the diff`));
    world.appendChild(g);
  }
  container.appendChild(svg);

  // ---------- moving around ----------
  const view = { x: 0, y: 0, k: 1 };
  const apply = () => world.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
  // While you drag or zoom, every frame redraws the whole diagram. Lines and
  // boxes are then drawn without smoothing (svg.moving, styles.css), which
  // brought a large diagram on a large window from 20 to 8 ms a frame; they
  // are smooth again a moment after it stops.
  let settle = 0;
  const moving = () => {
    svg.classList.add('moving');
    clearTimeout(settle);
    settle = setTimeout(() => { if (!drag?.moved) svg.classList.remove('moving'); }, 150);
  };
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
    drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, target: e.target.closest('.uml-node'), toggle: e.target.closest('[data-toggle]')?.dataset.toggle };
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
    moving();
    apply();
  });
  svg.addEventListener('pointerup', () => {
    const d = drag;
    drag = null;
    svg.classList.remove('dragging');
    moving();
    if (d && !d.moved && d.toggle) { onToggle?.(d.toggle); return; }
    // The diff opens at the type's first change; a collapsed box opens.
    if (d && !d.moved && d.target) {
      const node = (boxes.get(d.target.dataset.id) || innerBoxes.get(d.target.dataset.id)).node;
      if (node.proxy) { onToggle?.(node.proxy); return; }
      const first = node.members.filter(m => m.change).sort((a, b) => a.line - b.line)[0];
      onOpen?.(node, first?.line ?? node.line);
    }
  });
  svg.addEventListener('wheel', e => {
    if (!wheelZooms && !e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    moving();
    zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  // Pointing at a box lights up its arrows and the types at their other end.
  // A nested type's small box counts as its owner's box: its arrows are the owner's.
  svg.addEventListener('pointerover', e => {
    const node = e.target.closest('.uml-node:not(.uml-inner)');
    if (!node || drag) return;
    const id = node.dataset.id;
    const linked = new Set([id]);
    for (const g of edgeLayer.children) {
      const on = g.dataset.from === id || g.dataset.to === id;
      g.classList.toggle('lit', on);
      if (on) { linked.add(g.dataset.from); linked.add(g.dataset.to); }
    }
    // A small diagram fades everything else. A large one leaves the rest as it
    // is and outlines the linked boxes: fading every box and arrow made the
    // window draw the whole diagram again on each move of the pointer, and on
    // a large window it showed half-drawn frames (part faded, part not).
    if (svg.classList.contains('large')) {
      for (const g of world.querySelectorAll('.uml-node.linked')) if (!linked.has(g.dataset.id)) g.classList.remove('linked');
      for (const lid of linked) elementOf(lid)?.classList.add('linked');
      return;
    }
    for (const g of world.querySelectorAll('.uml-node:not(.uml-inner)')) g.classList.toggle('dim', !linked.has(g.dataset.id));
    edgeLayer.classList.add('focus');
  });
  svg.addEventListener('pointerout', e => {
    if (e.relatedTarget?.closest?.('.uml-node:not(.uml-inner)') === e.target.closest('.uml-node:not(.uml-inner)')) return;
    for (const g of world.querySelectorAll('.dim')) g.classList.remove('dim');
    for (const g of world.querySelectorAll('.uml-node.linked')) g.classList.remove('linked');
    for (const g of edgeLayer.querySelectorAll('.lit')) g.classList.remove('lit');
    edgeLayer.classList.remove('focus');
  });

  if (startView) {
    Object.assign(view, startView);
    apply();
  } else {
    requestAnimationFrame(() => fit({ readable: true }));
  }
  // The boxes in reading order (top to bottom, left to right), for stepping
  // from one type's diff to the next.
  const readingOrder = [...boxes.values()].filter(b => !b.node.proxy).sort((a, b) => a.y - b.y || a.x - b.x).map(b => b.id);
  const elementOf = id => world.querySelector(`.uml-node[data-id="${CSS.escape(id)}"]`);
  return { fit, zoom, svg, width: maxW, height: totalH, order: readingOrder, elementOf, view };
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
  let resizer = null;
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
    // The full file and side by side load after this, and switching views
    // changes the height: the box follows, up to the window's height.
    resizer?.disconnect();
    resizer = new ResizeObserver(() => {
      if (activeDetail?.box !== box || box.classList.contains('closing')) return;
      const r = target();
      if (Math.abs(r.height - box.offsetHeight) > 2) place(r);
    });
    resizer.observe(diff);
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
    resizer?.disconnect();
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
    api = drawUml(stage, model, { onOpen, wheelZooms: full, collapsed, onToggle: toggle, view: keepView });
    const kept = keepView;
    keepView = null;
    if (!full && !kept) {
      const scale = Math.min(1.15, (stage.clientWidth - 48) / Math.max(1, api.width));
      panel.style.height = `${Math.max(260, Math.round(api.height * scale + 90))}px`;
      requestAnimationFrame(() => api.fit());
    }
    return true;
  };
  // Collapsing a namespace or folder draws the diagram again, where you were.
  const collapsed = new Set();
  let keepView = null;
  const toggle = key => {
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
    window.uiSound?.('select');
    keepView = api ? { ...api.view } : null;
    stage.innerHTML = '';
    api = null;
    draw();
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
