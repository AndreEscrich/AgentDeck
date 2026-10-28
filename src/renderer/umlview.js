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
  // The greedy order can leave a heavy arrow pointing back (it takes the one
  // that uses most first, whatever that costs its neighbours). For small
  // graphs, polish it: move each one to where the fewest arrows, by weight,
  // point back, until nothing improves.
  const order = [...head, ...tail];
  if (order.length <= 60) {
    const w = (a, b) => weight.get(`${a}>${b}`) || 0;
    for (let pass = 0, better = true; better && pass < 20; pass++) {
      better = false;
      for (const id of [...order]) {
        const rest = order.filter(x => x !== id);
        // Placed first, every arrow into it points back; each one it passes
        // turns its arrow to that one back and the one from it forward.
        let cost = rest.reduce((sum, x) => sum + w(x, id), 0);
        let best = 0;
        let bestCost = cost;
        rest.forEach((x, i) => {
          cost += w(id, x) - w(x, id);
          if (cost < bestCost) { bestCost = cost; best = i + 1; }
        });
        const now = order.indexOf(id);
        let nowCost = 0;
        order.forEach((x, i) => { if (i < now) nowCost += w(id, x); else if (i > now) nowCost += w(x, id); });
        if (bestCost < nowCost) {
          rest.splice(best, 0, id);
          order.splice(0, order.length, ...rest);
          better = true;
        }
      }
    }
  }
  const position = new Map(order.map((id, i) => [id, i]));
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
  // Fewer crossings: each type moves toward the middle of its neighbours,
  // weighted by how many arrows join them (so what is most linked ends up
  // closest).
  const neighbours = new Map(ids.map(id => [id, []]));
  for (const e of edges) {
    const w = e.weight || 1;
    neighbours.get(e.from)?.push([e.to, w]);
    neighbours.get(e.to)?.push([e.from, w]);
  }
  for (let sweep = 0; sweep < 8; sweep++) {
    const order = new Map();
    filled.forEach(layer => layer.forEach((id, i) => order.set(id, i / Math.max(1, layer.length - 1))));
    const list = sweep % 2 ? [...filled].reverse() : filled;
    for (const layer of list) {
      const key = id => {
        let sum = 0;
        let total = 0;
        for (const [n, w] of neighbours.get(id)) if (order.has(n)) { sum += order.get(n) * w; total += w; }
        return total ? sum / total : order.get(id);
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

// The Unity package a file is in (com.company.name), or null: an embedded
// package (Packages/com.company.name/…) or one from the package cache
// (Library/PackageCache/com.company.name@version/…).
function packageOf(file) {
  const f = String(file || '');
  return /(?:^|[\\/])PackageCache[\\/]([^\\/@]+)/.exec(f)?.[1]
    || /(?:^|[\\/])Packages[\\/]([a-z0-9_-]+(?:\.[a-z0-9_-]+)+)[\\/]/i.exec(f)?.[1]
    || null;
}

// The one package all these node ids are in, or null (none, or several).
function onePackage(ids, pkgOf) {
  const set = new Set(ids.map(id => pkgOf.get(id) ?? null));
  return set.size === 1 ? [...set][0] : null;
}

// The tag on a package's container or card: a pill on its top edge, at the
// right, with a box icon and the package's name (fitted to the room there
// is). Returns the room it takes from the title.
function packageTag(parent, pkg, width, y, small = false) {
  const h = small ? 16 : 18;
  const label = fitLabel(pkg, Math.max(40, width * 0.55 - 40));
  const w = Math.round(textWidth(label, UML_SMALL) + (small ? 30 : 34));
  const x = width - w - 12;
  const tag = svgEl('g', { class: 'uml-pkg-tag', transform: `translate(${x},${y - h / 2})` });
  tag.appendChild(svgEl('rect', { width: w, height: h, rx: h / 2 }));
  // A small box (an open package), drawn with lines.
  const s = small ? 8 : 9;
  const ix = 8;
  const iy = (h - s) / 2;
  tag.appendChild(svgEl('path', { class: 'uml-pkg-icon', d: `M${ix},${iy + s * 0.3} L${ix + s / 2},${iy} L${ix + s},${iy + s * 0.3} V${iy + s} H${ix} Z M${ix},${iy + s * 0.3} H${ix + s} M${ix + s / 2},${iy} V${iy + s * 0.3}` }));
  tag.appendChild(svgEl('text', { x: ix + s + 6, y: h / 2 + 3.5 }, label));
  parent.appendChild(tag);
  return w + 16;
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

// collapsed: the keys of collapsed containers ("c:<composer id>" or
// "c:ns:<namespace>") and folders ("f:<container>|<part>|<folder>"); onToggle(key) runs when you click one's
// name or its box. view: where to look ({ x, y, k }) instead of fitting.
function drawUml(container, model, { onOpen, onToggle, collapsed = new Set(), view: startView = null, wheelZooms = false } = {}) {
  const nesting = nestTypes(model);
  model = nesting.model;

  // Each type's folder, relative to the folder all the changes share.
  const labelOf = folderLabels(model.nodes);
  const folderOf = new Map(model.nodes.map(n => [n.id, labelOf(n)]));

  // Containers: the system composers say what belongs together, so each
  // one is a container with the types it wires; namespaces are only labels.
  // A composer gathers the types of its namespace that its wiring reaches
  // first (it creates a factory, the factory a controller: the controller is
  // that composer's too), not through another composer; in a namespace with
  // one composer, all of them. A type no composer reaches goes with the
  // composer most of its folder is with. What is left, and namespaces
  // without a composer, get a container named after the namespace.
  // Composers talk to each other through facade interfaces, which form each
  // container's bottom edge.
  const nsKey = n => n.namespace || '(no namespace)';
  const containerOf = new Map();
  const composersIn = new Map();
  for (const n of model.nodes) {
    if (!isComposer(n)) continue;
    if (!composersIn.has(nsKey(n))) composersIn.set(nsKey(n), []);
    composersIn.get(nsKey(n)).push(n);
  }
  const nodeById = new Map(model.nodes.map(n => [n.id, n]));
  const usesOf = new Map();
  for (const e of model.edges) {
    if (!usesOf.has(e.from)) usesOf.set(e.from, []);
    usesOf.get(e.from).push(e.to);
  }
  for (const n of model.nodes) {
    const list = composersIn.get(nsKey(n)) || [];
    if (isComposer(n)) containerOf.set(n.id, n.id);
    else if (list.length === 1) containerOf.set(n.id, list[0].id);
  }
  for (const [ns, list] of composersIn) {
    if (list.length < 2) continue;
    // How many steps each composer needs to reach each type of its namespace.
    const steps = new Map();   // type id -> Map(composer id -> steps)
    for (const c of list) {
      const seen = new Map([[c.id, 0]]);
      const queue = [c.id];
      while (queue.length) {
        const id = queue.shift();
        for (const next of usesOf.get(id) || []) {
          const t = nodeById.get(next);
          if (!t || seen.has(next) || nsKey(t) !== ns || isComposer(t)) continue;
          seen.set(next, seen.get(id) + 1);
          queue.push(next);
          if (!steps.has(next)) steps.set(next, new Map());
          steps.get(next).set(c.id, seen.get(next));
        }
      }
    }
    const members = model.nodes.filter(n => nsKey(n) === ns && !isComposer(n));
    for (const n of members) {
      const by = steps.get(n.id);
      if (!by) continue;
      const nearest = Math.min(...by.values());
      const owners = [...by].filter(([, d]) => d === nearest).map(([cid]) => cid);
      if (owners.length === 1) containerOf.set(n.id, owners[0]);
    }
    // Not reached (or a tie): the composer most of its folder is with, or
    // else of the folder above it (UI/Views/Board/Components goes where
    // UI/Views/Board goes), and so on up.
    const reached = members.filter(m => containerOf.has(m.id)).map(m => ({ c: containerOf.get(m.id), folder: folderOf.get(m.id) }));
    for (const n of members) {
      if (containerOf.has(n.id)) continue;
      const path = folderOf.get(n.id).split('/');
      for (let len = path.length; len > 0 && !containerOf.has(n.id); len--) {
        const prefix = path.slice(0, len).join('/');
        const votes = new Map();
        for (const m of reached) {
          if (m.folder !== prefix && !m.folder.startsWith(`${prefix}/`)) continue;
          votes.set(m.c, (votes.get(m.c) || 0) + 1);
        }
        const best = [...votes].sort((x, y) => y[1] - x[1])[0];
        if (best) containerOf.set(n.id, best[0]);
      }
    }
  }
  for (const n of model.nodes) if (!containerOf.has(n.id)) containerOf.set(n.id, `ns:${nsKey(n)}`);

  // Cards: a card per folder to start with, then by dependency: a type
  // whose links (both ways, inside its container) are mostly with another
  // card's types moves to that card, so what depends on each other sits
  // together. A folder that hangs together keeps its card (staying counts a
  // little extra); composers and facades do not move or pull. A card is
  // named after the folder most of its types are from, with how many are
  // from others. (On a large branch this put about half again as many
  // arrows inside a card and made them a quarter shorter.)
  const homeFolder = new Map(folderOf);
  {
    const STAY = 0.3;
    const pulls = n => n && !isComposer(n) && !isFacade(n);
    const linksOf = new Map();
    const usesOf2 = new Map();   // id -> the ids it uses (in its container)
    const usedBy2 = new Map();   // id -> the ids that use it
    for (const e of model.edges) {
      const a = nodeById.get(e.from);
      const b = nodeById.get(e.to);
      // A package's types and the project's do not share a card (see packageOf).
      if (!pulls(a) || !pulls(b) || a === b || containerOf.get(a.id) !== containerOf.get(b.id) || packageOf(a.file) !== packageOf(b.file)) continue;
      for (const [x, y] of [[a.id, b.id], [b.id, a.id]]) {
        if (!linksOf.has(x)) linksOf.set(x, new Map());
        linksOf.get(x).set(y, (linksOf.get(x).get(y) || 0) + 1);
      }
      if (!usesOf2.has(a.id)) usesOf2.set(a.id, []);
      if (!usedBy2.has(b.id)) usedBy2.set(b.id, []);
      usesOf2.get(a.id).push(b.id);
      usedBy2.get(b.id).push(a.id);
    }
    // The cards must keep flowing downwards: a type does not move into a
    // card if that would make two cards use each other (some arrows would
    // then have to point up). cardUses: card -> Map(card -> arrows).
    const cardUses = new Map();
    const link = (from, to, d) => {
      if (from === to) return;
      if (!cardUses.has(from)) cardUses.set(from, new Map());
      const m = cardUses.get(from);
      const n = (m.get(to) || 0) + d;
      if (n > 0) m.set(to, n); else m.delete(to);
    };
    const place = (id, card, d) => {
      for (const x of usesOf2.get(id) || []) link(card, folderOf.get(x), d);
      for (const x of usedBy2.get(id) || []) link(folderOf.get(x), card, d);
    };
    for (const [from, list] of usesOf2) for (const to of list) link(folderOf.get(from), folderOf.get(to), 1);
    const reaches = (from, to) => {
      if (from === to) return true;
      const seen = new Set([from]);
      const queue = [from];
      while (queue.length) {
        for (const next of cardUses.get(queue.shift())?.keys() || []) {
          if (next === to) return true;
          if (!seen.has(next)) { seen.add(next); queue.push(next); }
        }
      }
      return false;
    };
    // Would id in card close a loop between cards (its own arrows taken out)?
    const loops = (id, card) => {
      for (const x of usesOf2.get(id) || []) { const c = folderOf.get(x); if (c !== card && reaches(c, card)) return true; }
      for (const x of usedBy2.get(id) || []) { const c = folderOf.get(x); if (c !== card && reaches(card, c)) return true; }
      return false;
    };
    // Moving a type to a card is worth its links into that card, less what
    // a card that big would be expected to get by chance (modularity, as in
    // the Louvain method's local moving): types join what they really work
    // with, and no card swallows everything. RESOLUTION above 1 favours
    // smaller cards.
    const RESOLUTION = 1;
    const byContainer = new Map();
    for (const id of linksOf.keys()) {
      const c = containerOf.get(id);
      if (!byContainer.has(c)) byContainer.set(c, []);
      byContainer.get(c).push(id);
    }
    for (const ids of byContainer.values()) {
      const degree = new Map(ids.map(id => [id, [...linksOf.get(id).values()].reduce((s, w) => s + w, 0)]));
      const total = [...degree.values()].reduce((s, d) => s + d, 0);
      if (!total) continue;
      const sizeOf = new Map();   // card -> sum of its types' degrees
      for (const id of ids) sizeOf.set(folderOf.get(id), (sizeOf.get(folderOf.get(id)) || 0) + degree.get(id));
      for (let round = 0; round < 12; round++) {
        let moved = false;
        for (const id of ids) {
          const k = degree.get(id);
          const mine = folderOf.get(id);
          sizeOf.set(mine, sizeOf.get(mine) - k);
          const into = new Map([[mine, 0]]);
          for (const [other, w] of linksOf.get(id)) into.set(folderOf.get(other), (into.get(folderOf.get(other)) || 0) + w);
          const gain = card => into.get(card) - RESOLUTION * (sizeOf.get(card) || 0) * k / total;
          let best = mine;
          let bestGain = gain(mine) + STAY;
          const candidates = [...into.keys()].filter(card => card !== mine && gain(card) > bestGain + 1e-9).sort((x, y) => gain(y) - gain(x));
          if (candidates.length) {
            place(id, mine, -1);
            best = candidates.find(card => !loops(id, card)) || mine;
            place(id, best, 1);
          }
          sizeOf.set(best, (sizeOf.get(best) || 0) + k);
          if (best !== mine) { folderOf.set(id, best); moved = true; }
        }
        if (!moved) break;
      }
    }
  }
  // One part per container (parts were a namespace's composers).
  const comp = new Map(model.nodes.map(n => [n.id, 'main']));
  // Collapsed namespaces and folders: their types become one box, and their
  // arrows go to that box. hiddenIn: type id -> the key of the collapsed box
  // it is in (for the search, which opens that box to show the type).
  const hiddenIn = new Map();
  {
    const proxyOf = new Map();
    const proxies = new Map();
    for (const n of model.nodes) {
      const box = containerOf.get(n.id);
      const folderKey = `f:${box}|${comp.get(n.id)}|${folderOf.get(n.id)}`;
      let key = null;
      let label = null;
      if (collapsed.has(`c:${box}`)) {
        key = `c:${box}`;
        const owner = nodeById.get(box);
        label = owner ? owner.name : nsKey(n).split('.').pop();
      }
      else if (!isComposer(n) && collapsed.has(folderKey)) { key = folderKey; label = folderOf.get(n.id).split('/').pop(); }
      if (!key) continue;
      proxyOf.set(n.id, key);
      hiddenIn.set(n.id, key);
      if (!proxies.has(key)) {
        proxies.set(key, {
          id: `proxy:${key}`, name: label, kind: 'collapsed', namespace: n.namespace, folder: n.folder, file: '', line: 0,
          members: [], proxy: key, count: 0, statuses: new Set(),
          comp: key.startsWith('c:') ? 'main' : comp.get(n.id), folderLabel: key.startsWith('c:') ? '' : folderOf.get(n.id), container: box,
        });
      }
      const p = proxies.get(key);
      p.packages = (p.packages || new Set()).add(packageOf(n.file));
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
  // take a row each; a number: at most that many levels share a row.
  const levelRows = (items, uses, width, gap, { merge = false } = {}) => {
    const byId = new Map(items.map(it => [it.id, it]));
    const levels = layout(items, uses, { maxLength: Infinity, sizeOf: () => 1, gap: 0 }).reverse();
    const levelOf = new Map();
    levels.forEach((level, i) => level.forEach(id => levelOf.set(id, i)));
    // A level that wraps: what the levels below use most goes last, right
    // above them, and what only uses the levels above goes first (the model
    // right above the UI that uses it, not a side module in between).
    const up = new Map();
    const down = new Map();
    for (const e of uses) {
      const lf = levelOf.get(e.from);
      const lt = levelOf.get(e.to);
      if (lf == null || lt == null || lf === lt) continue;
      const w = e.weight || 1;
      if (lf > lt) { up.set(e.from, (up.get(e.from) || 0) + w); down.set(e.to, (down.get(e.to) || 0) + w); }
    }
    const lean = id => { const u = up.get(id) || 0; const d = down.get(id) || 0; return (d - u) / (d + u || 1); };
    const rows = [];
    let row = [];
    let used = 0;
    let levelsInRow = 0;
    for (const level of levels) {
      const levelW = level.reduce((sum, id) => sum + byId.get(id).w, 0) + gap * 2 * level.length;
      if (row.length && !(merge && levelsInRow < (merge === true ? Infinity : merge) && used + levelW <= width)) { rows.push(row); row = []; used = 0; levelsInRow = 0; }
      levelsInRow++;
      const fits = levelW - gap * level.length <= width - used;
      // (By the side it leans to only: within a side, the order the layout
      // found, with what is most linked side by side, stays.)
      const ordered = fits ? level : [...level].sort((a, b) => Math.sign(lean(a)) - Math.sign(lean(b)));
      // This level's rows; a small one that does not fit where it would go
      // fills a gap in one of them before starting a row of its own.
      const own = [];
      for (const id of ordered) {
        const it = byId.get(id);
        if (row.length && used + gap + it.w > width) {
          const room = own.find(r => r.w + gap + it.w <= width);
          if (room) { room.row.push(it); room.w += gap + it.w; continue; }
          rows.push(row); row = []; used = 0; levelsInRow = 1;
        }
        used += (row.length ? gap : 0) + it.w;
        row.push(it);
        if (!own.length || own[own.length - 1].row !== row) own.push({ row, w: used });
        else own[own.length - 1].w = used;
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

  // The package of each box (a collapsed box: the one package of its types).
  const pkgOf = new Map(model.nodes.map(n => [n.id, n.proxy ? (n.packages?.size === 1 ? [...n.packages][0] : null) : packageOf(n.file)]));

  // One container per system composer (see containerOf), or per namespace
  // for what no composer wires; in it a card per folder. A container says
  // its composer and, small under it, the namespaces of its types.
  const groups = new Map();
  for (const n of model.nodes) {
    const key = n.proxy && n.container ? n.container : containerOf.get(n.id) || `ns:${nsKey(n)}`;
    if (!groups.has(key)) {
      const owner = nodeById.get(key);
      groups.set(key, { id: key, ids: [], label: owner ? owner.name : key.slice(3), namespaces: new Set() });
    }
    groups.get(key).ids.push(n.id);
    if (!n.proxy || n.proxy.startsWith('f:')) groups.get(key).namespaces.add(nsKey(n));
  }
  for (const g of groups.values()) {
    g.package = onePackage(g.ids, pkgOf);
    g.collapsed = collapsed.has(`c:${g.id}`);
    g.sub = nodeById.get(g.id) ? [...g.namespaces].join(' · ') : '';
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
        // Named after the folder most of its types are from (see the cards'
        // grouping above), with how many are from other folders.
        const homes = new Map();
        for (const b of list) { const f = homeFolder.get(b.id) ?? folder; homes.set(f, (homes.get(f) || 0) + 1); }
        const ranked = [...homes].sort((a, b) => b[1] - a[1]);
        const main = ranked[0]?.[0] ?? folder;
        const others = list.length - (ranked[0]?.[1] || 0);
        const label = others ? `${main} +${others}` : main;
        const title = others ? `Types that work together, from ${ranked.map(([f, n]) => `${f} (${n})`).join(', ')}` : `folder ${main}`;
        return { key, folder, main, others, label, title, ids: list.map(b => b.id), w: innerW + CARD_PAD * 2, h: y + CARD_PAD, collapsed: list.length === 1 && list[0].node.proxy === key };
      });
      // Card names from the folder the container's cards share (Board/Queue,
      // not Assets/Code/MergeDiggingSideBoard/Board/Queue); the tooltip has it all.
      const shared = part.cards.length > 1 ? part.cards.map(c => String(c.main).split('/')).reduce((p, parts) => {
        let i = 0;
        while (i < p.length && i < parts.length - 1 && p[i] === parts[i]) i++;
        return p.slice(0, i);
      }) : [];
      if (shared.length) {
        for (const card of part.cards) {
          const rest = String(card.main).split('/').slice(shared.length).join('/') || shared[shared.length - 1];
          card.label = card.others ? `${rest} +${card.others}` : rest;
        }
      }
      // The cards, by dependency between their types; the entry row above them.
      const left = part.composer ? COMPOSER_W + COMPOSER_GAP : 0;
      const top = several ? COMP_LABEL : 0;
      const cardOf = new Map();
      for (const card of part.cards) { card.id = card.key; for (const cid of card.ids) cardOf.set(cid, card.key); }
      const packed = placeRows(levelRows(part.cards, usesBetween(id => cardOf.get(id)), maxWidth - PAD * 2 - left - (several ? CARD_PAD * 2 : 0), CARD_GAP), CARD_GAP, CARD_GAP + 12);
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
    const packed = placeRows(levelRows(partList, usesBetween(partOf), maxWidth - PAD * 2, COMP_GAP), COMP_GAP, COMP_GAP + 12);
    g.parts = partList;
    g.several = several;
    g.inner = { width: Math.max(packed.w, Math.min(textWidth(g.label, UML_SMALL) + (g.sub ? textWidth(g.sub, UML_SMALL) + 16 : 0) + 40, 480)), height: packed.h };
    g.w = g.inner.width + PAD * 2;
    g.h = g.inner.height + TITLE + PAD;
  }

  // The containers under each other, one below those it uses. What a
  // composer wires says it best: the facades it is given come from
  // containers above it, and an interface of its own that it needs and
  // another container implements (the model's client dependencies) makes
  // that container one it uses too; handing such an implementation over is
  // not using. Other types a composer takes from elsewhere (a config) count
  // less than a facade, and the arrows between the types least: they only
  // settle what the composers leave open.
  const FACADE_WEIGHT = 50;
  const WIRED_WEIGHT = 10;
  const groupOfId = new Map();
  for (const g of groups.values()) for (const id of g.ids) groupOfId.set(id, g.id);
  const groupOf = id => groupOfId.get(id) || containerOf.get(id);
  const implementersOf = new Map();
  for (const e of model.edges) {
    if (e.kind !== 'implements') continue;
    if (!implementersOf.has(e.to)) implementersOf.set(e.to, []);
    implementersOf.get(e.to).push(e.from);
  }
  const groupEdges = new Map();
  const link = (from, to, weight) => {
    if (!from || !to || from === to) return;
    // Weighted by how many arrows it stands for: when two containers use
    // each other, the direction with more arrows wins (91 against 1, not a tie).
    const k = `${from}>${to}`;
    if (!groupEdges.has(k)) groupEdges.set(k, { from, to, weight: 0 });
    groupEdges.get(k).weight += weight;
  };
  for (const e of model.edges) {
    const a = groupOf(e.from);
    const b = groupOf(e.to);
    if (!boxes.get(e.from)?.composer) { link(a, b, 1); continue; }
    const implementers = (implementersOf.get(e.to) || []).map(groupOf);
    if (a === b) { for (const g of implementers) link(a, g, FACADE_WEIGHT); continue; }
    if (implementers.includes(a)) continue;
    link(a, b, boxes.get(e.to)?.facade ? FACADE_WEIGHT : WIRED_WEIGHT);
  }
  // A domain is what its namespaces are named after (Client.X, TactileModules.X
  // and Client.X.Editor are all X). Each domain is a stack of its own: one
  // row per level, a container that uses another always below it, however
  // tall that makes the diagram, so the dependencies run straight down
  // (folder cards and composer parts too). The domains are placed the
  // same way, so another feature's containers stand beside a domain instead
  // of in the middle of it.
  const domainOf = g => {
    const ns = nodeById.get(g.id) ? nsKey(nodeById.get(g.id)) : g.id.slice(3);
    const parts = ns.split('.');
    return parts.length > 1 ? parts[1] : parts[0];
  };
  const rowLimit = Math.max(maxWidth, ...[...groups.values()].map(g => g.w));
  const domains = new Map();
  for (const g of groups.values()) {
    const d = domainOf(g);
    if (!domains.has(d)) domains.set(d, { id: d, groups: [] });
    domains.get(d).groups.push(g);
  }
  const domainEdges = new Map();
  for (const e of groupEdges.values()) {
    const da = domainOf(groups.get(e.from));
    const db = domainOf(groups.get(e.to));
    if (da === db) continue;
    const k = `${da}>${db}`;
    if (!domainEdges.has(k)) domainEdges.set(k, { from: da, to: db, weight: 0 });
    domainEdges.get(k).weight += e.weight;
  }
  for (const d of domains.values()) {
    const ids = new Set(d.groups.map(g => g.id));
    const inside = [...groupEdges.values()].filter(e => ids.has(e.from) && ids.has(e.to));
    d.rows = levelRows(d.groups, inside, rowLimit, GROUP_GAP);
    const size = placeRows(d.rows, GROUP_GAP, GROUP_GAP);
    d.w = size.w;
    d.h = size.h;
  }
  const domainList = [...domains.values()];
  const domainRows = levelRows(domainList, [...domainEdges.values()], Math.max(rowLimit, ...domainList.map(d => d.w)) + maxWidth, GROUP_GAP * 2);
  const placed = placeRows(domainRows, GROUP_GAP * 2, GROUP_GAP * 2);
  for (const d of domainList) for (const g of d.groups) { g.x += d.x; g.y += d.y; }
  const groupOrder = domainRows.flat().flatMap(d => d.rows.flat()).map(g => g.id);
  const maxW = placed.w;
  const groupY = placed.h + GROUP_GAP;
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
    // A container of a package's types looks different (blue, dashed, with
    // the package's name in a tag on its top edge), so code from packages
    // stands apart from the project's own.
    const box = svgEl('g', { class: `uml-group${g.package ? ' package' : ''}`, transform: `translate(${g.x},${g.y})` });
    box.appendChild(svgEl('rect', { width: g.w, height: g.h, rx: 14 }));
    const tagW = g.package ? packageTag(box, g.package, g.w, 0) : 0;
    const name = fitLabel(g.label, g.w - 44 - tagW);
    const title = svgEl('text', { class: 'uml-toggle', x: 14, y: 20, 'data-toggle': `c:${g.id}` }, `${g.collapsed ? '▸' : '▾'} ${name}`);
    // The namespaces of what it wires, small after its name (the name is
    // bold: about a fifth wider than measured).
    const room = g.w - 44 - tagW - textWidth(name, UML_SMALL) * 1.2 - 12;
    if (g.sub && room > 40) title.appendChild(svgEl('tspan', { class: 'uml-group-sub', dx: 10 }, fitLabel(g.sub, room)));
    box.appendChild(title);
    const what = (nodeById.get(g.id) ? `${g.label}: what it wires (${[...g.namespaces].join(', ')})` : `namespace ${g.label}`)
      + (g.package ? `\nFrom the package ${g.package}` : '');
    box.appendChild(svgEl('title', {}, `${what}\n${g.collapsed ? 'Click its name to open it' : 'Click its name to collapse it'}`));
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
        // A folder of a package in a container that is not all that
        // package's: the card gets the package look and tag instead.
        const pkg = !g.package && onePackage(card.ids, pkgOf);
        const c = svgEl('g', { class: `uml-card${card.collapsed ? ' collapsed' : ''}${pkg ? ' package' : ''}`, transform: `translate(${card.ax},${card.ay})` });
        c.appendChild(svgEl('rect', { width: card.w, height: card.h, rx: 10 }));
        const cardTag = pkg ? packageTag(c, pkg, card.w, 0, true) : 0;
        // In a package, the folder inside it (the tag names the package).
        const inPkg = pkg || g.package;
        let cardName = card.label || card.folder;
        if (inPkg) {
          const at = cardName.indexOf(inPkg);
          if (at >= 0) cardName = cardName.slice(at + inPkg.length).replace(/^@[^/]*/, '').replace(/^\//, '') || inPkg;
        }
        c.appendChild(svgEl('text', { class: 'uml-toggle', x: 10, y: 16, 'data-toggle': card.key }, `${card.collapsed ? '▸' : '▾'} ${fitLabel(cardName, card.w - 30 - cardTag)}`));
        c.appendChild(svgEl('title', {}, `${card.title || `folder ${card.folder}`}${pkg ? `\nFrom the package ${pkg}` : ''}\n${card.collapsed ? 'Click its name to open it' : 'Click its name to collapse it'}`));
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
  // A nested type is in a collapsed box when its owner is.
  const ownerOf = new Map();
  for (const [owner, list] of nesting.owners) for (const n of list) ownerOf.set(n.id, owner);
  const collapsedKeyOf = id => hiddenIn.get(ownerOf.get(id) || id) || null;
  // Moves the view (in about a quarter of a second) so the type's box is in
  // the middle, at a size where its name can be read, and outlines the box
  // for a moment.
  let glide = 0;
  const showType = id => {
    const g = elementOf(id);
    if (!g) return false;
    const r = g.getBoundingClientRect();
    const s = svg.getBoundingClientRect();
    const wx = (r.left + r.width / 2 - s.left - view.x) / view.k;
    const wy = (r.top + r.height / 2 - s.top - view.y) / view.k;
    const k = Math.max(view.k, 1);
    const to = { x: s.width / 2 - wx * k, y: s.height / 2 - wy * k, k };
    const from = { ...view };
    const start = performance.now();
    cancelAnimationFrame(glide);
    const step = now => {
      const t = Math.min(1, (now - start) / 260);
      const e = 1 - (1 - t) ** 3;
      for (const key of ['x', 'y', 'k']) view[key] = from[key] + (to[key] - from[key]) * e;
      apply();
      if (t < 1) glide = requestAnimationFrame(step);
    };
    moving();
    glide = requestAnimationFrame(step);
    for (const old of world.querySelectorAll('.uml-node.found')) old.classList.remove('found');
    g.classList.remove('found');
    void g.getBBox();
    g.classList.add('found');
    setTimeout(() => g.classList.remove('found'), 2400);
    return true;
  };
  return { fit, zoom, svg, width: maxW, height: totalH, order: readingOrder, elementOf, view, collapsedKeyOf, showType };
}

// The legend under the diagram. packages: some types are from a package.
function umlLegend(packages = false) {
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
  if (packages) item('package', 'From a package');
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

// follow(id): goes to another type of the diagram (a click on its name in
// the code, see linkTypes).
// next(id): opens the next type not reviewed yet (after the Reviewed button).
function openDetail(panel, api, model, node, line, { files, comments, follow = null, next = null }) {
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
    // Reviewed: the type's file counts as reviewed (the same tick as in the
    // Files list), and the next type you have not reviewed opens.
    const done = el('button', 'uml-detail-reviewed');
    done.type = 'button';
    const drawDone = () => {
      const on = !!file && reviewedSet().has(reviewKey(file));
      done.classList.toggle('on', on);
      done.textContent = on ? 'Reviewed ✓' : 'Mark reviewed';
      done.title = on ? 'Reviewed (click to undo)' : 'Mark this type as reviewed and go to the next one';
    };
    drawDone();
    done.onclick = () => {
      if (!file) return;
      const on = !reviewedSet().has(reviewKey(file));
      setReviewed(file, on);
      drawDone();
      window.uiSound?.('tick');
      if (on && next) {
        const id = n.id;
        close();
        setTimeout(() => { if (!next(id)) window.uiSound?.('done'); }, 220);
      }
    };
    head.append(step('‹', 'Previous type (←)', -1), step('›', 'Next type (→)', 1), text, send, done, back);
    if (!file) {
      body.appendChild(el('div', 'uml-detail-empty', 'No diff for this type.'));
      return;
    }
    // Changes, Full file or Side by side (see fileViews in diffview.js).
    const views = fileViews(file, comments?.cwd, () => (comments ? comments.diff(file, { maxLines: 20000 }) : renderDiff(file, { maxLines: 20000 })), comments);
    const diff = views;
    body.appendChild(diff);
    if (follow) linkTypes(body, model, n);
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
  // The names of the diagram's other types in the code are links (linkTypes):
  // a click goes there instead of commenting on the line. The Full file and
  // Side by side views come later, and get their links when they do.
  if (follow) {
    body.addEventListener('click', e => {
      const ref = e.target.closest('.uml-ref');
      if (!ref) return;
      e.preventDefault();
      e.stopPropagation();
      follow(ref.dataset.id);
    }, true);
    const later = new MutationObserver(() => linkTypes(body, model, current));
    later.observe(body, { childList: true, subtree: true });
  }
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

// In a type's code: each name of another type of the diagram becomes a link
// to it (a click goes there, see follow in umlPanel). A name two types share
// goes to the one in the same namespace as the type on screen.
function linkTypes(root, model, current) {
  const byName = new Map();
  for (const n of model.nodes) {
    if (n.id === current.id || n.name === current.name) continue;
    const had = byName.get(n.name);
    if (!had || (n.namespace === current.namespace && had.namespace !== current.namespace)) byName.set(n.name, n);
  }
  if (!byName.size) return;
  const names = [...byName.keys()].sort((a, b) => b.length - a.length).map(x => x.replace(/[^\w]/g, ''));
  const re = new RegExp(`\\b(${names.join('|')})\\b`, 'g');
  for (const code of root.querySelectorAll('.code:not([data-refs])')) {
    code.dataset.refs = '1';
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    for (const t of texts) {
      re.lastIndex = 0;
      if (!re.test(t.data)) continue;
      re.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0;
      for (const m of t.data.matchAll(re)) {
        const node = byName.get(m[1]);
        frag.append(t.data.slice(last, m.index));
        const ref = el('span', `uml-ref status-${node.status}`, m[1]);
        ref.dataset.id = node.id;
        ref.title = `Go to ${node.name}${node.namespace ? ` (${node.namespace})` : ''}`;
        frag.append(ref);
        last = m.index + m[0].length;
      }
      frag.append(t.data.slice(last));
      t.replaceWith(frag);
    }
  }
}

// How much of each type changed, from 0 to 1: its file's changed lines,
// shared out among the file's types by how many of their members changed,
// against the type that changed most.
function changeHeat(model, files) {
  const lines = new Map(files.map(f => { const s = fileStats(f); return [f.path, s.add + s.del]; }));
  const perFile = new Map();
  for (const n of model.nodes) if (lines.has(n.file)) perFile.set(n.file, [...(perFile.get(n.file) || []), n]);
  const raw = new Map();
  for (const [file, nodes] of perFile) {
    const weights = nodes.map(n => n.members.filter(m => m.change).length || 1);
    const sum = weights.reduce((a, b) => a + b, 0);
    nodes.forEach((n, i) => raw.set(n.id, lines.get(file) * weights[i] / sum));
  }
  const max = Math.max(1, ...raw.values());
  return new Map([...raw].map(([id, v]) => [id, Math.sqrt(v / max)]));
}

// Draws a lens's marks on a type's box: its heat tint, a check when it is
// reviewed, and the review peer's mark.
function decorateNode(g, { heat, done, mark }) {
  const box = g.querySelector(':scope > .uml-box');
  if (!box) return;
  let w;
  let h;
  try { ({ width: w, height: h } = box.getBBox()); } catch { return; }
  let tint = g.querySelector(':scope > .uml-heat');
  if (heat != null) {
    if (!tint) { tint = box.cloneNode(); tint.setAttribute('class', 'uml-heat'); box.after(tint); }
    tint.style.fillOpacity = (0.06 + heat * 0.62).toFixed(2);
  } else tint?.remove();
  let check = g.querySelector(':scope > .uml-check');
  if (done && !check) {
    check = svgEl('text', { class: 'uml-check', x: w - 8, y: h - 7, 'text-anchor': 'end' });
    check.textContent = '✓';
    g.appendChild(check);
  } else if (!done) check?.remove();
  let pin = g.querySelector(':scope > .uml-mark');
  if (mark && !pin) {
    pin = svgEl('g', { class: 'uml-mark', transform: `translate(${w - 2},2)` });
    pin.append(svgEl('circle', { r: 9 }), Object.assign(svgEl('text', { y: 4, 'text-anchor': 'middle' }), { textContent: '!' }));
    const tip = svgEl('title', {});
    pin.appendChild(tip);
    g.appendChild(pin);
  }
  if (mark && pin) pin.querySelector('title').textContent = `Review peer: ${mark.text}\n(click to see the answer)`;
  if (!mark) pin?.remove();
}

// A diagram with its buttons, for the Changes card or the full window.
// Returns the element. files: the card's files, for the diffs of the boxes;
// comments: the card's line comments (see lineComments in diffview.js).
function umlPanel(fullModel, { files = [], comments = null, onFull = null, full = false } = {}) {
  const model = changedModel(fullModel);
  const panel = el('div', `uml-panel${full ? ' full' : ' wide'}`);
  const onOpen = (node, line) => {
    if (api && files.some(f => f.path === node.file)) openDetail(panel, api, model, node, line, { files, comments, follow, next: id => panel.nextUnreviewed?.(id) });
  };
  // A link in a type's diff to another type of the diagram: the diff goes
  // back into its box, the diagram moves to the other type, and its diff
  // opens out of its box.
  const follow = id => {
    const node = model.nodes.find(n => n.id === id);
    if (!node) return;
    activeDetail?.close();
    setTimeout(() => {
      reveal(id);
      const first = node.members.filter(m => m.change).sort((a, b) => a.line - b.line)[0];
      setTimeout(() => onOpen(node, first?.line ?? node.line), 380);
    }, 200);
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
  panel.append(stage, tools, umlLegend(model.nodes.some(n => packageOf(n.file))));
  let api = null;
  button('−', 'Zoom out', () => api?.zoom(1 / 1.25));
  button('+', 'Zoom in', () => api?.zoom(1.25));
  button('Fit', 'Show the whole diagram', () => api?.fit());
  if (onFull) button('⤢', 'Open in the whole window', onFull);
  // Moves the diagram to a type (a search, a link in a type's diff).
  const reveal = id => {
    // A type in a collapsed namespace or folder: open that box first.
    const key = api?.collapsedKeyOf(id);
    if (key) {
      collapsed.delete(key);
      keepView = { ...api.view };
      stage.innerHTML = '';
      api = null;
      draw();
    }
    window.uiSound?.('select');
    api?.showType(id);
  };
  tools.prepend(typeSearch(model, reveal));
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
  // The whole diagram in the panel as it is now (after its size changed).
  panel.fit = () => api?.fit();

  // ---------- lenses ----------
  // Ways to look at the same diagram, drawn over the boxes the diagram has:
  //   Before / After: before, the new types and dependencies are gone and the
  //     changes lose their colour (what the code was like)
  //   Heat: each box tinted by how many lines its file changed (shared out
  //     among the types of that file by their changed members)
  //   review progress: a type whose file you marked reviewed is greyed out
  //     with a check; "Next unreviewed" opens the next one in reading order
  //   peer marks: the types the review peer talked about (setPeerMarks)
  //   playback: an agent's tasks one by one (setPlayback, its Changes card)
  const byId = new Map(model.nodes.map(n => [n.id, n]));
  const heat = changeHeat(model, files);
  const lens = { before: false, heat: false, play: null, marks: new Map(), onMark: null };
  const fileFor = n => files.find(f => f.path === n.file);
  const reviewable = () => (api?.order || model.nodes.map(n => n.id)).map(id => byId.get(id)).filter(n => n && fileFor(n));
  const isReviewed = (n, set) => { const f = fileFor(n); return !!f && set.has(reviewKey(f)); };
  const applyLens = () => {
    if (!api) return;
    const set = reviewedSet();
    for (const g of stage.querySelectorAll('.uml-node[data-id]')) {
      const n = byId.get(g.dataset.id);
      if (!n) continue;
      g.classList.toggle('lens-gone', lens.before && n.status === 'new');
      g.classList.toggle('lens-before', lens.before && n.status !== 'new');
      g.classList.toggle('lens-ghost', !!lens.play && !lens.play.show.has(n.id));
      g.classList.toggle('lens-focus', !!lens.play && lens.play.focus.has(n.id));
      const done = isReviewed(n, set);
      g.classList.toggle('reviewed', done);
      decorateNode(g, { heat: lens.heat ? heat.get(n.id) || 0 : null, done, mark: lens.marks.get(n.id) || null });
    }
    for (const e of stage.querySelectorAll('.uml-edge')) {
      const from = byId.get(e.dataset.from);
      const to = byId.get(e.dataset.to);
      e.classList.toggle('lens-gone', lens.before && (e.classList.contains('fresh') || from?.status === 'new' || to?.status === 'new'));
      e.classList.toggle('lens-ghost', !!lens.play && !(lens.play.show.has(e.dataset.from) && lens.play.show.has(e.dataset.to)));
    }
    const all = reviewable();
    const left = all.filter(n => !isReviewed(n, set));
    progress.textContent = all.length ? (left.length ? `${all.length - left.length} of ${all.length} reviewed` : `All ${all.length} reviewed ✓`) : '';
    progress.classList.toggle('done', all.length > 0 && !left.length);
    nextBtn.hidden = !left.length;
  };
  // Each drawing of the diagram (a collapsed group opened, a resize) gets the lenses again.
  new MutationObserver(() => requestAnimationFrame(applyLens)).observe(stage, { childList: true });
  const lensBar = el('div', 'uml-lens');
  const seg = el('div', 'uml-lens-seg');
  const beforeBtn = el('button', null, 'Before');
  const afterBtn = el('button', 'on', 'After');
  for (const b of [beforeBtn, afterBtn]) b.type = 'button';
  beforeBtn.title = 'The code as it was: without the new types and dependencies';
  afterBtn.title = 'The code with the change';
  const setBefore = on => {
    lens.before = on;
    beforeBtn.classList.toggle('on', on);
    afterBtn.classList.toggle('on', !on);
    window.uiSound?.('tick');
    applyLens();
  };
  beforeBtn.onclick = () => setBefore(true);
  afterBtn.onclick = () => setBefore(false);
  seg.append(beforeBtn, afterBtn);
  const heatBtn = el('button', 'uml-lens-heat', 'Heat');
  heatBtn.type = 'button';
  heatBtn.title = 'Tint each type by how much of it changed';
  heatBtn.onclick = () => { lens.heat = !lens.heat; heatBtn.classList.toggle('on', lens.heat); window.uiSound?.('tick'); applyLens(); };
  const progress = el('span', 'uml-lens-progress');
  const nextBtn = el('button', 'uml-lens-next', 'Next unreviewed ›');
  nextBtn.type = 'button';
  nextBtn.title = 'Open the next type you have not reviewed, in reading order';
  const openNextUnreviewed = (after = null) => {
    const set = reviewedSet();
    const list = reviewable().filter(n => !isReviewed(n, set) && n.id !== after);
    const next = list[0];
    if (!next) return false;
    reveal(next.id);
    const first = next.members.filter(m => m.change).sort((a, b) => a.line - b.line)[0];
    setTimeout(() => onOpen(next, first?.line ?? next.line), 320);
    return true;
  };
  nextBtn.onclick = () => openNextUnreviewed();
  const changesSomething = model.nodes.some(n => n.status === 'new') || model.edges.some(e => e.fresh);
  if (changesSomething) lensBar.appendChild(seg);
  lensBar.append(heatBtn, progress, nextBtn);
  panel.appendChild(lensBar);
  for (const type of ['pointerdown', 'wheel']) lensBar.addEventListener(type, e => e.stopPropagation());
  // A click on a peer mark shows what the peer said (not the type's diff).
  stage.addEventListener('pointerdown', e => {
    const mark = e.target.closest?.('.uml-mark');
    if (!mark) return;
    e.stopPropagation();
    e.preventDefault();
    lens.onMark?.(mark.closest('.uml-node')?.dataset.id);
  }, true);
  const onReviewed = () => { if (panel.isConnected) applyLens(); };
  window.addEventListener('reviewed-change', onReviewed);
  panel.nextUnreviewed = openNextUnreviewed;
  // marks: id -> { count, text }; onMark(id) when one is clicked.
  panel.setPeerMarks = (marks, onMark) => { lens.marks = marks; lens.onMark = onMark; applyLens(); };
  // play: { show: Set of ids, focus: Set of ids } or null for all.
  panel.setPlayback = play => { lens.play = play; applyLens(); };
  panel.model = model;
  return panel;
}

// The search box in the diagram's buttons: type part of a type's name and
// the types that match show under it (names that start with it first, then
// names that contain it, then names whose capitals spell it: "pvc" finds
// PlayerViewController). ↑ ↓ choose, Tab or Enter goes to the chosen one
// (Tab fills in its name), Esc empties the box. onPick(id) shows the type.
function typeSearch(model, onPick) {
  const wrap = el('div', 'uml-search');
  const input = el('input');
  input.type = 'search';
  input.placeholder = 'Find a class…';
  input.spellcheck = false;
  input.title = 'Type part of a class name · Tab or Enter goes to it';
  const list = el('div', 'uml-search-list');
  wrap.append(input, list);
  const types = model.nodes.map(n => ({ id: n.id, name: n.name, lower: n.name.toLowerCase(), caps: n.name.replace(/[^A-Z0-9]/g, '').toLowerCase(), node: n }));
  let found = [];
  let chosen = 0;
  const KINDS = { class: 'C', interface: 'I', struct: 'S', enum: 'E', record: 'R' };
  const match = text => {
    const q = text.trim().toLowerCase();
    if (!q) return [];
    const rank = t => (t.lower.startsWith(q) ? 0 : t.lower.includes(q) ? 1 : t.caps.startsWith(q) ? 2 : -1);
    return types.map(t => ({ t, r: rank(t) })).filter(x => x.r >= 0)
      .sort((a, b) => a.r - b.r || a.t.name.length - b.t.name.length || a.t.name.localeCompare(b.t.name))
      .slice(0, 8).map(x => x.t);
  };
  const render = () => {
    list.innerHTML = '';
    wrap.classList.toggle('open', found.length > 0 || !!input.value.trim());
    if (!found.length && input.value.trim()) list.appendChild(el('div', 'uml-search-none', 'No class with that name in this diagram'));
    found.forEach((t, i) => {
      const row = el('div', `uml-search-item status-${t.node.status}${i === chosen ? ' active' : ''}`);
      row.append(el('span', 'uml-search-kind', KINDS[t.node.kind] || '·'), el('span', 'uml-search-name', t.name),
        el('span', 'uml-search-ns', t.node.namespace || ''));
      row.title = `${t.node.namespace ? `${t.node.namespace}.` : ''}${t.name}\n${t.node.file}`;
      row.onpointerdown = e => { e.preventDefault(); chosen = i; pick(); };
      list.appendChild(row);
    });
  };
  const pick = () => {
    const t = found[chosen];
    if (!t) return;
    input.value = t.name;
    onPick(t.id);
    found = match(input.value);
    chosen = Math.max(0, found.findIndex(x => x.id === t.id));
    render();
  };
  input.addEventListener('input', () => { found = match(input.value); chosen = 0; render(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!found.length) return;
      e.preventDefault();
      chosen = (chosen + (e.key === 'ArrowDown' ? 1 : -1) + found.length) % found.length;
      render();
    } else if ((e.key === 'Tab' && !e.shiftKey) || e.key === 'Enter') {
      if (!found.length) return;
      // Not for the app's Tab (the next agent to check) or Enter.
      e.preventDefault();
      e.stopPropagation();
      pick();
    } else if (e.key === 'Escape' && input.value) {
      // Esc empties the box; with nothing in it, Esc closes the diagram as before.
      e.preventDefault();
      e.stopPropagation();
      input.value = '';
      found = [];
      render();
    }
  });
  input.addEventListener('blur', () => wrap.classList.remove('open'));
  input.addEventListener('focus', () => { found = match(input.value); render(); });
  // Keys and clicks in the box are not for the diagram.
  for (const type of ['pointerdown', 'wheel']) wrap.addEventListener(type, e => e.stopPropagation());
  return wrap;
}

// The diagram in the whole window, over the chat (Esc closes it).
let umlFullEl = null;
function closeUmlFull() {
  if (activeDetail && umlFullEl?.contains(activeDetail.panel)) activeDetail.close(true);
  umlFullEl?.peer?.leave();
  umlFullEl?.remove();
  umlFullEl = null;
}

function openUmlFull(model, { title, ...options }) {
  closeUmlFull();
  umlFullEl = el('div', 'uml-full');
  umlFullEl.tabIndex = -1;
  const bar = el('div', 'review-bar');
  const close = el('button', 'uml-full-close', 'Close (Esc)');
  close.onclick = closeUmlFull;
  bar.append(el('span', 'review-title', title), el('span', 'hint', 'Wheel to zoom · drag to move · click a box for its diff'));
  const body = el('div', 'uml-full-body');
  const diagram = umlPanel(model, { ...options, full: true });
  body.appendChild(diagram);
  // The review peer, for the card's files (see reviewPeer): a box at the
  // bottom right of the diagram until you ask it something, then a panel
  // beside it. Review peer in the title bar shows or hides that panel, once
  // there is a conversation.
  const cwd = options.comments?.cwd;
  if (cwd && options.files?.length && window.deck?.reviewAsk) {
    const toggle = el('button', 'uml-peer-toggle', 'Review peer');
    toggle.title = 'Show or hide the conversation with the review peer';
    const peer = reviewPeer(options.files, cwd, (open, talked) => {
      const was = body.classList.contains('peer-open');
      body.classList.toggle('peer-open', open);
      toggle.classList.toggle('active', open);
      toggle.hidden = !talked;
      if (was !== open) requestAnimationFrame(() => diagram.fit());
    });
    umlFullEl.peer = peer;
    body.appendChild(peer.el);
    // The types the peer talks about get its mark on their box (peerMarks).
    const mark = () => diagram.setPeerMarks?.(peerMarks(diagram.model, peer.answers()), id => peer.showAbout(diagram.model.nodes.find(n => n.id === id)?.name));
    peer.onAnswer(mark);
    mark();
    toggle.onclick = () => peer.toggle();
    bar.appendChild(toggle);
    peer.refresh();
  }
  bar.appendChild(close);
  umlFullEl.append(bar, body);
  document.getElementById('main').appendChild(umlFullEl);
  umlFullEl.focus();
}

// ---------- the review peer ----------

// The types of the diagram that the review peer's answers name: id ->
// { count, text } with the sentence of the latest answer that names it.
function peerMarks(model, answers) {
  const marks = new Map();
  if (!model) return marks;
  answers.forEach(text => {
    if (!text) return;
    for (const n of model.nodes) {
      const name = String(n.name || '').replace(/[^\w]/g, '');
      if (name.length < 3) continue;
      const re = new RegExp(`\\b${name}\\b`, 'g');
      const hits = text.match(re);
      if (!hits) continue;
      const sentence = text.split(/(?<=[.!?])\s+|\n+/).find(s => new RegExp(`\\b${name}\\b`).test(s)) || '';
      const before = marks.get(n.id);
      marks.set(n.id, { count: (before?.count || 0) + hits.length, text: sentence.replace(/[*`_]/g, '').trim().slice(0, 220) });
    }
  });
  return marks;
}

// A chat in the whole-window diagram with an agent that reviews the change
// with you (reviewpeer.js in the main process): it gets the diff of the
// card's files with your first question, and it can read and search the
// project, but not change it. Until you ask something it is only a box at the
// bottom right of the diagram, with the suggested questions above it (Alt+1–3
// asks one); the first question opens the conversation as a panel beside the
// diagram. × hides the panel again (back to the box), New empties it. The
// conversation belongs to the card (its files): closing the diagram and
// opening it again keeps it. The agent's process stops 10 minutes after you
// close the diagram; a question after that starts a new one, which gets the
// earlier questions and answers too. onLayout(open, talked) runs when the
// panel opens or closes; talked: there is a conversation.
const peerChats = new WeakMap();      // the card's files -> chat
const peerById = new Map();           // chat id -> chat
const PEER_IDLE_MS = 10 * 60 * 1000;
let peerListening = false;

function reviewPeer(files, cwd, onLayout) {
  if (!peerListening) {
    peerListening = true;
    window.deck.onReviewEvent((id, event) => peerById.get(id)?.onEvent(event));
  }
  let chat = peerChats.get(files);
  if (!chat) {
    chat = { id: null, alive: false, busy: false, turns: [], hidden: false, idle: 0 };
    peerChats.set(files, chat);
  }
  clearTimeout(chat.idle);
  const rel = p => {
    const s = String(p || '');
    return s === cwd ? '' : s.startsWith(`${cwd}/`) ? s.slice(cwd.length + 1) : s;
  };

  const root = el('aside', 'uml-peer');
  const head = el('div', 'uml-peer-head');
  const hide = el('button', 'uml-peer-hide', '×');
  hide.title = 'Hide the review peer';
  hide.onclick = () => { chat.hidden = true; layout(); };
  const clear = el('button', 'uml-peer-clear', 'New');
  clear.title = 'Start a new conversation';
  head.append(el('span', 'uml-peer-title', 'Review peer'), el('span', 'uml-peer-sub', `${files.length} file${files.length === 1 ? '' : 's'} · reads the project, cannot change it`), clear, hide);
  const log = el('div', 'uml-peer-log');
  const form = el('div', 'uml-peer-form');
  const input = el('textarea');
  input.rows = 2;
  input.placeholder = 'Ask a review peer about this change… (↩ to send)';
  input.title = 'An agent that reads the diff and the project with you (it cannot change files). ⇧↩ for a new line.';
  const sendBtn = el('button', 'uml-peer-send', 'Ask');
  form.append(input, sendBtn);

  const SUGGESTIONS = [
    'Review this change: what could break, and what did it miss?',
    'Explain how the changed types work together.',
    'Is anything here hard to test or likely to regress?',
  ];
  // The suggested questions, as the follow-ups under an agent's answer look
  // (a click or Alt+N asks it).
  const chips = el('div', 'followups uml-peer-chips');
  SUGGESTIONS.forEach((text, i) => {
    const chip = el('button', 'followup');
    chip.type = 'button';
    chip.title = `Ask it (Alt+${i + 1})`;
    chip.append(el('kbd', null, `Alt+${i + 1}`), el('span', null, text));
    chip.onclick = () => ask(text);
    chips.appendChild(chip);
  });
  root.append(head, log, chips, form);
  // The panel is open while there is a conversation you did not hide.
  const layout = () => {
    const open = chat.turns.length > 0 && !chat.hidden;
    root.classList.toggle('open', open);
    onLayout?.(open, chat.turns.length > 0);
  };
  const toolText = (name, i) => (name === 'Read' ? `Reading ${rel(i.file_path)}`
    : name === 'Grep' ? `Searching for “${i.pattern || ''}”${rel(i.path) ? ` in ${rel(i.path)}` : ''}`
      : name === 'Glob' ? `Looking for ${i.pattern || 'files'}` : name);

  // Draws one turn: the question, the steps, and the answer (as Markdown).
  const drawTurn = t => {
    const box = el('div', 'uml-peer-turn');
    box.appendChild(el('div', 'uml-peer-q', t.q));
    const steps = el('div', 'uml-peer-steps');
    const answer = el('div', 'uml-peer-a');
    box.append(steps, answer);
    t.draw = () => {
      steps.replaceChildren(...t.tools.slice(-4).map(x => el('div', 'uml-peer-step', x)));
      if (t.tools.length > 4) steps.prepend(el('div', 'uml-peer-step more', `${t.tools.length - 4} more`));
      const text = t.a || (t.error ? '' : chat.busy && t === chat.turns.at(-1) ? '' : '(no answer)');
      answer.replaceChildren(text ? markdown(text, cwd) : el('div', 'uml-peer-thinking', 'Thinking…'));
      if (t.error) answer.appendChild(el('div', 'uml-peer-error', t.error));
    };
    t.draw();
    return box;
  };
  const drawAll = () => {
    log.replaceChildren();
    for (const t of chat.turns) log.appendChild(drawTurn(t));
    log.scrollTop = log.scrollHeight;
  };
  const sync = () => {
    sendBtn.textContent = chat.busy ? 'Stop' : 'Ask';
    sendBtn.classList.toggle('stop', chat.busy);
    root.classList.toggle('busy', chat.busy);
  };

  // Redrawing the answer's Markdown at most once a frame while it streams.
  let frame = 0;
  const redraw = t => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const stuck = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      t.draw?.();
      if (stuck) log.scrollTop = log.scrollHeight;
    });
  };
  chat.onEvent = event => {
    const t = chat.turns.at(-1);
    if (!t) return;
    if (event.type === 'text') { t.a += event.text; redraw(t); }
    else if (event.type === 'tool') { t.tools.push(toolText(event.name, event.input || {})); redraw(t); }
    else if (event.type === 'done' || event.type === 'exit') {
      if (event.type === 'exit') chat.alive = false;
      if (event.error && chat.busy) t.error = event.error;
      if (chat.busy) window.uiSound?.(event.error ? 'error' : 'done');
      chat.busy = false;
      chat.onAnswer?.();
      sync();
      cancelAnimationFrame(frame);
      frame = 0;
      const stuck = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      t.draw?.();
      if (stuck) log.scrollTop = log.scrollHeight;
    }
  };

  async function ask(text) {
    const q = String(text || '').trim();
    if (!q || chat.busy) return;
    input.value = '';
    input.style.height = '';
    // A new process: it gets the earlier questions and answers with this one.
    let question = q;
    if (!chat.alive) {
      if (chat.id) peerById.delete(chat.id);
      chat.id = `peer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      peerById.set(chat.id, chat);
      const before = chat.turns.filter(t => t.a);
      if (before.length) question = `Earlier in this review:\n\n${before.map(t => `Q: ${t.q}\nA: ${t.a}`).join('\n\n')}\n\nNew question: ${q}`;
    }
    const turn = { q, a: '', tools: [], error: null };
    chat.turns.push(turn);
    chat.busy = true;
    chat.hidden = false;
    window.uiSound?.('sent');
    sync();
    drawAll();
    layout();
    input.focus();
    const diffs = chat.alive ? [] : files.map(f => ({ path: f.path, status: f.status, diff: (f.lines || []).map(l => l[1]).join('\n') }));
    const res = await window.deck.reviewAsk(chat.id, { cwd, question, files: diffs }).catch(e => ({ ok: false, error: e.message }));
    if (!res?.ok) {
      turn.error = res?.error || 'Could not ask the review peer';
      chat.busy = false;
      sync();
      turn.draw?.();
      return;
    }
    chat.alive = true;
  }

  sendBtn.onclick = () => (chat.busy ? window.deck.reviewInterrupt(chat.id) : ask(input.value));
  clear.onclick = () => {
    if (chat.id) window.deck.reviewClose(chat.id);
    if (chat.id) peerById.delete(chat.id);
    chat.id = null;
    chat.alive = false;
    chat.busy = false;
    chat.turns = [];
    sync();
    drawAll();
    layout();
    input.focus();
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      ask(input.value);
    }
  });
  // The box grows with what you type (up to its maximum height, styles.css).
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight + 2}px`;
  });
  // Keys and the wheel in the panel are not for the diagram.
  root.addEventListener('wheel', e => e.stopPropagation());

  sync();
  drawAll();
  const api = {
    el: root,
    focus: () => input.focus(),
    // n: 1 to 3, the suggested question to ask.
    suggest: n => { if (SUGGESTIONS[n - 1] && !chat.busy) ask(SUGGESTIONS[n - 1]); },
    toggle: () => { chat.hidden = !chat.hidden; layout(); if (!chat.hidden) input.focus(); },
    refresh: layout,
    // Asks a question (the review comments from a Changes card, see
    // askPeerAbout), opening the conversation.
    ask: text => { chat.hidden = false; ask(text); },
    // The answers so far, and fn() whenever one is finished (peer marks).
    answers: () => chat.turns.map(t => t.a || ''),
    onAnswer: fn => { chat.onAnswer = fn; },
    // Opens the conversation at the latest answer that names a type.
    showAbout: name => {
      chat.hidden = false;
      layout();
      const re = new RegExp(`\\b${String(name || '').replace(/[^\w]/g, '')}\\b`);
      const i = chat.turns.map(t => re.test(t.a || '')).lastIndexOf(true);
      const box = log.children[i];
      if (!box) return;
      box.scrollIntoView({ block: 'start', behavior: 'smooth' });
      box.classList.remove('flash');
      void box.offsetWidth;
      box.classList.add('flash');
    },
    // The diagram closed: the conversation stays; its process stops after a while.
    leave: () => {
      clearTimeout(chat.idle);
      chat.idle = setTimeout(() => {
        if (chat.busy || !chat.id) return;
        window.deck.reviewClose(chat.id);
        chat.alive = false;
      }, PEER_IDLE_MS);
    },
  };
  return api;
}

// Esc (or Alt+←) closes a type's diff first, then the full-window diagram; a
// review on top of them closes by itself first. ← → step through the types' diffs.
document.addEventListener('keydown', e => {
  // Keys in a comment box stay there (Esc cancels the comment).
  // (An empty class search box is not typing: Esc closes as usual.)
  const typing = e.target.closest?.('input, textarea, [contenteditable="true"]') && !(e.target.closest('.uml-search') && !e.target.value);
  if (typing && e.key === 'Escape') return;
  const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
  // Alt+1–3 asks the review peer's suggested question (instead of sending
  // the chat's follow-up behind the diagram).
  if (umlFullEl?.peer && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && /^Digit[1-3]$/.test(e.code)) {
    stop();
    umlFullEl.peer.suggest(Number(e.code.slice(5)));
    return;
  }
  // Ctrl+F (or ⌘F) in the whole-window diagram goes to its class search
  // (instead of the app's search of past agents); a type's diff open on it
  // closes first.
  if (umlFullEl && e.key.toLowerCase() === 'f' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
    const search = umlFullEl.querySelector('.uml-search input');
    if (search) {
      stop();
      if (activeDetail && umlFullEl.contains(activeDetail.panel)) activeDetail.close(true);
      search.focus();
      search.select();
      return;
    }
  }
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
