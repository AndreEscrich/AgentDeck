// The Branches view (the branch button on the Hub's left rail): pick an SVN
// branch of the projects in Settings → Branch diff, and see what the branch
// itself changed, as a Changes card with its class diagram. Changes that came
// in from trunk are left out (see src/svnbranches.js).
//
// Branches of all the projects are listed together, newest first, with your
// GitHub pull requests and branches when Settings → Branch diff → GitHub is on
// (see src/githubbranches.js); the filter box keeps the branches whose name
// starts with what you type. A branch's diff is kept while the app runs, per
// revision.

// The projects in Settings (none: every project on the server).
function svnProjectList(config) {
  const list = Array.isArray(config.svnProjects) ? config.svnProjects : [];
  return list.map(p => String(p || '').trim()).filter(Boolean);
}

const BRANCH_FILE_LIMIT = 2000;

// A file's domain: a changed package (merge-board package); its folder
// under Assets/Code (MergeSideBoard); a
// module's assets (Assets/ModulesAssets/MergeSideBoard) are "MergeSideBoard
// assets"; anything else under Assets goes by its folder there, else by its
// first folder.
function domainOf(file) {
  // A package the branch changed (its repository's changes, see packagediff.js).
  const pkg = /(?:^|\/)Packages\/([^/]+\.[^/]+)\//.exec(file);
  if (pkg) return `${pkg[1].replace(/^com\.[^.]+\./, '')} package`;
  const code = /(?:^|\/)Assets\/Code\/([^/]+)\//.exec(file);
  if (code) return code[1];
  const module = /(?:^|\/)Assets\/ModulesAssets\/([^/]+)\//.exec(file);
  if (module) return `${module[1]} assets`;
  const assets = /(?:^|\/)Assets\/([^/]+)\//.exec(file);
  if (assets) return `Assets/${assets[1]}`;
  return file.split('/')[0];
}

// What a branch's diff has come to while it loads (svn can take a minute):
// the steps with what each found, the branch's latest commits, and a
// container per domain that fills as the diff's files come in. In the retro
// theme it sounds like the ship's systems booting (see sounds.js): they
// start, hum while it works, chatter as data comes in, and come online.
class BranchLoading {
  constructor(name) {
    this.root = el('div', 'branch-loading');
    this.started = Date.now();
    this.head = el('div', 'branch-loading-head');
    this.clock = el('span', 'branch-loading-clock', '0s');
    this.head.append(el('span', 'branch-loading-dot'), el('span', null, `Working out what ${name} changed`), this.clock);
    this.steps = el('div', 'branch-loading-steps');
    this.rows = {};
    for (const [id, label] of [['history', 'Reading its history'], ['diff', 'Comparing with trunk'], ['fetch', 'Fetching its C# files']]) this.addRow(id, label);
    this.commits = el('div', 'branch-loading-commits');
    this.grid = el('div', 'branch-loading-grid');
    // Placeholders until the files are known.
    for (let i = 0; i < 6; i++) this.grid.appendChild(el('div', 'branch-ghost'));
    this.root.append(this.head, this.steps, this.commits, this.grid);
    this.domains = new Map();   // domain -> { card, expected, got, recent, ... }
    // The hum runs while this is on screen (not when you look elsewhere).
    this.timer = setInterval(() => {
      this.clock.textContent = `${Math.round((Date.now() - this.started) / 1000)}s`;
      window.uiSound?.('bootHum', this.shown());
    }, 1000);
    this.set('history', 'active');
    this.lastData = 0;
    requestAnimationFrame(() => {
      this.sound('bootStart');
      window.uiSound?.('bootHum', this.shown());
    });
  }

  shown() {
    return this.root.isConnected && this.root.offsetParent !== null;
  }

  sound(name) {
    if (this.shown()) window.uiSound?.(name);
  }

  // Data coming in: a chatter now and then, not on every batch.
  chatter() {
    const now = Date.now();
    if (now - this.lastData < 450) return;
    this.lastData = now;
    this.sound('bootData');
  }

  addRow(id, label) {
    const row = el('div', 'branch-step');
    const detail = el('span', 'branch-step-detail');
    const bar = el('span', 'branch-step-bar');
    bar.appendChild(el('span'));
    row.append(el('span', 'branch-step-mark'), el('span', 'branch-step-label', label), detail, bar);
    this.rows[id] = { row, detail, bar, label: row.children[1] };
    this.steps.appendChild(row);
  }

