// Reads the session history that Claude Code saves under ~/.claude/projects.
// Each project folder holds one .jsonl file per session, with one JSON object per line.

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 64 * 1024;

function readSlice(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a slice can cut a line in half */ }
  }
  return out;
}

// Returns the plain text of a user message, or null when the message is not
// something the person typed (tool results, slash-command output, meta lines).
function userText(entry) {
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain) return null;
  const content = entry.message?.content;
  let text = null;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    const parts = content.filter(c => c.type === 'text').map(c => c.text);
    if (parts.length) text = parts.join('\n');
  }
  if (!text) return null;
  if (/^\s*<(command-|local-command|system-reminder)/.test(text)) return null;
  return text;
}

function summarize(file) {
  const stat = fs.statSync(file);
  const head = parseLines(readSlice(file, 0, Math.min(stat.size, HEAD_BYTES)));
  const tailStart = Math.max(0, stat.size - TAIL_BYTES);
  const tail = tailStart > 0 ? parseLines(readSlice(file, tailStart, TAIL_BYTES)) : head;

  let cwd = null;
  let firstPrompt = null;
  let customTitle = null;
  for (const e of head) {
    if (!cwd && e.cwd) cwd = e.cwd;
    if (!firstPrompt) firstPrompt = userText(e);
    if (e.type === 'custom-title') customTitle = e.customTitle;
  }
  // The newest custom title wins, and it is usually near the end of the file.
  for (const e of tail) {
    if (e.type === 'custom-title') customTitle = e.customTitle;
  }
  if (!firstPrompt && !customTitle) return null;

  return {
    id: path.basename(file, '.jsonl'),
    file,
    cwd,
    title: customTitle || firstPrompt.split('\n')[0].slice(0, 120),
    updatedAt: stat.mtimeMs,
  };
}

// The History entry of each file, kept while the file does not change. While
// agents work, the list is read again every few seconds, and reading all
// files each time blocked the app for about 200 ms.
const summaries = new Map();   // file -> { mtimeMs, size, summary }

function summarizeCached(file) {
  const stat = fs.statSync(file);
  const hit = summaries.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.summary;
  const summary = summarize(file);
  summaries.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
  return summary;
}

function listSessions() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  const sessions = [];
  for (const dir of fs.readdirSync(PROJECTS_DIR)) {
    const full = path.join(PROJECTS_DIR, dir);
    let files;
    try { files = fs.readdirSync(full); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const s = summarizeCached(path.join(full, f));
        if (s) sessions.push(s);
      } catch { /* skip unreadable files */ }
    }
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions;
}

// Converts a saved transcript into the same message shape that a live agent
// emits, so the renderer can draw both with one code path.
function loadTranscript(file) {
  const entries = parseLines(fs.readFileSync(file, 'utf8'));
  const messages = [];
  let cwd = null;
  for (const e of entries) {
    if (e.isSidechain) continue;
    if (!cwd && e.cwd) cwd = e.cwd;
    if (e.type === 'assistant' && e.message) {
      messages.push({ type: 'assistant', message: e.message });
    } else if (e.type === 'user' && e.message && !e.isMeta) {
      const content = e.message.content;
      const hasToolResult = Array.isArray(content) && content.some(c => c.type === 'tool_result');
      if (hasToolResult || userText(e)) messages.push({ type: 'user', message: e.message, tool_use_result: e.toolUseResult });
    }
  }
  return { cwd, messages };
}

module.exports = { listSessions, loadTranscript, PROJECTS_DIR };
