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
  // A new file written whole has no @@ line: its lines count from 1.
  let oldNo = 1;
  let newNo = 1;
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

// The card under the answer. Every file starts collapsed: click one to see
// its diff. Click a line in a diff to comment on it (see lineComments).
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
  const comments = lineComments(files, cwd);
  const send = comments.sendButton();
  head.append(
    el('span', 'changes-title', `Changed ${files.length} file${files.length === 1 ? '' : 's'}`),
    el('span', 'plus', ` +${totalAdd}`),
    el('span', 'minus', ` −${totalDel}`),
    send,
  );
  card.appendChild(head);

  // Undo is in the message box ("Undo last prompt", see app.js); files it
  // put back are crossed out here. card.syncUndone() redraws that.
  const rows = new Map();   // file -> its row
  card.syncUndone = () => { for (const [f, row] of rows) row.classList.toggle('undone', !!f.undone); };

  const titles = [];   // [file, its summary], to show namespaces once they are known
  const addFile = (parent, f) => {
    const row = el('details', `change-file status-${f.status}`);
    row.title = f.path;
    const summary = fileSummary(f);
    titles.push([f, summary]);
    rows.set(f, row);
    if (f.undone) row.classList.add('undone');
    row.appendChild(summary);
    // Drawing happens when the file is first opened, so big changes stay fast.
    const draw = () => {
      if (!row.querySelector('.diff')) row.appendChild(comments.diff(f));
    };
    row.addEventListener('toggle', () => { if (row.open) draw(); });
    parent.appendChild(row);
  };

  for (const f of code) addFile(card, f);
  if (other.length) {
    const group = el('details', 'other-files');
    const s = el('summary', null, `Other files (${other.length})`);
    group.appendChild(s);
    for (const f of other) addFile(group, f);
    // Without code files, the list of other files is what there is to see.
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
  addDiagram(card, head, files, cwd, comments);
  return card;
}

// The class diagram of the C# changes (see umlview.js; the types come from
// src/csharp.js). The card is one container for the task's changes, with
// Files | Diagram in its title: Files is the list of files (the default),
// Diagram the class diagram, for which the whole card widens to most of the
// window. Diagram waits until the C# has been read, and goes away when the
// changes declare no types.
function addDiagram(card, head, files, cwd, comments) {
  const csFiles = files.filter(f => CS_FILE.test(f.path) && f.status !== 'bin');
  if (!csFiles.length || !window.deck?.csModel || !window.umlPanel) return;
  const switcher = el('div', 'changes-switch');
  const filesBtn = el('button', 'active', `Files · ${files.length}`);
  const diagramBtn = el('button', null, 'Diagram…');
  for (const b of [filesBtn, diagramBtn]) b.type = 'button';
  diagramBtn.disabled = true;
  diagramBtn.title = 'Reading the C# changes…';
  switcher.append(filesBtn, diagramBtn);
  head.insertBefore(switcher, head.querySelector('.comments-send'));

  window.deck.csModel(cwd, csFiles.map(({ path, status, lines }) => ({ path, status, lines }))).then(model => {
    const changed = model?.nodes?.filter(n => n.status === 'new' || n.status === 'mod' || n.status === 'del') || [];
    if (!changed.length) { switcher.remove(); return; }
    const title = `Class diagram · ${changed.length} changed type${changed.length === 1 ? '' : 's'}`;
    const options = { files, comments };
    const panel = umlPanel(model, { ...options, onFull: () => openUmlFull(model, { ...options, title }) });
    card.insertBefore(panel, head.nextSibling);
    card.classList.add('has-diagram');
    diagramBtn.disabled = false;
    diagramBtn.textContent = changed.length > 1 ? `Diagram · ${changed.length} types` : 'Diagram';
    diagramBtn.title = 'Class diagram of the C# changes: the changed types and how they depend on each other';
    const setView = diagram => {
      card.classList.toggle('show-diagram', diagram);
      diagramBtn.classList.toggle('active', diagram);
      filesBtn.classList.toggle('active', !diagram);
      // Drawn at the width the card has once it has widened.
      if (diagram) setTimeout(() => panel.redraw?.(), 260);
    };
    diagramBtn.onclick = () => { window.uiSound?.('tick'); setView(true); };
    filesBtn.onclick = () => { window.uiSound?.('tick'); setView(false); };
  }).catch(() => switcher.remove());
}