  set(id, state, detail) {
    const r = this.rows[id];
    r.row.classList.remove('active', 'done');
    if (state) r.row.classList.add(state);
    if (detail != null) r.detail.textContent = detail;
  }

  progress(id, fraction) {
    const r = this.rows[id];
    r.bar.classList.add('shown');
    r.bar.firstChild.style.width = `${Math.round(Math.min(1, fraction) * 100)}%`;
  }

  domain(name) {
    if (!this.domains.has(name)) {
      if (!this.domains.size) this.grid.replaceChildren();
      // Each new container is a unit coming online: a blip, one after another.
      const n = this.domains.size;
      if (n < 14) setTimeout(() => this.sound('bootUnit'), 120 + n * 70);
      const card = el('div', 'branch-ghost filled');
      const title = el('div', 'branch-ghost-title', name);
      const count = el('span', 'branch-ghost-count');
      title.appendChild(count);
      const files = el('div', 'branch-ghost-files');
      const bar = el('div', 'branch-ghost-bar');
      bar.appendChild(el('span'));
      card.append(title, files, bar);
      this.grid.appendChild(card);
      this.domains.set(name, { card, count, files, bar, expected: 0, got: 0, recent: [] });
    }
    return this.domains.get(name);
  }

  paint(d) {
    d.count.textContent = d.expected ? `${Math.min(d.got, d.expected)} / ${d.expected}` : `${d.got}`;
    d.bar.firstChild.style.width = d.expected ? `${Math.round(Math.min(1, d.got / d.expected) * 100)}%` : '0%';
    d.files.replaceChildren(...d.recent.slice(-4).map(f => el('div', 'branch-ghost-file', f.split('/').pop())));
    d.card.classList.toggle('complete', d.expected > 0 && d.got >= d.expected);
  }

  step(s) {
    if (!s || typeof s !== 'object') return;
    if (s.stage === 'history' && s.commitCount != null) {
      this.sound('bootStep');
      this.set('history', 'done', `${s.commitCount} commit${s.commitCount === 1 ? '' : 's'} of its own · ${s.merges} merge${s.merges === 1 ? '' : 's'} from ${s.parent} left out`);
      this.rows.diff.label.textContent = `Comparing with ${s.parent}`;
      this.set('diff', 'active', `${(s.paths || []).length} files to compare`);
      this.expected = (s.paths || []).length;
      // The files its commits touched, by domain (biggest first).
      const by = new Map();
      for (const p of s.paths || []) by.set(domainOf(p), (by.get(domainOf(p)) || 0) + 1);
      for (const [name, n] of [...by].sort((a, b) => b[1] - a[1])) { const d = this.domain(name); d.expected = n; this.paint(d); }
      this.commits.replaceChildren(...(s.commits || []).slice(0, 5).map(c => {
        const row = el('div', 'branch-commit');
        row.append(
          el('span', 'branch-commit-rev', commitId(c)),
          el('span', 'branch-commit-msg', c.message || '(no message)'),
          el('span', 'branch-commit-meta', [c.author, c.date ? timeAgo(Date.parse(c.date)) : ''].filter(Boolean).join(' · ')),
        );
        return row;
      }));
    } else if (s.stage === 'diff') {
      if (s.base) this.rows.diff.label.textContent = `Comparing with ${s.parent}@${typeof s.base === 'number' ? `r${s.base}` : s.base}`;
      this.got = (this.got || 0) + (s.files || []).length;
      this.set('diff', 'active', this.expected ? `${Math.min(this.got, this.expected)} of ${this.expected} files` : `${this.got} files so far`);
      if (this.expected) this.progress('diff', this.got / this.expected);
      for (const f of s.files || []) {
        const d = this.domain(domainOf(f));
        d.got++;
        d.recent.push(f);
        d.dirty = true;
      }
      for (const d of this.domains.values()) if (d.dirty) { d.dirty = false; this.paint(d); }
      if (s.files?.length) this.chatter();
    } else if (s.stage === 'fetch') {
      if (!this.rows.diff.row.classList.contains('done')) {
        this.sound('bootStep');
        this.set('diff', 'done', `${this.got || 0} file${this.got === 1 ? '' : 's'} changed`);
        this.progress('diff', 1);
        for (const d of this.domains.values()) { d.card.classList.add('complete'); }
      }
      this.set('fetch', s.done >= s.total ? 'done' : 'active', s.total ? `${s.done} / ${s.total}` : 'already here');
      if (s.done < s.total) this.chatter();
      this.progress('fetch', s.total ? s.done / s.total : 1);
    } else if (s.stage === 'packages') {
      // A package it changed in the manifest: its repository's changes.
      if (!this.rows.packages) {
        this.set('fetch', 'done');
        this.progress('fetch', 1);
        this.addRow('packages', 'Comparing changed packages');
        this.sound('bootStep');
      }
      this.set('packages', 'active', s.name);
      this.domain(domainOf(`Packages/${s.name}/`)).card.classList.remove('complete');
      this.chatter();
    }
  }

