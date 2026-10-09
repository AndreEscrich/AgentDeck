// Draws Claude Code messages into a chat container. Live agents and saved
// transcripts both go through Transcript.add(), because they share one format.

marked.setOptions({ gfm: true, breaks: true });

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// ---------- images and videos ----------

const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;

// The address the window loads a file on disk from (see src/media.js).
function mediaUrl(file) {
  return 'media://file/?path=' + encodeURIComponent(file);
}

// A file path from Markdown: absolute, file://, or relative to the agent's folder.
function resolveMediaPath(src, cwd) {
  if (!src || /^(https?:|data:|media:|blob:)/i.test(src)) return null;
  let p = src;
  if (/^file:/i.test(p)) {
    try { p = decodeURIComponent(new URL(p).pathname); } catch { return null; }
  } else {
    try { p = decodeURIComponent(p); } catch { /* keep as written */ }
  }
  if (p.startsWith('/') || /^[a-z]:[\\/]/i.test(p)) return p;
  if (!cwd) return null;
  return cwd.replace(/[\\/]$/, '') + '/' + p.replace(/^\.\//, '');
}

// An attached image at full size; Esc or a click closes it.
function openImageOverlay(src) {
  const box = el('div', 'lightbox');
  const img = document.createElement('img');
  img.src = src;
  box.appendChild(img);
  const close = () => { window.uiSound?.('tickDown'); box.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  box.onclick = close;
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(box);
  window.uiSound?.('tick');
}

// Full size on click; Esc or another click closes it.
function openLightbox(file) {
  const box = el('div', 'lightbox');
  const img = document.createElement('img');
  img.src = mediaUrl(file);
  box.append(img, el('div', 'lightbox-path', file));
  const close = () => { window.uiSound?.('tickDown'); box.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  box.onclick = close;
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(box);
  window.uiSound?.('tick');
}

function mediaElement(file, caption) {
  let node;
  if (VIDEO_EXT.test(file)) {
    node = document.createElement('video');
    node.controls = true;
    node.preload = 'metadata';
    node.src = mediaUrl(file);
  } else {
    node = document.createElement('img');
    node.src = mediaUrl(file);
    node.alt = caption || file.split(/[\\/]/).pop();
    node.title = 'Click to see it at full size';
    node.onclick = () => openLightbox(file);
    node.onerror = () => node.replaceWith(el('div', 'media-missing', `Cannot show ${file.split(/[\\/]/).pop()}`));
  }
  node.classList.add('chat-media');
  node.dataset.path = file;
  return node;
}

// Markdown images with a file path show the file; a video path becomes a player.
// ---------- links and Jira tickets ----------

// Web addresses in plain text (your messages, notes, tool output).
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+/g;

// A Jira ticket link: …/browse/KEY, or a board link with ?selectedIssue=KEY.
function jiraKeyOf(href) {
  let url;
  try { url = new URL(href); } catch { return null; }
  if (!/atlassian\.net$|(^|\.)jira\./i.test(url.hostname)) return null;
  const m = url.pathname.match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)/) || (url.searchParams.get('selectedIssue') || '').match(/^([A-Z][A-Z0-9_]+-\d+)$/);
  return m ? m[1] : null;
}

// Plain text with its web addresses turned into links. Punctuation right
// after an address (a period at the end of a sentence) stays text.
function linkify(text) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of text.matchAll(URL_IN_TEXT)) {
    let url = m[0];
    const trail = url.match(/[.,;:!?)\]]+$/);
    if (trail) url = url.slice(0, -trail[0].length);
    frag.append(text.slice(last, m.index));
    const a = document.createElement('a');
    a.href = url;
    a.textContent = url;
    frag.append(a);
    last = m.index + url.length;
  }
  frag.append(text.slice(last));
  return frag;
}

