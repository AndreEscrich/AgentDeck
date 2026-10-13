// The Branches view (the branch button on the Hub's left rail): pick an SVN
// branch of the project in Settings → Branch diff project, and see what the
// branch itself changed, as a Changes card with its class diagram. Changes
// that came in from trunk are left out (see src/svnbranches.js).
//
// Branches are listed newest first; the filter box keeps the branches whose
// name starts with what you type. A branch's diff is kept while the app
// runs, per revision.

const BRANCH_FILE_LIMIT = 2000;

// A file's domain: its folder under Assets/Code (MergeSideBoard); a
// module's assets (Assets/ModulesAssets/MergeSideBoard) are "MergeSideBoard
// assets"; anything else under Assets goes by its folder there, else by its
// first folder.
function domainOf(file) {
  const code = /(?:^|\/)Assets\/Code\/([^/]+)\//.exec(file);
  if (code) return code[1];
  const module = /(?:^|\/)Assets\/ModulesAssets\/([^/]+)\//.exec(file);
  if (module) return `${module[1]} assets`;
  const assets = /(?:^|\/)Assets\/([^/]+)\//.exec(file);
  if (assets) return `Assets/${assets[1]}`;
  return file.split('/')[0];
}

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
    this.source.textContent = `${r.branches.length} feature branches · ${r.url}`;
    this.source.title = `${r.url}${r.hidden ? `
${r.hidden} release and other branches not listed (only person_feature names are)` : ''}`;
    this.renderList();
  }

  renderList() {
    if (!this.branches) return;
    const q = this.filter.value.trim().toLowerCase();
    // What you type is the start of the branch's name ("esc": escrich_…).
    const shown = this.branches.filter(b => !q || b.name.toLowerCase().startsWith(q)).slice(0, 300);
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
    // The branch's own commits (merges from trunk left out), newest first.
    if (r.commits?.length) {
      const list = document.createElement('details');
      list.className = 'branch-commits';
      list.appendChild(el('summary', null, `${r.commits.length} commit${r.commits.length === 1 ? '' : 's'} of its own`));
      for (const c of r.commits) {
        const row = el('div', 'branch-commit');
        row.append(
          el('span', 'branch-commit-rev', `r${c.revision}`),
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
