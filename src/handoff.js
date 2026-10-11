// A new agent in a category continues from the category's latest agent (see
// forkSourceFor in app.js). Forking copies that agent's whole conversation,
// and every step of the new agent then reads it again: with a long parent
// (hundreds of thousands of tokens) that was most of the tokens a category
// used. So a large parent is not forked: the new agent starts fresh with a
// short handoff that Haiku writes from the parent's conversation.
//
// contextSize(file): how many tokens the session's conversation had at its
// last answer. handoff(config, file, title): the handoff text, or null.

const fs = require('fs');
const os = require('os');
const { spawnClaude, killTree, childEnv } = require('./platform');

function entries(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a partly written line */ }
  }
  return out;
}

function contextSize(file) {
  try {
    const all = entries(file);
    for (let i = all.length - 1; i >= 0; i--) {
      const u = all[i].type === 'assistant' ? all[i].message?.usage : null;
      if (u) return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    }
  } catch { /* unreadable */ }
  return 0;
}

// The parent's conversation, condensed: your messages, what the agent said,
// and the files it changed (the newest part when it is long).
function digest(file) {
  const parts = [];
  const files = new Set();
  for (const e of entries(file)) {
    if (e.isSidechain || e.isMeta || e.isCompactSummary) continue;
    const c = e.message?.content;
    if (e.type === 'user') {
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';
      const clean = text.replace(/^\s*<(group-notes|handoff)\b[\s\S]*?<\/\1>\s*/g, '').trim();
      if (clean && !/^\s*<(command-|local-command|system-reminder|task-notification)/.test(clean)) parts.push(`USER: ${clean.slice(0, 1500)}`);
    } else if (e.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'text' && b.text.trim()) parts.push(`AGENT: ${b.text.trim().slice(0, 1200)}`);
        if (b.type === 'tool_use' && ['Edit', 'Write', 'MultiEdit'].includes(b.name) && b.input?.file_path) files.add(b.input.file_path);
      }
    }
  }
  return { text: parts.join('\n\n').slice(-24000), files: [...files].slice(-40) };
}

function handoff(config, file, title) {
  return new Promise(resolve => {
    let d;
    try { d = digest(file); } catch { return resolve(null); }
    if (!d.text) return resolve(null);
    const proc = spawnClaude(config.claudePath,
      ['-p', '--model', 'haiku', '--output-format', 'json', '--strict-mcp-config', '--tools', '', '--no-session-persistence'],
      { cwd: os.tmpdir(), env: childEnv(config.env), stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => killTree(proc), 90000);
    proc.stdout.on('data', x => { out += x; });
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
    proc.on('close', () => {
      clearTimeout(timer);
      try {
        const r = JSON.parse(out);
        resolve(!r.is_error && typeof r.result === 'string' && r.result.trim() ? r.result.trim() : null);
      } catch { resolve(null); }
    });
    proc.stdin.end([
      `An AI coding agent ("${title}") worked on tasks for a user. A new agent continues this line of work in the same project, but starts fresh instead of reading the whole conversation.`,
      'Write the handoff the new agent needs, from the conversation below:',
      '- What was built or changed, and where (key files, folders, assets, names).',
      '- Decisions and the user\'s preferences (what was approved, rejected, or asked to change), and how things are done in this project (tools, commands, steps that worked, pitfalls).',
      '- What is unfinished or was planned next, if anything.',
      'At most 250 words, as short bullet points under those three headings. Only facts from the conversation. Reply with only the handoff.',
      '',
      `<files_changed>\n${d.files.join('\n') || 'none recorded'}\n</files_changed>`,
      '',
      `<conversation>\n${d.text}\n</conversation>`,
    ].join('\n'));
  });
}

module.exports = { contextSize, handoff };