// A Jira link as a ticket card: Jira icon, key, title and status. The title
// and status come from Jira (see src/jira.js); without them the card shows
// the key alone and still opens the ticket.
function jiraCard(href, key) {
  const a = document.createElement('a');
  a.className = 'jira-card';
  a.href = href;
  a.title = `Open ${key} in Jira`;
  const logo = el('span', 'jira-logo');
  logo.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="#2684ff" d="M15.4 7.4 8.6.6 8 0 2.9 5.1.6 7.4a.8.8 0 0 0 0 1.2l4.7 4.7L8 16l5.1-5.1.1-.1 2.2-2.2a.8.8 0 0 0 0-1.2zM8 10.2 5.8 8 8 5.8 10.2 8z"/></svg>';
  const summary = el('span', 'jira-summary');
  const status = el('span', 'jira-status');
  a.append(logo, el('span', 'jira-key', key), summary, status);
  window.deck?.jiraIssue?.(key).then(issue => {
    if (!issue) return;
    summary.textContent = issue.summary;
    status.textContent = issue.status;
    status.dataset.category = issue.category;
    a.title = `${issue.type ? issue.type + ' ' : ''}${key}: ${issue.summary}\n${issue.status} · open in Jira`;
  }).catch(() => {});
  return a;
}

// Every link opens in your browser; Jira ticket links become ticket cards.
function decorateLinks(root) {
  for (const a of [...root.querySelectorAll('a[href]')]) {
    if (a.closest('.jira-card')) continue;
    const href = a.getAttribute('href');
    if (!/^https?:/i.test(href)) continue;
    a.target = '_blank';
    const key = jiraKeyOf(href);
    if (key) a.replaceWith(jiraCard(href, key));
  }
  return root;
}

// One handler for the whole window: a click on a web link opens it in your
// normal browser (the main process turns window.open into shell.openExternal).
document.addEventListener('click', e => {
  const a = e.target.closest?.('a[href]');
  if (!a || !/^https?:/i.test(a.getAttribute('href'))) return;
  e.preventDefault();
  e.stopPropagation();
  window.open(a.href, '_blank');
}, true);

