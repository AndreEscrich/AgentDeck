// Sprint planning: the Tickets view's third tab. One person at a time
// (the ‹ › buttons step through everyone with open tickets in the space,
// and Unassigned): on the left their open tickets that are not in the
// upcoming sprint, then the space's unassigned stories and bugs; on the
// right the ones in the sprint. → puts a ticket in the upcoming sprint (an
// unassigned one gets the person too), ← takes it out (to the backlog);
// both change it in PM at once. Each side has its own search, sorting (a
// click on a column's name; by default stories first, then bugs, each
// newest first) and type filter, kept between runs.
// The upcoming sprint: the first planned (not active) sprint whose name
// starts with one of Settings → Tactile PM → Sprints (any, when empty); a
// picker when there are several. The tickets are All tickets' list.
// The methods join TicketsView.

(() => {
  const P = TicketsView.prototype;
  const created = t => (t.createdAt ? Date.parse(t.createdAt) || 0 : 0);
  // Stories first, then bugs, then the rest.
  const typeRank = t => (/story/i.test(t.type || '') ? 0 : /bug/i.test(t.type || '') ? 1 : 2);
  // The default order: by type, each newest first.
  const byDefault = (a, b) => typeRank(a) - typeRank(b) || created(b) - created(a) || b.seq - a.seq;
  // [id, name, the value it sorts by, the value its filter lists (or none)]
  const COLUMNS = [
    ['key', 'Key', t => t.seq, t => t.type || 'Task'],
    ['title', 'Title', t => t.title.toLowerCase()],
  ];
  const FILTER_NAMES = { key: 'type' };
  const newPane = () => ({ q: '', sort: { col: null, desc: false }, hidden: {} });

  P.planState = function () {
    if (this.plan) return this.plan;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('pmSprintPlan') || '{}'); } catch { /* defaults */ }
    const pane = p => ({ ...newPane(), ...(p || {}), q: '' });
    this.plan = { person: saved.person ?? null, sprintName: saved.sprintName || null, sprints: null, panes: { left: pane(saved.panes?.left), right: pane(saved.panes?.right) }, els: {} };
    return this.plan;
  };

  P.savePlan = function () {
    const p = this.plan;
    const pane = x => ({ sort: x.sort, hidden: x.hidden });
    try { localStorage.setItem('pmSprintPlan', JSON.stringify({ person: p.person, sprintName: p.sprintName, panes: { left: pane(p.panes.left), right: pane(p.panes.right) } })); } catch { /* this run only */ }
  };

  // The sprint prefixes you follow, and a sprint's name without the prefix
  // when there is just one (like the ticket panel's Sprint field).
  const prefixes = () => ((typeof state !== 'undefined' && state.config?.pmSprintPrefixes) || []);
  const shortSprint = name => {
    const ps = prefixes();
    if (ps.length !== 1 || !name) return name;
    return name.toLowerCase().startsWith(ps[0].toLowerCase()) ? name.slice(ps[0].length).replace(/^[\s\-–:·]+/, '') || name : name;
  };

  // The planned sprints of the space's projects, merged by name:
  // [{ name, ids: { project: id } }], by name.
  P.loadPlanSprints = async function () {
    const plan = this.planState();
    if (plan.sprintsLoading) return;
    plan.sprintsLoading = true;
    const projects = [...new Set((this.data.all?.items || []).map(t => t.project).filter(Boolean))];
    const lists = await Promise.all(projects.map(p => window.deck.pmOptions(p).then(o => [p, o?.sprints || []]).catch(() => [p, []])));
    const byName = new Map();
    for (const [project, sprints] of lists) for (const s of sprints) {
      if (s.status === 'ACTIVE') continue;
      if (!byName.has(s.name)) byName.set(s.name, { name: s.name, ids: {} });
      byName.get(s.name).ids[project] = s.id;
    }
    const ps = prefixes().map(p => p.toLowerCase());
    let all = [...byName.values()];
    const followed = all.filter(s => !ps.length || ps.some(p => s.name.toLowerCase().startsWith(p)));
    if (followed.length) all = followed;
    plan.sprints = all.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    plan.sprintsLoading = false;
    if (this.list === 'plan') this.renderPlan();
  };

  P.planTarget = function () {
    const plan = this.planState();
    const s = plan.sprints || [];
    return s.find(x => x.name === plan.sprintName) || s[0] || null;
  };

  P.renderPlan = function () {
    const plan = this.planState();
    const d = this.data.all;
    if (!d) return;
    if (!plan.sprints) this.loadPlanSprints();
    const items = d.items || [];
    // Everyone with open tickets, you first; then Unassigned ('').
    const count = new Map();
    for (const t of items) if (t.assignee) count.set(t.assignee, (count.get(t.assignee) || 0) + 1);
    const me = this.myName?.();
    const people = [...count.keys()].sort((a, b) => (b === me) - (a === me) || a.localeCompare(b));
    if (items.some(t => !t.assignee)) people.push('');
    if (plan.person === null || !people.includes(plan.person)) plan.person = people.includes(me) ? me : people[0] ?? '';
    const target = this.planTarget();

    const bar = el('div', 'plan-bar');
    const step = dir => {
      const b = el('button', 'icon plan-step', dir < 0 ? '‹' : '›');
      b.type = 'button';
      b.title = dir < 0 ? 'The person before' : 'The next person';
      b.onclick = () => {
        const i = people.indexOf(plan.person);
        plan.person = people[(i + dir + people.length) % people.length];
        this.savePlan();
        this.renderPlan();
      };
      return b;
    };
    // The person: a button with their mark; its menu lists everyone, with theirs.
    const label = p => (p === '' ? 'Unassigned' : p === me ? `${p} (you)` : p);
    const who = el('button', 'plan-person');
    who.type = 'button';
    who.append(personAvatar(plan.person), el('span', 'plan-person-name', label(plan.person)), el('span', 'tickets-status-caret', '▾'));
    who.onclick = () => this.openMenu(who, 'plan:person', menu => this.fillPeopleMenu(menu, people.map(p => [p, label(p)]), plan.person, v => {
      plan.person = v;
      this.savePlan();
      this.renderPlan();
    }));
    const into = el('span', 'plan-into');
    if (!plan.sprints) into.append('Reading the sprints…');
    else if (!target) into.append('No upcoming sprint');
    else if (plan.sprints.length === 1) into.append('Planning into ', el('b', null, shortSprint(target.name)));
    else {
      const s = document.createElement('select');
      s.className = 'plan-sprint';
      for (const x of plan.sprints) s.append(new Option(shortSprint(x.name), x.name));
      s.value = target.name;
      s.onchange = () => { plan.sprintName = s.value; this.savePlan(); this.renderPlan(); };
      into.append('Planning into ', s);
    }
    if (target) into.title = target.name;
    bar.append(step(-1), who, step(1), el('span', 'tickets-spacer'), into);

    const mine = items.filter(t => (plan.person === '' ? !t.assignee : t.assignee === plan.person));
    const ids = target ? new Set(Object.values(target.ids)) : new Set();
    const inSprint = t => !!target && (t.sprintId ? ids.has(t.sprintId) : t.sprint === target.name);
    plan.lists = { left: mine.filter(t => !inSprint(t)), right: mine.filter(inSprint) };
    // After the person's own: nobody's stories and bugs, to take into the sprint.
    plan.extra = plan.person === '' ? [] : items.filter(t => !t.assignee && !inSprint(t) && typeRank(t) < 2);

    const panes = el('div', 'plan-panes');
    for (const side of ['left', 'right']) {
      const st = plan.panes[side];
      const pane = el('section', 'plan-pane plan-' + side);
      const head = el('div', 'plan-pane-head');
      const name = el('span', 'plan-pane-name', side === 'left' ? 'Not in the sprint' : target ? shortSprint(target.name) : 'Upcoming sprint');
      if (side === 'right' && target) name.title = target.name;
      const countEl = el('span', 'gallery-cat-count');
      const search = document.createElement('input');
      search.type = 'search';
      search.className = 'tickets-search plan-search';
      search.placeholder = 'Filter by key or title…';
      search.value = st.q;
      search.oninput = () => { st.q = search.value; this.renderPlanTable(side); };
      head.append(name, countEl, search);
      const box = el('div', 'plan-table-box scroll');
      pane.append(head, box);
      panes.append(pane);
      plan.els[side] = { box, countEl };
    }
    const keepFocus = document.activeElement?.classList.contains('plan-search') ? [...this.listBox.querySelectorAll('.plan-search')].indexOf(document.activeElement) : -1;
    this.listBox.replaceChildren(bar, panes);
    this.listBox.classList.add('planning');
    if (keepFocus >= 0) { const s = this.listBox.querySelectorAll('.plan-search')[keepFocus]; s?.focus(); }
    this.renderPlanTable('left');
    this.renderPlanTable('right');
  };

  P.renderPlanTable = function (side) {
    const plan = this.plan;
    const st = plan.panes[side];
    const { box, countEl } = plan.els[side];
    const cols = COLUMNS;
    const q = st.q.trim().toLowerCase();
    const keep = t => cols.every(c => !c[3] || !(st.hidden[c[0]] || []).includes(c[3](t)))
      && (!q || `${t.key} ${t.title} ${t.epic}`.toLowerCase().includes(q));
    const col = cols.find(c => c[0] === st.sort.col);
    const order = (a, b) => {
      if (!col) return byDefault(a, b);
      const x = col[2](a), y = col[2](b);
      const c = (typeof x === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) || a.seq - b.seq;
      return st.sort.desc ? -c : c;
    };
    const all = plan.lists[side];
    const shown = all.filter(keep).sort(order);
    const extraAll = side === 'left' ? plan.extra || [] : [];
    const extra = extraAll.filter(keep).sort(order);
    const n = (a, b) => (a === b ? String(b) : `${a} of ${b}`);
    countEl.textContent = n(shown.length, all.length) + (extraAll.length ? ` · ${n(extra.length, extraAll.length)} unassigned` : '');

    const table = el('table', 'tickets-table plan-table');
    const head = el('tr');
    const moveTh = () => { const th = el('th', 'col-move'); th.title = side === 'left' ? 'Move into the sprint' : 'Take out of the sprint'; return th; };
    if (side === 'right') head.append(moveTh());
    for (const [id, name, , valueOf] of cols) {
      const th = el('th', 'col-' + id);
      const cell = el('div', 'tickets-th');
      const sorted = col?.[0] === id;
      // A click goes: one way, the other way, then back to the default order.
      const first = id === 'key';
      const next = !sorted ? { col: id, desc: first } : st.sort.desc === first ? { col: id, desc: !first } : { col: null, desc: false };
      const sort = el('button', 'tickets-th-btn tickets-sort-btn' + (sorted ? ' on' : ''), sorted ? (st.sort.desc ? '↓' : '↑') : '↕');
      sort.type = 'button';
      sort.title = next.col ? `Sort by ${name.toLowerCase()}` : 'Back to stories first, then bugs, newest first';
      sort.onclick = e => {
        e.stopPropagation();
        st.sort = next;
        this.savePlan();
        this.renderPlanTable(side);
      };
      cell.append(el('span', 'tickets-th-name', name), sort);
      if (valueOf) {
        const on = (st.hidden[id] || []).length > 0;
        const f = el('button', 'tickets-th-btn tickets-th-filter' + (on ? ' on' : ''));
        f.type = 'button';
        f.innerHTML = FUNNEL;
        f.title = on ? `Filtering by ${FILTER_NAMES[id]}` : `Filter by ${FILTER_NAMES[id]}`;
        f.onclick = e => { e.stopPropagation(); this.openMenu(f, `plan:${side}:${id}`, menu => this.fillPlanFilter(menu, side, id, valueOf)); };
        cell.append(f);
      }
      th.append(cell);
      th.onclick = () => sort.click();
      head.append(th);
    }
    if (side === 'left') head.append(moveTh());
    const thead = el('thead');
    thead.append(head);
    const body = el('tbody');
    const target = this.planTarget();
    const row = t => {
      const tr = el('tr', 'tickets-row' + (this.selected === t.key ? ' selected' : '') + (t.planSaving ? ' saving' : ''));
      tr.dataset.key = t.key;
      const td = (cls, ...kids) => { const c = el('td', cls); c.append(...kids); return c; };
      const title = ticketTitle(t.title, 'tickets-title-link');
      title.onclick = e => { e.stopPropagation(); this.select(t); };
      const cells = [td('col-key', typeIcon(t.type), this.keyButton(t), this.notifBell(t)), td('col-title', title)];
      const move = el('button', 'plan-move', side === 'left' ? '→' : '←');
      move.type = 'button';
      move.disabled = side === 'left' ? !target : false;
      const takes = !t.assignee && plan.person ? ` and assign to ${plan.person}` : '';
      move.title = side === 'left' ? (target ? `Move to ${target.name}${takes}` : 'No upcoming sprint') : 'Take out of the sprint (to the backlog)';
      move.onclick = e => { e.stopPropagation(); this.planMove(t, side === 'left' ? target : null, side === 'left' && !t.assignee ? plan.person : null); };
      if (side === 'right') tr.append(td('col-move', move), ...cells);
      else tr.append(...cells, td('col-move', move));
      tr.title = t.title;
      return tr;
    };
    for (const t of shown) body.append(row(t));
    if (extra.length) {
      const tr = el('tr', 'plan-group');
      const td = el('td', null, 'Unassigned stories and bugs');
      td.colSpan = cols.length + 1;
      tr.append(td);
      body.append(tr);
      for (const t of extra) body.append(row(t));
    }
    table.append(thead, body);
    const frag = document.createDocumentFragment();
    frag.append(table);
    if (!shown.length && !extra.length) frag.append(el('div', 'gallery-note', all.length || extraAll.length ? 'No ticket matches.' : side === 'left' ? 'No other open tickets.' : 'Nothing in this sprint yet.'));
    box.replaceChildren(frag);
  };

  // A column's filter: its values (with counts), ticked ones show.
  P.fillPlanFilter = function (menu, side, id, valueOf) {
    const st = this.plan.panes[side];
    menu.replaceChildren();
    menu.classList.add('tickets-filter-menu');
    const counts = new Map();
    for (const t of [...this.plan.lists[side], ...(side === 'left' ? this.plan.extra || [] : [])]) counts.set(valueOf(t), (counts.get(valueOf(t)) || 0) + 1);
    const hidden = new Set(st.hidden[id] || []);
    for (const v of hidden) if (!counts.has(v)) counts.set(v, 0);
    const values = [...counts.keys()].sort((a, b) => typeRank({ type: a }) - typeRank({ type: b }) || a.localeCompare(b));
    menu.append(el('div', 'tickets-status-group', FILTER_NAMES[id][0].toUpperCase() + FILTER_NAMES[id].slice(1)));
    const redo = () => { st.hidden[id] = [...hidden]; this.savePlan(); this.renderPlanTable(side); this.fillPlanFilter(menu, side, id, valueOf); };
    for (const v of values) {
      const on = !hidden.has(v);
      const b = el('button', 'tickets-status-item tickets-check' + (on ? ' ticked' : ''));
      b.type = 'button';
      const label = v;
      b.append(id === 'key' ? typeIcon(v) : el('span', 'tickets-check-box', on ? '✓' : ''), el('span', null, label), el('span', 'gallery-cat-count', String(counts.get(v))));
      if (id === 'key') b.firstChild.classList.add(on ? 'picked' : 'unpicked');
      b.onclick = () => { if (on) hidden.add(v); else hidden.delete(v); redo(); };
      menu.append(b);
    }
    if (hidden.size) {
      const reset = el('button', 'tp-link tickets-filter-reset', 'Show all');
      reset.type = 'button';
      reset.onclick = () => { hidden.clear(); redo(); };
      menu.append(reset);
    }
  };

  // Into the sprint (target) or out of it (null: the backlog). Shows at
  // once; goes back if PM says no.
  P.planMove = async function (t, target, assignee = null) {
    const sprintId = target ? (target.ids[t.project] || Object.values(target.ids)[0]) : '';
    const before = { sprint: t.sprint, sprintId: t.sprintId, assignee: t.assignee };
    const set = v => { for (const c of this.copies(t.key)) Object.assign(c, v); };
    const fields = { sprintId, ...(assignee ? { assignee } : {}) };
    set({ sprint: target ? target.name : '', sprintId, ...(assignee ? { assignee } : {}), planSaving: true });
    this.renderPlan();
    const r = await window.deck.pmUpdate({ key: t.key, id: t.id, project: t.project || t.key.split('-')[0], subtask: false, fields })
      .catch(err => ({ error: String(err?.message || err) }));
    if (r?.notConnected) return this.setConnected({ connected: false });
    if (!r || r.error) {
      set({ ...before, planSaving: false });
      this.renderWhen(`Could not move ${t.key}: ${r?.error || 'PM did not answer.'}`);
    } else {
      set({ sprint: r.sprint ?? (target ? target.name : ''), sprintId: r.sprintId ?? sprintId, ...(assignee ? { assignee: r.assignee || assignee } : {}), planSaving: false });
      for (const c of this.copies(t.key)) delete c.planSaving;
      try { localStorage.setItem('pmTicketLists', JSON.stringify(this.data)); } catch { /* shown anyway */ }
    }
    if (this.list === 'plan') this.renderPlan();
  };
})();
