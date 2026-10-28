// Starts and talks to Codex agents (OpenAI's Codex CLI), the second provider
// next to Claude Code.
//
// Each agent is one `codex app-server` process, which speaks JSON-RPC over
// stdin and stdout: we start or resume a thread, start a turn per message,
// and it sends notifications for everything that happens (text, commands,
// file changes, plans, token usage, limits) and requests when it needs your
// approval. The window draws Claude Code's stream-json events, so this file
// turns Codex's notifications into those same events (CodexEvents): the
// chat, the Hub and the Changes card then work the same for both providers.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawnCodex, killTree, childEnv } = require('./platform');
const { SYSTEM_PROMPT, EDIT_PROMPT, compactTokens } = require('./agents');

// Codex edits files with its own patch tool, not Claude Code's Edit.
const CODEX_EDIT_PROMPT = 'To change an existing file, edit the lines that change with apply_patch instead of writing the whole file again from a shell command, so its line endings and encoding stay as they are.';

// Your global Claude Code instructions (~/.claude/CLAUDE.md) also apply to
// Codex agents; a project's CLAUDE.md is read by Codex itself
// (project_doc_fallback_filenames in START_ARGS).
function developerInstructions() {
  let global = '';
  try { global = fs.readFileSync(path.join(os.homedir(), '.claude', 'CLAUDE.md'), 'utf8').trim(); } catch { /* none */ }
  const base = SYSTEM_PROMPT.replace(EDIT_PROMPT, CODEX_EDIT_PROMPT);
  return global ? `${base}\n\nThe user's own instructions for every project (written for Claude Code, they apply to you too):\n\n${global}` : base;
}

const START_ARGS = ['app-server', '-c', 'project_doc_fallback_filenames=["CLAUDE.md"]'];

// Every agent's app-server gets: the size at which Codex compacts the
// conversation (Settings → Agents → Compact the conversation at; "auto"
// leaves it to Codex), and Settings → Advanced → Codex → Extra flags.
function agentArgs(config) {
  const compact = compactTokens(String(config.autoCompact || '').trim().toLowerCase());
  return [
    ...START_ARGS,
    ...(typeof compact === 'number' ? ['-c', `model_auto_compact_token_limit=${compact}`] : []),
    ...(Array.isArray(config.codexExtraArgs) ? config.codexExtraArgs : []),
  ];
}

// The app's permission modes as Codex's approval policy and sandbox.
const MODES = {
  bypassPermissions: { approvalPolicy: 'never', sandbox: 'danger-full-access' },
  auto: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  acceptEdits: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
  default: { approvalPolicy: 'untrusted', sandbox: 'read-only' },
  plan: { approvalPolicy: 'never', sandbox: 'read-only' },
};
const modeOf = mode => MODES[mode === 'manual' ? 'default' : mode] || MODES.bypassPermissions;
const SANDBOX_POLICY = {
  'danger-full-access': { type: 'dangerFullAccess' },
  'workspace-write': { type: 'workspaceWrite', networkAccess: true },
  'read-only': { type: 'readOnly', networkAccess: true },
};
const PLAN_PROMPT = 'You are in plan mode: do not change any file. Explore what you need, then propose a plan for the user to approve.';

// ---------- JSON-RPC ----------

// One app-server process: requests with answers, notifications, and the
// server's own requests (approvals), which wait for respond().
class CodexClient {
  constructor(proc, { onNotification, onRequest, onExit }) {
    this.proc = proc;
    this.nextId = 1;
    this.waiting = new Map();
    let buffer = '';
    proc.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && msg.method) onRequest?.(msg);
        else if (msg.id !== undefined) {
          const w = this.waiting.get(msg.id);
          this.waiting.delete(msg.id);
          if (w) msg.error ? w.reject(new Error(msg.error.message || 'Codex request failed')) : w.resolve(msg.result);
        } else if (msg.method) onNotification?.(msg.method, msg.params || {});
      }
    });
    proc.stdin.on('error', () => {});
    proc.on('exit', code => {
      for (const w of this.waiting.values()) w.reject(new Error('Codex stopped'));
      this.waiting.clear();
      onExit?.(code);
    });
  }

  write(obj) {
    if (this.proc.stdin.writable) this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params, timeoutMs = 0) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      if (timeoutMs) setTimeout(() => { if (this.waiting.delete(id)) reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this.write({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  respond(id, result) {
    this.write({ jsonrpc: '2.0', id, result });
  }

  fail(id, message) {
    this.write({ jsonrpc: '2.0', id, error: { code: -32601, message } });
  }

  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'agent-hub', title: 'Agent Hub', version: '1' } }, 30000);
    this.notify('initialized');
  }
}

