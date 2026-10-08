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

class Transcript {
  constructor(container) {
    this.root = el('div', 'messages');
    container.appendChild(this.root);
    this.scroller = container;
    this.seen = new Set();          // content blocks already drawn
    this.tools = new Map();         // tool_use id -> card element
    this.draft = null;              // text streaming in before the full message arrives
  }

  // Keep the view pinned to the bottom only when the person has not scrolled up.
  append(node) {
    const atBottom = this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 80;
    this.root.appendChild(node);
    if (atBottom) this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  note(text, isError) {
    this.append(el('div', isError ? 'note err' : 'note', text));
  }

  add(msg) {
    switch (msg.type) {
      case 'user': return this.addUser(msg.message);
      case 'assistant': return this.addAssistant(msg.message);
      case 'stream_event': return this.addStreamEvent(msg.event);
      case 'result': return this.addResult(msg);
      case 'system':
        if (msg.subtype === 'init') this.note(`Session ready · ${msg.model} · ${msg.permissionMode}`);
        else if (msg.subtype === 'api_retry' && msg.attempt === 1) this.note(`API error (${msg.error}), retrying…`, true);
        return;
      case 'app_error': return this.note(msg.message, true);
    }
  }

  addUser(message) {
    const content = message.content;
    if (typeof content === 'string') return this.append(el('div', 'msg-user', content));
    for (const block of content) {
      if (block.type === 'text') this.append(el('div', 'msg-user', block.text));
      else if (block.type === 'tool_result') this.fillTool(block);
    }
  }

  addAssistant(message) {
    for (const block of message.content || []) {
      const key = `${message.id}|${block.type}|${block.id || (block.text || block.thinking || '').slice(0, 300)}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);

      if (block.type === 'text' && block.text.trim()) {
        this.clearDraft();
        this.lastText = block.text;
        this.append(markdown(block.text));
      } else if (block.type === 'thinking' && block.thinking) {
        const d = el('details', 'thinking');
        d.append(el('summary', null, 'Thinking'), el('pre', null, block.thinking));
        this.append(d);
      } else if (block.type === 'tool_use') {
        this.clearDraft();
        this.append(this.toolCard(block));
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
    this.tools.set(block.id, d);
    return d;
  }

  fillTool(block) {
    const card = this.tools.get(block.tool_use_id);
    if (!card) return;
    const state = card.querySelector('.tool-state');
    state.className = 'tool-state ' + (block.is_error ? 'err' : 'ok');
    state.textContent = block.is_error ? 'failed' : 'done';
    const out = el('pre', null, clip(resultText(block.content)));
    if (block.is_error) out.style.color = 'var(--err)';
    card.appendChild(out);
  }

  // Partial messages: show text as it arrives, then swap it for the final
  // rendered Markdown when the complete assistant message comes in.
  addStreamEvent(event) {
    if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      if (!this.draft) {
        this.draft = el('div', 'msg-draft');
        this.append(this.draft);
      }
      this.draft.textContent += event.delta.text;
      this.scroller.scrollTop = this.scroller.scrollHeight;
    }
  }

  clearDraft() {
    if (this.draft) this.draft.remove();
    this.draft = null;
  }

  addResult(msg) {
    this.clearDraft();
    if (msg.is_error) {
      // The CLI often sends the error both as assistant text and as the result.
      if (msg.result && msg.result === this.lastText) return;
      this.note(msg.result || `Turn ended with an error (${msg.subtype})`, true);
      return;
    }
    const parts = [];
    if (msg.duration_ms) parts.push(`${(msg.duration_ms / 1000).toFixed(1)}s`);
    if (msg.num_turns) parts.push(`${msg.num_turns} turn${msg.num_turns === 1 ? '' : 's'}`);
    if (msg.total_cost_usd) parts.push(`$${msg.total_cost_usd.toFixed(3)}`);
    if (msg.subtype && msg.subtype !== 'success') parts.push(msg.subtype);
    this.note(parts.join(' · '));
  }
}

window.Transcript = Transcript;
window.el = el;
