// Sprint planning: the Tickets view's third tab. One person at a time
// (the ‹ › buttons step through everyone with open tickets in the space,
// and Unassigned): on the left their open tickets that are not in the
// upcoming sprint, then the space's unassigned stories and bugs, then
// everyone else's tickets (to hand one over); on the right the ones in the
// sprint. → puts a ticket in the upcoming sprint and, when it is unassigned
// or someone else's, gives it to the person; ← takes it out (to the backlog);
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
    this.plan = { person: saved.person ?? null, sprintName: saved.sprintName || null, marked: saved.marked || {}, sprints: null, panes: { left: pane(saved.panes?.left), right: pane(saved.panes?.right) }, els: {} };
    return this.plan;
  };

  P.savePlan = function () {
    const p = this.plan;
    const pane = x => ({ sort: x.sort, hidden: x.hidden });
    try { localStorage.setItem('pmSprintPlan', JSON.stringify({ person: p.person, sprintName: p.sprintName, marked: p.marked, panes: { left: pane(p.panes.left), right: pane(p.panes.right) } })); } catch { /* this run only */ }
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
    plan.active = [];
    for (const [project, sprints] of lists) for (const s of sprints) {
      if (s.status === 'ACTIVE') { plan.active.push({ ...s, project }); continue; }
      if (!byName.has(s.name)) byName.set(s.name, { name: s.name, ids: {}, boardId: s.boardId || '', goal: s.goal || '' });
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
    // Settings → Tactile PM → Not in planning: left out (case does not count).
    const hidden = new Set(((typeof state !== 'undefined' && state.config?.pmPlanHidden) || []).map(n => n.toLowerCase()));
    const people = [...count.keys()].filter(n => !hidden.has(n.toLowerCase())).sort((a, b) => (b === me) - (a === me) || a.localeCompare(b));
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
    // People you marked as planned for this sprint (the ✓): kept per sprint.
    const sprintKey = target?.name || '';
    const marked = new Set(plan.marked[sprintKey] || []);
    const done = p => marked.has(p);
    who.onclick = () => this.openMenu(who, 'plan:person', menu => this.fillChoiceMenu(menu, {
      choices: [...people.filter(p => !done(p)), ...people.filter(done)].map(p => ({
        value: p, label: label(p), faint: p === '', group: done(p) ? 'Planned' : 'Pending', icon: () => personAvatar(p),
      })),
      value: plan.person, placeholder: 'Search people…',
      onPick: v => { plan.person = v ?? ''; this.savePlan(); this.renderPlan(); },
    }));
    who.classList.toggle('planned', done(plan.person));
    const check = el('button', 'plan-check' + (done(plan.person) ? ' on' : ''));
    // A circle with a check in its middle: dashed and empty until marked.
    check.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3.2 7.4l2.5 2.5 5.1-5.6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    check.type = 'button';
    check.title = done(plan.person) ? `${label(plan.person)} is planned for this sprint: click to put them back in Pending` : `Mark ${label(plan.person)} as planned for this sprint`;
    check.onclick = () => {
      if (marked.has(plan.person)) marked.delete(plan.person); else marked.add(plan.person);
      plan.marked = { ...plan.marked, [sprintKey]: [...marked] };
      window.uiSound?.(marked.has(plan.person) ? 'done' : 'tick');
      this.savePlan();
      this.renderPlan();
    };
    const into = el('span', 'plan-into');
    if (!plan.sprints) into.append('Reading the sprints…');
    else if (!target) into.append('No upcoming sprint');
    else if (plan.sprints.length === 1) into.append('Planning into ', el('b', null, shortSprint(target.name)));
    else {
      const s = this.dropdown({
        value: target.name, key: 'plan:sprint', cls: 'plan-sprint',
        choices: plan.sprints.map(x => ({ value: x.name, label: shortSprint(x.name), tip: x.name })),
        onPick: v => { plan.sprintName = v; this.savePlan(); this.renderPlan(); },
      });
      into.append('Planning into ', s);
    }
    if (target) into.title = target.name;
    bar.append(step(-1), who, check, step(1), el('span', 'tickets-spacer'), into);
    // Start sprint: a window with the dates, what is in it and its goal.
    if (target) {
      const start = el('button', 'review-complete plan-start', 'Start sprint');
      start.type = 'button';
      start.title = `Start ${target.name} now, for two weeks`;
      start.onclick = () => this.confirmStartSprint(target, start);
      bar.append(start);
    }

    const mine = items.filter(t => (plan.person === '' ? !t.assignee : t.assignee === plan.person));
    const ids = target ? new Set(Object.values(target.ids)) : new Set();
    const inSprint = t => !!target && (t.sprintId ? ids.has(t.sprintId) : t.sprint === target.name);
    plan.lists = { left: mine.filter(t => !inSprint(t)), right: mine.filter(inSprint) };
    // After the person's own: nobody's stories and bugs, to take into the sprint.
    plan.extra = plan.person === '' ? [] : items.filter(t => !t.assignee && !inSprint(t) && typeRank(t) < 2);
    // Then everyone else's (in the sprint or not), to give one to this person.
    plan.others = plan.person === '' ? [] : items.filter(t => t.assignee && t.assignee !== plan.person);

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
    const othersAll = side === 'left' ? plan.others || [] : [];
    const others = othersAll.filter(keep).sort(order);
    const n = (a, b) => (a === b ? String(b) : `${a} of ${b}`);
    countEl.textContent = n(shown.length, all.length) + (extraAll.length ? ` · ${n(extra.length, extraAll.length)} unassigned` : '') + (othersAll.length ? ` · ${n(others.length, othersAll.length)} others'` : '');

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
      // Someone else's: their mark before the title.
      const theirs = side === 'left' && t.assignee && t.assignee !== plan.person;
      if (theirs) cells[1].prepend(personAvatar(t.assignee));
      const move = el('button', 'plan-move', side === 'left' ? '→' : '←');
      move.type = 'button';
      move.disabled = side === 'left' ? !target : false;
      // Unassigned or someone else's: it becomes the person's too.
      const give = side === 'left' && plan.person && t.assignee !== plan.person;
      const takes = give ? ` and assign to ${plan.person}` + (t.assignee ? ` (now ${t.assignee}'s)` : '') : '';
      move.title = side === 'left' ? (target ? `Move to ${target.name}${takes}` : 'No upcoming sprint') : 'Take out of the sprint (to the backlog)';
      move.onclick = e => { e.stopPropagation(); this.planMove(t, side === 'left' ? target : null, give ? plan.person : null); };
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
    if (others.length) {
      const tr = el('tr', 'plan-group');
      const td = el('td', null, 'Other people\'s tickets');
      td.colSpan = cols.length + 1;
      tr.append(td);
      body.append(tr);
      for (const t of others) body.append(row(t));
    }
    table.append(thead, body);
    const frag = document.createDocumentFragment();
    frag.append(table);
    if (!shown.length && !extra.length && !others.length) frag.append(el('div', 'gallery-note', all.length || extraAll.length || othersAll.length ? 'No ticket matches.' : side === 'left' ? 'No other open tickets.' : 'Nothing in this sprint yet.'));
    box.replaceChildren(frag);
  };

  // A column's filter: its values (with counts), ticked ones show.
  P.fillPlanFilter = function (menu, side, id, valueOf) {
    const st = this.plan.panes[side];
    menu.replaceChildren();
    menu.classList.add('tickets-filter-menu');
    const counts = new Map();
    for (const t of [...this.plan.lists[side], ...(side === 'left' ? [...(this.plan.extra || []), ...(this.plan.others || [])] : [])]) counts.set(valueOf(t), (counts.get(valueOf(t)) || 0) + 1);
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

  // ---------- Start sprint ----------
  //
  // A window: the sprint starts now and ends in two weeks; what is in it
  // (everyone's tickets); a warning when its board still has an active
  // sprint; and its goal, a list Haiku writes from the sprint's tickets by
  // epic (pmassist.js goals), which you can change before Start sprint.
  P.confirmStartSprint = function (sprint, button) {
    const plan = this.plan;
    const ids = new Set(Object.values(sprint.ids));
    const items = (this.data.all?.items || []).filter(t => (t.sprintId ? ids.has(t.sprintId) : t.sprint === sprint.name));
    const kinds = new Map();
    for (const t of items) { const k = isStory(t) ? 'stories' : /bug/i.test(t.type || '') ? 'bugs' : 'other tickets'; kinds.set(k, (kinds.get(k) || 0) + 1); }
    const busy = (plan.active || []).find(s => s.boardId && s.boardId === sprint.boardId);
    const project = Object.keys(sprint.ids)[0];

    const shade = el('div', 'review-shade top');
    const box = el('div', 'review-confirm start-sprint');
    const close = async () => {
      document.removeEventListener('keydown', onKey, true);
      window.uiSound?.('close');
      const r = await morphClose(box, button, { backdrop: shade });
      r?.done?.();
      shade.remove();
    };
    const onKey = e => { if (isBackKey(e) && !box.classList.contains('busy') && !e.target.closest?.('textarea')) { e.preventDefault(); e.stopImmediatePropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    shade.onmousedown = e => { if (e.target === shade && !box.classList.contains('busy')) close(); };

    const day = d => d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    const now = new Date();
    const end = new Date(now.getTime() + 14 * 24 * 3600 * 1000);
    box.append(el('h3', null, `Start ${sprint.name}?`));
    box.append(el('div', 'review-confirm-dates', `Today, ${day(now)} – ${day(end)} · 2 weeks`));
    const what = el('div', 'review-confirm-carry');
    if (items.length) what.append(el('span', 'review-confirm-n', String(items.length)), ` open ticket${items.length === 1 ? '' : 's'} in it`);
    else what.append('Nothing is planned into it yet.');
    box.append(what);
    if (items.length) box.append(el('div', 'review-confirm-kinds', ['stories', 'bugs', 'other tickets'].filter(k => kinds.get(k)).map(k => `${kinds.get(k)} ${k}`).join(' · ')));
    if (busy) box.append(el('div', 'start-sprint-warn', `${busy.name} is still active on this board: complete it in Sprint review first, or PM may refuse.`));

    // The goal: Haiku's list, yours to change.
    const head = el('div', 'start-sprint-goal-head');
    const again = el('button', 'tp-link', 'Write with Haiku');
    again.type = 'button';
    const count = el('span', 'start-sprint-count');
    head.append(el('span', 'review-confirm-label', 'Sprint goal'), count, again);
    const goal = document.createElement('textarea');
    goal.className = 'tp-input start-sprint-goal';
    goal.rows = 11;
    goal.maxLength = 500;
    goal.placeholder = '- Party Time shipped\n- Expedition done';
    const counted = () => { count.textContent = `${goal.value.length} / 500`; count.classList.toggle('full', goal.value.length >= 500); };
    goal.oninput = counted;
    const write = async () => {
      if (!items.length) { goal.placeholder = 'Plan some tickets into the sprint first, or write the goal yourself.'; return; }
      goal.disabled = again.disabled = true;
      box.classList.add('writing');
      const before = goal.value;
      goal.value = '';
      goal.placeholder = 'Haiku is writing the goals from the sprint\'s tickets…';
      const byEpic = new Map();
      for (const t of items) { const e = t.epic || 'No epic'; if (!byEpic.has(e)) byEpic.set(e, []); byEpic.get(e).push(t); }
      const text = `Sprint: ${sprint.name}\n\n` + [...byEpic].map(([e, list]) => `Epic: ${e}\n` + list.map(t => `- [${t.type || 'Task'}] ${t.title}`).join('\n')).join('\n\n');
      const r = await window.deck.pmSprintGoals(text).catch(e => ({ error: String(e?.message || e) }));
      if (!document.body.contains(box)) return;
      box.classList.remove('writing');
      goal.disabled = again.disabled = false;
      goal.placeholder = '- Party Time shipped\n- Expedition done';
      if (r?.error) { goal.value = before; err.textContent = `Haiku could not write the goals: ${r.error}`; err.classList.remove('hidden'); }
      else goal.value = String(r.result || '').slice(0, 500);
      counted();
      goal.focus();
    };
    again.onclick = () => { err.classList.add('hidden'); write(); };
    box.append(head, goal);

    const err = el('div', 'tickets-error hidden');
    const actions = el('div', 'review-confirm-actions');
    const cancel = el('button', null, 'Cancel');
    cancel.type = 'button';
    cancel.onclick = close;
    const go = el('button', 'primary', 'Start sprint');
    go.type = 'button';
    go.onclick = async () => {
      box.classList.add('busy');
      go.disabled = cancel.disabled = goal.disabled = again.disabled = true;
      go.textContent = 'Starting…';
      err.classList.add('hidden');
      // It starts now (the moment you confirm), for two weeks.
      const r = await window.deck.pmStartSprint({ project, sprintId: sprint.ids[project], goal: goal.value.trim(), days: 14 })
        .catch(e => ({ error: String(e?.message || e) }));
      if (r?.notConnected) { close(); return this.setConnected({ connected: false }); }
      if (!r || r.error) {
        box.classList.remove('busy');
        go.disabled = cancel.disabled = goal.disabled = again.disabled = false;
        go.textContent = 'Start sprint';
        err.textContent = r?.error || 'PM did not answer.';
        err.classList.remove('hidden');
        return;
      }
      close();
      // The sprints as PM has them now (this one is active: the next one is planned into).
      plan.sprints = null;
      plan.sprintName = null;
      this.reviewList = null;
      this.savePlan();
      this.load(true);
      this.renderPlan();
    };
    actions.append(cancel, go);
    box.append(err, actions);
    shade.append(box);
    this.view.append(shade);
    window.uiSound?.('open');
    morphOpen(box, button, { backdrop: shade });
    // A goal already written stays; otherwise Haiku writes one at once.
    if (sprint.goal) { goal.value = sprint.goal; counted(); } else { counted(); write(); }
    cancel.focus();
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