function startServer(config, cwd, handlers, args = START_ARGS) {
  const proc = spawnCodex(config.codexPath, args, { cwd, env: childEnv(config.env), stdio: ['pipe', 'pipe', 'pipe'] });
  return new CodexClient(proc, handlers);
}

// ---------- limits ----------

// Codex's usage limits as Claude Code's rate_limit_info, so the Hub shows
// both the same way: the primary window (5 hours) as the session, the
// secondary (a week) as the week. Updates are sparse: each is merged into
// the last full snapshot.
let lastLimits = null;
function mergeLimits(snapshot) {
  if (!snapshot) return lastLimits;
  const merged = { ...(lastLimits || {}) };
  for (const [k, v] of Object.entries(snapshot)) if (v !== null && v !== undefined) merged[k] = v;
  if ('rateLimitReachedType' in snapshot) merged.rateLimitReachedType = snapshot.rateLimitReachedType;
  lastLimits = merged;
  return merged;
}

function limitsInfo(snapshot) {
  if (!snapshot) return null;
  const windowOf = w => (w ? { utilization: Math.max(0, w.usedPercent || 0) / 100, resetsAt: w.resetsAt || null } : null);
  const unifiedWindows = {};
  if (snapshot.primary) unifiedWindows.five_hour = windowOf(snapshot.primary);
  if (snapshot.secondary) unifiedWindows.seven_day = windowOf(snapshot.secondary);
  const full = Object.entries(unifiedWindows).filter(([, w]) => w.utilization >= 1).sort((a, b) => (b[1].resetsAt || 0) - (a[1].resetsAt || 0));
  const rejected = full.length > 0 || !!snapshot.rateLimitReachedType;
  const [type, w] = full[0] || ['five_hour', unifiedWindows.five_hour];
  return { status: rejected ? 'rejected' : 'allowed', rateLimitType: type, resetsAt: w?.resetsAt || null, unifiedWindows };
}

// ---------- Codex items as Claude Code events ----------

// The command Codex ran, without the shell it wraps it in.
function shownCommand(item) {
  const actions = (item.commandActions || []).map(a => a.command).filter(Boolean);
  if (actions.length) return actions.join('\n');
  const wrapped = /^\S*(?:zsh|bash|sh)\s+-l?c\s+(["'])([\s\S]*)\1$/.exec(item.command || '');
  return wrapped ? wrapped[2] : item.command || '';
}

// A unified diff as the hunks Claude Code reports for an Edit.
function hunksOf(diff) {
  const hunks = [];
  let hunk = null;
  for (const line of String(diff || '').split('\n')) {
    const head = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (head) {
      hunk = { oldStart: +head[1], oldLines: head[2] === undefined ? 1 : +head[2], newStart: +head[3], newLines: head[4] === undefined ? 1 : +head[4], lines: [] };
      hunks.push(hunk);
    } else if (hunk && /^[ +-]/.test(line)) {
      hunk.lines.push(line);
    }
  }
  return hunks;
}

// A new file's content: Codex gives it as a diff of added lines, or as is.
function addedContent(diff) {
  const text = String(diff || '');
  if (!/^@@ /m.test(text)) return text;
  return text.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1)).join('\n');
}

