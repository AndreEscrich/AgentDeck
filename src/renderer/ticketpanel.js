// The ticket panel: the floating panel a click on a key opens in the
// Tickets view (tickets.js), laid out like PM's own ticket view.
//
// On the left: the title (the pencil edits it), Description (Edit changes
// it), Comments, and Subtasks (a progress bar, each subtask's status,
// priority and assignee; + adds one). On the right: the status, a small
// Attachments field (a click opens a file in the browser; + Add or files
// dropped on it upload), and the fields, each one editable: Assignee (and Assign to me), Assignee 2, Epic,
// Sprint, Components, Estimate, Priority, Story Points, Team and the
// project's custom fields for the ticket's type (Testable revision, Branch,
// Found in, ...). A subtask shows only the fields a subtask has.
//
// Every change goes to PM at once through the app's own sign-in
// (src/pmclient.js: pm_update_task / pm_update_subtask), and the panel then
// shows the ticket as PM has it now. The methods join TicketsView.

(() => {
  const P = TicketsView.prototype;
  const PRIORITIES = ['Critical', 'Highest', 'High', 'Medium', 'Low', 'Lowest'];
  const POINTS = [1, 2, 3, 5, 8, 13, 21];
  const up = d => `<path d="${d}" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  const PRIORITY_ICONS = {
    Critical: ['#e5493a', up('M6 11l6-5 6 5') + up('M6 17l6-5 6 5')],
    Highest: ['#e5493a', up('M6 11l6-5 6 5') + up('M6 17l6-5 6 5')],
    High: ['#e5493a', up('M6 15l6-6 6 6')],
    Medium: ['#f0a030', up('M6 10h12') + up('M6 15h12')],
    Low: ['#4c9aff', up('M6 9l6 6 6-6')],
    Lowest: ['#4c9aff', up('M6 7l6 5 6-5') + up('M6 13l6 5 6-5')],
  };
  const FILE = '<svg width="14" height="14" viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/><path d="M14 3v4h4" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>';

  function priorityIcon(p) {
    const span = el('span', 'tp-priority');
    const icon = PRIORITY_ICONS[p];
    if (icon) span.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" style="color:${icon[0]}">${icon[1]}</svg>`;
    else span.textContent = '—';
    span.title = p ? `Priority: ${p}` : 'No priority';
    return span;
  }
  const avatar = personAvatar;   // tickets.js
  function minutesText(m) {
    if (!m) return '';
    const h = Math.floor(m / 60), r = m % 60;
    return [h ? `${h}h` : '', r ? `${r}m` : ''].filter(Boolean).join(' ');
  }
  // "2h 30m", "1.5h", "45m", "1d" (8 hours) or a plain number of hours.
  function parseMinutes(text) {
    text = String(text || '').trim().toLowerCase();
    if (!text) return null;
    let total = 0, found = false;
    for (const [, n, unit] of text.matchAll(/(\d+(?:[.,]\d+)?)\s*([dhm]?)/g)) {
      found = true;
      total += parseFloat(n.replace(',', '.')) * (unit === 'd' ? 480 : unit === 'm' ? 1 : 60);
    }
    return found && total > 0 ? Math.round(total) : NaN;
  }
  function fileSize(n) {
    if (!n) return '';
    return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
  }
  const projectOf = t => t.project || String(t.key || '').split('-')[0];

  // ---------- data the panel needs besides the ticket ----------

  P.panelOptions = function (project) {
    this.optionLists ||= new Map();
    const hit = this.optionLists.get(project);
    if (hit && !hit.error) return hit;
    if (!hit?.loading) {
      this.optionLists.set(project, { loading: true });
      this.optionsFor(project).then(r => {
        this.optionLists.set(project, r?.error ? { error: r.error } : r);
        if (r?.statuses?.length) this.statusLists.set(project, r.statuses);
        if (this.detailTicket && projectOf(this.detailTicket) === project) this.renderDetail(this.detailTicket, null);
      });
    }
    return null;
  };

  // Everyone the view has seen, for the assignee fields' suggestions.
  P.people = function () {
    const names = new Set();
    const add = t => { for (const n of [t?.assignee, t?.assignee2, t?.author]) if (n && !n.includes('@')) names.add(n); };
    for (const d of Object.values(this.data)) (d.items || []).forEach(add);
    for (const d of this.subs.values()) (d.items || []).forEach(add);
    add(this.detailTicket);
    (this.detailTicket?.subtasks || []).forEach(add);
    // You first, then everyone else A to Z.
    const me = this.myName();
    return [...names].sort((a, b) => (b === me) - (a === me) || a.localeCompare(b));
  };

  // Your name as PM shows it: the assignee of most of your tickets.
  P.myName = function () {
    const count = new Map();
    for (const d of Object.values(this.data)) for (const t of d.items || []) if (t.assignee && !t.assignee.includes('@')) count.set(t.assignee, (count.get(t.assignee) || 0) + 1);
    return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] || this.email || 'Agent Hub';
  };

  // Attachments and comments, read when a ticket opens: key -> { items,
  // loading, error, at }. A list read before the ticket last opened is read
  // again (an agent or PM's web page may have added files or comments since);
  // the panel shows the old list until the new one arrives.
  P.panelList = function (store, key, read) {
    this[store] ||= new Map();
    const d = this[store].get(key);
    const fetch = () => read().then(r => {
      const old = this[store].get(key);
      this[store].set(key, Array.isArray(r) ? { items: r, at: Date.now() } : old?.items ? { ...old, refreshing: false } : { error: r?.error || 'PM sent nothing.', at: Date.now() });
      if (this.detailTicket?.key === key) this.renderDetail(this.detailTicket, null);
    });
    if (!d) {
      this[store].set(key, { loading: true });
      fetch();
      return { loading: true };
    }
    if (!d.loading && !d.refreshing && (d.at || 0) < (this.panelOpenedAt || 0)) {
      this[store].set(key, { ...d, refreshing: true });
      fetch();
    }
    return d;
  };

  // ---------- saving ----------

  // Sends some fields to PM; the panel then shows the ticket as PM has it.
  P.saveFields = async function (t, fields) {
    this.panelBusy = true;
    this.detail.querySelector('.tp')?.classList.add('busy');
    const r = await window.deck.pmUpdate({ key: t.key, id: t.id, project: projectOf(t), subtask: !!t.subtask, fields })
      .catch(err => ({ error: String(err?.message || err) }));
    this.panelBusy = false;
    if (r?.notConnected) return this.setConnected({ connected: false });
    this.afterSave(t, r);
  };

  P.afterSave = function (t, r) {
    if (!r || r.error) {
      this.panelError = r?.error || 'PM did not answer.';
      if (this.detailTicket?.key === t.key) this.renderDetail(this.detailTicket, null);
      return;
    }
    this.panelError = null;
    if (t.parentKey) r.parentKey = t.parentKey;
    const shown = ['title', 'status', 'category', 'color', 'textColor', 'statusId', 'priority', 'assignee', 'assignee2', 'sprint', 'epic'];
    for (const c of this.copies(r.key)) for (const f of shown) if (f in r) c[f] = r[f];
    // Your own change: what you saw, so it does not play as news later.
    for (const c of this.copies(r.key)) this.remember(c);
    if (!r.subtask && r.subtasks) this.subs.set(r.key, { items: r.subtasks });
    try { localStorage.setItem('pmTicketLists', JSON.stringify(this.data)); } catch { /* shown anyway */ }
    this.renderList();
    if (this.selected === r.key) this.renderDetail(r, null);
  };

  // ---------- what changed since you last looked ----------
  //
  // A ticket with unread notifications (pmnotify.js) shows them when its
  // panel opens: the status changes from the old one to the new one, and
  // new comments and subtasks slide in, lit up. A few seconds later they
  // count as read (the bells and red counts go).
  P.newsOf = function (t) {
    if (this.news?.key === t.key) return this.news;
    const items = this.unreadFor(t.key);
    const subKey = n => (/added ([A-Z][A-Z0-9]*-\d+)/.exec(n.text) || [])[1];
    this.news = {
      key: t.key, ids: items.map(n => n.id), status: null, morphed: false, readTimer: null,
      comments: new Set(items.filter(n => n.kind === 'comment').map(n => n.at)),
      subs: new Set(items.filter(n => n.kind === 'subtask').map(subKey).filter(Boolean)),
      shown: new Set(),    // what already slid in (later renders keep it lit, without sliding again)
    };
    return this.news;
  };

  // Lights up a new comment or subtask row: it slides in the first time,
  // and stays lit until the news is read.
  P.markNew = function (row, id, i = 0) {
    const news = this.news;
    if (!news || news.read) return;
    if (news.shown.has(id)) { row.classList.add('tp-new-lit'); return; }
    news.shown.add(id);
    row.classList.add('tp-new');
    row.style.animationDelay = `${0.25 + i * 0.15}s`;
  };

  // Opening the ticket counts as seeing what changed: its notifications are
  // read at once (its bell in the list and the red counts go). The panel
  // keeps the changes lit for a few seconds, then drops "was …" and the
  // light.
  P.readNewsSoon = function (t) {
    const news = this.newsOf(t);
    if (!news.ids.length || news.sent || t.description === undefined) return;
    news.sent = true;
    window.deck.pmReadNotifications(news.ids).then(r => this.setNotifications(r));
    news.readTimer = setTimeout(() => {
      news.read = true;
      if (this.detailTicket?.key === t.key && !this.editing) this.renderDetail(this.detailTicket, null);
    }, 8000);
  };

  // ---------- the panel ----------

  P.renderDetail = function (t, error) {
    if (t.isEpic) return this.renderEpic(t, error);
    const same = this.detailTicket?.key === t.key;
    const scroll = same ? this.detail.scrollTop : 0;
    if (!same) { this.panelOpenedAt = Date.now(); this.panelError = null; this.editing = null; this.editingComment = null; this.news = null; this.descTab = 'description'; this.deleting = null; }
    this.newsOf(t);
    this.detailTicket = t;
    const box = el('div', 'tp' + (this.panelBusy ? ' busy' : ''));
    box.append(this.panelTop(t), this.panelTitle(t));
    for (const text of [error, this.panelError]) if (text) box.append(el('div', 'tp-error', text));
    const cols = el('div', 'tp-cols');
    const main = el('div', 'tp-main');
    const side = el('div', 'tp-side');
    cols.append(main, side);
    box.append(cols);
    if (t.description === undefined && !error) main.append(el('div', 'gallery-note', 'Reading the ticket…'));
    else {
      // Description and Comments together; the subtasks after them.
      main.append(this.panelDescription(t), this.panelComments(t));
      if (!t.subtask) main.append(this.panelSubtasks(t));
    }
    this.panelSide(t, side);
    this.detail.replaceChildren(box);
    this.detail.scrollTop = scroll;
    this.readNewsSoon(t);
  };

  // An epic opened from the chain: its name, its status and its tickets
  // (each opens with a click).
  P.renderEpic = function (t, error) {
    const same = this.detailTicket?.key === t.key;
    const scroll = same ? this.detail.scrollTop : 0;
    this.detailTicket = t;
    const box = el('div', 'tp tp-epic');
    box.append(this.panelTop(t));
    const row = el('div', 'tp-title-row');
    row.append(el('h2', 'tp-title', t.title || t.key));
    if (t.status) row.append(el('span', 'tp-epic-status', t.status));
    box.append(row);
    if (error) box.append(el('div', 'tp-error', error));
    if (!t.tasks) box.append(el('div', 'gallery-note', 'Reading the epic…'));
    else {
      const list = el('div', 'tp-subs tp-epic-tasks');
      const open = t.tasks.filter(x => x.category !== 'done').length;
      list.append(el('div', 'tp-label', `Tickets · ${t.tasks.length}${open !== t.tasks.length ? ` (${open} open)` : ''}`));
      const order = { in_progress: 0, todo: 1, done: 2 };
      for (const x of [...t.tasks].sort((a, b) => (order[a.category] ?? 1) - (order[b.category] ?? 1) || b.seq - a.seq)) {
        const r = el('button', 'tp-sub' + (x.category === 'done' ? ' done' : ''));
        r.type = 'button';
        r.append(typeIcon(x.type), el('span', 'tp-sub-key', shortKey(x.key)), ticketTitle(x.title, 'tp-sub-title'),
          el('span', 'tp-epic-who', x.assignee || 'Unassigned'), el('span', 'tp-epic-st', x.status || ''));
        r.title = x.title;
        r.onclick = () => this.select({ ...x });
        list.append(r);
      }
      box.append(list);
    }
    this.detail.replaceChildren(box);
    this.detail.scrollTop = scroll;
  };

  P.panelTop = function (t) {
    const top = el('div', 'tp-top');
    const crumbs = el('div', 'tp-crumbs');
    const sep = () => el('span', 'tp-sep', '›');
    // The chain Epic › Story › Subtask: a click on the epic or the story opens
    // it here. A ticket's ▾ after its epic picks another epic.
    const goto = (key, extra = {}) => this.select({ key, project: key.split('-')[0], title: '', type: '', ...extra });
    const epicName = t.epicName || t.epic;
    if (t.isEpic) {
      const icon = typeIcon('epic');
      crumbs.append(icon, el('span', 'tp-crumb tp-crumb-here', t.title || t.key));
      const tools = el('div', 'tp-tools');
      const close = el('button', 'icon tp-close');
      close.type = 'button';
      close.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
      close.title = 'Close (Escape)';
      close.onclick = () => this.closeDetail();
      tools.append(close);
      top.append(crumbs, tools);
      return top;
    }
    if (epicName) {
      const e = t.epicKey ? el('button', 'tp-crumb tp-crumb-link tp-crumb-name') : el('span', 'tp-crumb');
      e.append(epicTag(epicName));
      if (t.epicKey) { e.type = 'button'; e.title = `Open the epic ${epicName}`; e.onclick = () => goto(t.epicKey, { isEpic: true, title: epicName }); }
      crumbs.append(e);
    }
    if (t.subtask) {
      if (epicName) crumbs.append(sep());
    } else {
      const epic = el('button', 'tp-crumb tp-crumb-epic', epicName ? '▾' : '⚑ No epic ▾');
      epic.type = 'button';
      epic.title = 'Change the epic';
      epic.onclick = () => this.openMenu(epic, 'epic:' + t.key, async menu => {
        let o = this.panelOptions(projectOf(t));
        for (let i = 0; i < 40 && !o?.epics; i++) { await new Promise(r => setTimeout(r, 250)); o = this.panelOptions(projectOf(t)); }
        if (!o?.epics) throw new Error('Could not read the project\'s epics.');
        menu.replaceChildren();
        menu.classList.add('tp-epic-menu');
        const pick = id => { this.closeStatusMenu(); if ((id || null) !== (t.epicId || null)) this.saveFields(t, { epicId: id }); };
        // Newest epics first: by when they were made (PM's createdAt, else
        // the time in the epic's id).
        const made = e => Date.parse(e.createdAt) || (parseInt(String(e.id).slice(0, 8), 16) * 1000) || 0;
        const epics = o.epics.filter(e => !e.done || e.id === t.epicId).sort((a, b) => made(b) - made(a));
        // A search box on top: typing filters the list, and the first epic
        // left is the one Enter picks (↑ ↓ move).
        const search = document.createElement('input');
        search.type = 'search';
        search.className = 'tp-epic-search';
        search.placeholder = 'Search epics…';
        const list = el('div', 'tp-epic-list');
        menu.append(search, list);
        const items = [];
        const none = el('button', 'tickets-status-item' + (t.epicId ? '' : ' on'), 'No epic');
        none.type = 'button';
        none.onclick = () => pick(null);
        items.push({ el: none, text: 'no epic', id: null });
        for (const e of epics) {
          const item = el('button', 'tickets-status-item tp-epic-item' + (e.id === t.epicId ? ' on' : ''));
          item.type = 'button';
          item.append(epicDot(e.name), el('span', null, e.name));
          item.onclick = () => pick(e.id);
          items.push({ el: item, text: `${e.name} ${e.key}`.toLowerCase(), id: e.id });
        }
        list.append(...items.map(i => i.el));
        let shown = items;
        let at = 0;
        const mark = () => {
          items.forEach(i => i.el.classList.remove('focus'));
          const cur = shown[at];
          if (cur) { cur.el.classList.add('focus'); if (search.value) cur.el.scrollIntoView({ block: 'nearest' }); }
        };
        search.oninput = () => {
          const q = search.value.trim().toLowerCase();
          shown = q ? items.filter(i => i.id && q.split(/\s+/).every(w => i.text.includes(w))) : items;
          for (const i of items) i.el.classList.toggle('hidden', !shown.includes(i));
          at = 0;
          list.scrollTop = 0;
          mark();
        };
        search.onkeydown = e => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!shown.length) return;
            at = (at + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
            mark();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (shown[at]) pick(shown[at].id);
          }
        };
        requestAnimationFrame(() => search.focus());
      });
      crumbs.append(epic, sep());
    }
    if (t.parentKey) {
      const parent = el('button', 'tp-crumb tp-crumb-link', shortKey(t.parentKey));
      parent.type = 'button';
      parent.title = `Back to ${t.parentKey}`;
      parent.onclick = () => this.select({ key: t.parentKey, project: projectOf(t), title: t.parentTitle || '', type: t.parentType || 'Story' });
      if (t.parentTitle) { parent.textContent = ''; parent.append(el('span', 'tp-crumb-key', shortKey(t.parentKey)), ticketTitle(t.parentTitle, 'tp-crumb-title')); parent.title = `Open ${t.parentKey}: ${t.parentTitle}`; }
      crumbs.append(parent, sep());
    }
    let icon;
    if (t.subtask) { icon = el('span', 'tickets-type-icon'); icon.innerHTML = SUBTASK_ICON; icon.title = 'Subtask'; }
    else icon = typeIcon(t.type);
    const link = el('a', 'tp-key', shortKey(t.key));
    link.href = pmItemUrl(t.key);
    link.dataset.external = '1';
    link.target = '_blank';
    link.title = `Open ${t.key} in PM`;
    // Copy, to hand the ticket to an agent: a click copies its PM link,
    // ⇧-click its key.
    const copy = el('button', 'tp-copy');
    copy.type = 'button';
    copy.title = `Copy the link to ${t.key} (⇧-click: copy ${t.key})`;
    copy.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
    const label = el('span', 'tp-copy-label');
    copy.appendChild(label);
    // The note stays when the panel redraws meanwhile (comments arrive).
    const shown = this.copyNote?.key === t.key && this.copyNote.until > Date.now() ? this.copyNote : null;
    const showNote = note => {
      label.textContent = note.text;
      copy.classList.add('copied');
      setTimeout(() => { if (this.copyNote === note) { copy.classList.remove('copied'); label.textContent = ''; } }, note.until - Date.now());
    };
    if (shown) showNote(shown);
    copy.onclick = e => {
      e.stopPropagation();
      const key = e.shiftKey;
      const text = key ? t.key : pmItemUrl(t.key);
      const done = () => {
        this.copyNote = { key: t.key, text: key ? 'Key copied' : 'Link copied', until: Date.now() + 1400 };
        showNote(this.copyNote);
      };
      (window.deck?.copyText ? window.deck.copyText(text) : navigator.clipboard.writeText(text)).then(done, () => {});
    };
    crumbs.append(icon, link, copy);
    const tools = el('div', 'tp-tools');
    // An agent already on this ticket: Open agent instead of Start agent.
    const agent = this.agentFor?.(t.key);
    const start = el('button', 'gallery-use' + (agent ? ' tp-open-agent' : ''), agent ? 'Open agent' : 'Start agent');
    start.type = 'button';
    start.title = agent ? `Open "${agent.title || 'Agent'}", the agent working on ${t.key} (${agentStateText(agent)})`
      : 'Put the ticket on the Hub\'s message box: say what to do and send. A Story with two or more subtasks gets the ⑂ Split button there.';
    start.onclick = () => {
      // Open agent: the chat grows out of this button, and ← Tickets comes back here.
      if (agent) { this.onOpenAgent?.(agent.id, t.key, start); this.closeDetail(); return; }
      this.closeDetail();
      this.onStart?.(t);
    };
    const open = el('a', 'gallery-action', 'Open in PM');
    open.href = pmItemUrl(t.key);
    open.dataset.external = '1';
    open.target = '_blank';
    const close = el('button', 'icon ticket-close', '✕');
    close.type = 'button';
    close.title = 'Close (Escape)';
    close.onclick = () => this.closeDetail();
    // Delete: asks first, in its place (what goes, and that PM keeps it 60
    // days), then the panel goes up a level: a subtask's story, a ticket's
    // epic, or closes.
    const del = el('button', 'icon tp-delete');
    del.type = 'button';
    del.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    del.title = t.subtask ? 'Delete this subtask' : 'Delete this ticket';
    // The question stays while the panel redraws (more of the ticket arrives).
    const askDelete = () => {
      const ask = el('div', 'tp-delete-ask');
      const subs = t.subtasks?.length || 0;
      ask.append(el('span', null, `Delete ${t.key}${!t.subtask && subs ? ` and its ${subs} subtask${subs === 1 ? '' : 's'}` : ''}? PM keeps it 60 days.`));
      const yes = el('button', 'tp-delete-yes', 'Delete');
      yes.type = 'button';
      const no = el('button', 'gallery-action', 'Cancel');
      no.type = 'button';
      no.onclick = () => { this.deleting = null; ask.replaceWith(tools); };
      yes.onclick = async () => {
        yes.disabled = no.disabled = true;
        yes.textContent = 'Deleting…';
        this.deleting = null;
        const r = await window.deck.pmRemove({ key: t.key, id: t.id, project: projectOf(t), subtask: !!t.subtask }).catch(err => ({ error: String(err?.message || err) }));
        if (r?.notConnected) return this.setConnected({ connected: false });
        if (r?.error) { this.panelError = r.error; this.renderDetail(t, null); return; }
        window.toast?.(`${t.key} deleted. PM keeps it 60 days, so it can be brought back there.`);
        this.forget(t.key);
        if (t.subtask && t.parentKey) this.select({ key: t.parentKey, project: projectOf(t), title: t.parentTitle || '', type: t.parentType || 'Story' });
        else if (!t.subtask && t.epicKey) this.select({ key: t.epicKey, project: t.epicKey.split('-')[0], isEpic: true, title: t.epicName || '' });
        else this.closeDetail();
        this.load(true);
      };
      ask.append(yes, no);
      return ask;
    };
    del.onclick = () => { this.deleting = t.key; tools.replaceWith(askDelete()); };
    tools.append(start, open, del, close);
    top.append(crumbs, this.deleting === t.key ? askDelete() : tools);
    return top;
  };

  P.panelTitle = function (t) {
    const row = el('div', 'tp-title-row');
    if (this.editing === 'title') {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'tp-title-input';
      input.value = t.title;
      const done = save => {
        this.editing = null;
        const v = input.value.trim();
        if (save && v && v !== t.title) this.saveFields(t, { title: v });
        else this.renderDetail(t, null);
      };
      input.onkeydown = e => {
        if (e.key === 'Enter') { e.preventDefault(); done(true); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
      };
      input.onblur = () => { if (this.editing === 'title') done(true); };
      row.append(input);
      requestAnimationFrame(() => { input.focus(); input.select(); });
      return row;
    }
    const h = el('h2', 'tp-title');
    h.appendChild(t.title ? ticketTitle(t.title) : document.createTextNode(shortKey(t.key)));
    // A double-click on the title edits it (no pencil button).
    h.title = 'Double-click to edit the title';
    h.ondblclick = e => { if (e.target.closest('a, button')) return; window.getSelection()?.removeAllRanges(); this.editing = 'title'; this.renderDetail(t, null); };
    row.append(h);
    return row;
  };

  // A section with a heading that folds it (remembered).
  P.panelSection = function (id, title, body, ...extra) {
    if (!this.folded) { try { this.folded = new Set(JSON.parse(localStorage.getItem('pmPanelFolded') || '[]')); } catch { this.folded = new Set(); } }
    const sec = el('section', 'tp-section' + (this.folded.has(id) ? ' folded' : ''));
    const head = el('div', 'tp-section-head');
    const fold = el('button', 'tp-fold');
    fold.type = 'button';
    fold.innerHTML = CHEVRON;
    fold.append(el('span', null, title));
    fold.onclick = () => {
      if (this.folded.has(id)) this.folded.delete(id); else this.folded.add(id);
      try { localStorage.setItem('pmPanelFolded', JSON.stringify([...this.folded])); } catch { /* this run only */ }
      sec.classList.toggle('folded');
    };
    head.append(fold, ...extra);
    sec.append(head, body);
    return sec;
  };

  // Description and Attachments share a section: two tabs in its heading,
  // Attachments with how many there are, so you know before you switch.
  P.panelDescription = function (t) {
    const canAttach = !!t.id && t.description !== undefined;
    const files = canAttach ? this.panelList('attachLists', t.key, () => window.deck.pmAttachments({ project: projectOf(t), id: t.id })) : null;
    const tab = canAttach && ['attachments', 'history'].includes(this.descTab) ? this.descTab : 'description';
    const tabs = el('div', 'tp-tabs');
    const tabButton = (id, label, count = null) => {
      const b = el('button', 'tp-tab' + (tab === id ? ' on' : ''));
      b.type = 'button';
      b.append(el('span', null, label));
      if (count !== null) b.append(el('span', 'tp-tab-count', String(count)));
      b.onclick = () => { if (tab !== id) { this.descTab = id; this.editing = null; this.renderDetail(t, null); } };
      return b;
    };
    tabs.append(tabButton('description', 'Description'));
    if (canAttach) tabs.append(tabButton('attachments', 'Attachments', files?.items ? files.items.length : '…'), tabButton('history', 'History'));
    if (tab === 'history') {
      const body = el('div', 'tp-section-body');
      body.append(this.panelHistory(t));
      return this.panelSection('description', '', body, tabs);
    }
    if (tab === 'attachments') {
      const body = el('div', 'tp-section-body');
      body.append(this.panelAttachments(t, { inTab: true }));
      return this.panelSection('description', '', body, tabs);
    }
    const body = el('div', 'tp-section-body');
    if (this.editing === 'description') {
      const bar = el('div', 'tp-editbar');
      for (const [cmd, label, title] of [['bold', 'B', 'Bold'], ['italic', 'I', 'Italic'], ['insertUnorderedList', '•', 'List'], ['insertOrderedList', '1.', 'Numbered list']]) {
        const b = el('button', 'tp-editbtn', label);
        b.type = 'button';
        b.title = title;
        b.onmousedown = e => { e.preventDefault(); document.execCommand(cmd); };
        bar.append(b);
      }
      const box = el('div', 'tp-desc tp-desc-edit msg-text');
      box.contentEditable = 'true';
      box.innerHTML = DOMPurify.sanitize(t.description || '', { ADD_ATTR: ['data-media-id', 'data-file-name', 'data-content-type', 'target'] });
      const media = new Map((t.media || []).map(m => [m.id, m]));
      for (const img of box.querySelectorAll('img[data-media-id]')) { const m = media.get(img.dataset.mediaId); if (m?.url) img.src = m.url; }
      const actions = el('div', 'tp-edit-actions');
      const save = el('button', 'gallery-use', 'Save');
      save.type = 'button';
      save.onclick = () => {
        const copy = box.cloneNode(true);
        for (const m of copy.querySelectorAll('img[data-media-id], video[data-media-id]')) m.removeAttribute('src');   // PM's links expire; PM stores the id
        this.editing = null;
        this.saveFields(t, { description: copy.innerHTML });
      };
      const cancel = el('button', 'gallery-action', 'Cancel');
      cancel.type = 'button';
      cancel.onclick = () => { this.editing = null; this.renderDetail(t, null); };
      box.onkeydown = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel.onclick(); } };
      actions.append(save, cancel);
      body.append(bar, box, actions);
      requestAnimationFrame(() => box.focus());
    } else {
      // A double-click on the description edits it (no pencil button); one
      // on a link, a ticket card, a picture or a video does what it does.
      const startEdit = () => { window.getSelection()?.removeAllRanges(); this.editing = 'description'; this.renderDetail(t, null); };
      if (t.description) {
        const desc = this.description(t);
        desc.ondblclick = e => { if (!e.target.closest('a, button, img, video, .ticket-card, .pm-key')) startEdit(); };
        body.append(desc);
      } else {
        const empty = el('div', 'tp-desc tp-empty', 'Add a description…');
        empty.onclick = startEdit;
        body.append(empty);
      }
    }
    return this.panelSection('description', '', body, tabs);
  };

  // History: who changed what and when, newest first, as PM's own page
  // lists it (pmclient.history reads PM's audit log). Read again each time
  // the ticket opens, like the attachments and comments.
  P.panelHistory = function (t) {
    const box = el('div', 'tp-history');
    const d = this.panelList('historyLists', t.key, () => window.deck.pmHistory({ project: projectOf(t), id: t.id, subtask: !!t.subtask }));
    if (d.error) { box.append(el('div', 'tickets-error', d.error)); return box; }
    if (!d.items) { box.append(el('div', 'tp-label', 'Reading the history from PM…')); return box; }
    if (!d.items.length) { box.append(el('div', 'tp-label', 'No changes yet.')); return box; }
    for (const h of d.items) {
      const row = el('div', 'tp-hist');
      const head = el('div', 'tp-hist-head');
      const when = el('span', 'tp-hist-when', h.at ? timeAgoText(Date.parse(h.at)) : '');
      if (h.at) when.title = new Date(h.at).toLocaleString();
      head.append(el('span', 'tp-hist-who', h.who), el('span', 'tp-hist-what', h.action === 'create' ? 'created the ticket' : h.action === 'delete' ? 'deleted the ticket' : h.action === 'update' ? 'changed' : h.action), when);
      row.append(head);
      for (const c of h.changes || []) {
        const line = el('div', 'tp-hist-change');
        line.append(el('span', 'tp-hist-field', c.field));
        if (c.edited) line.append(el('span', 'tp-hist-to', 'edited'));
        else {
          if (c.from) line.append(el('span', 'tp-hist-from', c.from), el('span', 'tp-hist-arrow', '→'));
          line.append(el('span', 'tp-hist-to', c.to || 'none'));
        }
        row.append(line);
      }
      box.append(row);
    }
    return box;
  };

  // PM's HTML, cleaned, with its images and videos as PM's short-lived links
  // (a description's, or a comment's: t.media); without a link they open in PM.
  P.description = function (t, html = t.description) {
    const div = el('div', 'tp-desc msg-text');
    // Agents and PM's API often save plain text (lines split by \n), which PM's
    // page shows line by line; HTML ignores \n, so turn the lines into <br>.
    // Text with block tags (<p>, <ul>, …) is real HTML and stays as it is.
    html = String(html || '');
    if (!/<(p|div|ul|ol|li|br|h[1-6]|pre|table|blockquote)\b/i.test(html)) {
      if (!/<[a-z]/i.test(html)) html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      html = html.replace(/\r?\n/g, '<br>');
    }
    div.innerHTML = DOMPurify.sanitize(html, { ADD_TAGS: ['video'], ADD_ATTR: ['data-media-id', 'data-file-name', 'target'] });
    // Other tickets named in the text (M2S-3627, or a PM link) become ticket
    // cards, like in a chat: a click opens that ticket here.
    learnPmPrefix(projectOf(t));
    linkPmKeys(div);
    decorateLinks(div);
    const media = new Map((t.media || []).map(m => [m.id, m]));
    for (const img of div.querySelectorAll('img[data-media-id]')) {
      const m = media.get(img.dataset.mediaId);
      if (m?.url) {
        img.src = m.url;
        img.onclick = () => openImageOverlay(m.url, [...div.querySelectorAll('img')].map(i => i.src));
      } else {
        const a = el('a', 'ticket-media', `🖼 ${img.dataset.fileName || 'Image'} (open in PM)`);
        a.href = pmItemUrl(t.key);
        a.dataset.external = '1';
        a.target = '_blank';
        img.replaceWith(a);
      }
    }
    for (const video of div.querySelectorAll('video')) {
      const m = media.get(video.dataset.mediaId);
      if (m?.url) {
        // PM's link plays here (it lasts about a day; the panel reads a new one each time it opens).
        video.src = m.url;
        video.controls = true;
        video.muted = true;
        video.playsInline = true;
        video.className = 'tp-video';
        continue;
      }
      const a = el('a', 'ticket-media', `▶ ${video.dataset.fileName || 'Video'} (open in PM)`);
      a.href = pmItemUrl(t.key);
      a.dataset.external = '1';
      a.target = '_blank';
      video.replaceWith(a);
    }
    for (const a of div.querySelectorAll('a[href]')) a.target = '_blank';
    return div;
  };

  // Attachments: a small field on the right, under the status, and the
  // Attachments tab beside Description. Files dropped on either (pictures,
  // videos, anything) or + Add upload to PM. In the tab, pictures and
  // videos show in the app (PM's short-lived links, read when the tab opens);
  // a click on a picture enlarges it, other files open in the browser.
  P.panelAttachments = function (t, { inTab = false } = {}) {
    const box = el('div', 'tp-field tp-attach' + (inTab ? ' in-tab' : ''));
    const project = projectOf(t);
    const d = this.panelList('attachLists', t.key, () => window.deck.pmAttachments({ project, id: t.id }));
    const head = el('div', 'tp-attach-head');
    const label = el('span', 'tp-label', inTab ? (d.items && !d.items.length ? 'No attachments yet. Add files, or drop them here.' : '') : 'Attachments' + (d.items?.length ? ` · ${d.items.length}` : ''));
    const add = el('button', 'tp-link', this.uploading === t.key ? 'Uploading…' : '+ Add');
    add.type = 'button';
    add.title = 'Attach files (or drop them here)';
    head.append(label, add);
    box.append(head);
    if (d.error) box.append(el('div', 'tickets-error', d.error));
    const kind = a => (/^image\//.test(a.type) || /\.(png|jpe?g|gif|webp)$/i.test(a.name) ? 'image' : /^video\//.test(a.type) || /\.(mp4|mov|webm|m4v)$/i.test(a.name) ? 'video' : '');
    // In the tab: pictures and videos as previews, the other files as rows.
    const media = inTab ? (d.items || []).filter(kind) : [];
    if (media.length) {
      this.attachLinks ||= new Map();
      const cached = this.attachLinks.get(t.key);
      const links = cached && Date.now() - cached.at < 30 * 60 * 1000 ? cached.links : null;
      if (!links && !cached?.loading) {
        this.attachLinks.set(t.key, { loading: true, at: 0, links: null });
        window.deck.pmAttachmentLinks({ project, ids: media.map(a => a.id) }).then(r => {
          this.attachLinks.set(t.key, { at: Date.now(), links: r?.error ? {} : r });
          if (this.detailTicket?.key === t.key && this.descTab === 'attachments') this.renderDetail(this.detailTicket, null);
        });
      }
      const grid = el('div', 'tp-media-grid');
      for (const a of media) {
        const cell = el('div', 'tp-media');
        const link = links?.[a.id];
        if (!link) cell.append(el('div', 'tp-media-wait', links ? 'No preview' : 'Loading…'));
        else if (kind(a) === 'image') {
          const img = document.createElement('img');
          img.src = link.preview;
          img.alt = a.name;
          img.onclick = () => openImageOverlay(link.preview, media.filter(m => kind(m) === 'image' && links[m.id]).map(m => links[m.id].preview));
          cell.append(img);
        } else {
          const video = document.createElement('video');
          video.src = link.preview;
          video.controls = true;
          video.preload = 'metadata';
          video.playsInline = true;
          cell.append(video);
        }
        const name = el('div', 'tp-media-name');
        name.append(el('span', null, a.name), el('span', 'tp-file-size', fileSize(a.size)));
        cell.append(name);
        grid.append(cell);
      }
      box.append(grid);
    }
    for (const a of (d.items || []).filter(a => !media.includes(a))) {
      const b = el('button', 'tp-file');
      b.type = 'button';
      const icon = el('span', 'tp-file-icon');
      icon.innerHTML = FILE;
      b.append(icon, el('span', 'tp-file-name', a.name), el('span', 'tp-file-size', fileSize(a.size)));
      b.title = `Open ${a.name} in the browser`;
      b.onclick = async () => {
        b.classList.add('busy');
        const r = await window.deck.pmOpenAttachment({ project, attachmentId: a.id });
        b.classList.remove('busy');
        if (r?.error) { this.panelError = r.error; this.renderDetail(t, null); }
      };
      box.append(b);
    }
    const upload = async paths => {
      if (this.uploading) return;
      this.uploading = t.key;
      this.renderDetail(t, null);
      const r = await window.deck.pmAttach({ key: t.key, project, projectId: t.projectId, id: t.id, paths }).catch(err => ({ error: String(err?.message || err) }));
      this.uploading = null;
      if (Array.isArray(r)) this.attachLists.set(t.key, { items: r, at: Date.now() });
      else if (r?.error) this.panelError = r.error;
      if (this.detailTicket?.key === t.key) this.renderDetail(this.detailTicket, null);
    };
    add.onclick = () => upload([]);
    // The window's own drop handler (app.js: files dropped anywhere go to the
    // message box, or nowhere while it is hidden) must not see these drops.
    const files = e => [...(e.dataTransfer?.types || [])].includes('Files');
    box.ondragenter = e => { if (files(e)) { e.preventDefault(); e.stopPropagation(); box.classList.add('over'); } };
    box.ondragover = e => {
      if (!files(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      box.classList.add('over');
    };
    box.ondragleave = e => { if (!box.contains(e.relatedTarget)) box.classList.remove('over'); };
    box.ondrop = e => {
      if (!files(e)) return;
      e.preventDefault();
      e.stopPropagation();
      box.classList.remove('over');
      const paths = [...e.dataTransfer.files].map(f => window.deck.pathForFile?.(f)).filter(Boolean);
      if (paths.length) upload(paths);
    };
    return box;
  };

  P.panelSubtasks = function (t) {
    const body = el('div', 'tp-section-body');
    const subs = t.subtasks || [];
    const list = el('div', 'tp-subs');
    let hiddenNote = null;
    // The panel's own status filter (panelFilter): the lists' filter does not
    // reach here, and this one does not reach the lists.
    const pf = this.panelFilter;
    const filter = el('button', 'icon tickets-filter-btn tp-filter' + (this.filtering(pf) ? ' active' : ''));
    filter.type = 'button';
    filter.innerHTML = FUNNEL;
    filter.title = this.filtering(pf) ? 'Filters: some statuses are hidden' : 'Filter the subtasks by status';
    filter.onclick = () => this.openMenu(filter, 'subfilters:' + t.key, menu => this.fillFilterMenu(menu, { items: t.subtasks || [], types: false, filter: pf }));
    if (subs.length) {
      const done = subs.filter(s => s.done).length;
      const pct = Math.round(done * 100 / subs.length);
      const bar = el('div', 'tp-progress');
      const track = el('div', 'tp-progress-track');
      const fill = el('div', 'tp-progress-fill');
      fill.style.width = pct + '%';
      track.append(fill);
      bar.append(track, el('span', 'tp-progress-text', `${pct}% Done`));
      body.append(bar);
      const shown = subs.filter(s => this.shows(s, pf));
      for (const s of shown) {
        const row = el('div', 'tp-sub' + (s.done ? ' done' : ''));
        if (this.news?.subs.has(s.key)) this.markNew(row, 's:' + s.key);
        const icon = el('span', 'tickets-type-icon');
        icon.innerHTML = SUBTASK_ICON;
        row.append(icon, el('span', 'tp-sub-key', shortKey(s.key)), ticketTitle(s.title, 'tp-sub-title'),
          this.statusButton(s), priorityIcon(s.priority), avatar(s.assignee));
        row.title = s.title;
        row.onclick = e => { if (!e.target.closest('button')) this.select({ ...s, type: 'Subtask', parentKey: t.key }); };
        list.append(row);
      }
      if (shown.length < subs.length) {
        const n = subs.length - shown.length;
        hiddenNote = el('button', 'tp-link tp-hidden-note', `${n} subtask${n === 1 ? '' : 's'} hidden by the status filter · Show all`);
        hiddenNote.type = 'button';
        hiddenNote.onclick = () => {
          this.resetStatusFilter(pf);
          this.renderDetail(t, null);
        };
      }
    }
    // The last row: the next subtask's place, a faint outline of one (its
    // mark, + and the story's assignee, who gets it). A click makes it a field.
    const ghost = el('div', 'tp-sub tp-sub-ghost');
    const gIcon = el('span', 'tickets-type-icon');
    gIcon.innerHTML = SUBTASK_ICON;
    const who = avatar(t.assignee);
    who.title = t.assignee ? `It goes to ${t.assignee}, like the story` : 'Unassigned, like the story';
    ghost.append(gIcon, el('span', 'tp-sub-plus', '+'));
    list.append(ghost);
    body.append(list);
    if (hiddenNote) body.append(hiddenNote);
    if (this.editing !== 'subtask') {
      // Just a + in the middle.
      ghost.replaceChildren(el('span', 'tp-sub-plus', '+'));
      ghost.classList.add('plain');
      ghost.title = 'Add a subtask';
      ghost.onclick = () => { this.editing = 'subtask'; this.renderDetail(t, null); };
    } else {
      ghost.classList.add('editing');
      const input = document.createElement('input');
      input.className = 'tp-sub-input';
      input.placeholder = 'What needs to be done? (Enter adds it, Esc stops)';
      ghost.append(input, who);
      input.onkeydown = async e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.editing = null; this.renderDetail(t, null); }
        if (e.key !== 'Enter' || !input.value.trim()) return;
        e.preventDefault();
        input.disabled = true;
        const r = await window.deck.pmCreateSubtask({ key: t.key, id: t.id, project: projectOf(t), title: input.value.trim(), assignee: t.assignee || '' }).catch(err => ({ error: String(err?.message || err) }));
        if (r?.notConnected) return this.setConnected({ connected: false });
        this.editing = r?.error ? 'subtask' : null;
        this.afterSave(t, r);
        if (!r?.error) { this.editing = 'subtask'; this.renderDetail(this.detailTicket, null); }   // ready for the next one
      };
      // Leaving it empty puts the outline back.
      input.onblur = () => { if (!input.value.trim() && !input.disabled && this.editing === 'subtask') { this.editing = null; this.renderDetail(t, null); } };
      requestAnimationFrame(() => input.focus());
    }
    return this.panelSection('subtasks', 'Subtasks', body, ...(subs.length ? [filter] : []));
  };

  P.panelComments = function (t) {
    const body = el('div', 'tp-section-body');
    const target = { key: t.key, id: t.id, project: projectOf(t), subtask: !!t.subtask };
    const d = this.panelList('commentLists', t.key, () => window.deck.pmComments(target));
    if (d.loading) body.append(el('div', 'tp-empty-line', 'Reading the comments…'));
    if (d.error) body.append(el('div', 'tickets-error', d.error));
    for (const c of (d.items || []).filter(c => !c.deleted)) {
      const row = el('div', 'tp-comment' + (c.parentId ? ' reply' : ''));
      if (this.news?.comments.has(c.at)) this.markNew(row, 'c:' + c.id, [...this.news.comments].sort().reverse().indexOf(c.at));
      const head = el('div', 'tp-comment-head');
      const when = c.at ? new Date(c.at) : null;
      head.append(avatar(c.author), el('span', 'tp-comment-author', c.author || 'Someone'), el('span', 'tp-comment-time', (when ? when.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '') + (c.edited ? ' · edited' : '')));
      if (c.mine) head.append(this.commentTools(t, c, target, row));
      row.append(head, this.editingComment === c.id ? this.commentEditor(t, c, target) : this.description(c.media?.length ? { ...t, media: [...(t.media || []), ...c.media] } : t, c.content));
      body.append(row);
    }
    const write = document.createElement('textarea');
    write.className = 'tp-input tp-comment-input';
    write.placeholder = 'Add a comment…';
    write.rows = 2;
    const send = el('button', 'gallery-use', 'Comment');
    send.type = 'button';
    send.onclick = async () => {
      const text = write.value.trim();
      if (!text) return;
      send.disabled = write.disabled = true;
      const r = await window.deck.pmAddComment({ ...target, content: text, authorName: this.myName() }).catch(err => ({ error: String(err?.message || err) }));
      if (Array.isArray(r)) this.commentLists.set(t.key, { items: r, at: Date.now() });
      else this.panelError = r?.error || 'PM did not answer.';
      if (this.detailTicket?.key === t.key) this.renderDetail(this.detailTicket, null);
    };
    write.onkeydown = e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send.onclick(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); write.blur(); }
    };
    const box = el('div', 'tp-comment-new');
    box.append(write, send);
    // The newest comments come first, so the box to write one sits on top.
    body.prepend(box);
    const count = d.items?.length ? el('span', 'tp-count', String(d.items.length)) : '';
    return this.panelSection('comments', 'Comments', body, count);
  };

  // ---------- your own comments: edit and delete ----------

  // A comment's text as plain text, for editing (PM takes plain text).
  const plainText = html => {
    const div = document.createElement('div');
    div.innerHTML = DOMPurify.sanitize(String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|div|h\d)>/gi, '\n'));
    return div.textContent.replace(/\n{3,}/g, '\n\n').trim();
  };

  // Edit and Delete on your own comment (shown when you point at it). A
  // comment with images or videos can only be deleted here: plain text
  // would drop them.
  P.commentTools = function (t, c, target, row) {
    const tools = el('span', 'tp-comment-tools');
    const media = /<(img|video)\b/i.test(c.content);
    if (!media) {
      const edit = el('button', 'tp-link', 'Edit');
      edit.type = 'button';
      edit.onclick = () => { this.editingComment = c.id; this.renderDetail(t, null); };
      tools.append(edit);
    }
    const del = el('button', 'tp-link tp-danger', 'Delete');
    del.type = 'button';
    del.title = media ? 'Delete this comment (it has images or videos, so edit it in PM)' : 'Delete this comment';
    del.onclick = () => {
      // One more click to be sure: the comment goes for everyone.
      tools.replaceChildren(el('span', 'tp-faint', 'Delete it for everyone?'));
      const yes = el('button', 'tp-link tp-danger', 'Delete');
      yes.type = 'button';
      const no = el('button', 'tp-link', 'Keep');
      no.type = 'button';
      no.onclick = () => this.renderDetail(t, null);
      yes.onclick = async () => {
        row.classList.add('tp-comment-going');
        const r = await window.deck.pmDeleteComment({ ...target, commentId: c.id }).catch(err => ({ error: String(err?.message || err) }));
        this.afterComments(t, r);
      };
      tools.append(yes, no);
      tools.classList.add('asking');
    };
    tools.append(del);
    return tools;
  };

  P.commentEditor = function (t, c, target) {
    const box = el('div', 'tp-comment-edit');
    const input = document.createElement('textarea');
    input.className = 'tp-input tp-comment-input';
    input.value = plainText(c.content);
    input.rows = Math.min(10, Math.max(2, input.value.split('\n').length + 1));
    const save = el('button', 'gallery-use', 'Save');
    save.type = 'button';
    const cancel = el('button', 'gallery-action', 'Cancel');
    cancel.type = 'button';
    cancel.onclick = () => { this.editingComment = null; this.renderDetail(t, null); };
    save.onclick = async () => {
      const text = input.value.trim();
      if (!text || text === plainText(c.content)) return cancel.onclick();
      save.disabled = input.disabled = true;
      const r = await window.deck.pmEditComment({ ...target, commentId: c.id, content: text }).catch(err => ({ error: String(err?.message || err) }));
      this.editingComment = null;
      this.afterComments(t, r);
    };
    input.onkeydown = e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save.onclick(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel.onclick(); }
    };
    const actions = el('div', 'tp-edit-actions');
    actions.append(save, cancel);
    box.append(input, actions);
    requestAnimationFrame(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); });
    return box;
  };

  // The comments as PM has them after a change, or PM's error.
  P.afterComments = function (t, r) {
    if (r?.notConnected) return this.setConnected({ connected: false });
    if (Array.isArray(r)) { this.commentLists.set(t.key, { items: r, at: Date.now() }); this.panelError = null; }
    else this.panelError = r?.error || 'PM did not answer.';
    if (this.detailTicket?.key === t.key) this.renderDetail(this.detailTicket, null);
  };

  // ---------- the fields on the right ----------

  P.panelSide = function (t, side) {
    const status = this.statusButton(t);
    status.classList.add('tp-status');
    side.append(status);
    // An unseen status change: the old status first, then it turns into the
    // new one; "was …" stays under it until the news is read.
    const news = this.news;
    if (news?.status && !news.read && t.description !== undefined) {
      const was = el('div', 'tp-was', `was ${news.status.from}`);
      side.append(was);
      if (!news.morphed) {
        news.morphed = true;
        const old = (this.statusLists.get(projectOf(t)) || []).find(x => x.name === news.status.from);
        const keep = { cls: status.className, html: status.innerHTML };
        status.className = `tickets-status tp-status status-${old?.category || 'todo'}`;
        status.replaceChildren(el('span', null, news.status.from), el('span', 'tickets-status-caret', '▾'));
        was.classList.add('hidden');
        setTimeout(() => {
          status.className = keep.cls + ' tp-morph';
          status.innerHTML = keep.html;
          was.classList.remove('hidden');
          was.classList.add('tp-was-in');
        }, 900);
      }
    }
    const fieldEl = (label, ...kids) => {
      const f = el('div', 'tp-field');
      f.append(el('div', 'tp-label', label), ...kids);
      return f;
    };
    const field = (label, ...kids) => side.appendChild(fieldEl(label, ...kids));
    // Two fields next to each other.
    const pair = (...fields) => {
      const row = el('div', 'tp-pair');
      row.append(...fields);
      side.append(row);
    };
    // A dropdown (pickers.js): choices are [value, label, group, tooltip].
    // apart: a line between the none choice and the others.
    const select = (value, choices, onChange, { none = 'None', prefix, apart = false } = {}) => this.dropdown({
      value: value || '', none, apart, prefix,
      choices: choices.map(([v, label, group, tip]) => ({ value: v, label, group: group || undefined, tip })),
      onPick: v => { if ((v || null) !== (value || null)) onChange(v); },
    });
    const text = (value, onSave, { placeholder = '', parse } = {}) => {
      const input = document.createElement('input');
      input.className = 'tp-input';
      input.value = value || '';
      input.placeholder = placeholder;
      const before = input.value;
      input.onchange = () => {
        const v = input.value.trim();
        if (v === before) return;
        const out = parse ? parse(v) : (v || null);
        if (Number.isNaN(out)) { input.classList.add('bad'); input.title = 'Write it like 2h 30m, 45m or 1d'; return; }
        onSave(out);
      };
      input.onkeydown = e => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); input.value = before; input.blur(); }
      };
      return input;
    };
    // An assignee field: type a name, or pick one from the list under it
    // (everyone the view knows, with their marks).
    const person = (value, key) => {
      const wrap = el('div', 'tp-person');
      const input = text(value, v => this.saveFields(t, { [key]: v ?? (t.subtask ? '' : null) }), { placeholder: 'Unassigned' });
      input.autocomplete = 'off';
      const menuKey = 'people:' + key;
      const fill = menu => {
        const q = input.value.trim().toLowerCase();
        const typed = q && q !== String(value || '').toLowerCase();
        const names = this.people().filter(n => !typed || n.toLowerCase().includes(q)).map(n => [n, n]);
        this.fillPeopleMenu(menu, names, value || '', v => { const save = input.onchange; input.onchange = null; input.value = v; save(); input.blur(); });
      };
      const show = () => {
        if (this.menu?.dataset.key === menuKey) fill(this.menu);
        else this.openMenu(wrap, menuKey, fill);
      };
      input.onfocus = show;
      input.onclick = () => { if (this.menu?.dataset.key !== menuKey) show(); };
      input.oninput = show;
      input.addEventListener('blur', () => { if (this.menu?.dataset.key === menuKey) this.closeStatusMenu(); });
      wrap.append(avatar(value), input);
      return wrap;
    };

    const reporter = el('div', 'tp-static');
    reporter.append(...(t.author ? [avatar(t.author), el('span', null, t.author)] : [el('span', 'tp-faint', '—')]));
    field('Reporter', reporter);
    const me = el('button', 'tp-link', 'Assign to me');
    me.type = 'button';
    // Your name, not your email: PM shows the text it is given.
    me.onclick = () => this.saveFields(t, { assignee: this.myName() });
    pair(fieldEl('Assignee', person(t.assignee, 'assignee'), me), fieldEl('Assignee 2', person(t.assignee2, 'assignee2')));

    const o = this.panelOptions(projectOf(t));
    if (!t.subtask) {
      if (!o) side.append(el('div', 'tp-faint tp-loading', 'Reading the project\'s fields…'));
      else {
        // The epic is in the chain at the top left (its ▾ changes it), not here.
        // Active sprints first, then planned ones (pmclient sorts them that way).
        // Only the kinds of sprint you follow (Settings → Tactile PM → Sprints:
        // name prefixes; empty, all). The ticket's own sprint shows anyway.
        const prefixes = ((typeof state !== 'undefined' && state.config?.pmSprintPrefixes) || []).map(p => p.toLowerCase());
        const followed = x => !prefixes.length || x.id === t.sprintId || prefixes.some(p => x.name.toLowerCase().startsWith(p));
        // With one prefix, it is the same on every name: the names show without
        // it ("Features & UI - Sprint 37" → "Sprint 37"). With several, in full,
        // so sprints of different kinds stay apart.
        const short = name => {
          if (prefixes.length !== 1 || !name.toLowerCase().startsWith(prefixes[0])) return name;
          return name.slice(prefixes[0].length).replace(/^[\s\-–—:|·/]+/, '') || name;
        };
        // Under Current and Upcoming. A group of one sprint is just its name
        // (Current, Upcoming): the sprint's own name is its tooltip.
        const shown = (o.sprints || []).filter(followed);
        const groupOf = x => (x.status === 'ACTIVE' ? 'Current' : 'Upcoming');
        const count = g => shown.filter(x => groupOf(x) === g).length;
        const sprints = shown.map(x => (count(groupOf(x)) === 1 ? [x.id, groupOf(x), null, x.name] : [x.id, short(x.name), groupOf(x), x.name]));
        if (t.sprintId && !sprints.some(x => x[0] === t.sprintId)) sprints.unshift([t.sprintId, t.sprint || 'Sprint']);
        const sprintSelect = select(t.sprintId, sprints, v => this.saveFields(t, { sprintId: v }), { none: 'Backlog', apart: true });
        const picked = shown.find(x => x.id === t.sprintId);
        if (picked) sprintSelect.title = picked.name;
        field('Sprint', sprintSelect);
      }
    }
    // Priority: a menu of its own (not a dropdown), so each choice shows its icon.
    const prio = el('button', 'tp-select tp-select-button tp-prio-button');
    prio.type = 'button';
    prio.append(priorityIcon(t.priority), el('span', 'tp-prio-name', t.priority || 'None'), el('span', 'tp-prio-caret', '▾'));
    prio.onclick = () => this.openMenu(prio, 'priority:' + t.key, menu => {
      menu.replaceChildren();
      for (const p of [...PRIORITIES, null]) {
        const item = el('button', 'tickets-status-item tp-prio-item' + ((t.priority || null) === p ? ' on' : ''));
        item.type = 'button';
        item.append(priorityIcon(p), el('span', null, p || 'None'));
        item.onclick = () => { this.closeStatusMenu(); if ((t.priority || null) !== p) this.saveFields(t, { priority: p }); };
        menu.append(item);
      }
    });
    field('Priority', prio);
    // Components, Estimate, Story Points and Found in are not shown (the team
    // does not use them here); PM keeps whatever they hold.
    // A subtask: its story's Branch and Revision, read only (subtasks have no
    // custom fields; agents put them on the story).
    if (t.subtask && o && t.parentCustomFields) {
      const val = f => { const v = f && (t.parentCustomFields[f.id] ?? t.parentCustomFields[f.name]); return Array.isArray(v) ? v.join(', ') : String(v ?? ''); };
      const branch = (o.fields || []).find(f => /^branch$/i.test(f.name.trim()));
      const revision = (o.fields || []).find(f => /revision/i.test(f.name));
      const ro = (label, v) => { const x = el('div', 'tp-readonly', v || '—'); x.title = `On the story ${t.parentKey}: subtasks have no ${label} field of their own`; return fieldEl(`${label} · story`, x); };
      if (branch || revision) pair(ro('Branch', val(branch)), ro('Revision', val(revision)));
    }
    if (!t.subtask && o) {
      const teams = (o.teams || []).map(x => [x.id, x.name]);
      field('Team', select(t.teamId, teams, v => this.saveFields(t, { team: v })));
      // Shorter names for some of PM's fields (saving still uses PM's name).
      const labelOf = f => (/^testable revision$/i.test(f.name.trim()) ? 'Revision' : f.name);
      const custom = f => {
        const value = t.customFields?.[f.id] ?? t.customFields?.[f.name] ?? '';
        const save = v => this.saveFields(t, { customFields: { [f.name]: v } });
        if ((f.type === 'select' || f.type === 'multiSelect') && f.values.length) {
          const choices = f.values.map(v => (typeof v === 'string' ? [v, v] : [v.value ?? v.label, v.label ?? v.value]));
          return fieldEl(labelOf(f), select(Array.isArray(value) ? value[0] : value, choices, save));
        }
        return fieldEl(labelOf(f), text(Array.isArray(value) ? value.join(', ') : String(value), save));
      };
      const fields = (o.fields || []).filter(f => f.types.includes(t.typeId) && !/^found in$/i.test(f.name.trim()));
      // Branch and Testable revision side by side; the others one a row.
      const branch = fields.find(f => /^branch$/i.test(f.name.trim()));
      const revision = fields.find(f => /revision/i.test(f.name));
      for (const f of fields) {
        if (f === branch && revision) pair(custom(branch), custom(revision));
        else if (f === revision && branch) continue;
        else side.append(custom(f));
      }
    }
  };

  // Components: a list to tick in a menu (a ticket can have several).
  P.componentsPicker = function (t, components) {
    const names = new Map(components.map(c => [c.id, c.name]));
    const chosen = t.componentIds || [];
    const b = el('button', 'tp-select tp-select-button', chosen.map(id => names.get(id) || 'Component').join(', ') || 'None');
    b.type = 'button';
    if (!components.length) { b.disabled = true; b.title = 'This project has no components.'; return b; }
    b.onclick = () => this.openMenu(b, 'components:' + t.key, menu => {
      menu.replaceChildren();
      const pick = new Set(chosen);
      for (const c of components) {
        const item = el('button', 'tickets-status-item' + (pick.has(c.id) ? ' on' : ''), c.name);
        item.type = 'button';
        item.onclick = () => {
          if (pick.has(c.id)) pick.delete(c.id); else pick.add(c.id);
          item.classList.toggle('on');
        };
        menu.append(item);
      }
      const save = el('button', 'gallery-use tp-menu-save', 'Save');
      save.type = 'button';
      save.onclick = () => { this.closeStatusMenu(); this.saveFields(t, { componentIds: [...pick] }); };
      menu.append(save);
    });
    return b;
  };
})();
