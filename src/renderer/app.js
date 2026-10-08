// Window state: which agents are running, which session is on screen, and
// the sidebar. Each agent or opened history session gets its own chat
// container, which stays in the page while you look at others, so switching
// is instant and keeps the scroll position.

const $ = id => document.getElementById(id);

// macOS uses ⌘ for shortcuts and keeps its window buttons at the top left;
// Windows uses Ctrl and keeps them at the top right (see styles.css).
const IS_MAC = window.deck.platform === 'darwin';
document.body.classList.add(`platform-${window.deck.platform}`);
const isMod = e => (IS_MAC ? e.metaKey : e.ctrlKey);
// Paths use / on macOS and \ on Windows.
const SEP = /[\\/]/;

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
  current: null,           // { kind: 'hub' | 'agent' | 'history', id }
  groups: { groups: [], assignments: {} },  // your session groups, saved in groups.json
  renamingGroup: null,     // id of the group whose name is being edited
  parked: new Map(),       // session id -> a completed Hub agent that is not running (kept across restarts)
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
    } else if (cur?.kind === 'hub') {
      ensureDraft().choice = choice;
    }
  },
});

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
    } else if (cur?.kind === 'hub') {
      ensureDraft().mode = mode;
    }
  },
});

// ---------- new agent ----------

// A new agent starts as an empty chat (a "draft"). Its folder, group,
// permissions and model are set with the buttons under the message box, and
// the first message starts it.

function homePath(p) {
  const home = state.config.home;
  return home && p && (p === home || p.startsWith(home + '/') || p.startsWith(home + '\\')) ? '~' + p.slice(home.length) : p;
}

function lastFolder() {
  try {
    const saved = localStorage.getItem('lastFolder');
    if (saved) return saved;
  } catch { /* not important */ }
  return state.config.defaultFolder || recentFolders()[0] || null;
}

// Folders you used lately: running agents first, then saved sessions, newest
// first. Temporary folders (from scratchpads) are left out.
function recentFolders() {
  const list = [];
  const add = f => { if (f && !list.includes(f) && !/\/private\/tmp\/|scratch-workspaces/.test(f)) list.push(f); };
  try { add(localStorage.getItem('lastFolder')); } catch { /* not important */ }
  for (const a of state.agents.values()) add(a.cwd);
  for (const s of state.sessions) add(s.cwd);
  return list.slice(0, 12);
}

function ensureDraft() {
  if (!state.draft) {
    state.draft = {
      folder: lastFolder(),
      groupId: state.groups.lastGroupId || null,
      choice: defaultChoice(),
      mode: defaultMode(),
    };
  }
  if (state.draft.groupId && !state.groups.groups.some(g => g.id === state.draft.groupId)) state.draft.groupId = null;
  return state.draft;
}

function renderDraftButtons() {
  const d = ensureDraft();
  const folder = $('composer-folder');
  folder.textContent = (d.folder ? '📁 ' + shortPath(d.folder) : '📁 Choose folder') + ' ▾';
  folder.title = d.folder ? `Folder: ${d.folder}` : 'Pick the folder the agent works in';
  folder.classList.toggle('danger-text', !d.folder);
  const group = state.groups.groups.find(g => g.id === d.groupId);
  $('composer-group').textContent = (group ? '# ' + group.name : '# No group') + ' ▾';
  $('composer-group').title = 'The group the new session goes into';
}

async function chooseFolder() {
  const d = ensureDraft();
  const folders = recentFolders();
  const items = folders.map(f => ({ id: 'f:' + f, label: homePath(f), checked: f === d.folder }));
  if (items.length) items.push({ type: 'separator' });
  items.push({ id: 'choose', label: 'Choose folder…' });
  const picked = await window.deck.popupMenu(items);
  if (!picked) return;
  if (picked === 'choose') {
    const dir = await window.deck.pickFolder();
    if (!dir) return;
    d.folder = dir;
  } else {
    d.folder = picked.slice(2);
  }
  renderDraftButtons();
  $('input').focus();
}