function resultText(result) {
  return (result?.content || []).map(c => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
}

const PLAN_STATUS = { pending: 'pending', inProgress: 'in_progress', completed: 'completed' };

// Turns one agent's (or one saved thread's) Codex items into events. Each
// event of a turn carries the turn's id as its uuid: going back to one of
// your messages forks the thread at the turn before it (lastTurnId).
class CodexEvents {
  constructor(threadId) {
    this.threadId = threadId;
    this.turnId = null;
    this.started = new Set();
    this.planCount = 0;
    this.usageCount = 0;
    this.resetTurn();
  }

  resetTurn() {
    this.lastText = '';
    this.usage = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
    this.retried = false;
  }

  assistant(id, content, usage) {
    return { type: 'assistant', uuid: this.turnId || undefined, session_id: this.threadId, message: { id, role: 'assistant', content, ...(usage ? { usage } : {}) } };
  }

  toolUse(id, name, input) {
    return this.assistant(`tool-${id}`, [{ type: 'tool_use', id, name, input }]);
  }

  toolResult(id, content, isError, toolUseResult) {
    return { type: 'user', session_id: this.threadId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: !!isError }] }, ...(toolUseResult ? { tool_use_result: toolUseResult } : {}) };
  }

  // started: true for item/started, false for item/completed. A saved
  // thread only has completed items, so those start their tool card too.
  item(item, started, { user = false } = {}) {
    const first = started || !this.started.has(item.id);
    if (started) this.started.add(item.id);
    else this.started.delete(item.id);
    switch (item.type) {
      case 'userMessage': {
        if (started || !user) return [];
        const text = (item.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
        return text ? [{ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }] : [];
      }
      case 'agentMessage':
        if (started || !item.text) return [];
        this.lastText = item.text;
        return [this.assistant(item.id, [{ type: 'text', text: item.text }])];
      case 'plan':
        if (started || !item.text) return [];
        this.lastText = item.text;
        return [this.assistant(item.id, [{ type: 'text', text: item.text }])];
      case 'reasoning': {
        if (started) return [];
        const text = [...(item.summary || []), ...(item.summary?.length ? [] : item.content || [])].join('\n\n').trim();
        return text ? [this.assistant(item.id, [{ type: 'thinking', thinking: text }])] : [];
      }
      case 'commandExecution': {
        const events = first ? [this.toolUse(item.id, 'Bash', { command: shownCommand(item) })] : [];
        if (!started) {
          const declined = item.status === 'declined';
          const failed = item.status === 'failed' || (item.exitCode != null && item.exitCode !== 0);
          const out = declined ? 'The user declined this command.' : (item.aggregatedOutput || '') + (failed && item.exitCode != null ? `\nExit code ${item.exitCode}` : '');
          events.push(this.toolResult(item.id, out, declined || failed));
        }
        return events;
      }
      case 'fileChange': {
        const changes = item.changes || [];
        const events = [];
        changes.forEach((c, i) => {
          const id = `${item.id}#${i}`;
          const kind = c.kind?.type || 'update';
          if (first) events.push(this.toolUse(id, kind === 'add' ? 'Write' : 'Edit', { file_path: c.path, ...(kind === 'add' ? { content: addedContent(c.diff) } : {}) }));
          if (started) return;
          const ok = item.status === 'completed';
          const result = !ok ? null
            : kind === 'add' ? { type: 'create', filePath: c.path, content: addedContent(c.diff) }
            : { filePath: c.kind?.move_path || c.path, structuredPatch: hunksOf(c.diff) };
          const said = ok ? (kind === 'add' ? `Created ${c.path}` : kind === 'delete' ? `Deleted ${c.path}` : `Updated ${c.path}`)
            : item.status === 'declined' ? 'The user declined this change.' : 'The change failed.';
          events.push(this.toolResult(id, said, !ok, result));
        });
        return events;
      }
      case 'mcpToolCall': {
        const events = first ? [this.toolUse(item.id, `mcp__${item.server}__${item.tool}`, item.arguments || {})] : [];
        if (!started) events.push(this.toolResult(item.id, item.error ? item.error.message : resultText(item.result), !!item.error));
        return events;
      }
      case 'dynamicToolCall': {
        const events = first ? [this.toolUse(item.id, item.tool, item.arguments || {})] : [];
        if (!started) events.push(this.toolResult(item.id, (item.contentItems || []).map(c => c.text || '').join('\n'), item.success === false));
        return events;
      }
      case 'webSearch': {
        const events = first ? [this.toolUse(item.id, 'WebSearch', { query: item.query })] : [];
        if (!started) events.push(this.toolResult(item.id, `Searched: ${item.query}`, false));
        return events;
      }
      case 'imageView': {
        const events = first ? [this.toolUse(item.id, 'Read', { file_path: item.path })] : [];
        if (!started) events.push(this.toolResult(item.id, '', false));
        return events;
      }
      case 'collabAgentToolCall': {
        const events = first ? [this.toolUse(item.id, 'Task', { description: (item.prompt || 'A sub-agent').split('\n')[0].slice(0, 120), prompt: item.prompt || '' })] : [];
        if (!started) events.push(this.toolResult(item.id, '', false));
        return events;
      }
      case 'contextCompaction':
        return started ? [] : [{ type: 'system', subtype: 'compact_boundary', compact_metadata: {} }];
      default:
        return [];
    }
  }

  // Codex's plan for the turn, as the task list (TodoWrite) the chat shows.
  plan(steps) {
    const id = `plan-${this.turnId}-${++this.planCount}`;
    const todos = (steps || []).map(s => ({ content: s.step, activeForm: s.step, status: PLAN_STATUS[s.status] || 'pending' }));
    return [this.toolUse(id, 'TodoWrite', { todos }), this.toolResult(id, 'Plan updated', false)];
  }

  // One model call's tokens, as an answer with usage and nothing to show,
  // so the health bar and the turn's token count see it.
  tokens(last) {
    if (!last) return [];
    const usage = {
      input_tokens: Math.max(0, (last.inputTokens || 0) - (last.cachedInputTokens || 0)),
      cache_creation_input_tokens: last.cacheWriteInputTokens || 0,
      cache_read_input_tokens: last.cachedInputTokens || 0,
      output_tokens: last.outputTokens || 0,
    };
    for (const k of Object.keys(this.usage)) this.usage[k] += usage[k];
    return [this.assistant(`usage-${this.turnId}-${++this.usageCount}`, [], usage)];
  }

  // The end of a turn, as Claude Code's result.
  result(turn) {
    const failed = turn?.status === 'failed';
    const error = turn?.error;
    const limit = error?.codexErrorInfo === 'usageLimitExceeded';
    const event = {
      type: 'result',
      subtype: failed ? 'error_during_execution' : turn?.status === 'interrupted' ? 'interrupted' : 'success',
      is_error: failed,
      result: failed ? error?.message || 'Codex stopped with an error' : this.lastText,
      duration_ms: turn?.durationMs || 0,
      usage: { ...this.usage },
      session_id: this.threadId,
      total_cost_usd: 0,
      ...(limit ? { api_error_status: 429 } : {}),
    };
    this.resetTurn();
    return event;
  }
}

