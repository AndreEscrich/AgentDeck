// Starts and talks to Claude Code processes.
//
// Each agent is one `claude -p` process in stream-json mode. We write the
// person's messages to its stdin as JSON lines, and it writes every event
// (assistant text, tool calls, tool results, end-of-turn results) to stdout
// as JSON lines. We forward those events to the window unchanged.

const os = require('os');
const { randomUUID } = require('crypto');
const { findClaude, spawnClaude, killTree, childEnv } = require('./platform');

// Tells every agent that the chat shows images and videos (see media.js and
// the Markdown rendering in render.js).
const MEDIA_PROMPT = [
  'Your conversation is shown in Agent Hub, a desktop app that renders images and videos in the chat.',
  'To show the user an image or a video, write a Markdown image with its file path, for example',
  '![Grass texture](Assets/Textures/Grass.png) or ![Gameplay recording](/Users/name/Movies/clip.mp4).',
  'Paths can be absolute or relative to your working folder.',
  'Images (png, jpg, gif, webp, tga, psd, exr, tif) show as pictures; videos (mp4, webm, mov) show as players.',
  'Whenever you create or change a texture, image or video, show it this way.',
].join(' ');

class AgentManager {
  constructor({ send, getConfig }) {
    this.send = send;          // send(channel, ...args) to the window
    this.getConfig = getConfig;
    this.agents = new Map();
  }

  start({ cwd, resumeId, forkSession, permissionMode, model, effort, fastMode, title }) {
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
      // Without this flag the CLI refuses a later switch to bypass mode.
      '--allow-dangerously-skip-permissions',
      '--append-system-prompt', MEDIA_PROMPT,
    ];
    if (model && model !== 'default') args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (fastMode) args.push('--settings', JSON.stringify({ fastMode: true }));
    if (resumeId) args.push('--resume', resumeId);
    // A fork starts a new session that begins with a copy of resumeId's conversation.
    if (resumeId && forkSession) args.push('--fork-session');
    args.push(...(config.extraArgs || []));

    const proc = spawnClaude(config.claudePath, args, {
      cwd,
      // Lets Claude ask you questions with options (the AskUserQuestion tool),
      // as in the Claude desktop app. They arrive as permission requests.
      env: childEnv({ CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL: 'true', ...config.env }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const agent = { id, proc, cwd, title, status: 'starting', sessionId: forkSession ? null : resumeId || null, stderr: '', pending: new Set() };
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
    if (msg.type === 'control_response') {
      // An answer to one of our requests; request() may be waiting for it.
      const waiting = agent.waiting?.get(msg.response?.request_id);
      if (waiting) {
        agent.waiting.delete(msg.response.request_id);
        waiting(msg.response);
      }
      return;
    }
    if (msg.session_id && msg.session_id !== agent.sessionId) {
      agent.sessionId = msg.session_id;
      this.send('agent:session', agent.id, msg.session_id);
    }
    // The mode can change without us asking, for example when Claude leaves
    // plan mode. The CLI reports the new mode in init and status events.
    if (msg.type === 'system' && msg.permissionMode && msg.permissionMode !== agent.mode) {
      agent.mode = msg.permissionMode;
      this.send('agent:mode', agent.id, msg.permissionMode);
    }
    if (msg.type === 'system' && msg.subtype === 'status') return;
    if (msg.type === 'system' && msg.subtype === 'init') {
      this.setStatus(agent, agent.status === 'starting' ? 'idle' : agent.status);
      if (msg.model && msg.model !== agent.model) {
        agent.model = msg.model;
        this.send('agent:model', agent.id, msg.model);
      }
    }
    // Late pieces of a message must not hide an open question or approval.
    if ((msg.type === 'assistant' || msg.type === 'stream_event') && !agent.pending.size) this.setStatus(agent, 'working');
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
      response: { subtype: 'error', request_id: msg.request_id, error: `Agent Hub does not handle ${msg.request?.subtype}` },
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

  // Sends a control request and waits for the CLI's answer (null after 10
  // seconds without one, or when the request failed).
  request(id, request) {
    const agent = this.agents.get(id);
    if (!agent) return Promise.resolve(null);
    const requestId = randomUUID();
    agent.waiting = agent.waiting || new Map();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        agent.waiting.delete(requestId);
        resolve(null);
      }, 10000);
      agent.waiting.set(requestId, response => {
        clearTimeout(timer);
        resolve(response.subtype === 'success' ? response.response : null);
      });
      this.writeJson(agent, { type: 'control_request', request_id: requestId, request });
    });
  }

  // How full the context window is: { totalTokens, maxTokens, percentage,
  // categories: [{ name, tokens, kind }] }, the same numbers as /context.
  contextUsage(id) {
    return this.request(id, { subtype: 'get_context_usage' });
  }

  // Changes model, effort and fast mode from the next turn on, the same as the
  // /model, /effort and /fast commands in the terminal.
  setModel(id, { model, effort, fastMode }) {
    this.control(id, { subtype: 'set_model', model: model && model !== 'default' ? model : null });
    this.control(id, { subtype: 'apply_flag_settings', settings: { effortLevel: effort || null, fastMode: !!fastMode } });
  }

  setPermissionMode(id, mode) {
    this.control(id, { subtype: 'set_permission_mode', mode });
  }

  // Asks Claude to stop the current turn but keeps the process alive, the same
  // as pressing Esc in the terminal.
  interrupt(id) {
    const agent = this.agents.get(id);
    if (!agent) return;
    const req = { type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } };
    agent.proc.stdin.write(JSON.stringify(req) + '\n');
  }

  // Stops the claude process and every command it is running.
  killGroup(agent) {
    killTree(agent.proc);
  }

  // Asks the agent to finish (end of input), and stops it after two seconds.
  close(id) {
    const agent = this.agents.get(id);
    if (!agent) return;
    agent.closing = true;
    agent.proc.stdin.end();
    setTimeout(() => { if (agent.proc.exitCode === null) this.killGroup(agent); }, 2000);
  }

  // Agents that are busy right now: working, starting, or waiting for you.
  activeCount() {
    return [...this.agents.values()].filter(a => ['working', 'starting', 'waiting'].includes(a.status)).length;
  }

  // The app is quitting, so there is no time to wait.
  closeAll() {
    for (const agent of this.agents.values()) {
      agent.closing = true;
      this.killGroup(agent);
    }
    for (const proc of helperProcesses) killTree(proc);
  }
}

