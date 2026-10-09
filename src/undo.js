// Undo for the Changes card: puts one file back the way it was before the
// agent's task, by applying the file's diff backwards. That works the same
// for git repositories, SVN checkouts and plain folders, and touches nothing
// but the file (not git's index, not the stash).
//
// A file you (or another agent) changed again after the task is only undone
// where its lines still match: each block of changed lines must still be in
// the file, or nothing is written and the answer says which file is in the way.
//
// Undo returns the file's content before the undo, so Redo can put it back.

const fs = require('fs');
const path = require('path');

// file: { path, status: 'new' | 'mod' | 'del' | 'bin', lines: [[kind, text]] },
// as parseUnifiedDiff in render.js makes it.

function resolve(cwd, p) {
  return path.isAbsolute(p) ? p : path.join(cwd || '', p);
}

// Text and how it was written: line ending and a newline at the end or not.
function splitText(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const finalNewline = lines.length > 1 && lines[lines.length - 1] === '';
  if (finalNewline) lines.pop();
  return { lines, eol, finalNewline };
}

function joinText({ lines, eol, finalNewline }) {
  return lines.join(eol) + (finalNewline && lines.length ? eol : '');
}

const clean = text => text.slice(1).replace(/\r$/, '');

// Splits the diff lines into hunks: { newStart, newCount, before, after }.
function hunksOf(file) {
  const hunks = [];
  let h = null;
  for (const [kind, text] of file.lines) {
    if (kind === 'hunk') {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(text);
      if (!m) { h = null; continue; }
      h = { newStart: Number(m[1]), newCount: m[2] == null ? 1 : Number(m[2]), before: [], after: [] };
      hunks.push(h);
    } else if (h) {
      if (kind !== 'add') h.before.push(clean(text));
      if (kind !== 'del') h.after.push(clean(text));
    }
  }
  return hunks;
}

function matchesAt(lines, block, at) {
  if (at < 0 || at + block.length > lines.length) return false;
  for (let i = 0; i < block.length; i++) if (lines[at + i] !== block[i]) return false;
  return true;
}

// Where block is in lines: at the expected place, or the nearest place to it.
function find(lines, block, expected) {
  for (let d = 0; d <= lines.length; d++) {
    if (matchesAt(lines, block, expected - d)) return expected - d;
    if (d && matchesAt(lines, block, expected + d)) return expected + d;
  }
  return -1;
}

// Applies the hunks backwards: each block of new lines goes back to the old
// lines. The last hunk goes first, so the line numbers of the earlier ones
// still fit (also for several Edit reports in a row).
function unpatch(lines, hunks) {
  lines = [...lines];
  for (const h of [...hunks].reverse()) {
    // A hunk without lines on the new side sits after line newStart.
    const expected = h.after.length ? h.newStart - 1 : h.newStart;
    const at = h.after.length ? find(lines, h.after, expected) : Math.min(expected, lines.length);
    if (at < 0) return null;
    lines.splice(at, h.after.length, ...h.before);
  }
  return lines;
}

// Applies the hunks forwards: each block of old lines becomes the new lines.
// The first hunk goes first, so later ones find their place after it.
function patch(lines, hunks) {
  lines = [...lines];
  for (const h of hunks) {
    const expected = h.before.length ? h.newStart - 1 : h.newStart;
    const at = h.before.length ? find(lines, h.before, expected) : Math.min(Math.max(0, expected), lines.length);
    if (at < 0) return null;
    lines.splice(at, h.before.length, ...h.after);
  }
  return lines;
}