// ---------- agents ----------

class CodexManager {
  constructor({ send, getConfig }) {
    this.send = send;
    this.getConfig = getConfig;
    this.agents = new Map();
  }

  has(id) {
    return this.agents.has(id);
  }

  start({ id: wantedId, cwd, resumeId, forkSession, resumeSessionAt, permissionMode, model, effort, fastMode }) {
    const config = this.getConfig();
    const id = typeof wantedId === 'string' && /^[\w-]{8,64}$/.test(wantedId) && !this.agents.has(wantedId) ? wantedId : randomUUID();
    const agent = {
      id, cwd, status: 'starting', mode: permissionMode || config.defaultPermissionMode,
      model: model && model !== 'default' ? model : null, effort: effort || null, fast: !!fastMode,
      threadId: null, turnId: null, pending: new Map(), events: null, stderr: '', tokenUsage: null,
    };
    this.agents.set(id, agent);
    agent.client = startServer(config, cwd, {
      onNotification: (method, params) => this.handleNotification(agent, method, params),
      onRequest: msg => this.handleRequest(agent, msg),
      onExit: code => {
        this.setStatus(agent, code === 0 || agent.closing ? 'exited' : 'error');
        this.send('agent:exit', id, { code, stderr: agent.stderr });
        this.agents.delete(id);
      },
    }, agentArgs(config));
    agent.client.proc.stderr.on('data', chunk => { agent.stderr = (agent.stderr + chunk.toString('utf8')).slice(-8000); });
    agent.client.proc.on('error', err => {
      this.setStatus(agent, 'error');
      this.send('agent:event', id, { type: 'app_error', message: `Could not start codex: ${err.message}. Install the Codex CLI (brew install codex, or npm install -g @openai/codex), sign in with codex login in a terminal, or set its path in Settings → Providers.` });
    });
    agent.ready = this.open(agent, { resumeId, forkSession, resumeSessionAt }).catch(err => {
      this.setStatus(agent, 'error');
      this.send('agent:event', id, { type: 'app_error', message: `Codex could not start: ${err.message}` });
      throw err;
    });
    agent.ready.catch(() => {});
    return { id };
  }

  async open(agent, { resumeId, forkSession, resumeSessionAt }) {
    await agent.client.initialize();
    const { approvalPolicy, sandbox } = modeOf(agent.mode);
    const model = await resolveModel(this.getConfig(), agent.model).catch(() => '');
    const params = { cwd: agent.cwd, approvalPolicy, sandbox, developerInstructions: developerInstructions(), ...(model ? { model } : {}) };
    let res;
    if (resumeId && (forkSession || resumeSessionAt)) {
      res = await agent.client.request('thread/fork', { ...params, threadId: resumeId, ...(resumeSessionAt ? { lastTurnId: resumeSessionAt } : {}) });
    } else if (resumeId) {
      res = await agent.client.request('thread/resume', { ...params, threadId: resumeId });
    } else {
      res = await agent.client.request('thread/start', params);
    }
    agent.threadId = res.thread.id;
    agent.events = new CodexEvents(agent.threadId);
    if (res.model) this.send('agent:model', agent.id, res.model);
    this.send('agent:session', agent.id, agent.threadId);
    this.send('agent:event', agent.id, {
      type: 'system', subtype: 'init', provider: 'codex', session_id: agent.threadId,
      model: res.model || agent.model || 'codex', permissionMode: agent.mode, codex_version: res.thread?.cliVersion || '',
    });
    if (agent.status === 'starting') this.setStatus(agent, 'idle');
    // The limits as they are now, so the Hub shows them before the first reply.
    agent.client.request('account/rateLimits/read', undefined, 15000)
      .then(r => this.emitLimits(agent, r?.rateLimits)).catch(() => {});
  }

