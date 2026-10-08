// Draws Claude Code messages into a chat container. Live agents and saved
// transcripts both go through Transcript.add(), because they share one format.

marked.setOptions({ gfm: true, breaks: true });

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function markdown(text) {
  const div = el('div', 'msg-text');
  div.innerHTML = DOMPurify.sanitize(marked.parse(text), { ADD_ATTR: ['target'] });
  for (const a of div.querySelectorAll('a')) a.target = '_blank';
  return div;
}

// The one argument worth showing next to a tool name in the collapsed card.
function toolSummary(name, input = {}) {
  const pick = input.command || input.file_path || input.notebook_path || input.pattern
    || input.url || input.query || input.description || input.prompt || input.skill;
  if (pick) return String(pick).split('\n')[0];
  const first = Object.values(input).find(v => typeof v === 'string');
  return first ? first.split('\n')[0] : '';
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(c => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  }
  return JSON.stringify(content, null, 2);
}

function clip(text, max = 6000) {
  return text.length > max ? text.slice(0, max) + `\n… (${text.length - max} more characters)` : text;
}

const DESTINATION_NAMES = {
  session: 'for this session',
  localSettings: 'in this project (only you)',
  projectSettings: 'in this project (shared)',
  userSettings: 'in all projects',
};

// Describes one suggested permission update, for example
// "Always allow Bash(npm start) in this project (only you)".
function describeSuggestion(s) {
  const where = DESTINATION_NAMES[s.destination] || '';
  if (s.type === 'addRules') {
    const rules = s.rules.map(r => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName)).join(', ');
    return `Always allow ${rules} ${where}`.trim();
  }
  if (s.type === 'addDirectories') return `Allow access to ${s.directories.join(', ')} ${where}`.trim();
  if (s.type === 'setMode') return `Allow, and switch to ${s.mode} mode ${where}`.trim();
  return null;
}

// Tokens of one API call or one whole task. Input, cached context and output
// all count against a subscription's usage limits.
function tokenParts(usage) {
  return {
    input: usage?.input_tokens || 0,
    cacheWrite: usage?.cache_creation_input_tokens || 0,
    cacheRead: usage?.cache_read_input_tokens || 0,
    output: usage?.output_tokens || 0,
  };
}

function totalTokens(usage) {
  const t = tokenParts(usage);
  return t.input + t.cacheWrite + t.cacheRead + t.output;
}

// Adds up the API calls of a task.
function sumUsage(turn) {
  const sum = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
  for (const u of turn.usage.values()) {
    const t = tokenParts(u);
    sum.input_tokens += t.input;
    sum.cache_creation_input_tokens += t.cacheWrite;
    sum.cache_read_input_tokens += t.cacheRead;
    sum.output_tokens += t.output;
  }
  return sum;
}

function formatTokens(n) {
  if (n < 1000) return `${n}`;
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

// Splits the output of `git diff` into one entry per file.
function parseUnifiedDiff(text) {
  const files = [];
  let file = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = { path: '', status: 'mod', lines: [] };
      const m = line.match(/ b\/(.*)$/);
      if (m) file.path = m[1];
      files.push(file);
    } else if (!file) {
      continue;
    } else if (line.startsWith('new file mode')) {
      file.status = 'new';
    } else if (line.startsWith('deleted file mode')) {
      file.status = 'del';
    } else if (line.startsWith('Binary files')) {
      file.status = file.status === 'mod' ? 'bin' : file.status;
      file.lines.push(['hunk', line]);
    } else if (line.startsWith('+++ ')) {
      if (line !== '+++ /dev/null') file.path = line.slice(4).replace(/^b\//, '');
    } else if (line.startsWith('--- ') || line.startsWith('index ') || line.startsWith('similarity') || line.startsWith('rename ')) {
      continue;
    } else if (line.startsWith('@@')) {
      file.lines.push(['hunk', line]);
    } else if (line.startsWith('+')) {
      file.lines.push(['add', line]);
    } else if (line.startsWith('-')) {
      file.lines.push(['del', line]);
    } else if (line.startsWith(' ')) {
      file.lines.push(['ctx', line]);
    }
  }
  return files.filter(f => f.path);
}

// Splits a conversation into turns. A turn starts with your message and ends
// with Claude's final answer. Everything Claude does in between (tool calls,
// thinking, notes to itself) goes into a collapsed "steps" section, and after
// the turn the chat shows only the final answer and a list of changed files.
class Transcript {
  constructor(container, cwd) {
    this.root = el('div', 'messages');
    container.appendChild(this.root);
    this.scroller = container;
    this.cwd = cwd || null;
    this.seen = new Set();          // content blocks already drawn
    this.tools = new Map();         // tool_use id -> { card, name, input }
    this.draft = null;              // text streaming in before the full message arrives
    this.turn = null;               // the turn in progress
  }

