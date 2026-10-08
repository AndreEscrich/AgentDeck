// Window state: which agents are running, which session is on screen, and
// the sidebar. Each agent or opened history session gets its own chat
// container, which stays in the page while you look at others, so switching
// is instant and keeps the scroll position.

const $ = id => document.getElementById(id);

const STATUS_TEXT = {
  starting: 'Starting',
  working: 'Working',
  idle: 'Waiting for you',
  waiting: 'Needs approval',
  error: 'Error',
  exited: 'Stopped',
};

const state = {
  config: {},
  sessions: [],
  agents: new Map(),       // agent id -> { id, title, cwd, status, sessionId, view, transcript, unread }
  history: new Map(),      // session id -> { session, view, transcript } for opened, not-yet-resumed sessions
  current: null,           // { kind: 'agent' | 'history' | 'new', id }
  groups: { groups: [], assignments: {} },  // your session groups, saved in groups.json
  renamingGroup: null,     // id of the group whose name is being edited
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

function defaultMode() {
  return state.config.defaultPermissionMode || 'bypassPermissions';
}

// The permission menu under the message box works the same way as the model
// menu: it changes the agent on screen, or what a history session resumes with.
const composerModePicker = new ModePicker($('composer-mode-picker'), {
  onChange: mode => {
    const cur = state.current;
    if (cur?.kind === 'agent') {
      const a = state.agents.get(cur.id);
      a.mode = mode;
      window.deck.setPermissionMode(a.id, mode);
      a.transcript.note(`Permissions switched to ${composerModePicker.mode.label}.`);
    } else if (cur?.kind === 'history') {
      state.history.get(cur.id).mode = mode;
    }
  },
});
const newModePicker = new ModePicker($('new-mode-picker'), { openUp: false });

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
    composerModePicker.setValue(a.mode || defaultMode());
    $('input').placeholder = 'Message the agent… (↩ to send, ⇧↩ for a new line)';
    $('input').focus();
  } else if (kind === 'history') {
    const h = state.history.get(id);
    h.view.classList.remove('hidden');
    setHeader(h.session.title, h.cwd || h.session.cwd, null);
    composerPicker.setValue(h.choice || defaultChoice());
    composerModePicker.setValue(h.mode || defaultMode());
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
    li.oncontextmenu = e => { e.preventDefault(); sessionMenu(a.sessionId); };
    running.appendChild(li);
  }
  $('running-count').textContent = n ? String(n) : '';
  if (!n) running.appendChild(el('li', 'note', 'No agents running'));

  renderHistory();
}

// ---------- groups ----------

function saveGroups() {
  window.deck.saveGroups(state.groups);
}

function groupOf(sessionId) {
  const gid = state.groups.assignments[sessionId];
  return state.groups.groups.some(g => g.id === gid) ? gid : null;
}

function assignGroup(sessionId, groupId) {
  if (!sessionId) return;
  for (const a of state.agents.values()) if (a.sessionId === sessionId) a.groupId = groupId;
  if (groupId) state.groups.assignments[sessionId] = groupId;
  else delete state.groups.assignments[sessionId];
  saveGroups();
  renderSidebar();
}

function createGroup() {
  const group = { id: crypto.randomUUID(), name: 'New group', collapsed: false };
  state.groups.groups.push(group);
  saveGroups();
  state.renamingGroup = group.id;
  renderSidebar();
  return group;
}

function deleteGroup(groupId) {
  state.groups.groups = state.groups.groups.filter(g => g.id !== groupId);
  for (const [sid, gid] of Object.entries(state.groups.assignments)) {
    if (gid === groupId) delete state.groups.assignments[sid];
  }
  if (state.groups.lastGroupId === groupId) delete state.groups.lastGroupId;
  saveGroups();
  renderSidebar();
  fillGroupSelect();
}

