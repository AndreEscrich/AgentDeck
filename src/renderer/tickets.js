// The Tickets view (the ticket button on the Hub's left side): your Tactile
// PM tickets. It talks to PM with the app's own sign-in (src/pmclient.js),
// so it costs no tokens. Until you connect, it shows a Connect button that
// opens PM's sign-in page in your browser.
//
// Two lists: Mine (assigned to you and not done) and Sprint (every ticket
// in the open sprints your tickets are in), grouped by status. A click
// shows the ticket's details on the right: its description, its subtasks
// and Start agent, which puts the ticket's link on the Hub's message box
// (a Story with two or more open subtasks then gets the ⑂ Split button).
// The last lists are kept, so the view shows them at once and reads them
// again in the background.

const TICKET_LISTS = [['mine', 'Mine'], ['sprint', 'Sprint']];
const CATEGORY_ORDER = { in_progress: 0, todo: 1, done: 2 };
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
    this.search.placeholder = 'Filter by key, title or epic…';
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
    body.append(this.listBox, this.detail);
    this.view.append(bar, body);
    this.list = 'mine';
    this.type = null;
    this.data = {};      // list -> { items, total, at }
    this.selected = null;
    this.loading = new Set();
    this.connected = null;
    try { this.data = JSON.parse(localStorage.getItem('pmTicketLists') || '{}'); } catch { this.data = {}; }
    this.renderTabs();
    this.showDetailEmpty();
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
      && (!q || `${t.key} ${t.title} ${t.epic} ${t.assignee}`.toLowerCase().includes(q)));
    const groups = new Map();
    for (const t of shown) {
      if (!groups.has(t.status)) groups.set(t.status, { category: t.category, color: t.color, text: t.textColor, items: [] });
      groups.get(t.status).items.push(t);
    }
    const frag = document.createDocumentFragment();
    const order = [...groups].sort((a, b) => (CATEGORY_ORDER[a[1].category] ?? 1) - (CATEGORY_ORDER[b[1].category] ?? 1));
    for (const [status, g] of order) {
      const section = el('div', 'tickets-group');
      const head = el('div', 'tickets-group-head');
      const badge = el('span', 'tickets-status', status);
      if (g.color) { badge.style.background = g.color; badge.style.color = g.text || '#222'; }
      head.append(badge, el('span', 'gallery-cat-count', String(g.items.length)));
      section.append(head);
      for (const t of g.items) section.appendChild(this.row(t));
      frag.appendChild(section);
    }
    if (!shown.length) frag.appendChild(el('div', 'gallery-note', d.note || (q || this.type ? 'No ticket matches.' : 'No open tickets.')));
    if (d.total > d.items.length) frag.appendChild(el('div', 'gallery-note', `Showing ${d.items.length} of ${d.total} tickets.`));
    this.listBox.replaceChildren(frag);
  }

  row(t) {
    const row = el('button', 'tickets-row' + (this.selected === t.key ? ' selected' : ''));
    row.type = 'button';
    row.dataset.key = t.key;
    const top = el('div', 'tickets-row-top');
    top.append(el('span', 'tickets-key', t.key), el('span', `tickets-type type-${(t.type || '').toLowerCase()}`, t.type || ''));
    if (t.priority && !/^medium$/i.test(t.priority)) top.append(el('span', `tickets-prio prio-${t.priority.toLowerCase()}`, t.priority));
    row.append(top, el('div', 'tickets-title', t.title));
    const meta = [t.epic, this.list === 'sprint' ? t.assignee || 'Unassigned' : t.sprint].filter(Boolean).join(' · ');
    if (meta) row.append(el('div', 'tickets-meta', meta));
    row.onclick = () => this.select(t);
    return row;
  }

  showDetailEmpty() {
    this.detail.replaceChildren(el('div', 'gallery-note', 'Pick a ticket to see its description and subtasks.'));
  }

  async select(t) {
    this.selected = t.key;
    for (const r of this.listBox.querySelectorAll('.tickets-row')) r.classList.toggle('selected', r.dataset.key === t.key);
    this.renderDetail(t, null);
    const full = await window.deck.pmTicket(t.key).catch(err => ({ error: String(err?.message || err) }));
    if (this.selected !== t.key) return;
    if (full.notConnected) return this.setConnected({ connected: false });
    this.renderDetail(full.error ? t : full, full.error || null);
  }

  renderDetail(t, error) {
    const box = el('div', 'ticket-detail');
    const head = el('div', 'ticket-head');
    const link = el('a', 'ticket-key', t.key);
    link.href = pmItemUrl(t.key);
    link.target = '_blank';
    link.title = 'Open it in PM';
    const badge = el('span', 'tickets-status', t.status);
    if (t.color) { badge.style.background = t.color; badge.style.color = t.textColor || '#222'; }
    head.append(link, el('span', `tickets-type type-${(t.type || '').toLowerCase()}`, t.type || ''), badge);
    box.append(head, el('h2', 'ticket-title', t.title));
    const facts = [['Assignee', t.assignee], ['Also', t.assignee2], ['Sprint', t.sprint], ['Epic', t.epicName || t.epic], ['Priority', t.priority], ['Reporter', t.author]].filter(([, v]) => v);
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
        row.append(el('span', 'tickets-key', s.key), el('span', 'ticket-sub-title', s.title), el('span', 'ticket-sub-status', s.status));
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
