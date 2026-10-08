// Window state: which agents are running, which session is on screen, and
// the sidebar. Each agent or opened history session gets its own chat
// container, which stays in the page while you look at others, so switching
// is instant and keeps the scroll position.

const $ = id => document.getElementById(id);

const STATUS_TEXT = {
  starting: 'Starting',
  working: 'Working',
  idle: 'Waiting for you',
  error: 'Error',
  exited: 'Stopped',
};

const state = {
  config: {},
  sessions: [],
  agents: new Map(),       // agent id -> { id, title, cwd, status, sessionId, view, transcript, unread }
  history: new Map(),      // session id -> { session, view, transcript } for opened, not-yet-resumed sessions
  current: null,           // { kind: 'agent' | 'history' | 'new', id }
  collapsed: new Set(),    // project folders collapsed in the sidebar
};

// ---------- model menu ----------

function defaultChoice() {
  return {
    model: state.config.defaultModel || 'default',
    effort: state.config.defaultEffort || '',
    fastMode: !!state.config.defaultFastMode,
  };
}

// The menu under the message box changes the agent on screen. For a history
// session that is not running yet, it sets what the session resumes with.
const composerPicker = new ModelPicker($('composer-picker'), {
  onChange: choice => {
    const cur = state.current;
    if (cur?.kind === 'agent') {
      const a = state.agents.get(cur.id);
      a.choice = choice;
      window.deck.setModel(a.id, choice);
      a.transcript.note(`Switched to ${composerPicker.button.textContent.replace(' ▾', '')} from the next message on.`);
    } else if (cur?.kind === 'history') {
      state.history.get(cur.id).choice = choice;
    }
  },
});
const newPicker = new ModelPicker($('new-model-picker'), { openUp: false });

// ---------- views ----------

function makeChatView() {
  const view = el('div', 'view chat hidden');
  $('views').appendChild(view);
  return view;
}

function show(kind, id) {
  state.current = { kind, id };
  for (const v of $('views').children) v.classList.add('hidden');

  const isChat = kind === 'agent' || kind === 'history';
  $('composer').classList.toggle('hidden', !isChat);

  if (kind === 'new') {
    $('new-view').classList.remove('hidden');
    setHeader('New agent', '', null);
    $('new-prompt').focus();
  } else if (kind === 'agent') {
    const a = state.agents.get(id);
    a.view.classList.remove('hidden');
    a.unread = false;
    setHeader(a.title, a.cwd, a);
    composerPicker.setValue(a.choice || defaultChoice());
    $('input').placeholder = 'Message the agent… (↩ to send, ⇧↩ for a new line)';
    $('input').focus();
  } else if (kind === 'history') {
    const h = state.history.get(id);
    h.view.classList.remove('hidden');
    setHeader(h.session.title, h.cwd || h.session.cwd, null);
    composerPicker.setValue(h.choice || defaultChoice());
    $('input').placeholder = 'Send a message to continue this session…';
    $('input').focus();
  } else {
    $('empty-view').classList.remove('hidden');
    setHeader('AgentDeck', '', null);
  }
  renderSidebar();
}

function setHeader(title, subtitle, agent) {
  $('view-title').textContent = title;
  $('view-subtitle').textContent = subtitle || '';
  const pill = $('view-status');
  if (agent) {
    pill.classList.remove('hidden');
    pill.innerHTML = '';
    pill.append(el('span', `dot ${agent.status}`), document.createTextNode(STATUS_TEXT[agent.status] || agent.status));
  } else {
    pill.classList.add('hidden');
  }
  $('btn-interrupt').classList.toggle('hidden', !agent || agent.status !== 'working');
  $('btn-close').classList.toggle('hidden', !agent || agent.status === 'exited');
}

function refreshHeaderIfCurrent(agentId) {
  if (state.current?.kind === 'agent' && state.current.id === agentId) {
    const a = state.agents.get(agentId);
    setHeader(a.title, a.cwd, a);
  }
}

// ---------- sidebar ----------

