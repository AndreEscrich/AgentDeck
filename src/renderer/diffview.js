// Draws file diffs for code review: line numbers, syntax colors, code files
// first, and a full-window review view with a file list.
//
// A file is { path, status: 'new' | 'mod' | 'del' | 'bin', lines: [[kind, text]] },
// where kind is 'hunk', 'add', 'del' or 'ctx' and text starts with '+', '-' or ' '.

const LANGUAGES = {
  cs: 'csharp',
  shader: 'cpp', hlsl: 'cpp', cginc: 'cpp', compute: 'cpp',
  c: 'cpp', h: 'cpp', cpp: 'cpp', mm: 'objectivec', m: 'objectivec',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', java: 'java', kt: 'kotlin', swift: 'swift',
  json: 'json', asmdef: 'json', asmref: 'json',
  css: 'css', html: 'xml', xml: 'xml', sh: 'bash', md: 'markdown', yml: 'yaml', yaml: 'yaml',
};

// Files you review as code. Everything else (Unity .prefab, .asset, .meta,
// .unity, images) goes into the collapsed "Other files" group.
const CODE_EXTENSIONS = new Set(['cs', 'shader', 'hlsl', 'cginc', 'compute', 'c', 'h', 'cpp', 'mm', 'm',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'java', 'kt', 'swift', 'css', 'html', 'sh', 'asmdef', 'asmref']);

