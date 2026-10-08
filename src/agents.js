// Starts and talks to Claude Code processes.
//
// Each agent is one `claude -p` process in stream-json mode. We write the
// person's messages to its stdin as JSON lines, and it writes every event
// (assistant text, tool calls, tool results, end-of-turn results) to stdout
// as JSON lines. We forward those events to the window unchanged.

const { spawn } = require('child_process');
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

function findClaude(configured) {
  if (configured && fs.existsSync(configured)) return configured;
  return CLAUDE_CANDIDATES.find(p => fs.existsSync(p)) || 'claude';
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

  start({ cwd, resumeId, permissionMode, model, title }) {
    const config = this.getConfig();
    const id = randomUUID();
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', permissionMode || config.defaultPermissionMode,
    ];
    if (model) args.push('--model', model);
    if (resumeId) args.push('--resume', resumeId);
    args.push(...(config.extraArgs || []));

    const proc = spawn(findClaude(config.claudePath), args, {
      cwd,
      env: childEnv(config.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const agent = { id, proc, cwd, title, status: 'starting', sessionId: resumeId || null, stderr: '' };
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
    if (msg.session_id && msg.session_id !== agent.sessionId) {
      agent.sessionId = msg.session_id;
      this.send('agent:session', agent.id, msg.session_id);
    }
    if (msg.type === 'system' && msg.subtype === 'init') this.setStatus(agent, agent.status === 'starting' ? 'idle' : agent.status);
    if (msg.type === 'assistant' || msg.type === 'stream_event') this.setStatus(agent, 'working');
    if (msg.type === 'result') this.setStatus(agent, msg.is_error ? 'error' : 'idle');
    this.send('agent:event', agent.id, msg);
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

module.exports = { AgentManager };