  // ok: whether the diff came (all systems up) or failed.
  finish(ok) {
    clearInterval(this.timer);
    window.uiSound?.('bootHum', false);
    this.sound(ok ? 'bootReady' : 'error');
  }
}

// A branch in the list, and what its progress steps are sent with (see
// main.js): an SVN branch's name, a pull request's number or a GitHub
// branch's name.
const branchId = b => (b.source === 'github' ? String(b.number || b.branch) : b.name);
const branchKey = b => `${b.source || 'svn'}:${b.project}/${branchId(b)}`;
// A commit: its revision (SVN) or short hash (git).
const commitId = c => (c.sha ? c.sha.slice(0, 7) : `r${c.revision}`);

class BranchesView {
  constructor() {
    this.view = el('div', 'view branch-view hidden');
    $('views').appendChild(this.view);
    const side = el('aside', 'branch-side');
    this.filter = document.createElement('input');
    this.filter.type = 'search';
    this.filter.placeholder = 'Filter branches…';
    this.filter.className = 'branch-filter';
    this.filter.oninput = () => this.renderList();
    this.filter.onkeydown = e => {
      if (e.key === 'Enter') { e.preventDefault(); this.list.querySelector('.branch-row')?.click(); }
    };
    const refresh = el('button', 'icon branch-refresh', '↻');
    refresh.type = 'button';
    refresh.title = 'Read the branches again';
    refresh.onclick = () => this.load(true);
    const top = el('div', 'branch-side-top');
    top.append(this.filter, refresh);
    this.source = el('div', 'branch-source');
    this.list = el('div', 'branch-list scroll');
    side.append(top, this.source, this.list);
    this.main = el('section', 'branch-main scroll');
    this.view.append(side, this.main);
    this.branches = null;
    this.selected = null;
    this.results = new Map();   // "name@revision" -> promise of the result
    this.loadings = new Map();  // "name@revision" -> its BranchLoading, while it loads
    this.showIdle();
  }

  // Shows the view; the first time (or after the projects or the branch
  // names in Settings changed) it reads the branches.
  open(project) {
    if (project !== this.project) {
      this.project = project;
      this.branches = null;
      this.selected = null;
      this.showIdle();
    }
    if (!this.branches) this.load(false);
    requestAnimationFrame(() => this.filter.focus());
  }

  showIdle() {
    this.main.replaceChildren(el('div', 'branch-empty', 'Pick a branch to see what it changed. What came in from trunk is left out.'));
  }

  async load(again) {
    if (this.loading) return;
    this.loading = true;
    const project = this.project;
    if (again) window.uiSound?.('tick');
    // The list read last with the same settings, while it reads them again.
    const cached = this.branches ? null : await window.deck.svnBranches(true).catch(() => null);
    if (cached?.ok) this.showList(cached);
    else if (!this.branches) this.list.replaceChildren();
    this.source.textContent = this.branches ? `${this.source.textContent} · updating…` : 'Reading the branches…';
    this.source.classList.remove('err');
    const r = await window.deck.svnBranches().catch(err => ({ ok: false, error: String(err?.message || err) }));
    this.loading = false;
    // The settings changed meanwhile: read them with the new ones.
    if (project !== this.project) return this.load(false);
    if (!r?.ok) {
      if (this.branches) {
        this.source.textContent = `Could not read them again: ${r?.error || 'unknown error'}`;
        this.source.classList.add('err');
        return;
      }
      this.source.textContent = '';
      this.list.replaceChildren(el('div', 'note err', r?.error || 'Could not read the branches.'));
      return;
    }
    this.showList(r);
  }