function markdown(text, cwd) {
  const div = el('div', 'msg-text');
  // Text boxes drawn with ╔═╗ characters become cards (see boxcard.js).
  // Diagrams drawn with │ ├ └ ▼ get a diagram block (also boxcard.js).
  const { text: rest, boxes } = extractBoxes(text);
  div.innerHTML = DOMPurify.sanitize(marked.parse(fenceGraphs(rest)), { ADD_ATTR: ['target'] });
  decorateGraphs(div);
  for (const slot of div.querySelectorAll('[data-boxcard]')) {
    const lines = boxes[Number(slot.dataset.boxcard)];
    try {
      slot.replaceWith(renderBoxCard(lines));
    } catch {
      slot.replaceWith(el('pre', null, lines.join('\n')));
    }
  }
  decorateLinks(div);
  for (const img of div.querySelectorAll('img')) {
    const file = resolveMediaPath(img.getAttribute('src'), cwd);
    if (file) img.replaceWith(mediaElement(file, img.getAttribute('alt')));
  }
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

// Temporary files never count as an agent's work: files in a Temp, tmp or
// .tmp folder (like Unity's Temp/), names with "tmp" or "temp" as a separate
// word (tmp_fix.py, board.temp.cs, not Template.cs), backup and editor
// leftovers (.tmp .temp .bak .orig .rej .swp ~), .DS_Store, and the Unity
// .meta file of any of these.
function isTempFile(p) {
  const parts = String(p).replace(/\\/g, '/').split('/');
  if (parts.slice(0, -1).some(dir => /^\.?(temp|tmp)$/i.test(dir))) return true;
  const name = parts.pop().replace(/\.meta$/i, '');
  if (name === '.DS_Store' || name.endsWith('~')) return true;
  if (/\.(tmp|temp|bak|orig|rej|swp)$/i.test(name)) return true;
  const stem = name.replace(/\.[^.]+$/, '');
  return /(^|[_.\-\s])(tmp|temp)([_.\-\s\d]|$)/i.test(stem);
}

// How long a tool call says it will wait on purpose, in ms: the sleeps in a
// command (sleep 60), and inputs that name a duration (duration, seconds,
// waitSeconds, recordSeconds, delayMs …). Keys ending in "ms" are
// milliseconds, the others seconds. Bash's timeout is a limit, not a wait.
function plannedWaitMs(input) {
  let ms = 0;
  const command = typeof input.command === 'string' ? input.command : '';
  for (const m of command.matchAll(/\bsleep\s+(\d+(?:\.\d+)?)([smh]?)\b/g)) {
    ms += Number(m[1]) * ({ m: 60000, h: 3600000 }[m[2]] || 1000);
  }
  for (const [key, value] of Object.entries(input)) {
    if (key === 'timeout' || typeof value !== 'number' || value <= 0) continue;
    if (!/duration|seconds|secs|wait|record|delay|length/i.test(key)) continue;
    ms += /(ms|millis|milliseconds)$/i.test(key) ? value : value * 1000;
  }
  return ms;
}

// Tools that only look at things; their calls and results never count as the
// agent's work.
const READ_ONLY = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'Skill', 'ToolSearch']);

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
    this.prompts = [];              // your messages: { el, text }, in order
    this.createPromptPin(container);
  }

  // ---------- which message the output on screen answers ----------

  // A bar at the top of the chat with your message for the output on screen,
  // shown once that message has scrolled out of view. Clicking it scrolls back
  // to the message. It has no height of its own, so showing and hiding it does
  // not move the chat.
  createPromptPin(container) {
    this.pin = el('div', 'prompt-pin');
    const bar = el('button', 'prompt-pin-bar');
    bar.type = 'button';
    bar.title = 'Scroll to your message';
    this.pinText = el('span', 'prompt-pin-text');
    bar.append(el('span', 'prompt-pin-label', 'You asked'), this.pinText);
    bar.onclick = () => {
      const target = this.pinTarget?.el;
      if (!target) return;
      const top = this.scroller.scrollTop + target.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top - 12;
      this.scroller.scrollTo({ top, behavior: 'smooth' });
    };
    this.pin.appendChild(bar);
    container.insertBefore(this.pin, this.root);
    let frame = 0;
    container.addEventListener('scroll', () => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; this.updatePromptPin(); });
    }, { passive: true });
  }

  updatePromptPin() {
    const top = this.scroller.getBoundingClientRect().top + 4;
    // The last message that starts above the top edge is the one the output
    // on screen belongs to.
    let index = -1;
    for (let i = 0; i < this.prompts.length; i++) {
      if (this.prompts[i].el.getBoundingClientRect().top < top) index = i;
      else break;
    }
    const current = this.prompts[index];
    const next = this.prompts[index + 1];
    // No bar while that message is still (partly) on screen, or while the
    // next message is right at the top, where the bar would cover it.
    const show = !!current && current.el.getBoundingClientRect().bottom < top
      && !(next && next.el.getBoundingClientRect().top < top + 90);
    this.pin.classList.toggle('show', show);
    if (show && this.pinTarget !== current) {
      this.pinTarget = current;
      this.pinText.textContent = current.text;
      this.pinText.title = current.text;
    }
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
    const node = el('div', isError ? 'note err' : 'note');
    node.appendChild(linkify(String(text)));
    decorateLinks(node);
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
      skills: el('div', 'turn-skills'),
      answer: el('div', 'turn-answer'),
      skillNames: new Set(),
      stepCount: 0,
      pendingText: [],      // text written since the last tool call; the last batch is the answer
      changes: new Map(),   // file path -> { path, created, content, hunks }
      usage: new Map(),     // API message id -> its token usage, while the task runs
    };
    turn.summary.append(el('span', 'steps-spinner'), el('span', 'steps-text', 'Working…'));
    turn.steps.append(turn.summary, turn.body);
    turn.el.append(turn.steps, turn.live, turn.skills, turn.answer);
    this.turn = turn;
    this.append(turn.el);
    return turn;
  }

  ensureTurn() {
    return this.turn || this.startTurn();
  }

  // The skills the agent ran during the task, in a row above its answer.
  // Plugin skills ("plugin:name") show their own name; the full name is in
  // the tooltip.
  addSkill(turn, name) {
    const short = name?.split(':').pop();
    if (!short || turn.skillNames.has(short)) return;
    turn.skillNames.add(short);
    if (!turn.skills.childElementCount) turn.skills.appendChild(el('span', 'skills-label', 'Skills'));
    const chip = el('span', 'skill-chip', short);
    chip.title = name;
    this.pinned(() => turn.skills.appendChild(chip));
  }

  // A message that starts with /name runs that skill. The CLI does not report
  // it, so the name is checked against the skills it listed at the start.
  addSlashSkill(turn, text) {
    const name = String(text || '').trim().match(/^\/([\w:.-]+)/)?.[1];
    if (name && this.skillList?.has(name)) this.addSkill(turn, name);
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
      const toolFiles = this.toolChanges(turn.changes).filter(f => !isTempFile(f.path));
      turn.files = toolFiles;
      if (toolFiles.length) turn.answer.appendChild(changesCard(toolFiles, this.cwd));
      // Then drop files that no longer exist, unless the snapshot comparison
      // (showGitChanges) has replaced this card in the meantime.
      this.pruneMissing(turn).then(removed => {
        if (!removed || turn.gitShown) return;
        this.pinned(() => {
          turn.el.querySelector('.changes')?.remove();
          if (!turn.changes.size) return;
          turn.files = this.toolChanges(turn.changes);
          turn.answer.prepend(changesCard(turn.files, this.cwd));
        });
      }).catch(() => {});
      for (const node of turn.pendingText) turn.answer.appendChild(node);
      if (!turn.pendingText.length && result?.result && !result.is_error) turn.answer.appendChild(markdown(result.result, this.cwd));
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
    // The last answer before each of your messages is where a rewind to that
    // message continues from (see editPrompt).
    if (msg.type === 'assistant' && msg.uuid) this.lastAssistant = { uuid: msg.uuid, session: msg.session_id || null };
    switch (msg.type) {
      case 'user': return this.addUser(msg.message, msg.tool_use_result, msg.isSynthetic || msg.isMeta);
      case 'assistant': return this.addAssistant(msg.message);
      case 'stream_event': return this.addStreamEvent(msg.event);
      case 'result': return this.finishTurn(msg);
      case 'system':
        if (msg.subtype === 'init') {
          if (Array.isArray(msg.skills)) {
            this.skillList = new Set(msg.skills);
            // The task's message may have been a /skill command.
            if (this.turn && this.prompts.length) this.addSlashSkill(this.turn, this.prompts[this.prompts.length - 1].text);
          }
          this.addStep(el('div', 'note', `Session ready · ${msg.model} · ${msg.permissionMode} · Claude Code ${msg.claude_code_version || ''}`));
        } else if (msg.subtype === 'api_retry' && msg.attempt === 1) {
          this.note(`API error (${msg.error}), retrying…`, true);
        }
        return;
      case 'app_error': return this.note(msg.message, true);
    }
  }

  // Text that Claude Code adds by itself (a skill's instructions when the
  // agent runs a skill, notes about attached images) is for the agent, not
  // you: it stays out of the chat and does not start a new turn.
  addUser(message, toolUseResult, synthetic) {
    const content = message.content;
    // A skill you start with /name arrives only as its instructions.
    if (synthetic && this.turn) {
      const text = typeof content === 'string' ? content : content.find(b => b.type === 'text')?.text || '';
      const dir = text.match(/^Base directory for this skill: (.+)/)?.[1];
      if (dir) this.addSkill(this.turn, dir.trim().split(/[\\/]/).pop());
    }
    const texts = synthetic ? []
      : typeof content === 'string' ? [content]
      : content.filter(b => b.type === 'text').map(b => b.text);
    if (texts.length) {
      // Your message starts a new turn.
      this.finishTurn();
      const bubbles = texts.map(t => {
        const b = el('div', 'msg-user');
        b.appendChild(linkify(t));
        return decorateLinks(b);
      });
      // Images you attached show as small pictures in your message.
      const pictures = Array.isArray(content) ? content.filter(b => b.type === 'image' && b.source?.type === 'base64') : [];
      if (pictures.length) {
        const row = el('div', 'msg-images');
        for (const p of pictures) {
          const img = document.createElement('img');
          img.src = `data:${p.source.media_type};base64,${p.source.data}`;
          img.alt = 'Attached image';
          img.onclick = () => openImageOverlay(img.src);
          row.appendChild(img);
        }
        bubbles[bubbles.length - 1].appendChild(row);
      }
      for (const b of bubbles) this.append(b);
      const prompt = { el: bubbles[0], text: texts.join('\n').trim(), after: this.lastAssistant || null };
      this.prompts.push(prompt);
      this.addEditButton(prompt, bubbles[bubbles.length - 1]);
      this.startTurn();
      prompt.turn = this.turn;
      this.addSlashSkill(this.turn, texts.join('\n'));
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_result') this.fillTool(block, toolUseResult);
      }
    }
  }

  // ---------- going back to one of your messages ----------

  // Pointing at one of your messages shows Edit. Editing it and sending
  // continues the conversation from just before that message, with the new
  // text (the app does that, see rewindTo in app.js); what came after it
  // leaves the chat.
  addEditButton(prompt, bubble) {
    const button = el('button', 'msg-edit', 'Edit');
    button.type = 'button';
    button.title = 'Change this message and continue from here';
    button.onclick = e => {
      e.stopPropagation();
      this.editPrompt(prompt);
    };
    // The message itself, hidden while you edit it.
    const body = el('span', 'msg-body');
    body.append(...bubble.childNodes);
    bubble.classList.add('editable');
    bubble.append(body, button);
    prompt.bubble = bubble;
  }

  editPrompt(prompt) {
    const index = this.prompts.indexOf(prompt);
    const bubble = prompt.bubble || prompt.el;
    if (index < 0 || !this.onEditPrompt || bubble.querySelector('.msg-edit-box')) return;
    const box = el('div', 'msg-edit-box');
    const input = document.createElement('textarea');
    input.value = prompt.text;
    input.rows = Math.min(10, Math.max(2, prompt.text.split('\n').length));
    const later = this.prompts.slice(index);
    const files = later.flatMap(p => p.turn?.files || []).filter(f => f.status !== 'bin' && !f.undone);
    const options = el('div', 'msg-edit-options');
    let undo = null;
    if (files.length) {
      const label = el('label', 'msg-edit-undo');
      undo = document.createElement('input');
      undo.type = 'checkbox';
      label.append(undo, document.createTextNode(` Also undo the ${files.length} file change${files.length === 1 ? '' : 's'} made since this message`));
      options.appendChild(label);
    }
    const note = later.length > 1
      ? `The ${later.length - 1} message${later.length === 2 ? '' : 's'} after it, and the answers, leave the chat.`
      : 'Its answer leaves the chat.';
    options.appendChild(el('span', 'msg-edit-note', note));
    const cancel = el('button', null, 'Cancel');
    const send = el('button', 'msg-edit-send', 'Send');
    const buttons = el('div', 'msg-edit-buttons');
    buttons.append(cancel, send);
    box.append(input, options, buttons);
    bubble.classList.add('editing');
    bubble.appendChild(box);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    const close = () => { box.remove(); bubble.classList.remove('editing'); };
    const submit = () => {
      const text = input.value.trim();
      if (!text) return;
      close();
      this.onEditPrompt(index, text, { undoFiles: !!undo?.checked, files });
    };
    cancel.onclick = e => { e.stopPropagation(); close(); };
    send.onclick = e => { e.stopPropagation(); submit(); };
    box.onclick = e => e.stopPropagation();
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    });
  }

  // Removes your message number index, and everything after it, from the chat.
  truncateAt(index) {
    const prompt = this.prompts[index];
    if (!prompt) return;
    this.clearDraft();
    let node = prompt.el;
    while (node) {
      const next = node.nextSibling;
      node.remove();
      node = next;
    }
    this.prompts = this.prompts.slice(0, index);
    this.turn = null;
    this.lastAssistant = prompt.after;
    this.lastFinished = this.prompts[index - 1]?.turn || null;
    this.pin.classList.remove('show');
    this.onUpdate?.();
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
        const node = markdown(block.text, this.cwd);
        turn.pendingText.push(node);
        this.addStep(node, block.text.split('\n')[0].slice(0, 120));
      } else if (block.type === 'thinking' && block.thinking) {
        const d = el('details', 'thinking');
        d.append(el('summary', null, 'Thinking'), el('pre', null, block.thinking));
        this.addStep(d, 'Thinking…');
      } else if (block.type === 'tool_use') {
        if (block.name === 'Skill') this.addSkill(turn, block.input?.skill);
        this.noteEvidence(turn, block);
        this.trackTool(turn, block);
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
    this.turn?.openTools?.delete(block.tool_use_id);
    const tool = this.tools.get(block.tool_use_id);
    if (!tool) return;
    const state = tool.card.querySelector('.tool-state');
    state.className = 'tool-state ' + (block.is_error ? 'err' : 'ok');
    state.textContent = block.is_error ? 'failed' : 'done';
    const out = el('pre');
    out.appendChild(linkify(clip(resultText(block.content))));
    decorateLinks(out);
    if (block.is_error) out.style.color = 'var(--err)';
    tool.card.appendChild(out);
    if (!block.is_error) this.recordChange(tool, toolUseResult);
    // A tool that makes a file on its own (a Unity recorder, a screenshot
    // tool) often only names the file in its result. Shell output is left
    // out: an `ls` there would list other agents' files too.
    if (!block.is_error && this.turn && !READ_ONLY.has(tool.name) && !['Bash', 'PowerShell'].includes(tool.name)) {
      (this.turn.results = this.turn.results || []).push(resultText(block.content).slice(0, 20000));
    }
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
    // Files outside the agent's folder are its own helpers (scripts in /tmp
    // or a scratch folder), not part of the work.
    if (!path || !this.isInside(path)) return;
    const entry = this.turn.changes.get(path) || { path, created: false, content: null, hunks: [] };
    if (isNew) {
      entry.created = true;
      entry.content = result.content || '';
    }
    entry.hunks.push(...hunks);
    this.turn.changes.set(path, entry);
  }

  // What the agent did during the task that can change files: the files it
  // edited or wrote, the commands it ran, the scripts it wrote, and the input
  // of other tools that change things (Unity tools, sub-agents). Read-only
  // tools do not count: reading a file does not change it.
  noteEvidence(turn, block) {
    const SCRIPT = /\.(py|sh|bash|zsh|js|mjs|cjs|ts|rb|pl|ps1|command|bat|cmd)$/i;
    const input = block.input || {};
    turn.touched = turn.touched || new Set();
    turn.evidence = turn.evidence || [];
    const file = input.file_path || input.notebook_path;
    if (file) turn.touched.add(file);
    if (block.name === 'Bash' || block.name === 'PowerShell') turn.evidence.push(String(input.command || ''));
    else if (block.name === 'Write' && SCRIPT.test(file || '')) turn.evidence.push(String(input.content || ''));
    else if (!READ_ONLY.has(block.name) && !['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(block.name)) {
      try { turn.evidence.push(JSON.stringify(input)); } catch { /* not important */ }
    }
  }

  // ---------- stuck agents ----------

  // Remembers which tool calls are still running, and how often the agent
  // has made the same call in a row. Numbers do not count as a difference,
  // so "sleep 5" and "sleep 10" are the same call.
  trackTool(turn, block) {
    const summary = toolSummary(block.name, block.input || {});
    turn.openTools = turn.openTools || new Map();
    turn.openTools.set(block.id, { name: block.name, summary, startedAt: Date.now(), plannedMs: plannedWaitMs(block.input || {}) });
    const key = `${block.name}|${summary.replace(/\d+/g, '#').slice(0, 160)}`;
    if (turn.streak?.key === key) turn.streak.count++;
    else turn.streak = { key, name: block.name, summary, count: 1, since: Date.now() };
  }

  // Whether the task in progress looks stuck: one tool call running for at
  // least longMs, or the same call made repeatCount times in a row over at
  // least repeatMs. Sub-agents are left out: they often run long on purpose.
  // Returns { name, summary, since, count? } or null.
  stuckInfo({ longMs, repeatCount, repeatMs }) {
    const turn = this.turn;
    if (!turn) return null;
    const now = Date.now();
    for (const t of turn.openTools?.values() || []) {
      if (['Task', 'Agent'].includes(t.name)) continue;
      // A call that announced a wait (sleep 60 while recording) only counts
      // as stuck once that wait is over plus the usual limit.
      if (now - t.startedAt >= longMs + (t.plannedMs || 0)) return { name: t.name, summary: t.summary, since: t.startedAt };
    }
    const s = turn.streak;
    if (s && !['Task', 'Agent'].includes(s.name) && s.count >= repeatCount && now - s.since >= repeatMs) {
      return { name: s.name, summary: s.summary, since: s.since, count: s.count };
    }
    return null;
  }

  // True when the agent changed this file (path relative to its folder): it
  // edited or wrote it, or named it in a command, a script or a tool's input.
  agentTouched(turn, rel) {
    const abs = this.cwd ? `${this.cwd.replace(/[\\/]$/, '')}/${rel}` : rel;
    if (turn.touched?.has(abs) || turn.touched?.has(rel)) return true;
    const name = rel.split('/').pop();
    return (turn.evidence || []).some(text => text.includes(rel) || text.includes(name));
  }

  // Like agentTouched, for an image or video found in the folder: the agent
  // named it in a command or a tool's input, or a tool's result named it.
  agentMadeMedia(turn, file) {
    const rel = this.relativePath(file);
    if (turn.touched?.has(file) || this.agentTouched(turn, rel)) return true;
    const name = rel.split(/[\\/]/).pop();
    return (turn.results || []).some(text => text.includes(rel) || text.includes(name));
  }

  isInside(p) {
    if (!this.cwd) return true;
    return p === this.cwd || p.startsWith(this.cwd + '/') || p.startsWith(this.cwd + '\\');
  }

  // Leaves out files the agent created and deleted again during the task:
  // only files that still exist when it is done are part of its work. Resolves
  // true when something was left out.
  async pruneMissing(turn) {
    const paths = [...turn.changes.keys()];
    if (!paths.length || !window.deck?.existingFiles) return false;
    const existing = new Set(await window.deck.existingFiles(paths));
    let removed = false;
    for (const p of paths) {
      if (!existing.has(p)) {
        turn.changes.delete(p);
        removed = true;
      }
    }
    return removed;
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
  async showGitChanges(turn, diffText, merge) {
    if (!turn || diffText == null) return;
    turn.gitShown = true;
    // The snapshot also catches changes you (or other agents) made in the same
    // folder while this agent worked. Only files the agent touched stay.
    const files = parseUnifiedDiff(diffText).filter(f => !isTempFile(f.path) && this.agentTouched(turn, f.path));
    if (merge) {
      await this.pruneMissing(turn).catch(() => {});
      const seen = new Set(files.map(f => f.path));
      for (const f of this.toolChanges(turn.changes)) if (!seen.has(f.path) && !isTempFile(f.path)) files.push(f);
    }
    turn.files = files;
    this.pinned(() => {
      turn.el.querySelector('.changes')?.remove();
      if (files.length) turn.answer.prepend(changesCard(files, this.cwd));
    });
    if (this.lastFinished === turn && this.lastTurn) {
      this.lastTurn.changedFiles = files.length;
      this.onUpdate?.();
    }
  }

  // ---------- new images and videos ----------

  // Images and videos that appeared or changed in the agent's folder during
  // the task, in a card next to the code changes. Files the agent already
  // showed in its message are left out.
  showMedia(turn, files) {
    if (!turn || !files?.length) return;
    const shown = new Set([...turn.el.querySelectorAll('.msg-text .chat-media')].map(n => n.dataset.path));
    // The search finds every new file in the folder, also those other agents
    // (or you) made at the same time. Only files this agent made stay.
    files = files.filter(f => !shown.has(f.path) && !isTempFile(f.path) && this.agentMadeMedia(turn, f.path));
    if (!files.length) return;
    const card = el('div', 'media-card');
    const videos = files.filter(f => f.kind === 'video').length;
    const images = files.length - videos;
    const parts = [];
    if (images) parts.push(`${images} new or changed image${images === 1 ? '' : 's'}`);
    if (videos) parts.push(`${videos} video${videos === 1 ? '' : 's'}`);
    card.appendChild(el('div', 'changes-head', parts.join(' · ')));
    const grid = el('div', 'media-grid');
    for (const f of files) {
      const item = el('figure', 'media-item');
      item.append(mediaElement(f.path), el('figcaption', null, this.relativePath(f.path)));
      grid.appendChild(item);
    }
    card.appendChild(grid);
    this.pinned(() => {
      turn.el.querySelector('.media-card')?.remove();
      const changes = turn.answer.querySelector('.changes');
      if (changes) changes.after(card);
      else turn.answer.prepend(card);
    });
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
      window.uiSound?.(decision.behavior === 'allow' ? 'approve' : 'deny');
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
      window.uiSound?.(decision.behavior === 'allow' ? 'approve' : 'deny');
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

    // When every question takes one answer, picking the last missing one sends
    // them all right away, without a click on Answer.
    const instant = questions.every(q => !q.multiSelect);
    const pickers = [];   // per question: pick(labels) marks those options

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
          // The last missing answer sends them all (with its own sound).
          if (instant && complete()) send();
          else window.uiSound?.('select');
        };
        buttons.push(b);
        list.appendChild(b);
      });
      block.appendChild(list);
      pickers[i] = labels => {
        chosen[i] = new Set(labels);
        own[i] = '';
        other.value = '';
        for (const [k, btn] of buttons.entries()) btn.classList.toggle('selected', chosen[i].has(q.options[k].label));
      };

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
          if (pickByNumber(i, other.value)) refresh();
          send();
        }
      };
      block.appendChild(other);
      card.appendChild(block);
    });

    card.appendChild(footer);
    refresh();

    // Typed option numbers ("2", or "1, 3" where more answers are allowed)
    // count as picking those options. Returns false for any other text.
    function pickByNumber(i, text) {
      const q = questions[i];
      const nums = String(text).trim().split(/\s*[,\s]\s*/).filter(Boolean);
      if (!nums.length || !nums.every(n => /^\d+$/.test(n))) return false;
      const labels = nums.map(n => q.options?.[Number(n) - 1]?.label);
      if (labels.some(l => !l) || (!q.multiSelect && labels.length > 1)) return false;
      pickers[i](labels);
      return true;
    }

    // A typed answer from the message box answers the first unanswered
    // question. Once every question has an answer, they are sent.
    card.answerWith = text => {
      const i = Math.max(0, questions.findIndex((_, k) => !chosen[k].size && !own[k].trim()));
      if (!pickByNumber(i, text)) {
        own[i] = text;
        const field = card.querySelectorAll('.question-other')[i];
        if (field) field.value = text;
      }
      refresh();
      // More questions still open: a small click for this answer.
      if (!complete()) window.uiSound?.('select');
      send();
    };
    // Enter in an empty message box sends answers that are complete (after
    // picking several options with the number keys).
    card.sendIfComplete = () => { if (complete()) { send(); return true; } return false; };

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
window.isTempFile = isTempFile;
window.totalTokens = totalTokens;
window.formatTokens = formatTokens;
window.tokenParts = tokenParts;
window.el = el;
