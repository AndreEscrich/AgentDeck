// Connectors (MCP servers) for the Hub's Connectors panel, managed with
// Claude Code's own commands, so agents get exactly what this panel shows:
//
//   claude mcp list          every connector and its status
//   claude mcp login <name>  sign in (opens the sign-in page in your browser)
//   claude mcp add …         add your own connector by URL (user scope)
//   claude mcp remove …      remove a connector you added
//
// Connectors from your claude.ai account (the same ones the Claude desktop
// app has) show as "claude.ai <name>"; they are added and removed on claude.ai.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnClaude, killTree, childEnv } = require('./platform');

// Runs a `claude mcp …` command and resolves with { code, out }.
function run(config, args, { cwd = os.homedir(), timeout = 60000 } = {}) {
  return new Promise(resolve => {
    const proc = spawnClaude(config.claudePath, ['mcp', ...args],
      { cwd, env: childEnv(config.env), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { out += d; });
    const timer = setTimeout(() => killTree(proc), timeout);
    proc.on('error', err => { clearTimeout(timer); resolve({ code: -1, out: err.message }); });
    proc.on('close', code => { clearTimeout(timer); resolve({ code, out }); });
  });
}

// Connectors you added yourself: user scope (all folders) and local scope
// (this folder only), both kept in ~/.claude.json.
function ownConnectors(cwd) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    return {
      user: new Set(Object.keys(cfg.mcpServers || {})),
      local: new Set(Object.keys(cfg.projects?.[cwd]?.mcpServers || {})),
    };
  } catch {
    return { user: new Set(), local: new Set() };
  }
}

// One line of `claude mcp list` looks like
//   "claude.ai Notion: https://mcp.notion.com/mcp - ! Needs authentication"
// The name can contain spaces; the status follows the last " - ".
function parseList(text, cwd) {
  const own = ownConnectors(cwd);
  const list = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^(.+?): (.+) - ([✔✘!⏸?]|✓|✗)\s*(.*)$/u);
    if (!m) continue;
    const [, id, target, mark, rest] = m;
    const status = /✔|✓/.test(mark) ? 'connected'
      : mark === '!' ? 'auth'
      : mark === '⏸' ? 'pending'
      : /✘|✗/.test(mark) ? 'failed' : 'unknown';
    const fromAccount = id.startsWith('claude.ai ');
    list.push({
      id,                                             // the name Claude Code uses
      name: fromAccount ? id.slice('claude.ai '.length) : id,
      target,                                         // URL, or the command it runs
      status,
      detail: rest.replace(/^(Connected|Needs authentication|Failed to connect)\s*[—-]?\s*/, '').slice(0, 300),
      source: fromAccount ? 'claude.ai' : own.local.has(id) ? 'local' : own.user.has(id) ? 'user' : 'project',
    });
  }
  return list;
}

let lastList = null;   // shown right away while a new check runs

async function list(config, cwd) {
  const folder = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const { out } = await run(config, ['list'], { cwd: folder, timeout: 90000 });
  lastList = parseList(out, folder);
  return lastList;
}

function cached() {
  return lastList;
}

// Signing in waits for you to finish in the browser (up to 5 minutes).
// cancelLogin() stops a sign-in that is still waiting.
const logins = new Map();   // connector id -> process
function login(config, id) {
  return new Promise(resolve => {
    const proc = spawnClaude(config.claudePath, ['mcp', 'login', id],
      { cwd: os.homedir(), env: childEnv(config.env), stdio: ['ignore', 'pipe', 'pipe'] });
    logins.set(id, proc);
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { out += d; });
    const timer = setTimeout(() => killTree(proc), 5 * 60 * 1000);
    const done = code => {
      clearTimeout(timer);
      logins.delete(id);
      resolve({ ok: code === 0, message: out.trim().split('\n').slice(-3).join('\n') });
    };
    proc.on('error', () => done(-1));
    proc.on('close', done);
  });
}

function cancelLogin(id) {
  const proc = logins.get(id);
  if (proc) killTree(proc);
}

// Adds a connector by URL for all your folders (user scope). header is an
// optional "Name: value" line, for connectors that take an API key.
async function add(config, { name, url, transport = 'http', header }) {
  // Claude Code allows letters, digits, dashes and underscores in names.
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(name || '')) return { ok: false, message: 'Use only letters, digits, dashes (-) and underscores (_) in the name, for example my-docs.' };
  if (!/^https?:\/\//i.test(url || '')) return { ok: false, message: 'The URL must start with http:// or https://.' };
  const args = ['add', '--transport', transport === 'sse' ? 'sse' : 'http', '--scope', 'user'];
  if (header) args.push('--header', header);
  args.push(name, url);
  const { code, out } = await run(config, args);
  return { ok: code === 0, message: out.trim() };
}

async function remove(config, { id, source, cwd }) {
  const scope = source === 'local' ? 'local' : source === 'project' ? 'project' : 'user';
  const { code, out } = await run(config, ['remove', id, '--scope', scope], { cwd: cwd || os.homedir() });
  return { ok: code === 0, message: out.trim() };
}

module.exports = { list, cached, login, cancelLogin, add, remove, parseList };
