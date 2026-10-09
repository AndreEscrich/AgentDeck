// Reads C# well enough to draw a class diagram of an agent's changes: the
// types the changed files declare (classes, interfaces, structs, records,
// enums), their members, which members the diff touched, and how the types
// depend on each other (inherits, implements, uses). It is a reader, not a
// compiler: it works on the text with comments and strings blanked out, and
// it guesses a type from its name when that name is declared somewhere in
// the project.
//
// model(cwd, files) is what the window asks for (see cs:model in main.js).

const fs = require('fs');
const path = require('path');

// ---------- text ----------

// Comments, strings and chars become spaces, so braces and words inside them
// do not count. Line breaks stay, so positions keep their line numbers.
function blank(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  const spaces = s => s.replace(/[^\n]/g, ' ');
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    // Preprocessor lines (#region, #if UNITY_EDITOR) are not code.
    if (c === '#' && /(^|\n)[ \t]*$/.test(out.slice(-200))) {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      out += spaces(text.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '/' && d === '/') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      out += spaces(text.slice(i, stop));
      i = stop;
    } else if (c === '/' && d === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      out += spaces(text.slice(i, stop));
      i = stop;
    } else if (c === '"' || ((c === '@' || c === '$') && (d === '"' || ((d === '@' || d === '$') && text[i + 2] === '"')))) {
      // "…", @"…" (verbatim: "" is a quote), $"…" and $@"…" (holes stay blank too).
      let j = i;
      let verbatim = false;
      while (text[j] !== '"') { if (text[j] === '@') verbatim = true; j++; }
      // Raw strings: """ … """
      if (text.startsWith('"""', j)) {
        const end = text.indexOf('"""', j + 3);
        const stop = end < 0 ? n : end + 3;
        out += spaces(text.slice(i, stop));
        i = stop;
        continue;
      }
      j++;
      while (j < n) {
        if (verbatim && text[j] === '"' && text[j + 1] === '"') { j += 2; continue; }
        if (!verbatim && text[j] === '\\') { j += 2; continue; }
        if (text[j] === '"') { j++; break; }
        if (!verbatim && text[j] === '\n') break;
        j++;
      }
      // The whole string, quotes included, becomes spaces (same length).
      out += spaces(text.slice(i, j));
      i = j;
    } else if (c === '\'' && (text[i + 2] === '\'' || (d === '\\' && text.indexOf('\'', i + 2) - i <= 8))) {
      const end = text.indexOf('\'', i + (d === '\\' ? 3 : 2));
      const stop = end < 0 ? i + 1 : end + 1;
      out += spaces(text.slice(i, stop));
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

// 1-based line of a position.
function lineAt(starts, pos) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

// The position of the brace that closes the one at open.
function closingBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  return text.length - 1;
}

// ---------- types and members ----------

const TYPE_DECL = /\b(class|interface|struct|enum|record(?:\s+class|\s+struct)?)\s+([A-Za-z_]\w*)\s*(<[^>{;()]*>)?\s*(\([^)]*\))?\s*(?::\s*([^{;]+?))?\s*(?:where\s[^{;]*)?(\{|;)/g;
const MODIFIERS = /\b(public|private|protected|internal|static|readonly|const|virtual|override|abstract|sealed|async|extern|unsafe|volatile|new|partial|required|file|scoped|fixed)\b/g;
const KEYWORDS = new Set(['if', 'for', 'foreach', 'while', 'switch', 'using', 'lock', 'return', 'catch', 'fixed', 'nameof', 'typeof', 'sizeof', 'default', 'base', 'this', 'get', 'set', 'init', 'add', 'remove', 'value']);

function cleanTypeName(t) {
  return t.replace(/\s+/g, ' ').replace(/\s*([<>,?\[\]])\s*/g, '$1').replace(/,/g, ', ').trim();
}

// Splits the text right inside a type's braces into its member headers:
// "public int Count { get; }" → { header: 'public int Count', ... }.
function memberHeaders(text, from, to) {
  const out = [];
  let start = from;
  let i = from;
  let paren = 0;
  while (i < to) {
    const c = text[i];
    if (c === '(' || c === '[') paren++;
    else if (c === ')' || c === ']') paren--;
    if (paren === 0 && c === '{') {
      const close = closingBrace(text, i);
      out.push({ header: text.slice(start, i), start, end: close, block: true });
      i = close + 1;
      start = i;
      continue;
    }
    if (paren === 0 && c === ';') {
      out.push({ header: text.slice(start, i), start, end: i, block: false });
      start = i + 1;
    }
    i++;
  }
  return out;
}

// What a member header declares: { kind, name, type, params } or null.
function classifyMember(raw, typeName) {
  let h = raw.replace(/^\s*(\[[^\]]*\]\s*)+/, '').trim();   // attributes
  if (!h || h.startsWith('=') || h.startsWith('}')) return null;
  if (/^(using|namespace)\b/.test(h)) return null;
  if (/\b(class|interface|struct|enum|record)\s+[A-Za-z_]/.test(h)) return null;   // a nested type
  const isEvent = /\bevent\b/.test(h);
  h = h.replace(MODIFIERS, ' ').replace(/\bevent\b/, ' ').replace(/\s+/g, ' ').trim();
  const arrow = h.indexOf('=>');
  const head = (arrow >= 0 ? h.slice(0, arrow) : h).trim();
  const paren = head.indexOf('(');
  if (paren >= 0) {
    const before = head.slice(0, paren).trim();
    const m = /([A-Za-z_~][\w]*)\s*(<[^>]*>)?$/.exec(before);
    if (!m || KEYWORDS.has(m[1])) return null;
    if (/\boperator\b/.test(before)) return { kind: 'method', name: before.replace(/^.*\boperator\b/, 'operator').trim(), type: '' };
    const type = before.slice(0, m.index).trim();
    const params = head.slice(paren + 1, head.lastIndexOf(')') >= 0 ? head.lastIndexOf(')') : undefined).replace(/\s+/g, ' ').trim();
    if (m[1] === typeName || m[1] === `~${typeName}`) return { kind: 'ctor', name: m[1], type: '', params };
    if (!type) return null;   // a call, not a declaration
    return { kind: 'method', name: m[1], type: cleanTypeName(type), params };
  }
  // Indexer: Type this[...]
  if (/\bthis\s*\[/.test(head)) return { kind: 'property', name: 'this[]', type: cleanTypeName(head.split(/\bthis\s*\[/)[0]) };
  const decl = head.split('=')[0].trim();
  const m = /([A-Za-z_]\w*)\s*(,\s*[A-Za-z_]\w*\s*)*$/.exec(decl);
  if (!m) return null;
  const name = m[1];
  const type = decl.slice(0, m.index).trim();
  if (!type || KEYWORDS.has(name) || /[(){}]/.test(type)) return null;
  return { kind: isEvent ? 'event' : 'field', name, type: cleanTypeName(type) };
}

// The types in one file, with their members and the words they use.
function parseFile(text) {
  const clean = blank(text);
  const starts = lineStarts(clean);
  const namespaces = [];
  for (const m of clean.matchAll(/\bnamespace\s+([A-Za-z_][\w.]*)\s*(\{|;)/g)) {
    const end = m[2] === '{' ? closingBrace(clean, m.index + m[0].length - 1) : clean.length;
    namespaces.push({ name: m[1], start: m.index, end });
  }
  const types = [];
  TYPE_DECL.lastIndex = 0;
  for (const m of clean.matchAll(TYPE_DECL)) {
    const kindWord = m[1].split(/\s+/)[0];
    const kind = kindWord === 'record' ? (m[1].includes('struct') ? 'struct' : 'class') : kindWord;
    const name = m[2];
    const open = m.index + m[0].length - 1;
    const end = m[6] === '{' ? closingBrace(clean, open) : open;
    const ns = namespaces.filter(n => n.start < m.index && n.end > m.index).pop();
    const bases = (m[5] || '').split(',').map(b => b.replace(/<.*$/, '').replace(/^.*\./, '').trim()).filter(b => /^[A-Za-z_]\w*$/.test(b));
    types.push({
      name,
      kind,
      record: kindWord === 'record',
      generic: m[3] ? m[3].replace(/\s+/g, '') : '',
      namespace: ns?.name || '',
      bases,
      start: m.index,
      open,
      end,
      line: lineAt(starts, m.index + m[0].indexOf(name)),
      endLine: lineAt(starts, end),
      members: [],
      words: new Map(),   // word -> lines it is used on
    });
  }
  // Members belong to the innermost type around them.
  for (const t of types) {
    if (t.open === t.end) continue;
    if (t.kind === 'enum') {
      const body = clean.slice(t.open + 1, t.end);
      let pos = t.open + 1;
      for (const part of body.split(',')) {
        const nm = /^\s*([A-Za-z_]\w*)/.exec(part.replace(/\[[^\]]*\]/g, m => ' '.repeat(m.length)));
        if (nm) {
          const at = pos + part.indexOf(nm[1]);
          t.members.push({ kind: 'value', name: nm[1], type: '', line: lineAt(starts, at), endLine: lineAt(starts, at) });
        }
        pos += part.length + 1;
      }
      continue;
    }
    const nested = types.filter(o => o !== t && o.start > t.open && o.end <= t.end);
    for (const h of memberHeaders(clean, t.open + 1, t.end)) {
      if (nested.some(o => h.start <= o.start && h.end >= o.open)) continue;
      const member = classifyMember(h.header, t.name);
      if (!member) continue;
      const at = h.start + Math.max(0, h.header.search(new RegExp(`\\b${member.name.replace(/[^\w~]/g, '')}\\b`)));
      member.line = lineAt(starts, at);
      member.endLine = lineAt(starts, h.end);
      t.members.push(member);
    }
  }
  // Parts of namespace names (from using and namespace lines) are not types.
  const nsWords = new Set();
  for (const m of clean.matchAll(/\b(?:using|namespace)\s+(?:static\s+)?(?:[A-Za-z_]\w*\s*=\s*)?([A-Za-z_][\w.]*)/g)) {
    for (const part of m[1].split('.')) nsWords.add(part);
  }
  // The capitalized words each type uses, with their lines (for the arrows).
  for (const t of types) {
    const inner = types.filter(o => o !== t && o.start > t.open && o.end <= t.end);
    const from = t.start;
    const to = t.end;
    const re = /\b[A-Z][A-Za-z0-9_]*\b/g;
    re.lastIndex = from;
    let m;
    while ((m = re.exec(clean)) && m.index < to) {
      if (inner.some(o => m.index > o.start && m.index < o.end)) continue;
      if (m[0] === t.name) continue;
      // Only words in a type's place count: not a member (x.Run, Foo.Instance)
      // and not a method call (Get(…), Create<T>(…)), except after new.
      const before = clean.slice(Math.max(0, m.index - 40), m.index);
      const after = clean.slice(m.index + m[0].length, m.index + m[0].length + 80);
      if (/\.\s*$/.test(before)) continue;
      if (nsWords.has(m[0]) && /^\s*\./.test(after)) continue;
      if (/^\s*(<[^<>()]*(<[^<>()]*>[^<>()]*)*>)?\s*\(/.test(after) && !/\bnew\s+$/.test(before)) continue;
      const line = lineAt(starts, m.index);
      if (!t.words.has(m[0])) t.words.set(m[0], new Set());
      t.words.get(m[0]).add(line);
    }
  }
  return types;
}

// ---------- the diff ----------

// For one file's diff lines: the new-side lines that were added or changed,
// the old lines that were removed (with the new-side line they were at), and
// the text of each.
function diffLines(file) {
  const added = new Map();     // new line -> text
  const removed = [];          // { at: new line, text }
  let oldNo = 0;
  let newNo = 0;
  for (const [kind, text] of file.lines || []) {
    if (kind === 'hunk') {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(text);
      if (m) { oldNo = Number(m[1]); newNo = Number(m[2]); }
      continue;
    }
    if (kind === 'add') { added.set(newNo, text.slice(1)); newNo++; }
    else if (kind === 'del') { removed.push({ at: newNo, text: text.slice(1) }); oldNo++; }
    else { oldNo++; newNo++; }
  }
  return { added, removed };
}

// The text of a deleted file, from its diff.
function deletedText(file) {
  return (file.lines || []).filter(([kind]) => kind === 'del').map(([, t]) => t.slice(1)).join('\n');
}

// ---------- the project's types ----------

// Every type declared in the project's C# files, by name: { file, kind,
// namespace }. Unity's generated folders are skipped. Kept for 5 minutes.
const SKIP_DIRS = new Set(['Library', 'Temp', 'Logs', 'obj', 'bin', 'Build', 'Builds', 'node_modules', '.git', '.svn', '.vs', '.idea', 'UserSettings', 'MemoryCaptures', 'Recordings']);
const indexes = new Map();   // folder -> { at, promise }

async function projectIndex(root) {
  const hit = indexes.get(root);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.promise;
  const promise = (async () => {
    const byName = new Map();
    const files = [];
    const walk = async dir => {
      if (files.length > 25000) return;
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isDirectory()) {
          const skip = SKIP_DIRS.has(e.name) || e.name.startsWith('.') || /^(Tests?|Samples~|Documentation~)$/.test(e.name) && dir.includes('PackageCache');
          if (!skip) await walk(path.join(dir, e.name));
        } else if (/\.cs$/i.test(e.name)) {
          files.push(path.join(dir, e.name));
        }
      }
    };
    await walk(root);
    // Unity packages live in Library/PackageCache; their types count too.
    await walk(path.join(root, 'Library', 'PackageCache'));
    const DECL = /\b(class|interface|struct|enum|record)\s+([A-Za-z_]\w*)/g;
    for (let i = 0; i < files.length; i += 64) {
      await Promise.all(files.slice(i, i + 64).map(async file => {
        let text;
        try { text = await fs.promises.readFile(file, 'utf8'); } catch { return; }
        const ns = /^[ \t]*namespace[ \t]+([A-Za-z_][\w.]*)/m.exec(text)?.[1] || '';
        for (const m of text.matchAll(DECL)) {
          // Skip words in comments: the line must not start with // or *.
          const lineStart = text.lastIndexOf('\n', m.index) + 1;
          if (/^\s*(\/\/|\*|\/\*)/.test(text.slice(lineStart, m.index))) continue;
          if (!byName.has(m[2])) byName.set(m[2], { file, kind: m[1] === 'record' ? 'class' : m[1], namespace: ns });
        }
      }));
    }
    return byName;
  })();
  indexes.set(root, { at: Date.now(), promise });
  return promise;
}

// The folder to index: the Unity project (the folder with Assets) or the
// repository around cwd, else cwd itself.
function projectRoot(cwd) {
  let dir = path.resolve(cwd);
  const isUnity = d => fs.existsSync(path.join(d, 'Assets')) && fs.existsSync(path.join(d, 'ProjectSettings'));
  // A checkout with the Unity project in a folder of its own (MyGame/Unity).
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && isUnity(path.join(dir, e.name))) return path.join(dir, e.name);
    }
  } catch { /* not readable */ }
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'Assets')) && fs.existsSync(path.join(dir, 'ProjectSettings'))) return dir;
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, '.svn'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.resolve(cwd);
}

