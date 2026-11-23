// Sprint review: the Tickets view's fourth tab. One sprint's tickets,
// stories only, everyone's and done ones too, in one list like All tickets (not grouped
// by epic): by default done first, then in progress, then to do, each by
// epic, then by context (a title's [labels]), then newest first. The sprint picker sits over the list, with how much of it
// is done. The sprints: the open ones (the active ones first) whose names
// start with one of Settings → Tactile PM → Sprints (any, when empty); the
// current one by default. An active sprint has Complete sprint (then the
// view switches to Sprint planning, read again, with the carried-over
// tickets in the next sprint): a window
// says how many unfinished tickets carry over and into which sprint (the
// next planned one of its board), with the sprint's goal, before PM ends it.
// The methods join TicketsView.

(() => {
  const P = TicketsView.prototype;
  const prefixes = () => ((typeof state !== 'undefined' && state.config?.pmSprintPrefixes) || []).map(p => p.toLowerCase());

  // The sprints to pick from: [{ name, status }], the active ones first.
  P.reviewSprints = function () {
    if (this.reviewList) return this.reviewList;
    if (!this.reviewLoading && this.data.review) {
      this.reviewLoading = true;
      const projects = [...new Set(this.data.review.items.map(t => t.project).filter(Boolean))];
      Promise.all(projects.map(p => this.optionsFor(p).then(o => o?.sprints || []).catch(() => []))).then(lists => {
        const byName = new Map();
        lists.forEach((list, i) => { for (const s of list) if (!byName.has(s.name)) byName.set(s.name, { ...s, project: projects[i] }); });
        // And any sprint the tickets name that PM's list missed.
        for (const t of this.data.review.items) if (t.sprint && !byName.has(t.sprint)) byName.set(t.sprint, { name: t.sprint, status: '' });
        const ps = prefixes();
        let all = [...byName.values()];
        const followed = all.filter(s => !ps.length || ps.some(p => s.name.toLowerCase().startsWith(p)));
        if (followed.length) all = followed;
        this.reviewList = all.sort((a, b) => (a.status !== 'ACTIVE') - (b.status !== 'ACTIVE') || a.name.localeCompare(b.name, undefined, { numeric: true }));
        this.reviewLoading = false;
        if (this.list === 'review') this.renderList();
      });
    }
    return null;
  };

  P.reviewSprint = function () {
    const list = this.reviewSprints() || [];
    if (!this.reviewName) try { this.reviewName = localStorage.getItem('pmReviewSprint') || null; } catch { /* none */ }
    return list.find(s => s.name === this.reviewName) || list[0] || null;
  };

  P.reviewHas = function (t) {
    const s = this.reviewSprint();
    return !!s && t.sprint === s.name;
  };

  // Over the list: the sprint, and how much of it is done.
  P.reviewBar = function () {
    const bar = el('div', 'review-bar');
    const list = this.reviewSprints();
    const current = this.reviewSprint();
    if (!list) { bar.append(el('span', 'review-progress', 'Reading the sprints…')); return bar; }
    if (!current) { bar.append(el('span', 'review-progress', 'No open sprint.')); return bar; }
    const pick = this.dropdown({
      value: current.name, key: 'review:sprint', cls: 'review-sprint',
      choices: list.map(s => ({ value: s.name, label: s.name, group: s.status === 'ACTIVE' ? 'Current' : 'Upcoming' })),
      onPick: v => {
        this.reviewName = v;
        try { localStorage.setItem('pmReviewSprint', v); } catch { /* this run only */ }
        this.renderList();
      },
    });
    // Everyone's stories in the sprint (whatever the filters hide).
    const all = (this.data.review?.items || []).filter(t => isStory(t) && t.sprint === current.name);
    const n = c => all.filter(t => (t.category || 'todo') === c).length;
    const done = n('done'), prog = n('in_progress');
    const meter = el('span', 'review-meter');
    const pct = x => (all.length ? (100 * x) / all.length : 0) + '%';
    const md = el('i', 'm-done'); md.style.width = pct(done);
    const mp = el('i', 'm-prog'); mp.style.width = pct(prog);
    meter.append(md, mp);
    const progress = el('span', 'review-progress');
    progress.append(meter, `${done} of ${all.length} stories done · ${prog} in progress · ${all.length - done - prog} to do`);
    bar.append(pick, progress);
    if (current.status === 'ACTIVE' && current.id) {
      const done = el('button', 'review-complete', 'Complete sprint');
      done.type = 'button';
      done.title = `End ${current.name} in PM`;
      done.onclick = () => this.confirmComplete(current, done);
      bar.append(done);
    }
    return bar;
  };
  // The sprint after this one: the first planned sprint of the same board
  // (by name, so Sprint 38 before Sprint 39).
  P.nextSprint = function (sprint) {
    return (this.reviewList || []).filter(s => s.status === 'PLANNED' && s.id && s.boardId && s.boardId === sprint.boardId)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))[0] || null;
  };

  // After Complete sprint: the sprints and the tickets as PM has them now
  // (every list is read again when it shows: the review's, and All tickets,
  // which Sprint planning shows), then Sprint planning on the sprint the
  // tickets carried over into, so you see them there and plan the rest.
  P.afterCompleteSprint = function (next) {
    this.reviewList = null;
    this.reviewName = null;
    try { localStorage.removeItem('pmReviewSprint'); } catch { /* none */ }
    this.forgetSprints();
    delete this.data.review;
    delete this.data.all;
    const plan = this.planState();
    if (next) plan.sprintName = next.name;
    plan.sprints = null;
    this.savePlan?.();
    this.tabs.querySelector('[data-list="plan"]')?.click();
    if (this.list !== 'plan') this.load(true);
    // PM's search can take a moment to show the moved tickets: once more.
    setTimeout(() => { if (this.list === 'plan') this.load(true); }, 4000);
  };

  P.confirmComplete = function (sprint, button) {
    const next = this.nextSprint(sprint);
    // Every unfinished ticket of the sprint carries over, not just stories.
    const left = (this.data.review?.items || []).filter(t => t.sprint === sprint.name && t.category !== 'done');
    const kinds = new Map();
    for (const t of left) { const k = isStory(t) ? 'stories' : /bug/i.test(t.type || '') ? 'bugs' : 'other'; kinds.set(k, (kinds.get(k) || 0) + 1); }
    const shade = el('div', 'review-shade');
    const box = el('div', 'review-confirm');
    // It grows out of the button, and shrinks back into it.
    const close = async () => {
      document.removeEventListener('keydown', onKey, true);
      window.uiSound?.('close');
      const r = await morphClose(box, button, { backdrop: shade });
      r?.done?.();
      shade.remove();
    };
    const onKey = e => { if (isBackKey(e) && !box.classList.contains('busy')) { e.preventDefault(); e.stopImmediatePropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    shade.onclick = e => { if (e.target === shade && !box.classList.contains('busy')) close(); };
    const day = d => (d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
    box.append(el('h3', null, `Complete ${sprint.name}?`));
    if (sprint.startDate || sprint.endDate) box.append(el('div', 'review-confirm-dates', [day(sprint.startDate), day(sprint.endDate)].filter(Boolean).join(' – ')));
    const carry = el('div', 'review-confirm-carry');
    const num = el('span', 'review-confirm-n', String(left.length));
    if (!left.length) carry.append('Every ticket is done: nothing carries over.');
    else if (next) carry.append(num, ` unfinished ticket${left.length === 1 ? '' : 's'} will carry over into `, el('b', null, next.name));
    else carry.append(num, ` unfinished ticket${left.length === 1 ? '' : 's'} will go to the backlog (this board has no planned sprint).`);
    box.append(carry);
    if (left.length) box.append(el('div', 'review-confirm-kinds', ['stories', 'bugs', 'other'].filter(k => kinds.get(k)).map(k => `${kinds.get(k)} ${k === 'other' ? 'other tickets' : k}`).join(' · ')));
    box.append(el('div', 'review-confirm-label', 'Sprint goal'));
    box.append(el('div', 'review-confirm-goal' + (sprint.goal ? '' : ' none'), sprint.goal || 'This sprint has no goal.'));
    const err = el('div', 'tickets-error hidden');
    const actions = el('div', 'review-confirm-actions');
    const cancel = el('button', null, 'Cancel');
    cancel.type = 'button';
    cancel.onclick = close;
    const go = el('button', 'primary', 'Complete sprint');
    go.type = 'button';
    go.onclick = async () => {
      box.classList.add('busy');
      go.disabled = cancel.disabled = true;
      go.textContent = 'Completing…';
      err.classList.add('hidden');
      const r = await window.deck.pmCompleteSprint({ project: sprint.project, sprintId: sprint.id, targetSprintId: next?.id || null })
        .catch(e => ({ error: String(e?.message || e) }));
      if (r?.notConnected) { close(); return this.setConnected({ connected: false }); }
      if (!r || r.error) {
        box.classList.remove('busy');
        go.disabled = cancel.disabled = false;
        go.textContent = 'Complete sprint';
        err.textContent = r?.error || 'PM did not answer.';
        err.classList.remove('hidden');
        return;
      }
      close();
      this.afterCompleteSprint(next);
    };
    actions.append(cancel, go);
    box.append(err, actions);
    shade.append(box);
    this.view.append(shade);
    window.uiSound?.('open');
    morphOpen(box, button, { backdrop: shade });
    cancel.focus();   // not Complete: a stray Enter must not end the sprint
  };
})();
