// Shared parts of the Tickets view (after tickets.js, before the panel):
//
// - tagClass(name): the colour of a [context] tag or an epic. The same name
//   gets the same colour everywhere, and an epic matches the context of the
//   same name (Expeditions and [Expedition] too: case, spaces and a final s
//   do not count).
// - morphOpen(el, from) / morphClose(el, from): a window grows out of what
//   was clicked (a ticket's row, a button), like an agent's tile grows into
//   its chat, and shrinks back into it.
// - dropdown(...): the view's dropdowns. A button with the choice; its menu
//   always opens downwards, scrolls when long, and has a search box on top
//   when there are many choices (Enter picks the first one left, ↑ ↓ move).

const TAG_COLORS = 12;
function tagKey(name) {
  return String(name || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').replace(/s$/, '');
}
function tagClass(name) {
  let h = 0;
  for (const c of tagKey(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 'c' + (h % TAG_COLORS);
}
// An epic as a coloured tag (⚑ and its name).
function epicTag(name, cls = '') {
  const t = el('span', `ticket-tag epic-tag ${tagClass(name)} ${cls}`.trim());
  t.append(el('span', 'epic-tag-flag', '⚑'), el('span', null, name));
  return t;
}
// A round dot in an epic's colour (in menus).
function epicDot(name) {
  return el('span', `tag-dot ${tagClass(name)}`);
}

// The keys that leave an agent (app.js): Esc, Alt+← (like a browser's back;
// not while typing, where it moves by a word) and Ctrl+[ (⌘[ on a Mac).
function isBackKey(e) {
  if (e.key === 'Escape') return true;
  if ((e.ctrlKey || e.metaKey) && e.key === '[') return true;
  const typing = e.target?.closest?.('input, textarea, [contenteditable="true"]');
  return e.key === 'ArrowLeft' && e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey && !typing;
}

// ---------- growing out of what was clicked ----------

// The last thing pressed, so a window that opens because of it can grow out
// of it: the row, list item or button around where the pointer went down.
const pressed = { el: null, at: 0 };
document.addEventListener('pointerdown', e => {
  // A ticket's whole row first (a click on its key or title is the row),
  // then a link or a button on its own.
  const t = e.target.closest?.('tr.tickets-row, .plan-table tbody tr, .tp-sub, .tickets-notif, .tp-epic-tasks > *')
    || e.target.closest?.('a, button, [data-key], tr');
  pressed.el = t || null;
  pressed.at = Date.now();
}, true);
function lastPressed(ms = 900) {
  const r = pressed.el?.isConnected && Date.now() - pressed.at < ms ? pressed.el : null;
  return r && visibleRect(r) ? r : null;
}
function visibleRect(elm) {
  const r = elm.getBoundingClientRect();
  if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return null;
  return r;
}

// The movement of an agent's tile opening into its chat (hub.js open and
// returnTo): 420ms on the same curve; the window shows within its first 12%
// and, going back, goes in its last 15%.
//
// A box (a copy of what was clicked) goes from where that is to where the
// window ends, flying to it while it grows; the window rides inside it the
// whole way: as wide as the box (its content scaled, never squashed) and cut
// to its height, so nothing ever shows outside the box. The frames are
// sampled along the curve, so box and window move as one.
const MORPH = { duration: 420, easing: 'cubic-bezier(.35,0,.15,1)' };
const MORPH_STEPS = 16;
function cubicBezier(x1, y1, x2, y2) {
  const at = (t, a, b) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  return x => {
    let lo = 0, hi = 1;
    for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (at(m, x1, x2) < x) lo = m; else hi = m; }
    return at((lo + hi) / 2, y1, y2);
  };
}
const morphEase = cubicBezier(0.35, 0, 0.15, 1);

// Frames for the window (el) and the box, from the box `from` (p = 0) to
// the window's own place (p = 1). show(p): the window's opacity.
function morphFrames(elm, from, show) {
  const to = elm.getBoundingClientRect();
  if (!to.width || !to.height) return null;
  const tf = getComputedStyle(elm).transform;
  const m = new DOMMatrix(tf === 'none' ? undefined : tf);
  const win = [], box = [];
  for (let i = 0; i <= MORPH_STEPS; i++) {
    const t = i / MORPH_STEPS;
    const p = morphEase(t);
    const L = from.left + (to.left - from.left) * p;
    const T = from.top + (to.top - from.top) * p;
    const W = from.width + (to.width - from.width) * p;
    const H = from.height + (to.height - from.height) * p;
    const sc = Math.max(0.01, W / to.width);
    const tx = L - to.left + (1 - sc) * m.e;
    const ty = T - to.top + (1 - sc) * m.f;
    const cut = Math.max(0, to.height - H / sc);
    const r = 10 + 2 * p;
    win.push({ offset: t, translate: `${tx}px ${ty}px`, scale: `${sc}`, clipPath: `inset(0px 0px ${cut}px 0px round ${r / sc}px)`, opacity: show(t) });
    box.push({ offset: t, left: L + 'px', top: T + 'px', width: W + 'px', height: H + 'px', borderRadius: r + 'px' });
  }
  return { win, box };
}
// The box, under the window (just before it, on the same layer): a copy
// of what was clicked, with its content, like the copy of an agent's tile
// (hub.js tileCopy). The real one is hidden meanwhile, as the tile is.
function morphGhost(source, over) {
  const g = el('div', 'ticket-morph-ghost');
  const ocs = getComputedStyle(over);
  let z = parseInt(ocs.zIndex, 10);
  if (Number.isNaN(z)) {
    if (ocs.position === 'static') over.style.position = 'relative';
    over.style.zIndex = z = 2;
  }
  g.style.zIndex = z;
  const inner = el('div', 'ticket-morph-inner');
  if (source instanceof Element) {
    // Its background: its own, or the first one around it.
    for (let p = source; p && p !== document.body; p = p.parentElement) {
      const bg = getComputedStyle(p).backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') { g.style.background = bg; break; }
    }
    inner.append(copyOf(source));
  }
  g.append(inner);
  over.before(g);
  if (source instanceof Element) source.classList.add('morph-away');
  return { g, inner, restore: () => source instanceof Element && source.classList.remove('morph-away') };
}
// A copy that looks like the original where it stands: a table row goes in
// a table of its own, with its cells as wide as the real ones.
function copyOf(source) {
  if (source.tagName === 'TR') {
    const real = source.closest('table');
    const table = document.createElement('table');
    table.className = real?.className || '';
    Object.assign(table.style, { width: source.getBoundingClientRect().width + 'px', margin: '0' });
    const row = source.cloneNode(true);
    [...row.children].forEach((td, i) => { td.style.width = source.children[i]?.getBoundingClientRect().width + 'px'; });
    const body = document.createElement('tbody');
    body.append(row);
    table.append(body);
    // Inside the pane it sits in (its styles depend on it), when it has one.
    const pane = source.closest('.plan-pane');
    if (!pane) return table;
    const wrap = el('div', pane.className);
    Object.assign(wrap.style, { border: 'none', background: 'none', boxShadow: 'none', borderRadius: '0' });
    wrap.append(table);
    return wrap;
  }
  const c = source.cloneNode(true);
  Object.assign(c.style, { width: source.getBoundingClientRect().width + 'px', height: source.getBoundingClientRect().height + 'px', margin: '0' });
  return c;
}
const LINEAR = { duration: MORPH.duration, easing: 'linear' };
// An animation that is over, or that cannot run (a hidden window does not
// move them on), a little after it should have ended.
const endOf = a => Promise.race([a.finished.catch(() => {}), new Promise(r => setTimeout(r, MORPH.duration + 200))]);
function morphOpen(elm, from, { backdrop = null } = {}) {
  if (document.hidden) return null;
  const rect = from instanceof Element ? visibleRect(from) : from;
  if (!rect) return null;
  const f = morphFrames(elm, rect, t => Math.min(1, t / 0.12));
  if (!f) return null;
  elm.style.transformOrigin = '0 0';
  const ghost = morphGhost(from, elm);
  const run = elm.animate(f.win, LINEAR);
  ghost.g.animate(f.box, { ...LINEAR, fill: 'forwards' });
  // Its content goes at once, as a tile's text does (hub.js: 100ms).
  ghost.inner.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 100, fill: 'forwards' });
  backdrop?.animate([{ opacity: 0 }, { opacity: 1 }], MORPH);
  endOf(run).then(() => { run.cancel(); elm.style.transformOrigin = ''; ghost.g.remove(); ghost.restore(); });
  return run;
}
// The way back: into `from` (if it is still on screen). Resolves when it
// is done (at once when there is nothing to go into).
function morphClose(elm, from, { backdrop = null } = {}) {
  if (document.hidden) return Promise.resolve();
  const rect = from instanceof Element ? (from.isConnected ? visibleRect(from) : null) : from;
  // Played backwards: t = 1 is the start. The window goes in the last 15%.
  const f = rect && morphFrames(elm, rect, t => Math.min(1, t / 0.15));
  if (!f) return Promise.resolve();
  elm.style.transformOrigin = '0 0';
  elm.style.pointerEvents = 'none';
  const back = list => list.map(k => ({ ...k, offset: 1 - k.offset })).reverse();
  const ghost = morphGhost(from, elm);
  const a = elm.animate(back(f.win), { ...LINEAR, fill: 'forwards' });
  ghost.g.animate(back(f.box), { ...LINEAR, fill: 'forwards' });
  // Its content comes back near the end, as a tile's text does (hub.js: from 75%).
  ghost.inner.animate([{ opacity: 0 }, { opacity: 0, offset: 0.75 }, { opacity: 1 }], { duration: MORPH.duration, fill: 'forwards' });
  backdrop?.animate([{ opacity: 1 }, { opacity: 0 }], { ...MORPH, fill: 'forwards' });
  return endOf(a).then(() => {
    // The real one takes its place (hub.js: the tile fades in as its copy fades out).
    ghost.restore();
    from.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: 'ease-out' });
    ghost.g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 320, easing: 'ease-in', fill: 'forwards' });
    setTimeout(() => ghost.g.remove(), 360);
    return { done: () => { a.cancel(); elm.style.transformOrigin = ''; elm.style.pointerEvents = ''; backdrop?.getAnimations().forEach(x => x.cancel()); } };
  });
}