  // A list of branches (see listBranches in src/svnbranches.js); a cached
  // one says when it was read (at).
  showList(r) {
    this.branches = r.branches;
    this.multi = r.all || r.sources.length > 1;
    const failed = r.sources.filter(s => s.error);
    this.source.textContent = [
      `${r.branches.length} feature branches`,
      r.filter.length ? `starting with ${r.filter.join(', ')}` : '',
      r.all ? [`${r.sources.filter(s => !s.github).length} projects`, ...r.sources.filter(s => s.github).map(s => s.project)].join(', ') : r.sources.map(s => s.project).join(', '),
      failed.length ? `${failed.length} could not be read` : '',
      r.at ? `read ${timeAgo(r.at) === 'now' ? 'just now' : `${timeAgo(r.at)} ago`}` : '',
    ].filter(Boolean).join(' · ');
    this.source.title = [
      r.skipped ? `Not read: ${r.skipped.inactive} projects nobody committed to for ${r.skipped.inactiveDays} days, ${r.skipped.noBranches} without a branches folder` : '',
      ...r.sources.map(s => s.error
        ? `${s.url}\n  could not be read: ${s.error}`
        : `${s.url}\n  ${s.count} listed${s.filtered ? `, ${s.filtered} with other names left out` : ''}${s.hidden ? `, ${s.hidden} release and other branches not listed (only person_feature names are)` : ''}`),
    ].filter(Boolean).join('\n');
    this.source.classList.toggle('err', failed.length > 0);
    this.renderList();
  }

  renderList() {
    if (!this.branches) return;
    const q = this.filter.value.trim().toLowerCase();
    // What you type is the start of the branch's name ("esc": escrich_…).
    const shown = this.branches.filter(b => !q || b.name.toLowerCase().startsWith(q)).slice(0, 300);
    // With SVN and GitHub branches in the list, each says which it is.
    const mixed = this.branches.some(b => b.source === 'github') && this.branches.some(b => b.source !== 'github');
    this.list.replaceChildren();
    for (const b of shown) {
      const row = el('button', 'branch-row' + (this.selected === branchKey(b) ? ' selected' : ''));
      row.type = 'button';
      const when = b.date ? timeAgo(Date.parse(b.date)) : '';
      if (b.source === 'github') {
        row.title = `${b.url}\n${b.kind === 'pull' ? `${b.title}\n${b.branch}` : b.branch}`;
        row.append(el('span', 'branch-name', b.name), el('span', 'branch-meta', [
          b.kind === 'pull' ? `${b.project}#${b.number}${b.draft ? ' (draft)' : ''}` : `${b.project} branch`, when,
        ].filter(Boolean).join(' · ')));
      } else {
        row.title = `${b.project}/${b.name}\nr${b.revision} by ${b.author}`;
        row.append(el('span', 'branch-name', b.name), el('span', 'branch-meta', [this.multi ? b.project : '', b.author, when].filter(Boolean).join(' · ')));
      }
      if (mixed) row.lastChild.prepend(b.source === 'github' ? el('span', 'branch-kind git', 'Git') : el('span', 'branch-kind svn', 'SVN'));
      row.onclick = () => this.pick(b);
      this.list.appendChild(row);
    }
    if (!shown.length) this.list.appendChild(el('div', 'note', 'No branch matches.'));
  }