  // Keep the view pinned to the bottom only when the person has not scrolled up.
  pinned(change) {
    const atBottom = this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 80;
    change();
    if (atBottom) this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  append(node) {
    this.pinned(() => this.root.appendChild(node));
  }

  // Notes go into the current turn, under its steps, so they stay visible.
  note(text, isError) {
    const node = el('div', isError ? 'note err' : 'note', text);
    if (this.turn) this.pinned(() => this.turn.live.appendChild(node));
    else this.append(node);
  }

  // ---------- turns ----------

  startTurn() {
    this.activity = 'Starting…';
    const turn = {
      startedAt: Date.now(),
      el: el('div', 'turn'),
      steps: el('details', 'steps hidden'),
      summary: el('summary'),
      body: el('div', 'steps-body'),
      live: el('div', 'turn-live'),
      answer: el('div', 'turn-answer'),
      stepCount: 0,
      pendingText: [],      // text written since the last tool call; the last batch is the answer
      changes: new Map(),   // file path -> { path, created, content, hunks }
      usage: new Map(),     // API message id -> its token usage, while the task runs
    };
    turn.summary.append(el('span', 'steps-spinner'), el('span', 'steps-text', 'Working…'));
    turn.steps.append(turn.summary, turn.body);
    turn.el.append(turn.steps, turn.live, turn.answer);
    this.turn = turn;
    this.append(turn.el);
    return turn;
  }

  ensureTurn() {
    return this.turn || this.startTurn();
  }

  addStep(node, activity) {
    const turn = this.ensureTurn();
    turn.steps.classList.remove('hidden');
    this.pinned(() => turn.body.appendChild(node));
    if (activity) {
      turn.summary.querySelector('.steps-text').textContent = activity;
      this.activity = activity;
    }
    this.onUpdate?.();
  }

  // ---------- state for the Hub ----------

  get stepCount() {
    return this.turn ? this.turn.stepCount : this.lastTurn?.stepCount || 0;
  }

  // Tokens of the task in progress, or of the last finished task.
  get tokens() {
    return this.turn ? sumUsage(this.turn) : this.lastTurn?.usage || null;
  }

  get turnStartedAt() {
    return this.turn?.startedAt || null;
  }

  // Ends the turn: the last text Claude wrote becomes the visible answer, the
  // changed files are listed, and the steps line shows a short summary.
  finishTurn(result) {
    const turn = this.turn;
    if (!turn) return;
    this.clearDraft();
    this.turn = null;

    this.pinned(() => {
      // The changed files come first, then Claude's message about them.
      if (turn.changes.size) turn.answer.appendChild(changesCard(this.toolChanges(turn.changes)));
      for (const node of turn.pendingText) turn.answer.appendChild(node);
      if (!turn.pendingText.length && result?.result && !result.is_error) turn.answer.appendChild(markdown(result.result));
    });

    const parts = [`${turn.stepCount} step${turn.stepCount === 1 ? '' : 's'}`];
    if (result?.duration_ms) parts.push(`${(result.duration_ms / 1000).toFixed(1)}s`);
    // The result's usage covers the whole task; without a result (a saved
    // session), add up the API calls.
    const usage = result?.usage || sumUsage(turn);
    if (totalTokens(usage)) parts.push(`${formatTokens(totalTokens(usage))} tokens`);
    turn.summary.querySelector('.steps-text').textContent = parts.join(' · ');
    turn.el.classList.add('done');
    this.lastFinished = turn;
    this.lastTurn = {
      stepCount: turn.stepCount,
      durationMs: result?.duration_ms || Date.now() - turn.startedAt,
      usage,
      changedFiles: turn.changes.size,
    };
    this.activity = result?.is_error ? 'Stopped with an error' : 'Finished';
    this.onUpdate?.();
    if (!turn.stepCount) turn.steps.classList.add('hidden');
    else turn.steps.classList.remove('hidden');

    if (result?.is_error) {
      if (result.api_error_status === 401) {
        this.noteIn(turn, 'Claude Code\'s saved login was rejected. Run `claude auth login` in a terminal, then start the agent again.', true);
      }
      // The CLI often sends the error both as assistant text and as the result.
      const shown = turn.pendingText.some(n => n.textContent.trim() === (result.result || '').trim());
      if (!shown) this.noteIn(turn, result.result || `Turn ended with an error (${result.subtype})`, true);
    } else if (result?.subtype && result.subtype !== 'success') {
      this.noteIn(turn, `Turn ended: ${result.subtype}`);
    }
  }

  noteIn(turn, text, isError) {
    turn.live.appendChild(el('div', isError ? 'note err' : 'note', text));
  }

  // ---------- messages ----------

  add(msg) {
    switch (msg.type) {
      case 'user': return this.addUser(msg.message, msg.tool_use_result);
      case 'assistant': return this.addAssistant(msg.message);
      case 'stream_event': return this.addStreamEvent(msg.event);
      case 'result': return this.finishTurn(msg);
      case 'system':
        if (msg.subtype === 'init') {
          this.addStep(el('div', 'note', `Session ready · ${msg.model} · ${msg.permissionMode} · Claude Code ${msg.claude_code_version || ''}`));
        } else if (msg.subtype === 'api_retry' && msg.attempt === 1) {
          this.note(`API error (${msg.error}), retrying…`, true);
        }
        return;
      case 'app_error': return this.note(msg.message, true);
    }
  }

  addUser(message, toolUseResult) {
    const content = message.content;
    const texts = typeof content === 'string' ? [content]
      : content.filter(b => b.type === 'text').map(b => b.text);
    if (texts.length) {
      // Your message starts a new turn.
      this.finishTurn();
      for (const t of texts) this.append(el('div', 'msg-user', t));
      this.startTurn();
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_result') this.fillTool(block, toolUseResult);
      }
    }
  }

