// The review peer in the whole-window class diagram (umlview.js): a Claude
// Code process you ask questions about the diff the diagram shows, like a
// colleague reviewing it with you. It gets the diff with the first question,
// and it can read the project (Read, Grep and Glob only: it cannot change
// files or run commands). One process per conversation, kept running for the
// follow-up questions; it saves no session, so it does not show up in
// History. Its events go to the window as review:event (id, event):
//   { type: 'text', text }      more of the answer, as it is written
//   { type: 'tool', name, input } it reads or searches something
//   { type: 'done', error? }    the answer is finished
//   { type: 'exit', error? }    the process stopped

const { spawnClaude, killTree, childEnv } = require('./platform');

const TOOLS = 'Read,Grep,Glob';
const PROMPT = [
  'You are a senior engineer reviewing a code change together with the user, in Agent Hub (a desktop app for coding agents).',
  'The user sees the change as a class diagram with the diffs of the changed types.',
  'Your first message contains the diff. You can read and search the project to check how the changed code is used,',
  'but you cannot change files or run commands: point at what to change instead, with the file and line.',
  'Answer the question that was asked, directly and concretely. When you review, look for bugs, missed cases,',
  'unclear naming and design problems, and say how sure you are. Keep answers short unless the user asks for depth.',
].join(' ');

// Diffs longer than this are cut; the reviewer reads the rest of the files itself.
const MAX_DIFF = 150000;

class ReviewPeer {
  constructor({ send, getConfig }) {
    this.send = send;
    this.getConfig = getConfig;
    this.chats = new Map();   // id -> { proc, busy }
  }

  // Sends a question. The first question of a conversation starts the
  // process and carries the diff (files: [{ path, status, diff }]).
  ask(id, { cwd, question, files = [], model }) {
    let chat = this.chats.get(id);
    let text = String(question || '').trim();
    if (!text) return { ok: false };
    if (!chat) {
      chat = this.start(id, cwd, model);
      if (!chat) return { ok: false, error: 'Could not start Claude Code' };
      text = `${diffContext(files)}\n\nQuestion: ${text}`;
    }
    if (chat.busy) return { ok: false, error: 'Still answering the last question' };
    chat.busy = true;
    chat.proc.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`);
    return { ok: true };
  }

  start(id, cwd, model) {
    const config = this.getConfig();
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--no-session-persistence',
      '--strict-mcp-config',
      '--tools', TOOLS,
      '--allowedTools', TOOLS,
      '--append-system-prompt', PROMPT,
      '--model', model || config.reviewPeerModel || 'opus',
    ];
    let proc;
    try {
      proc = spawnClaude(config.claudePath, args, { cwd, env: childEnv(config.env), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      return null;
    }
    const chat = { proc, busy: false, stderr: '' };
    this.chats.set(id, chat);
    let buffer = '';
    proc.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) this.handleLine(id, chat, line);
      }
    });
    proc.stderr.on('data', chunk => { chat.stderr = (chat.stderr + chunk.toString('utf8')).slice(-2000); });
    proc.on('error', err => this.send('review:event', id, { type: 'exit', error: `Could not start claude: ${err.message}` }));
    proc.on('exit', code => {
      if (this.chats.get(id) !== chat) return;
      this.chats.delete(id);
      this.send('review:event', id, { type: 'exit', error: code && !chat.closing ? chat.stderr.trim().split('\n').pop() || `claude stopped (${code})` : null });
    });
    return chat;
  }

  handleLine(id, chat, line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta' && msg.event.delta?.type === 'text_delta') {
      this.send('review:event', id, { type: 'text', text: msg.event.delta.text });
    } else if (msg.type === 'assistant') {
      for (const block of msg.message?.content || []) {
        if (block.type === 'tool_use') this.send('review:event', id, { type: 'tool', name: block.name, input: block.input || {} });
      }
    } else if (msg.type === 'result') {
      chat.busy = false;
      const stopped = chat.stopped;
      chat.stopped = false;
      this.send('review:event', id, { type: 'done', error: stopped ? 'Stopped' : msg.is_error ? String(msg.result || 'The answer failed') : null });
    }
  }

  // Stops the answer being written (the conversation stays).
  interrupt(id) {
    const chat = this.chats.get(id);
    if (!chat?.busy) return;
    chat.stopped = true;
    chat.proc.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: `stop-${Date.now()}`, request: { subtype: 'interrupt' } })}\n`);
  }

  close(id) {
    const chat = this.chats.get(id);
    if (!chat) return;
    chat.closing = true;
    this.chats.delete(id);
    killTree(chat.proc);
  }

  closeAll() {
    for (const id of [...this.chats.keys()]) this.close(id);
  }
}

// The diff as text for the first message: each file's unified diff, cut at
// MAX_DIFF characters in all (the files left out are still listed).
function diffContext(files) {
  const parts = [];
  let size = 0;
  const left = [];
  for (const f of files) {
    const block = `--- ${f.path} (${f.status === 'new' ? 'new file' : f.status === 'del' ? 'deleted' : 'changed'})\n${f.diff || ''}`;
    if (size + block.length > MAX_DIFF) { left.push(f.path); continue; }
    parts.push(block);
    size += block.length;
  }
  return `The change under review touches ${files.length} file${files.length === 1 ? '' : 's'}. Its diff:\n\n${parts.join('\n\n')}`
    + (left.length ? `\n\nThese files are changed too, but their diffs did not fit here; read them yourself if you need them:\n${left.join('\n')}` : '');
}

module.exports = { ReviewPeer };