  async pick(b) {
    window.uiSound?.('select');
    this.selected = branchKey(b);
    this.renderList();
    const key = `${branchKey(b)}@${b.sha || b.revision}`;
    const box = el('div', 'branch-result');
    box.append(el('div', 'branch-title', b.name));
    this.main.replaceChildren(box);
    // While it loads: what is known so far (see BranchLoading), kept per
    // branch so coming back to it shows how far it has got.
    if (!this.results.has(key)) {
      const loading = new BranchLoading(b.name);
      this.loadings.set(key, loading);
      const stop = window.deck.onSvnBranchProgress?.((project, id, step) => { if (project === b.project && id === branchId(b)) loading.step(step); });
      const p = (b.source === 'github'
        ? window.deck.githubBranchDiff({ kind: b.kind, project: b.project, number: b.number, branch: b.branch })
        : window.deck.svnBranchDiff(b.project, b.name)).catch(err => ({ ok: false, error: String(err?.message || err) }));
      this.results.set(key, p);
      p.then(r => { stop?.(); loading.finish(!!r?.ok); this.loadings.delete(key); if (!r?.ok) this.results.delete(key); });
    }
    const loading = this.loadings.get(key);
    if (loading) box.appendChild(loading.root);
    const r = await this.results.get(key);
    if (this.selected !== branchKey(b)) return;   // another branch was picked meanwhile
    box.replaceChildren(el('div', 'branch-title', b.name));
    if (!r?.ok) {
      box.appendChild(el('div', 'note err', r?.error || 'Could not get the diff.'));
      return;
    }
    for (const n of r.notes || []) box.appendChild(el('div', 'branch-note', n));
    // The branch's own commits (merges from trunk left out), newest first.
    if (r.commits?.length) {
      const list = document.createElement('details');
      list.className = 'branch-commits';
      list.appendChild(el('summary', null, `${r.commits.length} commit${r.commits.length === 1 ? '' : 's'} of its own`));
      for (const c of r.commits) {
        const row = el('div', 'branch-commit');
        row.append(
          el('span', 'branch-commit-rev', commitId(c)),
          el('span', 'branch-commit-msg', c.message.split('\n')[0] || '(no message)'),
          el('span', 'branch-commit-meta', [c.author, c.date ? timeAgo(Date.parse(c.date)) : '', `${c.files} file${c.files === 1 ? '' : 's'}`].filter(Boolean).join(' · ')),
        );
        row.title = c.message;
        list.appendChild(row);
      }
      box.appendChild(list);
    }
    const all = parseUnifiedDiff(r.diff || '');
    // Unity's .meta files change with every new or moved asset: hidden, counted.
    const meta = all.filter(f => /\.meta$/i.test(f.path));
    const files = all.filter(f => !/\.meta$/i.test(f.path));
    if (!files.length) {
      box.appendChild(el('div', 'note', meta.length ? `Only .meta files changed (${meta.length}).` : 'No differences.'));
      return;
    }
    // The domains it changed: click one (or several) to see only those.
    const domains = new Map();
    for (const f of files) {
      const d = domainOf(f.path);
      domains.set(d, (domains.get(d) || 0) + 1);
    }
    const picked = new Set();
    const chips = el('div', 'branch-domains');
    const slot = el('div', 'branch-card');
    const draw = () => {
      chips.replaceChildren();
      const all = el('button', 'branch-domain' + (picked.size ? '' : ' on'), `All · ${files.length}`);
      all.type = 'button';
      all.onclick = () => { picked.clear(); window.uiSound?.('select'); draw(); };
      chips.appendChild(all);
      for (const [d, n] of [...domains].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
        const chip = el('button', 'branch-domain' + (picked.has(d) ? ' on' : ''), `${d} · ${n}`);
        chip.type = 'button';
        chip.title = 'Show only this domain; click more to add them';
        chip.onclick = () => { if (picked.has(d)) picked.delete(d); else picked.add(d); window.uiSound?.('select'); draw(); };
        chips.appendChild(chip);
      }
      const shown = picked.size ? files.filter(f => picked.has(domainOf(f.path))) : files;
      const title = picked.size ? `${r.title} · ${[...picked].join(', ')}` : r.title;
      const notes = [];
      if (shown.length > BRANCH_FILE_LIMIT) notes.push(`${shown.length - BRANCH_FILE_LIMIT} more files not shown: pick a domain`);
      if (meta.length) notes.push(`${meta.length} .meta file${meta.length === 1 ? '' : 's'} hidden`);
      slot.replaceChildren(changesCard(shown.slice(0, BRANCH_FILE_LIMIT), r.cwd, { title }));
      if (notes.length) slot.appendChild(el('div', 'note', notes.join(' · ')));
    };
    if (domains.size > 1) box.appendChild(chips);
    box.appendChild(slot);
    draw();
  }
}

window.BranchesView = BranchesView;
window.svnProjectList = svnProjectList;