  addAssistant(message) {
    const turn = this.ensureTurn();
    // One API call can arrive as several messages with the same id and usage.
    if (message.usage && message.id) {
      turn.usage.set(message.id, message.usage);
      this.onUpdate?.();
    }
    for (const block of message.content || []) {
      const key = `${message.id}|${block.type}|${block.id || (block.text || block.thinking || '').slice(0, 300)}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);

      if (block.type === 'text' && block.text.trim()) {
        this.clearDraft();
        const node = markdown(block.text);
        turn.pendingText.push(node);
        this.addStep(node, block.text.split('\n')[0].slice(0, 120));
      } else if (block.type === 'thinking' && block.thinking) {
        const d = el('details', 'thinking');
        d.append(el('summary', null, 'Thinking'), el('pre', null, block.thinking));
        this.addStep(d, 'Thinking…');
      } else if (block.type === 'tool_use') {
        this.clearDraft();
        // Text before a tool call was a note to itself, not the answer.
        turn.pendingText = [];
        turn.stepCount++;
        this.addStep(this.toolCard(block), `${block.name} · ${toolSummary(block.name, block.input)}`);
      }
    }
  }

  toolCard(block) {
    const d = el('details', 'tool');
    const summary = el('summary');
    summary.append(
      el('span', 'tool-name', block.name),
      el('span', 'tool-arg', toolSummary(block.name, block.input)),
      el('span', 'tool-state pending', '…'),
    );
    d.append(summary, el('pre', null, clip(JSON.stringify(block.input, null, 2))));
    this.tools.set(block.id, { card: d, name: block.name, input: block.input || {} });
    return d;
  }

  fillTool(block, toolUseResult) {
    const tool = this.tools.get(block.tool_use_id);
    if (!tool) return;
    const state = tool.card.querySelector('.tool-state');
    state.className = 'tool-state ' + (block.is_error ? 'err' : 'ok');
    state.textContent = block.is_error ? 'failed' : 'done';
    const out = el('pre', null, clip(resultText(block.content)));
    if (block.is_error) out.style.color = 'var(--err)';
    tool.card.appendChild(out);
    if (!block.is_error) this.recordChange(tool, toolUseResult);
  }

  // ---------- changed files ----------

  // After Edit and Write, the CLI reports the file path and the changed lines
  // ("structuredPatch"), or the full content for a new file.
  recordChange(tool, result) {
    if (!result || typeof result !== 'object' || !this.turn) return;
    const isNew = result.type === 'create';
    const hunks = Array.isArray(result.structuredPatch) ? result.structuredPatch : [];
    if (!isNew && !hunks.length) return;
    const path = result.filePath || tool.input.file_path;
    if (!path) return;
    const entry = this.turn.changes.get(path) || { path, created: false, content: null, hunks: [] };
    if (isNew) {
      entry.created = true;
      entry.content = result.content || '';
    }
    entry.hunks.push(...hunks);
    this.turn.changes.set(path, entry);
  }

  relativePath(p) {
    if (this.cwd && (p.startsWith(this.cwd + '/') || p.startsWith(this.cwd + '\\'))) return p.slice(this.cwd.length + 1);
    return p;
  }

  // Turns the Edit/Write reports into the same shape as a parsed git diff:
  // [{ path, status: 'new' | 'mod' | 'del', lines: [[kind, text]] }].
  toolChanges(changes) {
    return [...changes.values()].map(f => {
      const lines = [];
      if (f.created) {
        for (const line of (f.content || '').replace(/\n$/, '').split('\n')) lines.push(['add', '+' + line]);
      }
      for (const h of f.hunks) {
        lines.push(['hunk', `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`]);
        for (const line of h.lines) lines.push([line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx', line]);
      }
      return { path: this.relativePath(f.path), status: f.created ? 'new' : 'mod', lines };
    });
  }

  // Replaces the turn's Changes card with the snapshot comparison, which also
  // includes files changed by shell commands. A folder snapshot records only
  // code files, so with merge=true the Edit/Write reports for other files
  // (for example a .prefab) are kept.
  showGitChanges(turn, diffText, merge) {
    if (!turn || diffText == null) return;
    const files = parseUnifiedDiff(diffText);
    if (merge) {
      const seen = new Set(files.map(f => f.path));
      for (const f of this.toolChanges(turn.changes)) if (!seen.has(f.path)) files.push(f);
    }
    this.pinned(() => {
      turn.el.querySelector('.changes')?.remove();
      if (files.length) turn.answer.prepend(changesCard(files));
    });
    if (this.lastFinished === turn && this.lastTurn) {
      this.lastTurn.changedFiles = files.length;
      this.onUpdate?.();
    }
  }

  // ---------- permission prompts ----------

  // A card that asks you to allow or deny one tool call. decide(decision)
  // sends the answer to the agent. It stays visible outside the steps.
  permission(req, decide) {
    const card = el('div', 'permission');
    const head = el('div', 'perm-head');
    head.append(el('span', 'perm-icon', '⚠'), el('span', null, req.title || `Claude wants to use ${req.display_name || req.tool_name}`));
    card.appendChild(head);
    if (req.description) card.appendChild(el('div', 'perm-desc', req.description));

    const input = req.input || {};
    const main = input.command || input.file_path || input.url || input.pattern;
    card.appendChild(el('pre', 'perm-input', clip(main ? String(main) : JSON.stringify(input, null, 2), 3000)));
    if (req.decision_reason) card.appendChild(el('div', 'perm-desc', req.decision_reason));
    if (req.blocked_path) card.appendChild(el('div', 'perm-desc', `Path: ${req.blocked_path}`));

    const buttons = el('div', 'perm-buttons');
    const finish = (decision, label) => {
      decide(decision);
      buttons.replaceWith(el('div', 'perm-result ' + (decision.behavior === 'allow' ? 'ok' : 'err'), label));
      card.classList.add('answered');
    };

    const allow = el('button', 'primary', 'Allow once');
    allow.onclick = () => finish({ behavior: 'allow', updatedInput: input }, 'Allowed');
    buttons.appendChild(allow);

    for (const s of req.permission_suggestions || []) {
      const label = describeSuggestion(s);
      if (!label) continue;
      const b = el('button', null, label);
      b.onclick = () => finish({ behavior: 'allow', updatedInput: input, updatedPermissions: [s] }, label);
      buttons.appendChild(b);
    }

    const deny = el('button', 'danger', 'Deny');
    deny.onclick = () => finish({ behavior: 'deny', message: 'The user denied this action.' }, 'Denied');
    buttons.appendChild(deny);

    card.appendChild(buttons);
    card.dataset.requestId = req.requestId;
    const turn = this.ensureTurn();
    this.pinned(() => turn.live.appendChild(card));
    this.scroller.scrollTop = this.scroller.scrollHeight;
    return card;
  }

  // A question from Claude (the AskUserQuestion tool), drawn like in the
  // Claude desktop app: each question with its options as clickable cards,
  // plus a field for your own answer. decide(decision) sends the answers.
  // The returned card has answerWith(text), used when you type the answer in
  // the message box instead.
  question(req, decide) {
    const input = req.input || {};
    const questions = input.questions || [];
    const chosen = questions.map(() => new Set());   // selected option labels per question
    const own = questions.map(() => '');             // typed answer per question

    const card = el('div', 'permission question-card');
    card.dataset.requestId = req.requestId;
    const head = el('div', 'perm-head');
    head.append(el('span', 'question-icon', '?'), el('span', null, questions.length > 1 ? 'Claude has some questions' : 'Claude has a question'));
    card.appendChild(head);

    const answers = () => {
      const out = {};
      questions.forEach((q, i) => {
        const parts = [...chosen[i]];
        if (own[i].trim()) parts.push(own[i].trim());
        if (parts.length) out[q.question] = parts.join(', ');
      });
      return out;
    };
    const complete = () => Object.keys(answers()).length === questions.length;

    const footer = el('div', 'perm-buttons');
    const submit = el('button', 'primary', 'Answer');
    const skip = el('button', null, 'Skip');
    footer.append(submit, skip);

    let done = false;
    const finish = (decision, label) => {
      if (done) return;
      done = true;
      decide(decision);
      card.classList.add('answered');
      for (const b of card.querySelectorAll('button, input')) b.disabled = true;
      footer.replaceWith(el('div', 'perm-result ' + (decision.behavior === 'allow' ? 'ok' : 'err'), label));
    };
    const send = () => {
      if (!complete()) return;
      const a = answers();
      finish({ behavior: 'allow', updatedInput: { ...input, answers: a } }, Object.values(a).join(' · '));
    };
    submit.onclick = send;
    skip.onclick = () => finish({ behavior: 'deny', message: 'The user chose not to answer these questions.' }, 'Skipped');
    const refresh = () => { submit.disabled = !complete(); };

    // One question with one answer: a click on an option sends it right away.
    const instant = questions.length === 1 && !questions[0].multiSelect;

    questions.forEach((q, i) => {
      const block = el('div', 'question');
      const title = el('div', 'question-title');
      if (q.header) title.appendChild(el('span', 'question-chip', q.header));
      title.appendChild(el('span', null, q.question));
      block.appendChild(title);
      if (q.multiSelect) block.appendChild(el('div', 'question-hint', 'Pick one or more'));

      const list = el('div', 'question-options');
      const buttons = [];
      (q.options || []).forEach((o, n) => {
        const b = el('button', 'question-option');
        b.type = 'button';
        const text = el('span', 'question-option-text');
        text.append(el('span', 'question-option-label', o.label));
        if (o.description) text.append(el('span', 'question-option-desc', o.description));
        b.append(el('span', 'question-key', String(n + 1)), text);
        b.onclick = () => {
          if (q.multiSelect) {
            chosen[i].has(o.label) ? chosen[i].delete(o.label) : chosen[i].add(o.label);
          } else {
            chosen[i] = new Set([o.label]);
            own[i] = '';
            other.value = '';
          }
          for (const [k, btn] of buttons.entries()) btn.classList.toggle('selected', chosen[i].has(q.options[k].label));
          refresh();
          if (instant) send();
        };
        buttons.push(b);
        list.appendChild(b);
      });
      block.appendChild(list);

      const other = document.createElement('input');
      other.className = 'question-other';
      other.placeholder = 'Or type your own answer…';
      other.oninput = () => {
        own[i] = other.value;
        if (!q.multiSelect && other.value.trim()) {
          chosen[i].clear();
          for (const btn of buttons) btn.classList.remove('selected');
        }
        refresh();
      };
      other.onkeydown = e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          send();
        }
      };
      block.appendChild(other);
      card.appendChild(block);
    });

    card.appendChild(footer);
    refresh();

    // A typed answer from the message box answers the first unanswered question.
    card.answerWith = text => {
      const i = Math.max(0, questions.findIndex((_, k) => !chosen[k].size && !own[k].trim()));
      own[i] = text;
      const field = card.querySelectorAll('.question-other')[i];
      if (field) field.value = text;
      refresh();
      send();
    };

    const turn = this.ensureTurn();
    this.pinned(() => turn.live.appendChild(card));
    this.scroller.scrollTop = this.scroller.scrollHeight;
    return card;
  }

  cancelPermission(requestId) {
    const card = this.root.querySelector(`.permission[data-request-id="${CSS.escape(requestId)}"]`);
    const buttons = card?.querySelector('.perm-buttons');
    if (buttons) {
      buttons.replaceWith(el('div', 'perm-result', 'Cancelled'));
      card.classList.add('answered');
    }
  }

  // ---------- streaming text ----------

  // Partial messages: show text as it arrives, under the steps, then swap it
  // for the rendered Markdown when the complete message comes in.
  addStreamEvent(event) {
    if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      const turn = this.ensureTurn();
      if (!this.draft) {
        this.draft = el('div', 'msg-draft');
        turn.live.appendChild(this.draft);
      }
      this.pinned(() => { this.draft.textContent += event.delta.text; });
    }
  }

  clearDraft() {
    if (this.draft) this.draft.remove();
    this.draft = null;
  }
}

window.Transcript = Transcript;
window.totalTokens = totalTokens;
window.formatTokens = formatTokens;
window.tokenParts = tokenParts;
window.el = el;
