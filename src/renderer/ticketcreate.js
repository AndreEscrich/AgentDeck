// New ticket: the + New ticket button in the Tickets view's bar. A window
// with the type (Story or Bug), the title, a description, the assignee (you
// by default), the sprint (the backlog by default), the epic and the team
// (boards show a sprint's tickets by team, so the last one you picked is
// kept). Create makes it in PM (pm_create_task) and opens it in the panel.
// The methods join TicketsView.

(() => {
  const P = TicketsView.prototype;

  // The project new tickets go in: the one most of the view's tickets are in.
  P.newTicketProject = function () {
    const count = new Map();
    for (const d of Object.values(this.data)) for (const t of d.items || []) if (t.project) count.set(t.project, (count.get(t.project) || 0) + 1);
    return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  };

  // Plain text to the HTML PM keeps: a paragraph per blank line, "- " lines as a list.
  const toHtml = text => {
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return text.trim().split(/\n\s*\n/).map(block => {
      const lines = block.split('\n');
      if (lines.every(l => /^\s*[-*•]\s+/.test(l))) return '<ul>' + lines.map(l => `<li>${esc(l.replace(/^\s*[-*•]\s+/, ''))}</li>`).join('') + '</ul>';
      return `<p>${lines.map(esc).join('<br>')}</p>`;
    }).join('');
  };

  P.openNewTicket = function (button) {
    if (document.querySelector('.new-ticket')) return;
    const project = this.newTicketProject();
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('pmNewTicket') || '{}'); } catch { /* defaults */ }
    const pick = { type: saved.type || 'Story', assignee: this.myName(), sprintId: '', epicId: '', team: saved.team || '' };

    const shade = el('div', 'review-shade top');
    const box = el('div', 'review-confirm new-ticket');
    // It grows out of + New ticket, and shrinks back into it.
    const close = async (into = button) => {
      document.removeEventListener('keydown', onKey, true);
      window.uiSound?.('close');
      const r = await morphClose(box, into, { backdrop: shade });
      r?.done?.();
      shade.remove();
    };
    const onKey = e => {
      if (box.classList.contains('busy')) return;
      if (isBackKey(e) && !this.menu) { e.preventDefault(); e.stopImmediatePropagation(); close(); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); create(); }
    };
    document.addEventListener('keydown', onKey, true);
    shade.onmousedown = e => { if (e.target === shade && !box.classList.contains('busy')) close(); };

    box.append(el('h3', null, 'New ticket' + (project ? ` in ${project}` : '')));
    // Story or Bug.
    const types = el('div', 'new-ticket-types');
    for (const name of ['Story', 'Bug']) {
      const b = el('button', 'new-ticket-type' + (pick.type === name ? ' on' : ''));
      b.type = 'button';
      b.append(typeIcon(name), el('span', null, name));
      b.onclick = () => { pick.type = name; for (const x of types.children) x.classList.toggle('on', x === b); };
      types.append(b);
    }
    const title = document.createElement('input');
    title.className = 'tp-input new-ticket-title';
    title.placeholder = '[Context] What needs to be done';
    const desc = document.createElement('textarea');
    desc.className = 'tp-input new-ticket-desc';
    desc.placeholder = 'Description (optional): what is wanted and why. "- " lines make a list.';
    desc.rows = 5;
    const row = (label, ...kids) => { const r = el('div', 'new-ticket-field'); r.append(el('label', null, label), ...kids); return r; };

    // The assignee: a button with their mark; its menu lists everyone, you first.
    const who = el('button', 'plan-person new-ticket-who');
    who.type = 'button';
    const showWho = () => who.replaceChildren(personAvatar(pick.assignee), el('span', 'plan-person-name', pick.assignee || 'Unassigned'), el('span', 'tickets-status-caret', '▾'));
    showWho();
    who.onclick = () => this.openMenu(who, 'new:assignee', menu => this.fillPeopleMenu(menu, [...this.people().map(n => [n, n]), ['', 'Unassigned']], pick.assignee, v => { pick.assignee = v; showWho(); }));

    // Dropdowns like the rest of the view (pickers.js). choices: [value, label, icon, group].
    const selectOf = (choices, value, onChange, { none, placeholder } = {}) => this.dropdown({
      value, none, apart: true, cls: 'new-ticket-select', placeholder,
      choices: choices.map(([v, label, icon, group]) => ({ value: v, label, icon, group })),
      onPick: v => { onChange(v || ''); fill(lastOptions); },
    });
    let lastOptions = null;
    const fields = el('div', 'new-ticket-fields');
    const fill = o => {
      lastOptions = o;
      const prefixes = ((typeof state !== 'undefined' && state.config?.pmSprintPrefixes) || []).map(p => p.toLowerCase());
      const sprints = (o?.sprints || []).filter(s => !prefixes.length || prefixes.some(p => s.name.toLowerCase().startsWith(p)));
      const epics = (o?.epics || []).filter(e => !e.done).sort((a, b) => a.name.localeCompare(b.name));
      const teams = o?.teams || [];
      if (pick.team && !teams.some(t => t.name === pick.team)) pick.team = '';
      fields.replaceChildren(
        row('Assignee', who),
        row('Sprint', selectOf(sprints.map(s => [s.id, s.name, null, s.status === 'ACTIVE' ? 'Current' : 'Upcoming']), pick.sprintId, v => { pick.sprintId = v; }, { none: 'Backlog' })),
        row('Epic', selectOf(epics.map(e => [e.id, e.name, () => epicDot(e.name)]), pick.epicId, v => { pick.epicId = v; }, { none: 'No epic', placeholder: 'Search epics…' })),
        row('Team', selectOf(teams.map(t => [t.name, t.name]), pick.team, v => { pick.team = v; }, { none: 'No team' })));
    };
    fill(null);
    if (project) window.deck.pmOptions(project).then(o => { if (document.body.contains(box) && !o?.error) fill(o); });

    const err = el('div', 'tickets-error hidden');
    const actions = el('div', 'review-confirm-actions');
    const cancel = el('button', null, 'Cancel');
    cancel.type = 'button';
    cancel.onclick = close;
    const go = el('button', 'primary', 'Create ticket');
    go.type = 'button';
    go.title = 'Create it in PM (Ctrl+Enter)';
    const create = async () => {
      if (box.classList.contains('busy')) return;
      if (!project) { err.textContent = 'Open All tickets once first, so Agent Hub knows the project.'; err.classList.remove('hidden'); return; }
      if (!title.value.trim()) { title.focus(); title.classList.add('bad'); return; }
      box.classList.add('busy');
      go.disabled = cancel.disabled = true;
      go.textContent = 'Creating…';
      err.classList.add('hidden');
      try { localStorage.setItem('pmNewTicket', JSON.stringify({ type: pick.type, team: pick.team })); } catch { /* this run only */ }
      const r = await window.deck.pmCreateTask({
        project, title: title.value.trim(), type: pick.type, description: desc.value.trim() ? toHtml(desc.value) : '',
        assignee: pick.assignee || '', sprintId: pick.sprintId || '', epicId: pick.epicId || '', team: pick.team || '',
      }).catch(e => ({ error: String(e?.message || e) }));
      if (r?.notConnected) { close(); return this.setConnected({ connected: false }); }
      if (!r || r.error) {
        box.classList.remove('busy');
        go.disabled = cancel.disabled = false;
        go.textContent = 'Create ticket';
        err.textContent = r?.error || 'PM did not answer.';
        err.classList.remove('hidden');
        return;
      }
      // The window becomes the new ticket's panel.
      document.removeEventListener('keydown', onKey, true);
      shade.remove();
      this.load(true);
      this.select(r);
    };
    go.onclick = create;
    title.oninput = () => title.classList.remove('bad');
    title.onkeydown = e => { if (e.key === 'Enter' && !e.ctrlKey) { e.preventDefault(); desc.focus(); } };
    actions.append(cancel, go);
    box.append(types, title, desc, fields, err, actions);
    shade.append(box);
    this.view.append(shade);
    window.uiSound?.('open');
    morphOpen(box, button, { backdrop: shade });
    requestAnimationFrame(() => title.focus());
  };
})();