// Asks the CLI which models this account can use. This is the same list, with
// the same descriptions, that the model menu in the Claude desktop app shows.
// We start a short-lived process, send the "initialize" request and read the
// "models" field of the answer. No API call is made.
const helperProcesses = new Set();   // short-lived claude processes, stopped when the app quits

function fetchModels(config) {
  return new Promise(resolve => {
    const proc = spawnClaude(config.claudePath,
      ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
      { cwd: os.homedir(), env: childEnv(config.env), stdio: ['pipe', 'pipe', 'ignore'] });
    helperProcesses.add(proc);
    let buffer = '';
    const finish = models => {
      clearTimeout(timer);
      helperProcesses.delete(proc);
      killTree(proc);
      resolve(models);
    };
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

// Asks Claude Code (on Haiku, the fastest model) for a short title that
// summarizes a task, at most 5 words. It runs without MCP servers and tools,
// which makes it start faster, and saves no session, so it does not show up
// in History. Resolves with the title, or null.
function summarizeTitle(config, text) {
  return new Promise(resolve => {
    const proc = spawnClaude(config.claudePath,
      ['-p', '--model', 'haiku', '--output-format', 'json', '--strict-mcp-config', '--tools', '', '--no-session-persistence'],
      { cwd: os.tmpdir(), env: childEnv(config.env), stdio: ['pipe', 'pipe', 'ignore'] });
    helperProcesses.add(proc);
    let out = '';
    const timer = setTimeout(() => { killTree(proc); }, 30000);
    proc.stdout.on('data', d => { out += d; });
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      clearTimeout(timer);
      helperProcesses.delete(proc);
      try {
        const result = JSON.parse(out);
        if (result.is_error || typeof result.result !== 'string') return resolve(null);
        // One line, no "Title:" label, no quotes or end punctuation, at most 5 words.
        const title = result.result.split('\n')[0]
          .replace(/^["'`*#\s]+|["'`*.!?\s]+$/g, '')
          .replace(/^title\s*:\s*/i, '')
          .replace(/^["'`*\s]+/, '')
          .split(/\s+/).slice(0, 5).join(' ');
        resolve(title || null);
      } catch {
        resolve(null);
      }
    });
    proc.stdin.end(
      'Summarize this task as a short title of at most 5 words. Reply with only the title, no quotes, no punctuation at the end.\n\n'
      + 'Task: ' + text.slice(0, 2000));
  });
}

// Your plan's usage limits, without an agent: Claude Code reports them (a
// "rate_limit_event") with every reply, so this sends Haiku a one-word
// message, not saved as a session, and keeps only that report. It costs a
// very small amount of usage. Resolves with the rate_limit_info, or null.
function fetchUsage(config) {
  return new Promise(resolve => {
    const proc = spawnClaude(config.claudePath,
      ['-p', '--model', 'haiku', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--tools', '', '--no-session-persistence'],
      { cwd: os.tmpdir(), env: childEnv(config.env), stdio: ['pipe', 'pipe', 'ignore'] });
    helperProcesses.add(proc);
    let buffer = '';
    let info = null;
    const timer = setTimeout(() => { killTree(proc); }, 45000);
    proc.stdout.on('data', d => {
      buffer += d;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'rate_limit_event' && msg.rate_limit_info) info = msg.rate_limit_info;
        } catch { /* not a JSON line */ }
      }
    });
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      clearTimeout(timer);
      helperProcesses.delete(proc);
      resolve(info);
    });
    proc.stdin.end('Reply with only: ok');
  });
}

module.exports = { AgentManager, fetchModels, findClaude, summarizeTitle, fetchUsage };
