// Starts and talks to Claude Code processes.
//
// Each agent is one `claude -p` process in stream-json mode. We write the
// person's messages to its stdin as JSON lines, and it writes every event
// (assistant text, tool calls, tool results, end-of-turn results) to stdout
// as JSON lines. We forward those events to the window unchanged.

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const CLAUDE_CANDIDATES = [
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
  path.join(os.homedir(), '.local/bin/claude'),
  path.join(os.homedir(), '.claude/local/claude'),
];

// The Claude desktop app keeps its own copy of Claude Code here, one folder
// per version, and updates it automatically. That copy is often newer than a
// Homebrew or npm install, and a newer copy knows about newer models.
const DESKTOP_DIR = path.join(os.homedir(), 'Library/Application Support/Claude/claude-code');

function desktopCandidates() {
  const found = [];
  let versions = [];
  try { versions = fs.readdirSync(DESKTOP_DIR); } catch { return found; }
  for (const version of versions) {
    let builds = [];
    try { builds = fs.readdirSync(path.join(DESKTOP_DIR, version)); } catch { continue; }
    for (const build of builds) {
      found.push(path.join(DESKTOP_DIR, version, build, 'claude.app/Contents/MacOS/claude'));
    }
  }
  return found;
}

// Install paths contain the version (".../claude-code/2.1.293/...",
// ".../Caskroom/claude-code/2.1.176/..."). When a path does not, we ask the
// binary itself.
function versionOf(binary) {
  const fromPath = binary.match(/\/(\d+\.\d+\.\d+)\//);
  if (fromPath) return fromPath[1];
  try {
    const out = execFileSync(binary, ['--version'], { timeout: 5000, encoding: 'utf8' });
    return out.match(/\d+\.\d+\.\d+/)?.[0] || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

// Uses the configured path when there is one. Otherwise it picks the newest
// Claude Code installed on this Mac. The answer is kept for five minutes, so
// a desktop app update is picked up without restarting AgentDeck.
let cachedClaude = null;
function findClaude(configured) {
  if (configured && fs.existsSync(configured)) return configured;
  if (cachedClaude && Date.now() - cachedClaude.at < 5 * 60 * 1000) return cachedClaude.path;

  let best = null;
  for (const candidate of [...CLAUDE_CANDIDATES, ...desktopCandidates()]) {
    let real;
    try { real = fs.realpathSync(candidate); } catch { continue; }
    const version = versionOf(real);
    if (!best || compareVersions(version, best.version) > 0) best = { path: real, version };
  }
  cachedClaude = { path: best?.path || 'claude', version: best?.version, at: Date.now() };
  return cachedClaude.path;
}

// An app started from Finder gets a short PATH, so agents could not find
// node, git or brew tools. We add the usual install folders. When the app is
// itself started from inside a Claude Code session, that session's variables
// (proxy URL, session ids) would make the child talk to the wrong endpoint,
// so we remove them.
function childEnv(extra) {
  const env = { ...process.env, ...extra };
  if (env.CLAUDECODE) {
    for (const key of Object.keys(env)) {
      if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_') || key.startsWith('CLAUDE_AGENT_SDK_') || key === 'ANTHROPIC_BASE_URL') {
        delete env[key];
      }
    }
  }
  const extraPath = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin')];
  env.PATH = [...extraPath, env.PATH || '/usr/bin:/bin'].join(':');
  return env;
}

class AgentManager {
  constructor({ send, getConfig }) {
    this.send = send;          // send(channel, ...args) to the window
    this.getConfig = getConfig;
    this.agents = new Map();
  }

  start({ cwd, resumeId, permissionMode, model, effort, fastMode, title }) {
    const config = this.getConfig();
    const id = randomUUID();
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', permissionMode || config.defaultPermissionMode,
      // Send permission questions to us over stdout instead of refusing them.
      '--permission-prompt-tool', 'stdio',
    ];
    if (model && model !== 'default') args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (fastMode) args.push('--settings', JSON.stringify({ fastMode: true }));
    if (resumeId) args.push('--resume', resumeId);
    args.push(...(config.extraArgs || []));

    const proc = spawn(findClaude(config.claudePath), args, {
      cwd,
      env: childEnv(config.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const agent = { id, proc, cwd, title, status: 'starting', sessionId: resumeId || null, stderr: '', pending: new Set() };
    this.agents.set(id, agent);

    let buffer = '';
    proc.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) this.handleLine(agent, line);
      }
    });
    proc.stderr.on('data', chunk => {
      agent.stderr = (agent.stderr + chunk.toString('utf8')).slice(-8000);
    });
    proc.on('error', err => {
      this.setStatus(agent, 'error');
      this.send('agent:event', id, { type: 'app_error', message: `Could not start claude: ${err.message}` });
    });
    proc.on('exit', code => {
      this.setStatus(agent, code === 0 || agent.closing ? 'exited' : 'error');
      this.send('agent:exit', id, { code, stderr: agent.stderr });
      this.agents.delete(id);
    });

    return { id };
  }

  handleLine(agent, line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === 'control_request') return this.handleControlRequest(agent, msg);
    if (msg.type === 'control_cancel_request') {
      agent.pending.delete(msg.request_id);
      this.send('agent:permissionCancel', agent.id, msg.request_id);
      if (!agent.pending.size && agent.status === 'waiting') this.setStatus(agent, 'working');
      return;
    }
    if (msg.type === 'control_response') return; // answers to our own requests
    if (msg.session_id && msg.session_id !== agent.sessionId) {
      agent.sessionId = msg.session_id;
      this.send('agent:session', agent.id, msg.session_id);
    }
    if (msg.type === 'system' && msg.subtype === 'init') {
      this.setStatus(agent, agent.status === 'starting' ? 'idle' : agent.status);
      if (msg.model && msg.model !== agent.model) {
        agent.model = msg.model;
        this.send('agent:model', agent.id, msg.model);
      }
    }
    if (msg.type === 'assistant' || msg.type === 'stream_event') this.setStatus(agent, 'working');
    if (msg.type === 'result') this.setStatus(agent, msg.is_error ? 'error' : 'idle');
    this.send('agent:event', agent.id, msg);
  }

  // The CLI asks before it runs a tool that your permission mode and rules do
  // not already allow. It waits until we answer with respondPermission().
  handleControlRequest(agent, msg) {
    if (msg.request?.subtype === 'can_use_tool') {
      agent.pending.add(msg.request_id);
      this.setStatus(agent, 'waiting');
      this.send('agent:permission', agent.id, { requestId: msg.request_id, ...msg.request });
      return;
    }
    // We do not handle other requests (hook callbacks, SDK MCP servers), so we
    // answer with an error to keep the CLI from waiting for us.
    this.writeJson(agent, {
      type: 'control_response',
      response: { subtype: 'error', request_id: msg.request_id, error: `AgentDeck does not handle ${msg.request?.subtype}` },
    });
  }

  // decision is { behavior: 'allow', updatedInput, updatedPermissions? }
  // or { behavior: 'deny', message }.
  respondPermission(id, requestId, decision) {
    const agent = this.agents.get(id);
    if (!agent || !agent.pending.has(requestId)) return;
    agent.pending.delete(requestId);
    this.writeJson(agent, { type: 'control_response', response: { subtype: 'success', request_id: requestId, response: decision } });
    if (!agent.pending.size) this.setStatus(agent, 'working');
  }

  writeJson(agent, obj) {
    agent.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  setStatus(agent, status) {
    if (agent.status === status) return;
    agent.status = status;
    this.send('agent:status', agent.id, status);
  }

  sendMessage(id, text) {
    const agent = this.agents.get(id);
    if (!agent) throw new Error('Agent is not running');
    const msg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
    agent.proc.stdin.write(JSON.stringify(msg) + '\n');
    this.setStatus(agent, 'working');
  }

  control(id, request) {
    const agent = this.agents.get(id);
    if (!agent) return;
    agent.proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: randomUUID(), request }) + '\n');
  }

  // Changes model, effort and fast mode from the next turn on, the same as the
  // /model, /effort and /fast commands in the terminal.
  setModel(id, { model, effort, fastMode }) {
    this.control(id, { subtype: 'set_model', model: model && model !== 'default' ? model : null });
    this.control(id, { subtype: 'apply_flag_settings', settings: { effortLevel: effort || null, fastMode: !!fastMode } });
  }

  // Asks Claude to stop the current turn but keeps the process alive, the same
  // as pressing Esc in the terminal.
  interrupt(id) {
    const agent = this.agents.get(id);
    if (!agent) return;
    const req = { type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } };
    agent.proc.stdin.write(JSON.stringify(req) + '\n');
  }

  close(id) {
    const agent = this.agents.get(id);
    if (!agent) return;
    agent.closing = true;
    agent.proc.stdin.end();
    setTimeout(() => { if (!agent.proc.killed && agent.proc.exitCode === null) agent.proc.kill('SIGTERM'); }, 2000);
  }

  closeAll() {
    for (const id of this.agents.keys()) this.close(id);
  }
}

// Asks the CLI which models this account can use. This is the same list, with
// the same descriptions, that the model menu in the Claude desktop app shows.
// We start a short-lived process, send the "initialize" request and read the
// "models" field of the answer. No API call is made.
function fetchModels(config) {
  return new Promise(resolve => {
    const proc = spawn(findClaude(config.claudePath),
      ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
      { cwd: os.homedir(), env: childEnv(config.env), stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '';
    const finish = models => { clearTimeout(timer); proc.kill(); resolve(models); };
    const timer = setTimeout(() => finish(null), 15000);
    proc.on('error', () => finish(null));
    proc.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8');
      for (const line of buffer.split('\n')) {
        if (!line.includes('"control_response"')) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.response?.request_id === 'models') return finish(msg.response.response?.models || null);
        } catch { /* incomplete line, wait for more data */ }
      }
    });
    proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } }) + '\n');
  });
}

module.exports = { AgentManager, fetchModels, findClaude };