// ---------- comments on lines ----------

// Click a line of a diff (in the Files list, or in a type's diff from the
// diagram) to comment on it. Comments are kept on the file objects
// (f.comments: diff line index -> { line, side, code, text }), so they stay
// when a file is closed and opened again. "Send N comments" in the card's
// title (and in a type's diff) puts them all into the message box, as one
// message to the agent. Returns { diff(f), sendButton(), count(), send(),
// onChange(fn) }.
function lineComments(files, cwd) {
  const listeners = new Set();
  const count = () => files.reduce((n, f) => n + (f.comments?.size || 0), 0);
  const changed = () => { for (const fn of listeners) fn(count()); };

  const message = () => {
    const lines = ['Review comments on your changes:', ''];
    let i = 0;
    for (const f of files) {
      for (const [, c] of [...(f.comments || new Map())].sort((x, y) => x[0] - y[0])) {
        const code = c.code.trim().slice(0, 120);
        const where = `${f.path}, line ${c.line}${c.side === 'old' ? ' (a removed line)' : ''}`;
        lines.push(`${++i}. ${where}${code ? ': `' + code + '`' : ''}`);
        lines.push(...c.text.split('\n').map(t => `   ${t}`), '');
      }
    }
    lines.push('Please address each comment.');
    return lines.join('\n');
  };
  const boxes = new Set();   // the comment boxes on screen, removed after sending
  const send = () => {
    if (!count()) return;
    const text = message();
    for (const f of files) f.comments = null;
    for (const box of boxes) box.remove();
    boxes.clear();
    changed();
    window.dispatchEvent(new CustomEvent('review-comments', { detail: { text, cwd } }));
  };

  // A saved comment under its line: the text, Edit and Delete.
  const commentBox = (f, row, info) => {
    const box = el('div', 'review-comment');
    const actions = el('div', 'review-comment-actions');
    const editBtn = el('button', null, 'Edit');
    editBtn.onclick = () => edit(f, row, info);
    const del = el('button', null, 'Delete');
    del.onclick = () => {
      f.comments.delete(info.index);
      box.remove();
      boxes.delete(box);
      changed();
    };
    actions.append(editBtn, del);
    box.append(el('div', 'review-comment-text', f.comments.get(info.index).text), actions);
    boxes.add(box);
    return box;
  };
  // The editor for a line's comment (a new one, or the one it has).
  const edit = (f, row, info) => {
    const next = row.nextElementSibling;
    if (next?.classList.contains('review-comment-editor')) { next.querySelector('textarea').focus(); return; }
    if (next?.classList.contains('review-comment')) { next.remove(); boxes.delete(next); }
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
      changed();
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
  };

  return {
    count,
    send,
    onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    // A file's diff where a click on a line comments on it, with the
    // comments it already has.
    diff: (f, options = {}) => {
      const diff = renderDiff(f, { ...options, onLine: (row, info) => edit(f, row, info) });
      for (const [index, c] of f.comments || []) {
        const row = diff.querySelector(`.diff-line[data-index="${index}"]`);
        if (row) row.after(commentBox(f, row, { index, ...c }));
      }
      return diff;
    },
    // "Send N comments", shown while there are comments.
    sendButton: () => {
      const button = el('button', 'comments-send hidden');
      button.type = 'button';
      button.title = 'Put the comments into the message box, as one message to the agent';
      button.onclick = e => { e.stopPropagation(); send(); };
      const refresh = n => {
        button.classList.toggle('hidden', !n);
        button.textContent = `Send ${n} comment${n === 1 ? '' : 's'}`;
      };
      listeners.add(refresh);
      refresh(count());
      return button;
    },
  };
}

window.changesCard = changesCard;