// The group button opens a panel: type a name to create a group, or pick
// one from the list. The list only shows groups that agents in the Hub use.
function chooseGroup() {
  const d = ensureDraft();
  document.querySelector('.group-panel')?.remove();
  const panel = el('div', 'group-panel');
  const input = document.createElement('input');
  input.placeholder = 'Type a new group, or search…';
  const list = el('div', 'group-panel-list');
  panel.append(input, list);
  $('composer-group').parentNode.appendChild(panel);

  const inUse = new Map();
  for (const item of hubItems()) if (item.groupId) inUse.set(item.groupId, (inUse.get(item.groupId) || 0) + 1);

  const close = () => {
    panel.remove();
    document.removeEventListener('mousedown', outside, true);
  };
  const outside = e => { if (!panel.contains(e.target) && e.target !== $('composer-group')) close(); };
  const pick = groupId => {
    d.groupId = groupId;
    close();
    renderDraftButtons();
    $('input').focus();
  };

  function render() {
    const q = input.value.trim().toLowerCase();
    list.innerHTML = '';
    // Only groups that agents in the Hub use, plus the group picked right
    // now. A group without agents disappears from the list.
    const exactMatch = state.groups.groups.find(g => g.name.toLowerCase() === q);
    const groups = state.groups.groups
      .filter(g => inUse.get(g.id) || g.id === d.groupId || g === exactMatch)
      .filter(g => !q || g.name.toLowerCase().includes(q))
      .sort((a, b) => (inUse.get(b.id) || 0) - (inUse.get(a.id) || 0));
    if (q && !exactMatch) {
      const create = el('div', 'group-panel-item create', `+ Create group "${input.value.trim()}"`);
      create.onclick = () => pick(addGroup(input.value.trim()).id);
      list.appendChild(create);
    }
    if (!q) {
      const none = el('div', 'group-panel-item' + (!d.groupId ? ' selected' : ''));
      none.append(el('span', null, 'No group'));
      none.onclick = () => pick(null);
      list.appendChild(none);
    }
    for (const g of groups) {
      const n = inUse.get(g.id) || 0;
      const row = el('div', 'group-panel-item' + (g.id === d.groupId ? ' selected' : ''));
      row.append(el('span', null, '# ' + g.name), el('span', 'group-panel-count', n ? `${n} agent${n === 1 ? '' : 's'}` : ''));
      row.onclick = () => pick(g.id);
      list.appendChild(row);
    }
  }

  input.oninput = render;
  input.onkeydown = e => {
    if (e.key === 'Escape') { close(); $('input').focus(); }
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = input.value.trim();
      if (!q) return;
      const match = state.groups.groups.find(g => g.name.toLowerCase() === q.toLowerCase());
      pick(match ? match.id : addGroup(q).id);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', outside, true));
  render();
  input.focus();
}

$('composer-folder').onclick = chooseFolder;
$('composer-group').onclick = chooseGroup;

// ---------- views ----------

function makeChatView() {
  const view = el('div', 'view chat hidden');
  $('views').appendChild(view);
  return view;
}

function show(kind, id) {
  state.current = { kind, id };
  $('back-to-hub').classList.toggle('hidden', !['agent', 'history'].includes(kind));
  for (const v of $('views').children) v.classList.add('hidden');

  // The Hub also has the message box: a message there starts a new agent.
  const startsAgent = !['agent', 'history'].includes(kind);
  $('composer').classList.remove('hidden');
  $('composer-folder').classList.toggle('hidden', !startsAgent);
  $('composer-group').classList.toggle('hidden', !startsAgent);

  if (kind === 'agent') {
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
    state.current = { kind: 'hub' };
    $('hub-view').classList.remove('hidden');
    setHeader('Hub', 'All running agents', null);
    const d = ensureDraft();
    composerPicker.setValue(d.choice);
    composerModePicker.setValue(d.mode);
    renderDraftButtons();
    $('input').placeholder = 'Start a new agent… (↩ to start)';
  }
  renderSidebar();
}

// ---------- hub ----------

// From an agent, the view shrinks back into its tile; from anywhere else the
// Hub simply opens.
function backToHub() {
  const cur = state.current;
  show('hub');
  if (cur?.kind === 'agent' && state.agents.has(cur.id)) {
    hub.returnTo(cur.id, state.agents.get(cur.id).view);
  } else if (cur?.kind === 'history' && state.parked.has(cur.id)) {
    hub.returnTo('p:' + cur.id, state.history.get(cur.id)?.view);
  }
}
$('back-to-hub').onclick = backToHub;

const hub = new Hub($('hub-view'), {
  onOpen: async id => {
    if (id.startsWith('p:')) return openParked(id.slice(2));
    show('agent', id);
    return state.agents.get(id)?.view;
  },
  onRemove: removeFromHub,
  onHistory: () => setHistoryOpen(true),
  onSettings: () => window.deck.openConfig(),
  onContext: id => sessionMenu(id.startsWith('p:') ? id.slice(2) : state.agents.get(id)?.sessionId),
});

// Many events can arrive in one frame, so the Hub redraws at most once per frame.
let hubFrame = 0;
function refreshHub() {
  if (hubFrame) return;
  hubFrame = requestAnimationFrame(() => {
    hubFrame = 0;
    const items = hubItems();
    hub.update(items, state.current?.kind === 'agent' ? state.current.id : null, state.groups.groups);
    saveHub();
    const agents = items.filter(a => !a.parked);
    const busy = agents.filter(a => ['working', 'starting', 'waiting'].includes(a.status)).length;
  });
}

setInterval(() => {
  if (state.current?.kind === 'hub') hub.tick(hubItems());
}, 1000);

// ---------- agents kept in the Hub ----------

// What the Hub remembers about an agent. Enough to show its tile and to
// resume its session after a restart.
function hubInfo(a) {
  return {
    sessionId: a.sessionId,
    title: a.title,
    cwd: a.cwd,
    groupId: a.groupId || groupOf(a.sessionId) || null,
    choice: a.choice,
    mode: a.mode,
    lastTurn: a.transcript?.lastTurn ? { durationMs: a.transcript.lastTurn.durationMs, usage: a.transcript.lastTurn.usage } : a.lastTurn || null,
    // Finished while you were not looking, and not opened since.
    unread: !!a.unread,
  };
}

// An agent that is not running, in the shape the Hub expects from a running
// one. It shows as completed (green, with a check mark), the same as an agent
// that has just finished its task.
function parkedItem(p) {
  return {
    id: 'p:' + p.sessionId,
    parked: true,
    status: 'idle',
    title: p.title,
    cwd: p.cwd,
    groupId: groupOf(p.sessionId) || p.groupId,
    unread: !!p.unread,
    transcript: { stepCount: 0, tokens: p.lastTurn?.usage || null, turnStartedAt: null, lastTurn: p.lastTurn },
  };
}

// Running agents first, then the ones that are not running. Agents you removed are left out.
function hubItems() {
  const live = [...state.agents.values()].filter(a => !a.removed);
  for (const a of live) a.groupId = groupOf(a.sessionId) || a.groupId || null;
  const liveSessions = new Set(live.map(a => a.sessionId).filter(Boolean));
  const parked = [...state.parked.values()].filter(p => !liveSessions.has(p.sessionId)).map(parkedItem);
  const items = [...live, ...parked];
  for (const item of items) item.repo = repoName(item.cwd);
  return items;
}

// The Hub has one panel per group and repository. The main process finds the
// repository (the nearest folder with .git or .svn); until it answers, the
// agent's folder name is used.
const repoNames = new Map();   // folder -> repository name
function repoName(cwd) {
  if (!cwd) return '';
  if (!repoNames.has(cwd)) {
    repoNames.set(cwd, shortPath(cwd));
    window.deck.repoOf(cwd).then(r => {
      if (r && r.name !== repoNames.get(cwd)) {
        repoNames.set(cwd, r.name);
        refreshHub();
      }
    }).catch(() => {});
  }
  return repoNames.get(cwd);
}

// Saved in the window's local storage, which survives restarts. Running
// agents are saved too, so after a restart they come back as completed tiles.
function saveHub() {
  const list = [];
  for (const a of state.agents.values()) if (!a.removed && a.sessionId) list.push(hubInfo(a));
  const live = new Set(list.map(p => p.sessionId));
  for (const p of state.parked.values()) if (!live.has(p.sessionId)) list.push(p);
  try { localStorage.setItem('hubAgents', JSON.stringify(list)); } catch { /* not important */ }
}

function loadHub() {
  try {
    for (const p of JSON.parse(localStorage.getItem('hubAgents') || '[]')) state.parked.set(p.sessionId, p);
  } catch { /* start with an empty Hub */ }
}

// Opens the session of an agent that is not running; your next message there resumes it.
async function openParked(sessionId) {
  const p = state.parked.get(sessionId);
  if (p) p.unread = false;
  let session = state.sessions.find(s => s.id === sessionId);
  if (!session) {
    await loadSessions();
    session = state.sessions.find(s => s.id === sessionId);
  }
  if (!session) {
    show('hub');
    return null;
  }
  await openHistory(session);
  const h = state.history.get(sessionId);
  if (h && p) {
    h.choice = h.choice || p.choice;
    h.mode = h.mode || p.mode;
    composerPicker.setValue(h.choice || defaultChoice());
    composerModePicker.setValue(h.mode || defaultMode());
  }
  return h?.view;
}

async function removeFromHub(id) {
  if (id.startsWith('p:')) {
    await hub.removeTile(id);
    state.parked.delete(id.slice(2));
    refreshHub();
    return;
  }
  const a = state.agents.get(id);
  if (!a) return;
  if (['working', 'waiting', 'starting'].includes(a.status)
      && !confirm(`"${a.title}" is still working. Stop it and remove it from the Hub?`)) return;
  await hub.removeTile(id);
  // The process stops too; its session stays in History.
  a.removed = true;
  window.deck.closeAgent(id);
  if (state.current?.kind === 'agent' && state.current.id === id) show('hub');
  refreshHub();
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
  const parts = p.split(SEP).filter(Boolean);
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
  refreshHub();
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
  const parked = state.parked.get(sessionId);
  if (parked) parked.groupId = groupId;
  if (groupId) state.groups.assignments[sessionId] = groupId;
  else delete state.groups.assignments[sessionId];
  saveGroups();
  renderSidebar();
}

// Creates a group with a name, without the rename field in the sidebar.
function addGroup(name) {
  const group = { id: crypto.randomUUID(), name, collapsed: false };
  state.groups.groups.push(group);
  saveGroups();
  renderSidebar();
  return group;
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


async function loadSessions() {
  state.sessions = await window.deck.listSessions();
  const titles = savedTitles();
  for (const s of state.sessions) if (titles[s.id]) s.title = titles[s.id];
  renderSidebar();
}

// ---------- history ----------

async function openHistory(session) {
  // Opening a completed agent's session from History also counts as seeing it.
  const parked = state.parked.get(session.id);
  if (parked) parked.unread = false;
  if (!state.history.has(session.id)) {
    const view = makeChatView();
    const data = await window.deck.loadTranscript(session.file);
    const transcript = new Transcript(view, data.cwd || session.cwd);
    for (const m of data.messages) transcript.add(m);
    transcript.finishTurn();
    transcript.note('End of saved session. Send a message to continue it.');
    state.history.set(session.id, { session, view, transcript, cwd: data.cwd });
    view.scrollTop = view.scrollHeight;
  }
  show('history', session.id);
  setHistoryOpen(false);
}

// ---------- agents ----------

async function startAgent({ cwd, prompt, permissionMode, choice, resume, groupId, fromRect }) {
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
  const transcript = resume ? resume.transcript : new Transcript(view, cwd);
  if (resume) {
    state.history.delete(resume.session.id);
    state.parked.delete(resume.session.id);
  }

  transcript.onUpdate = refreshHub;
  const agent = { id, title, cwd, status: 'starting', sessionId: resume?.session.id || null, view, transcript, unread: false, choice, mode: permissionMode,
    // A resumed session stays in its group. A new one goes to the group picked in the form.
    groupId: resume ? groupOf(resume.session.id) : groupId || null };
  state.agents.set(id, agent);
  transcript.add({ type: 'user', message: { role: 'user', content: prompt } });
  if (!resume) summarizeTitle(agent, prompt);
  if (fromRect) {
    // Started from the Hub: stay there and watch the message box become the tile.
    hub.expectArrival(id, fromRect, prompt);
    show('hub');
  } else {
    afterSend(agent, false);
  }
  await sendToAgent(agent, prompt);
}

// ---------- titles ----------

// Titles that summarize what you asked for, by session id. Saved in local
// storage, because Claude Code's own session files keep your first message.
function savedTitles() {
  try { return JSON.parse(localStorage.getItem('sessionTitles') || '{}'); } catch { return {}; }
}

function rememberTitle(agent) {
  if (!agent.sessionId || !agent.summaryTitle) return;
  const titles = savedTitles();
  titles[agent.sessionId] = agent.summaryTitle;
  try { localStorage.setItem('sessionTitles', JSON.stringify(titles)); } catch { /* not important */ }
}

// Until the summary arrives, the agent keeps your message as its title.
async function summarizeTitle(agent, prompt) {
  const title = await window.deck.summarizeTitle(prompt).catch(() => null);
  if (!title) return;
  agent.title = title;
  agent.summaryTitle = title;
  rememberTitle(agent);
  refreshHeaderIfCurrent(agent.id);
  refreshHub();
}

// After you send a message, the Hub shows the agent going (back) to work.
// Set "hubAfterSend": false in Settings to stay in the chat instead.
function afterSend(agent, wake) {
  if (state.config.hubAfterSend === false) {
    show('agent', agent.id);
    return;
  }
  show('hub');
  if (wake) requestAnimationFrame(() => requestAnimationFrame(() => hub.wake(agent.id)));
}

// Before each message, remember the state of the files (only in a git
// repository), so that after the turn we can list every file the agent changed.
async function sendToAgent(agent, text) {
  if (!agent.snapshot) {
    try { agent.snapshot = await window.deck.gitSnapshot(agent.cwd); } catch { agent.snapshot = null; }
  }
  await window.deck.sendMessage(agent.id, text);
}

window.deck.onEvent((id, msg) => {
  const a = state.agents.get(id);
  if (!a) return;
  a.transcript.add(msg);
  if (msg.type === 'result' && a.snapshot) {
    const snap = a.snapshot;
    const turn = a.transcript.lastFinished;
    a.snapshot = null;
    window.deck.gitChanges(a.cwd, snap)
      .then(diff => a.transcript.showGitChanges(turn, diff, snap.kind === 'folder'))
      .catch(() => {});
  }
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
  rememberTitle(a);
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
  if (!a.removed && a.sessionId) state.parked.set(a.sessionId, hubInfo(a));
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

  if (state.current.kind === 'hub') {
    // The message box morphs into the new agent's tile.
    const fromRect = document.querySelector('.composer-box').getBoundingClientRect();
    const d = ensureDraft();
    if (!d.folder) {
      input.value = text;
      await chooseFolder();
      return;
    }
    try { localStorage.setItem('lastFolder', d.folder); } catch { /* not important */ }
    state.groups.lastGroupId = d.groupId || undefined;
    saveGroups();
    // The next new agent starts with the same folder and group, and the default model.
    state.draft = null;
    await startAgent({ cwd: d.folder, prompt: text, permissionMode: d.mode, choice: d.choice, groupId: d.groupId, fromRect });
  } else if (state.current.kind === 'agent') {
    const a = state.agents.get(state.current.id);
    a.transcript.add({ type: 'user', message: { role: 'user', content: text } });
    afterSend(a, true);
    await sendToAgent(a, text);
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
  // New agents start from the message box under the Hub.
  if (isMod(e) && e.key === 'n') { e.preventDefault(); show('hub'); $('input').focus(); }
  if (isMod(e) && e.key === '0') { e.preventDefault(); show('hub'); }
  if (isMod(e) && e.key === '[') { e.preventDefault(); backToHub(); }
  if (isMod(e) && /^[1-9]$/.test(e.key)) {
    const a = [...state.agents.values()][Number(e.key) - 1];
    if (a) { e.preventDefault(); show('agent', a.id); }
  }
  if (isMod(e) && e.key === 'f') { e.preventDefault(); setHistoryOpen(true); }
  // Esc leaves an agent (or a saved session, or a new agent) for the Hub.
  // The Stop button in the top bar stops a running turn.
  if (e.key === 'Escape' && !e.popupWasOpen && ['agent', 'history', 'new'].includes(state.current?.kind)) {
    e.preventDefault();
    backToHub();
  }
});

// Esc first closes whatever is open (a model or permission menu, the group
// panel, the review view). This runs before those close themselves, so the
// handler above knows not to go back to the Hub as well.
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') e.popupWasOpen = !!document.querySelector('.model-menu:not(.hidden), .group-panel, .review');
}, true);

// ---------- history drawer ----------

// The saved sessions live in a drawer that slides in over the window.
function setHistoryOpen(open) {
  document.body.classList.toggle('history-open', open);
  if (open) {
    renderHistory();
    setTimeout(() => $('search').focus(), 50);
  }
}

$('toggle-sidebar').onclick = () => setHistoryOpen(!document.body.classList.contains('history-open'));
$('close-history').onclick = () => setHistoryOpen(false);
$('drawer-backdrop').onclick = () => setHistoryOpen(false);
document.addEventListener('keydown', e => {
  if (isMod(e) && e.key === '\\') {
    e.preventDefault();
    $('toggle-sidebar').click();
  }
  // Esc closes the drawer first; it only stops an agent when the drawer is closed.
  if (e.key === 'Escape' && document.body.classList.contains('history-open')) {
    e.stopImmediatePropagation();
    setHistoryOpen(false);
  }
}, true);

// Refresh the "5m ago" labels now and then.
setInterval(renderSidebar, 60_000);

(async () => {
  state.config = await window.deck.getConfig();
  loadModels();
  state.groups = { groups: [], assignments: {}, ...(await window.deck.getGroups()) };
  loadHub();
  if (!IS_MAC) {
    for (const node of document.querySelectorAll('[title], [placeholder]')) {
      for (const attr of ['title', 'placeholder']) {
        const v = node.getAttribute(attr);
        if (v && v.includes('⌘')) node.setAttribute(attr, v.replaceAll('⌘', 'Ctrl+'));
      }
    }
  }
  await loadSessions();
  show('hub');
})();
