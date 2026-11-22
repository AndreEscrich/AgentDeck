// Sprint review: the Tickets view's fourth tab. One sprint's tickets,
// stories only, everyone's and done ones too, in one list like All tickets (not grouped
// by epic): by default done first, then in progress, then to do, each
// newest first. The sprint picker sits over the list, with how much of it
// is done. The sprints: the open ones (the active ones first) whose names
// start with one of Settings → Tactile PM → Sprints (any, when empty); the
// current one by default. The methods join TicketsView.

(() => {
  const P = TicketsView.prototype;
  const prefixes = () => ((typeof state !== 'undefined' && state.config?.pmSprintPrefixes) || []).map(p => p.toLowerCase());

  // The sprints to pick from: [{ name, status }], the active ones first.
  P.reviewSprints = function () {
    if (this.reviewList) return this.reviewList;
    if (!this.reviewLoading && this.data.review) {
      this.reviewLoading = true;
      const projects = [...new Set(this.data.review.items.map(t => t.project).filter(Boolean))];
      Promise.all(projects.map(p => window.deck.pmOptions(p).then(o => o?.sprints || []).catch(() => []))).then(lists => {
        const byName = new Map();
        for (const s of lists.flat()) if (!byName.has(s.name)) byName.set(s.name, { name: s.name, status: s.status });
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
    const pick = document.createElement('select');
    pick.className = 'review-sprint';
    const label = s => s.name + (s.status === 'ACTIVE' ? ' (current)' : '');
    for (const s of list) pick.append(new Option(label(s), s.name));
    pick.value = current.name;
    pick.onchange = () => {
      this.reviewName = pick.value;
      try { localStorage.setItem('pmReviewSprint', pick.value); } catch { /* this run only */ }
      this.renderList();
    };
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
    return bar;
  };
})();