// Resolves with { ok: true, previous } (base64 of the content before the
// undo, or null when the file did not exist) or { ok: false, error }.
async function undoFile(cwd, file) {
  if (!file || typeof file.path !== 'string' || !Array.isArray(file.lines)) return { ok: false, error: 'Nothing to undo.' };
  const abs = resolve(cwd, file.path);
  const name = path.basename(file.path);
  if (file.status === 'bin') return { ok: false, error: `${name} is a binary file, which can't be undone here.` };
  const exists = fs.existsSync(abs);
  const previous = exists ? fs.readFileSync(abs).toString('base64') : null;
  try {
    if (file.status === 'new') {
      // A file the task created: undoing it removes it.
      if (exists) fs.unlinkSync(abs);
      return { ok: true, previous };
    }
    if (file.status === 'del') {
      if (exists) return { ok: false, error: `${name} exists again, so it was not restored.` };
      const removed = file.lines.filter(([kind]) => kind === 'del').map(([, text]) => text);
      // git's diff keeps the \r of Windows line endings.
      const eol = removed.some(text => text.endsWith('\r')) ? '\r\n' : '\n';
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, joinText({ lines: removed.map(clean), eol, finalNewline: true }));
      return { ok: true, previous };
    }
    if (!exists) return { ok: false, error: `${name} no longer exists.` };
    const text = splitText(fs.readFileSync(abs, 'utf8'));
    const lines = unpatch(text.lines, hunksOf(file));
    if (!lines) return { ok: false, error: `${name} was changed again after the task, so its changes no longer fit. Nothing was written.` };
    fs.writeFileSync(abs, joinText({ ...text, lines }));
    return { ok: true, previous };
  } catch (err) {
    return { ok: false, error: `${name}: ${err.message}` };
  }
}

// Redo: puts back the content undoFile returned (null: the file did not exist).
async function restoreFile(cwd, p, previous) {
  const abs = resolve(cwd, p);
  try {
    if (previous == null) {
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, Buffer.from(previous, 'base64'));
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `${path.basename(p)}: ${err.message}` };
  }
}

// The whole file before and after the task, as the agent left it, rebuilt
// from the task's diff (its history), whatever happened to the file since:
// - a new file: its lines are in the diff (a file written and then edited
//   in the same task: its first content with the edits applied);
// - a deleted file: its removed lines;
// - an edited file: the file on disk, if it still is the agent's version
//   (the diff applies backwards to it); if it was undone or reverted since,
//   it is the version before, and the diff applied forwards gives the
//   agent's version.
// Used by the full and side-by-side views and the class diagram. Resolves
// with { before, after } (arrays of lines; null for a file that did not
// exist) or { error }.
async function versions(cwd, file) {
  if (!file || typeof file.path !== 'string' || !Array.isArray(file.lines)) return { error: 'No file.' };
  const abs = resolve(cwd, file.path);
  const removed = () => file.lines.filter(([kind]) => kind === 'del').map(([, text]) => clean(text));
  try {
    if (file.status === 'del') return { before: removed(), after: null };
    if (file.status === 'new') {
      // Written whole (lines before the first @@), then maybe edited.
      const first = file.lines.findIndex(([kind]) => kind === 'hunk');
      const written = file.lines.slice(0, first < 0 ? undefined : first).filter(([kind]) => kind === 'add').map(([, text]) => clean(text));
      const rest = { lines: first < 0 ? [] : file.lines.slice(first) };
      const onlyAdds = rest.lines.every(([kind]) => kind === 'hunk' || kind === 'add');
      if (onlyAdds) return { before: null, after: [...written, ...rest.lines.filter(([kind]) => kind === 'add').map(([, text]) => clean(text))] };
      const after = patch(written, hunksOf(rest));
      if (after) return { before: null, after };
      if (fs.existsSync(abs)) return { before: null, after: splitText(fs.readFileSync(abs, 'utf8')).lines };
      return { error: `${path.basename(file.path)} can't be rebuilt from the task's changes.` };
    }
    if (!fs.existsSync(abs)) return { error: `${path.basename(file.path)} no longer exists, and its version from the task can't be rebuilt without it.` };
    const now = splitText(fs.readFileSync(abs, 'utf8')).lines;
    const hunks = hunksOf(file);
    const before = unpatch(now, hunks);
    if (before) return { before, after: now };
    const after = patch(now, hunks);
    if (after) return { before: now, after };
    return { error: 'The file was changed in the same lines since the task, so its version from the task can\'t be rebuilt.' };
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = { undoFile, restoreFile, unpatch, patch, hunksOf, versions };
