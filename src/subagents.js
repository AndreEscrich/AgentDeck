// What an agent's sub-agents did, for its Changes card. A sub-agent that
// runs in the background is not in the agent's live stream, so the window
// never sees its tool calls; Claude Code saves them under
// ~/.claude/projects/<folder>/<session id>/subagents/agent-*.jsonl. The card
// keeps only the files the agent changed (agentTouched in render.js), and
// without these a prefab a sub-agent made or deleted would be left out.
//
// evidence(sessionId, since) resolves with { touched: [paths], evidence:
// [texts] } from the tool calls made at or after `since` (ms): the files
// edited or written, the commands run, and the input of the other tools that
// change things (the same as noteEvidence in render.js).

const fs = require('fs');
const path = require('path');
const { PROJECTS_DIR } = require('./sessions');

const ID = /^[A-Za-z0-9-]{8,64}$/;
const READ_ONLY = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'Skill', 'ToolSearch']);
const SCRIPT = /\.(py|sh|bash|zsh|js|mjs|cjs|ts|rb|pl|ps1|command|bat|cmd)$/i;

async function subagentDir(sessionId) {
  let projects;
  try { projects = await fs.promises.readdir(PROJECTS_DIR); } catch { return null; }
  for (const p of projects) {
    const dir = path.join(PROJECTS_DIR, p, sessionId, 'subagents');
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

async function evidence(sessionId, since) {
  const out = { touched: [], evidence: [] };
  if (!ID.test(String(sessionId))) return out;
  const dir = await subagentDir(sessionId);
  if (!dir) return out;
  const from = Number(since) || 0;
  for (const name of await fs.promises.readdir(dir).catch(() => [])) {
    if (!/\.jsonl$/.test(name)) continue;
    const file = path.join(dir, name);
    // A sub-agent that finished before the task started has nothing for it.
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat || stat.mtimeMs < from || stat.size > 64 * 1024 * 1024) continue;
    const text = await fs.promises.readFile(file, 'utf8').catch(() => '');
    for (const line of text.split('\n')) {
      if (!line.includes('"tool_use"')) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type !== 'assistant' || Date.parse(entry.timestamp) < from) continue;
      for (const block of entry.message?.content || []) {
        if (block?.type !== 'tool_use') continue;
        const input = block.input || {};
        const target = input.file_path || input.notebook_path;
        if (target) out.touched.push(target);
        if (block.name === 'Bash' || block.name === 'PowerShell') out.evidence.push(String(input.command || ''));
        else if (block.name === 'Write' && SCRIPT.test(target || '')) out.evidence.push(String(input.content || ''));
        else if (!READ_ONLY.has(block.name) && !['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(block.name)) {
          try { out.evidence.push(JSON.stringify(input)); } catch { /* not important */ }
        }
      }
    }
  }
  return out;
}

module.exports = { evidence };