function shortPath(p) {
  if (!p) return 'Unknown folder';
  const parts = p.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

function timeAgo(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return new Date(ms).toLocaleDateString();
}

function renderSidebar() {
  const running = $('running-list');
  running.innerHTML = '';
  let n = 0;
  for (const a of state.agents.values()) {
    n++;
    const li = el('li', 'item');
    if (state.current?.kind === 'agent' && state.current.id === a.id) li.classList.add('active');
    if (a.unread) li.classList.add('unread');
    li.title = `${a.title}\n${a.cwd}\n⌘${n}`;
    li.append(el('span', `dot ${a.status}`), el('span', 'label', a.title), el('span', 'meta', shortPath(a.cwd).split('/').pop()));
    li.onclick = () => show('agent', a.id);
    running.appendChild(li);
  }
  $('running-count').textContent = n ? String(n) : '';
  if (!n) running.appendChild(el('li', 'note', 'No agents running'));

  // Hide history entries that a running agent has taken over.
  const liveSessions = new Set([...state.agents.values()].map(a => a.sessionId).filter(Boolean));
  const q = $('search').value.trim().toLowerCase();
  const groups = new Map();
  for (const s of state.sessions) {
    if (liveSessions.has(s.id)) continue;
    if (q && !s.title.toLowerCase().includes(q) && !(s.cwd || '').toLowerCase().includes(q)) continue;
    const key = s.cwd || 'Unknown folder';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  const list = $('history-list');
  list.innerHTML = '';
  for (const [cwd, sessions] of groups) {
    const g = el('div', 'group');
    if (state.collapsed.has(cwd) && !q) g.classList.add('collapsed');
    const name = el('div', 'group-name', shortPath(cwd));
    name.title = cwd;
    name.onclick = () => {
      state.collapsed.has(cwd) ? state.collapsed.delete(cwd) : state.collapsed.add(cwd);
      g.classList.toggle('collapsed');
    };
    g.appendChild(name);
    for (const s of sessions) {
      const item = el('div', 'item');
      if (state.current?.kind === 'history' && state.current.id === s.id) item.classList.add('active');
      item.title = s.title;
      item.append(el('span', 'label', s.title), el('span', 'meta', timeAgo(s.updatedAt)));
      item.onclick = () => openHistory(s);
      g.appendChild(item);
    }
    list.appendChild(g);
  }
  if (!groups.size) list.appendChild(el('div', 'note', q ? 'No matches' : 'No saved sessions'));
}

async function loadSessions() {
  state.sessions = await window.deck.listSessions();
  renderSidebar();
}

// ---------- history ----------

async function openHistory(session) {
  if (!state.history.has(session.id)) {
    const view = makeChatView();
    const transcript = new Transcript(view);
    const data = await window.deck.loadTranscript(session.file);
    for (const m of data.messages) transcript.add(m);
    transcript.note('End of saved session. Send a message to continue it.');
    state.history.set(session.id, { session, view, transcript, cwd: data.cwd });
    view.scrollTop = view.scrollHeight;
  }
  show('history', session.id);
}

// ---------- agents ----------

async function startAgent({ cwd, prompt, permissionMode, choice, resume }) {
  const title = resume ? resume.session.title : prompt.split('\n')[0].slice(0, 80);
  choice = choice || defaultChoice();
  const { id } = await window.deck.startAgent({
    cwd,
    permissionMode,
    model: choice.model,
    effort: choice.effort,
    fastMode: choice.fastMode,
    resumeId: resume?.session.id,
  });

  // A resumed session keeps its chat container, so its history stays on screen.
  const view = resume ? resume.view : makeChatView();
  const transcript = resume ? resume.transcript : new Transcript(view);
  if (resume) state.history.delete(resume.session.id);

  const agent = { id, title, cwd, status: 'starting', sessionId: resume?.session.id || null, view, transcript, unread: false, choice };
  state.agents.set(id, agent);
  transcript.add({ type: 'user', message: { role: 'user', content: prompt } });
  await window.deck.sendMessage(id, prompt);
  show('agent', id);
}

window.deck.onEvent((id, msg) => {
  const a = state.agents.get(id);
  if (!a) return;
  a.transcript.add(msg);
  if (msg.type === 'result') {
    window.deck.notify(a.title, msg.is_error ? 'Stopped with an error' : 'Finished and waiting for you');
  }
});

window.deck.onStatus((id, status) => {
  const a = state.agents.get(id);
  if (!a) return;
  a.status = status;
  const viewing = state.current?.kind === 'agent' && state.current.id === id;
  if ((status === 'idle' || status === 'error') && !viewing) a.unread = true;
  refreshHeaderIfCurrent(id);
  renderSidebar();
});

window.deck.onSession((id, sessionId) => {
  const a = state.agents.get(id);
  if (a) a.sessionId = sessionId;
});

window.deck.onModel((id, model) => {
  const a = state.agents.get(id);
  if (!a) return;
  a.resolvedModel = model;
  refreshHeaderIfCurrent(id);
});

window.deck.onExit((id, { code, stderr }) => {
  const a = state.agents.get(id);
  if (!a) return;
  if (code !== 0 && stderr.trim()) a.transcript.note(stderr.trim().split('\n').slice(-12).join('\n'), true);
  a.transcript.note(`Agent process ended (exit code ${code}).`);
  a.status = 'exited';
  // Keep the chat open as a history entry, so you can read it and resume it.
  state.agents.delete(id);
  const session = { id: a.sessionId || id, title: a.title, cwd: a.cwd, file: null, updatedAt: Date.now() };
  state.history.set(session.id, { session, view: a.view, transcript: a.transcript, cwd: a.cwd, choice: a.choice });
  if (state.current?.kind === 'agent' && state.current.id === id) show('history', session.id);
  loadSessions();
});

// ---------- input ----------

async function sendFromComposer() {
  const input = $('input');
  const text = input.value.trim();
  if (!text || !state.current) return;
  input.value = '';
  autosize();

  if (state.current.kind === 'agent') {
    const a = state.agents.get(state.current.id);
    a.transcript.add({ type: 'user', message: { role: 'user', content: text } });
    await window.deck.sendMessage(a.id, text);
  } else if (state.current.kind === 'history') {
    const h = state.history.get(state.current.id);
    const cwd = h.cwd || h.session.cwd;
    if (!cwd) {
      h.transcript.note('This session has no saved folder, so it cannot be resumed.', true);
      return;
    }
    await startAgent({ cwd, prompt: text, permissionMode: state.config.defaultPermissionMode, choice: h.choice, resume: h });
  }
}

function autosize() {
  const input = $('input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 240) + 'px';
}

$('input').addEventListener('input', autosize);
$('input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendFromComposer();
  }
});
$('send').onclick = sendFromComposer;

$('new-agent').onclick = () => show('new');
$('pick-folder').onclick = async () => {
  const dir = await window.deck.pickFolder();
  if (dir) $('new-cwd').value = dir;
};
$('new-form').addEventListener('submit', async e => {
  e.preventDefault();
  const cwd = $('new-cwd').value.trim();
  const prompt = $('new-prompt').value.trim();
  if (!cwd || !prompt) return;
  $('new-prompt').value = '';
  await startAgent({ cwd, prompt, permissionMode: $('new-permission').value, choice: newPicker.value });
});
$('new-prompt').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.metaKey) $('new-form').requestSubmit();
});

