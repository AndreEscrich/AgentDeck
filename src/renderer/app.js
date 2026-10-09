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
  stuck: 'Stuck',
  error: 'Error',
  exited: 'Stopped',
};

const state = {
  config: {},
  sessions: [],
  agents: new Map(),       // agent id -> { id, title, cwd, status, sessionId, view, transcript, unread }
  history: new Map(),      // session id -> { session, view, transcript } for opened, not-yet-resumed sessions
  current: null,           // { kind: 'hub' | 'agent' | 'history', id }
  // Naming: in the code and in groups.json, "groups" are what the app shows as
  // Categories (labels you give sessions). A Group in the Hub is one Category
  // plus one folder; its agents share context (see forkSourceFor).
  groups: { groups: [], assignments: {} },  // your Categories, saved in groups.json
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
    renderSettingsButton();
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
    renderSettingsButton();
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
// Folders you removed from the folder menu. They come back when you pick
// them again with Choose folder… or start an agent in them.
function hiddenFolders() {
  try { return JSON.parse(localStorage.getItem('hiddenFolders') || '[]'); } catch { return []; }
}

function setFolderHidden(folder, hidden) {
  const list = hiddenFolders().filter(f => f !== folder);
  if (hidden) list.push(folder);
  try { localStorage.setItem('hiddenFolders', JSON.stringify(list)); } catch { /* not important */ }
}

function recentFolders() {
  const list = [];
  const hidden = new Set(hiddenFolders());
  const add = f => { if (f && !list.includes(f) && !hidden.has(f) && !/\/private\/tmp\/|scratch-workspaces/.test(f)) list.push(f); };
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
  $('composer-group').textContent = (group ? '# ' + group.name : '# No category') + ' ▾';
  $('composer-group').title = 'The category the new agent goes into. Category and folder together make its Group.';
  // Outline the Hub panel this message box points at. (At startup the Hub
  // does not exist yet; it picks the outline up on its first update.)
  try {
    const category = state.groups.groups.some(g => g.id === d.groupId) ? d.groupId : '';
    hub.markSelected(d.folder ? `${category}\n${repoName(d.folder)}` : null);
  } catch { /* the Hub is not created yet */ }
  // Which agent the next one continues from (see forkSourceFor).
  const source = forkSourceFor(d.folder, d.groupId);
  const fork = $('composer-fork');
  fork.textContent = source ? `↳ continues from "${source.title}"` : '';
  fork.title = source ? 'A new agent in this Group starts as a copy of this agent\'s conversation.' : '';
}

// The folder menu: recent folders, each with ✕ to remove it from the list,
// and Choose folder… at the bottom. It opens above the folder button, like
// the Category panel.
function chooseFolder() {
  const d = ensureDraft();
  const open = document.querySelector('.folder-panel');
  document.querySelector('.group-panel')?.remove();
  sfx(open ? 'tickDown' : 'tick');
  if (open) return; // a second click on the button closes it
  const panel = el('div', 'group-panel folder-panel');
  const list = el('div', 'group-panel-list');
  panel.appendChild(list);
  $('composer-folder').parentNode.appendChild(panel);

  const close = () => {
    panel.remove();
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const outside = e => { if (!panel.contains(e.target) && e.target !== $('composer-folder')) close(); };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const pick = folder => {
    d.folder = folder;
    setFolderHidden(folder, false);
    close();
    renderDraftButtons();
    $('input').focus();
  };

  function render() {
    list.innerHTML = '';
    for (const f of recentFolders()) {
      const row = el('div', 'group-panel-item folder-row' + (f === d.folder ? ' selected' : ''));
      row.title = f;
      const remove = el('button', 'folder-remove', '✕');
      remove.title = 'Remove from this list (the folder itself stays)';
      remove.onclick = e => {
        e.stopPropagation();
        sfx('detach');
        setFolderHidden(f, true);
        try { if (localStorage.getItem('lastFolder') === f) localStorage.removeItem('lastFolder'); } catch { /* not important */ }
        render();
      };
      row.append(el('span', 'folder-name', homePath(f)), remove);
      row.onclick = () => { sfx('select'); pick(f); };
      list.appendChild(row);
    }
    if (!list.children.length) list.appendChild(el('div', 'group-panel-sep', 'No recent folders'));
    const choose = el('div', 'group-panel-item create', 'Choose folder…');
    choose.onclick = async () => {
      close();
      const dir = await window.deck.pickFolder();
      if (dir) pick(dir);
    };
    list.appendChild(choose);
  }

  render();
  document.addEventListener('mousedown', outside, true);
  document.addEventListener('keydown', onKey, true);
}

// The group button opens a panel: type a name to create a group, or pick
// one from the list. The list only shows groups that agents in the Hub use.
function chooseGroup() {
  const d = ensureDraft();
  document.querySelector('.group-panel')?.remove();
  sfx('tick');
  const panel = el('div', 'group-panel');
  const input = document.createElement('input');
  input.placeholder = 'Type a new category, or search…';
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
      const create = el('div', 'group-panel-item create', `+ Create category "${input.value.trim()}"`);
      create.onclick = () => pick(addGroup(input.value.trim()).id);
      list.appendChild(create);
    }
    if (!q) {
      const none = el('div', 'group-panel-item' + (!d.groupId ? ' selected' : ''));
      none.append(el('span', null, 'No category'));
      none.onclick = () => pick(null);
      list.appendChild(none);
    }
    for (const g of groups) {
      const n = inUse.get(g.id) || 0;
      const row = el('div', 'group-panel-item' + (g.id === d.groupId ? ' selected' : ''));
      row.append(el('span', null, '# ' + g.name), el('span', 'group-panel-count', n ? `${n} agent${n === 1 ? '' : 's'}` : ''));
      row.onclick = () => { sfx('select'); pick(g.id); };
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

// ---------- settings button ----------

// Permissions and model are almost always the defaults (bypass, latest Opus,
// medium effort), so their menus sit behind a ⚙ button. When the settings on
// screen differ from the defaults, the button names them.
function settingsDiffer() {
  const c = composerPicker.value;
  const d = defaultChoice();
  return composerModePicker.value !== defaultMode()
    || (c.model || 'default') !== (d.model || 'default')
    || (c.effort || '') !== (d.effort || '')
    || !!c.fastMode !== !!d.fastMode;
}

function renderSettingsButton() {
  const btn = $('composer-settings-btn');
  const open = !$('composer-settings').classList.contains('hidden');
  const summary = `${composerModePicker.mode.short} · ${composerPicker.button.textContent.replace(' ▾', '')}`;
  btn.textContent = !open && settingsDiffer() ? `⚙ ${summary}` : '⚙';
  btn.title = `${open ? 'Hide' : 'Show'} permissions and model (${summary})`;
  btn.classList.toggle('active', open);
  btn.classList.toggle('changed', settingsDiffer());
}

function setSettingsOpen(open) {
  $('composer-settings').classList.toggle('hidden', !open);
  try { localStorage.setItem('composerSettingsOpen', open ? '1' : '0'); } catch { /* not important */ }
  renderSettingsButton();
}

$('composer-settings-btn').onclick = () => setSettingsOpen($('composer-settings').classList.contains('hidden'));

// ---------- context meter ----------

// Asks the agent's claude process how full its context window is.
function updateContext(agent) {
  agent.contextAt = Date.now();
  window.deck.contextUsage(agent.id).then(usage => {
    if (!usage || !usage.maxTokens) return;
    agent.context = usage;
    if (state.current?.kind === 'agent' && state.current.id === agent.id) renderContextMeter();
  }).catch(() => {});
}

function formatK(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

// A ring next to the Send button that fills up with the context in use, like
// in the Claude desktop app. Pointing at it shows what fills the context.
function renderContextMeter() {
  const meter = $('context-meter');
  const agent = state.current?.kind === 'agent' ? state.agents.get(state.current.id) : null;
  const usage = agent?.context;
  meter.classList.toggle('hidden', !usage);
  if (!usage) return;
  const fraction = Math.min(1, usage.totalTokens / usage.maxTokens);
  const percent = Math.round(fraction * 100);
  const r = 7;
  const length = 2 * Math.PI * r;
  meter.className = 'context-meter' + (fraction >= 0.85 ? ' full' : fraction >= 0.6 ? ' high' : '');
  meter.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 18 18">
      <circle class="ring-bg" cx="9" cy="9" r="${r}"/>
      <circle class="ring" cx="9" cy="9" r="${r}" stroke-dasharray="${(fraction * length).toFixed(2)} ${length.toFixed(2)}" transform="rotate(-90 9 9)"/>
    </svg>
    <span class="context-percent">${percent}%</span>`;
  const pop = el('div', 'context-pop');
  pop.append(el('div', 'context-pop-head', `Context: ${formatK(usage.totalTokens)} of ${formatK(usage.maxTokens)} tokens (${percent}%)`));
  const used = (usage.categories || []).filter(c => c.kind === 'used' && c.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  for (const c of used) {
    const row = el('div', 'context-pop-row');
    row.append(el('span', null, c.name), el('span', 'context-pop-num', formatK(c.tokens)));
    pop.appendChild(row);
  }
  const buffer = (usage.categories || []).find(c => c.kind === 'buffer');
  if (buffer) pop.appendChild(el('div', 'context-pop-note', `Claude Code compacts the conversation when it reaches ${formatK(usage.maxTokens - buffer.tokens)} tokens.`));
  meter.appendChild(pop);
}

// ---------- first look at a finished agent ----------

// The first time you open an agent after it finished a task, the chat starts
// at the beginning of that task's output (right under your message), so you
// read the result from its start. It stays there: you scroll yourself.
function revealLatest(view, transcript) {
  const turnEl = transcript?.lastFinished?.el;
  if (!view || !turnEl) return scrollToBottom(view);
  view.revealing = true;
  const place = () => {
    view.scrollTop = Math.max(0, view.scrollTop + turnEl.getBoundingClientRect().top - view.getBoundingClientRect().top - 16);
  };
  // A hidden view loses its scroll position, and its height is only final in
  // the next frame, so the place is set again then, and once more after the
  // opening animation, unless you scrolled in the meantime.
  let moved = false;
  const stop = () => {
    moved = true;
    for (const type of ['wheel', 'mousedown', 'touchstart']) view.removeEventListener(type, stop);
  };
  for (const type of ['wheel', 'mousedown', 'touchstart']) view.addEventListener(type, stop, { passive: true });
  place();
  requestAnimationFrame(() => { if (!moved) place(); });
  setTimeout(() => {
    if (!moved) place();
    stop();
    view.revealing = false;
  }, 500);
}

// Every other time you open a chat, it starts at the bottom. A hidden view
// loses its scroll position, so this runs after the view is shown, and once
// more in the next frame, when its height is final.
function scrollToBottom(view) {
  if (!view) return;
  view.scrollTop = view.scrollHeight;
  requestAnimationFrame(() => {
    if (!view.revealing) view.scrollTop = view.scrollHeight;
  });
}

// ---------- images and videos for the agent ----------

// Drop images or videos on the window (while a message box is shown), or
// paste an image into the message box: they go with your next message (see
// renderer/attachments.js).
const attachments = new Attachments($('composer-attachments'), {
  key: () => viewKey(state.current),
});

{
  let depth = 0;   // drag events fire for every element the pointer crosses
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  const box = () => document.querySelector('.composer-box');
  const canDrop = () => !$('composer').classList.contains('hidden');
  document.addEventListener('dragenter', e => {
    if (!hasFiles(e)) return;
    depth++;
    if (canDrop()) box().classList.add('drag-over');
  });
  document.addEventListener('dragleave', e => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) box().classList.remove('drag-over');
  });
  document.addEventListener('dragover', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = canDrop() ? 'copy' : 'none';
  });
  // A file dropped anywhere must never replace the app's page with the file.
  document.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    box().classList.remove('drag-over');
    if (!canDrop()) return;
    const skipped = attachments.add([...e.dataTransfer.files]);
    if (skipped.length) flashComposerNote(`Only images and videos can be attached (${skipped.join(', ')} skipped).`);
    $('input').focus();
  });
  $('input').addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    // A pasted screenshot is attached; pasted text still goes into the box.
    if (!e.clipboardData.getData('text')) e.preventDefault();
    attachments.add(files);
  });
}

// A short note over the message box that fades out again.
function flashComposerNote(text) {
  const note = el('div', 'composer-flash', text);
  document.querySelector('.composer-box').appendChild(note);
  setTimeout(() => note.remove(), 3500);
}

// ---------- one message box per view ----------

// The Hub, every agent and every saved session keep their own text in the
// message box: leaving a view remembers what you typed there, and coming back
// puts it back. Sending empties only the box of the view you sent from.
const inputDrafts = new Map();   // view key -> text

function viewKey(view) {
  if (!view) return null;
  if (view.kind === 'agent' || view.kind === 'history') return `${view.kind}:${view.id}`;
  return view.kind; // 'hub', 'new'
}

function saveInputDraft() {
  const key = viewKey(state.current);
  if (!key) return;
  const text = $('input').value;
  if (text) inputDrafts.set(key, text);
  else inputDrafts.delete(key);
}

function restoreInputDraft() {
  $('input').value = inputDrafts.get(viewKey(state.current)) || '';
  autosize();
  attachments.render();
}

function show(kind, id) {
  saveInputDraft();
  state.current = { kind, id };
  requestAnimationFrame(updateNextHint);
  $('back-to-hub').classList.toggle('hidden', !['agent', 'history'].includes(kind));
  for (const v of $('views').children) v.classList.add('hidden');

  // The Hub also has the message box: a message there starts a new agent.
  const startsAgent = !['agent', 'history'].includes(kind);
  $('composer').classList.remove('hidden');
  $('composer-folder').classList.toggle('hidden', !startsAgent);
  $('composer-group').classList.toggle('hidden', !startsAgent);
  $('composer-fork').classList.toggle('hidden', !startsAgent);

  if (kind === 'agent') {
    const a = state.agents.get(id);
    a.view.classList.remove('hidden');
    // Finished while you were not looking: show its output from the start.
    if (a.unread && a.status === 'idle') revealLatest(a.view, a.transcript);
    else scrollToBottom(a.view);
    a.unread = false;
    setHeader(a.title, a.cwd, a);
    composerPicker.setValue(a.choice || defaultChoice());
    composerModePicker.setValue(a.mode || defaultMode());
    $('input').placeholder = 'Message the agent… (↩ to send, ⇧↩ for a new line)';
    $('input').focus();
  } else if (kind === 'history') {
    const h = state.history.get(id);
    h.view.classList.remove('hidden');
    scrollToBottom(h.view);
    setHeader(h.session.title, h.cwd || h.session.cwd, null);
    composerPicker.setValue(h.choice || defaultChoice());
    composerModePicker.setValue(h.mode || defaultMode());
    $('input').placeholder = 'Send a message to continue this session…';
    $('input').focus();
  } else {
    state.current = { kind: 'hub' };
    $('hub-view').classList.remove('hidden');
    setHeader('Claude HUB', '', null);
    const d = ensureDraft();
    composerPicker.setValue(d.choice);
    composerModePicker.setValue(d.mode);
    renderDraftButtons();
    $('input').placeholder = 'Start a new agent… (↩ to start)';
    if (!state.agents.size) activityPanel.load({ ifOlderThan: 10 * 60 * 1000 });
    // Back in the Hub (after leaving or closing an agent): ready to type.
    focusInput();
  }
  renderSettingsButton();
  renderSidebar();
  // Opening an agent can take it off the badge.
  updateAttention();
  // The context meter shows for a running agent; it asks for numbers the
  // first time you open the agent.
  if (kind === 'agent' && state.agents.get(id) && !state.agents.get(id).context) updateContext(state.agents.get(id));
  renderContextMeter();
  restoreInputDraft();
}

// ---------- hub ----------

// From an agent, the view shrinks back into its tile; from anywhere else the
// Hub simply opens.
function backToHub() {
  const cur = state.current;
  if (cur?.kind === 'agent' || cur?.kind === 'history') sfx('close');
  continueReview(cur, leaveToHub());
}

// Shows the Hub; an agent's chat shrinks back into its tile. Resolves when
// that animation is over.
function leaveToHub() {
  const cur = state.current;
  show('hub');
  if (cur?.kind === 'agent' && state.agents.has(cur.id)) {
    return hub.returnTo(cur.id, state.agents.get(cur.id).view);
  }
  if (cur?.kind === 'history' && state.parked.has(cur.id)) {
    return hub.returnTo('p:' + cur.id, state.history.get(cur.id)?.view);
  }
  return Promise.resolve();
}

// ---------- review queue ----------

// The agents to check, in order: first the ones waiting for your input
// (a question or an approval) that you have not opened since, the one that
// has waited longest first; then completed agents you have not opened since
// they finished, the latest first; and last the agents that still wait for
// your answer although you have looked at them, so they come back once
// nothing else is left.
//
// Tab (anywhere in the app) opens the first one: from the Hub it zooms out
// of its tile; from an agent, the next one slides in from the right.
// Enter in the Hub (with the message box not active) also opens it, and
// there closing or answering the agent opens the next one.
function reviewQueue() {
  const items = hubItems();
  const waiting = items.filter(i => i.status === 'waiting' && i.unread)
    .sort((a, b) => (a.waitingSince || 0) - (b.waitingSince || 0));
  // Stuck agents are left out: they are still working, and the Hub shows
  // them with their own look.
  const unseen = items.filter(i => i.unread && i.status === 'idle')
    .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
  const unanswered = items.filter(i => i.status === 'waiting' && !i.unread)
    .sort((a, b) => (a.waitingSince || 0) - (b.waitingSince || 0));
  return [...waiting, ...unseen, ...unanswered];
}

// A new press of Enter starts a round. Within a round, agents already opened
// are skipped: an agent that still waits for your answer would otherwise come
// first again right after you close it.
function reviewNext(continuing = false) {
  if (!continuing || !state.reviewed) state.reviewed = new Set();
  const next = reviewQueue().find(i => !state.reviewed.has(i.id));
  state.reviewing = next ? next.id : null;
  if (next) {
    state.reviewed.add(next.id);
    hub.open(next.id);
  }
  return !!next;
}

// Tab: the next agent to check, or a short message when there is none.
// From the Hub, the agent zooms out of its tile. From an agent, the next one
// slides in from the right, without going through the Hub.
async function checkNext() {
  if (hub.opening || state.sliding) return;
  const cur = state.current;
  const next = reviewQueue().find(i => i.id !== hubIdOf(cur));
  if (!next) {
    if (playSounds()) sounds.nothing();
    toast('Nothing to check: no agent is waiting for you or has finished since you looked');
    return;
  }
  state.reviewing = null;
  if (playSounds()) sounds.tab();
  const from = viewOf(cur);
  if (cur?.kind === 'hub' || !from) {
    if (cur?.kind !== 'hub') show('hub');
    state.quietOpen = true;
    hub.open(next.id);
    return;
  }
  state.sliding = true;
  try {
    await slideTo(next, from);
  } finally {
    state.sliding = false;
  }
}

// The chat element of an agent or saved session on screen.
function viewOf(cur) {
  if (cur?.kind === 'agent') return state.agents.get(cur.id)?.view || null;
  if (cur?.kind === 'history') return state.history.get(cur.id)?.view || null;
  return null;
}

// The current chat moves out to the left while the next one comes in from
// the right.
async function slideTo(next, from) {
  if (next.id.startsWith('p:')) await openParked(next.id.slice(2));
  else show('agent', next.id);
  const to = viewOf(state.current);
  if (!to || to === from) return;
  from.classList.remove('hidden');
  const timing = { duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)' };
  await Promise.all([
    to.animate([{ transform: 'translateX(100%)', opacity: 0.6 }, { transform: 'none', opacity: 1 }], timing).finished,
    from.animate([{ transform: 'none', opacity: 1 }, { transform: 'translateX(-25%)', opacity: 0 }], timing).finished,
  ]).catch(() => {});
  if (viewOf(state.current) !== from) from.classList.add('hidden');
}

// A short message at the bottom of the window that fades away by itself.
function toast(text) {
  document.querySelector('.toast')?.remove();
  const node = el('div', 'toast', text);
  document.body.appendChild(node);
  requestAnimationFrame(() => node.classList.add('show'));
  setTimeout(() => {
    node.classList.remove('show');
    setTimeout(() => node.remove(), 300);
  }, 2200);
}

// The Hub id of what is on screen: an agent's id, or "p:<session>" for a
// completed agent that is not running.
function hubIdOf(view) {
  if (view?.kind === 'agent') return view.id;
  if (view?.kind === 'history') return 'p:' + view.id;
  return null;
}

// Called when you leave an agent (closing it or answering it). If the queue
// opened that agent, the next one opens once the closing animation is over.
function continueReview(left, closing) {
  if (!state.reviewing || hubIdOf(left) !== state.reviewing) {
    state.reviewing = null;
    return;
  }
  Promise.resolve(closing).then(() => {
    // Only if you are still in the Hub and did not open something else.
    if (state.current?.kind === 'hub') setTimeout(() => { if (state.current?.kind === 'hub') reviewNext(true); }, 250);
    else state.reviewing = null;
  });
}
$('back-to-hub').onclick = backToHub;

const hub = new Hub($('hub-view'), {
  // Clicking a Group panel: the next agent goes into that Group (its folder
  // and Category), so it continues from the Group's latest agent.
  onPickGroup: (categoryId, folder) => {
    sfx('select');
    const d = ensureDraft();
    d.folder = folder;
    d.groupId = categoryId;
    setFolderHidden(folder, false);
    renderDraftButtons();
    $('input').focus();
  },
  onOpen: async id => {
    // Tab plays its own sound for the agent it opens.
    if (state.quietOpen) state.quietOpen = false;
    else sfx('open');
    if (id.startsWith('p:')) return openParked(id.slice(2));
    show('agent', id);
    return state.agents.get(id)?.view;
  },
  onRemove: removeFromHub,
  onInterrupt: id => interruptAgent(id),
  onRemoveGroup: removeGroupFromHub,
  onTab: () => checkNext(),
  onReorder: ids => saveTileOrder(ids),
  onReorderGroups: keys => saveGroupOrder(keys),
  onDragSound: kind => { if (playSounds()) sounds[kind]?.(); },
  // A new agent's message box has flown into its tile.
  onLanded: () => { if (playSounds()) sounds.brew(); },
  // Catching up after the app was in the background: each tile that changed
  // plays the sound of its new state as it changes.
  onReplay: agent => {
    if (!playSounds()) return;
    if (agent.status === 'idle') sounds.done();
    else if (agent.status === 'waiting') sounds.attention();
    else if (agent.status === 'error') sounds.error();
  },
  onContext: id => sessionMenu(id.startsWith('p:') ? id.slice(2) : state.agents.get(id)?.sessionId),
});

// The Connectors dialog, opened from the Hub's settings button. It lists the
// connectors for the folder the message box points at (connectors can be set
// up for one folder only).
const connectorsDialog = new ConnectorsDialog({
  folder: () => ensureDraft().folder || state.config.home,
});
hub.onOpenConnectors = () => connectorsDialog.open();
hub.onOpenSettings = () => { sfx('tick'); window.deck.openConfig(); };

// Your Claude Code activity, shown in the Hub while it has no agents. It is
// read at startup and again when the empty Hub shows and the numbers are
// older than 10 minutes.
// The usage card (the Usage tab on the Hub's left edge) shows the same
// numbers in a smaller view, also when the Hub has agents.
const activityPanel = new ActivityPanel(hub.activityBox);
const usageActivity = new ActivityPanel(hub.usageActivityBox, { compact: true });
activityPanel.onLoaded = data => usageActivity.show(data);
hub.onOpenUsage = () => activityPanel.load({ ifOlderThan: 10 * 60 * 1000 });
setTimeout(() => activityPanel.load(), 1500);
// The audio engine is set up ahead of the first sound (see sounds.warm).
setTimeout(() => { if (playSounds()) (window.requestIdleCallback || setTimeout)(() => sounds.warm()); }, 2500);

// The Dock badge: how many agents wait for you right now.
let attentionCount = 0;
// It counts the agents that wait for your answer or approval (they only
// drop off once you reply), plus the finished agents you have not opened
// since they finished (they drop off when you open them). It is updated
// right away, also while the window is minimized and does not redraw.
function updateAttention() {
  const items = hubItems();
  const n = items.filter(i => i.status === 'waiting').length
    + items.filter(i => i.status === 'idle' && i.unread).length;
  if (n !== attentionCount) {
    attentionCount = n;
    window.deck.setAttention(n, window.deck.platform === 'darwin' ? null : badgeImage(n));
  }
}

// Windows has no Dock badge, so the taskbar button gets a red dot with the
// number drawn here (32 px, so it stays sharp on high-resolution screens).
function badgeImage(n) {
  if (!n) return null;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#e5484d';
  ctx.beginPath();
  ctx.arc(16, 16, 16, 0, Math.PI * 2);
  ctx.fill();
  const text = n > 9 ? '9+' : String(n);
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${text.length > 1 ? 17 : 21}px "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 16, 17);
  return canvas.toDataURL('image/png');
}

// Many events can arrive in one frame, so the Hub redraws at most once per frame.
let hubFrame = 0;
function refreshHub() {
  updateAttention();
  if (hubFrame) return;
  hubFrame = requestAnimationFrame(() => {
    hubFrame = 0;
    const items = hubItems();
    hub.update(items, state.current?.kind === 'agent' ? state.current.id : null, state.groups.groups);
    saveHub();
    const agents = items.filter(a => !a.parked);
    const busy = agents.filter(a => ['working', 'starting', 'waiting', 'stuck'].includes(a.status)).length;
    // Agents finishing or getting their short title change the "continues from" line.
    if (['new', 'hub'].includes(state.current?.kind)) renderDraftButtons();
    updateNextHint();
  });
}

// In an agent, when Tab has somewhere to go: a glow on the right edge in the
// color of the next agent's state, with "Tab to go" and its name. Clicking
// it does the same as Tab.
const NEXT_COLORS = { idle: '#74d39d', waiting: '#f09a75', question: '#a99bf7', error: '#ef7f7f' };
function updateNextHint() {
  let hint = $('next-hint');
  if (!hint) {
    // In the Hub, the Tab button sits right above the message box.
    $('composer').prepend(hub.tabHint);
    hint = el('button', 'next-hint');
    hint.id = 'next-hint';
    hint.type = 'button';
    // Bubbles in the next agent's color, like the tank it goes to, drift in
    // slowly from the right edge toward the chat; each has its own height,
    // size, speed and start.
    const bubbles = el('span', 'next-bubbles');
    for (let i = 0; i < 14; i++) {
      const b = el('span');
      b.style.setProperty('--y', `${8 + Math.random() * 84}%`);
      b.style.setProperty('--s', `${4 + Math.round(Math.random() * 10)}px`);
      b.style.setProperty('--t', `${(9 + Math.random() * 7).toFixed(2)}s`);
      b.style.setProperty('--w', `${(Math.random() * 16 - 8).toFixed(1)}px`);
      bubbles.appendChild(b);
    }
    hint.append(bubbles, el('span', 'next-hint-label', 'Tab to go'), el('span', 'next-hint-name'));
    hint.onclick = () => checkNext();
    $('main').appendChild(hint);
  }
  const cur = state.current;
  const queue = reviewQueue().filter(i => i.id !== hubIdOf(cur));
  const next = queue[0];
  const colorOf = i => NEXT_COLORS[i.status === 'waiting' && i.attention === 'question' ? 'question' : i.status] || NEXT_COLORS.idle;
  // In the Hub, the header says that Tab starts going through them.
  hub.setTabHint(cur?.kind === 'hub' && next ? { count: queue.length, name: next.latestTitle || next.title, color: colorOf(next) } : null);
  const inAgent = ['agent', 'history'].includes(cur?.kind);
  const showing = inAgent && !!next;
  // Each time the hint appears, or you move to another agent, the bubbles
  // start over from the right edge one after another, so they build up.
  const shownFor = showing ? `${hubIdOf(cur)}>${next.id}` : '';
  if (shownFor && shownFor !== hint.dataset.shownFor) {
    hint.querySelectorAll('.next-bubbles span').forEach((b, i) => {
      b.style.setProperty('--d', `${(0.1 + i * 0.35 + Math.random() * 0.3).toFixed(2)}s`);
      b.style.animation = 'none';
      void b.offsetWidth;
      b.style.animation = '';
    });
  }
  hint.dataset.shownFor = shownFor;
  hint.classList.toggle('show', showing);
  if (!showing) return;
  hint.style.setProperty('--next', colorOf(next));
  hint.querySelector('.next-hint-name').textContent = next.latestTitle || next.title;
  hint.title = `Tab: open "${next.title}"`;
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
    latestPrompt: a.latestPrompt || null,
    latestTitle: a.latestTitle || null,
    cwd: a.cwd,
    groupId: a.groupId || groupOf(a.sessionId) || null,
    choice: a.choice,
    mode: a.mode,
    lastTurn: a.transcript?.lastTurn ? { durationMs: a.transcript.lastTurn.durationMs, usage: a.transcript.lastTurn.usage } : a.lastTurn || null,
    // Finished while you were not looking, and not opened since.
    unread: !!a.unread,
    finishedAt: a.finishedAt || 0,
    // Busy when this was saved. If the app quits now, the agent continues
    // the next time the app opens (see resumeInterrupted).
    wasWorking: ['working', 'starting', 'waiting', 'stuck'].includes(a.status),
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
    latestPrompt: p.latestPrompt,
    latestTitle: p.latestTitle,
    cwd: p.cwd,
    groupId: groupOf(p.sessionId) || p.groupId,
    sessionId: p.sessionId,
    finishedAt: p.finishedAt || 0,
    unread: !!p.unread,
    transcript: { stepCount: 0, tokens: p.lastTurn?.usage || null, turnStartedAt: null, lastTurn: p.lastTurn },
  };
}

// ---------- shared context ----------

// A Group is one Category plus one folder. A new agent in a Group always
// starts as a fork of the Group's most recently finished agent, so it knows
// what that agent read, did and decided. Agents that are still working are
// skipped, because their saved conversation ends in the middle of a task.
// The fork must be in the same folder, because Claude Code keeps sessions per
// folder. Returns { sessionId, title } or null for the first agent of a Group.
function forkSourceFor(cwd, categoryId) {
  if (!cwd) return null;
  const known = id => state.groups.groups.some(g => g.id === id);
  const category = known(categoryId) ? categoryId : null;
  let best = null;
  for (const item of hubItems()) {
    const itemCategory = known(item.groupId) ? item.groupId : null;
    if (itemCategory !== category || item.cwd !== cwd) continue;
    if (item.status !== 'idle' || !item.sessionId || !item.finishedAt) continue;
    if (!best || item.finishedAt > best.finishedAt) best = item;
  }
  return best ? { sessionId: best.sessionId, title: best.title } : null;
}

// Running agents first, then the ones that are not running. Agents you removed are left out.
// Tiles you sorted by dragging, by session (so the order survives a
// restart), or by agent id for an agent that has no session yet.
let tileOrder = [];
try { tileOrder = JSON.parse(localStorage.getItem('hubOrder') || '[]'); } catch { /* unsorted */ }
function hubItems() {
  const live = [...state.agents.values()].filter(a => !a.removed);
  for (const a of live) a.groupId = groupOf(a.sessionId) || a.groupId || null;
  const liveSessions = new Set(live.map(a => a.sessionId).filter(Boolean));
  const parked = [...state.parked.values()].filter(p => !liveSessions.has(p.sessionId)).map(parkedItem);
  const items = [...live, ...parked];
  for (const item of items) item.repo = repoName(item.cwd);
  // Every tile has a lasting place: a new agent gets the next place at the
  // end, so it shows right of the others in its group (and a new group shows
  // below the others). Dragging tiles swaps places (see saveTileOrder).
  let changed = false;
  for (const item of items) {
    const key = orderKey(item);
    if (tileOrder.includes(key)) continue;
    // An agent keeps its place when its session id arrives.
    const old = tileOrder.indexOf(item.id);
    if (old >= 0) tileOrder[old] = key;
    else tileOrder.push(key);
    changed = true;
  }
  // Places of tiles that are gone (removed from the Hub) are dropped.
  const present = new Set(items.map(orderKey));
  if (tileOrder.some(k => !present.has(k))) { tileOrder = tileOrder.filter(k => present.has(k)); changed = true; }
  if (changed) {
    try { localStorage.setItem('hubOrder', JSON.stringify(tileOrder)); } catch { /* not important */ }
  }
  const rank = new Map(tileOrder.map((key, i) => [key, i]));
  return items.sort((a, b) => rank.get(orderKey(a)) - rank.get(orderKey(b)));
}

function orderKey(item) {
  return item.sessionId || item.id;
}
// After a drag, the group's tiles take the places they had between them, in
// the new order; tiles of other groups, and the group itself, stay put.
function saveTileOrder(ids) {
  const keys = ids.map(id => (id.startsWith('p:') ? id.slice(2) : orderKey(state.agents.get(id) || { id })));
  const places = tileOrder.map((k, i) => (keys.includes(k) ? i : -1)).filter(i => i >= 0);
  if (places.length === keys.length) keys.forEach((k, n) => { tileOrder[places[n]] = k; });
  else tileOrder = [...tileOrder.filter(k => !keys.includes(k)), ...keys];
  try { localStorage.setItem('hubOrder', JSON.stringify(tileOrder)); } catch { /* not important */ }
  refreshHub();
}

// The order of the group panels, after you drag one: their keys (Category
// id + "\n" + repository) from top to bottom. Groups you have not placed yet
// (new ones) come below them. Kept in this computer's local storage, like
// the order of the tiles.
let groupOrder = [];
try { groupOrder = JSON.parse(localStorage.getItem('hubGroupOrder') || '[]'); } catch { /* unsorted */ }
hub.groupOrder = groupOrder;
function saveGroupOrder(keys) {
  // Panels that are not on screen now keep their places after the others.
  groupOrder = [...keys, ...groupOrder.filter(k => !keys.includes(k))];
  hub.groupOrder = groupOrder;
  try { localStorage.setItem('hubGroupOrder', JSON.stringify(groupOrder)); } catch { /* not important */ }
  refreshHub();
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
  const firstLook = !!p?.unread;
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
  if (firstLook && h) revealLatest(h.view, h.transcript);
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
    if (playSounds()) sounds.removed();
    await hub.removeTile(id);
    state.parked.delete(id.slice(2));
    refreshHub();
    return;
  }
  const a = state.agents.get(id);
  if (!a) return;
  if (!(await confirmStop([a], { action: 'Removing it from the Hub', label: 'Stop and remove' }))) return;
  if (playSounds()) sounds.removed();
  await hub.removeTile(id);
  // The process stops too; its session stays in History.
  a.removed = true;
  window.deck.closeAgent(id);
  if (state.current?.kind === 'agent' && state.current.id === id) show('hub');
  refreshHub();
}

// Removes every agent of a Hub group (one panel). Busy agents are stopped,
// after one question for all of them. Their sessions stay in History.
async function removeGroupFromHub(ids) {
  const live = ids.filter(id => !id.startsWith('p:')).map(id => state.agents.get(id)).filter(Boolean);
  if (!(await confirmStop(live, { action: 'Removing the group from the Hub', label: 'Stop and remove group' }))) return;
  if (playSounds()) sounds.groupRemoved(ids.length);
  await hub.removeGroup(ids);
  for (const id of ids) {
    if (id.startsWith('p:')) {
      state.parked.delete(id.slice(2));
      continue;
    }
    const a = state.agents.get(id);
    if (!a) continue;
    a.removed = true;
    window.deck.closeAgent(id);
  }
  if (state.current?.kind === 'agent' && ids.includes(state.current.id)) show('hub');
  refreshHub();
  saveHub();
}

function setHeader(title, subtitle, agent) {
  $('view-title').textContent = title;
  $('view-subtitle').textContent = subtitle || '';
  const pill = $('view-status');
  if (agent) {
    pill.classList.remove('hidden');
    pill.innerHTML = '';
    const statusText = agent.status === 'waiting' && agent.attention === 'question' ? 'Asks you a question' : STATUS_TEXT[agent.status] || agent.status;
    pill.append(el('span', `dot ${agent.status}`), document.createTextNode(statusText));
  } else {
    pill.classList.add('hidden');
  }
  $('btn-interrupt').classList.toggle('hidden', !agent || !['working', 'stuck'].includes(agent.status));
  $('composer-stop').classList.toggle('hidden', !agent || !['working', 'stuck'].includes(agent.status));
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
  const group = { id: crypto.randomUUID(), name: 'New category', collapsed: false };
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
      label: 'Move to category',
      submenu: [
        ...state.groups.groups.map(g => ({ id: 'g:' + g.id, label: g.name, checked: g.id === current })),
        ...(state.groups.groups.length ? [{ type: 'separator' }] : []),
        { id: 'new', label: 'New category…' },
      ],
    },
    { id: 'remove', label: 'Remove from category', enabled: !!current },
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
    { id: 'delete', label: 'Delete category (its sessions become uncategorized)' },
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
  head.append(el('span', 'group-label', group ? group.name : 'Uncategorized'), el('span', 'group-count', count ? String(count) : ''));
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
  item.onclick = () => { sfx('open'); openHistory(s); };
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
    // Without any groups yet, the list needs no "Uncategorized" header.
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

// Loads a saved session into a (hidden) chat view, once.
async function loadHistory(session) {
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
  return state.history.get(session.id);
}

async function openHistory(session) {
  // Opening a completed agent's session from History also counts as seeing it.
  const parked = state.parked.get(session.id);
  if (parked) parked.unread = false;
  await loadHistory(session);
  show('history', session.id);
  setHistoryOpen(false);
}

// Agents that were busy when the app quit continue on their saved session.
const RESUME_PROMPT = 'The app was closed while you were working, which stopped you. Continue where you left off.';
async function resumeInterrupted() {
  for (const p of [...state.parked.values()]) {
    if (!p.wasWorking) continue;
    p.wasWorking = false;
    const session = state.sessions.find(s => s.id === p.sessionId);
    if (!session?.file) continue;
    try {
      const h = await loadHistory({ ...session, title: p.title || session.title });
      await startAgent({ cwd: h.cwd || session.cwd || p.cwd, prompt: RESUME_PROMPT, permissionMode: p.mode, choice: p.choice, resume: h });
    } catch (err) {
      console.error('Could not continue', p.title, err);
    }
  }
  saveHub();
}

// The app is about to quit: save which agents are busy, and keep that list,
// because stopping the agents would otherwise mark them as finished.
const BUSY = ['working', 'starting', 'waiting', 'stuck'];

// A card in the app (not a system dialog) that asks before stopping working
// agents: a title, a sentence, the agents with their state, and two buttons.
// Enter confirms, Esc (or a click outside the card) keeps them working.
// Resolves true when you confirm. While it waits after confirming
// (busyText), the buttons are disabled.
function confirmCard({ title, text, agents = [], confirmLabel, busyText = null }) {
  return new Promise(resolve => {
    if (document.querySelector('.quit-modal')) return resolve(false);
    const overlay = el('div', 'quit-modal');
    const card = el('div', 'quit-card');
    card.append(el('div', 'quit-title', title), el('p', 'quit-text', text));
    if (agents.length) {
      const list = el('div', 'quit-list');
      for (const a of agents.slice(0, 6)) {
        const row = el('div', 'quit-agent');
        row.append(el('span', `dot ${a.status}`), el('span', null, a.latestTitle || a.title));
        list.appendChild(row);
      }
      if (agents.length > 6) list.appendChild(el('div', 'quit-more', `and ${agents.length - 6} more`));
      card.appendChild(list);
    }
    const buttons = el('div', 'quit-buttons');
    const stay = el('button', 'quit-stay', 'Keep working');
    const go = el('button', 'quit-go', confirmLabel);
    buttons.append(stay, go);
    card.appendChild(buttons);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    go.focus();
    const close = answer => {
      document.removeEventListener('keydown', onKey, true);
      if (answer && busyText) {
        go.disabled = stay.disabled = true;
        go.textContent = busyText;
      } else {
        overlay.classList.remove('show');
        setTimeout(() => overlay.remove(), 200);
      }
      resolve(answer);
    };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(false); }
      if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); close(true); }
      if (e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); (document.activeElement === go ? stay : go).focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    stay.onclick = () => close(false);
    go.onclick = () => close(true);
    overlay.onclick = e => { if (e.target === overlay) close(false); };
  });
}

// Closing the app while agents work: the card lists them and says they
// continue the next time the app opens.
window.deck.onConfirmQuit(confirmQuit);
async function confirmQuit() {
  const working = [...state.agents.values()].filter(a => !a.removed && BUSY.includes(a.status));
  const n = working.length || 1;
  const one = n === 1;
  const ok = await confirmCard({
    title: one ? '1 agent is still working' : `${n} agents are still working`,
    text: `If you quit now, ${one ? 'it stops' : 'they stop'}. The next time you open Agent Hub, ${one ? 'it restarts' : 'they restart'} and ${one ? 'continues' : 'continue'} where ${one ? 'it' : 'they'} left off.`,
    agents: working,
    confirmLabel: 'Quit',
    busyText: 'Quitting…',
  });
  if (ok) window.deck.quit();
}

// Stopping agents yourself (removing them from the Hub, or Close agent)
// while they work asks first, with the same card. Resolves true when there
// is nothing to ask or you confirm.
async function confirmStop(agents, { action, label }) {
  const working = agents.filter(a => a && BUSY.includes(a.status));
  if (!working.length) return true;
  const one = working.length === 1;
  return confirmCard({
    title: one ? `"${working[0].latestTitle || working[0].title}" is still working` : `${working.length} agents are still working`,
    text: `${action} stops ${one ? 'its task' : 'their tasks'} now. ${one ? 'Its session stays' : 'Their sessions stay'} in History, so you can open ${one ? 'it' : 'them'} and continue later.`,
    agents: working,
    confirmLabel: label,
  });
}

// A newer version on GitHub (stable copy only): a button next to the version
// number. Clicking it updates and restarts the app; working agents get the
// same card as quitting and continue after the restart.
window.deck.onUpdate(showUpdate);
function showUpdate(info) {
  const btn = $('app-update');
  btn.classList.toggle('hidden', !info);
  btn.classList.remove('failed');
  if (!info) return;
  btn.disabled = false;
  btn.textContent = info.version ? `v${info.version} available` : 'Update available';
  const what = info.commits.length ? `\n\nWhat's new:\n${info.commits.map(c => `• ${c}`).join('\n')}` : '';
  btn.title = `Click to update and restart (${info.behind} new commit${info.behind === 1 ? '' : 's'}).${what}`;
}

$('app-update').onclick = async () => {
  const btn = $('app-update');
  const working = [...state.agents.values()].filter(a => !a.removed && BUSY.includes(a.status));
  if (working.length) {
    const one = working.length === 1;
    const ok = await confirmCard({
      title: one ? '1 agent is still working' : `${working.length} agents are still working`,
      text: `Updating restarts Agent Hub. ${one ? 'It stops' : 'They stop'} now, then ${one ? 'restarts' : 'restart'} and ${one ? 'continues' : 'continue'} where ${one ? 'it' : 'they'} left off.`,
      agents: working,
      confirmLabel: 'Update and restart',
      busyText: 'Updating…',
    });
    if (!ok) return;
  }
  btn.disabled = true;
  btn.textContent = 'Updating…';
  const result = await window.deck.applyUpdate().catch(err => ({ ok: false, error: String(err) }));
  if (result.ok) return;
  document.querySelector('.quit-modal')?.remove();
  btn.disabled = false;
  btn.classList.add('failed');
  btn.textContent = 'Update failed';
  btn.title = `${result.error}\n\nClick to try again.`;
};

window.deck.onQuitting(() => {
  saveHub();
  state.quitting = true;
});

// ---------- agents ----------

async function startAgent({ cwd, prompt, permissionMode, choice, resume, groupId, fromRect, forkFrom, images = [] }) {
  const title = resume ? resume.session.title : prompt.split('\n')[0].slice(0, 80);
  choice = choice || defaultChoice();
  permissionMode = permissionMode || defaultMode();
  // The agent and its tile exist right away, with the status "starting"
  // ("Booting up…" in the Hub); Claude Code starts in the background. The
  // main process can be busy for a moment, and the tile should not wait for it.
  const id = crypto.randomUUID();

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
  if (forkFrom) {
    agent.forkedFrom = forkFrom;
    transcript.note(`Continues from "${forkFrom.title}", so it knows what that agent did.`);
  }
  transcript.add({ type: 'user', message: { role: 'user', content: userContent(prompt, images) } });
  if (!resume) summarizeTitle(agent, prompt);
  else if (prompt !== RESUME_PROMPT) notePrompt(agent, prompt);
  if (fromRect) {
    // Started from the Hub: stay there and watch the message box become the tile.
    hub.expectArrival(id, fromRect, prompt);
    show('hub');
  } else {
    afterSend(agent, false);
  }

  try {
    await window.deck.startAgent({
      id,
      cwd,
      permissionMode,
      model: choice.model,
      effort: choice.effort,
      fastMode: choice.fastMode,
      resumeId: resume?.session.id || forkFrom?.sessionId,
      forkSession: !resume && !!forkFrom,
    });
  } catch (err) {
    agent.status = 'error';
    transcript.note(`Could not start the agent: ${err?.message || err}`, true);
    refreshHub();
    return;
  }
  await sendToAgent(agent, prompt, images);
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

// A message after the first one: the agent's tile shows it, first as you
// wrote it, then as a short summary (the same kind as the agent's title).
// The full message is in the tile's tooltip.
function notePrompt(agent, text) {
  text = String(text || '').trim();
  if (!text) return;
  agent.latestPrompt = text;
  agent.latestTitle = text.split('\n')[0].slice(0, 80);
  refreshHub();
  saveHub();
  window.deck.summarizeTitle(text).then(title => {
    if (!title || agent.latestPrompt !== text) return;
    agent.latestTitle = title;
    refreshHub();
    saveHub();
  }).catch(() => {});
}

// After you send a message, the Hub shows the agent going (back) to work.
// Set "hubAfterSend": false in Settings to stay in the chat instead.
function afterSend(agent, wake) {
  if (state.config.hubAfterSend === false) {
    show('agent', agent.id);
    return;
  }
  // Sent from the agent's chat (or from a saved session it continues): the
  // chat shrinks back into the tile, the same as with "← Hub", and the tile
  // then hops back to work.
  const cur = state.current;
  const fromChat = (cur?.kind === 'agent' && cur.id === agent.id) || cur?.kind === 'history';
  // The agent reports "working" a moment after it gets the message, which
  // would be in the middle of the animation below. The tile changes look and
  // place then, so the chat would shrink into a picture of the old tile and
  // jump at the end. The tile shows "working" right away instead.
  if (wake && agent.status === 'idle') agent.status = 'working';
  show('hub');
  if (fromChat && agent.view) {
    // The tile of a continued session is new: draw it now, not in the next frame.
    hub.update(hubItems(), null, state.groups.groups);
    // The hop starts once the tile has faded in under the chat's last frame
    // (see returnTo), not at the same time.
    const back = hub.returnTo(agent.id, agent.view).then(() => { if (wake) setTimeout(() => hub.wake(agent.id), 320); });
    continueReview(cur, back);
    return;
  }
  if (wake) requestAnimationFrame(() => requestAnimationFrame(() => hub.wake(agent.id)));
}

// Before each message, remember the state of the files (only in a git
// repository), so that after the turn we can list every file the agent changed.
// Your message as the chat shows it: the text, plus the images you attached.
function userContent(text, images = []) {
  if (!images.length) return text;
  return [{ type: 'text', text }, ...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } }))];
}

async function sendToAgent(agent, text, images = []) {
  // Images and videos changed after this moment count as the task's media.
  // A second of slack covers clocks that round file times.
  if (!agent.mediaSince) agent.mediaSince = Date.now() - 1000;
  if (!agent.snapshot) {
    try { agent.snapshot = await window.deck.gitSnapshot(agent.cwd); } catch { agent.snapshot = null; }
  }
  await window.deck.sendMessage(agent.id, text, images);
}

// ---------- two agents, one file ----------

// While a task runs, the app remembers which files the agent edits or
// writes. When a second working agent edits one of the same files, both
// chats get a warning and both tiles say so, until one of the tasks ends.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function fileKey(cwd, file) {
  let p = String(file).replace(/\\/g, '/');
  if (!/^([a-z]:)?\//i.test(p) && cwd) p = `${cwd.replace(/\\/g, '/').replace(/\/$/, '')}/${p}`;
  return IS_MAC ? p : p.toLowerCase();
}

function noteClashes(agent, message) {
  for (const block of message?.content || []) {
    if (block.type !== 'tool_use' || !EDIT_TOOLS.has(block.name)) continue;
    const file = block.input?.file_path || block.input?.notebook_path;
    if (!file) continue;
    const key = fileKey(agent.cwd, file);
    agent.editing = agent.editing || new Map();
    agent.editing.set(key, file);
    for (const other of state.agents.values()) {
      if (other === agent || other.removed || !BUSY.includes(other.status) || !other.editing?.has(key)) continue;
      addClash(agent, other, key, file);
      addClash(other, agent, key, other.editing.get(key));
    }
  }
}

function addClash(agent, other, key, file) {
  agent.clashes = agent.clashes || new Map();
  const clash = agent.clashes.get(other.id) || { title: other.latestTitle || other.title, files: new Set() };
  agent.clashes.set(other.id, clash);
  if (clash.files.has(key)) return;
  clash.files.add(key);
  const name = String(file).split(SEP).pop();
  agent.transcript.note(`⚠ "${clash.title}" is also changing ${name} in its current task. Check that one change does not undo the other.`);
  sfx('stuck');
  refreshHub();
}

// A task ended: its files are no longer in the way of other agents.
function clearClashes(agent) {
  agent.editing = null;
  for (const otherId of agent.clashes?.keys() || []) {
    const other = state.agents.get(otherId);
    other?.clashes?.delete(agent.id);
  }
  agent.clashes = null;
  refreshHub();
}

// ---------- queued messages ----------

// A message you send while the agent works waits in a queue under the chat
// and goes out when the task ends, one message per task. Until then you can
// edit it, remove it, or send it right away (Claude Code then reads it in
// the middle of the task). After you stop a task yourself, the queue waits
// for you to send it.
const QUEUE_WHILE = ['working', 'stuck', 'starting'];

function queueMessage(agent, text, images) {
  agent.queue = agent.queue || [];
  agent.queue.push({ text, images });
  sfx('attach');
  renderQueue(agent);
  agent.view.scrollTop = agent.view.scrollHeight;
}

function renderQueue(agent) {
  if (!agent.view) return;
  if (!agent.queueBox) {
    agent.queueBox = el('div', 'queue');
    agent.view.appendChild(agent.queueBox);
  }
  const box = agent.queueBox;
  box.innerHTML = '';
  const items = agent.queue || [];
  box.classList.toggle('hidden', !items.length);
  items.forEach((item, i) => {
    const row = el('div', 'queued');
    const text = el('div', 'queued-text', item.text);
    const label = i === 0 ? (agent.queueHeld ? 'Waiting for you: the task was stopped' : 'Sends when the agent is done')
      : `Sends after ${i === 1 ? 'the message above' : `the ${i} messages above`}`;
    const actions = el('div', 'queued-actions');
    const now = el('button', null, 'Send now');
    now.title = 'Send it right away; Claude reads it in the middle of the task';
    now.onclick = () => sendQueued(agent, i);
    const editBtn = el('button', null, 'Edit');
    editBtn.title = 'Take it back into the message box';
    editBtn.onclick = () => {
      agent.queue.splice(i, 1);
      renderQueue(agent);
      const input = $('input');
      input.value = [item.text, input.value].filter(Boolean).join('\n\n');
      autosize();
      input.focus();
    };
    const remove = el('button', 'queued-remove', '×');
    remove.title = 'Remove it from the queue';
    remove.onclick = () => {
      agent.queue.splice(i, 1);
      sfx('detach');
      renderQueue(agent);
    };
    actions.append(el('span', 'queued-label', label), now, editBtn, remove);
    row.append(text, actions);
    box.appendChild(row);
  });
  refreshHub();
}

async function sendQueued(agent, index = 0) {
  const [item] = (agent.queue || []).splice(index, 1);
  if (!item) return;
  agent.queueHeld = false;
  renderQueue(agent);
  sfx('sent');
  agent.transcript.add({ type: 'user', message: { role: 'user', content: userContent(item.text, item.images) } });
  // The queue stays under the newest message.
  if (agent.queueBox) agent.view.appendChild(agent.queueBox);
  notePrompt(agent, item.text);
  if (agent.status === 'idle') agent.status = 'working';
  hub.wake(agent.id);
  await sendToAgent(agent, item.text, item.images);
}

// Your plan's usage, as Claude Code reports it with each agent's replies,
// and the tokens your agents used since the app opened. The last limits are
// remembered, so the Hub shows them right after a restart.
const usage = { limits: null, at: 0, tokens: 0, tasks: 0 };
try { Object.assign(usage, JSON.parse(localStorage.getItem('usageLimits') || '{}'), { tokens: 0, tasks: 0 }); } catch { /* none yet */ }
hub.setUsage({ ...usage });

// The limits also come without an agent: when the app opens, and every 15
// minutes after that if no agent has reported them in the meantime, a tiny
// Claude Code request fetches them (see fetchUsage in agents.js).
const USAGE_REFRESH = 15 * 60 * 1000;
let fetchingUsage = false;
async function refreshUsage() {
  if (fetchingUsage) return;
  fetchingUsage = true;
  try {
    const info = await window.deck.fetchUsage();
    if (info) noteUsage({ type: 'rate_limit_event', rate_limit_info: info });
  } catch { /* the last known numbers stay */ } finally {
    fetchingUsage = false;
  }
}
refreshUsage();
setInterval(() => { if (Date.now() - usage.at >= USAGE_REFRESH) refreshUsage(); }, 60 * 1000);
function noteUsage(msg) {
  if (msg.type === 'rate_limit_event' && msg.rate_limit_info) {
    usage.limits = msg.rate_limit_info;
    usage.at = Date.now();
    try { localStorage.setItem('usageLimits', JSON.stringify({ limits: usage.limits, at: usage.at })); } catch { /* not important */ }
  } else if (msg.type === 'result') {
    usage.tokens += totalTokens(msg.usage || {});
    usage.tasks++;
  } else {
    return;
  }
  hub.setUsage({ ...usage });
}

window.deck.onEvent((id, msg) => {
  noteUsage(msg);
  const a = state.agents.get(id);
  if (!a) return;
  a.transcript.add(msg);
  if (msg.type === 'assistant') noteClashes(a, msg.message);
  if (msg.type === 'result') clearClashes(a);
  // New textures and videos from this task (see showMedia). Your home folder
  // is too big to search.
  if (msg.type === 'result' && a.mediaSince) {
    const since = a.mediaSince;
    const turn = a.transcript.lastFinished;
    a.mediaSince = null;
    if (a.cwd && a.cwd !== state.config.home) {
      window.deck.recentMedia(a.cwd, since).then(files => a.transcript.showMedia(turn, files)).catch(() => {});
    }
  }
  if (msg.type === 'result' && a.snapshot) {
    const snap = a.snapshot;
    const turn = a.transcript.lastFinished;
    a.snapshot = null;
    window.deck.gitChanges(a.cwd, snap)
      .then(diff => a.transcript.showGitChanges(turn, diff, snap.kind === 'folder'))
      .catch(() => {});
  }
  if (msg.type === 'result' && !msg.is_error) {
    // Used to find the most recently finished agent of a Group.
    a.finishedAt = Date.now();
    saveHub();
  }
  if (msg.type === 'result') {
    window.deck.notify(a.id, a.title, msg.is_error ? 'Stopped with an error' : 'Finished and waiting for you');
    if (playSounds()) {
      if (!msg.is_error) sounds.done();
      else if (!a.stopping) sounds.error();
    }
    // The next queued message goes out now, unless you stopped the task.
    if (a.queue?.length) {
      if (a.stopping) {
        a.queueHeld = true;
        renderQueue(a);
      } else {
        setTimeout(() => sendQueued(a), 400);
      }
    }
    a.stopping = false;
  }
  // The context meter: after each task, and at most every 5 seconds while working.
  if (msg.type === 'result' || (msg.type === 'assistant' && Date.now() - (a.contextAt || 0) > 5000)) updateContext(a);
});

window.deck.onStatus((id, status) => {
  const a = state.agents.get(id);
  if (!a) return;
  a.status = status;
  if (status !== 'waiting') a.attention = null;
  // Used by the review queue: the agent that has waited longest goes first.
  if (status === 'waiting') a.waitingSince = a.waitingSince || Date.now();
  else a.waitingSince = null;
  const viewing = state.current?.kind === 'agent' && state.current.id === id;
  if ((status === 'idle' || status === 'error' || status === 'waiting') && !viewing) a.unread = true;
  updateAttention();
  refreshHeaderIfCurrent(id);
  renderSidebar();
});

window.deck.onPermission((id, req) => {
  const a = state.agents.get(id);
  if (!a) return;
  const answer = decision => {
    if (a.pendingQuestion?.requestId === req.requestId) a.pendingQuestion = null;
    window.deck.respondPermission(id, req.requestId, decision);
  };
  // A question from Claude (AskUserQuestion) arrives as a permission request;
  // it gets a card with its options instead of Allow/Deny.
  if (!(state.current?.kind === 'agent' && state.current.id === id)) a.unread = true;
  if (req.tool_name === 'AskUserQuestion' && Array.isArray(req.input?.questions)) {
    a.attention = 'question';
    a.pendingQuestion = { requestId: req.requestId, card: a.transcript.question(req, answer) };
    window.deck.notify(a.id, a.title, `Asks: ${req.input.questions[0]?.question || 'a question'}`);
  } else {
    a.attention = 'approval';
    a.transcript.permission(req, answer);
    window.deck.notify(a.id, a.title, req.title || `Needs approval to use ${req.display_name || req.tool_name}`);
  }
  if (playSounds()) sounds.attention();
  refreshHeaderIfCurrent(id);
  refreshHub();
});

window.deck.onMode((id, mode) => {
  const a = state.agents.get(id);
  if (!a) return;
  a.mode = mode;
  if (state.current?.kind === 'agent' && state.current.id === id) composerModePicker.setValue(mode);
});

// Clicking a notification opens the agent it is about.
window.deck.onNotificationOpen(id => {
  if (state.agents.has(id)) {
    sfx('open');
    show('agent', id);
  }
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
  if (!a || state.quitting) return;
  clearClashes(a);
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
  const typed = input.value.trim();
  const hasFiles = attachments.current().length > 0;
  // Enter in the Hub's empty message box also opens the next agent that needs you.
  if (!typed && !hasFiles && state.current?.kind === 'hub') {
    reviewNext();
    return;
  }
  if ((!typed && !hasFiles) || !state.current) return;
  // While Claude waits for an answer to its question, what you type is the
  // answer; dropped files stay for your next message.
  const waitingAgent = state.current.kind === 'agent' ? state.agents.get(state.current.id) : null;
  if (waitingAgent?.pendingQuestion && typed) {
    input.value = '';
    autosize();
    waitingAgent.pendingQuestion.card.answerWith(typed);
    return;
  }
  input.value = '';
  autosize();
  // Dropped images and videos go with the message; the text names their files.
  const { images, note } = hasFiles ? await attachments.take() : { images: [], note: '' };
  const text = [typed || (images.length ? 'Take a look at the attached files.' : ''), note].filter(Boolean).join('\n\n');
  if (!text) return;

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
    setFolderHidden(d.folder, false);
    state.groups.lastGroupId = d.groupId || undefined;
    saveGroups();
    // The next new agent starts with the same folder and group, and the default model.
    state.draft = null;
    const forkFrom = forkSourceFor(d.folder, d.groupId);
    if (playSounds()) sounds.created();
    await startAgent({ cwd: d.folder, prompt: text, permissionMode: d.mode, choice: d.choice, groupId: d.groupId, fromRect, forkFrom, images });
  } else if (state.current.kind === 'agent') {
    const a = state.agents.get(state.current.id);
    if (QUEUE_WHILE.includes(a.status)) {
      queueMessage(a, text, images);
      return;
    }
    // Messages still queued from a stopped task go first, in order.
    if (a.queue?.length) {
      queueMessage(a, text, images);
      sendQueued(a);
      return;
    }
    sfx('sent');
    a.transcript.add({ type: 'user', message: { role: 'user', content: userContent(text, images) } });
    notePrompt(a, text);
    afterSend(a, true);
    await sendToAgent(a, text, images);
  } else if (state.current.kind === 'history') {
    const h = state.history.get(state.current.id);
    const cwd = h.cwd || h.session.cwd;
    if (!cwd) {
      h.transcript.note('This session has no saved folder, so it cannot be resumed.', true);
      return;
    }
    if (playSounds()) sounds.created();
    await startAgent({ cwd, prompt: text, permissionMode: h.mode, choice: h.choice, resume: h, images });
  }
}

// Sounds when you start an agent and when one finishes (see sounds.js).
function playSounds() {
  return state.config?.sounds !== false;
}

// Plays one of the sounds in sounds.js, unless sounds are off in the
// settings. The other renderer files call it as window.uiSound.
function sfx(name) {
  if (playSounds()) sounds[name]?.();
}
window.uiSound = sfx;

function autosize() {
  const input = $('input');
  input.style.height = 'auto';
  // scrollHeight leaves out the border, which the height includes.
  const border = input.offsetHeight - input.clientHeight;
  input.style.height = Math.min(input.scrollHeight + border, 240) + 'px';
}

$('input').addEventListener('input', autosize);
$('input').addEventListener('keydown', e => {
  // While Claude waits for an answer and the box is empty, 1–9 pick an option.
  const asking = state.current?.kind === 'agent' && state.agents.get(state.current.id)?.pendingQuestion;
  if (asking && !$('input').value && /^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const open = [...asking.card.querySelectorAll('.question')].find(q => !q.querySelector('.question-option.selected')) || asking.card.querySelector('.question');
    const option = open?.querySelectorAll('.question-option')[Number(e.key) - 1];
    if (option && !option.disabled) {
      e.preventDefault();
      option.click();
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (asking && !$('input').value.trim() && asking.card.sendIfComplete?.()) return;
    sendFromComposer();
  }
});
$('send').onclick = sendFromComposer;


// Stops an agent's current task; the agent stays, ready for your next
// message. From the top bar, the message box, or its tile in the Hub.
function interruptAgent(id) {
  const a = state.agents.get(id);
  if (!a || !['working', 'stuck'].includes(a.status)) return;
  // A task you stop yourself ends without the error sound.
  a.stopping = true;
  sfx('stopped');
  window.deck.interrupt(id);
}
$('btn-interrupt').onclick = () => { if (state.current?.kind === 'agent') interruptAgent(state.current.id); };
$('composer-stop').onclick = () => { if (state.current?.kind === 'agent') interruptAgent(state.current.id); };
$('btn-close').onclick = async () => {
  if (state.current?.kind !== 'agent') return;
  const id = state.current.id;
  if (!(await confirmStop([state.agents.get(id)], { action: 'Closing it', label: 'Stop and close' }))) return;
  window.deck.closeAgent(id);
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
  // Enter in the Hub, with no text field active: open the next agent that needs you.
  const typing = e.target.closest?.('input, textarea, select, [contenteditable="true"]');
  if (e.key === 'Enter' && !e.shiftKey && !isMod(e) && !e.altKey && !typing && state.current?.kind === 'hub'
      && !document.querySelector('.group-panel, .model-menu:not(.hidden), .lightbox, .review')) {
    e.preventDefault();
    reviewNext();
  }
  // Tab never moves the focus around the app; it opens the next agent to check.
  if (e.key === 'Tab' && !isMod(e) && !e.altKey) {
    e.preventDefault();
    if (!document.querySelector('.group-panel, .model-menu:not(.hidden), .lightbox, .review')) checkNext();
  }
  // Esc leaves an agent (or a saved session, or a new agent) for the Hub.
  // The Stop button in the top bar stops a running turn.
  if (e.key === 'Escape' && !e.popupWasOpen && ['agent', 'history', 'new'].includes(state.current?.kind)) {
    e.preventDefault();
    backToHub();
  }
  // Alt+← does the same, like "back" in a browser. (On macOS, Option+← in a
  // text field moves the cursor a word, so there it only works outside one.)
  if (e.key === 'ArrowLeft' && e.altKey && !e.shiftKey && !isMod(e) && (!IS_MAC || !typing)
      && !document.querySelector('.quit-modal') && ['agent', 'history', 'new'].includes(state.current?.kind)) {
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

// While the window is on screen, the Hub animates live, also when another
// app has the focus. While it is minimized (or fully hidden), the tiles stay
// as you left them; when you bring it back and it has the focus, the changes
// play one tile after another, so you see what happened while you were away.
// (Only when the Hub is on screen; otherwise the tiles simply catch up.)
const catchUp = () => hub.thaw({ instant: state.current?.kind !== 'hub' });
// Coming back to the app puts the cursor in the message box.
window.addEventListener('focus', () => focusInput());

// The cursor goes to the message box, unless you are typing somewhere else
// (a search, a group name) or a menu, panel or dialog is open.
function focusInput() {
  const active = document.activeElement;
  if (active && active !== $('input') && active.matches?.('input, textarea, select, [contenteditable="true"]')) return;
  if (document.querySelector('.quit-modal, .group-panel, .model-menu:not(.hidden), .lightbox, .review, .usage-rail.open')) return;
  if ($('composer').classList.contains('hidden')) return;
  $('input').focus();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') hub.freeze();
  else if (document.hasFocus()) catchUp();
});
window.addEventListener('focus', catchUp);

// Refresh the "5m ago" labels now and then.
setInterval(renderSidebar, 60_000);

// ---------- stuck agents ----------

// Every few seconds: a working agent whose task looks stuck (see
// Transcript.stuckInfo) gets the status "stuck", and back to "working" once
// it does something else. The limits are in Settings.
function checkStuck() {
  const c = state.config;
  const limits = {
    longMs: (c.stuckAfterSeconds || 30) * 1000,
    repeatCount: c.stuckRepeatCount || 4,
    repeatMs: (c.stuckRepeatSeconds || 30) * 1000,
  };
  for (const a of state.agents.values()) {
    if (!['working', 'stuck'].includes(a.status)) continue;
    const info = a.transcript.stuckInfo(limits);
    if (info && a.status === 'working') {
      a.status = 'stuck';
      sfx('stuck');
      a.stuck = info;
      window.deck.notify(a.title, `Seems stuck: ${info.name} · ${info.summary}`.slice(0, 180));
    } else if (info) {
      a.stuck = info;
    } else if (a.status === 'stuck') {
      a.status = 'working';
      a.stuck = null;
    } else {
      continue;
    }
    refreshHeaderIfCurrent(a.id);
    refreshHub();
  }
}
setInterval(checkStuck, 3000);

(async () => {
  state.config = await window.deck.getConfig();
  // The version next to the title; the dev copy says "dev" after it.
  window.deck.appVersion().then(({ version, dev }) => {
    $('app-version').textContent = `v${version}${dev ? ' dev' : ''}`;
    $('app-version').classList.toggle('dev', dev);
  }).catch(() => {});
  window.deck.latestUpdate().then(showUpdate).catch(() => {});
  loadModels().then(renderSettingsButton);
  try { setSettingsOpen(localStorage.getItem('composerSettingsOpen') === '1'); } catch { setSettingsOpen(false); }
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
  resumeInterrupted();
})();