function moveGroup(groupId, delta) {
  const list = state.groups.groups;
  const i = list.findIndex(g => g.id === groupId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  saveGroups();
  renderSidebar();
}

// The menu shown when you right-click a session in History or Running.
async function sessionMenu(sessionId) {
  if (!sessionId) return;
  const current = groupOf(sessionId);
  const items = [
    {
      label: 'Move to group',
      submenu: [
        ...state.groups.groups.map(g => ({ id: 'g:' + g.id, label: g.name, checked: g.id === current })),
        ...(state.groups.groups.length ? [{ type: 'separator' }] : []),
        { id: 'new', label: 'New group…' },
      ],
    },
    { id: 'remove', label: 'Remove from group', enabled: !!current },
  ];
  const picked = await window.deck.popupMenu(items);
  if (!picked) return;
  if (picked === 'remove') assignGroup(sessionId, null);
  else if (picked === 'new') assignGroup(sessionId, createGroup().id);
  else assignGroup(sessionId, picked.slice(2));
}

async function groupMenu(group) {
  const i = state.groups.groups.indexOf(group);
  const picked = await window.deck.popupMenu([
    { id: 'rename', label: 'Rename' },
    { id: 'up', label: 'Move up', enabled: i > 0 },
    { id: 'down', label: 'Move down', enabled: i < state.groups.groups.length - 1 },
    { type: 'separator' },
    { id: 'delete', label: 'Delete group (its sessions become ungrouped)' },
  ]);
  if (picked === 'rename') { state.renamingGroup = group.id; renderSidebar(); }
  if (picked === 'up') moveGroup(group.id, -1);
  if (picked === 'down') moveGroup(group.id, 1);
  if (picked === 'delete') deleteGroup(group.id);
}

// A group header accepts sessions that you drag onto it.
function makeDropTarget(node, groupId) {
  node.addEventListener('dragover', e => {
    if (!e.dataTransfer.types.includes('text/x-session-id')) return;
    e.preventDefault();
    node.classList.add('drop');
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop'));
  node.addEventListener('drop', e => {
    e.preventDefault();
    node.classList.remove('drop');
    assignGroup(e.dataTransfer.getData('text/x-session-id'), groupId);
  });
}

function groupHeader(group, count, collapsed) {
  const head = el('div', 'group-name');
  if (group && state.renamingGroup === group.id) {
    const input = document.createElement('input');
    input.className = 'group-rename';
    input.value = group.name;
    const finish = commit => {
      if (state.renamingGroup !== group.id) return;
      state.renamingGroup = null;
      if (commit && input.value.trim()) group.name = input.value.trim();
      saveGroups();
      renderSidebar();
      fillGroupSelect();
    };
    input.onkeydown = e => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    };
    input.onblur = () => finish(true);
    head.appendChild(input);
    setTimeout(() => { input.focus(); input.select(); });
    return head;
  }
  head.append(el('span', 'group-label', group ? group.name : 'Ungrouped'), el('span', 'group-count', count ? String(count) : ''));
  head.onclick = () => {
    if (group) group.collapsed = !collapsed;
    else state.groups.ungroupedCollapsed = !collapsed;
    saveGroups();
    renderSidebar();
  };
  if (group) {
    head.oncontextmenu = e => { e.preventDefault(); groupMenu(group); };
    head.ondblclick = () => { state.renamingGroup = group.id; renderSidebar(); };
  }
  makeDropTarget(head, group ? group.id : null);
  return head;
}

function historyItem(s) {
  const item = el('div', 'item');
  if (state.current?.kind === 'history' && state.current.id === s.id) item.classList.add('active');
  item.title = `${s.title}\n${s.cwd || ''}`;
  item.append(el('span', 'label', s.title), el('span', 'meta', timeAgo(s.updatedAt)));
  item.onclick = () => openHistory(s);
  item.oncontextmenu = e => { e.preventDefault(); sessionMenu(s.id); };
  item.draggable = true;
  item.ondragstart = e => {
    e.dataTransfer.setData('text/x-session-id', s.id);
    e.dataTransfer.effectAllowed = 'move';
  };
  return item;
}

function renderHistory() {
  // Hide history entries that a running agent has taken over.
  const liveSessions = new Set([...state.agents.values()].map(a => a.sessionId).filter(Boolean));
  const q = $('search').value.trim().toLowerCase();
  const byGroup = new Map(state.groups.groups.map(g => [g.id, []]));
  const ungrouped = [];
  for (const s of state.sessions) {
    if (liveSessions.has(s.id)) continue;
    if (q && !s.title.toLowerCase().includes(q) && !(s.cwd || '').toLowerCase().includes(q)) continue;
    const gid = groupOf(s.id);
    (gid ? byGroup.get(gid) : ungrouped).push(s);
  }

  const list = $('history-list');
  list.innerHTML = '';
  let shown = 0;
  for (const group of state.groups.groups) {
    const sessions = byGroup.get(group.id);
    // While searching, only groups with matches are shown.
    if (q && !sessions.length) continue;
    const collapsed = group.collapsed && !q;
    const g = el('div', 'group' + (collapsed ? ' collapsed' : ''));
    g.appendChild(groupHeader(group, sessions.length, collapsed));
    for (const s of sessions) g.appendChild(historyItem(s));
    if (!sessions.length && !collapsed) g.appendChild(el('div', 'group-empty', 'Drag sessions here'));
    list.appendChild(g);
    shown += sessions.length;
  }

  if (ungrouped.length || !state.groups.groups.length) {
    const collapsed = !!state.groups.ungroupedCollapsed && !q;
    const g = el('div', 'group' + (collapsed ? ' collapsed' : ''));
    // Without any groups yet, the list needs no "Ungrouped" header.
    if (state.groups.groups.length) g.appendChild(groupHeader(null, ungrouped.length, collapsed));
    for (const s of ungrouped) g.appendChild(historyItem(s));
    list.appendChild(g);
    shown += ungrouped.length;
  }
  if (!shown && (q || !state.groups.groups.length)) list.appendChild(el('div', 'note', q ? 'No matches' : 'No saved sessions'));
}

// The Group menu in the New agent form.
function fillGroupSelect() {
  const select = $('new-group');
  const keep = select.value || state.groups.lastGroupId || '';
  select.innerHTML = '';
  select.appendChild(new Option('No group', ''));
  for (const g of state.groups.groups) select.appendChild(new Option(g.name, g.id));
  select.value = state.groups.groups.some(g => g.id === keep) ? keep : '';
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

async function startAgent({ cwd, prompt, permissionMode, choice, resume, groupId }) {
  const title = resume ? resume.session.title : prompt.split('\n')[0].slice(0, 80);
  choice = choice || defaultChoice();
  permissionMode = permissionMode || defaultMode();
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

  const agent = { id, title, cwd, status: 'starting', sessionId: resume?.session.id || null, view, transcript, unread: false, choice, mode: permissionMode,
    // A resumed session stays in its group. A new one goes to the group picked in the form.
    groupId: resume ? groupOf(resume.session.id) : groupId || null };
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
  if ((status === 'idle' || status === 'error' || status === 'waiting') && !viewing) a.unread = true;
  refreshHeaderIfCurrent(id);
  renderSidebar();
});

window.deck.onPermission((id, req) => {
  const a = state.agents.get(id);
  if (!a) return;
  a.transcript.permission(req, decision => window.deck.respondPermission(id, req.requestId, decision));
  window.deck.notify(a.title, req.title || `Needs approval to use ${req.display_name || req.tool_name}`);
});

window.deck.onMode((id, mode) => {
  const a = state.agents.get(id);
  if (!a) return;
  a.mode = mode;
  if (state.current?.kind === 'agent' && state.current.id === id) composerModePicker.setValue(mode);
});

window.deck.onPermissionCancel((id, requestId) => {
  state.agents.get(id)?.transcript.cancelPermission(requestId);
});

window.deck.onSession((id, sessionId) => {
  const a = state.agents.get(id);
  if (!a) return;
  a.sessionId = sessionId;
  // The CLI reports the session id once the session exists. That is when we
  // can save the group, and it also covers a resume that got a new id.
  if (a.groupId && groupOf(sessionId) !== a.groupId) assignGroup(sessionId, a.groupId);
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
  state.history.set(session.id, { session, view: a.view, transcript: a.transcript, cwd: a.cwd, choice: a.choice, mode: a.mode });
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
    await startAgent({ cwd, prompt: text, permissionMode: h.mode, choice: h.choice, resume: h });
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
  const groupId = $('new-group').value || null;
  state.groups.lastGroupId = groupId || undefined;
  saveGroups();
  await startAgent({ cwd, prompt, permissionMode: newModePicker.value, choice: newPicker.value, groupId });
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
$('new-group-btn').onclick = () => createGroup();
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
  newModePicker.setValue(defaultMode());
  newPicker.setValue(defaultChoice());
  loadModels();
  if (state.config.defaultFolder) $('new-cwd').value = state.config.defaultFolder;
  state.groups = { groups: [], assignments: {}, ...(await window.deck.getGroups()) };
  fillGroupSelect();
  await loadSessions();
  show('empty');
})();