  emit(agent, events) {
    for (const e of events) this.send('agent:event', agent.id, e);
  }

  emitLimits(agent, snapshot) {
    const info = limitsInfo(mergeLimits(snapshot));
    if (info) this.send('agent:event', agent.id, { type: 'rate_limit_event', provider: 'codex', rate_limit_info: info });
  }

  handleNotification(agent, method, p) {
    const ev = agent.events;
    switch (method) {
      case 'turn/started':
        agent.turnId = p.turn?.id || null;
        if (ev) ev.turnId = agent.turnId;
        if (!agent.pending.size) this.setStatus(agent, 'working');
        return;
      case 'item/started':
      case 'item/completed':
        if (!ev) return;
        if (!agent.pending.size) this.setStatus(agent, 'working');
        // The files of a change, for its approval card.
        if (p.item?.type === 'fileChange') (agent.files ||= new Map()).set(p.item.id, (p.item.changes || []).map(c => c.path));
        return this.emit(agent, ev.item(p.item || {}, method === 'item/started'));
      case 'item/agentMessage/delta':
        if (p.delta) this.send('agent:event', agent.id, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: p.delta } } });
        return;
      case 'turn/plan/updated':
        if (ev) this.emit(agent, ev.plan(p.plan));
        return;
      case 'thread/tokenUsage/updated':
        agent.tokenUsage = p.tokenUsage || null;
        if (ev) this.emit(agent, ev.tokens(p.tokenUsage?.last));
        return;
      case 'account/rateLimits/updated':
        return this.emitLimits(agent, p.rateLimits);
      case 'error':
        // A retry is a note once per turn; a final error ends the turn (turn/completed).
        if (p.willRetry && ev && !ev.retried) {
          ev.retried = true;
          this.send('agent:event', agent.id, { type: 'system', subtype: 'api_retry', attempt: 1, error: p.error?.message || 'error' });
        }
        if (p.error?.codexErrorInfo === 'usageLimitExceeded') {
          agent.client.request('account/rateLimits/read', undefined, 15000).then(r => this.emitLimits(agent, r?.rateLimits)).catch(() => {});
        }
        return;
      case 'turn/completed': {
        agent.turnId = null;
        for (const [requestId, req] of agent.pending) {
          if (req.turnId === p.turn?.id) {
            agent.pending.delete(requestId);
            this.send('agent:permissionCancel', agent.id, requestId);
          }
        }
        if (!ev) return;
        const result = ev.result(p.turn);
        this.setStatus(agent, result.is_error ? 'error' : 'idle');
        this.send('agent:event', agent.id, result);
        return;
      }
      case 'serverRequest/resolved': {
        const requestId = String(p.requestId ?? '');
        if (agent.pending.delete(requestId)) {
          this.send('agent:permissionCancel', agent.id, requestId);
          if (!agent.pending.size && agent.status === 'waiting') this.setStatus(agent, 'working');
        }
        return;
      }
      default:
    }
  }

  // Codex asks before it runs a command or changes files that your mode
  // does not already allow, and asks you questions with options. They show
  // as Claude Code's permission requests and AskUserQuestion.
  handleRequest(agent, msg) {
    const p = msg.params || {};
    const requestId = String(msg.id);
    let req;
    if (msg.method === 'item/commandExecution/requestApproval') {
      req = { tool_name: 'Bash', display_name: 'a command', title: 'Codex wants to run a command', input: { command: shownCommand(p), description: p.reason || '' } };
    } else if (msg.method === 'item/fileChange/requestApproval') {
      const files = (agent.files?.get(p.itemId) || []).join(', ');
      req = { tool_name: 'Edit', display_name: 'file changes', title: 'Codex wants to change files', input: { file_path: files || p.grantRoot || '', description: p.reason || '' } };
    } else if (msg.method === 'item/permissions/requestApproval') {
      req = { tool_name: 'Permissions', display_name: 'more permissions', title: 'Codex asks for more permissions', input: { description: p.reason || '', permissions: p.permissions } };
    } else if (msg.method === 'item/tool/requestUserInput') {
      const questions = (p.questions || []).map(q => ({
        question: q.question, header: q.header, multiSelect: false,
        options: (q.options || []).map(o => ({ label: o.label, description: o.description || '' })),
      }));
      req = { tool_name: 'AskUserQuestion', input: { questions }, who: 'Codex' };
      agent.pending.set(requestId, { rpcId: msg.id, kind: 'question', questions: p.questions || [], turnId: p.turnId });
    } else {
      agent.client.fail(msg.id, `Agent Hub does not handle ${msg.method}`);
      return;
    }
    if (!agent.pending.has(requestId)) agent.pending.set(requestId, { rpcId: msg.id, kind: msg.method, permissions: p.permissions, turnId: p.turnId });
    this.setStatus(agent, 'waiting');
    this.send('agent:permission', agent.id, { requestId, subtype: 'can_use_tool', ...req });
  }

  // decision: { behavior: 'allow', updatedInput, updatedPermissions? } or { behavior: 'deny' }.
  respondPermission(id, requestId, decision) {
    const agent = this.agents.get(id);
    const req = agent?.pending.get(requestId);
    if (!req) return;
    agent.pending.delete(requestId);
    const allow = decision?.behavior === 'allow';
    if (req.kind === 'question') {
      const given = decision?.updatedInput?.answers || {};
      const answers = {};
      for (const q of req.questions) {
        const a = given[q.question];
        if (a) answers[q.id] = { answers: String(a).split(', ').filter(Boolean) };
      }
      agent.client.respond(req.rpcId, { answers });
    } else if (req.kind === 'item/permissions/requestApproval') {
      agent.client.respond(req.rpcId, allow ? { permissions: req.permissions, scope: 'turn' } : { permissions: {}, scope: 'turn' });
    } else {
      agent.client.respond(req.rpcId, { decision: allow ? (decision.updatedPermissions?.length ? 'acceptForSession' : 'accept') : 'decline' });
    }
    if (!agent.pending.size) this.setStatus(agent, 'working');
  }

  setStatus(agent, status) {
    if (agent.status === status) return;
    agent.status = status;
    this.send('agent:status', agent.id, status);
  }

  // images: [{ mediaType, data }] (base64).
  async sendMessage(id, text, images = []) {
    const agent = this.agents.get(id);
    if (!agent) throw new Error('Agent is not running');
    this.setStatus(agent, 'working');
    await agent.ready;
    const pictures = (Array.isArray(images) ? images : [])
      .filter(i => /^image\/(png|jpeg|gif|webp)$/.test(i?.mediaType) && typeof i.data === 'string')
      .map(i => ({ type: 'image', url: `data:${i.mediaType};base64,${i.data}` }));
    const said = agent.mode === 'plan' ? `${PLAN_PROMPT}\n\n${text}` : text;
    const input = [...pictures, { type: 'text', text: said, text_elements: [] }];
    // A message while a turn runs joins that turn, as with Claude Code.
    if (agent.turnId) {
      try {
        await agent.client.request('turn/steer', { threadId: agent.threadId, expectedTurnId: agent.turnId, input });
        return;
      } catch { /* the turn ended meanwhile: start a new one */ }
    }
    const { approvalPolicy, sandbox } = modeOf(agent.mode);
    const model = await resolveModel(this.getConfig(), agent.model).catch(() => '');
    // Fast mode: the model's Fast service tier; off, the model's own default.
    const tier = agent.fast ? (await fetchCodexModels(this.getConfig()).catch(() => null))?.find(m => m.value === model)?.fastTier?.id || 'priority' : null;
    try {
      await agent.client.request('turn/start', {
        threadId: agent.threadId, input, approvalPolicy, sandboxPolicy: SANDBOX_POLICY[sandbox],
        ...(model ? { model } : {}), ...(agent.effort ? { effort: agent.effort } : {}), ...(tier ? { serviceTier: tier } : {}),
      });
    } catch (err) {
      this.setStatus(agent, 'error');
      this.send('agent:event', id, { type: 'app_error', message: `Codex could not start the task: ${err.message}` });
    }
  }

  // Model, effort and fast mode apply from the next message on.
  setModel(id, { model, effort, fastMode }) {
    const agent = this.agents.get(id);
    if (!agent) return;
    agent.model = model && model !== 'default' ? model : null;
    agent.effort = effort || null;
    agent.fast = !!fastMode;
  }

  setPermissionMode(id, mode) {
    const agent = this.agents.get(id);
    if (!agent) return;
    agent.mode = mode;
    this.send('agent:mode', id, mode);
  }

  interrupt(id) {
    const agent = this.agents.get(id);
    if (!agent?.turnId) return;
    agent.client.request('turn/interrupt', { threadId: agent.threadId, turnId: agent.turnId }).catch(() => {});
  }

  // How full the context window is, from the last model call's tokens.
  contextUsage(id) {
    const u = this.agents.get(id)?.tokenUsage;
    if (!u?.modelContextWindow) return null;
    const total = u.last?.totalTokens || 0;
    return { totalTokens: total, maxTokens: u.modelContextWindow, percentage: Math.round((total / u.modelContextWindow) * 100), categories: [] };
  }

  close(id) {
    const agent = this.agents.get(id);
    if (!agent) return;
    agent.closing = true;
    agent.client.proc.stdin.end();
    setTimeout(() => { if (agent.client.proc.exitCode === null) killTree(agent.client.proc); }, 2000);
  }

  activeCount() {
    return [...this.agents.values()].filter(a => ['working', 'starting', 'waiting'].includes(a.status)).length;
  }

  closeAll() {
    for (const agent of this.agents.values()) {
      agent.closing = true;
      killTree(agent.client.proc);
    }
    helper?.client.proc && killTree(helper.client.proc);
    helper = null;
  }
}

