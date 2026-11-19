// The Tickets view (the ticket button on the Hub's left side): your Tactile
// PM tickets. It talks to PM with the app's own sign-in (src/pmclient.js),
// so it costs no tokens. Until you connect, it shows a Connect button that
// opens PM's sign-in page in your browser.
//
// Your tickets as a table like PM's sheet (key, type, title, status, epic,
// sprint; a click on a column's name sorts by it), in two lists: This
// sprint (yours in the open sprints, done ones too) and All open (yours
// that are not done). Keys show without the project's prefix, after the
// type's mark. A click on a key opens the ticket's details in a floating
// panel in the middle of the view, like PM's: its description, its subtasks and Start
// agent, which puts the ticket's link on the Hub's message box (a Story
// with two or more open subtasks then gets the ⑂ Split button). A click
// anywhere else on a Story's row opens or closes its subtasks as rows below
// it, like PM's sheet.
// A click on a status opens the project's statuses; picking one changes the
// ticket or subtask in PM (pm_update_task / pm_update_subtask).
// The last lists are kept, so the view shows them at once and reads them
// again in the background.

const TICKET_LISTS = [['sprint', 'This sprint'], ['open', 'All open']];
const CATEGORY_ORDER = { todo: 0, in_progress: 1, done: 2 };
// The table's columns: [id, name, the value it sorts by].
const TICKET_COLUMNS = [
  ['key', 'Key', t => t.seq],
  ['title', 'Title', t => t.title.toLowerCase()],
  ['status', 'Status', t => `${CATEGORY_ORDER[t.category] ?? 1}${t.status}`],
  ['epic', 'Epic', t => t.epic.toLowerCase()],
  ['sprint', 'Sprint', t => t.sprint.toLowerCase()],
];
// The type's mark, like PM's: a green bookmark for a Story, a red dot for a
// Bug, a blue check for anything else.
const TYPE_ICONS = {
  story: '<svg width="14" height="14" viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4.5L6 21z" fill="#36b37e"/></svg>',
  bug: '<svg width="14" height="14" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="4" fill="#e5493a"/><circle cx="12" cy="12" r="4" fill="#fff"/></svg>',
  task: '<svg width="14" height="14" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="4" fill="#4c9aff"/><path d="M7.5 12.5l3 3 6-6.5" stroke="#fff" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  epic: '<svg width="14" height="14" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="4" fill="#8f7ee7"/><path d="M13 6l-5 7h4l-1 5 5-7h-4z" fill="#fff"/></svg>',
};
function typeIcon(type) {
  const span = el('span', 'tickets-type-icon');
  span.innerHTML = TYPE_ICONS[(type || '').toLowerCase()] || TYPE_ICONS.task;
  span.title = type || 'Task';
  return span;
}
const CHEVRON = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M3 1.5L6.5 5 3 8.5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SUBTASK_ICON = '<svg width="14" height="14" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="4" fill="#4c9aff"/><rect x="7" y="7" width="6" height="6" rx="1" fill="none" stroke="#fff" stroke-width="2"/><rect x="11" y="11" width="6" height="6" rx="1" fill="#fff"/></svg>';
// The key without the project's prefix (M2S-3612 shows as 3612).
const shortKey = key => String(key || '').replace(/^[A-Za-z][A-Za-z0-9]*-/, '');
const isStory = t => !t.subtask && /story/i.test(t.type || '');
const REFRESH_MS = 5 * 60 * 1000;

function pmItemUrl(key) { return 'https://pm.tactilews.com/pm/items/' + key; }

