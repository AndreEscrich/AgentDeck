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

// Files you review as code, in the diff viewer. Everything else (Unity
// .prefab, .asset, .unity, images, .meta) is listed under the code, in the
// asset changes (see addAssets).
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
    // A diff pasted as an excerpt (file.excerpt) has no real line numbers.
    const oldCell = el('span', 'ln', kind === 'add' || file.excerpt ? '' : String(oldNo));
    const newCell = el('span', 'ln', kind === 'del' || file.excerpt ? '' : String(newNo));
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
// Unit tests stay out of the class diagram (the same path rule as in
// csharp.js, which also knows a test by its NUnit attributes).
const TEST_PATH = /(^|[\\/])(tests?|unittests?|editmodetests?|playmodetests?|integrationtests?|[\w.]+\.tests?)[\\/]/i;
const TEST_NAME = /Tests\.cs$/;   // BoardTests.cs, not Contests.cs
const isTestPath = p => TEST_PATH.test(p) || TEST_NAME.test(p);
const NAMESPACE_LINE = /^[+\- ]?[ \t]*namespace[ \t]+([A-Za-z_][\w.]*)/;

// The namespace the file has now: a removed line only counts for a deleted
// file (a moved file can change its namespace, and the old one is the "-"
// line of the diff).
function namespaceInDiff(f) {
  let removed = null;
  for (const [kind, text] of f.lines || []) {
    const m = NAMESPACE_LINE.exec(text || '');
    if (!m) continue;
    if (kind !== 'del') return m[1];
    removed = removed || m[1];
  }
  return f.status === 'del' ? removed : null;
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

// ---------- reviewed files ----------

// Files you ticked as reviewed, by path and content of their change, so the
// same change stays reviewed after a restart and a new change of the file
// does not. Kept in this computer's local storage.
function reviewKey(f) {
  let h = 0;
  for (const [, text] of f.lines || []) for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return `${String(f.path).replace(/\\/g, '/')}|${f.lines?.length || 0}|${h}`;
}
function reviewedSet() {
  try { return new Set(JSON.parse(localStorage.getItem('reviewedFiles') || '[]')); } catch { return new Set(); }
}
function setReviewed(f, on) {
  const set = reviewedSet();
  if (on) set.add(reviewKey(f));
  else set.delete(reviewKey(f));
  try { localStorage.setItem('reviewedFiles', JSON.stringify([...set].slice(-5000))); } catch { /* not important */ }
}

// A count that rolls up from zero to its value.
function rollUp(node, to, prefix) {
  if (!node || !to) return;
  const start = performance.now();
  const step = now => {
    const q = Math.min(1, (now - start) / 700);
    node.textContent = prefix + Math.round(to * (1 - Math.pow(1 - q, 3)));
    if (q < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
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
  // A moved file says where it came from: SVN shows it as the old path
  // deleted and the new one added.
  if (f.from) {
    const oldFolder = f.from.split(/[\\/]/).slice(0, -1).join('/');
    const oldName = f.from.split(/[\\/]/).pop();
    const newName = f.path.split(/[\\/]/).pop();
    pathEl.appendChild(el('span', 'change-from', `  ← ${oldFolder}${oldName !== newName ? '/' + oldName : ''}`));
  }
  const summary = el('summary');
  summary.append(
    el('span', 'change-chevron'),
    el('span', 'change-badge ' + (f.from ? 'moved' : f.status), f.from ? 'Moved' : BADGES[f.status] || 'Edited'),
    pathEl,
    counts,
  );
  return summary;
}

// The card under the answer. Every file starts collapsed: click one to see
// its diff. Click a line in a diff to comment on it (see lineComments).
// title: the card's heading instead of "Changed N files" (a diff you asked for).
// animate: a task that just finished, so its files deal in one by one and
// the line counts roll up.
function changesCard(files, cwd, { title = null, animate = false } = {}) {
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
    el('span', 'changes-title', title ? `${title} · ${files.length} file${files.length === 1 ? '' : 's'}` : `Changed ${files.length} file${files.length === 1 ? '' : 's'}`),
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
    row.title = f.from ? `${f.path}\nmoved from ${f.from}` : f.path;
    const summary = fileSummary(f);
    titles.push([f, summary]);
    rows.set(f, row);
    if (f.undone) row.classList.add('undone');
    row.appendChild(summary);
    const tick = el('button', 'review-tick');
    tick.type = 'button';
    tick.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8.5 L7 11 L12 5"/></svg>';
    if (animate) row.style.setProperty('--i', String(rows.size - 1));
    tick.onclick = e => {
      e.preventDefault();
      e.stopPropagation();
      setReviewed(f, !row.classList.contains('reviewed'));
      syncReview();
      if (row.classList.contains('reviewed')) row.open = false;
    };
    summary.appendChild(tick);
    // Drawing happens when the file is first opened, so big changes stay fast.
    const draw = () => {
      if (!row.querySelector('.file-views')) row.appendChild(fileViews(f, cwd, () => comments.diff(f), comments));
    };
    row.addEventListener('toggle', () => { if (row.open) draw(); });
    parent.appendChild(row);
  };

  // The diff viewer lists the code only; the other files are in the asset
  // changes under it (addAssets).
  for (const f of code) addFile(card, f);
  // Reviewing: a tick per file, "N of M reviewed", and when all are ticked,
  // Commit or Ask for changes (handled by window.reviewAction in app.js).
  const progress = el('span', 'review-progress');
  const actions = el('span', 'review-actions hidden');
  if (!title) {
    const commit = el('button', 'review-commit', 'Commit');
    commit.type = 'button';
    commit.title = 'Ask the agent to commit these changes, with a message that says what changed';
    commit.onclick = () => window.reviewAction?.('commit', card, files);
    const ask = el('button', null, 'Ask for changes');
    ask.type = 'button';
    ask.title = 'Send your line comments, or write what to change';
    ask.onclick = () => (comments.count() ? comments.send() : window.reviewAction?.('changes', card, files));
    actions.append(ask, commit);
  }
  head.insertBefore(progress, send);
  head.insertBefore(actions, send);
  let wasAll = null;
  const syncReview = () => {
    const set = reviewedSet();
    let n = 0;
    for (const [f, row] of rows) {
      const on = set.has(reviewKey(f));
      row.classList.toggle('reviewed', on);
      row.querySelector('.review-tick').title = on ? 'Reviewed (click to undo)' : 'Mark as reviewed';
      if (on) n++;
    }
    const all = n === rows.size && n > 0;
    progress.textContent = n ? `${n} of ${rows.size} reviewed` : '';
    progress.classList.toggle('done', all);
    actions.classList.toggle('hidden', !all);
    if (all && wasAll === false) {
      window.dispatchEvent(new CustomEvent('changes-reviewed', { detail: { card } }));
      // A stamp lands on the card, and Commit glows once.
      const stamp = el('div', 'review-stamp', 'Reviewed');
      head.appendChild(stamp);
      setTimeout(() => stamp.classList.add('fade'), 1400);
      setTimeout(() => stamp.remove(), 2000);
      actions.querySelector('.review-commit')?.classList.add('glow');
    }
    wasAll = all;
  };
  card.syncReview = syncReview;
  syncReview();
  if (animate) {
    card.classList.add('deal');
    rollUp(head.querySelector('.plus'), totalAdd, ' +');
    rollUp(head.querySelector('.minus'), totalDel, ' −');
  }
  loadNamespaces(files, cwd, () => {
    for (const [f, summary] of titles) {
      const { front, name } = titleParts(f);
      summary.querySelector('.change-folder').textContent = front;
      summary.querySelector('.change-name').textContent = name;
    }
  });
  addDiagram(card, head, files, cwd, comments);
  addAssets(card, other, cwd, comments);
  return card;
}

// The class diagram of the C# changes (see umlview.js; the types come from
// src/csharp.js). The card is one container for the task's changes, with
// Diagram | Files in its title: Diagram is the class diagram (where it
// starts, with the whole card widened to most of the window), Files the list
// of files. While the C# is read the card says so; when the changes declare
// no types, it shows the files.
// While the class diagram is worked out (a big change takes a while): its
// containers already, from what the diff tells. A box per C# file (named
// after the file, as its class mostly is; green when new, struck when
// deleted), grouped by the namespace the diff shows, else by folder.
function umlWaiting(csFiles) {
  const root = el('div', 'uml-waiting');
  root.appendChild(el('div', 'uml-waiting-head', `Drawing the class diagram · ${csFiles.length} C# file${csFiles.length === 1 ? '' : 's'}…`));
  const groups = new Map();
  for (const f of csFiles) {
    const parts = f.path.split('/');
    const key = namespaceInDiff(f) || parts[parts.length - 2] || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const grid = el('div', 'uml-waiting-grid');
  const sorted = [...groups].sort((a, b) => b[1].length - a[1].length);
  const MAX_GROUPS = 12;
  const MAX_BOXES = 10;
  sorted.slice(0, MAX_GROUPS).forEach(([key, list], i) => {
    const box = el('div', 'uml-waiting-group');
    box.style.animationDelay = `${(i % 6) * 0.15}s`;
    box.appendChild(el('div', 'uml-waiting-title', `${key || '(no folder)'} · ${list.length}`));
    const boxes = el('div', 'uml-waiting-boxes');
    for (const f of list.slice(0, MAX_BOXES)) {
      boxes.appendChild(el('span', `uml-waiting-box ${f.status}`, f.path.split('/').pop().replace(/\.cs$/i, '')));
    }
    if (list.length > MAX_BOXES) boxes.appendChild(el('span', 'uml-waiting-more', `+${list.length - MAX_BOXES}`));
    box.appendChild(boxes);
    grid.appendChild(box);
  });
  if (sorted.length > MAX_GROUPS) grid.appendChild(el('div', 'uml-waiting-more', `+${sorted.length - MAX_GROUPS} more`));
  root.appendChild(grid);
  return root;
}

function addDiagram(card, head, files, cwd, comments) {
  // Temporary helpers stay out of the diagram, also the ones that only may
  // be temporary (TempProbe, AtlasTemp), and so do unit tests: it shows the
  // structure of the work. The Files list still has them.
  const csFiles = files.filter(f => CS_FILE.test(f.path) && f.status !== 'bin' && !isTestPath(f.path)
    && !(window.isTempFile?.(f.path) || window.maybeTempFile?.(f.path)));
  const testCount = files.filter(f => CS_FILE.test(f.path) && isTestPath(f.path)).length;
  if (!csFiles.length || !window.deck?.csModel || !window.umlPanel) return;
  const switcher = el('div', 'changes-switch');
  const diagramBtn = el('button', 'active', 'Diagram…');
  const filesBtn = el('button', null, `Files · ${files.length}`);
  for (const b of [diagramBtn, filesBtn]) b.type = 'button';
  diagramBtn.disabled = true;
  diagramBtn.title = 'Reading the C# changes…';
  switcher.append(diagramBtn, filesBtn);
  head.insertBefore(switcher, head.querySelector('.comments-send'));
  // Until the diagram is ready: a line that says so instead of the files
  // (unless you ask for the files).
  let choseFiles = false;
  const waiting = umlWaiting(csFiles);
  card.insertBefore(waiting, head.nextSibling);
  card.classList.add('diagram-waiting');
  const showFiles = () => {
    waiting.remove();
    card.classList.remove('diagram-waiting');
  };
  filesBtn.onclick = () => {
    choseFiles = true;
    showFiles();
    diagramBtn.classList.remove('active');
    filesBtn.classList.add('active');
  };

  window.deck.csModel(cwd, csFiles.map(({ path, status, lines, earlier }) => ({ path, status, lines, earlier }))).then(model => {
    const changed = model?.nodes?.filter(n => n.status === 'new' || n.status === 'mod' || n.status === 'del') || [];
    showFiles();
    if (!changed.length) { switcher.remove(); return; }
    const title = `Class diagram · ${changed.length} changed type${changed.length === 1 ? '' : 's'}`;
    const options = { files, comments };
    const panel = umlPanel(model, { ...options, onFull: () => openUmlFull(model, { ...options, title }) });
    card.insertBefore(panel, head.nextSibling);
    card.classList.add('has-diagram');
    diagramBtn.disabled = false;
    diagramBtn.textContent = changed.length > 1 ? `Diagram · ${changed.length} types` : 'Diagram';
    const tests = testCount + (model.testsLeftOut || 0);
    diagramBtn.title = 'Class diagram of the C# changes: the changed types and how they depend on each other'
      + (tests ? ` (${tests} unit test file${tests === 1 ? '' : 's'} left out; they are under Files)` : '');
    const setView = diagram => {
      card.classList.toggle('show-diagram', diagram);
      diagramBtn.classList.toggle('active', diagram);
      filesBtn.classList.toggle('active', !diagram);
      // Drawn at the width the card has once it has widened.
      if (diagram) setTimeout(() => panel.redraw?.(), 260);
    };
    diagramBtn.onclick = () => { window.uiSound?.('tick'); setView(true); };
    filesBtn.onclick = () => { window.uiSound?.('tick'); setView(false); };
    setView(!choseFiles);
  }).catch(() => { showFiles(); switcher.remove(); });
}

// ---------- the assets a task changed ----------

// Under the code: the Unity assets the task changed, prefabs first, then
// scenes, then the others. Clicking one lists in words what changed in it
// (src/unityassets.js): game objects and components added or removed, and
// values before → after, grouped by game object.
const ASSET_KINDS = [
  ['prefab', 'Prefab'], ['unity', 'Scene'], ['mat', 'Material'], ['anim', 'Animation'], ['controller', 'Animator'],
  ['overridecontroller', 'Animator override'], ['asset', 'Asset'], ['spriteatlas', 'Sprite atlas'], ['spriteatlasv2', 'Sprite atlas'],
  ['playable', 'Timeline'], ['mask', 'Avatar mask'], ['preset', 'Preset'], ['rendertexture', 'Render texture'],
  ['physicmaterial', 'Physics material'], ['physicsmaterial2d', 'Physics material'], ['lighting', 'Lighting'],
  ['terrainlayer', 'Terrain layer'], ['mixer', 'Audio mixer'], ['signal', 'Signal'], ['brush', 'Brush'], ['guiskin', 'GUI skin'],
  ['fontsettings', 'Font settings'], ['flare', 'Flare'], ['giparams', 'GI parameters'],
];
const ASSET_ORDER = new Map(ASSET_KINDS.map(([ext], i) => [ext, i]));
const assetKind = p => ASSET_KINDS.find(([ext]) => ext === extensionOf(p).toLowerCase())?.[1] || null;

// The other files that are not code: a kind by their extension. Their rows
// open to the usual diff (or the picture), not to a description.
const OTHER_KINDS = [
  [/^(png|jpe?g|tga|psd|psb|tiff?|exr|hdr|bmp|gif|webp|svg)$/, 'Texture'], [/^(wav|mp3|ogg|aiff?|flac|m4a)$/, 'Audio'],
  [/^(mp4|mov|webm|m4v)$/, 'Video'], [/^(fbx|obj|blend|dae|3ds)$/, 'Model'], [/^(ttf|otf)$/, 'Font'], [/^meta$/, 'Meta'],
  [/^(json|ya?ml|xml|txt|md|csv|ini|cfg|toml|plist|uxml|uss)$/, 'Text'],
];
const otherKind = p => OTHER_KINDS.find(([re]) => re.test(extensionOf(p)))?.[1] || (extensionOf(p).toUpperCase() || 'File');
const kindRank = p => (ASSET_ORDER.has(extensionOf(p)) ? ASSET_ORDER.get(extensionOf(p))
  : ASSET_KINDS.length + 1 + OTHER_KINDS.findIndex(([re]) => re.test(extensionOf(p))));

// The kind, status, name and folder of an asset, for its row (and for the
// list in the whole-window view).
const ASSET_STATUS = { new: 'New', mod: 'Changed', del: 'Deleted', bin: 'Changed' };
function assetLabel(f) {
  const parts = f.path.split('/');
  return [
    el('span', `asset-kind kind-${extensionOf(f.path).toLowerCase()}`, assetKind(f.path) || otherKind(f.path)),
    // New, Deleted, Changed or Moved, right after the kind.
    el('span', `asset-status status-${f.from ? 'moved' : f.status}`, f.from ? 'Moved' : ASSET_STATUS[f.status] || 'Changed'),
    el('span', 'asset-name', parts.pop()),
    el('span', 'asset-folder', parts.slice(-3).join('/')),
  ];
}

// Fills body with what changed in one asset: for a Unity asset, a list in
// words (src/unityassets.js) of game objects and components added or
// removed and values before → after, grouped by game object; for other
// files, their diff (or the picture).
async function loadAsset(f, body, cwd, comments) {
  // Not a Unity asset (a texture, a text file, a .meta): its diff or picture.
  if (!assetKind(f.path)) {
    // An image the task added: a preview of it.
    if (/\.(png|jpe?g|gif|webp|bmp|tga|psd|psb|exr|hdr|tiff?)$/i.test(f.path) && f.status !== 'del' && window.mediaElement) {
      const file = window.resolveMediaPath?.(f.path, cwd) || f.path;
      body.replaceChildren(window.mediaElement(file, f.path.split('/').pop(), cwd));
      return;
    }
    if (f.status === 'new' || f.status === 'del') {
      if (f.lines.some(([, t]) => /^Binary files /.test(t || ''))) {
        body.replaceChildren(el('div', 'asset-note', f.status === 'new' ? 'A new file, added during the task.' : 'Deleted during the task.'));
        return;
      }
    }
    body.replaceChildren(fileViews(f, cwd, () => comments.diff(f), comments));
    return;
  }
  body.replaceChildren(el('div', 'asset-note', 'Reading the asset… (the first one in a project takes a few seconds, to name its scripts and assets)'));
  const r = await (window.deck?.describeAsset?.(cwd, { path: f.path, status: f.status, lines: f.lines, earlier: f.earlier, from: f.from }) || Promise.resolve({ error: 'Not available.' })).catch(err => ({ error: String(err?.message || err) }));
  body.replaceChildren();
  if (r.error) { body.appendChild(el('div', 'asset-note', r.error)); return; }
  if (r.note) body.appendChild(el('div', 'asset-note', r.note));
  if (!r.groups.length) body.appendChild(el('div', 'asset-note', 'Nothing changed that the list shows (only ids, ordering or editor-only data).'));
  for (const g of r.groups) {
    const block = el('div', 'asset-group');
    block.appendChild(el('div', 'asset-object', g.heading));
    for (const line of g.lines) {
      const mark = line[0];
      const item = el('div', `asset-line ${mark === '+' ? 'add' : mark === '−' ? 'del' : 'mod'}`);
      item.append(el('span', 'asset-mark', mark === '~' ? '•' : mark), el('span', null, line.slice(2)));
      block.appendChild(item);
    }
    body.appendChild(block);
  }
}

// files: the task's files that are not code (the diff viewer has the code).
// comments: the card's line comments (a text file's diff takes them too).
function addAssets(card, files, cwd, comments) {
  // .meta files (Unity's import settings and ids) are left out.
  const assets = files.filter(f => !/\.meta$/i.test(f.path)).sort((a, b) => kindRank(a.path) - kindRank(b.path) || a.path.localeCompare(b.path));
  if (!assets.length) return;
  const section = el('div', 'assets-section');
  const prefabs = assets.filter(f => /\.prefab$/i.test(f.path)).length;
  // Everything that is not code is under "Asset changes", text files too.
  const head = el('div', 'assets-head');
  const title = `Asset changes · ${assets.length}${prefabs ? ` · ${prefabs} prefab${prefabs === 1 ? '' : 's'}` : ''}`;
  const full = el('button', 'assets-full-btn', '⤢');
  full.type = 'button';
  full.title = 'Review them in the whole window';
  head.append(el('span', null, title), full);
  section.appendChild(head);
  // A long list (a branch can change hundreds of assets) shows the first ones
  // and a button for the rest.
  const SHOWN = 25;
  let more = null;
  const rows = [];
  for (const [i, f] of assets.entries()) {
    const row = el('details', `asset-row status-${f.status}`);
    const summary = el('summary', 'asset-summary');
    summary.append(...assetLabel(f));
    summary.title = f.from ? `${f.path}\nmoved from ${f.from}` : f.path;
    row.appendChild(summary);
    const body = el('div', 'asset-body');
    row.appendChild(body);
    row.addEventListener('toggle', () => {
      if (!row.open || row.dataset.loaded) return;
      row.dataset.loaded = '1';
      loadAsset(f, body, cwd, comments);
    });
    if (i >= SHOWN) row.classList.add('hidden');
    section.appendChild(row);
    rows.push(row);
  }
  // The whole-window view starts at the asset that is open, if one is.
  full.onclick = () => {
    window.uiSound?.('tick');
    openAssetsFull(assets, cwd, comments, title, Math.max(0, rows.findIndex(r => r.open)));
  };
  if (assets.length > SHOWN) {
    more = el('button', 'assets-more', `Show ${assets.length - SHOWN} more`);
    more.type = 'button';
    more.onclick = () => { for (const r of section.querySelectorAll('.asset-row.hidden')) r.classList.remove('hidden'); more.remove(); };
    section.appendChild(more);
  }
  // Right under the code, above the review bar.
  card.insertBefore(section, card.querySelector(':scope > .review-bar, :scope > .review-progress') || null);
}

// The assets in the whole window, over the chat (⤢ in their title): the
// list on the left and the picked one large on the right. ↑ ↓ step through
// them, Esc closes.
let assetsFullEl = null;
function closeAssetsFull() {
  assetsFullEl?.remove();
  assetsFullEl = null;
}

function openAssetsFull(assets, cwd, comments, title, start = 0) {
  closeAssetsFull();
  const root = el('div', 'uml-full assets-full');
  root.tabIndex = -1;
  const bar = el('div', 'review-bar');
  const close = el('button', null, 'Close (Esc)');
  close.onclick = closeAssetsFull;
  bar.append(el('span', 'review-title', title), el('span', 'hint', '↑ ↓ to go through them · Esc to close'), close);
  const list = el('div', 'assets-full-list');
  const view = el('div', 'assets-full-view');
  const main = el('div', 'assets-full-main');
  main.append(list, view);
  root.append(bar, main);
  let current = -1;
  const items = assets.map((f, i) => {
    const item = el('button', 'assets-full-item');
    item.type = 'button';
    item.title = f.from ? `${f.path}\nmoved from ${f.from}` : f.path;
    item.append(...assetLabel(f));
    item.onclick = () => pick(i);
    list.appendChild(item);
    return item;
  });
  const pick = i => {
    if (i < 0 || i >= assets.length || i === current) return;
    current = i;
    items.forEach((item, j) => item.classList.toggle('active', j === i));
    items[i].scrollIntoView({ block: 'nearest' });
    const f = assets[i];
    const head = el('div', 'assets-full-title');
    head.append(...assetLabel(f));
    head.appendChild(el('span', 'assets-full-path', f.from ? `${f.path} (moved from ${f.from})` : f.path));
    const body = el('div', 'asset-body');
    view.replaceChildren(head, body);
    view.scrollTop = 0;
    loadAsset(f, body, cwd, comments);
  };
  root.step = d => pick(Math.min(assets.length - 1, Math.max(0, current + d)));
  document.getElementById('main').appendChild(root);
  assetsFullEl = root;
  pick(start);
  root.focus();
}

document.addEventListener('keydown', e => {
  if (!assetsFullEl) return;
  // Keys in a comment box stay there (Esc cancels the comment).
  if (e.target.closest?.('input, textarea, [contenteditable="true"]')) return;
  const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
  if (e.key === 'Escape') { stop(); closeAssetsFull(); return; }
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.altKey && !e.ctrlKey && !e.metaKey) {
    stop();
    assetsFullEl.step(e.key === 'ArrowDown' ? 1 : -1);
  }
}, true);

// ---------- the session's changes, floating over the chat ----------

// What an agent changed since its first message, all its tasks together
// (app.js keeps the snapshot from before its first task, see updateSession):
// a small card floating at the top left of its chat (the right edge is for
// the next-agent hint), like a task's Changes card made small: the class
// diagram of the C# it changed, then the assets.
// Its title folds it to one line. It sits inside the chat (app.js puts it
// there), so it opens and closes with it. Each task's own Changes card stays
// in the chat; when a task ends, its changes fly from that card to here as
// one shape (flyCard) and, once they are in, the card takes them in (digest).
// Returns { el, update(files), targetFor(path), digest(), landing(),
// setFolded(on) }.
const SESSION_ROOM = 1540;   // px of window for the chat (820) and the card on each side

function sessionPanel(cwd) {
  // It fades in once, when it first appears; the class goes after, or the
  // fade would play again whenever another animation (digest) ends.
  const root = el('aside', 'session-panel fresh');
  root.addEventListener('animationend', e => { if (e.target === root && e.animationName === 'session-in') root.classList.remove('fresh'); });
  const head = el('div', 'session-head');
  const title = el('span', 'session-title', 'Changes');
  title.title = 'Everything this agent changed since its first message, all its tasks together';
  const stats = el('span', 'session-stats');
  head.append(el('span', 'session-caret', '▼'), title, stats);
  const body = el('div', 'session-body');
  root.append(head, body);
  // Folded to its title, for every agent, until you open it again.
  const setFolded = (on, announce = true) => {
    root.classList.toggle('folded', on);
    head.title = on ? 'Show everything this agent changed' : 'Fold';
    try { localStorage.setItem('sessionPanelFolded', on ? '1' : ''); } catch { /* it still folds */ }
    if (announce) root.dispatchEvent(new CustomEvent('session-fold', { bubbles: true, detail: on }));
  };
  // A window too narrow for the chat and the card side by side shows it
  // folded, until you open it there.
  let openNarrow = false;
  const fit = () => root.classList.toggle('narrow', innerWidth < SESSION_ROOM && !openNarrow);
  head.onclick = () => {
    if (root.classList.contains('narrow')) { openNarrow = true; if (root.classList.contains('folded')) setFolded(false); fit(); return; }
    if (innerWidth < SESSION_ROOM && !root.classList.contains('folded')) { openNarrow = false; fit(); return; }
    setFolded(!root.classList.contains('folded'));
  };
  addEventListener('resize', () => { if (innerWidth >= SESSION_ROOM) openNarrow = false; fit(); });
  fit();
  try { if (localStorage.getItem('sessionPanelFolded')) setFolded(true, false); } catch { /* unfolded */ }

  // The whole diagram in its canvas: after it is drawn, when the card opens
  // and when the window changes size.
  const fitDiagram = () => requestAnimationFrame(() => root.querySelector('.session-diagram .uml-panel')?.fit?.());
  addEventListener('resize', fitDiagram);
  root.addEventListener('session-fold', e => { if (!e.detail) fitDiagram(); });

  let model = null;
  let assetsBox = null;
  let diagramBox = null;
  let version = 0;
  const update = async files => {
    const mine = ++version;
    files = sortFiles(files);
    let add = 0;
    let del = 0;
    for (const f of files) { const s = fileStats(f); add += s.add; del += s.del; }
    stats.replaceChildren(el('span', null, `${files.length} file${files.length === 1 ? '' : 's'}`), el('span', 'plus', ` +${add}`), el('span', 'minus', ` −${del}`));
    root.classList.toggle('empty', !files.length);
    const comments = lineComments(files, cwd);
    const csFiles = files.filter(f => CS_FILE.test(f.path) && f.status !== 'bin' && !isTestPath(f.path)
      && !(window.isTempFile?.(f.path) || window.maybeTempFile?.(f.path)));
    const code = files.filter(f => isCodeFile(f.path));
    const other = files.filter(f => !isCodeFile(f.path));

    // The diagram (or, while it is worked out, its boxes from the diff).
    // The diagram drawn before stays until the new one is ready.
    if (!diagramBox) {
      diagramBox = el('div', 'session-diagram');
      body.prepend(diagramBox);
    }
    if (!csFiles.length) diagramBox.replaceChildren();
    else if (!diagramBox.querySelector('.uml-panel')) diagramBox.replaceChildren(umlWaiting(csFiles));

    // The code files that are not in the diagram (other languages, tests).
    const inDiagram = new Set(csFiles.map(f => f.path));
    const rest = code.filter(f => !inDiagram.has(f.path));
    body.querySelector(':scope > .session-code')?.remove();
    if (rest.length) {
      const list = el('div', 'session-code');
      list.appendChild(el('div', 'assets-head', `Other code · ${rest.length}`));
      for (const f of rest) {
        const row = el('details', `session-code-row status-${f.status}`);
        const summary = el('summary', 'session-code-summary');
        const s = fileStats(f);
        summary.title = f.path;
        summary.append(el('span', 'asset-name', f.path.split('/').pop()), el('span', 'plus', ` +${s.add}`), el('span', 'minus', ` −${s.del}`));
        row.appendChild(summary);
        row.addEventListener('toggle', () => {
          if (row.open && !row.querySelector('.file-views')) row.appendChild(fileViews(f, cwd, () => comments.diff(f), comments));
        });
        list.appendChild(row);
      }
      body.insertBefore(list, diagramBox.nextSibling);
    }

    // The assets, under the code.
    assetsBox?.remove();
    assetsBox = el('div', 'session-assets');
    addAssets(assetsBox, other, cwd, comments);
    body.appendChild(assetsBox);
    if (!files.length) body.querySelector(':scope > .session-none') || body.appendChild(el('div', 'session-none', 'No changes yet. What this agent changes in the project shows here, all its tasks together.'));
    else body.querySelector(':scope > .session-none')?.remove();

    if (!csFiles.length || !window.deck?.csModel || !window.umlPanel) { model = null; return; }
    const m = await window.deck.csModel(cwd, csFiles.map(({ path, status, lines, earlier }) => ({ path, status, lines, earlier }))).catch(() => null);
    if (mine !== version) return;
    const changed = m?.nodes?.filter(n => ['new', 'mod', 'del'].includes(n.status)) || [];
    if (!changed.length) { model = null; diagramBox.replaceChildren(); return; }
    model = m;
    const options = { files, comments };
    const full = `Class diagram · this agent's changes · ${changed.length} type${changed.length === 1 ? '' : 's'}`;
    const panel = umlPanel(m, { ...options, onFull: () => openUmlFull(m, { ...options, title: full }) });
    diagramBox.replaceChildren(el('div', 'session-sub', `Class diagram · ${changed.length} type${changed.length === 1 ? '' : 's'}`), panel);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    fitDiagram();
  };

  // Where a file lands when it flies in: its type's box in the diagram, its
  // asset's row, else the top of the panel.
  const targetFor = path => {
    if (root.classList.contains('folded')) return head;
    const ids = (model?.nodes || []).filter(n => n.file === path).map(n => n.id);
    for (const id of ids) {
      const node = root.querySelector(`.uml-node[data-id="${CSS.escape(id)}"]`);
      if (node?.getClientRects().length) return node;
    }
    for (const row of root.querySelectorAll('.asset-row > summary, .session-code-summary')) {
      if ((row.title || '').split('\n')[0] === path && row.getClientRects().length) return row;
    }
    return head;
  };
  // The task's changes have flown in and the card shows them now: it
  // swallows, once.
  const digest = () => {
    root.classList.remove('digest');
    void root.offsetWidth;
    root.classList.add('digest');
    setTimeout(() => root.classList.remove('digest'), 700);
  };
  // Where the flight lands: the card, or its title when it is folded.
  const landing = () => (root.classList.contains('folded') || root.classList.contains('narrow') ? head : root);
  const api = { el: root, update, targetFor, digest, landing, setFolded };
  root._panel = api;
  return api;
}

// A task's changes fly into the session card as one shape: it starts the
// size and place of the task's class diagram (or its assets, or its whole
// Changes card), says how many files it carries, and shrinks into the card
// (or its title, when folded). Resolves when it is in.
function flyCard(from, target, label) {
  return new Promise(done => {
    if (!from || !target) { done(); return; }
    const a = from.getBoundingClientRect();
    const b = target.getBoundingClientRect();
    if (!a.width || !b.width || b.bottom < 0 || b.top > innerHeight) { done(); return; }
    // A card scrolled out of sight starts from the edge of the chat nearest
    // to it, and a tall one starts no taller than a third of the window.
    const height = Math.max(48, Math.min(a.height, innerHeight / 3));
    const top = Math.max(60, Math.min(innerHeight - height - 20, a.top));
    const ghost = el('div', 'fly-card');
    ghost.appendChild(el('span', 'fly-card-label', label));
    document.body.appendChild(ghost);
    if (playSounds()) sounds.lift();
    const at = (r, h = r.height, t = r.top) => ({ left: `${r.left}px`, top: `${t}px`, width: `${r.width}px`, height: `${h}px` });
    ghost.animate([
      { ...at(a, height, top), opacity: 0 },
      { ...at(a, height, top), opacity: 0.85, offset: 0.2 },
      { ...at(b), opacity: 0.7, offset: 0.8 },
      { ...at(b), opacity: 0 },
    ], { duration: 900, easing: 'cubic-bezier(.5,0,.3,1)', fill: 'forwards' }).finished
      .catch(() => {}).then(() => { ghost.remove(); done(); });
  });
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
  // A comment is kept by the side and number of its line (new:42, old:17),
  // so it shows in each view of the file: Changes, Full file, Side by side.
  const keyOf = c => `${c.side}:${c.line}`;
  const listeners = new Set();
  const count = () => files.reduce((n, f) => n + (f.comments?.size || 0), 0);
  const changed = () => { for (const fn of listeners) fn(count()); };

  const message = () => {
    const lines = ['Review comments on your changes:', ''];
    let i = 0;
    for (const f of files) {
      for (const c of [...(f.comments || new Map()).values()].sort((x, y) => x.line - y.line || (x.side === 'old' ? -1 : 1))) {
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
      f.comments.delete(keyOf(info));
      box.remove();
      boxes.delete(box);
      changed();
    };
    actions.append(editBtn, del);
    box.append(el('div', 'review-comment-text', f.comments.get(keyOf(info)).text), actions);
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
    input.placeholder = 'Comment for the agent… (↩ to save, ⇧↩ for a new line, Esc to cancel)';
    input.value = f.comments?.get(keyOf(info))?.text || '';
    const save = el('button', 'review-comment-save', 'Comment');
    const cancel = el('button', null, 'Cancel');
    const done = keep => {
      const text = input.value.trim();
      editor.remove();
      if (keep && text) {
        f.comments = f.comments || new Map();
        f.comments.set(keyOf(info), { line: info.line, side: info.side, code: info.code, text });
      } else if (keep) {
        f.comments?.delete(keyOf(info));
      }
      if (f.comments?.has(keyOf(info))) row.after(commentBox(f, row, info));
      changed();
    };
    save.onclick = () => done(true);
    cancel.onclick = () => done(false);
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
      // ↩ saves; ⇧↩ starts a new line.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); done(true); }
    });
    const buttons = el('div', 'review-comment-actions');
    buttons.append(cancel, save);
    editor.append(input, buttons);
    row.after(editor);
    input.focus();
  };

  // Where a comment shows in a view: the row of its line, on its side.
  const rowFor = (view, c) => view.querySelector(c.side === 'old'
    ? `.diff-line[data-old-line="${c.line}"], .sbs-row:has(> .sbs-cell[data-old-line="${c.line}"])`
    : `.diff-line[data-new-line="${c.line}"], .sbs-row:has(> .sbs-cell[data-new-line="${c.line}"])`);
  const showComments = (f, view) => {
    for (const c of (f.comments || new Map()).values()) {
      const row = rowFor(view, c);
      if (row) row.after(commentBox(f, row, c));
    }
  };

  return {
    cwd,
    count,
    send,
    // The Full file and Side by side views: a click on a line (in Side by
    // side, on its old or new half) comments on it, and the file's comments
    // show under their lines. The same comments as in the Changes view: they
    // are kept by side and line number.
    attach: (f, view) => {
      for (const row of view.querySelectorAll('.diff-line:not(.hunk)')) {
        const side = row.classList.contains('del') ? 'old' : 'new';
        const line = Number(side === 'old' ? row.dataset.oldLine : row.dataset.newLine);
        if (!line) continue;
        row.classList.add('commentable');
        row.title = 'Click to comment on this line';
        row.onclick = () => { if (!window.getSelection()?.toString()) edit(f, row, { line, side, code: row.querySelector('.code')?.textContent || '' }); };
      }
      for (const row of view.querySelectorAll('.sbs-row')) {
        for (const cell of row.querySelectorAll('.sbs-cell:not(.empty)')) {
          // An unchanged line is the same on both sides: it counts as the new one.
          const old = cell.classList.contains('del');
          const line = Number(old ? cell.dataset.oldLine : cell.dataset.newLine);
          if (!line) continue;
          cell.classList.add('commentable');
          cell.title = 'Click to comment on this line';
          cell.onclick = () => { if (!window.getSelection()?.toString()) edit(f, row, { line, side: old ? 'old' : 'new', code: cell.querySelector('.code')?.textContent || '' }); };
        }
      }
      showComments(f, view);
    },
    onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    // A file's diff where a click on a line comments on it, with the
    // comments it already has.
    diff: (f, options = {}) => {
      const diff = renderDiff(f, { ...options, onLine: (row, info) => edit(f, row, info) });
      showComments(f, diff);
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

// ---------- moved and renamed files ----------

// A file that was moved or renamed reaches the card as two files: the old
// path deleted and the new one added (the comparisons in git.js leave
// pairing to this). A deleted and a new file of the same kind are one moved
// file when enough of their lines are the same (half of them, or a third
// when the name stayed). In a Unity project the .meta files decide instead:
// a moved asset keeps its guid, so when both have their .meta in the task,
// they are a move only if the guids match. Views made from one template are
// more than half the same, and so are any two .meta files, so a view removed
// and another one added would look like a move. The pair becomes one entry
// at the new path, with `from` the old path and the diff between the two
// versions, like a file git paired.
function similarity(a, b) {
  const set = lines => new Set(lines.map(l => l.trim()).filter(l => l.length > 2));
  const x = set(a);
  const y = set(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const l of x) if (y.has(l)) shared++;
  return shared / Math.max(x.size, y.size);
}

// The full-file diff of lineDiff as hunks with 3 lines around each change,
// with their "@@ -a,b +c,d @@" headers (the Changes card and the class
// diagram read the line numbers from them).
function toHunks(merged, around = 3) {
  const out = [];
  const changed = merged.map(([k]) => k !== 'ctx');
  let i = 0;
  let oldNo = 1;
  let newNo = 1;
  const near = j => changed.slice(Math.max(0, j - around), j + around + 1).some(Boolean);
  while (i < merged.length) {
    if (!near(i)) {
      if (merged[i][0] !== 'add') oldNo++;
      if (merged[i][0] !== 'del') newNo++;
      i++;
      continue;
    }
    const start = i;
    const oldStart = oldNo;
    const newStart = newNo;
    const body = [];
    while (i < merged.length && near(i)) {
      body.push(merged[i]);
      if (merged[i][0] !== 'add') oldNo++;
      if (merged[i][0] !== 'del') newNo++;
      i++;
    }
    const oldCount = body.filter(([k]) => k !== 'add').length;
    const newCount = body.filter(([k]) => k !== 'del').length;
    out.push(['hunk', `@@ -${oldCount ? oldStart : oldStart - 1},${oldCount} +${newCount ? newStart : newStart - 1},${newCount} @@`], ...body);
    if (start === i) i++;
  }
  return out;
}

function pairMoves(files) {
  const content = (f, kind) => f.lines.filter(([k]) => k === kind).map(([, t]) => t.slice(1));
  const removed = files.filter(f => f.status === 'del' && !f.from);
  const added = files.filter(f => f.status === 'new' && !f.from);
  if (!removed.length || !added.length) return files;
  const ext = p => (p.match(/\.[^./\\]+$/) || [''])[0].toLowerCase();
  const base = p => p.split(/[\\/]/).pop();
  // The guid in a .meta file (its old lines for a deleted file).
  const guidIn = (f, kind) => content(f, kind).map(t => /^guid:\s*([0-9a-f]{32})/.exec(t)?.[1]).find(Boolean) || null;
  const byPath = new Map(files.map(f => [f.path, f]));
  const metaGuid = (f, kind) => {
    const meta = /\.meta$/i.test(f.path) ? f : byPath.get(f.path + '.meta');
    return meta ? guidIn(meta, kind) : null;
  };
  const pairs = [];
  for (const d of removed) {
    for (const a of added) {
      if (ext(d.path) !== ext(a.path)) continue;
      const sameName = base(d.path) === base(a.path);
      const was = metaGuid(d, 'del');
      const now = metaGuid(a, 'add');
      if (was && now) {
        if (was === now) pairs.push({ d, a, score: 2 });
        continue;
      }
      const score = similarity(content(d, 'del'), content(a, 'add'));
      if (score >= (sameName ? 0.33 : 0.5)) pairs.push({ d, a, score: score + (sameName ? 0.25 : 0) });
    }
  }
  pairs.sort((p, q) => q.score - p.score);
  const used = new Set();
  const merged = new Map();   // the new file -> its moved entry
  for (const { d, a } of pairs) {
    if (used.has(d) || used.has(a)) continue;
    used.add(d);
    used.add(a);
    const diff = lineDiff(content(d, 'del'), content(a, 'add'));
    merged.set(a, { path: a.path, from: d.path, status: 'mod', lines: diff ? toHunks(diff) : [...d.lines, ...a.lines] });
  }
  return files.filter(f => !used.has(f) || merged.has(f)).map(f => merged.get(f) || f);
}

// ---------- the whole file, and side by side ----------

// A line diff of two versions (Myers' algorithm): the lines of both in order
// as [kind, text] with kind ctx, add or del, the way renderDiff wants them.
// null when the versions are too different to compare quickly.
function lineDiff(a, b) {
  const n = a.length;
  const m = b.length;
  const v = { 1: 0 };
  const trace = [];
  for (let d = 0; d <= n + m; d++) {
    const step = {};
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[k - 1] < v[k + 1]) ? v[k + 1] : v[k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[k] = x;
      step[k] = x;
      if (x >= n && y >= m) {
        trace.push(step);
        return backtrack(trace, a, b);
      }
    }
    trace.push(step);
    if (d > 4000) return null;
  }
  return null;
}

function backtrack(trace, a, b) {
  const out = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const k = x - y;
    const prev = d > 0 ? trace[d - 1] : { 1: 0 };
    const prevK = d === 0 ? k : k === -d || (k !== d && (prev[k - 1] ?? -1) < (prev[k + 1] ?? -1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : prev[prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { out.push(['ctx', ' ' + a[x - 1]]); x--; y--; }
    if (d > 0) {
      if (x === prevX) { out.push(['add', '+' + b[y - 1]]); y--; } else { out.push(['del', '-' + a[x - 1]]); x--; }
    }
  }
  return out.reverse();
}

// The two versions side by side: one row per line, before on the left and
// after on the right, removed and added lines facing each other.
function renderSideBySide(path, merged) {
  const language = LANGUAGES[extensionOf(path)];
  const rows = [];
  let i = 0;
  let oldNo = 1;
  let newNo = 1;
  while (i < merged.length) {
    if (merged[i][0] === 'ctx') {
      rows.push([{ no: oldNo++, text: merged[i][1].slice(1) }, { no: newNo++, text: merged[i][1].slice(1) }, 'ctx']);
      i++;
      continue;
    }
    const dels = [];
    const adds = [];
    while (i < merged.length && merged[i][0] !== 'ctx') {
      (merged[i][0] === 'del' ? dels : adds).push(merged[i][1].slice(1));
      i++;
    }
    for (let j = 0; j < Math.max(dels.length, adds.length); j++) {
      rows.push([j < dels.length ? { no: oldNo++, text: dels[j] } : null, j < adds.length ? { no: newNo++, text: adds[j] } : null, 'change']);
    }
  }
  const grid = el('div', 'diff sbs');
  const cell = (side, data, kind) => {
    const c = el('div', `sbs-cell ${data ? (kind === 'ctx' ? 'ctx' : side) : 'empty'}`);
    c.append(el('span', 'ln', data ? String(data.no) : ''));
    const code = el('span', 'code');
    if (data) {
      const html = highlightLine(data.text, language);
      if (html != null) code.innerHTML = html || ' ';
      else code.textContent = data.text || ' ';
    }
    c.append(code);
    if (data && side === 'add') c.dataset.newLine = String(data.no);
    if (data && side === 'del' && kind !== 'ctx') c.dataset.oldLine = String(data.no);
    return c;
  };
  for (const [left, right, kind] of rows) {
    const row = el('div', 'sbs-row');
    const l = cell('del', left, kind);
    const r = cell('add', right, kind);
    if (kind === 'ctx' && right) l.dataset.newLine = String(right.no);
    row.append(l, r);
    grid.appendChild(row);
  }
  if (!rows.length) grid.appendChild(el('div', 'diff-line hunk', 'The file is empty'));
  return grid;
}

// ---------- finding your way in a long file ----------

// The blocks of changed lines in a Full file or Side by side view: runs of
// rows next to each other that were added, removed or both, as
// [{ rows, kind: 'add' | 'del' | 'mod' }].
function changeClusters(view) {
  const rows = view.classList.contains('sbs') ? [...view.querySelectorAll(':scope > .sbs-row')] : [...view.querySelectorAll(':scope > .diff-line')];
  const kindOf = row => {
    if (row.classList.contains('sbs-row')) {
      const del = row.querySelector('.sbs-cell.del');
      const add = row.querySelector('.sbs-cell.add');
      return del && add ? 'mod' : del ? 'del' : add ? 'add' : null;
    }
    return row.classList.contains('add') ? 'add' : row.classList.contains('del') ? 'del' : null;
  };
  const clusters = [];
  let current = null;
  for (const row of rows) {
    const kind = kindOf(row);
    if (!kind) { current = null; continue; }
    if (!current) clusters.push(current = { rows: [], kinds: new Set() });
    current.rows.push(row);
    current.kinds.add(kind);
  }
  return clusters.map(c => ({ rows: c.rows, kind: c.kinds.has('mod') || c.kinds.size > 1 ? 'mod' : [...c.kinds][0] }));
}

// The element that scrolls the view: the view itself (in a Changes card it
// has a maximum height) or a box around it (the diff that opens from the
// class diagram).
function scrollerOf(node) {
  for (let n = node; n && n !== document.body; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY;
    if ((o === 'auto' || o === 'scroll') && n.scrollHeight > n.clientHeight + 1) return n;
  }
  return null;
}

// Marks beside the scrollbar where the changes are (green added, red
// removed, amber both; click one to go there), and ↑ ↓ buttons in the bar
// that go to the previous and next block of changes, with "2 / 7". Returns
// a function that removes them again.
function changeNavigation(view, bar) {
  const clusters = changeClusters(view);
  const nav = el('span', 'change-nav');
  const count = el('span', 'change-nav-count');
  const prev = el('button', 'change-nav-btn', '↑');
  const next = el('button', 'change-nav-btn', '↓');
  prev.type = next.type = 'button';
  prev.title = 'Previous change';
  next.title = 'Next change';
  nav.append(prev, next, count);
  bar.appendChild(nav);
  let rail = null;
  let observer = null;
  const scroller = () => scrollerOf(view);
  const topOf = (row, sc) => row.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
  // The sticky bar covers the top of the scrolling box when the box is
  // around the view.
  const covered = sc => (sc.contains(bar) ? bar.offsetHeight : 0);
  const go = i => {
    const sc = scroller();
    const c = clusters[i];
    if (!sc || !c) return;
    sc.scrollTo({ top: Math.max(0, topOf(c.rows[0], sc) - covered(sc) - 48), behavior: 'smooth' });
    for (const row of c.rows) {
      row.classList.remove('change-flash');
      void row.offsetWidth;
      row.classList.add('change-flash');
    }
    window.uiSound?.('select');
  };
  // Which block is at the top of the box now: the last one that starts
  // above a line a little under its top edge.
  const index = () => {
    const sc = scroller();
    if (!sc) return -1;
    const edge = sc.scrollTop + covered(sc) + 56;
    let at = -1;
    clusters.forEach((c, i) => { if (topOf(c.rows[0], sc) <= edge) at = i; });
    return at;
  };
  const update = () => {
    const at = index();
    count.textContent = clusters.length ? `${at < 0 ? '–' : at + 1} / ${clusters.length}` : 'No changes';
    prev.disabled = at <= 0;
    next.disabled = at >= clusters.length - 1;
  };
  prev.onclick = e => { e.stopPropagation(); go(Math.max(0, index() - 1)); };
  next.onclick = e => { e.stopPropagation(); go(Math.min(clusters.length - 1, index() + 1)); };
  const drawRail = () => {
    rail?.remove();
    const sc = scroller();
    if (!sc || !clusters.length) return;
    const parent = sc.parentElement;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    const sr = sc.getBoundingClientRect();
    const pr = parent.getBoundingClientRect();
    rail = el('div', 'change-rail');
    const scrollbar = sc.offsetWidth - sc.clientWidth;
    Object.assign(rail.style, { top: `${sr.top - pr.top}px`, height: `${sc.clientHeight}px`, right: `${pr.right - sr.right + scrollbar}px` });
    const total = sc.scrollHeight;
    clusters.forEach((c, i) => {
      const top = topOf(c.rows[0], sc);
      const last = c.rows[c.rows.length - 1];
      const height = topOf(last, sc) + last.offsetHeight - top;
      const mark = el('button', `change-mark ${c.kind}`);
      mark.type = 'button';
      mark.title = `Change ${i + 1} of ${clusters.length}`;
      Object.assign(mark.style, { top: `${(top / total) * 100}%`, height: `max(3px, ${(height / total) * 100}%)` });
      mark.onclick = e => { e.stopPropagation(); go(i); };
      rail.appendChild(mark);
    });
    parent.appendChild(rail);
  };
  let frame = 0;
  const later = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; update(); }); };
  // The view is in the page only after it is drawn; then the box that
  // scrolls it is known.
  requestAnimationFrame(() => {
    const sc = scroller();
    if (sc) {
      sc.addEventListener('scroll', later, { passive: true });
      observer = new ResizeObserver(() => { drawRail(); update(); });
      observer.observe(sc);
    }
    drawRail();
    update();
  });
  return () => {
    nav.remove();
    rail?.remove();
    observer?.disconnect();
    scroller()?.removeEventListener('scroll', later);
  };
}

// The views of one file's change: Changes (the diff, made by changesView,
// where you can comment on lines), Full file (all of it, the changes marked
// in place) and Side by side (before and after). The last view you picked is
// the one the next file opens in.
let lastFileView = 'changes';
function fileViews(f, cwd, changesView, comments = null) {
  const box = el('div', 'file-views');
  const bar = el('div', 'file-views-bar');
  const body = el('div', 'file-views-body');
  const modes = [['changes', 'Changes'], ['full', 'Full file'], ['sbs', 'Side by side']];
  const buttons = new Map();
  for (const [mode, label] of modes) {
    const b = el('button', null, label);
    b.type = 'button';
    b.onclick = e => { e.stopPropagation(); window.uiSound?.('tick'); show(mode); };
    buttons.set(mode, b);
    bar.appendChild(b);
  }
  box.append(bar, body);
  const versions = () => {
    if (!f.versions) f.versions = window.deck?.fileVersions ? window.deck.fileVersions(cwd, { path: f.path, status: f.status, lines: f.lines, earlier: f.earlier }) : Promise.resolve({ error: 'Not available.' });
    return f.versions;
  };
  let current = null;
  let dropNav = null;
  const show = async mode => {
    current = mode;
    lastFileView = mode;
    dropNav?.();
    dropNav = null;
    box.dataset.mode = mode;
    for (const [m, b] of buttons) b.classList.toggle('active', m === mode);
    if (mode === 'changes') {
      body.replaceChildren(changesView());
      return;
    }
    body.replaceChildren(el('div', 'diff-line hunk', 'Reading the file…'));
    const v = await versions().catch(err => ({ error: String(err?.message || err) }));
    if (current !== mode) return;
    if (v.error) {
      body.replaceChildren(el('div', 'diff-line hunk', v.error));
      return;
    }
    const merged = lineDiff(v.before || [], v.after || []);
    if (!merged) {
      body.replaceChildren(el('div', 'diff-line hunk', 'The two versions are too different to compare here.'));
      return;
    }
    const view = mode === 'full'
      ? renderDiff({ path: f.path, status: f.status, lines: merged }, { maxLines: 50000 })
      : renderSideBySide(f.path, merged);
    body.replaceChildren(view);
    comments?.attach(f, view);
    dropNav = changeNavigation(view, bar);
  };
  show(f.status === 'bin' ? 'changes' : lastFileView);
  if (f.status === 'bin') bar.classList.add('hidden');
  box.showMode = show;
  return box;
}

window.fileViews = fileViews;

window.changesCard = changesCard;
window.pairMoves = pairMoves;
