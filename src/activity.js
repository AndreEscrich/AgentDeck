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

// One file: every API answer (by message id, with its day, session, tokens,
// output tokens and model) and every message you typed (by uuid, with its
// day, hour and session). A forked session copies its history into its own
// file with the same ids, so the merge below counts each one only once, for
// the session it first belonged to.
async function summarizeFile(file) {
  const calls = [];    // [id, date, sessionId, tokens, output, model, fromHub]
  const prompts = [];  // [uuid, date, hour, sessionId]
  const seen = new Set();   // one API answer can be saved as several lines with the same message id
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
    if (e.type === 'assistant' && e.message?.usage) {
      const id = e.message.id || e.requestId || e.uuid;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const model = e.message.model && !e.message.model.startsWith('<') ? e.message.model : null;
      calls.push([id, date, e.sessionId || null, tokensOf(e.message.usage), e.message.usage.output_tokens || 0, model, e.entrypoint === 'sdk-cli' ? 1 : 0]);
    } else if (e.type === 'user' && !e.isMeta && !e.isSidechain && !e.isCompactSummary) {
      // A message you typed: text, not a tool result or a command's output.
      const c = e.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) && !c.some(b => b.type === 'tool_result') ? c.filter(b => b.type === 'text').map(b => b.text).join('') : '';
      if (text && !/^s*<(command-|local-command|system-reminder|task-notification)/.test(text)) {
        prompts.push([e.uuid || `${file}:${prompts.length}`, date, new Date(e.timestamp).getHours(), e.sessionId || null]);
      }
    }
  }
  return { calls, prompts };
}

// Everything, merged: { days: [{ date, tokens, output, prompts, sessions }],
// models, hours, sessions: { id: { tokens, prompts, fromHub, days: { date: tokens },
// promptDays: { date: messages } } } }.
const CACHE_VERSION = 2;
async function activity(cacheFile) {
  let cache = { files: {} };
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { /* first time */ }
  if (cache.version !== CACHE_VERSION) cache = { files: {} };
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
  try { fs.writeFileSync(cacheFile, JSON.stringify({ version: CACHE_VERSION, files })); } catch { /* not important */ }

  // Oldest files first: a copied answer counts for the session that had it first.
  const ordered = Object.values(files).sort((a, b) => a.mtimeMs - b.mtimeMs);
  const callSeen = new Set();
  const promptSeen = new Set();
  const days = {};
  const models = {};
  const hours = new Array(24).fill(0);
  const sessions = {};
  const day = date => (days[date] = days[date] || { date, tokens: 0, output: 0, prompts: 0, sessions: new Set() });
  const session = id => (sessions[id] = sessions[id] || { tokens: 0, prompts: 0, fromHub: 0, days: {}, promptDays: {} });
  for (const f of ordered) {
    for (const [id, date, sid, tokens, output, model, fromHub] of f.calls || []) {
      if (callSeen.has(id)) continue;
      callSeen.add(id);
      const d = day(date);
      d.tokens += tokens;
      d.output += output;
      if (sid) {
        d.sessions.add(sid);
        const s = session(sid);
        s.tokens += tokens;
        s.days[date] = (s.days[date] || 0) + tokens;
        if (fromHub) s.fromHub = 1;
      }
      if (model) models[model] = (models[model] || 0) + tokens;
    }
    for (const [uuid, date, hour, sid] of f.prompts || []) {
      if (promptSeen.has(uuid)) continue;
      promptSeen.add(uuid);
      const d = day(date);
      d.prompts++;
      hours[hour]++;
      if (sid) {
        d.sessions.add(sid);
        const s = session(sid);
        s.prompts++;
        s.promptDays[date] = (s.promptDays[date] || 0) + 1;
      }
    }
  }
  const list = Object.values(days)
    .map(d => ({ date: d.date, tokens: d.tokens, output: d.output, prompts: d.prompts, sessions: d.sessions.size }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { days: list, models, hours, sessions };
}

module.exports = { activity, localDay };