// ---------- without an agent ----------

// One shared app-server for what needs no agent: the model list, the limits,
// and the saved threads for History. Started when first needed, stopped
// after five idle minutes.
let helper = null;
function helperClient(config) {
  if (!helper) {
    const client = startServer(config, os.homedir(), {
      onNotification: (method, params) => {
        if (method === 'account/rateLimits/updated') mergeLimits(params.rateLimits);
        const ask = asks.get(params.threadId);
        if (!ask) return;
        if (method === 'item/completed' && params.item?.type === 'agentMessage') ask.text = params.item.text;
        if (method === 'turn/completed') ask.done(params.turn?.status === 'completed' ? ask.text : null);
      },
      onExit: () => { if (helper?.client === client) helper = null; },
    });
    client.proc.on('error', () => {});
    client.proc.stderr.on('data', () => {});
    helper = { client, ready: client.initialize() };
  }
  clearTimeout(helper.idle);
  const current = helper;
  current.idle = setTimeout(() => { killTree(current.client.proc); if (helper === current) helper = null; }, 5 * 60 * 1000);
  return current;
}

async function helperRequest(config, method, params, timeoutMs = 20000) {
  const h = helperClient(config);
  await h.ready;
  return h.client.request(method, params, timeoutMs);
}

// Codex's models come in families, like Claude's: Luna (fast, Codex's
// Haiku), Terra (balanced, its Sonnet), Sol (the workhorse, its Opus) and
// Astra (frontier, for exceptions, like Fable). Codex has no alias that
// follows a family's newest version, so the app saves the family ("sol")
// and runs its newest model (resolveModel).
const FAMILIES = ['sol', 'terra', 'luna', 'astra'];
const familyOf = id => FAMILIES.find(f => new RegExp(`(^|[-_.])${f}($|[-_.])`, 'i').test(id)) || null;
const versionOf = id => (/(\d+(?:\.\d+)*)/.exec(id)?.[1] || '0').split('.').map(Number);
const newer = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); return false; };
function newestOf(models, family) {
  const all = models.filter(m => m.family === family);
  return all.length ? all.reduce((best, m) => (newer(versionOf(m.value), versionOf(best.value)) ? m : best)) : null;
}