$('btn-interrupt').onclick = () => {
  if (state.current?.kind === 'agent') window.deck.interrupt(state.current.id);
};
$('btn-close').onclick = () => {
  if (state.current?.kind === 'agent') window.deck.closeAgent(state.current.id);
};
$('search').addEventListener('input', renderSidebar);
$('refresh').onclick = loadSessions;
$('open-settings').onclick = () => window.deck.openConfig();
window.deck.onSessionsChanged(loadSessions);

document.addEventListener('keydown', e => {
  if (e.metaKey && e.key === 'n') { e.preventDefault(); show('new'); }
  if (e.metaKey && /^[1-9]$/.test(e.key)) {
    const a = [...state.agents.values()][Number(e.key) - 1];
    if (a) { e.preventDefault(); show('agent', a.id); }
  }
  if (e.metaKey && e.key === 'f') { e.preventDefault(); $('search').focus(); }
  if (e.key === 'Escape' && state.current?.kind === 'agent') {
    const a = state.agents.get(state.current.id);
    if (a?.status === 'working') window.deck.interrupt(a.id);
  }
});

// Refresh the "5m ago" labels now and then.
setInterval(renderSidebar, 60_000);

(async () => {
  state.config = await window.deck.getConfig();
  $('new-permission').value = state.config.defaultPermissionMode;
  newPicker.setValue(defaultChoice());
  loadModels();
  if (state.config.defaultFolder) $('new-cwd').value = state.config.defaultFolder;
  await loadSessions();
  show('empty');
})();
