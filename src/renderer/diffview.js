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

function fileSummary(f) {
  const { add, del } = fileStats(f);
  const counts = el('span', 'change-counts');
  counts.append(el('span', 'plus', add ? `+${add}` : ''), el('span', 'minus', del ? ` −${del}` : ''));
  const summary = el('summary');
  summary.append(
    el('span', 'change-badge ' + f.status, BADGES[f.status] || 'Edited'),
    el('span', 'change-path', f.path),
    counts,
  );
  return summary;
}

// The card under the answer. Code files start open, up to a size that keeps
// the chat readable; you can open the rest, or the review view, yourself.
function changesCard(files) {
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
  const addFile = (parent, f, open) => {
    const row = el('details', 'change-file');
    row.title = f.path;
    const summary = fileSummary(f);
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
    const name = f.path.split(/[\\/]/).pop();
    const dir = f.path.slice(0, -name.length).replace(/\/$/, '');
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