function extensionOf(p) {
  const name = p.split(/[\\/]/).pop();
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function isCodeFile(p) {
  return CODE_EXTENSIONS.has(extensionOf(p));
}

function fileStats(f) {
  let add = 0;
  let del = 0;
  for (const [kind] of f.lines) {
    if (kind === 'add') add++;
    if (kind === 'del') del++;
  }
  return { add, del };
}

// Code files first, then by path.
function sortFiles(files) {
  return [...files].sort((a, b) => (isCodeFile(b.path) - isCodeFile(a.path)) || a.path.localeCompare(b.path));
}

function highlightLine(text, language) {
  if (!language || !window.hljs || text.length > 2000) return null;
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

// One diff table: old line number, new line number, sign, code.
function renderDiff(file, { maxLines = 3000 } = {}) {
  const language = LANGUAGES[extensionOf(file.path)];
  const diff = el('div', 'diff');
  let oldNo = 0;
  let newNo = 0;
  const lines = file.lines.slice(0, maxLines);
  for (const [kind, text] of lines) {
    const row = el('div', 'diff-line ' + kind);
    if (kind === 'hunk') {
      const m = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
      if (m) { oldNo = Number(m[1]); newNo = Number(m[2]); }
      row.append(el('span', 'ln'), el('span', 'ln'), el('span', 'code', text));
      diff.appendChild(row);
      continue;
    }
    const oldCell = el('span', 'ln', kind === 'add' ? '' : String(oldNo));
    const newCell = el('span', 'ln', kind === 'del' ? '' : String(newNo));
    if (kind !== 'add') oldNo++;
    if (kind !== 'del') newNo++;
    const body = text.slice(1);
    const code = el('span', 'code');
    const html = highlightLine(body, language);
    if (html != null) code.innerHTML = html || ' ';
    else code.textContent = body || ' ';
    row.append(oldCell, newCell, el('span', 'sign', text[0] === ' ' ? '' : text[0]), code);
    diff.appendChild(row);
  }
  if (file.lines.length > maxLines) diff.appendChild(el('div', 'diff-line hunk', `… ${file.lines.length - maxLines} more lines`));
  if (!file.lines.length) diff.appendChild(el('div', 'diff-line hunk', 'No text changes to show'));
  return diff;
}

const BADGES = { new: 'New', mod: 'Edited', del: 'Deleted', bin: 'Binary' };

// ---------- C# files: namespace and class name instead of the path ----------

// A C# file is named by its namespace and its file name, the way you find
// it in code: "Client.QuestPass - QuestPassMainView". The full path stays in
// the tooltip. The namespace comes from the file on disk (the main process
// reads its "namespace" line), or, for a deleted or new file, from the
// diff, which then holds every line of it.
const CS_FILE = /\.cs$/i;
const NAMESPACE_LINE = /^[+\- ]?[ \t]*namespace[ \t]+([A-Za-z_][\w.]*)/;

function namespaceInDiff(f) {
  for (const [, text] of f.lines || []) {
    const m = NAMESPACE_LINE.exec(text || '');
    if (m) return m[1];
  }
  return null;
}

// The two parts of a file's title: dimmed in front, and the name.
function titleParts(f) {
  const base = f.path.split(/[\\/]/).pop();
  if (CS_FILE.test(base)) {
    return { front: f.namespace ? `${f.namespace} - ` : '', name: base.replace(CS_FILE, '') };
  }
  return { front: f.path.slice(0, f.path.length - base.length), name: base };
}

// Finds the namespace of every C# file in the list (f.namespace), then
// calls done(). cwd: the agent's folder, for paths relative to it.
function loadNamespaces(files, cwd, done) {
  const cs = files.filter(f => CS_FILE.test(f.path) && f.namespace === undefined);
  for (const f of cs) f.namespace = namespaceInDiff(f);
  const missing = cs.filter(f => !f.namespace && f.status !== 'del');
  if (!missing.length || !window.deck?.csNamespaces) return done();
  const abs = p => (p.startsWith('/') || /^[a-z]:[\\/]/i.test(p) || !cwd ? p : `${cwd.replace(/[\\/]$/, '')}/${p}`);
  window.deck.csNamespaces(missing.map(f => abs(f.path)))
    .then(names => { missing.forEach((f, i) => { if (names?.[i]) f.namespace = names[i]; }); })
    .catch(() => {})
    .finally(done);
}

function fileSummary(f) {
  const { add, del } = fileStats(f);
  const counts = el('span', 'change-counts');
  counts.append(el('span', 'plus', add ? `+${add}` : ''), el('span', 'minus', del ? ` −${del}` : ''));
  // The file name stands out; its folder (or a C# file's namespace) is
  // dimmed in front of it.
  const { front, name } = titleParts(f);
  const pathEl = el('span', 'change-path');
  pathEl.append(el('span', 'change-folder', front), el('span', 'change-name', name));
  const summary = el('summary');
  summary.append(
    el('span', 'change-chevron'),
    el('span', 'change-badge ' + f.status, BADGES[f.status] || 'Edited'),
    pathEl,
    counts,
  );
  return summary;
}

// The card under the answer. Code files start open, up to a size that keeps
// the chat readable; you can open the rest, or the review view, yourself.
function changesCard(files, cwd) {
  files = sortFiles(files);
  const code = files.filter(f => isCodeFile(f.path));
  const other = files.filter(f => !isCodeFile(f.path));
  let totalAdd = 0;
  let totalDel = 0;
  for (const f of files) {
    const s = fileStats(f);
    totalAdd += s.add;
    totalDel += s.del;
  }

  const card = el('div', 'changes');
  const head = el('div', 'changes-head');
  const review = el('button', 'review-btn', 'Review');
  review.title = 'Open the changes in the whole window';
  review.onclick = () => openReview(files);
  head.append(
    el('span', 'changes-title', `Changed ${files.length} file${files.length === 1 ? '' : 's'}`),
    el('span', 'plus', ` +${totalAdd}`),
    el('span', 'minus', ` −${totalDel}`),
    review,
  );
  card.appendChild(head);

  let openBudget = 400; // diff lines shown open in the chat
  const titles = [];   // [file, its summary], to show namespaces once they are known
  const addFile = (parent, f, open) => {
    const row = el('details', `change-file status-${f.status}`);
    row.title = f.path;
    const summary = fileSummary(f);
    titles.push([f, summary]);
    row.appendChild(summary);
    // Drawing happens when the file is first opened, so big changes stay fast.
    const draw = () => {
      if (!row.querySelector('.diff')) row.appendChild(renderDiff(f));
    };
    row.addEventListener('toggle', () => { if (row.open) draw(); });
    if (open) { row.open = true; draw(); }
    parent.appendChild(row);
  };

  for (const f of code) {
    const open = openBudget > 0;
    openBudget -= f.lines.length;
    addFile(card, f, open);
  }
  if (other.length) {
    const group = el('details', 'other-files');
    const s = el('summary', null, `Other files (${other.length})`);
    group.appendChild(s);
    for (const f of other) addFile(group, f, false);
    // Without code files, the other files are what there is to see.
    if (!code.length) group.open = true;
    card.appendChild(group);
  }
  loadNamespaces(files, cwd, () => {
    for (const [f, summary] of titles) {
      const { front, name } = titleParts(f);
      summary.querySelector('.change-folder').textContent = front;
      summary.querySelector('.change-name').textContent = name;
    }
  });
  return card;
}

// ---------- full-window review ----------

let reviewEl = null;

function closeReview() {
  reviewEl?.remove();
  reviewEl = null;
}

function openReview(files, start = 0) {
  closeReview();
  files = sortFiles(files);
  reviewEl = el('div', 'review');
  const bar = el('div', 'review-bar');
  const close = el('button', null, 'Close (Esc)');
  close.onclick = closeReview;
  bar.append(el('span', 'review-title', `Review · ${files.length} file${files.length === 1 ? '' : 's'}`), el('span', 'hint', '↑ ↓ to switch files'), close);

  const list = el('div', 'review-list');
  const pane = el('div', 'review-pane');
  let current = -1;
  const items = files.map((f, i) => {
    const item = el('div', 'review-item' + (isCodeFile(f.path) ? '' : ' other'));
    const { add, del } = fileStats(f);
    const parts = titleParts(f);
    const name = parts.name;
    const dir = parts.front.replace(/( - |\/)$/, '');
    const text = el('div', 'review-item-text');
    text.append(el('div', 'review-name', name), el('div', 'review-dir', dir));
    const counts = el('span', 'change-counts');
    counts.append(el('span', 'plus', add ? `+${add}` : ''), el('span', 'minus', del ? ` −${del}` : ''));
    item.append(el('span', 'change-badge ' + f.status, (BADGES[f.status] || 'Edited')[0]), text, counts);
    item.title = f.path;
    item.onclick = () => select(i);
    list.appendChild(item);
    return item;
  });

  function select(i) {
    if (i < 0 || i >= files.length || i === current) return;
    items[current]?.classList.remove('active');
    current = i;
    items[i].classList.add('active');
    items[i].scrollIntoView({ block: 'nearest' });
    pane.innerHTML = '';
    const f = files[i];
    pane.append(el('div', 'review-path', f.path), renderDiff(f, { maxLines: 20000 }));
    pane.scrollTop = 0;
  }

  reviewEl.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); closeReview(); }
    if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); select(current + 1); }
    if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); select(current - 1); }
  });
  reviewEl.tabIndex = -1;

  const body = el('div', 'review-body');
  body.append(list, pane);
  reviewEl.append(bar, body);
  document.getElementById('main').appendChild(reviewEl);
  select(Math.min(start, files.length - 1));
  reviewEl.focus();
}

window.changesCard = changesCard;
window.openReview = openReview;
window.closeReview = closeReview;
