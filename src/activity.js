// Your Claude Code activity per day, for the Hub's activity view: tokens,
// messages you sent and sessions, from the session files Claude Code saves in
// ~/.claude/projects (everything run with Claude Code: Agent Hub, the
// terminal, the Claude desktop app's Code tab).
//
// Reading every file each time would be slow, so the result per file is kept
// in a cache file and only files that changed since are read again.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { PROJECTS_DIR } = require('./sessions');

// The day of a timestamp in your own time zone, as YYYY-MM-DD.
function localDay(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function tokensOf(u) {
  return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
}

// One file: { days: { date: { tokens, output, prompts, sessions: [ids] } }, models: { model: tokens }, hours: [24] }.
async function summarizeFile(file) {
  const days = {};
  const models = {};
  const hours = new Array(24).fill(0);
  const seen = new Set();   // one API answer can be saved as several lines with the same message id
  const day = d => (days[d] = days[d] || { tokens: 0, output: 0, prompts: 0, sessions: [] });
  const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    // Only answers (with token usage) and your own messages matter.
    const isAnswer = line.includes('"usage"') && line.includes('"assistant"');
    const isUser = !isAnswer && line.includes('"type":"user"');
    if (!isAnswer && !isUser) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const date = localDay(e.timestamp);
    if (!date) continue;
    const d = day(date);
    if (e.sessionId && !d.sessions.includes(e.sessionId)) d.sessions.push(e.sessionId);
    if (e.type === 'assistant' && e.message?.usage) {
      const id = e.message.id || e.requestId;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      const t = tokensOf(e.message.usage);
      d.tokens += t;
      d.output += e.message.usage.output_tokens || 0;
      const model = e.message.model;
      if (model && !model.startsWith('<')) models[model] = (models[model] || 0) + t;
    } else if (e.type === 'user' && !e.isMeta && !e.isSidechain) {
      // A message you typed: text, not a tool result or a command's output.
      const c = e.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) && !c.some(b => b.type === 'tool_result') ? c.filter(b => b.type === 'text').map(b => b.text).join('') : '';
      if (text && !/^\s*<(command-|local-command|system-reminder)/.test(text)) {
        d.prompts++;
        hours[new Date(e.timestamp).getHours()]++;
      }
    }
  }
  return { days, models, hours };
}

// Everything, merged: { days: [{ date, tokens, output, prompts, sessions }], models, hours, since }.
async function activity(cacheFile) {
  let cache = { files: {} };
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { /* first time */ }
  const files = {};
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch { /* no sessions yet */ }
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(path.join(PROJECTS_DIR, dir)); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(PROJECTS_DIR, dir, name);
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      const old = cache.files[file];
      if (old && old.mtimeMs === stat.mtimeMs && old.size === stat.size) {
        files[file] = old;
      } else {
        try {
          files[file] = { mtimeMs: stat.mtimeMs, size: stat.size, ...(await summarizeFile(file)) };
        } catch { /* unreadable: leave it out */ }
      }
    }
  }
  try { fs.writeFileSync(cacheFile, JSON.stringify({ files })); } catch { /* not important */ }

  const days = {};
  const models = {};
  const hours = new Array(24).fill(0);
  for (const f of Object.values(files)) {
    for (const [date, d] of Object.entries(f.days || {})) {
      const t = (days[date] = days[date] || { date, tokens: 0, output: 0, prompts: 0, sessions: new Set() });
      t.tokens += d.tokens;
      t.output += d.output;
      t.prompts += d.prompts;
      for (const s of d.sessions) t.sessions.add(s);
    }
    for (const [m, t] of Object.entries(f.models || {})) models[m] = (models[m] || 0) + t;
    (f.hours || []).forEach((n, h) => { hours[h] += n; });
  }
  const list = Object.values(days)
    .map(d => ({ date: d.date, tokens: d.tokens, output: d.output, prompts: d.prompts, sessions: d.sessions.size }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { days: list, models, hours };
}

module.exports = { activity, localDay };
