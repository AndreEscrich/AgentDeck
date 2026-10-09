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

// Code files first; within them (and within the other files) modified
// files, then added ones, then deleted ones; then by path.
const STATUS_ORDER = { mod: 0, bin: 0, new: 1, del: 2 };
function sortFiles(files) {
  const rank = f => STATUS_ORDER[f.status] ?? 0;
  return [...files].sort((a, b) => (isCodeFile(b.path) - isCodeFile(a.path)) || rank(a) - rank(b) || a.path.localeCompare(b.path));
}

function highlightLine(text, language) {
  if (!language || !window.hljs || text.length > 2000) return null;
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

// One diff table: old line number, new line number, sign, code. With
// onLine, clicking a line calls onLine(row, { index, line, side, code }).
function renderDiff(file, { maxLines = 3000, onLine = null } = {}) {
  const language = LANGUAGES[extensionOf(file.path)];
  const diff = el('div', 'diff');
  let oldNo = 0;
  let newNo = 0;
  const lines = file.lines.slice(0, maxLines);
  lines.forEach(([kind, text], index) => {
    const row = el('div', 'diff-line ' + kind);
    row.dataset.index = String(index);
    if (kind === 'hunk') {
      const m = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
      if (m) { oldNo = Number(m[1]); newNo = Number(m[2]); }
      row.append(el('span', 'ln'), el('span', 'ln'), el('span', 'code', text));
      diff.appendChild(row);
      return;
    }
    const info = { index, line: kind === 'del' ? oldNo : newNo, side: kind === 'del' ? 'old' : 'new', code: text.slice(1) };
    // For jumping to a line from the class diagram.
    if (kind !== 'del') row.dataset.newLine = String(newNo);
    else row.dataset.oldLine = String(oldNo);
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
    if (onLine) {
      row.classList.add('commentable');
      row.title = 'Click to comment on this line';
      row.onclick = () => { if (!window.getSelection()?.toString()) onLine(row, info); };
    }
    diff.appendChild(row);
  });
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
  review.onclick = () => openReview(files, 0, { cwd });
  const undoable = files.filter(f => f.status !== 'bin');
  const undoAll = el('button', 'undo-all-btn', 'Undo all');
  undoAll.title = 'Put every file back the way it was before this task';
  head.append(
    el('span', 'changes-title', `Changed ${files.length} file${files.length === 1 ? '' : 's'}`),
    el('span', 'plus', ` +${totalAdd}`),
    el('span', 'minus', ` −${totalDel}`),
    review,
  );
  if (undoable.length && window.deck?.undoFile) head.insertBefore(undoAll, review);
  card.appendChild(head);
  const problem = el('div', 'changes-problem hidden');

  // Undo puts a file back the way it was before the task (see src/undo.js);
  // Redo puts the agent's version back. Each row has its own button, and
  // "Undo all" does every file that is not undone yet.
  const rows = new Map();   // file -> { row, button }
  const showProblems = errors => {
    problem.textContent = errors.join('\n');
    problem.classList.toggle('hidden', !errors.length);
  };
  const refreshUndoAll = () => {
    const allUndone = undoable.every(f => f.undone);
    undoAll.textContent = allUndone ? 'Redo all' : 'Undo all';
    undoAll.title = allUndone ? 'Put back every change of this task' : 'Put every file back the way it was before this task';
  };
  const toggle = async f => {
    if (f.undone) {
      const r = await window.deck.restoreFile(cwd, f.path, f.undone.previous);
      if (!r.ok) return r.error;
      f.undone = null;
    } else {
      const r = await window.deck.undoFile(cwd, { path: f.path, status: f.status, lines: f.lines });
      if (!r.ok) return r.error;
      f.undone = { previous: r.previous };
    }
    const { row, button } = rows.get(f);
    row.classList.toggle('undone', !!f.undone);
    button.textContent = f.undone ? 'Redo' : 'Undo';
    button.title = f.undone ? 'Put the agent\'s change back' : 'Put this file back the way it was before this task';
    return null;
  };
  const run = async list => {
    undoAll.disabled = true;
    const errors = [];
    for (const f of list) {
      const err = await toggle(f).catch(e => String(e?.message || e));
      if (err) errors.push(err);
    }
    undoAll.disabled = false;
    refreshUndoAll();
    showProblems(errors);
    window.uiSound?.(errors.length ? 'refuse' : 'detach');
  };
  undoAll.onclick = () => {
    const allUndone = undoable.every(f => f.undone);
    run(undoable.filter(f => !!f.undone === allUndone));
  };

  let openBudget = 400; // diff lines shown open in the chat
  const titles = [];   // [file, its summary], to show namespaces once they are known
  const addFile = (parent, f, open) => {
    const row = el('details', `change-file status-${f.status}`);
    row.title = f.path;
    const summary = fileSummary(f);
    titles.push([f, summary]);
    if (f.status !== 'bin' && window.deck?.undoFile) {
      const button = el('button', 'undo-btn', 'Undo');
      button.title = 'Put this file back the way it was before this task';
      // The button sits in the row's summary; a click must not open the diff.
      button.onclick = e => {
        e.preventDefault();
        e.stopPropagation();
        run([f]);
      };
      summary.appendChild(button);
      rows.set(f, { row, button });
      if (f.undone) { row.classList.add('undone'); button.textContent = 'Redo'; }
    }
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
  card.appendChild(problem);
  refreshUndoAll();
  loadNamespaces(files, cwd, () => {
    for (const [f, summary] of titles) {
      const { front, name } = titleParts(f);
      summary.querySelector('.change-folder').textContent = front;
      summary.querySelector('.change-name').textContent = name;
    }
  });
  addDiagram(card, head, files, cwd);
  return card;
}

// The class diagram of the C# changes, under the card's title (see
// umlview.js; the types come from src/csharp.js). It opens by itself when the
// task changed two or more types, or a type that depends on another one, up
// to 16 types (a bigger one is better read in the whole window, ⤢);
// otherwise the Diagram button shows it.
function addDiagram(card, head, files, cwd) {
  const csFiles = files.filter(f => CS_FILE.test(f.path) && f.status !== 'bin');
  if (!csFiles.length || !window.deck?.csModel || !window.umlPanel) return;
  const toggle = el('button', 'diagram-btn hidden', 'Diagram');
  toggle.title = 'Class diagram of the C# changes: which types changed and how they depend on each other';
  head.insertBefore(toggle, head.querySelector('.undo-all-btn, .review-btn'));
  window.deck.csModel(cwd, csFiles.map(({ path, status, lines }) => ({ path, status, lines }))).then(model => {
    const changed = model?.nodes?.filter(n => n.status === 'new' || n.status === 'mod' || n.status === 'del') || [];
    if (!changed.length) return;
    const title = `Class diagram · ${changed.length} changed type${changed.length === 1 ? '' : 's'}`;
    // A box opens its diff at the type; a type the task did not change opens
    // in your editor.
    const open = (node, line) => {
      if (node.status === 'context' || !files.some(f => f.path === node.file)) {
        window.deck.openFile(node.file);
        return;
      }
      window.uiSound?.('open');
      openReview(files, files.findIndex(f => f.path === node.file), { cwd, line: line ?? node.line });
    };
    const full = () => openUmlFull(model, { onOpen: open, title });
    const panel = umlPanel(model, { onOpen: open, onFull: full });
    card.insertBefore(panel, head.nextSibling);
    toggle.classList.remove('hidden');
    const setOpen = on => {
      panel.classList.toggle('hidden', !on);
      toggle.classList.toggle('active', on);
      toggle.textContent = on ? 'Hide diagram' : changed.length > 1 ? `Diagram · ${changed.length} types` : 'Diagram';
    };
    setOpen(changed.length <= 16 && (changed.length >= 2 || model.edges.some(e => changed.some(n => n.id === e.from))));
    toggle.onclick = () => setOpen(panel.classList.contains('hidden'));
  }).catch(() => {});
}

// ---------- full-window review ----------

let reviewEl = null;

function closeReview() {
  reviewEl?.remove();
  reviewEl = null;
}

// Comments on lines, kept on the file objects (f.comments: diff line index ->
// { line, side, code, text }), so they survive closing and reopening the
// review. "Send to agent" turns them into one message in the message box.
function allComments(files) {
  const out = [];
  for (const f of files) {
    for (const [index, c] of [...(f.comments || new Map())].sort((a, b) => a[0] - b[0])) out.push({ file: f, index, ...c });
  }
  return out;
}

function commentsMessage(files) {
  const lines = ['Review comments on your changes:', ''];
  allComments(files).forEach((c, i) => {
    const code = c.code.trim().slice(0, 120);
    const where = `${c.file.path}, line ${c.line}${c.side === 'old' ? ' (a removed line)' : ''}`;
    lines.push(`${i + 1}. ${where}${code ? ': `' + code + '`' : ''}`);
    lines.push(...c.text.split('\n').map(t => `   ${t}`), '');
  });
  lines.push('Please address each comment.');
  return lines.join('\n');
}

// line: show that line of the first file (from the class diagram): the diff
// scrolls to the nearest changed or shown line and marks it for a moment.
function openReview(files, start = 0, { cwd = null, line = null } = {}) {
  closeReview();
  files = sortFiles(files);
  reviewEl = el('div', 'review');
  const bar = el('div', 'review-bar');
  const close = el('button', null, 'Close (Esc)');
  close.onclick = closeReview;
  const sendComments = el('button', 'review-send hidden');
  sendComments.title = 'Put the comments into the message box, as one message to the agent';
  sendComments.onclick = () => {
    const text = commentsMessage(files);
    for (const f of files) f.comments = null;
    closeReview();
    window.dispatchEvent(new CustomEvent('review-comments', { detail: { text, cwd } }));
  };
  const refreshSend = () => {
    const n = allComments(files).length;
    sendComments.classList.toggle('hidden', !n);
    sendComments.textContent = `Send ${n} comment${n === 1 ? '' : 's'} to the agent`;
    items.forEach((item, i) => {
      const count = files[i].comments?.size || 0;
      item.querySelector('.review-comment-count').textContent = count ? `💬 ${count}` : '';
    });
  };
  bar.append(el('span', 'review-title', `Review · ${files.length} file${files.length === 1 ? '' : 's'}`), el('span', 'hint', '↑ ↓ to switch files · click a line to comment'), sendComments, close);

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
    item.append(el('span', 'change-badge ' + f.status, (BADGES[f.status] || 'Edited')[0]), text, el('span', 'review-comment-count'), counts);
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
    const diff = renderDiff(f, { maxLines: 20000, onLine: (row, info) => editComment(f, row, info) });
    pane.append(el('div', 'review-path', f.path), diff);
    for (const [index, c] of f.comments || []) {
      const row = diff.querySelector(`.diff-line[data-index="${index}"]`);
      if (row) row.after(commentBox(f, row, { index, ...c }));
    }
    pane.scrollTop = 0;
  }

  // A saved comment under its line: the text, Edit and Delete.
  function commentBox(f, row, info) {
    const box = el('div', 'review-comment');
    const actions = el('div', 'review-comment-actions');
    const editBtn = el('button', null, 'Edit');
    editBtn.onclick = () => editComment(f, row, info);
    const del = el('button', null, 'Delete');
    del.onclick = () => {
      f.comments.delete(info.index);
      box.remove();
      refreshSend();
    };
    actions.append(editBtn, del);
    box.append(el('div', 'review-comment-text', f.comments.get(info.index).text), actions);
    return box;
  }

  // Opens the editor for a line's comment (a new one, or the one it has).
  function editComment(f, row, info) {
    const next = row.nextElementSibling;
    if (next?.classList.contains('review-comment-editor')) { next.querySelector('textarea').focus(); return; }
    if (next?.classList.contains('review-comment')) next.remove();
    const editor = el('div', 'review-comment-editor');
    const input = document.createElement('textarea');
    input.rows = 3;
    input.placeholder = 'Comment for the agent… (Ctrl+↩ to save, Esc to cancel)';
    input.value = f.comments?.get(info.index)?.text || '';
    const save = el('button', 'review-comment-save', 'Comment');
    const cancel = el('button', null, 'Cancel');
    const done = keep => {
      const text = input.value.trim();
      editor.remove();
      if (keep && text) {
        f.comments = f.comments || new Map();
        f.comments.set(info.index, { line: info.line, side: info.side, code: info.code, text });
      } else if (keep) {
        f.comments?.delete(info.index);
      }
      if (f.comments?.has(info.index)) row.after(commentBox(f, row, info));
      refreshSend();
      reviewEl?.focus();
    };
    save.onclick = () => done(true);
    cancel.onclick = () => done(false);
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); done(true); }
    });
    const buttons = el('div', 'review-comment-actions');
    buttons.append(cancel, save);
    editor.append(input, buttons);
    row.after(editor);
    input.focus();
  }

  reviewEl.addEventListener('keydown', e => {
    if (e.target.closest?.('textarea')) return;
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
  refreshSend();
  reviewEl.focus();
  if (line != null) {
    // A deleted file has only old line numbers.
    const no = row => Number(row.dataset.newLine ?? row.dataset.oldLine);
    let best = null;
    for (const row of pane.querySelectorAll('.diff-line[data-new-line], .diff-line[data-old-line]')) {
      if (!best || Math.abs(no(row) - line) < Math.abs(no(best) - line)) best = row;
    }
    if (best) {
      best.scrollIntoView({ block: 'center' });
      best.classList.add('flash');
      setTimeout(() => best.classList.remove('flash'), 1600);
    }
  }
}

window.changesCard = changesCard;
window.openReview = openReview;
window.closeReview = closeReview;
