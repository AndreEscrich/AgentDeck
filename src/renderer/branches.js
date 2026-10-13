// The Branches view (the branch button on the Hub's left rail): pick an SVN
// branch of the project in Settings → Branch diff project, and see what the
// branch itself changed, as a Changes card with its class diagram. Changes
// that came in from trunk are left out (see src/svnbranches.js).
//
// Branches are listed newest first; the filter box narrows the list by name
// or author. A branch's diff is kept while the app runs, per revision.

const BRANCH_FILE_LIMIT = 600;

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
    this.showIdle();
  }

  // Shows the view; the first time (or after the project changed) it reads
  // the branches.
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
    if (again) window.uiSound?.('tick');
    this.source.textContent = 'Reading the branches…';
    this.list.replaceChildren();
    const r = await window.deck.svnBranches().catch(err => ({ ok: false, error: String(err?.message || err) }));
    this.loading = false;
    if (!r?.ok) {
      this.source.textContent = '';
      this.list.replaceChildren(el('div', 'note err', r?.error || 'Could not read the branches.'));
      return;
    }
    this.branches = r.branches;
    this.source.textContent = `${r.branches.length} branches · ${r.url}`;
    this.source.title = r.url;
    this.renderList();
  }

  renderList() {
    if (!this.branches) return;
    const q = this.filter.value.trim().toLowerCase();
    const shown = this.branches.filter(b => !q || b.name.toLowerCase().includes(q) || b.author.toLowerCase().includes(q)).slice(0, 300);
    this.list.replaceChildren();
    for (const b of shown) {
      const row = el('button', 'branch-row' + (this.selected === b.name ? ' selected' : ''));
      row.type = 'button';
      row.title = `${b.name}\nr${b.revision} by ${b.author}`;
      const when = b.date ? timeAgo(Date.parse(b.date)) : '';
      row.append(el('span', 'branch-name', b.name), el('span', 'branch-meta', [b.author, when].filter(Boolean).join(' · ')));
      row.onclick = () => this.pick(b);
      this.list.appendChild(row);
    }
    if (!shown.length) this.list.appendChild(el('div', 'note', 'No branch matches.'));
  }

  async pick(b) {
    window.uiSound?.('select');
    this.selected = b.name;
    this.renderList();
    const key = `${b.name}@${b.revision}`;
    const box = el('div', 'branch-result');
    box.append(el('div', 'branch-title', b.name), el('div', 'note', `Working out what ${b.name} changed, leaving out what came in from trunk…`));
    this.main.replaceChildren(box);
    if (!this.results.has(key)) {
      const p = window.deck.svnBranchDiff(b.name).catch(err => ({ ok: false, error: String(err?.message || err) }));
      this.results.set(key, p);
      p.then(r => { if (!r?.ok) this.results.delete(key); });
    }
    const r = await this.results.get(key);
    if (this.selected !== b.name) return;   // another branch was picked meanwhile
    box.replaceChildren(el('div', 'branch-title', b.name));
    if (!r?.ok) {
      box.appendChild(el('div', 'note err', r?.error || 'Could not get the diff.'));
      return;
    }
    for (const n of r.notes || []) box.appendChild(el('div', 'branch-note', n));
    const all = parseUnifiedDiff(r.diff || '');
    // Unity's .meta files change with every new or moved asset: hidden, counted.
    const meta = all.filter(f => /\.meta$/i.test(f.path));
    const files = all.filter(f => !/\.meta$/i.test(f.path));
    if (!files.length) {
      box.appendChild(el('div', 'note', meta.length ? `Only .meta files changed (${meta.length}).` : 'No differences.'));
      return;
    }
    box.appendChild(changesCard(files.slice(0, BRANCH_FILE_LIMIT), r.cwd, { title: r.title }));
    const left = [];
    if (files.length > BRANCH_FILE_LIMIT) left.push(`${files.length - BRANCH_FILE_LIMIT} more files not shown`);
    if (meta.length) left.push(`${meta.length} .meta file${meta.length === 1 ? '' : 's'} hidden`);
    if (left.length) box.appendChild(el('div', 'note', left.join(' · ')));
  }
}

window.BranchesView = BranchesView;