class TicketsView {
  // onStart(ticket): Start agent, for the Hub's message box.
  constructor({ onStart }) {
    this.onStart = onStart;
    this.view = el('div', 'view tickets-view hidden');
    $('views').appendChild(this.view);
    const bar = el('div', 'tickets-bar');
    this.tabs = el('div', 'tickets-tabs');
    for (const [id, label] of TICKET_LISTS) {
      const b = el('button', 'tickets-tab', label);
      b.type = 'button';
      b.dataset.list = id;
      b.onclick = () => { this.list = id; this.type = null; this.renderTabs(); this.show(); this.load(); };
      this.tabs.appendChild(b);
    }
    this.search = document.createElement('input');
    this.search.type = 'search';
    this.search.placeholder = 'Filter by key, title, epic or sprint…';
    this.search.className = 'tickets-search';
    this.search.oninput = () => this.renderList();
    this.types = el('div', 'gallery-cats tickets-types');
    this.when = el('span', 'tickets-when');
    const refresh = el('button', 'icon gallery-refresh', '↻');
    refresh.type = 'button';
    refresh.title = 'Read the tickets again';
    refresh.onclick = () => this.load(true);
    this.account = el('button', 'tickets-account');
    this.account.type = 'button';
    this.account.onclick = () => this.signOut();
    bar.append(this.tabs, this.search, this.types, this.when, refresh, this.account);
    const body = el('div', 'tickets-body');
    this.listBox = el('section', 'tickets-list scroll');
    this.detail = el('section', 'tickets-detail scroll');
    // Behind the details: dims the table, and a click on it closes them.
    this.backdrop = el('div', 'tickets-backdrop');
    this.backdrop.onclick = () => this.closeDetail();
    body.append(this.listBox, this.backdrop, this.detail);
    this.view.append(bar, body);
    this.list = 'sprint';
    this.type = null;
    this.sort = { col: 'key', desc: true };
    this.data = {};      // list -> { items, total, at }
    this.selected = null;
    this.detailTicket = null;  // the ticket the details show
    this.expanded = new Set(); // Stories whose subtasks show below them
    this.subs = new Map();     // key -> { items, loading, error }
    this.statusLists = new Map(); // project -> its statuses
    this.loading = new Set();
    this.connected = null;
    try { this.data = JSON.parse(localStorage.getItem('pmTicketLists') || '{}'); } catch { this.data = {}; }
    this.renderTabs();
    this.showDetailEmpty();
    // Escape closes the floating details (and the status menu first).
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || this.menu || this.view.classList.contains('hidden') || !this.view.classList.contains('detail-open')) return;
      if (document.querySelector('.lightbox, .gallery-preview')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.closeDetail();
    }, true);
  }

  async open() {
    const st = await window.deck.pmStatus().catch(() => ({ connected: false }));
    this.setConnected(st);
    if (!st.connected) return;
    this.show();
    const d = this.data[this.list];
    if (!d || Date.now() - d.at > 60 * 1000) this.load();
    clearInterval(this.timer);
    this.timer = setInterval(() => { if (!this.view.classList.contains('hidden')) this.load(); }, REFRESH_MS);
    requestAnimationFrame(() => this.search.focus());
  }

  setConnected(st) {
    this.connected = !!st.connected;
    this.view.classList.toggle('signed-out', !this.connected);
    this.account.textContent = st.email ? `${st.email} · Sign out` : 'Sign out';
    this.account.title = 'Sign Agent Hub out of Tactile PM (your agents keep their connector)';
    if (!this.connected) this.showConnect();
  }

  // Not connected: what the sign-in is, and Connect.
  showConnect(error) {
    clearInterval(this.timer);
    const box = el('div', 'tickets-connect');
    box.append(
      el('h3', null, 'Connect Agent Hub to Tactile PM'),
      el('p', null, 'Agent Hub signs in to PM by itself, so it can show your tickets fast and without using tokens. Connect opens PM\'s sign-in page in your browser; sign in there and come back.'),
      el('p', 'tickets-connect-small', 'This is separate from the PM connector your agents use: signing in or out here does not change it.'));
    if (error) box.append(el('p', 'tickets-error', error));
    const go = el('button', 'gallery-use', 'Connect');
    go.type = 'button';
    go.onclick = async () => {
      go.disabled = true;
      go.textContent = 'Waiting for the sign-in in your browser…';
      const r = await window.deck.pmConnect();
      if (r?.error) return this.showConnect(r.error);
      window.uiSound?.('open');
      this.setConnected(r);
      this.open();
    };
    box.append(go);
    this.listBox.replaceChildren(box);
    this.detail.replaceChildren();
  }

  async signOut() {
    this.setConnected(await window.deck.pmDisconnect());
  }

  renderTabs() {
    for (const b of this.tabs.children) b.classList.toggle('on', b.dataset.list === this.list);
  }

  async load(force = false) {
    const list = this.list;
    if (this.loading.has(list) && !force) return;
    this.loading.add(list);
    this.renderWhen();
    if (!this.data[list]) this.listBox.replaceChildren(el('div', 'gallery-note', 'Reading your tickets…'));
    const r = await window.deck.pmTickets(list).catch(err => ({ error: String(err?.message || err) }));
    this.loading.delete(list);
    if (r.notConnected) return this.setConnected({ connected: false });
    if (r.error) {
      this.renderWhen(r.error);
      if (!this.data[list]) this.listBox.replaceChildren(el('div', 'gallery-note tickets-error', r.error));
      return;
    }
    this.data[list] = { items: r.items, total: r.total, note: r.note || '', at: Date.now() };
    try { localStorage.setItem('pmTicketLists', JSON.stringify(this.data)); } catch { /* shown anyway */ }
    if (list === this.list) this.show();
  }

  renderWhen(error) {
    const d = this.data[this.list];
    this.when.classList.toggle('err', !!error);
    if (error) { this.when.textContent = error; return; }
    if (this.loading.has(this.list)) { this.when.textContent = 'Updating…'; return; }
    if (!d) { this.when.textContent = ''; return; }
    const min = Math.round((Date.now() - d.at) / 60000);
    this.when.textContent = min < 1 ? 'Just now' : `${min} min ago`;
  }

  show() {
    this.renderTypes();
    this.renderList();
    this.renderWhen();
  }

  items() {
    return this.data[this.list]?.items || [];
  }

  renderTypes() {
    this.types.replaceChildren();
    const counts = new Map();
    for (const t of this.items()) counts.set(t.type || 'Other', (counts.get(t.type || 'Other') || 0) + 1);
    if (counts.size < 2) return;
    const chip = (label, value, n) => {
      const b = el('button', 'gallery-cat' + (this.type === value ? ' on' : ''));
      b.type = 'button';
      b.append(el('span', null, label), el('span', 'gallery-cat-count', String(n)));
      b.onclick = () => { this.type = value; this.renderTypes(); this.renderList(); };
      this.types.appendChild(b);
    };
    chip('All', null, this.items().length);
    for (const [type, n] of [...counts].sort((a, b) => b[1] - a[1])) chip(type, type, n);
  }

  renderList() {
    const d = this.data[this.list];
    if (!d) return;
    const q = this.search.value.trim().toLowerCase();
    const shown = this.items().filter(t => (this.type === null || (t.type || 'Other') === this.type)
      && (!q || `${t.key} ${t.title} ${t.epic} ${t.sprint}`.toLowerCase().includes(q)));
    const by = (TICKET_COLUMNS.find(c => c[0] === this.sort.col) || TICKET_COLUMNS[0])[2];
    shown.sort((a, b) => {
      const x = by(a), y = by(b);
      const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
      return (this.sort.desc ? -c : c) || b.seq - a.seq;
    });
    const table = el('table', 'tickets-table');
    const head = el('tr');
    for (const [id, name] of TICKET_COLUMNS) {
      const th = el('th', `col-${id}`);
      th.append(el('span', null, name));
      if (this.sort.col === id) th.append(el('span', 'tickets-sort', this.sort.desc ? '↓' : '↑'));
      th.title = `Sort by ${name.toLowerCase()}`;
      th.onclick = () => {
        this.sort = this.sort.col === id ? { col: id, desc: !this.sort.desc } : { col: id, desc: id === 'key' };
        this.renderList();
      };
      head.appendChild(th);
    }
    const thead = el('thead');
    thead.appendChild(head);
    const body = el('tbody');
    for (const t of shown) {
      body.appendChild(this.row(t));
      if (this.expanded.has(t.key)) for (const r of this.subRows(t)) body.appendChild(r);
    }
    table.append(thead, body);
    const frag = document.createDocumentFragment();
    frag.appendChild(table);
    if (!shown.length) frag.appendChild(el('div', 'gallery-note', q || this.type ? 'No ticket matches.' : this.list === 'sprint' ? 'You have no tickets in an open sprint.' : 'No open tickets.'));
    if (d.total > d.items.length) frag.appendChild(el('div', 'gallery-note', `Showing ${d.items.length} of ${d.total} tickets.`));
    this.listBox.replaceChildren(frag);
  }

  // The key as a link that opens the details (a second click closes them).
  keyButton(t) {
    const b = el('button', 'tickets-key', shortKey(t.key));
    b.type = 'button';
    b.title = `${t.key}: show the details`;
    b.onclick = e => {
      e.stopPropagation();
      if (this.selected === t.key) { this.closeDetail(); return; }
      this.select(t);
    };
    return b;
  }

  row(t) {
    const story = isStory(t);
    const tr = el('tr', 'tickets-row' + (this.selected === t.key ? ' selected' : '') + (t.category === 'done' ? ' done' : '') + (story ? ' story' : ''));
    tr.dataset.key = t.key;
    const cell = (cls, ...kids) => { const td = el('td', cls); td.append(...kids); return td; };
    const key = cell('col-key');
    if (story) {
      const open = this.expanded.has(t.key);
      const chev = el('button', 'tickets-expand' + (open ? ' open' : ''));
      chev.type = 'button';
      chev.innerHTML = CHEVRON;
      chev.title = open ? 'Hide the subtasks' : 'Show the subtasks';
      chev.onclick = e => { e.stopPropagation(); this.toggleSubs(t); };
      key.append(chev);
    } else key.append(el('span', 'tickets-expand-gap'));
    key.append(typeIcon(t.type), this.keyButton(t));
    tr.append(
      key,
      cell('col-title', el('span', null, t.title)),
      cell('col-status', this.statusButton(t)),
      cell('col-epic', el('span', null, t.epic)),
      cell('col-sprint', el('span', null, t.sprint)));
    tr.title = story ? `${t.title}\n(click to show or hide the subtasks)` : t.title;
    if (story) tr.onclick = e => { if (!e.target.closest('a, button')) this.toggleSubs(t); };
    return tr;
  }

  // The rows under an open Story: its subtasks, or what is happening.
  subRows(parent) {
    const d = this.subs.get(parent.key);
    const note = text => {
      const tr = el('tr', 'tickets-subnote');
      const td = el('td', null, text);
      td.colSpan = TICKET_COLUMNS.length;
      tr.append(td);
      return [tr];
    };
    if (!d || (d.loading && !d.items)) return note('Reading the subtasks…');
    if (d.error && !d.items) return note(d.error);
    if (!d.items.length) return note('No subtasks.');
    return d.items.map(s => {
      const tr = el('tr', 'tickets-row tickets-subrow' + (this.selected === s.key ? ' selected' : '') + (s.done ? ' done' : ''));
      tr.dataset.key = s.key;
      const cell = (cls, ...kids) => { const td = el('td', cls); td.append(...kids); return td; };
      const icon = el('span', 'tickets-type-icon');
      icon.innerHTML = SUBTASK_ICON;
      icon.title = 'Subtask';
      const who = s.assignee ? el('span', 'tickets-sub-who', s.assignee) : '';
      const keyBtn = this.keyButton({ ...s, type: 'Subtask', parentKey: parent.key });
      tr.append(
        cell('col-key', el('span', 'tickets-expand-gap'), icon, keyBtn),
        cell('col-title', el('span', 'tickets-sub-title', s.title), who),
        cell('col-status', this.statusButton(s)),
        cell('col-epic'),
        cell('col-sprint'));
      tr.title = s.title;
      return tr;
    });
  }

  toggleSubs(t) {
    if (this.expanded.has(t.key)) this.expanded.delete(t.key);
    else {
      this.expanded.add(t.key);
      this.loadSubs(t.key);
    }
    this.renderList();
  }

  async loadSubs(key) {
    const d = this.subs.get(key) || {};
    if (d.loading) return;
    this.subs.set(key, { ...d, loading: true, error: null });
    const r = await window.deck.pmSubtasks(key).catch(err => ({ error: String(err?.message || err) }));
    if (r?.notConnected) return this.setConnected({ connected: false });
    const now = this.subs.get(key) || {};
    this.subs.set(key, Array.isArray(r) ? { items: r, loading: false } : { ...now, loading: false, error: r?.error || 'PM sent no subtasks.' });
    if (this.expanded.has(key)) this.renderList();
  }

  // ---------- statuses ----------

  // A ticket's status as a button: a click lists the project's statuses.
  statusButton(t) {
    const b = el('button', `tickets-status status-${t.category || 'todo'}` + (t.saving ? ' saving' : ''));
    b.type = 'button';
    b.append(el('span', null, t.status), el('span', 'tickets-status-caret', '▾'));
    b.title = 'Change the status';
    b.onclick = e => { e.stopPropagation(); e.preventDefault(); this.openStatusMenu(b, t); };
    return b;
  }

  async projectStatuses(project) {
    if (this.statusLists.has(project)) return this.statusLists.get(project);
    const r = await window.deck.pmStatuses(project).catch(err => ({ error: String(err?.message || err) }));
    if (!Array.isArray(r)) throw new Error(r?.error || 'PM sent no statuses.');
    this.statusLists.set(project, r);
    return r;
  }

  closeStatusMenu() {
    this.menu?.remove();
    this.menu = null;
    document.removeEventListener('mousedown', this.menuAway, true);
    document.removeEventListener('keydown', this.menuKey, true);
  }

  async openStatusMenu(btn, t) {
    const again = this.menu?.dataset.key === t.key;
    this.closeStatusMenu();
    if (again) return;
    const menu = el('div', 'tickets-status-menu');
    menu.dataset.key = t.key;
    menu.append(el('div', 'gallery-note', 'Reading the statuses…'));
    document.body.appendChild(menu);
    this.menu = menu;
    const place = () => {
      const r = btn.getBoundingClientRect();
      const h = menu.offsetHeight;
      const below = window.innerHeight - r.bottom - 8;
      menu.style.left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8) + 'px';
      menu.style.top = (below >= h || below > r.top ? r.bottom + 4 : Math.max(8, r.top - h - 4)) + 'px';
      menu.style.maxHeight = Math.max(160, below >= h || below > r.top ? below : r.top - 12) + 'px';
    };
    place();
    this.menuAway = e => { if (!menu.contains(e.target) && !btn.contains(e.target)) this.closeStatusMenu(); };
    this.menuKey = e => { if (e.key === 'Escape') { e.stopPropagation(); this.closeStatusMenu(); } };
    document.addEventListener('mousedown', this.menuAway, true);
    document.addEventListener('keydown', this.menuKey, true);
    let list;
    try { list = await this.projectStatuses(t.project || t.key.split('-')[0]); }
    catch (err) { if (this.menu === menu) menu.replaceChildren(el('div', 'tickets-error', err.message)); return; }
    if (this.menu !== menu) return;
    menu.replaceChildren();
    const names = { todo: 'To do', in_progress: 'In progress', done: 'Done' };
    for (const cat of ['todo', 'in_progress', 'done']) {
      const group = list.filter(s => s.category === cat);
      if (!group.length) continue;
      menu.append(el('div', 'tickets-status-group', names[cat]));
      for (const st of group) {
        const item = el('button', 'tickets-status-item' + (st.id === t.statusId || (!t.statusId && st.name === t.status) ? ' on' : ''));
        item.type = 'button';
        item.append(el('span', `tickets-status status-${st.category}`, st.name));
        item.onclick = () => { this.closeStatusMenu(); this.changeStatus(t, st); };
        menu.append(item);
      }
    }
    place();
    menu.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }

  // Every copy of a ticket the view holds (the lists, the subtask rows, the
  // details), so a change shows everywhere at once.
  copies(key) {
    const out = [];
    for (const d of Object.values(this.data)) for (const t of d.items || []) if (t.key === key) out.push(t);
    for (const d of this.subs.values()) for (const t of d.items || []) if (t.key === key) out.push(t);
    const dt = this.detailTicket;
    if (dt?.key === key) out.push(dt);
    for (const t of dt?.subtasks || []) if (t.key === key) out.push(t);
    return out;
  }

  async changeStatus(t, st) {
    if (st.id === t.statusId) return;
    const fields = ['statusId', 'status', 'category', 'color', 'textColor', 'done'];
    const before = Object.fromEntries(fields.map(f => [f, t[f]]));
    const apply = v => { for (const c of this.copies(t.key)) Object.assign(c, v); this.redraw(); };
    apply({ statusId: st.id, status: st.name, category: st.category, color: st.color, textColor: st.text, done: st.category === 'done', saving: true });
    const r = await window.deck.pmSetStatus({ key: t.key, id: t.id, project: t.project || t.key.split('-')[0], statusId: st.id, subtask: !!t.subtask })
      .catch(err => ({ error: String(err?.message || err) }));
    if (r?.notConnected) return this.setConnected({ connected: false });
    if (r?.error) {
      apply({ ...before, saving: false });
      this.renderWhen(`${t.key}: ${r.error}`);
      return;
    }
    apply({ ...r, saving: false });
    window.uiSound?.('done');
    try { localStorage.setItem('pmTicketLists', JSON.stringify(this.data)); } catch { /* shown anyway */ }
  }

  redraw() {
    this.renderList();
    if (this.detailTicket && this.selected === this.detailTicket.key) this.renderDetail(this.detailTicket, null);
  }

  closeDetail() {
    this.selected = null;
    this.detailTicket = null;
    this.view.classList.remove('detail-open');
    for (const r of this.listBox.querySelectorAll('.tickets-row')) r.classList.remove('selected');
    this.showDetailEmpty();
  }

  showDetailEmpty() {
    this.detail.replaceChildren(el('div', 'gallery-note', 'Pick a ticket to see its description and subtasks.'));
  }

  async select(t) {
    this.selected = t.key;
    this.view.classList.add('detail-open');
    for (const r of this.listBox.querySelectorAll('.tickets-row')) r.classList.toggle('selected', r.dataset.key === t.key);
    this.renderDetail(t, null);
    const full = await window.deck.pmTicket(t.key).catch(err => ({ error: String(err?.message || err) }));
    if (this.selected !== t.key) return;
    if (full.notConnected) return this.setConnected({ connected: false });
    if (!full.error && full.subtasks?.length) this.subs.set(full.key, { items: full.subtasks, loading: false });
    if (!full.error && t.parentKey) full.parentKey = t.parentKey;
    this.renderDetail(full.error ? t : full, full.error || null);
    if (!full.error && this.expanded.has(full.key)) this.renderList();
  }

  renderDetail(t, error) {
    this.detailTicket = t;
    const box = el('div', 'ticket-detail');
    const head = el('div', 'ticket-head');
    const link = el('a', 'ticket-key', shortKey(t.key));
    link.href = pmItemUrl(t.key);
    link.target = '_blank';
    link.title = `Open ${t.key} in PM`;
    const close = el('button', 'icon ticket-close', '✕');
    close.type = 'button';
    close.title = 'Close';
    close.onclick = () => this.closeDetail();
    const icon = t.subtask ? el('span', 'tickets-type-icon') : typeIcon(t.type);
    if (t.subtask) { icon.innerHTML = SUBTASK_ICON; icon.title = 'Subtask'; }
    head.append(icon, link, this.statusButton(t), close);
    box.append(head, el('h2', 'ticket-title', t.title));
    const facts = [['Subtask of', t.parentKey && shortKey(t.parentKey)], ['Assignee', t.assignee], ['Also', t.assignee2], ['Sprint', t.sprint], ['Epic', t.epicName || t.epic], ['Priority', t.priority], ['Reporter', t.author]].filter(([, v]) => v);
    if (facts.length) {
      const grid = el('div', 'ticket-facts');
      for (const [k, v] of facts) grid.append(el('span', 'ticket-fact-name', k), el('span', null, v));
      box.append(grid);
    }
    const actions = el('div', 'ticket-actions');
    const start = el('button', 'gallery-use', 'Start agent');
    start.type = 'button';
    start.title = 'Put the ticket on the Hub\'s message box: say what to do and send. A Story with two or more subtasks gets the ⑂ Split button there.';
    start.onclick = () => this.onStart?.(t);
    const open = el('a', 'gallery-action', 'Open in PM');
    open.href = pmItemUrl(t.key);
    open.target = '_blank';
    actions.append(start, open);
    box.append(actions);
    if (error) box.append(el('div', 'tickets-error', error));
    if (t.description === undefined && !error) box.append(el('div', 'gallery-note ticket-loading', 'Reading the ticket…'));
    if (t.description) box.append(this.description(t));
    else if (t.description === '') box.append(el('div', 'ticket-empty', 'No description.'));
    if (t.subtasks?.length) {
      const open = t.subtasks.filter(s => !s.done).length;
      const subs = el('div', 'ticket-subtasks');
      subs.append(el('h3', null, `Subtasks · ${open} open of ${t.subtasks.length}`));
      for (const s of t.subtasks) {
        const row = el('a', 'ticket-sub' + (s.done ? ' done' : ''));
        row.href = pmItemUrl(s.key);
        row.target = '_blank';
        row.append(el('span', 'tickets-key', shortKey(s.key)), el('span', 'ticket-sub-title', s.title), this.statusButton(s));
        subs.append(row);
      }
      box.append(subs);
    }
    this.detail.replaceChildren(box);
  }

  // The description is PM's HTML: cleaned, with its images and videos as
  // PM's short-lived links (videos open in the browser).
  description(t) {
    const div = el('div', 'ticket-desc msg-text');
    div.innerHTML = DOMPurify.sanitize(t.description, { ADD_ATTR: ['data-media-id', 'data-file-name', 'target'] });
    const media = new Map((t.media || []).map(m => [m.id, m]));
    for (const img of div.querySelectorAll('img[data-media-id]')) {
      const m = media.get(img.dataset.mediaId);
      if (m?.url) {
        img.src = m.url;
        img.onclick = () => openImageOverlay(m.url, [...div.querySelectorAll('img')].map(i => i.src));
      } else img.replaceWith(el('div', 'ticket-media', `🖼 ${img.dataset.fileName || 'Image'}`));
    }
    for (const video of div.querySelectorAll('video')) {
      const name = video.dataset.fileName || 'Video';
      const a = el('a', 'ticket-media', `▶ ${name} (open in PM)`);
      a.href = pmItemUrl(t.key);
      a.target = '_blank';
      video.replaceWith(a);
    }
    for (const a of div.querySelectorAll('a[href]')) a.target = '_blank';
    return div;
  }
}

window.TicketsView = TicketsView;