// The models this account can use, in the shape of Claude Code's list (see
// picker.js), each marked as a Codex model, with its family; the newest of
// each family has latest, and the one for quick tasks (the newest Luna, or
// one that says it is fast) has fast.
let modelsCache = null;
async function fetchCodexModels(config) {
  if (modelsCache) return modelsCache;
  try {
    const res = await helperRequest(config, 'model/list', {});
    const models = (res?.data || []).filter(m => !m.hidden).map(m => ({
      value: m.id, displayName: m.displayName || m.id, description: m.description || '', provider: 'codex',
      isDefault: !!m.isDefault, defaultEffort: m.defaultReasoningEffort || '',
      supportsEffort: !!m.supportedReasoningEfforts?.length,
      supportedEffortLevels: (m.supportedReasoningEfforts || []).map(e => e.reasoningEffort),
      // Codex's fast mode: its "Fast" service tier, faster and for some
      // models at a higher cost against your limits ("increased usage").
      fastTier: (m.serviceTiers || []).find(t => /fast/i.test(t.name) || t.id === 'priority') || null,
      supportsFastMode: (m.serviceTiers || []).some(t => /fast/i.test(t.name) || t.id === 'priority'),
      fastByDefault: !!m.defaultServiceTier && (m.serviceTiers || []).some(t => t.id === m.defaultServiceTier && (/fast/i.test(t.name) || t.id === 'priority')),
    }));
    for (const m of models) m.family = familyOf(m.value);
    for (const f of FAMILIES) { const m = newestOf(models, f); if (m) m.latest = true; }
    const fast = newestOf(models, 'luna') || models.find(m => /\bfast/i.test(m.description));
    if (fast) fast.fast = true;
    if (models.length) modelsCache = models;
    return models;
  } catch {
    return null;
  }
}

// A model choice as the model Codex runs: a family is its newest model;
// Auto or nothing is Codex's own default (the window picks a family for
// Auto before this); a model id stays as it is.
async function resolveModel(config, value) {
  if (!value || value === 'auto' || value === 'default') return '';
  if (!FAMILIES.includes(value)) return value;
  return newestOf((await fetchCodexModels(config)) || [], value)?.value || '';
}

