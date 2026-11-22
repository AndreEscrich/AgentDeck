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

// The keyframes that take el (where it is now, transformed or not) from a
// small copy of itself sitting in the middle of the box `from` (fitted in
// it, like an agent's chat starts as a thumbnail inside its tile) to
// itself: on the way it flies to its place while it grows. Uses the
// translate and scale properties, so el's own transform (translateX(-50%))
// stays as it is.
function morphFrames(elm, from) {
  const to = elm.getBoundingClientRect();
  if (!to.width || !to.height) return null;
  const m = new DOMMatrix(getComputedStyle(elm).transform === 'none' ? undefined : getComputedStyle(elm).transform);
  const s = Math.min(1, Math.max(0.12, Math.min(from.width / to.width, from.height / to.height)));
  // Its top left corner when centred on from.
  const left = from.left + from.width / 2 - (to.width * s) / 2;
  const top = from.top + from.height / 2 - (to.height * s) / 2;
  const tx = left - to.left + (1 - s) * m.e;
  const ty = top - to.top + (1 - s) * m.f;
  return [
    { translate: `${tx}px ${ty}px`, scale: `${s}`, clipPath: `inset(0px 0px 0px 0px round ${12 / s}px)`, opacity: 0 },
    { opacity: 1, offset: 0.12 },
    { translate: '0px 0px', scale: '1', clipPath: 'inset(0px 0px 0px 0px round 12px)', opacity: 1 },
  ];
}
// The same movement as an agent's tile opening into its chat (hub.js open
// and returnTo): 420ms on the same curve; the window shows within its first
// 12% and, going back, goes in its last 15%. Meanwhile a copy of what was
// clicked (its box) stretches over the window and fades, like the tile's copy.
const MORPH = { duration: 420, easing: 'cubic-bezier(.35,0,.15,1)' };
// Under the window it grows into (just before it, on the same layer).
function morphGhost(source, rect, over) {
  const g = el('div', 'ticket-morph-ghost');
  const ocs = getComputedStyle(over);
  let z = parseInt(ocs.zIndex, 10);
  if (Number.isNaN(z)) {
    if (ocs.position === 'static') over.style.position = 'relative';
    over.style.zIndex = z = 2;
  }
  g.style.zIndex = z;
  const cs = source instanceof Element ? getComputedStyle(source) : null;
  Object.assign(g.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px' });
  if (cs && cs.backgroundColor !== 'rgba(0, 0, 0, 0)') g.style.background = cs.backgroundColor;
  over.before(g);
  return g;
}
function coverOf(from, to) {
  return `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width}, ${to.height / from.height})`;
}
function morphOpen(elm, from, { backdrop = null } = {}) {
  const rect = from instanceof Element ? visibleRect(from) : from;
  if (!rect) return null;
  const frames = morphFrames(elm, rect);
  if (!frames) return null;
  const to = elm.getBoundingClientRect();
  elm.style.transformOrigin = '0 0';
  const ghost = morphGhost(from, rect, elm);
  const runs = [
    elm.animate(frames, MORPH),
    ghost.animate([{ transform: 'none', opacity: 1 }, { opacity: 1, offset: 0.8 }, { transform: coverOf(rect, to), opacity: 0 }], { ...MORPH, fill: 'forwards' }),
    backdrop?.animate([{ opacity: 0 }, { opacity: 1 }], MORPH),
  ];
  runs[0].finished.catch(() => {}).then(() => { elm.style.transformOrigin = ''; ghost.remove(); });
  return runs[0];
}
// The way back: shrinks into `from` (if it is still on screen). Resolves
// when it is done (at once when there is nothing to shrink into).
function morphClose(elm, from, { backdrop = null } = {}) {
  const rect = from instanceof Element ? (from.isConnected ? visibleRect(from) : null) : from;
  const frames = rect && morphFrames(elm, rect);
  if (!frames) return Promise.resolve();
  const to = elm.getBoundingClientRect();
  elm.style.transformOrigin = '0 0';
  elm.style.pointerEvents = 'none';
  const back = [frames[2], { opacity: 1, offset: 0.85 }, frames[0]];
  const ghost = morphGhost(from, rect, elm);
  const a = elm.animate(back, { ...MORPH, fill: 'forwards' });
  ghost.animate([{ transform: coverOf(rect, to), opacity: 0 }, { opacity: 1, offset: 0.2 }, { transform: 'none', opacity: 1 }], { ...MORPH, fill: 'forwards' });
  backdrop?.animate([{ opacity: 1 }, { opacity: 0 }], { ...MORPH, fill: 'forwards' });
  return a.finished.catch(() => {}).then(() => {
    // The ghost goes as the real row shows under it.
    ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' }).finished.catch(() => {}).then(() => ghost.remove());
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