// ---------- the model ----------

const MAX_CONTEXT = 14;

// Names that some package may declare too, but that almost always mean the
// .NET or Unity type: they would only clutter the diagram.
const COMMON = new Set([
  'List', 'Dictionary', 'HashSet', 'Queue', 'Stack', 'LinkedList', 'SortedList', 'SortedDictionary', 'Action', 'Func', 'Predicate',
  'Task', 'ValueTask', 'IEnumerator', 'IEnumerable', 'IList', 'IDictionary', 'ICollection', 'IReadOnlyList', 'IReadOnlyCollection',
  'IReadOnlyDictionary', 'IDisposable', 'IComparable', 'IEquatable', 'Exception', 'Object', 'String', 'Math', 'Mathf', 'Debug', 'Random',
  'Vector2', 'Vector3', 'Vector4', 'Vector2Int', 'Vector3Int', 'Quaternion', 'Color', 'Color32', 'Rect', 'Bounds', 'Time', 'Array',
  'Type', 'Attribute', 'EventArgs', 'Guid', 'DateTime', 'TimeSpan', 'Lazy', 'Nullable', 'Tuple', 'ValueTuple', 'StringBuilder', 'Encoding',
  'Path', 'File', 'Directory', 'Stream', 'Regex', 'Enumerable', 'Convert', 'Console', 'Environment', 'Assert', 'Test', 'TestCase',
]);