// ---------- dropdowns ----------

(() => {
  const P = TicketsView.prototype;

  // A menu of choices (from openMenu). choices: [{ value, label, group,
  // tip, icon: () => element, line: true (a line before it) }].
  P.fillChoiceMenu = function (menu, { choices, value, onPick, search = choices.length > 8, placeholder = 'Search…' }) {
    menu.replaceChildren();
    menu.classList.add('pick-menu');
    const list = el('div', 'pick-list');
    const items = [];
    let group = null;
    for (const c of choices) {
      if (c.line) list.append(el('div', 'pick-line'));
      if (c.group && c.group !== group) { group = c.group; list.append(el('div', 'tickets-status-group', c.group)); }
      const b = el('button', 'tickets-status-item pick-item' + (c.value === value ? ' on' : ''));
      b.type = 'button';
      if (c.icon) b.append(c.icon());
      b.append(el('span', 'pick-label' + (c.faint ? ' tp-faint' : ''), c.label));
      if (c.tip) b.title = c.tip;
      b.onmousedown = e => e.preventDefault();   // a field being typed in keeps the focus
      b.onclick = () => { this.closeStatusMenu(); onPick(c.value); };
      list.append(b);
      items.push({ el: b, text: `${c.label} ${c.group || ''} ${c.tip || ''}`.toLowerCase() });
    }
    if (!items.length) list.append(el('div', 'gallery-note', 'Nothing to pick.'));
    if (!search) { menu.append(list); return; }
    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'tp-epic-search pick-search';
    input.placeholder = placeholder;
    menu.append(input, list);
    let shown = items, at = -1;
    const mark = () => {
      items.forEach(i => i.el.classList.remove('focus'));
      shown[at]?.el.classList.add('focus');
      shown[at]?.el.scrollIntoView({ block: 'nearest' });
    };
    input.oninput = () => {
      const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      shown = items.filter(i => words.every(w => i.text.includes(w)));
      for (const i of items) i.el.classList.toggle('hidden', !shown.includes(i));
      // Headings and lines only over choices that still show.
      for (const h of list.querySelectorAll('.tickets-status-group, .pick-line')) h.classList.toggle('hidden', !!words.length);
      at = words.length && shown.length ? 0 : -1;
      mark();
    };
    input.onkeydown = e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); at = Math.min(shown.length - 1, at + 1); mark(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); at = Math.max(0, at - 1); mark(); }
      if (e.key === 'Enter') { e.preventDefault(); (shown[at] || shown[0])?.el.click(); }
    };
    requestAnimationFrame(() => input.focus());
  };

  // A dropdown: a button with the choice (its icon, its label, ▾). none: the
  // label of the empty choice ('' value; false for none), first; apart: a
  // line after it. onPick(value) gets null for the empty choice.
  P.dropdown = function ({ value, choices, onPick, none = false, apart = false, key, search, placeholder, cls = '', prefix = null, title = '' }) {
    const all = [...(none !== false ? [{ value: '', label: none, faint: true }] : []),
      ...choices.map((c, i) => ({ ...c, line: c.line || (apart && none !== false && i === 0) }))];
    const current = all.find(c => c.value === (value ?? '')) || all.find(c => c.value === '') || null;
    const b = el('button', `tp-select tp-select-button pick-button ${cls}`.trim());
    b.type = 'button';
    if (prefix) b.append(prefix);
    if (current?.icon) b.append(current.icon());
    b.append(el('span', 'pick-current' + (current && current.value !== '' ? '' : ' tp-faint'), current?.label ?? '—'), el('span', 'tp-prio-caret', '▾'));
    b.title = title || current?.tip || '';
    const id = key || 'pick:' + Math.random().toString(36).slice(2);
    b.onclick = () => this.openMenu(b, id, menu => this.fillChoiceMenu(menu, { choices: all, value: current?.value, onPick: v => onPick(v === '' ? null : v), search, placeholder }));
    return b;
  };
})();