// The model for quick tasks: Settings' pick, else the fast one, and the
// service tier: the Fast one when it costs no more of your limits.
async function codexHelperModel(config) {
  const models = (await fetchCodexModels(config)) || [];
  const id = config.codexHelperModel ? await resolveModel(config, config.codexHelperModel) : models.find(m => m.fast)?.value || '';
  const tier = models.find(m => m.value === id)?.fastTier;
  return { model: id, tier: tier && !/increased usage/i.test(tier.description || '') ? tier.id : null };
}

// A quick task (agents.js) on Codex: a throwaway thread on the shared
// app-server, with a one-line instruction instead of Codex's own (about a
// fifth fewer tokens), and no new process: about as fast as Haiku. At
// medium effort: at low, Luna got more of Auto's ratings wrong than Haiku.
// Resolves with the answer's text, or null.
const asks = new Map();   // thread id -> { text, done }
const QUICK_INSTRUCTIONS = 'You answer short questions about software tasks for a desktop app. Reply exactly in the format asked, with no other text. Do not run commands or change files.';
async function codexAsk(config, prompt, timeoutMs = 60000) {
  const { model, tier } = await codexHelperModel(config);
  const effort = 'medium';
  const res = await helperRequest(config, 'thread/start', {
    ephemeral: true, cwd: os.tmpdir(), sandbox: 'read-only', approvalPolicy: 'never', baseInstructions: QUICK_INSTRUCTIONS, ...(model ? { model } : {}),
  });
  const threadId = res.thread.id;
  return new Promise(resolve => {
    const timer = setTimeout(() => finish(null), timeoutMs);
    const finish = text => { clearTimeout(timer); asks.delete(threadId); resolve(text ?? null); };
    asks.set(threadId, { text: null, done: finish });
    helperRequest(config, 'turn/start', {
      threadId, effort, ...(tier ? { serviceTier: tier } : {}), input: [{ type: 'text', text: prompt, text_elements: [] }],
    }).catch(() => finish(null));
  });
}

// Codex's limits as rate_limit_info, or null. No model call is made.
async function fetchCodexUsage(config) {
  try {
    const res = await helperRequest(config, 'account/rateLimits/read', undefined);
    return limitsInfo(mergeLimits(res?.rateLimits));
  } catch {
    return null;
  }
}

// Codex's saved threads for History, in the shape of sessions.js's list.
// The file is "codex:<thread id>", which loadCodexThread reads.
async function listCodexThreads(config) {
  try {
    const res = await helperRequest(config, 'thread/list', { limit: 200, sortKey: 'updated_at' });
    return (res?.data || []).filter(t => !t.ephemeral && !t.parentThreadId).map(t => ({
      id: t.id, file: `codex:${t.id}`, cwd: t.cwd, provider: 'codex',
      title: (t.name || t.preview || 'Untitled session').split('\n')[0].slice(0, 120),
      updatedAt: (t.updatedAt || t.createdAt || 0) * 1000,
    }));
  } catch {
    return [];
  }
}

// A saved thread as the events of a saved Claude Code session.
async function loadCodexThread(config, threadId) {
  const res = await helperRequest(config, 'thread/read', { threadId, includeTurns: true }, 30000);
  const thread = res?.thread;
  const events = new CodexEvents(threadId);
  const messages = [];
  for (const turn of thread?.turns || []) {
    events.turnId = turn.id;
    for (const item of turn.items || []) messages.push(...events.item(item, false, { user: true }));
    messages.push(events.result(turn));
  }
  return { cwd: thread?.cwd || null, messages };
}

// The apps your ChatGPT account gives Codex (its connectors from
// chatgpt.com), by name. OpenAI's own built-in ones (connector_openai_…)
// are left out: they are always there and need no setup.
async function chatgptApps(config) {
  const installed = (await helperRequest(config, 'app/installed', {}))?.apps || [];
  const own = installed.filter(a => !/^connector_openai_/.test(a.id));
  if (!own.length) return [];
  const read = await helperRequest(config, 'app/read', { appIds: own.map(a => a.id) }).catch(() => null);
  const meta = new Map((read?.apps || []).map(a => [a.id, a]));
  return own.map(a => ({
    id: a.id, name: meta.get(a.id)?.name || a.runtimeName || a.id, description: meta.get(a.id)?.description || '',
    enabled: a.enabled !== false, callable: a.callable !== false, url: meta.get(a.id)?.installUrl || 'https://chatgpt.com/apps',
  }));
}

module.exports = { CodexManager, fetchCodexModels, codexHelperModel, codexAsk, chatgptApps, fetchCodexUsage, listCodexThreads, loadCodexThread };