// files: [{ path, status, lines }] from a Changes card (C# files only).
// Resolves with { nodes, edges } for the diagram:
//   node: { id, name, kind, namespace, status: new|mod|del|same|context,
//           file, line, members: [{ name, kind, type, params, change, line }],
//           hiddenMembers, generic, bases }
//   edge: { from, to, kind: inherits|implements|uses, fresh, line }
async function model(cwd, files) {
  const changed = [];   // { node, type, file, diff }
  for (const f of (Array.isArray(files) ? files : []).slice(0, 200)) {
    if (!f || typeof f.path !== 'string' || !/\.cs$/i.test(f.path)) continue;
    const abs = path.isAbsolute(f.path) ? f.path : path.join(cwd || '', f.path);
    let text = null;
    if (f.status === 'del') text = deletedText(f);
    else {
      try { text = await fs.promises.readFile(abs, 'utf8'); } catch { text = null; }
      if (text == null) continue;
    }
    const diff = diffLines(f);
    const changedLines = new Set(diff.added.keys());
    for (const r of diff.removed) changedLines.add(r.at);
    const types = parseFile(text);
    for (const t of types) {
      // A type is changed when lines inside it changed; in a new or deleted
      // file, every type is.
      const touched = f.status === 'new' || f.status === 'del'
        || [...changedLines].some(l => l >= t.line - 1 && l <= t.endLine);
      const allNew = f.status === 'new' || (diff.added.has(t.line) && [...Array(t.endLine - t.line + 1).keys()].every(k => diff.added.has(t.line + k)));
      const status = f.status === 'del' ? 'del' : allNew ? 'new' : touched ? 'mod' : 'same';
      const members = t.members.map(m => {
        let change = null;
        if (status === 'new') change = 'new';
        else if (status === 'del') change = 'del';
        else {
          let any = false;
          let all = true;
          for (let l = m.line; l <= m.endLine; l++) {
            if (changedLines.has(l)) any = true;
            if (!diff.added.has(l)) all = false;
          }
          if (all) change = 'new';
          else if (any) change = 'mod';
        }
        return { name: m.name, kind: m.kind, type: m.type, params: m.params, change, line: m.line };
      });
      // Members whose declaration was removed (and that are not there any more).
      if (status === 'mod') {
        const names = new Set(t.members.map(m => m.name));
        for (const r of diff.removed) {
          if (r.at < t.line || r.at > t.endLine + 1) continue;
          const line = blank(r.text).trim();
          if (!/[;{]\s*$|=>|^\s*(public|private|protected|internal)\b/.test(line)) continue;
          const m = classifyMember(line.replace(/[;{]\s*$/, ''), t.name);
          if (m && !names.has(m.name)) {
            names.add(m.name);
            members.push({ name: m.name, kind: m.kind, type: m.type, params: m.params, change: 'del', line: r.at });
          }
        }
      }
      changed.push({
        node: {
          id: `${f.path}#${t.name}#${t.line}`,
          name: t.name,
          kind: t.kind,
          record: t.record,
          generic: t.generic,
          namespace: t.namespace,
          status,
          file: f.path,
          line: t.line,
          members,
          bases: t.bases,
        },
        type: t,
        added: diff.added,
      });
    }
  }
  // Types of the changed files that did not change themselves stay only when
  // the changed ones use them, or they use a changed one.
  const byName = new Map();
  for (const c of changed) if (!byName.has(c.node.name) || c.node.status !== 'same') byName.set(c.node.name, c);

  let index = new Map();
  if (cwd && fs.existsSync(cwd)) {
    try { index = await projectIndex(projectRoot(cwd)); } catch { index = new Map(); }
  }
  const edges = [];
  const contextUse = new Map();   // name -> times used by changed types
  const kindOf = name => byName.get(name)?.node.kind || (COMMON.has(name) ? null : index.get(name)?.kind) || null;
  for (const c of changed) {
    const t = c.type;
    const seen = new Set();
    for (const base of t.bases) {
      if (base === t.name) continue;
      const k = kindOf(base);
      if (!k) continue;
      const implementsIt = k === 'interface' && t.kind !== 'interface';
      edges.push({ from: c.node.id, toName: base, kind: implementsIt ? 'implements' : 'inherits', fresh: c.added.has(t.line) && c.node.status !== 'new', line: t.line });
      seen.add(base);
    }
    for (const [word, lines] of t.words) {
      if (seen.has(word) || !kindOf(word)) continue;
      // A use is new when it is only on lines the diff added.
      const fresh = c.node.status === 'mod' && [...lines].every(l => c.added.has(l));
      edges.push({ from: c.node.id, toName: word, kind: 'uses', fresh, line: Math.min(...lines) });
      seen.add(word);
    }
  }
  // Where each arrow goes: a type of the changes, or a type elsewhere in the
  // project (a "context" box, faded, for the most used ones only).
  const nodes = changed.map(c => c.node);
  const relevant = new Set(nodes.filter(n => n.status !== 'same').map(n => n.id));
  for (const e of edges) {
    const target = byName.get(e.toName);
    if (target) e.to = target.node.id;
    else contextUse.set(e.toName, (contextUse.get(e.toName) || 0) + (relevant.has(e.from) ? 1 : 0));
  }
  const context = [...contextUse].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, MAX_CONTEXT).map(([name]) => name);
  for (const name of context) {
    const info = index.get(name);
    // A type from a Unity package names its package (com.company.name).
    const pkg = /[\\/]PackageCache[\\/]([^\\/@]+)/.exec(info.file)?.[1] || null;
    nodes.push({ id: `ctx#${name}`, name, kind: info.kind, namespace: info.namespace, package: pkg, status: 'context', file: info.file, line: 1, members: [], bases: [] });
  }
  for (const e of edges) if (!e.to && context.includes(e.toName)) e.to = `ctx#${e.toName}`;
  let kept = edges.filter(e => e.to && e.to !== e.from);
  // Unchanged types stay when they are connected to a changed one.
  const touchesChanged = new Set();
  for (const e of kept) {
    if (relevant.has(e.from)) touchesChanged.add(e.to);
    if (relevant.has(e.to)) touchesChanged.add(e.from);
  }
  const keep = new Set(nodes.filter(n => n.status !== 'same' || touchesChanged.has(n.id)).map(n => n.id));
  kept = kept.filter(e => keep.has(e.from) && keep.has(e.to));
  // One arrow per pair: inherits/implements win over uses.
  const pairs = new Map();
  for (const e of kept) {
    const key = `${e.from}>${e.to}`;
    const prev = pairs.get(key);
    if (!prev || (prev.kind === 'uses' && e.kind !== 'uses')) pairs.set(key, e);
  }
  return {
    nodes: nodes.filter(n => keep.has(n.id)),
    edges: [...pairs.values()].map(({ from, to, kind, fresh, line }) => ({ from, to, kind, fresh, line })),
  };
}

module.exports = { model, parseFile, blank };
