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

// Sprint: yours in the open sprints. All tickets: every open ticket of the
// space (Settings → Tactile PM; Enchanted Inn by default), whoever
// has it, so you can find unassigned ones and take them (Assign to me).
const TICKET_LISTS = [['sprint', 'Sprint'], ['all', 'All tickets']];
const CATEGORY_ORDER = { todo: 0, in_progress: 1, done: 2 };
// The table's columns: [id, name, the value it sorts by].
const TICKET_COLUMNS = [
  ['key', 'Key', t => t.seq],
  ['title', 'Title', t => t.title.toLowerCase()],
  ['assignee', 'Assignee', t => (t.assignee || '\uffff').toLowerCase()],
  ['status', 'Status', t => `${CATEGORY_ORDER[t.category] ?? 1}${t.status}`],
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
// "[UI][Daily rewards] Streak calendar": the bracketed names at the start of
// a title are labels the team uses to sort tickets. They show as small tags
// (each name its own colour), then the rest of the title.
function ticketTitle(title, cls = null) {
  const span = el('span', cls);
  const text = String(title || '');
  const m = text.match(/^\s*((?:\[[^\[\]]{1,40}\]\s*)+)(.*)$/);
  if (!m || !m[2].trim()) { span.textContent = text; return span; }
  for (const [, name] of m[1].matchAll(/\[([^\[\]]+)\]/g)) {
    let h = 0;
    for (const c of name.trim().toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const tag = el('span', 'ticket-tag c' + (h % 8), name.trim());
    span.appendChild(tag);
  }
  span.append(m[2].trim());
  return span;
}

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
const FUNNEL = '<svg width="15" height="15" viewBox="0 0 24 24"><path d="M4 5h16l-6.2 7.4V19l-3.6-1.8v-4.8z" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linejoin="round"/></svg>';
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
    // The filters (which statuses show, which type) sit in a menu behind a
    // small funnel button; it shows a dot while a filter hides something.
    this.filterBtn = el('button', 'icon tickets-filter-btn');
    this.filterBtn.type = 'button';
    this.filterBtn.innerHTML = FUNNEL;
    this.filterBtn.title = 'Filters';
    this.filterBtn.onclick = () => this.openMenu(this.filterBtn, 'filters', menu => this.fillFilterMenu(menu));
    const spacer = el('span', 'tickets-spacer');
    // The bell: PM notifications (src/pmnotify.js), with a red count.
    this.bell = el('button', 'icon tickets-bell');
    this.bell.type = 'button';
    this.bell.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2H4.5z" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linejoin="round"/><path d="M10 20.5a2 2 0 0 0 4 0" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>';
    this.bellCount = el('span', 'hub-badge hidden');
    this.bell.append(this.bellCount);
    this.bell.title = 'Notifications';
    this.bell.onclick = () => this.openMenu(this.bell, 'notifications', menu => this.fillNotifications(menu));
    this.notifications = { unread: 0, items: [] };
    // Which statuses show (To do, In progress, Done): a click on one hides
    // or shows those tickets and subtasks. Remembered.
    // And single statuses hidden on their own (In QA but not In Progress), by name.
    try { this.hiddenNames = new Set(JSON.parse(localStorage.getItem('pmTicketHiddenStatuses') || '[]')); } catch { this.hiddenNames = new Set(); }
    try { this.statusShow = new Set(JSON.parse(localStorage.getItem('pmTicketStatusShow') || 'null') || ['todo', 'in_progress', 'done']); } catch { this.statusShow = new Set(['todo', 'in_progress', 'done']); }
    try { this.foldedEpics = new Set(JSON.parse(localStorage.getItem('pmTicketFoldedEpics') || '[]')); } catch { this.foldedEpics = new Set(); }
    this.when = el('span', 'tickets-when');
    const refresh = el('button', 'icon gallery-refresh', '↻');
    refresh.type = 'button';
    refresh.title = 'Read the tickets again';
    refresh.onclick = () => this.load(true);
    this.account = el('button', 'tickets-account');
    this.account.type = 'button';
    this.account.onclick = () => this.signOut();
    // The PM account and Sign out live in Settings → Account (pmAccountPanel).
    // The filters are on the columns now (renderList): no filter button here.
    bar.append(this.tabs, this.search, spacer, this.when, refresh, this.bell);
    // Haiku for tickets (src/pmassist.js): say what to do or ask; it only
    // reads tickets and makes changes you can undo, nothing else.
    this.assist = el('div', 'tickets-assist');
    this.assistInput = document.createElement('input');
    this.assistInput.type = 'text';
    this.assistInput.className = 'tickets-assist-input';
    this.assistInput.placeholder = 'Ask Haiku about tickets: "assign M2S-3644 to me", "which of my tickets are in QA?"… (↩)';
    this.assistInput.title = 'Haiku with the Tactile PM connector, for ticket work only. It can read tickets and make changes you can undo (fields, status, assignee, comments, new tickets and subtasks), never delete or archive anything, touch sprints, projects or epics, or start agents.';
    const mark = el('span', 'tickets-assist-mark', 'Haiku');
    this.assistOut = el('div', 'tickets-assist-out hidden');
    const row = el('div', 'tickets-assist-row');
    row.append(mark, this.assistInput);
    // At the bottom of the view, like the Hub's message box: the answer shows above the field.
    this.assist.append(this.assistOut, row);
    this.assistInput.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.runAssist(); } if (e.key === 'Escape') this.assistInput.blur(); };
    window.deck.onPmAssistStep?.((id, line) => { if (id === this.assistId) this.assistStep.textContent = line; });
    const body = el('div', 'tickets-body');
    this.bodyEl = body;
    this.listBox = el('section', 'tickets-list scroll');
    this.detail = el('section', 'tickets-detail scroll');
    // Behind the details: dims the table, and a click on it closes them.
    this.backdrop = el('div', 'tickets-backdrop');
    this.backdrop.onclick = () => this.closeDetail();
    body.append(this.listBox, this.backdrop, this.detail);
    this.view.append(bar, body, this.assist);
    this.list = 'sprint';
    this.type = null;
    this.titleQ = '';     // the Title column's filter: words a title must have
    this.sprintPick = null;  // All tickets: one sprint ('' none), or null for any
    this.who = null;     // All tickets: whose (null anyone, '' unassigned, or a name)
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
    // Escape closes the floating details (and the status menu first). On
    // the window, so it comes before the app's own Escape (an agent's stop).
    window.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || this.menu || !this.view.classList.contains('detail-open')) return;
      if (!this.global && this.view.classList.contains('hidden')) return;
      if (document.querySelector('.lightbox, .gallery-preview')) return;
      const a = document.activeElement;
      if (this.detail.contains(a) && a.matches('input, textarea, select, [contenteditable="true"]')) return;  // the field handles it
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
    this.email = st.email || null;
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

  // ---------- notifications ----------

  setNotifications(summary) {
    this.notifications = summary || { unread: 0, items: [] };
    const n = this.notifications.unread;
    this.bellCount.textContent = n > 99 ? '99+' : String(n || '');
    this.bellCount.classList.toggle('hidden', !n);
    this.bell.title = n ? `${n} new notification${n === 1 ? '' : 's'}` : 'Notifications';
    if (this.menu?.dataset.key === 'notifications') this.fillNotifications(this.menu);
    if (this.data[this.list]) this.renderList();   // the bells next to the keys
  }

  // A ticket's unread notifications, oldest first.
  unreadFor(key) {
    return (this.notifications.items || []).filter(n => n.key === key && !n.read).sort((a, b) => (a.at < b.at ? -1 : 1));
  }

  // A status change you have not seen: { from, to } (the first unread
  // change's old status, the last one's new status), or null.
  statusNews(key) {
    const moves = this.unreadFor(key).filter(n => n.kind === 'status');
    if (!moves.length) return null;
    const split = n => (n.from || n.to ? [n.from, n.to] : String(n.text).split(' → '));
    const from = split(moves[0])[0];
    const to = split(moves[moves.length - 1])[1];
    return from && from !== to ? { from, to } : null;
  }

  // The red bell next to a key with unread notifications; its tooltip says
  // what happened.
  notifBell(t) {
    const news = this.unreadFor(t.key);
    if (!news.length) return '';
    const b = el('span', 'tickets-notif-bell');
    b.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2H4.5z" fill="currentColor"/><path d="M10 20.5a2 2 0 0 0 4 0" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>';
    if (news.length > 1) b.append(el('span', 'tickets-notif-bell-n', String(news.length)));
    b.title = news.map(n => n.text).join('\n') + '\n(open the ticket to see what changed)';
    return b;
  }

  // The bell's list: the newest first; unread ones have a dot. A click
  // opens the ticket and marks it read.
  fillNotifications(menu) {
    menu.replaceChildren();
    menu.classList.add('tickets-notif-menu');
    const head = el('div', 'tickets-notif-head');
    head.append(el('span', null, 'Notifications'));
    const actions = el('span', 'tickets-notif-actions');
    const check = el('button', 'tp-link', 'Check now');
    check.type = 'button';
    check.onclick = async () => {
      check.textContent = 'Checking…';
      const r = await window.deck.pmCheckNotifications();
      if (r?.error) check.textContent = 'Could not check';
      else this.setNotifications(r);
    };
    actions.append(check);
    if (this.notifications.unread) {
      const all = el('button', 'tp-link', 'Mark all read');
      all.type = 'button';
      all.onclick = async () => this.setNotifications(await window.deck.pmReadNotifications(null));
      actions.append(all);
    }
    head.append(actions);
    menu.append(head);
    const items = this.notifications.items || [];
    if (!items.length) {
      menu.append(el('div', 'tickets-notif-empty', 'Nothing new. The app looks at PM every 2 minutes for changes to your tickets: status changes, comments, new subtasks and tickets assigned to you.'));
      return;
    }
    const icons = { status: '⇄', comment: '💬', subtask: '＋', assigned: '→', new: '★' };
    for (const n of items.slice(0, 60)) {
      const row = el('button', 'tickets-notif' + (n.read ? '' : ' unread'));
      row.type = 'button';
      const top = el('div', 'tickets-notif-top');
      top.append(el('span', 'tickets-notif-kind', icons[n.kind] || '•'), typeIcon(n.type), el('span', 'tickets-key', shortKey(n.key)),
        el('span', 'tickets-notif-title', n.title), el('span', 'tickets-notif-time', typeof timeAgo === 'function' ? timeAgo(new Date(n.at).getTime()) : ''));
      const text = el('div', 'tickets-notif-text' + (n.kind === 'status' ? ` status-${n.category || 'todo'}` : ''), n.text);
      row.append(top, text);
      row.title = new Date(n.at).toLocaleString();
      row.onclick = async () => {
        this.closeStatusMenu();
        if (!n.read) window.deck.pmReadNotifications([n.id]).then(r => this.setNotifications(r));
        this.select({ key: n.key, project: n.key.split('-')[0], title: n.title, type: n.type });
      };
      menu.append(row);
    }
  }

  // ---------- the filters ----------

  filtering() { return this.statusShow.size < 3 || this.hiddenNames.size > 0; }

  saveStatusFilter() {
    try {
      localStorage.setItem('pmTicketStatusShow', JSON.stringify([...this.statusShow]));
      localStorage.setItem('pmTicketHiddenStatuses', JSON.stringify([...this.hiddenNames]));
    } catch { /* this run only */ }
  }

  resetStatusFilter() {
    this.statusShow = new Set(['todo', 'in_progress', 'done']);
    this.hiddenNames = new Set();
    this.saveStatusFilter();
  }

  // Every status the filter can offer for these tickets: the statuses of
  // their projects (PM's list, read once) and any other status they have.
  // Map: lowercase name -> { name, category }, in PM's order.
  knownStatuses(items, onRead) {
    const out = new Map();
    const projects = new Set(items.map(t => t.project || String(t.key || '').split('-')[0]).filter(Boolean));
    for (const p of projects) {
      const list = this.statusLists.get(p);
      if (list) for (const st of list) out.set(st.name.toLowerCase(), { name: st.name, category: st.category });
      else if (onRead) this.projectStatuses(p).then(onRead).catch(() => {});
    }
    for (const t of items) if (t.status && !out.has(t.status.toLowerCase())) out.set(t.status.toLowerCase(), { name: t.status, category: t.category || 'todo' });
    return out;
  }

  // The filter menu: the statuses to show (ticked ones show), grouped under
  // To do, In progress and Done (a group's tick shows or hides all of it),
  // and the type. The ticket panel's subtasks use the same statuses, with
  // items = the subtasks and no type.
  // The filters. only: one column's (status, type, assignee, sprint, title),
  // from the funnel in its header; without, every one (the subtasks' filter).
  fillFilterMenu(menu, { items = this.items(), types: withTypes = true, only = null } = {}) {
    menu.replaceChildren();
    menu.classList.add('tickets-filter-menu');
    const redo = () => {
      if (this.menu !== menu) return;
      this.fillFilterMenu(menu, { items, types: withTypes, only });
      this.renderList();
      this.renderFilterBtn();
      if (this.detailTicket && this.selected === this.detailTicket.key) this.renderDetail(this.detailTicket, null);
    };
    // A column's own filter (only): just its part of the menu.
    const part = id => !only || only === id;
    // Title: the words a title must have.
    if (only === 'title') {
      menu.append(el('div', 'tickets-status-group', 'Title has'));
      const input = document.createElement('input');
      input.type = 'search';
      input.className = 'tp-epic-search';
      input.placeholder = 'Words in the title…';
      input.value = this.titleQ;
      input.oninput = () => { this.titleQ = input.value; this.renderList(); };
      input.onkeydown = e => { if (e.key === 'Enter') this.closeStatusMenu(); };
      menu.append(input);
      requestAnimationFrame(() => input.focus());
      return;
    }
    // Sprint: one sprint, or tickets in none.
    if (only === 'sprint') {
      const sprints = new Map();
      for (const t of this.items()) if (t.sprint) sprints.set(t.sprint, (sprints.get(t.sprint) || 0) + 1);
      menu.append(el('div', 'tickets-status-group', 'Sprint'));
      const choices = [[null, 'Any sprint', this.items().length], ['', 'No sprint', this.items().filter(t => !t.sprint).length],
        ...[...sprints].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })).map(([n, c]) => [n, n, c])];
      for (const [value, label, n] of choices) {
        const b = el('button', 'tickets-status-item tickets-check' + (this.sprintPick === value ? ' ticked' : ''));
        b.type = 'button';
        b.append(el('span', 'tickets-check-box round', this.sprintPick === value ? '●' : ''), el('span', null, label), el('span', 'gallery-cat-count', String(n)));
        b.onclick = () => { this.sprintPick = value; redo(); };
        menu.append(b);
      }
      return;
    }
    const known = part('status') ? this.knownStatuses(items, () => { if (this.menu === menu) this.fillFilterMenu(menu, { items, types: withTypes, only }); }) : new Map();
    const count = new Map();
    for (const t of items) count.set(String(t.status || '').toLowerCase(), (count.get(String(t.status || '').toLowerCase()) || 0) + 1);
    const catOf = t => (t.category in { todo: 1, in_progress: 1, done: 1 } ? t.category : 'todo');
    if (part('status')) menu.append(el('div', 'tickets-status-group', 'Status'));
    for (const [cat, label] of part('status') ? [['todo', 'To do'], ['in_progress', 'In progress'], ['done', 'Done']] : []) {
      const names = [...known.entries()].filter(([, v]) => v.category === cat);
      const catOn = this.statusShow.has(cat);
      const shownNames = names.filter(([k]) => !this.hiddenNames.has(k));
      const full = catOn && shownNames.length === names.length;
      const part = catOn && !full;
      const b = el('button', `tickets-status-item tickets-check tickets-check-cat status-${cat}` + (full ? ' ticked' : part ? ' partly' : ''));
      b.type = 'button';
      b.append(el('span', 'tickets-check-box', full ? '✓' : part ? '–' : ''), el('span', null, label), el('span', 'gallery-cat-count', String(items.filter(t => catOf(t) === cat).length)));
      b.title = full ? `Hide every ${label.toLowerCase()} status` : `Show every ${label.toLowerCase()} status`;
      b.onclick = () => {
        if (full) this.statusShow.delete(cat);
        else { this.statusShow.add(cat); for (const [k] of names) this.hiddenNames.delete(k); }
        this.saveStatusFilter();
        redo();
      };
      menu.append(b);
      // Its statuses one by one, when the group has more than one.
      if (names.length < 2) continue;
      for (const [k, v] of names) {
        const on = catOn && !this.hiddenNames.has(k);
        const n = count.get(k) || 0;
        const row = el('button', `tickets-status-item tickets-check tickets-check-name status-${cat}` + (on ? ' ticked' : '') + (n ? '' : ' none-here'));
        row.type = 'button';
        row.append(el('span', 'tickets-check-box', on ? '✓' : ''), el('span', null, v.name), el('span', 'gallery-cat-count', n ? String(n) : ''));
        row.onclick = () => {
          if (!catOn) {
            // The group was hidden: show just this one of it.
            this.statusShow.add(cat);
            for (const [o] of names) if (o !== k) this.hiddenNames.add(o); else this.hiddenNames.delete(o);
          } else if (on) this.hiddenNames.add(k);
          else this.hiddenNames.delete(k);
          // Every status of the group hidden: the group is off.
          if (names.every(([o]) => this.hiddenNames.has(o))) { this.statusShow.delete(cat); for (const [o] of names) this.hiddenNames.delete(o); }
          this.saveStatusFilter();
          redo();
        };
        menu.append(row);
      }
    }
    const types = new Map();
    for (const t of this.items()) types.set(t.type || 'Other', (types.get(t.type || 'Other') || 0) + 1);
    if (withTypes && part('type') && (types.size > 1 || this.type || only === 'type')) {
      menu.append(el('div', 'tickets-status-group', 'Type'));
      for (const [value, label, n] of [[null, 'All types', this.items().length], ...[...types].sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, k, n])]) {
        const b = el('button', 'tickets-status-item tickets-check' + (this.type === value ? ' ticked' : ''));
        b.type = 'button';
        const icon = value ? typeIcon(value) : el('span', 'tickets-check-box round', this.type === null ? '●' : '');
        if (value) icon.classList.add(this.type === value ? 'picked' : 'unpicked');
        b.append(icon, el('span', null, label), el('span', 'gallery-cat-count', String(n)));
        b.onclick = () => { this.type = value; redo(); };
        menu.append(b);
      }
    }
    // Whose tickets (All tickets only): anyone, unassigned, yours or one person's.
    if (withTypes && part('assignee') && this.list === 'all') {
      const people = new Map();
      for (const t of this.items()) if (t.assignee) people.set(t.assignee, (people.get(t.assignee) || 0) + 1);
      const me = this.email ? [...people.keys()].find(n => n === this.myName?.()) : null;
      menu.append(el('div', 'tickets-status-group', 'Assignee'));
      const choices = [[null, 'Anyone', this.items().length], ['', 'Unassigned', this.items().filter(t => !t.assignee).length],
        ...(me ? [[me, `Me (${me})`, people.get(me)]] : []),
        ...[...people].filter(([n]) => n !== me).sort((a, b) => a[0].localeCompare(b[0])).map(([n, c]) => [n, n, c])];
      for (const [value, label, n] of choices) {
        const b = el('button', 'tickets-status-item tickets-check' + (this.who === value ? ' ticked' : ''));
        b.type = 'button';
        b.append(el('span', 'tickets-check-box round', this.who === value ? '●' : ''), el('span', null, label), el('span', 'gallery-cat-count', String(n)));
        b.onclick = () => { this.who = value; redo(); };
        menu.append(b);
      }
    }
    const on = { status: this.filtering(), type: withTypes && this.type, assignee: this.list === 'all' && this.who !== null };
    if (only ? on[only] : Object.values(on).some(Boolean)) {
      const reset = el('button', 'tp-link tickets-filter-reset', only ? 'Show all' : 'Show everything');
      reset.type = 'button';
      reset.onclick = () => {
        if (part('status')) this.resetStatusFilter();
        if (part('type')) this.type = null;
        if (part('assignee')) this.who = null;
        redo();
      };
      menu.append(reset);
    }
  }

  renderFilterBtn() {
    const hidden = [];
    for (const [cat, label] of [['todo', 'to do'], ['in_progress', 'in progress'], ['done', 'done']]) if (!this.statusShow.has(cat)) hidden.push(label);
    const known = this.knownStatuses(this.items());
    for (const k of this.hiddenNames) hidden.push(known.get(k)?.name || k);
    const whose = this.list === 'all' && this.who !== null ? (this.who ? `only ${this.who}'s` : 'only unassigned') : '';
    const active = hidden.length || this.type || whose;
    this.filterBtn.classList.toggle('active', !!active);
    this.filterBtn.title = active ? `Filters: ${[whose, this.type ? `only ${this.type}` : '', hidden.length ? `hiding ${hidden.join(', ')}` : ''].filter(Boolean).join('; ')}` : 'Filters';
  }

  shows(t) {
    const cat = t.category in { todo: 1, in_progress: 1, done: 1 } ? t.category : 'todo';
    return this.statusShow.has(cat) && !this.hiddenNames.has(String(t.status || '').toLowerCase());
  }

  renderTypes() {
    this.renderFilterBtn();
  }

  renderList() {
    const d = this.data[this.list];
    if (!d) return;
    const q = this.search.value.trim().toLowerCase();
    const whoOk = t => this.list !== 'all' || this.who === null || (this.who === '' ? !t.assignee : t.assignee === this.who);
    const sprintOk = t => this.list !== 'all' || this.sprintPick === null || (this.sprintPick === '' ? !t.sprint : t.sprint === this.sprintPick);
    const words = this.titleQ.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const titleOk = t => words.every(w => t.title.toLowerCase().includes(w));
    const shown = this.items().filter(t => (this.type === null || (t.type || 'Other') === this.type) && this.shows(t) && whoOk(t) && sprintOk(t) && titleOk(t)
      && (!q || `${t.key} ${t.title} ${t.epic} ${t.sprint} ${t.assignee || 'unassigned'}`.toLowerCase().includes(q)));
    const columns = this.columns();
    if (!columns.some(c => c[0] === this.sort.col)) this.sort = { col: 'key', desc: true };
    const by = (columns.find(c => c[0] === this.sort.col) || columns[0])[2];
    shown.sort((a, b) => {
      const x = by(a), y = by(b);
      const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
      return (this.sort.desc ? -c : c) || b.seq - a.seq;
    });
    const table = el('table', `tickets-table list-${this.list}`);
    const head = el('tr');
    // Each column's heading: its name, a sort button (↑ ↓, or ↕ when the
    // list is sorted by another column) and a funnel with that column's filter
    // (lit while it hides something). Key filters by type.
    const filterOf = { key: 'type', title: 'title', assignee: 'assignee', status: 'status', sprint: 'sprint' };
    const active = {
      type: this.type !== null, title: !!this.titleQ.trim(), assignee: this.who !== null,
      status: this.filtering(), sprint: this.sprintPick !== null,
    };
    for (const [id, name] of columns) {
      const th = el('th', `col-${id}`);
      const cellBox = el('div', 'tickets-th');
      const sorted = this.sort.col === id;
      const sort = el('button', 'tickets-th-btn tickets-sort-btn' + (sorted ? ' on' : ''), sorted ? (this.sort.desc ? '↓' : '↑') : '↕');
      sort.type = 'button';
      sort.title = `Sort by ${name.toLowerCase()}`;
      sort.onclick = e => {
        e.stopPropagation();
        this.sort = sorted ? { col: id, desc: !this.sort.desc } : { col: id, desc: id === 'key' };
        this.renderList();
      };
      cellBox.append(el('span', 'tickets-th-name', name), sort);
      const only = filterOf[id];
      if (only) {
        const f = el('button', 'tickets-th-btn tickets-th-filter' + (active[only] ? ' on' : ''));
        f.type = 'button';
        f.innerHTML = FUNNEL;
        f.title = active[only] ? `Filtering by ${only}` : `Filter by ${only}`;
        f.onclick = e => { e.stopPropagation(); this.openMenu(f, 'filter:' + only, menu => this.fillFilterMenu(menu, { only })); };
        cellBox.append(f);
      }
      th.append(cellBox);
      th.onclick = () => sort.click();
      head.appendChild(th);
    }
    const thead = el('thead');
    thead.appendChild(head);
    const body = el('tbody');
    // Grouped by epic, like PM's sheet: epics by name, then the tickets
    // without one. A click on an epic's row folds it (remembered).
    const groups = new Map();
    for (const t of shown) {
      const name = t.epic || '';
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(t);
    }
    const names = [...groups.keys()].sort((a, b) => (!a) - (!b) || a.localeCompare(b));
    names.forEach((name, gi) => {
      const list = groups.get(name);
      const folded = this.foldedEpics.has(name);
      // A gap between epics, so each one's start and end are plain to see.
      if (gi) {
        const gap = el('tr', 'tickets-gap');
        const gtd = el('td');
        gtd.colSpan = this.columns().length;
        gap.append(gtd);
        body.appendChild(gap);
      }
      const tr = el('tr', 'tickets-group' + (folded ? ' folded' : ''));
      const td = el('td');
      td.colSpan = this.columns().length;
      const chev = el('span', 'tickets-expand' + (folded ? '' : ' open'));
      chev.innerHTML = CHEVRON;
      const done = list.filter(t => t.category === 'done').length;
      td.append(chev, el('span', 'tickets-group-flag', '⚑'), el('span', 'tickets-group-name', name || 'No epic'),
        el('span', 'tickets-group-count', `${list.length} ticket${list.length === 1 ? '' : 's'}` + (done ? ` · ${done} done` : '')));
      tr.append(td);
      tr.title = folded ? 'Show this epic\'s tickets' : 'Hide this epic\'s tickets';
      tr.onclick = () => {
        if (folded) this.foldedEpics.delete(name); else this.foldedEpics.add(name);
        try { localStorage.setItem('pmTicketFoldedEpics', JSON.stringify([...this.foldedEpics])); } catch { /* this run only */ }
        this.renderList();
      };
      body.appendChild(tr);
      if (folded) return;
      let last = null;
      for (const t of list) {
        last = this.row(t);
        body.appendChild(last);
        if (this.expanded.has(t.key)) {
          const subs = this.subRows(t);
          if (subs.length) last.classList.add('expanded');
          subs[0]?.classList.add('sub-first');
          if (subs.length) { subs[subs.length - 1].classList.add('sub-last'); last = subs[subs.length - 1]; }
          for (const r of subs) body.appendChild(r);
        }
      }
      last?.classList.add('group-end');
    });
    table.append(thead, body);
    const frag = document.createDocumentFragment();
    frag.appendChild(table);
    if (!shown.length) frag.appendChild(el('div', 'gallery-note', q || this.type || this.filtering() ? 'No ticket matches.' : this.list === 'sprint' ? 'You have no tickets in an open sprint.' : 'No open tickets.'));
    if (d.total > d.items.length) frag.appendChild(el('div', 'gallery-note', `Showing ${d.items.length} of ${d.total} tickets.`));
    this.listBox.replaceChildren(frag);
  }

  // This sprint's list needs no Sprint column: every ticket is in it.
  columns() {
    return TICKET_COLUMNS.filter(c => !(['sprint', 'assignee'].includes(c[0]) && this.list === 'sprint'));
  }

  // The small robot-head button after a key: starts an agent on the ticket.
  // The row wraps into its key, the view goes to the Hub, and the ticket
  // flies into the message box (app.js onStart). Always in view.
  agentButton(t) {
    const b = el('button', 'tickets-agent');
    b.type = 'button';
    b.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6v2.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="1.6" r="1" fill="currentColor"/><rect x="2.3" y="3.8" width="11.4" height="9.4" rx="3" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="5.7" cy="7.8" r="1.25" fill="currentColor" class="tickets-agent-eye"/><circle cx="10.3" cy="7.8" r="1.25" fill="currentColor" class="tickets-agent-eye"/><path d="M6 10.9h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M1 7.2v2.4M15 7.2v2.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
    b.title = `Start an agent on ${t.key}: its link goes on the Hub's message box, where you say what to do`;
    b.onclick = e => { e.stopPropagation(); this.onStart?.(t, { row: b.closest('tr'), key: b.closest('td') }); };
    return b;
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
    key.append(typeIcon(t.type), this.keyButton(t), this.notifBell(t), this.agentButton(t));
    // The title's text opens the ticket's details, like its key; the rest of
    // the row (the cell around the text too) shows or hides the subtasks.
    const text = ticketTitle(t.title, 'tickets-title-link');
    text.onclick = e => { e.stopPropagation(); this.select(t); };
    const title = cell('col-title', text);
    tr.append(
      key,
      title,
      cell('col-status', ...(() => {
        // An unseen status change shows as before → after.
        const news = this.statusNews(t.key);
        return news ? [el('span', 'tickets-was', news.from), el('span', 'tickets-was-arrow', '→'), this.statusButton(t)] : [this.statusButton(t)];
      })()));
    if (this.list !== 'sprint') {
      const who = el('span', 'tickets-who' + (t.assignee ? '' : ' none'), t.assignee || 'Unassigned');
      tr.insertBefore(cell('col-assignee', who), tr.querySelector('.col-status'));
      tr.append(cell('col-sprint', el('span', null, t.sprint)));
    }
    tr.title = story ? `${t.title}\n(the title opens the ticket; the rest of the row shows or hides the subtasks)` : t.title;
    if (story) tr.onclick = e => { if (!e.target.closest('a, button')) this.toggleSubs(t); };
    return tr;
  }

  // The rows under an open Story: its subtasks, or what is happening.
  subRows(parent) {
    const d = this.subs.get(parent.key);
    const note = text => {
      const tr = el('tr', 'tickets-subnote');
      const td = el('td', null, text);
      td.colSpan = this.columns().length;
      tr.append(td);
      return [tr];
    };
    if (!d || (d.loading && !d.items)) return note('Reading the subtasks…');
    if (d.error && !d.items) return note(d.error);
    if (!d.items.length) return [];
    const items = d.items.filter(s => this.shows(s));
    if (!items.length) return note(`All ${d.items.length} subtasks are hidden by the status filter.`);
    return items.map(s => {
      const tr = el('tr', 'tickets-row tickets-subrow' + (this.selected === s.key ? ' selected' : '') + (s.done ? ' done' : ''));
      tr.dataset.key = s.key;
      const cell = (cls, ...kids) => { const td = el('td', cls); td.append(...kids); return td; };
      const icon = el('span', 'tickets-type-icon');
      icon.innerHTML = SUBTASK_ICON;
      icon.title = 'Subtask';
      const keyBtn = this.keyButton({ ...s, type: 'Subtask', parentKey: parent.key });
      tr.append(
        cell('col-key', el('span', 'tickets-expand-gap'), icon, keyBtn, this.agentButton({ ...s, parentKey: parent.key })),
        (() => { const x = ticketTitle(s.title, 'tickets-sub-title tickets-title-link'); x.onclick = e => { e.stopPropagation(); this.select({ ...s, type: 'Subtask', parentKey: parent.key }); }; return cell('col-title', x); })(),
        cell('col-status', this.statusButton(s)));
      if (this.list !== 'sprint') {
        tr.insertBefore(cell('col-assignee', el('span', 'tickets-who' + (s.assignee ? '' : ' none'), s.assignee || '')), tr.querySelector('.col-status'));
        tr.append(cell('col-sprint'));
      }
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

  // A small menu under (or above) an element: fill(menu) puts its items in,
  // and may wait for PM first. A second click on the same element closes it.
  openMenu(anchor, key, fill) {
    const again = this.menu?.dataset.key === key;
    this.closeStatusMenu();
    if (again) return;
    const menu = el('div', 'tickets-status-menu');
    menu.dataset.key = key;
    menu.append(el('div', 'gallery-note', 'Reading…'));
    document.body.appendChild(menu);
    this.menu = menu;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      menu.style.maxHeight = '';
      const h = menu.offsetHeight;
      const below = window.innerHeight - r.bottom - 8;
      const down = below >= h || below > r.top;
      menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
      menu.style.top = (down ? r.bottom + 4 : Math.max(8, r.top - h - 4)) + 'px';
      menu.style.maxHeight = Math.max(160, down ? below : r.top - 12) + 'px';
    };
    place();
    this.menuAway = e => { if (!menu.contains(e.target) && !anchor.contains(e.target)) this.closeStatusMenu(); };
    this.menuKey = e => { if (e.key === 'Escape') { e.stopPropagation(); this.closeStatusMenu(); } };
    document.addEventListener('mousedown', this.menuAway, true);
    document.addEventListener('keydown', this.menuKey, true);
    Promise.resolve().then(() => fill(menu)).then(() => {
      if (this.menu !== menu) return;
      place();
      menu.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
    }).catch(err => { if (this.menu === menu) menu.replaceChildren(el('div', 'tickets-error', err.message)); });
  }

  openStatusMenu(btn, t) {
    this.openMenu(btn, 'status:' + t.key, async menu => {
      const list = await this.projectStatuses(t.project || t.key.split('-')[0]);
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
    });
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

  // The Haiku box: one request at a time; its answer shows under the box,
  // and the lists (and the open ticket) read PM again after it.
  async runAssist() {
    const text = this.assistInput.value.trim();
    if (!text) return;
    if (this.assistId) { window.deck.pmAssistStop(this.assistId); return; }
    const id = 'assist-' + Date.now();
    this.assistId = id;
    this.assist.classList.add('busy');
    this.assistInput.disabled = true;
    this.assistStep = el('span', 'tickets-assist-step', 'Thinking…');
    const stop = el('button', 'tp-link', 'Stop');
    stop.type = 'button';
    stop.onclick = () => window.deck.pmAssistStop(id);
    const asked = el('div', 'tickets-assist-asked', text);
    const working = el('div', 'tickets-assist-working');
    working.append(el('span', 'pm-signin-spin'), this.assistStep, stop);
    this.assistOut.replaceChildren(asked, working);
    this.assistOut.classList.remove('hidden');
    const r = await window.deck.pmAssist(id, text, { selected: this.selected || null, list: this.list }).catch(err => ({ error: String(err?.message || err) }));
    this.assistId = null;
    this.assist.classList.remove('busy');
    this.assistInput.disabled = false;
    this.assistInput.value = '';
    this.assistInput.focus();
    const answer = el('div', 'tickets-assist-answer' + (r.error ? ' err' : ''));
    if (r.error) answer.textContent = r.error;
    else answer.append(typeof markdown === 'function' ? markdown(r.result) : document.createTextNode(r.result));
    const close = el('button', 'icon tickets-assist-close', '×');
    close.type = 'button';
    close.title = 'Close';
    close.onclick = () => this.assistOut.classList.add('hidden');
    this.assistOut.replaceChildren(close, asked, answer);
    window.uiSound?.(r.error ? 'error' : 'done');
    // What it changed shows: the lists and the open ticket read PM again.
    this.load(true);
    if (this.detailTicket && this.selected === this.detailTicket.key) this.select(this.detailTicket);
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
      // The whole of PM's answer (the line above is cut to fit).
      this.lastStatusError = { key: t.key, from: before.status, to: st.name, type: t.type, error: r.error };
      window.toast?.(`${t.key}: ${r.error}`);
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

  // A ticket opened from anywhere else in the app (a PM link on a tile or in
  // a chat): its panel pops up over everything, without leaving where you
  // are. closeDetail puts the panel back in the Tickets view.
  popOut(t) {
    if (!this.globalHost) {
      this.globalHost = el('div', 'ticket-overlay hidden');
      const backdrop = el('div', 'ticket-overlay-backdrop');
      backdrop.onclick = () => this.closeDetail();
      this.globalHost.append(backdrop);
      document.body.append(this.globalHost);
    }
    this.global = true;
    this.globalHost.append(this.detail);
    this.detail.classList.add('global');
    this.globalHost.classList.remove('hidden');
    this.select(t);
  }

  closeDetail() {
    if (this.global) {
      this.global = false;
      this.globalHost.classList.add('hidden');
      this.detail.classList.remove('global');
      this.bodyEl.append(this.detail);
    }
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
    // PM ended the sign-in meanwhile: sign in again, then this ticket opens.
    if (full.notConnected) {
      if (window.pmSignIn && await window.pmSignIn(t.key)) return this.select(t);
      return this.setConnected({ connected: false });
    }
    if (!full.error && full.subtasks?.length) this.subs.set(full.key, { items: full.subtasks, loading: false });
    if (!full.error && t.parentKey && !full.parentKey) full.parentKey = t.parentKey;
    this.renderDetail(full.error ? t : full, full.error || null);
    if (!full.error && this.expanded.has(full.key)) this.renderList();
  }
}

window.TicketsView = TicketsView;
