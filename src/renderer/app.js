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
  background: 'Running in the background',
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

// ---------- the Auto model (automodel.js) ----------

// The model Claude Code runs for an agent: its choice, or with Auto the one
// Auto picked for it (agent.autoLevel, 1 to 3).
function cliModel(agent) {
  const m = agent.choice?.model;
  return m === 'auto' ? autoModel.modelOf(agent.autoLevel || 2) : m;
}
function cliChoice(agent) {
  return { ...(agent.choice || {}), model: cliModel(agent) };
}
// The model button says what Auto picked for the agent on screen.
function showAutoPick(agent) {
  if (state.current?.kind !== 'agent' || state.current.id !== agent.id) return;
  composerPicker.setResolved(agent.choice?.model === 'auto' && agent.autoLevel ? autoModel.nameOf(cliModel(agent)) : null);
}
// Haiku's rating: its level (or null), and its cost goes into the Auto report.
function rated(r) {
  autoReport.noteRating(r?.cost);
  return r?.level ?? null;
}

// The first message waits for Haiku's rating (at most 5 seconds; Claude Code
// is starting meanwhile), and the model changes before it if the rules and
// Haiku together say so.
async function settleAuto(agent, rating) {
  const haiku = await Promise.race([rating, new Promise(r => setTimeout(() => r(null), 5000))]);
  const before = cliModel(agent);
  agent.autoLevel = autoModel.combine(agent.autoRules, haiku);
  if (cliModel(agent) !== before) window.deck.setModel(agent.id, cliChoice(agent));
  const why = haiku ? `Haiku rated it ${haiku} of 3` : 'from your message';
  agent.transcript.note(`Auto picked ${autoModel.nameOf(cliModel(agent))} (${why}).`);
  showAutoPick(agent);
  refreshHub();
}

function defaultChoice() {
  return {
    model: state.config.defaultModel || 'auto',
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
      if (choice.model === 'auto' && !a.autoLevel) a.autoLevel = autoModel.visual(a.latestPrompt || a.title) ? 3 : autoModel.combine(autoModel.rules(a.latestPrompt || a.title), null);
      window.deck.setModel(a.id, cliChoice(a));
      showAutoPick(a);
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
  // The folder, then the branch its repository is on (see repoBranch).
  const branch = d.folder ? repoBranch(d.folder) : null;
  folder.textContent = d.folder ? '📁 ' + shortPath(d.folder) : '📁 Choose folder';
  if (branch) {
    const tag = el('span', 'composer-branch');
    tag.innerHTML = BRANCH_ICON;
    tag.appendChild(document.createTextNode(branch.name));
    folder.append(' ', tag);
  }
  folder.append(' ▾');
  folder.title = d.folder ? `Folder: ${d.folder}${branch ? `\n${branch.vcs === 'svn' ? 'SVN' : 'Git'} branch: ${branch.name}` : ''}` : 'Pick the folder the agent works in';
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
  fork.title = source ? 'A new agent here continues from this agent: a copy of its conversation when that is short, or a handoff summary of it when it is long.' : '';
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
    state.folderPanelRender = null;
    panel.remove();
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const outside = e => { if (!panel.contains(e.target) && e.target !== $('composer-folder')) close(); };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  // A folder picked here starts with no category (a category belongs to the
  // panel you were on, not to the new folder); pick one after, if you want.
  const pick = folder => {
    d.folder = folder;
    d.groupId = null;
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
      // The branch its repository is on, like on the folder button.
      const branch = repoBranch(f);
      row.append(el('span', 'folder-name', homePath(f)));
      if (branch) {
        const tag = el('span', 'composer-branch folder-branch');
        tag.innerHTML = BRANCH_ICON;
        tag.appendChild(document.createTextNode(branch.name));
        row.title = `${f}\n${branch.vcs === 'svn' ? 'SVN' : 'Git'} branch: ${branch.name}`;
        row.appendChild(tag);
      }
      row.appendChild(remove);
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

  // Branches that arrive while the menu is open show right away.
  state.folderPanelRender = render;
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

// Drop images, videos or sounds on the window (while a message box is shown),
// or paste an image into the message box: they go with your next message (see
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
    if (skipped.length) flashComposerNote(`Only images, videos and sounds can be attached (${skipped.join(', ')} skipped).`);
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
  if ($('input').value.startsWith('/')) learnSlashNames();
  attachments.render();
}

function show(kind, id) {
  // A "You asked" card beside the message box belongs to the chat that was on screen.
  window.homePinBars?.();
  saveInputDraft();
  state.current = { kind, id };
  requestAnimationFrame(updateNextHint);
  $('back-to-hub').classList.toggle('hidden', !['agent', 'history', 'branches'].includes(kind));
  for (const v of $('views').children) v.classList.add('hidden');

  // The Hub also has the message box: a message there starts a new agent.
  const startsAgent = !['agent', 'history'].includes(kind);
  // The Branches view has no message box.
  $('composer').classList.toggle('hidden', kind === 'branches');
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
    setHeader(headerTitle(a), a.cwd, a);
    composerPicker.setValue(a.choice || defaultChoice());
    composerPicker.setResolved(null);
    showAutoPick(a);
    composerModePicker.setValue(a.mode || defaultMode());
    $('input').placeholder = DEFAULT_PLACEHOLDER;
    renderFollowUps();
    $('input').focus();
  } else if (kind === 'branches') {
    branchesView.view.classList.remove('hidden');
    setHeader('Branch diff', state.config?.svnProject ? `${(state.config.svnServer || '').replace(/\/+$/, '')}/${state.config.svnProject}/branches` : '', null);
    branchesView.open(state.config?.svnProject || '');
  } else if (kind === 'history') {
    const h = state.history.get(id);
    h.view.classList.remove('hidden');
    scrollToBottom(h.view);
    const listed = state.parked.get(id) || state.agentList.get(id);
    setHeader(listed?.latestTitle || h.session.title, h.cwd || h.session.cwd, null, findGroup(groupOf(h.session.id))?.name || null);
    composerPicker.setValue(h.choice || defaultChoice());
    composerPicker.setResolved(null);
    composerModePicker.setValue(h.mode || defaultMode());
    $('input').placeholder = 'Send a message to continue this session…';
    $('input').focus();
  } else {
    state.current = { kind: 'hub' };
    $('hub-view').classList.remove('hidden');
    setHeader('Claude HUB', '', null);
    const d = ensureDraft();
    composerPicker.setValue(d.choice);
    composerPicker.setResolved(null);
    composerModePicker.setValue(d.mode);
    renderDraftButtons();
    $('input').placeholder = HUB_PLACEHOLDER;
    renderBroadcast();
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

// ↩ in the Hub's empty message box with no agent to check: the agent chosen
// in the selected group (see hub.moveKeyAgent) opens.
function openKeyAgent() {
  if (hub.keyAgentId && hub.tiles.has(hub.keyAgentId)) hub.open(hub.keyAgentId);
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
// Double-clicking the top bar zooms the window. The system does that itself
// on the bar's drag area; a double-click that still reaches the page (where
// the drag area was not up to date) asks the main process to do the same.
$('topbar').addEventListener('dblclick', e => {
  if (e.target.closest('button, input, a, .status-pill, [contenteditable]')) return;
  window.deck.titleDoubleClick?.();
});
// The retro theme's bezel above the picture counts as the title bar too.
document.addEventListener('dblclick', e => {
  if (e.target.id === 'mu-bezel-top') window.deck.titleDoubleClick?.();
});

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
  onRestart: id => restartAgent(id),
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
    else if (agent.status === 'waiting') (agent.attention === 'question' ? sounds.question : sounds.attention)();
    else if (agent.status === 'error') sounds.error();
  },
  onContext: id => sessionMenu(id.startsWith('p:') ? id.slice(2) : state.agents.get(id)?.sessionId, id),
});

// The Connectors dialog, opened from the Hub's settings button. It lists the
// connectors for the folder the message box points at (connectors can be set
// up for one folder only).
const connectorsDialog = new ConnectorsDialog({
  folder: () => ensureDraft().folder || state.config.home,
});
hub.onOpenConnectors = () => connectorsDialog.open();
// The Branches view: an SVN branch's own changes (renderer/branches.js).
const branchesView = new BranchesView();
hub.onOpenBranches = () => { sfx('open'); show('branches'); };
hub.onOpenSettings = () => showSettings();
hub.onOpenNotes = groupId => openNotesEditor(findGroup(groupId));
hub.onSelect = () => renderBroadcast();

// ---------- command palette (Ctrl+K) ----------

// One box to get anywhere: your agents (on the Hub or not), saved sessions,
// a new agent in a category, a category's notes, /diff, Settings and Your
// activity. Type to filter (letters in order, like "s34" for "Set34 first
// spawner"), ↑ ↓ to move, Enter to go, Esc to close.
function paletteItems() {
  const items = [];
  const cur = state.current?.kind === 'agent' ? state.agents.get(state.current.id)
    : state.current?.kind === 'history' ? state.history.get(state.current.id) : null;
  if (cur) {
    items.push({ icon: '±', label: 'Diff of this branch', hint: '/diff', run: () => { $('input').value = '/diff'; sendFromComposer(); } });
  }
  const seen = new Set();
  for (const item of hubItems()) {
    const group = findGroup(item.groupId);
    if (item.sessionId) seen.add(item.sessionId);
    items.push({
      icon: item.parked ? '○' : '●',
      boost: 40,   // agents on the Hub come before saved sessions
      label: item.latestTitle || item.title,
      hint: [group?.name, item.repo, HUB_STATUS_TEXT[item.status] || item.status].filter(Boolean).join(' · '),
      run: () => hub.onOpen(item.id),
    });
  }
  for (const g of state.groups.groups) {
    items.push({ icon: '+', label: `New agent in ${g.name}`, hint: 'Category', run: () => {
      show('hub');
      const d = ensureDraft();
      d.groupId = g.id;
      const last = hubItems().filter(i => i.groupId === g.id).sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))[0];
      if (last?.cwd) { d.folder = last.cwd; setFolderHidden(last.cwd, false); }
      renderDraftButtons();
      $('input').focus();
    } });
    items.push({ icon: '✎', label: `${g.name} · shared notes`, hint: 'Category', run: () => openNotesEditor(g) });
  }
  items.push({ icon: '⚙', label: 'Settings', hint: '', run: () => showSettings() });
  items.push({ icon: '▤', label: 'Your activity', hint: 'Tokens, charts', run: () => { show('hub'); hub.usageTab.click(); } });
  items.push({ icon: '⌂', label: 'Hub', hint: '', run: () => show('hub') });
  for (const s of state.sessions.slice(0, 300)) {
    if (seen.has(s.id)) continue;
    const group = findGroup(groupOf(s.id));
    items.push({ icon: '↺', label: s.title, hint: [group?.name, shortPath(s.cwd || ''), timeAgo(s.updatedAt)].filter(Boolean).join(' · '), run: () => openHistory(s) });
  }
  return items;
}

// Letters of the query in order; a match at the start of a word scores more.
function paletteScore(query, text) {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const at = t.indexOf(q);
  if (at >= 0) return 100 - at + (at === 0 || /[\s\-_./]/.test(t[at - 1]) ? 50 : 0);
  let score = 0;
  let i = 0;
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) { score += j === 0 || /[\s\-_./]/.test(t[j - 1]) ? 5 : 1; i++; }
  }
  return i === q.length ? score : 0;
}

function openPalette() {
  if (document.querySelector('.palette-modal')) return;
  const all = paletteItems();
  const overlay = el('div', 'quit-modal palette-modal');
  const card = el('div', 'palette');
  const input = el('input', 'palette-input');
  input.placeholder = 'Go to an agent, a session, a category… (↑ ↓, Enter)';
  input.spellcheck = false;
  const list = el('div', 'palette-list');
  card.append(input, list);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));
  input.focus();
  sfx('tick');
  let shown = [];
  let at = 0;
  const draw = () => {
    const q = input.value.trim();
    shown = all.map(it => { const s = paletteScore(q, `${it.label} ${it.hint}`); return { it, s: s > 0 ? s + (it.boost || 0) : 0 }; }).filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s).slice(0, 40).map(x => x.it);
    at = Math.min(at, Math.max(0, shown.length - 1));
    list.replaceChildren();
    shown.forEach((it, i) => {
      const row = el('div', 'palette-row' + (i === at ? ' on' : ''));
      row.append(el('span', 'palette-icon', it.icon), el('span', 'palette-label', it.label), el('span', 'palette-hint', it.hint));
      row.onmouseenter = () => { at = i; for (const [k, r] of [...list.children].entries()) r.classList.toggle('on', k === at); };
      row.onclick = () => go(it);
      list.appendChild(row);
    });
    if (!shown.length) list.appendChild(el('div', 'palette-empty', 'Nothing matches'));
    list.children[at]?.scrollIntoView({ block: 'nearest' });
  };
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 150);
  };
  const go = it => { close(); setHistoryOpen(false); it.run(); };
  const onKey = e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopImmediatePropagation();
      at = (at + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % Math.max(1, shown.length);
      draw();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (shown[at]) go(shown[at]);
    } else if (e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); }
  };
  document.addEventListener('keydown', onKey, true);
  input.addEventListener('input', () => { at = 0; draw(); });
  overlay.onclick = e => { if (e.target === overlay) close(); };
  draw();
}

document.addEventListener('keydown', e => {
  if (isMod(e) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    e.stopImmediatePropagation();
    openPalette();
  }
}, true);

// ---------- feel ----------

// Buttons squish a little while pressed and spring back, a touch past their
// size, when you let go.
document.addEventListener('pointerdown', e => {
  const b = e.target.closest?.('button');
  if (!b || b.disabled || e.button !== 0 || b.classList.contains('hub-health')) return;
  const press = b.animate([{ scale: 1 }, { scale: 0.93 }], { duration: 80, fill: 'forwards', easing: 'ease-out' });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    press.cancel();
    b.animate([{ scale: 0.93 }, { scale: 1.05, offset: 0.55 }, { scale: 1 }], { duration: 300, easing: 'cubic-bezier(.3,1.5,.5,1)' });
  };
  b.addEventListener('pointerup', release, { once: true });
  b.addEventListener('pointerleave', release, { once: true });
}, true);

// Cards (Settings, notes, the palette, questions) grow out of the point you
// clicked, and shrink back into it when they close.
let lastPointer = { x: 0, y: 0, at: 0 };
document.addEventListener('pointerdown', e => { lastPointer = { x: e.clientX, y: e.clientY, at: Date.now() }; }, true);
new MutationObserver(records => {
  for (const r of records) for (const node of r.addedNodes) {
    if (!(node instanceof HTMLElement) || !node.matches('.quit-modal, .settings-modal')) continue;
    const card = node.firstElementChild;
    if (!card || Date.now() - lastPointer.at > 1500) continue;
    card.style.transformOrigin = `${lastPointer.x - card.offsetLeft}px ${lastPointer.y - card.offsetTop}px`;
    node.classList.add('from-click');
  }
}).observe(document.body, { childList: true });

// ---------- reviewing a task's changes ----------

// The agent (or saved session) a Changes card belongs to.
function ownerOfCard(card) {
  for (const a of state.agents.values()) if (a.view?.contains(card)) return { kind: 'agent', id: a.id, agent: a };
  for (const [id, h] of state.history) if (h.view?.contains(card)) return { kind: 'history', id };
  return null;
}

// Commit or Ask for changes, once every file of a card is ticked as reviewed.
window.reviewAction = async (action, card, files) => {
  const owner = ownerOfCard(card);
  if (!owner) return;
  if (action === 'changes') {
    $('input').value = 'Please change this: ';
    autosize();
    $('input').focus();
    return;
  }
  const list = files.map(f => f.path).join(', ');
  const text = `I reviewed the changes of your last task (${list}). Commit them, with a short message that says what changed and why. Commit only these files.`;
  sfx('sent');
  if (owner.kind === 'agent') await sendToHubItem(owner.id, text);
  else await sendToHubItem('p:' + owner.id, text);
  refreshHub();
};

// A task whose changes you reviewed completely counts as seen: Tab skips it.
window.addEventListener('changes-reviewed', e => {
  const owner = ownerOfCard(e.detail.card);
  if (owner?.agent) owner.agent.unread = false;
  if (owner?.kind === 'history' && state.parked.get(owner.id)) state.parked.get(owner.id).unread = false;
  toast('All files reviewed: Commit or Ask for changes');
  refreshHub();
  updateAttention();
});

// ---------- one message to several agents ----------

const HUB_PLACEHOLDER = 'Start a new agent… (↩ to start)';

// Esc in the Hub unselects the tiles first.
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && state.current?.kind === 'hub' && hub.selected.size) {
    e.preventDefault();
    e.stopImmediatePropagation();
    hub.clearSelection();
  }
}, true);

// Ctrl+click tiles (or a panel, for all of its agents) and the Hub's message
// box sends your message to each of them: running agents get it (queued while
// they work), agents that are not running resume their session with it.
function renderBroadcast() {
  let bar = document.getElementById('broadcast');
  if (!bar) {
    bar = el('div', 'broadcast hidden');
    bar.id = 'broadcast';
    document.querySelector('.composer-box').before(bar);
  }
  const ids = [...hub.selected];
  const show = state.current?.kind === 'hub' && ids.length > 0;
  bar.classList.toggle('hidden', !show);
  document.getElementById('composer').classList.toggle('broadcasting', show);
  if (state.current?.kind === 'hub') {
    $('input').placeholder = show ? `Message the ${ids.length} selected agent${ids.length === 1 ? '' : 's'}… (↩ sends to each)` : HUB_PLACEHOLDER;
  }
  if (!show) return;
  const items = hubItems();
  const names = ids.map(id => items.find(i => i.id === id)).filter(Boolean).map(i => i.latestTitle || i.title);
  bar.replaceChildren();
  bar.append(el('span', 'broadcast-count', `To ${ids.length} agent${ids.length === 1 ? '' : 's'}`), el('span', 'broadcast-names', names.join(' · ')));
  const clear = el('button', 'broadcast-clear', 'Clear');
  clear.type = 'button';
  clear.title = 'Unselect them (Esc)';
  clear.onclick = () => hub.clearSelection();
  bar.appendChild(clear);
}

// One agent on the Hub gets your message, the same as from its own chat.
async function sendToHubItem(id, text, images = []) {
  if (id.startsWith('p:')) {
    const sessionId = id.slice(2);
    let session = state.sessions.find(s => s.id === sessionId);
    if (!session) { await loadSessions(); session = state.sessions.find(s => s.id === sessionId); }
    if (!session) return false;
    const h = await loadHistory(session);
    const p = state.parked.get(sessionId);
    await startAgent({ cwd: h.cwd || session.cwd, prompt: text, permissionMode: h.mode || p?.mode, choice: h.choice || p?.choice, resume: h, images });
    return true;
  }
  const a = state.agents.get(id);
  if (!a) return false;
  if (QUEUE_WHILE.includes(a.status) || a.queue?.length) {
    queueMessage(a, text, images);
    if (!QUEUE_WHILE.includes(a.status)) sendQueued(a);
    return true;
  }
  a.transcript.add({ type: 'user', message: { role: 'user', content: userContent(text, images) } });
  notePrompt(a, text);
  if (['idle', 'background'].includes(a.status)) a.status = 'working';
  await sendToAgent(a, text, images);
  return true;
}

// Glowing dots arc from the message box into each tile, which bubbles as
// they land.
function flyToTiles(ids) {
  const box = document.querySelector('.composer-box')?.getBoundingClientRect();
  if (!box) return;
  ids.forEach((id, i) => {
    const tile = hub.tiles.get(id)?.el;
    if (!tile) return;
    const to = tile.getBoundingClientRect();
    const sx = box.left + box.width / 2, sy = box.top + 10;
    const ex = to.left + to.width / 2, ey = to.top + to.height * 0.35;
    const dot = el('div', 'fly-dot');
    document.body.appendChild(dot);
    dot.animate([
      { transform: `translate(${sx}px, ${sy}px) scale(0.6)` },
      { transform: `translate(${(sx + ex) / 2}px, ${Math.min(sy, ey) - 80}px) scale(1.25)`, offset: 0.5 },
      { transform: `translate(${ex}px, ${ey}px) scale(0.4)`, opacity: 0.5 },
    ], { duration: 560, delay: i * 80, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'backwards' }).onfinish = () => {
      dot.remove();
      hub.replay(tile, 'landed', 600);
    };
  });
}

async function broadcast(text, images) {
  const ids = [...hub.selected];
  flyToTiles(ids);
  hub.clearSelection();
  sfx('sent');
  let sent = 0;
  for (const id of ids) {
    try { if (await sendToHubItem(id, text, images)) sent++; } catch (err) { console.error('Could not send to', id, err); }
  }
  show('hub');
  refreshHub();
  for (const id of ids) if (!id.startsWith('p:')) requestAnimationFrame(() => hub.wake(id));
  toast(`Sent to ${sent} agent${sent === 1 ? '' : 's'}`);
}


// Your Claude Code activity, shown in the Hub while it has no agents. It is
// read at startup and again when the empty Hub shows and the numbers are
// older than 10 minutes.
// The usage card (the Usage tab on the Hub's left edge) shows the same
// numbers in a smaller view, also when the Hub has agents.
// The charts group tokens by the category of each session.
ActivityPanel.categoryOf = id => {
  const g = findGroup(groupOf(id) || state.agentList.get(id)?.groupId);
  return g ? { key: g.id, name: g.name } : null;
};
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
    const busy = agents.filter(a => BUSY.includes(a.status)).length;
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
    // Moved to cwd, but its session is still in the old folder (moveToFolder).
    moved: !!a.moved,
    groupId: a.groupId || groupOf(a.sessionId) || null,
    choice: a.choice,
    autoLevel: a.autoLevel || undefined,
    mode: a.mode,
    lastTurn: a.transcript?.lastTurn ? { durationMs: a.transcript.lastTurn.durationMs, usage: a.transcript.lastTurn.usage } : a.lastTurn || null,
    // Finished while you were not looking, and not opened since.
    unread: !!a.unread,
    finishedAt: a.finishedAt || 0,
    // Busy when this was saved. If the app quits now, the agent continues
    // the next time the app opens (see resumeInterrupted).
    wasWorking: ['working', 'starting', 'waiting', 'stuck'].includes(a.status),
    // Stopped before it was done (see restartAgent).
    stopped: !!a.stopped,
  };
}

// An agent that is not running, in the shape the Hub expects from a running
// one. It shows as completed (green, with a check mark), the same as an agent
// that has just finished its task.
function parkedItem(p) {
  return {
    id: 'p:' + p.sessionId,
    parked: true,
    limited: limitOf(p),
    authWait: isAuthWaiting(p),
    status: 'idle',
    title: p.title,
    latestPrompt: p.latestPrompt,
    latestTitle: p.latestTitle,
    cwd: p.cwd,
    groupId: groupOf(p.sessionId) || p.groupId,
    sessionId: p.sessionId,
    choice: p.choice,
    autoLevel: p.autoLevel,
    finishedAt: p.finishedAt || 0,
    unread: !!p.unread,
    stopped: !!p.stopped,
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
// Agents without a category are separate tasks: they still share a panel per
// repository on the Hub, but a new one starts fresh, not as a fork.
function forkSourceFor(cwd, categoryId) {
  if (!cwd) return null;
  const known = id => state.groups.groups.some(g => g.id === id);
  const category = known(categoryId) ? categoryId : null;
  if (!category) return null;
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
  for (const item of items) { item.repo = repoName(item.cwd); item.repoRoot = repoRootName(item.cwd); }
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
const repoNames = new Map();   // folder -> repository name (plus the folder inside it)
const repoRoots = new Map();   // folder -> the repository's own name, for its container in the Hub
function repoName(cwd) {
  if (!cwd) return '';
  if (!repoNames.has(cwd)) {
    repoNames.set(cwd, shortPath(cwd));
    window.deck.repoOf(cwd).then(r => {
      const root = r?.root ? r.root.split(SEP).filter(Boolean).pop() : null;
      if (r && (r.name !== repoNames.get(cwd) || root !== repoRoots.get(cwd))) {
        repoNames.set(cwd, r.name);
        if (root) repoRoots.set(cwd, root);
        refreshHub();
      }
    }).catch(() => {});
  }
  return repoNames.get(cwd);
}
function repoRootName(cwd) {
  return repoRoots.get(cwd) || repoName(cwd);
}

// The branch a folder's repository is on, for its container in the Hub.
// Asked again when the answer is over 20 seconds old, so switching branches
// shows up.
const repoBranches = new Map();   // folder -> { branch, at, asking }
const BRANCH_ICON = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="7" r="2.2"/><path d="M6 7.2v9.6M18 9.2c0 4.5-6 3.8-11 7.6"/></svg>';
function repoBranch(cwd) {
  if (!cwd || !window.deck.repoBranch) return null;
  const known = repoBranches.get(cwd) || { branch: null, at: 0, asking: false };
  repoBranches.set(cwd, known);
  if (!known.asking && Date.now() - known.at > 20000) {
    known.asking = true;
    window.deck.repoBranch(cwd).then(b => {
      const name = b?.name || null;
      const changed = name !== known.branch?.name || b?.vcs !== known.branch?.vcs;
      known.branch = name ? b : null;
      known.at = Date.now();
      known.asking = false;
      if (changed) {
        refreshHub();
        renderDraftButtons();
        state.folderPanelRender?.();
      }
    }).catch(() => { known.asking = false; known.at = Date.now(); });
  }
  return known.branch;
}

// ---------- the list of every agent you have had ----------

// agents.json in the main process (see agentlist.js), by session id: the
// title, folder, category and whether the agent is on the Hub. The Hub (in
// local storage) and the categories (groups.json) rebuild from it when
// they lost something, and History uses it to bring agents back.
state.agentList = new Map();
let agentListReady = false;
let hubSynced = new Set();   // sessions the list has as on the Hub
let agentListTimer = null;

async function loadAgentList() {
  const list = await window.deck.listAgents().catch(() => []);
  state.agentList = new Map(list.map(e => [e.sessionId, e]));
  let groupsChanged = false;
  for (const e of list) {
    // A category that is gone from groups.json without being deleted here
    // (another copy of the app saved over it) comes back.
    if (e.groupId && e.groupName && !findGroup(e.groupId)) {
      state.groups.groups.push({ id: e.groupId, name: e.groupName, collapsed: false });
      groupsChanged = true;
    }
    if (e.groupId && findGroup(e.groupId) && !state.groups.assignments[e.sessionId]) {
      state.groups.assignments[e.sessionId] = e.groupId;
      groupsChanged = true;
    }
    if (e.inHub && !state.parked.has(e.sessionId)) state.parked.set(e.sessionId, parkedFromList(e));
    // Removed from the Hub (here or in the other copy of the app, which has
    // its own saved Hub): it stays off, also when this copy's saved Hub
    // still has it.
    if (e.inHub === false && state.parked.has(e.sessionId)) state.parked.delete(e.sessionId);
  }
  hubSynced = new Set(list.filter(e => e.inHub).map(e => e.sessionId));
  agentListReady = true;
  if (groupsChanged) saveGroups();
}

// When you come back to the window: what the other copy of the app (the
// dev one, or the stable one) changed on the Hub since. An agent it removed
// leaves this Hub too, one it added appears; agents running here stay.
async function reconcileHub() {
  if (!agentListReady) return;
  const list = await window.deck.listAgents().catch(() => null);
  if (!list) return;
  const running = new Set([...state.agents.values()].filter(a => !a.removed).map(a => a.sessionId).filter(Boolean));
  let changed = false;
  for (const e of list) {
    state.agentList.set(e.sessionId, e);
    if (running.has(e.sessionId)) continue;
    if (e.inHub === false && hubSynced.has(e.sessionId)) {
      hubSynced.delete(e.sessionId);
      if (state.parked.delete(e.sessionId)) changed = true;
    } else if (e.inHub && !hubSynced.has(e.sessionId) && !state.parked.has(e.sessionId)) {
      hubSynced.add(e.sessionId);
      state.parked.set(e.sessionId, parkedFromList(e));
      changed = true;
    }
  }
  if (!changed) return;
  try { localStorage.setItem('hubAgents', JSON.stringify([...state.parked.values()])); } catch { /* not important */ }
  refreshHub();
}
window.addEventListener('focus', () => { reconcileHub(); });

function parkedFromList(e) {
  const { inHub, updatedAt, groupName, ...p } = e;
  return { ...p, wasWorking: false };
}

// After each change of the Hub: the agents on it, with what the list keeps,
// and the ones that left it.
function syncAgentList(list, { now = false } = {}) {
  if (!agentListReady) return;
  clearTimeout(agentListTimer);
  const write = () => {
    const on = new Set(list.map(p => p.sessionId));
    // "On the Hub" is written only for agents this copy put there since its
    // last write. Another copy of the app (dev and stable keep their own
    // saved Hub) that still lists an agent you removed here would otherwise
    // write it back on every change of its own Hub.
    const entries = list.map(p => ({ ...p, ...(hubSynced.has(p.sessionId) ? {} : { inHub: true }), groupName: findGroup(p.groupId)?.name || null, lastActiveAt: Math.max(p.finishedAt || 0, state.agentList.get(p.sessionId)?.lastActiveAt || 0) || Date.now() }));
    for (const sid of hubSynced) if (!on.has(sid)) entries.push({ sessionId: sid, inHub: false });
    hubSynced = on;
    rememberAgents(entries);
  };
  // When the app quits it is written right away: the app is gone before 400 ms.
  if (now) write();
  else agentListTimer = setTimeout(write, 400);
}

function rememberAgents(entries) {
  for (const e of entries) state.agentList.set(e.sessionId, { ...(state.agentList.get(e.sessionId) || {}), ...e });
  window.deck.rememberAgents(entries).catch(() => {});
}

// From History: a session goes (back) on the Hub as a completed tile.
function bringBackToHub(session, { quiet = false } = {}) {
  const e = state.agentList.get(session.id) || {};
  state.parked.set(session.id, parkedFromList({
    ...e,
    sessionId: session.id,
    title: e.title || session.title,
    cwd: e.cwd || session.cwd,
    groupId: groupOf(session.id) || e.groupId || null,
    finishedAt: e.finishedAt || session.updatedAt || Date.now(),
    unread: false,
  }));
  if (quiet) return;
  saveHub();
  refreshHub();
  renderHistory();
  toast(`"${e.title || session.title}" is back on the Hub`);
}

// From History: every agent of a category that is not on the Hub goes back there.
function bringGroupToHub(group) {
  const sessions = state.sessions.filter(s => groupOf(s.id) === group.id && !isOnHub(s.id));
  if (!sessions.length) return toast(`Every agent of ${group.name} is on the Hub`);
  for (const s of sessions) bringBackToHub(s, { quiet: true });
  saveHub();
  refreshHub();
  renderHistory();
  toast(`${sessions.length} ${sessions.length === 1 ? 'agent' : 'agents'} of ${group.name} back on the Hub`);
}

function isOnHub(sessionId) {
  return state.parked.has(sessionId) || [...state.agents.values()].some(a => a.sessionId === sessionId && !a.removed);
}

// Saved in the window's local storage, which survives restarts. Running
// agents are saved too, so after a restart they come back as completed tiles.
function saveHub({ now = false } = {}) {
  const list = [];
  for (const a of state.agents.values()) if (!a.removed && a.sessionId) list.push(hubInfo(a));
  const live = new Set(list.map(p => p.sessionId));
  for (const p of state.parked.values()) if (!live.has(p.sessionId)) list.push(p);
  try { localStorage.setItem('hubAgents', JSON.stringify(list)); } catch { /* not important */ }
  syncAgentList(list, { now });
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
  if (h && p?.moved && p.moveNote && !h.moveNoted) {
    h.moveNoted = true;
    h.transcript.note(p.moveNote);
  }
  if (h && p) {
    h.choice = h.choice || p.choice;
    h.autoLevel = h.autoLevel || p.autoLevel;
    h.mode = h.mode || p.mode;
    composerPicker.setValue(h.choice || defaultChoice());
    composerPicker.setResolved(null);
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

// The top bar names an agent the way its Hub tile does: the summary of your
// latest message, with the task (its first message) in the tooltip.
function headerTitle(a) {
  return a.latestTitle || a.title;
}

// category: the name of the category (for a saved session; an agent's
// comes from the agent). It stands before the title, as on the Hub.
function setHeader(title, subtitle, agent, category = null) {
  const cat = $('view-category');
  const name = category || (agent ? findGroup(agent.groupId || groupOf(agent.sessionId))?.name : null);
  cat.textContent = name ? `# ${name}` : '';
  cat.title = name ? `Category: ${name}` : '';
  cat.classList.toggle('hidden', !name);
  $('view-title').textContent = title;
  $('view-title').title = agent && agent.title !== title ? `Task: ${agent.title}` : '';
  renderFollowUps();
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
  renderUndoButton(agent);
  renderUnityButton();
  renderRestartButton();
  $('btn-close').classList.toggle('hidden', !agent || agent.status === 'exited');
}

function refreshHeaderIfCurrent(agentId) {
  if (state.current?.kind === 'agent' && state.current.id === agentId) {
    const a = state.agents.get(agentId);
    setHeader(headerTitle(a), a.cwd, a);
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
  rememberAgents([{ sessionId, groupId: groupId || null, groupName: findGroup(groupId)?.name || null }]);
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
  const left = [];
  for (const [sid, gid] of Object.entries(state.groups.assignments)) {
    if (gid === groupId) { delete state.groups.assignments[sid]; left.push(sid); }
  }
  // The list forgets the category too, so it does not bring it back.
  const listed = [...state.agentList.values()].filter(e => e.groupId === groupId).map(e => e.sessionId);
  rememberAgents([...new Set([...left, ...listed])].map(sessionId => ({ sessionId, groupId: null, groupName: null })));
  if (state.groups.lastGroupId === groupId) delete state.groups.lastGroupId;
  saveGroups();
  renderSidebar();
}


// ---------- shared notes of a group ----------

// Every agent in a category reads the category's notes, and after each task
// Haiku adds what the agent learned to them (mergeNotes in agents.js). The
// notes live with the groups: group.notes = { text, rev, history }, where
// history keeps the last changes ({ rev, prev, text, by, at }) for undo.
// group.shareLearnings === false turns both off for the category.
const NOTES_HISTORY = 30;

function findGroup(groupId) {
  return groupId ? state.groups.groups.find(g => g.id === groupId) || null : null;
}

function sharesNotes(group) {
  return !!group && group.shareLearnings !== false;
}

// Changes the notes and keeps the change for undo. Returns the change.
function setGroupNotes(group, text, by) {
  const prev = group.notes?.text || '';
  text = text.trim();
  if (text === prev.trim()) return null;
  const rev = (group.notes?.rev || 0) + 1;
  const change = { rev, prev, text, by, at: Date.now() };
  group.notes = { text, rev, history: [...(group.notes?.history || []), change].slice(-NOTES_HISTORY) };
  saveGroups();
  refreshHub();
  return change;
}

// Which version of its group's notes each session has read, by session id,
// so a resumed session gets them again only when they changed.
function seenNotes() {
  try { return JSON.parse(localStorage.getItem('groupNotesSeen') || '{}'); } catch { return {}; }
}

function rememberNotesSeen(agent) {
  if (!agent.sessionId || !agent.notesSeen) return;
  const seen = seenNotes();
  seen[agent.sessionId] = agent.notesSeen;
  try { localStorage.setItem('groupNotesSeen', JSON.stringify(seen)); } catch { /* not important */ }
}

// The notes in front of a message to the agent, when it has not read this
// version yet ('' otherwise). The chat leaves them out of your message
// (stripGroupNotes in render.js).
function notesBlock(agent) {
  const group = findGroup(agent.groupId);
  const notes = group?.notes?.text?.trim();
  if (!sharesNotes(group) || !notes) return '';
  const stamp = `${group.id}:${group.notes.rev}`;
  const seen = agent.notesSeen || (agent.sessionId ? seenNotes()[agent.sessionId] : null);
  if (seen === stamp) return '';
  const updated = !!seen && seen.startsWith(group.id + ':');
  agent.notesSeen = stamp;
  rememberNotesSeen(agent);
  return `<group-notes category="${group.name.replace(/"/g, '\'')}">\n`
    + `${updated ? 'The shared notes of your category changed since you last read them. They now are:' : 'Shared notes of your category, collected from the other agents\' tasks and edited by the user. Use them as hints and check them when they matter.'}\n`
    + `${notes}\n</group-notes>\n\n`;
}

// A compacted conversation may have lost the notes in its summary: they go
// to the agent again, right away when it is in the middle of a task (Claude
// reads them at its next step), or else with your next message.
function afterCompact(agent) {
  agent.notesSeen = 'compacted';
  rememberNotesSeen(agent);
  if (!['working', 'starting', 'waiting', 'stuck'].includes(agent.status)) return;
  const block = notesBlock(agent);
  if (block) window.deck.sendMessage(agent.id, block.trim(), []).catch(() => {});
}

// After a task: Haiku merges what the agent learned into its group's notes.
// Merges for one group run one after the other, each on the newest notes.
const notesMerges = new Map();   // group id -> promise of the last merge

function learnFrom(agent, turn, answer) {
  const group = findGroup(agent.groupId);
  if (!sharesNotes(group) || !turn || !answer?.trim()) return;
  const task = agent.transcript.prompts.filter(p => p.turn === turn || p.turn?.el === turn.el).pop()?.text
    || agent.transcript.prompts[agent.transcript.prompts.length - 1]?.text || '';
  const files = (turn.files || []).map(f => f.path);
  // What the agent said along the way (what failed, what it tried instead),
  // the newest part when it is long, then its final message.
  const said = (turn.texts || []).filter(t => t.trim() !== answer.trim()).join('\n\n').slice(-8000);
  const messages = said ? `${said}\n\n--- final message ---\n${answer}` : answer;
  const run = async () => {
    const before = group.notes?.text || '';
    const merged = await window.deck.mergeNotes({ notes: before, category: group.name, task, answer: messages, files }).catch(() => null);
    if (!merged || !findGroup(group.id)) return;
    const change = setGroupNotes(group, merged, agent.title);
    if (change) showNotesChange(agent, turn, group, change);
  };
  const next = (notesMerges.get(group.id) || Promise.resolve()).then(run, run);
  notesMerges.set(group.id, next);
}

// The lines one version of the notes has and the other has not.
function notesDiff(before, after) {
  const a = before.split('\n').filter(l => l.trim());
  const b = after.split('\n').filter(l => l.trim());
  return { added: b.filter(l => !a.includes(l)), removed: a.filter(l => !b.includes(l)) };
}

// "Category notes updated" under the agent's answer: what changed, Undo, and
// a way to see or edit all the notes.
function showNotesChange(agent, turn, group, change) {
  if (!turn?.answer) return;
  const { added, removed } = notesDiff(change.prev, change.text);
  const box = el('details', 'notes-change');
  const summary = el('summary');
  summary.append(el('span', 'notes-change-title', `${group.name} notes updated`),
    el('span', 'notes-change-count', [added.length && `+${added.length}`, removed.length && `−${removed.length}`].filter(Boolean).join(' ')));
  const list = el('div', 'notes-change-lines');
  for (const l of removed) list.appendChild(el('div', 'del', l));
  for (const l of added) list.appendChild(el('div', 'add', l));
  const actions = el('div', 'notes-change-actions');
  const edit = el('button', null, 'See all notes');
  edit.onclick = () => openNotesEditor(group);
  const undo = el('button', null, 'Undo');
  undo.onclick = () => {
    undoNotesChange(group, change);
    box.classList.add('undone');
    summary.querySelector('.notes-change-title').textContent = `${group.name} notes: change undone`;
    undo.remove();
  };
  actions.append(edit, undo);
  box.append(summary, list, actions);
  agent.transcript.pinned(() => turn.answer.appendChild(box));
}

// Undo one change: the notes as they were, when nothing changed them since;
// otherwise its lines are taken out again and the lines it removed come back.
function undoNotesChange(group, change) {
  const now = group.notes?.text || '';
  if (group.notes?.rev === change.rev) return setGroupNotes(group, change.prev, 'Undo');
  const { added, removed } = notesDiff(change.prev, change.text);
  const lines = now.split('\n').filter(l => l.trim() && !added.includes(l));
  for (const l of removed) if (!lines.includes(l)) lines.push(l);
  return setGroupNotes(group, lines.join('\n'), 'Undo');
}

// A card to read and edit a category's notes, and to turn sharing off.
function openNotesEditor(group) {
  if (!group || document.querySelector('.quit-modal')) return;
  const overlay = el('div', 'quit-modal notes-modal');
  const card = el('div', 'quit-card notes-card');
  const text = el('p', 'quit-text', 'Every agent in this category reads these notes. After each task, what the agent learned is added to them. One note per line.');
  const area = el('textarea', 'notes-text');
  area.value = group.notes?.text || '';
  area.placeholder = '- The Unity bridge listens on port 7891';
  area.spellcheck = false;
  const last = group.notes?.history?.[group.notes.history.length - 1];
  const meta = el('div', 'notes-meta', last ? `Last change: ${last.by || 'you'}, ${new Date(last.at).toLocaleString()}` : 'No notes yet.');
  const share = el('label', 'notes-share');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = sharesNotes(group);
  share.append(box, el('span', null, 'Share notes and add learnings after each task'));
  const buttons = el('div', 'quit-buttons');
  const cancel = el('button', 'quit-stay', 'Cancel');
  const save = el('button', 'quit-go', 'Save');
  buttons.append(cancel, save);
  card.append(el('div', 'quit-title', `${group.name} · shared notes`), text, area, meta, share, buttons);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));
  area.focus();
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 200);
  };
  const onKey = e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
    if (e.key === 'Enter' && isMod(e)) { e.preventDefault(); e.stopImmediatePropagation(); save.click(); }
  };
  document.addEventListener('keydown', onKey, true);
  cancel.onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };
  save.onclick = () => {
    if (box.checked) delete group.shareLearnings;
    else group.shareLearnings = false;
    if (!setGroupNotes(group, area.value, 'you')) saveGroups();
    refreshHub();
    close();
  };
}

// The menu shown when you right-click a session in History or Running.
// hubId: the Hub tile the menu is for (its agent can move to another folder).
async function sessionMenu(sessionId, hubId = null) {
  if (!sessionId) return;
  const current = groupOf(sessionId);
  const moving = hubId ? folderMenu(hubId) : null;
  const items = [
    ...(moving ? [moving, { type: 'separator' }] : []),
    {
      label: 'Move to category',
      submenu: [
        ...state.groups.groups.map(g => ({ id: 'g:' + g.id, label: g.name, checked: g.id === current })),
        ...(state.groups.groups.length ? [{ type: 'separator' }] : []),
        { id: 'new', label: 'New category…' },
      ],
    },
    { id: 'remove', label: 'Remove from category', enabled: !!current },
    { type: 'separator' },
    // Its Claude Code session id, to name it to an agent (its transcript is
    // ~/.claude/projects/<folder>/<id>.jsonl).
    { id: 'copy-id', label: 'Copy agent id' },
    { type: 'separator' },
    { id: 'forget', label: 'Remove from History…', enabled: !runningSession(sessionId) },
  ];
  const picked = await window.deck.popupMenu(items);
  if (!picked) return;
  if (picked === 'forget') { removeFromHistory([sessionId]); return; }
  if (picked === 'copy-id') { window.deck.copyText(sessionId); sfx('select'); return; }
  if (picked.startsWith('folder:') || picked === 'folder-pick') {
    const folder = picked === 'folder-pick' ? await window.deck.pickFolder() : picked.slice(7);
    if (folder) moveToFolder(hubId, folder);
    return;
  }
  if (picked === 'remove') assignGroup(sessionId, null);
  else if (picked === 'new') assignGroup(sessionId, createGroup().id);
  else assignGroup(sessionId, picked.slice(2));
}

// ---------- removing agents from History ----------

// Removes saved sessions from History, and from the Hub when they are on it,
// and leaves them out of Your activity (the token graphs). Claude Code's own
// session files stay (removedsessions.js keeps the list), so Undo puts
// everything back. Agents that are running are not removed. With group: the
// category goes too, unless one of its agents is running.
function runningSession(sessionId) {
  return [...state.agents.values()].some(a => a.sessionId === sessionId && !a.removed);
}

async function removeFromHistory(ids, { group = null } = {}) {
  ids = ids.filter(id => !runningSession(id));
  const running = group ? [...state.agents.values()].filter(a => !a.removed && a.groupId === group.id).length : 0;
  if (!ids.length && !group) return;
  const titles = ids.map(id => state.sessions.find(s => s.id === id)?.title).filter(Boolean);
  const one = ids.length === 1;
  const ok = await confirmCard({
    title: group ? `Remove ${group.name} from History?` : one ? `Remove "${titles[0] || 'this agent'}" from History?` : `Remove ${ids.length} agents from History?`,
    text: `${ids.length ? `${one ? 'It leaves' : `Its ${ids.length} agents leave`} History and the Hub, and ${one ? 'its' : 'their'} tokens and messages no longer count in Your activity. ` : ''}`
      + `${group && !running ? 'The category is deleted too. ' : ''}${running ? `${running} running agent${running === 1 ? ' stays' : 's stay'}, and so does the category. ` : ''}`
      + 'Claude Code keeps the conversation files, so you can undo this right after.',
    lines: group ? titles.slice(0, 8).concat(titles.length > 8 ? [`and ${titles.length - 8} more`] : []) : [],
    confirmLabel: 'Remove',
    stayLabel: 'Cancel',
  });
  if (!ok) return;
  const before = { parked: ids.map(id => state.parked.get(id)).filter(Boolean), group: group && !running ? { ...group } : null,
    assignments: Object.fromEntries(ids.map(id => [id, state.groups.assignments[id]]).filter(([, g]) => g)) };
  for (const id of ids) {
    state.parked.delete(id);
    if (state.current?.kind === 'history' && state.current.id === id) show('hub');
    state.history.delete(id);
  }
  if (before.parked.length) rememberAgents(before.parked.map(p => ({ sessionId: p.sessionId, inHub: false })));
  if (before.group) deleteGroup(group.id);
  await window.deck.removeFromHistory(ids).catch(() => {});
  saveHub();
  refreshHub();
  await loadSessions();
  // A category left without agents (none in History, none running) goes too.
  before.emptied = [];
  for (const gid of new Set(Object.values(before.assignments))) {
    const g = findGroup(gid);
    if (!g || (before.group && before.group.id === gid)) continue;
    const left = state.sessions.some(s => groupOf(s.id) === gid) || [...state.agents.values()].some(a => !a.removed && a.groupId === gid) || [...state.parked.values()].some(p => (groupOf(p.sessionId) || p.groupId) === gid);
    if (left) continue;
    before.emptied.push({ ...g });
    deleteGroup(gid);
  }
  sfx('close');
  const gone = before.emptied.length ? ` · ${before.emptied.map(g => g.name).join(', ')} had no agents left and is removed too` : '';
  toastAction((group ? `Removed ${group.name} from History` : one ? 'Removed from History' : `Removed ${ids.length} agents from History`) + gone, 'Undo', async () => {
    await window.deck.restoreToHistory(ids).catch(() => {});
    if (before.group || before.emptied.length) {
      for (const g of [before.group, ...before.emptied].filter(Boolean)) if (!findGroup(g.id)) state.groups.groups.push(g);
      Object.assign(state.groups.assignments, before.assignments);
      saveGroups();
    }
    for (const p of before.parked) state.parked.set(p.sessionId, p);
    if (before.parked.length) rememberAgents(before.parked.map(p => ({ sessionId: p.sessionId, inHub: true })));
    saveHub();
    refreshHub();
    await loadSessions();
  });
}

// A message at the bottom with one button (Undo), for a few seconds longer
// than a plain toast.
function toastAction(text, label, action) {
  document.querySelector('.toast')?.remove();
  const node = el('div', 'toast toast-action', text);
  const btn = el('button', 'toast-btn', label);
  btn.onclick = () => { node.remove(); action(); };
  node.appendChild(btn);
  document.body.appendChild(node);
  requestAnimationFrame(() => node.classList.add('show'));
  setTimeout(() => {
    node.classList.remove('show');
    setTimeout(() => node.remove(), 300);
  }, 7000);
}

// ---------- moving an agent to another folder ----------

// An agent works in the folder it was started in, and the Changes card only
// looks there. "Move to folder" (the tile's menu) moves it: with your next
// message it starts again in the new folder, continuing a copy of its
// conversation (Claude Code resumes it there with --fork-session). Until
// then it is marked as moving (agent.moved / a parked agent's moved), so the
// move also holds when the app restarts in between.
function hubAgentFor(hubId) {
  return hubId.startsWith('p:') ? state.parked.get(hubId.slice(2)) : state.agents.get(hubId);
}

function folderMenu(hubId) {
  const a = hubAgentFor(hubId);
  if (!a) return null;
  const live = !hubId.startsWith('p:');
  const busy = live && BUSY.includes(a.status) && a.status !== 'background';
  const here = (a.cwd || '').replace(/[\\/]+$/, '').toLowerCase();
  const others = recentFolders().filter(f => f.replace(/[\\/]+$/, '').toLowerCase() !== here).slice(0, 8);
  return {
    label: busy ? 'Move to folder (when it is not working)' : 'Move to folder',
    enabled: !busy,
    submenu: [
      ...others.map(f => ({ id: 'folder:' + f, label: homePath(f) })),
      ...(others.length ? [{ type: 'separator' }] : []),
      { id: 'folder-pick', label: 'Choose folder…' },
    ],
  };
}

function moveToFolder(hubId, folder) {
  const a = hubAgentFor(hubId);
  if (!a || !folder) return;
  if (!hubId.startsWith('p:') && BUSY.includes(a.status) && a.status !== 'background') return;
  const from = a.cwd;
  if ((from || '').toLowerCase() === folder.toLowerCase()) return;
  a.cwd = folder;
  a.moved = true;
  sfx('select');
  const note = `Moves to ${homePath(folder)} with your next message, continuing this conversation there. It worked in ${homePath(from || '?')} until now.`;
  if (a.transcript) {
    a.transcript.note(note);
    refreshHeaderIfCurrent(a.id);
  } else {
    // A parked agent: the note shows when you open it (see openParked).
    a.moveNote = note;
  }
  refreshHub();
  saveHub();
}

// Moves a whole group (a category in one folder, a panel on the Hub) to
// another folder, so its agents continue their work in another repository:
// each one moves like with Move to folder, and continues its conversation
// there with your next message. Agents that are working right now move
// once they are done (agent.moveWhenDone, see the status handler). A
// message box pointing at the group follows it.
async function moveGroup(ids, from, groupId) {
  if (!ids.length) return;
  const here = (from || '').replace(/[\\/]+$/, '').toLowerCase();
  const others = recentFolders().filter(f => f.replace(/[\\/]+$/, '').toLowerCase() !== here).slice(0, 8);
  const group = findGroup(groupId);
  const picked = await window.deck.popupMenu([
    { label: `Move ${group ? group.name : 'this group'} (${ids.length} agent${ids.length === 1 ? '' : 's'}) to`, enabled: false },
    ...others.map(f => ({ id: 'folder:' + f, label: homePath(f) })),
    ...(others.length ? [{ type: 'separator' }] : []),
    { id: 'folder-pick', label: 'Choose folder…' },
  ]);
  if (!picked) return;
  const folder = picked === 'folder-pick' ? await window.deck.pickFolder() : picked.slice(7);
  if (folder) moveGroupTo(ids, from, groupId, folder);
}

// A group's panel dropped on another repository's container on the Hub:
// the group moves to the same folder inside that repository when it has one
// (MyGame/Unity dropped on MyGame2: MyGame2/Unity), else to the folder the
// repository's own panels use.
async function dropGroupOnRepo(ids, from, groupId, targetCwds) {
  if (!ids.length || !from || !targetCwds.length) return;
  let folder = targetCwds[0];
  try {
    const [src, dst] = await Promise.all([window.deck.repoOf(from), window.deck.repoOf(targetCwds[0])]);
    const sep = window.deck.platform === 'win32' ? '\\' : '/';
    const rel = src?.root && from.toLowerCase().startsWith(src.root.toLowerCase()) ? from.slice(src.root.length).replace(/^[\\/]+/, '') : '';
    if (dst?.root && rel) {
      const same = dst.root.replace(/[\\/]+$/, '') + sep + rel;
      if ((await window.deck.existingFiles([same])).length) folder = same;
    } else if (dst?.root && !rel) folder = dst.root;
  } catch { /* the target's own folder */ }
  moveGroupTo(ids, from, groupId, folder);
}

function moveGroupTo(ids, from, groupId, folder) {
  const group = findGroup(groupId);
  if (!folder || folder.replace(/[\\/]+$/, '').toLowerCase() === (from || '').replace(/[\\/]+$/, '').toLowerCase()) return;
  let later = 0;
  for (const id of ids) {
    const a = hubAgentFor(id);
    if (!a) continue;
    if (!id.startsWith('p:') && BUSY.includes(a.status) && a.status !== 'background') {
      a.moveWhenDone = folder;
      later++;
    } else moveToFolder(id, folder);
  }
  const d = ensureDraft();
  if (d.folder && from && d.folder.toLowerCase() === from.toLowerCase() && (d.groupId || null) === (groupId || null)) {
    d.folder = folder;
    renderDraftButtons();
  }
  refreshHub();
  saveHub();
  toast(`${group ? group.name : 'The group'} moves to ${homePath(folder)}${later ? ` · ${later} working agent${later === 1 ? ' moves' : 's move'} when done` : ''}`);
}

// Before a moved agent's next message: stop it, and start it again in its
// new folder, continuing a copy of its conversation. Same id, so its tile
// stays where it is.
async function restartInNewFolder(agent) {
  const ended = new Promise(resolve => exitWaiters.set(agent.id, resolve));
  window.deck.closeAgent(agent.id);
  await Promise.race([ended, new Promise(r => setTimeout(r, 8000))]);
  exitWaiters.delete(agent.id);
  const from = agent.sessionId;
  const place = tileOrder.indexOf(orderKey(agent));
  if (place >= 0) tileOrder[place] = agent.id;
  agent.sessionId = null;
  agent.status = 'starting';
  agent.snapshot = null;
  agent.mediaSince = null;
  clearClashes(agent);
  refreshHub();
  await window.deck.startAgent({
    id: agent.id,
    cwd: agent.cwd,
    permissionMode: agent.mode,
    model: cliModel(agent),
    effort: agent.choice?.effort,
    fastMode: agent.choice?.fastMode,
    resumeId: from,
    forkSession: true,
  });
  agent.moved = false;
}

// History orders the categories by their latest update, so there is no
// Move up / Move down.
async function groupMenu(group) {
  const picked = await window.deck.popupMenu([
    { id: 'notes', label: 'Shared notes…' },
    { id: 'hub', label: 'Put all its agents on the Hub' },
    { id: 'rename', label: 'Rename' },
    { type: 'separator' },
    { id: 'delete', label: 'Delete category (its sessions become uncategorized)' },
    { id: 'forget', label: 'Remove category and its agents from History…' },
  ]);
  if (picked === 'forget') removeFromHistory(state.sessions.filter(s => groupOf(s.id) === group.id).map(s => s.id), { group });
  if (picked === 'notes') openNotesEditor(group);
  if (picked === 'hub') bringGroupToHub(group);
  if (picked === 'rename') { state.renamingGroup = group.id; renderSidebar(); }
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
    // The category's agents that are not on the Hub go back there.
    if (state.sessions.some(s => groupOf(s.id) === group.id && !isOnHub(s.id))) {
      const all = el('button', 'group-to-hub', 'All to Hub');
      all.title = `Put every agent of ${group.name} on the Hub`;
      all.onclick = e => { e.stopPropagation(); bringGroupToHub(group); };
      head.appendChild(all);
    }
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
  // Not on the Hub (any more): one click puts it back there.
  if (!isOnHub(s.id)) {
    const back = el('button', 'item-to-hub', 'Back to Hub');
    back.title = 'Show this agent on the Hub again';
    back.onclick = e => { e.stopPropagation(); bringBackToHub(s); };
    item.appendChild(back);
  }
  const forget = el('button', 'item-remove', '×');
  forget.title = 'Remove from History';
  forget.onclick = e => { e.stopPropagation(); removeFromHistory([s.id]); };
  item.appendChild(forget);
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

  // The category used most recently comes first: each one (and
  // Uncategorized) is placed by the newest update of its sessions, counting
  // the ones running on the Hub too. Sessions inside are newest first.
  const lastUpdate = new Map();
  for (const s of state.sessions) {
    const key = groupOf(s.id) || '';
    lastUpdate.set(key, Math.max(lastUpdate.get(key) || 0, s.updatedAt || 0));
  }
  const sections = [
    ...state.groups.groups.map(group => ({ group, sessions: byGroup.get(group.id) })),
    ...(ungrouped.length || !state.groups.groups.length ? [{ group: null, sessions: ungrouped }] : []),
  ].sort((a, b) => (lastUpdate.get(b.group?.id || '') || 0) - (lastUpdate.get(a.group?.id || '') || 0));

  const list = $('history-list');
  list.innerHTML = '';
  let shown = 0;
  for (const { group, sessions } of sections) {
    // While searching, only groups with matches are shown.
    if (group && q && !sessions.length) continue;
    const collapsed = group ? group.collapsed && !q : !!state.groups.ungroupedCollapsed && !q;
    const g = el('div', 'group' + (collapsed ? ' collapsed' : ''));
    // Without any groups yet, the list needs no "Uncategorized" header.
    if (group || state.groups.groups.length) g.appendChild(groupHeader(group, sessions.length, collapsed));
    sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    for (const s of sessions) g.appendChild(historyItem(s));
    if (group && !sessions.length && !collapsed) g.appendChild(el('div', 'group-empty', 'Drag sessions here'));
    list.appendChild(g);
    shown += sessions.length;
  }
  if (!shown && (q || !state.groups.groups.length)) list.appendChild(el('div', 'note', q ? 'No matches' : 'No saved sessions'));
}


async function loadSessions() {
  state.sessions = await window.deck.listSessions();
  const titles = savedTitles();
  for (const s of state.sessions) {
    const listed = state.agentList.get(s.id);
    if (titles[s.id]) s.title = titles[s.id];
    else if (listed?.title) s.title = listed.title;
  }
  renderSidebar();
}

// ---------- history ----------

// Loads a saved session into a (hidden) chat view, once.
async function loadHistory(session) {
  if (!state.history.has(session.id)) {
    const view = makeChatView();
    const data = await window.deck.loadTranscript(session.file);
    const transcript = new Transcript(view, data.cwd || session.cwd);
    transcript.onEditPrompt = (index, text, opts) => rewindTo(transcript, index, text, opts);
    // A saved session is drawn all at once, so its milestones show no times.
    transcript.replaying = true;
    for (const m of data.messages) transcript.add(m);
    transcript.finishTurn();
    transcript.replaying = false;
    transcript.note('End of saved session. Send a message to continue it.');
    await restoreTurnChanges(transcript);
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

// Each task's Changes card as the snapshot comparison made it, saved when
// the task ends and put back when its session is opened again (after a
// restart or an update), with the task's snapshot for Undo.
function saveTurnChanges(turn) {
  if (!turn?.endUuid || !turn.gitShown || !Array.isArray(turn.files)) return;
  window.deck.saveTurnChanges(turn.endUuid, { files: turn.files, snap: turn.snap || null }).catch(() => {});
}

async function restoreTurnChanges(transcript) {
  const turns = transcript.prompts.map(p => p.turn).filter(t => t?.endUuid);
  if (!turns.length) return;
  const saved = await window.deck.loadTurnChanges(turns.map(t => t.endUuid)).catch(() => ({}));
  // Oldest first, so each card finds the earlier tasks' files (withEarlier).
  for (const turn of turns) {
    const s = saved[turn.endUuid];
    if (!s) continue;
    if (s.snap) turn.snap = s.snap;
    transcript.restoreChanges(turn, s.files);
  }
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

// ---------- signing Claude Code in again ----------

// Claude Code's saved login expired (or was rejected): every agent fails
// until you sign in again. A card offers that right away when the window has
// the focus, or as soon as you come back to it. It runs `claude auth login`
// (see auth.js): the sign-in page opens in your browser, and the card closes
// itself when you are signed in.
const AUTH_FAILURE = /OAuth (session|token)[^.\n]*expired|Failed to authenticate|authentication_error|Invalid API key|Please run \/login|Not logged in/i;
const authProblem = { pending: false };

function isAuthFailure(msg) {
  if (msg?.type === 'result' && msg.is_error) return msg.api_error_status === 401 || AUTH_FAILURE.test(msg.result || '');
  if (msg?.type === 'assistant') return msg.error === 'authentication_failed';
  return false;
}

// ---------- the Unity Editor ----------

// Groups in a Unity project, and an agent's message box when its folder is
// one, have a button for the project's Unity Editor: "Focus Unity" brings it
// to the front when it is open, "Open Unity" starts it (src/unityapp.js).
// Whether it is open is checked every few seconds.
const unityStates = new Map();   // folder -> { unity, running, version, root }
const UNITY_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M8 1.5 14 5v6l-6 3.5L2 11V5z"/><path d="M8 8v6.5M8 8l6-3M8 8 2 5"/></svg>';
async function refreshUnity() {
  const folders = new Set([...hub.sections.values()].map(s => s.cwd).filter(Boolean));
  const cur = state.current;
  const curCwd = cur?.kind === 'agent' ? state.agents.get(cur.id)?.cwd : cur?.kind === 'history' ? (state.history.get(cur.id)?.cwd || state.history.get(cur.id)?.session.cwd) : null;
  if (curCwd) folders.add(curCwd);
  await Promise.all([...folders].filter(f => f !== state.config?.home).map(async f => {
    unityStates.set(f, await window.deck.unityStatus(f).catch(() => ({ unity: false })));
    svnStates.set(f, await window.deck.tactileSvnStatus(f).catch(() => ({ available: false })));
  }));
  hub.setUnity(unityStates);
  hub.setTactileSvn(svnStates);
  renderUnityButton();
}
function renderUnityButton() {
  // The top bar is drawn once before this part of the file has run.
  try { unityStates; } catch { return; }
  const cur = state.current;
  const cwd = cur?.kind === 'agent' ? state.agents.get(cur.id)?.cwd : cur?.kind === 'history' ? (state.history.get(cur.id)?.cwd || state.history.get(cur.id)?.session.cwd) : null;
  const st = cwd ? unityStates.get(cwd) : null;
  renderTactileSvnButton(cwd);
  const b = $('composer-unity');
  b.classList.toggle('hidden', !st?.unity);
  if (!st?.unity) return;
  b.innerHTML = `${UNITY_ICON}<span>${st.running ? 'Focus Unity' : 'Open Unity'}</span>`;
  b.classList.toggle('running', !!st.running);
  b.title = st.running ? 'Bring this project\'s Unity Editor to the front' : `Open this project in Unity${st.version ? ' ' + st.version : ''}`;
  b.dataset.cwd = cwd;
}
// TactileSVN: the folder's working copy opens there, or its window comes to
// the front when TactileSVN already has it open (see tactilesvn.js).
const svnStates = new Map();   // folder -> { available, root }
function renderTactileSvnButton(cwd) {
  const st = cwd ? svnStates.get(cwd) : null;
  const b = $('composer-tsvn');
  b.classList.toggle('hidden', !st?.available);
  if (!st?.available) return;
  b.innerHTML = `${TSVN_ICON}<span>TactileSVN</span>`;
  b.title = `Show ${st.root} in TactileSVN (brings its window to the front when it is open)`;
  b.dataset.cwd = cwd;
}
async function openTactileSvn(cwd) {
  if (!cwd) return;
  sfx('open');
  const r = await window.deck.openTactileSvn(cwd).catch(err => ({ ok: false, message: String(err?.message || err) }));
  if (!r.ok) { sfx('refuse'); toast(r.message || 'Could not open TactileSVN.'); }
}

async function openUnity(cwd) {
  if (!cwd) return;
  sfx('open');
  const r = await window.deck.openUnity(cwd).catch(err => ({ ok: false, message: String(err?.message || err) }));
  if (!r.ok) { sfx('refuse'); toast(r.message || 'Could not open Unity.'); return; }
  if (r.action === 'opened') toast(`Opening Unity ${r.version || ''}… it takes a moment to load the project.`);
  setTimeout(refreshUnity, r.action === 'opened' ? 8000 : 1500);
}
hub.onOpenUnity = openUnity;
hub.onOpenTactileSvn = openTactileSvn;
$('composer-tsvn').onclick = () => openTactileSvn($('composer-tsvn').dataset.cwd);
hub.onMoveGroup = moveGroup;
hub.onDropGroup = dropGroupOnRepo;
hub.branchOf = repoBranch;
// The model on each agent's tile: "Opus 5.5", or with Auto "Auto · Sonnet"
// (what Auto runs right now). Fable shows apart, as in the model menu.
hub.modelOf = agent => {
  // A saved session from before models were recorded: nothing to show.
  if (!agent.choice?.model) return null;
  const value = agent.choice.model;
  if (value === 'auto') {
    const picked = autoModel.nameOf(cliModel(agent));
    return { label: `Auto · ${picked}`, auto: true, title: `Auto picked ${picked} for this task (it can change with your next message)` };
  }
  if (value === 'default') return { label: 'Default', title: "Claude Code's default model" };
  const m = modelByValue(value);
  const name = m ? shortName(m) : value;
  return { label: name, fable: /^fable/i.test(name), title: `Runs on ${name}` };
};
$('composer-unity').onclick = () => openUnity($('composer-unity').dataset.cwd);
setTimeout(refreshUnity, 3000);
setInterval(() => { if (!document.hidden) refreshUnity(); }, 5000);

// ---------- what the agents need ----------

// A popup like the quit card: a title, a text, any extra content and
// buttons ([label, onClick, primary]). Returns { overlay, close, title,
// text, extra, setButtons }.
function setupCard() {
  const overlay = el('div', 'quit-modal setup-modal');
  const card = el('div', 'quit-card setup-card');
  const title = el('div', 'quit-title');
  const text = el('p', 'quit-text');
  const extra = el('div', 'setup-extra');
  const buttons = el('div', 'quit-buttons');
  card.append(title, text, extra, buttons);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 200);
  };
  const onKey = e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
  };
  document.addEventListener('keydown', onKey, true);
  const setButtons = (...list) => {
    buttons.replaceChildren();
    for (const [label, onClick, primary] of list) {
      const b = el('button', primary ? 'quit-go' : 'quit-stay', label);
      b.type = 'button';
      b.onclick = onClick;
      buttons.appendChild(b);
    }
    buttons.querySelector('.quit-go')?.focus();
  };
  return { overlay, close, title, text, extra, setButtons };
}

// A command to type in a terminal, with a Copy button.
function commandRow(label, command) {
  const row = el('div', 'setup-command');
  const head = el('div', 'setup-command-label', label);
  const code = el('code', null, command);
  const copy = el('button', 'setup-copy', 'Copy');
  copy.type = 'button';
  copy.onclick = () => { navigator.clipboard.writeText(command).catch(() => {}); copy.textContent = 'Copied'; sfx('select'); setTimeout(() => { copy.textContent = 'Copy'; }, 1500); };
  const line = el('div', 'setup-command-line');
  line.append(code, copy);
  row.append(head, line);
  return row;
}

// Claude Code is not on this computer: the agents cannot start. Says how to
// install it and sign in, and checks again on request. Shown when the app
// starts without it, and when an agent fails to start because of it.
let claudeMissingOpen = false;
function showClaudeMissing() {
  if (claudeMissingOpen) return;
  claudeMissingOpen = true;
  sfx('refuse');
  const c = setupCard();
  const close = () => { claudeMissingOpen = false; c.close(); };
  c.title.textContent = 'Claude Code is not installed';
  c.text.textContent = 'Agent Hub runs your agents with Claude Code, the command-line tool, and could not find it on this computer. Install it, then sign in once:';
  c.extra.append(
    IS_MAC ? commandRow('1. In Terminal (Mac):', 'curl -fsSL https://claude.ai/install.sh | bash')
      : commandRow('1. In PowerShell (Windows):', 'irm https://claude.ai/install.ps1 | iex'),
    commandRow('   or, with Node.js installed:', 'npm install -g @anthropic-ai/claude-code'),
    commandRow('2. Then sign in (it opens your browser):', 'claude'),
    el('p', 'setup-note', 'Installed somewhere unusual? Set its path in Settings → Claude Code.'),
  );
  const check = async () => {
    const r = await window.deck.setupClaude().catch(() => ({ found: false }));
    if (r.found) {
      close();
      toast(`Found Claude Code${r.version ? ' ' + r.version : ''}. New agents can start now.`);
      sfx('connected');
    } else {
      c.text.textContent = 'Still not found. Install it with one of the commands below (a new terminal may be needed for it to be on the PATH), then check again:';
      sfx('refuse');
    }
  };
  c.setButtons(['Later', close], ['Settings', () => { close(); showSettings(); }], ['Check again', check, true]);
}

// The Unity bridge (the com.tactilegames.unity-mcp package) lets agents work
// in the Unity Editor. When an agent starts in a Unity project where it is
// not set up, a popup lists the steps (done or not) and how to do the rest.
// Once per project while the app runs; "Don't show again" stops it for
// that project.
const UNITY_STEPS = {
  node: ['Node.js is installed', 'Install Node.js (version 18 or later) from nodejs.org, then restart Agent Hub.'],
  package: ['The Unity MCP package is in the project', 'Add com.tactilegames.unity-mcp to the project with the Package Manager.'],
  activated: ['The bridge is activated', 'In Unity: Tactile → AI → MCPs → Unity MCP, and tick Activated. That copies the bridge into Library/McpServer.'],
  installed: ['Its Node.js part is installed', 'The Unity MCP window runs npm install when you activate it. If that failed, run it yourself:'],
  mcpJson: ['Claude Code knows about it (.mcp.json)', 'A .mcp.json next to the Assets folder tells Claude Code to start the bridge.'],
};
const unityChecked = new Set();
async function checkUnityBridge(cwd) {
  const r = await window.deck.setupUnity(cwd).catch(() => null);
  if (!r?.unity || r.ok || unityChecked.has(r.root)) return;
  unityChecked.add(r.root);
  let hidden = [];
  try { hidden = JSON.parse(localStorage.getItem('unityBridgeHidden') || '[]'); } catch { hidden = []; }
  if (hidden.includes(r.root)) return;
  showUnityBridge(r);
}

function showUnityBridge(result) {
  if (document.querySelector('.setup-modal')) return;
  sfx('attention');
  const c = setupCard();
  const render = r => {
    c.title.textContent = r.ok ? 'The Unity bridge is set up' : 'Set up the Unity bridge';
    c.text.textContent = r.ok
      ? 'Agents you start from now on can work in the Unity Editor (open the project in Unity for that).'
      : `Your agents can't reach the Unity Editor in ${r.root.split(SEP).slice(-2).join('/')}: the Unity bridge is not set up yet. They can still edit files, but not inspect scenes, prefabs or the console, or run the game. To set it up:`;
    c.extra.replaceChildren();
    for (const step of r.steps) {
      const [done, how] = UNITY_STEPS[step.id];
      const row = el('div', `setup-step ${step.ok ? 'ok' : 'todo'}`);
      row.append(el('span', 'setup-step-mark', step.ok ? '✓' : '✗'), el('span', 'setup-step-text', done));
      c.extra.appendChild(row);
      if (step.ok) continue;
      const help = el('div', 'setup-step-help', how);
      c.extra.appendChild(help);
      const sep = window.deck.platform === 'win32' ? '\\' : '/';
      if (step.id === 'installed') c.extra.appendChild(commandRow('', `cd "${r.root}${sep}Library${sep}McpServer" && npm install`));
      if (step.id === 'mcpJson') {
        const make = el('button', 'setup-copy', 'Create .mcp.json');
        make.type = 'button';
        make.onclick = async () => {
          const w = await window.deck.writeMcpJson(r.root).catch(err => ({ ok: false, message: String(err) }));
          if (w.ok) { sfx('approve'); render(await window.deck.setupUnity(r.root)); } else { help.textContent = `Could not write it: ${w.message}`; sfx('refuse'); }
        };
        help.appendChild(make);
      }
    }
    if (!r.ok) c.extra.appendChild(el('p', 'setup-note', 'Agents you start after this get the bridge; running ones need a new agent.'));
    const hide = () => {
      let hidden = [];
      try { hidden = JSON.parse(localStorage.getItem('unityBridgeHidden') || '[]'); } catch { hidden = []; }
      try { localStorage.setItem('unityBridgeHidden', JSON.stringify([...new Set([...hidden, r.root])])); } catch { /* not important */ }
      c.close();
    };
    c.setButtons(...(r.ok ? [['Close', c.close, true]] : [["Don't show again for this project", hide], ['Later', c.close], ['Check again', async () => render(await window.deck.setupUnity(r.root)), true]]));
  };
  render(result);
}

function noteAuthProblem() {
  authProblem.pending = true;
  if (document.hasFocus()) showLoginCard();
}

// Agents that stopped because Claude Code was signed out wait (their tile
// says so) and continue by themselves once you sign in again (see
// resumeAuthWaits). Kept in local storage, so they survive a restart.
const AUTH_CONTINUE = 'You are signed in again. Continue where you left off.';
function authWaits() {
  try { return JSON.parse(localStorage.getItem('authWaits') || '[]'); } catch { return []; }
}
function saveAuthWaits(list) {
  try { localStorage.setItem('authWaits', JSON.stringify([...new Set(list)])); } catch { /* not important */ }
}
function noteAuthWait(a) {
  if (a.authWait) return;
  a.authWait = true;
  if (a.sessionId) saveAuthWaits([...authWaits(), a.sessionId]);
  a.transcript.note('Claude Code is signed out. This agent continues by itself once you sign in again.');
  refreshHub();
}
function isAuthWaiting(item) {
  return !!item.authWait || (!!item.sessionId && authWaits().includes(item.sessionId));
}
async function resumeAuthWaits() {
  const live = [...state.agents.values()].filter(a => a.authWait || (a.sessionId && authWaits().includes(a.sessionId)));
  const rest = new Set(authWaits());
  saveAuthWaits([]);
  for (const a of live) {
    a.authWait = false;
    rest.delete(a.sessionId);
    await sendToHubItem(a.id, AUTH_CONTINUE).catch(() => {});
  }
  for (const sid of rest) if (state.parked.has(sid)) await sendToHubItem('p:' + sid, AUTH_CONTINUE).catch(() => {});
  const n = live.length + [...rest].filter(sid => state.parked.has(sid)).length;
  if (n) toast(`Signed in: ${n} agent${n === 1 ? '' : 's'} continue`);
  refreshHub();
}

// While agents wait for a sign-in, the card comes back when you return to
// the window (not more than every 10 minutes after you chose Later).
window.addEventListener('focus', () => {
  const waiting = authWaits().length || [...state.agents.values()].some(a => a.authWait);
  if (authProblem.pending || (waiting && Date.now() - (authProblem.dismissedAt || 0) > 10 * 60 * 1000)) showLoginCard();
});

function showLoginCard() {
  if (document.querySelector('.login-modal') || document.querySelector('.quit-modal')) return;
  authProblem.pending = false;
  const overlay = el('div', 'quit-modal login-modal');
  const card = el('div', 'quit-card');
  const title = el('div', 'quit-title');
  const text = el('p', 'quit-text');
  const extra = el('div', 'login-extra');
  const buttons = el('div', 'quit-buttons');
  card.append(title, text, extra, buttons);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));

  let stopOutput = null;
  let signingIn = false;
  const close = () => {
    authProblem.dismissedAt = Date.now();
    stopOutput?.();
    if (signingIn) window.deck.auth.cancel();
    document.removeEventListener('keydown', onKey, true);
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 200);
  };
  const onKey = e => {
    if (e.target.closest?.('.login-code')) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
    if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); buttons.querySelector('.quit-go')?.click(); }
  };
  document.addEventListener('keydown', onKey, true);

  const setButtons = (...list) => {
    buttons.replaceChildren();
    for (const [label, onClick, primary] of list) {
      const b = el('button', primary ? 'quit-go' : 'quit-stay', label);
      b.onclick = onClick;
      buttons.appendChild(b);
    }
    buttons.querySelector('.quit-go')?.focus();
  };

  const intro = () => {
    title.textContent = 'Sign in to Claude again';
    text.textContent = 'Claude Code\'s login has expired, so your agents can\'t reach Claude. Sign in to keep them working.';
    extra.replaceChildren();
    setButtons(['Later', close], ['Sign in', signIn, true]);
  };

  const signIn = async () => {
    signingIn = true;
    title.textContent = 'Signing in…';
    text.textContent = 'Finish signing in on the page that opened in your browser. This card closes by itself when you are done.';
    extra.replaceChildren();
    setButtons(['Cancel', close]);
    // The command prints the sign-in link, and asks for a code when the
    // browser can't hand it back by itself.
    let output = '';
    let linkShown = false, codeShown = false;
    stopOutput?.();
    stopOutput = window.deck.auth.onOutput(chunk => {
      output += chunk;
      const url = /https:\/\/\S+/.exec(output)?.[0];
      if (url && !linkShown) {
        linkShown = true;
        const link = el('a', 'login-link', 'Open the sign-in page again');
        link.href = '#';
        link.onclick = e => { e.preventDefault(); window.open(url); };
        extra.appendChild(link);
      }
      if (/paste|code/i.test(output) && !codeShown) {
        codeShown = true;
        const row = el('div', 'login-code-row');
        const input = el('input', 'login-code');
        input.placeholder = 'Or paste the code from the page here';
        const submit = el('button', null, 'Submit');
        const send = () => {
          if (!input.value.trim()) return;
          window.deck.auth.input(input.value);
          input.value = '';
          submit.disabled = true;
        };
        submit.onclick = send;
        input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
        row.append(input, submit);
        extra.appendChild(row);
      }
    });
    const result = await window.deck.auth.login().catch(err => ({ ok: false, message: err.message }));
    if (!signingIn) return;   // cancelled
    signingIn = false;
    stopOutput?.();
    stopOutput = null;
    const status = result.ok ? await window.deck.auth.status().catch(() => null) : null;
    if (result.ok && status?.loggedIn !== false) {
      title.textContent = 'Signed in';
      const waiting = authWaits().length + [...state.agents.values()].filter(a => a.authWait).length;
      text.textContent = `${status?.email ? `Signed in as ${status.email}. ` : ''}${waiting ? 'The agents that stopped continue now.' : 'You can carry on.'}`;
      extra.replaceChildren();
      setButtons(['Done', close, true]);
      sounds.done?.();
      resumeAuthWaits();
    } else {
      title.textContent = 'Sign-in didn\'t finish';
      text.textContent = result.message || 'Claude Code could not sign in.';
      extra.replaceChildren();
      setButtons(['Later', close], ['Try again', signIn, true]);
    }
  };

  intro();
}

// The app is about to quit: save which agents are busy, and keep that list,
// because stopping the agents would otherwise mark them as finished.
const BUSY = ['working', 'starting', 'waiting', 'stuck', 'background'];

// A card in the app (not a system dialog) that asks before stopping working
// agents: a title, a sentence, the agents with their state, and two buttons.
// Enter confirms, Esc (or a click outside the card) keeps them working.
// Resolves true when you confirm. While it waits after confirming
// (busyText), the buttons are disabled.
function confirmCard({ title, text, agents = [], lines = [], confirmLabel, stayLabel = 'Keep working', busyText = null }) {
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
    if (lines.length) {
      const list = el('div', 'quit-list');
      for (const line of lines) list.appendChild(el('div', 'quit-agent', `• ${line}`));
      card.appendChild(list);
    }
    const buttons = el('div', 'quit-buttons');
    const stay = el('button', 'quit-stay', stayLabel);
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
  latestInfo = info || null;
  const btn = $('app-update');
  btn.classList.toggle('hidden', !info);
  btn.classList.remove('failed');
  if (!info) return;
  btn.disabled = false;
  btn.textContent = info.version ? `v${info.version} available` : 'Update available';
  // The check runs when the window gets the focus, so its answer counts as
  // part of that moment when it comes soon after.
  if (Date.now() - focusedAt < 20000) offerUpdate();
  const what = info.commits.length ? `\n\nWhat's new:\n${info.commits.map(c => `• ${c}`).join('\n')}` : '';
  btn.title = `Click to update and restart (${info.behind} new commit${info.behind === 1 ? '' : 's'}).${what}`;
}

// A new version also gets a card once, which offers to update right away.
// "Later" leaves the button; more new commits on GitHub bring the card back.
// The card comes only when you come back to the window and no agent needs
// you: none asks a question or waits for an approval, and you have opened
// every finished agent (the agents Tab would show, see reviewQueue). Until
// then the button next to the version is there.
const offeredUpdates = new Set();
let latestInfo = null;
let focusedAt = 0;
window.addEventListener('focus', () => {
  focusedAt = Date.now();
  offerUpdate();
});
async function offerUpdate() {
  const info = latestInfo;
  if (!info || !document.hasFocus() || reviewQueue().length) return;
  const key = `${info.version}:${info.behind}`;
  if (offeredUpdates.has(key) || document.querySelector('.quit-modal, .settings-modal')) return;
  offeredUpdates.add(key);
  sfx('open');
  const ok = await confirmCard({
    title: info.version ? `Agent Hub v${info.version} is available` : 'A new version of Agent Hub is available',
    text: `Updating restarts the app. Agents that are working stop, then continue where they left off after the restart.${info.commits.length ? " What's new:" : ''}`,
    lines: info.commits.slice(0, 8),
    confirmLabel: 'Update and restart',
    stayLabel: 'Later',
  });
  // The card needs a moment to close before the update may show its own.
  if (ok) setTimeout(() => $('app-update').onclick(), 250);
}

// The changelog: click the version next to the title. It comes from git
// (see changelog in updates.js): each release with its changes, newest first.
$('app-version').onclick = () => showChangelog();
async function showChangelog() {
  if (document.querySelector('.settings-modal')) return;
  const overlay = el('div', 'settings-modal');
  const card = el('div', 'settings-card changelog-card');
  const head = el('div', 'settings-head');
  head.append(el('div', 'settings-title', "What's new"));
  const body = el('div', 'settings-body changelog-body');
  body.appendChild(el('div', 'settings-hint', 'Loading…'));
  const foot = el('div', 'settings-foot');
  const close = el('button', 'settings-save', 'Close');
  close.type = 'button';
  foot.append(el('span', 'settings-hint', 'Each release lists the changes since the one before.'), close);
  foot.firstChild.style.marginRight = 'auto';
  card.append(head, body, foot);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));
  sfx('open');
  const shut = () => {
    document.removeEventListener('keydown', onKey, true);
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 200);
  };
  const onKey = e => {
    if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); shut(); }
  };
  document.addEventListener('keydown', onKey, true);
  close.onclick = shut;
  overlay.onclick = e => { if (e.target === overlay) shut(); };
  close.focus();

  const [entries, current] = await Promise.all([
    window.deck.changelog().catch(() => []),
    window.deck.appVersion().catch(() => ({})),
  ]);
  body.innerHTML = '';
  if (!entries.length) {
    body.appendChild(el('div', 'settings-hint', 'No releases found. The changelog comes from the version tags in git.'));
    return;
  }
  for (const entry of entries) {
    const section = el('div', 'changelog-release');
    const title = el('div', 'changelog-title');
    title.append(el('span', 'changelog-version', entry.unreleased ? 'Not released yet' : `v${entry.version}`));
    if (entry.date) title.append(el('span', 'changelog-date', entry.date));
    const yours = entry.unreleased ? current.dev : !current.dev && entry.version === current.version;
    if (yours) title.append(el('span', 'changelog-yours', 'Your version'));
    const list = el('ul', 'changelog-list');
    for (const change of entry.changes) list.appendChild(el('li', null, change));
    if (!entry.changes.length) list.appendChild(el('li', 'settings-hint', 'Version number only'));
    section.append(title, list);
    body.appendChild(section);
  }
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
  saveHub({ now: true });
  state.quitting = true;
});

// ---------- agents ----------

// rewindAt (going back to one of your messages in a saved session): the
// answer to continue after ({ uuid, session }), or null to start over.
// ---------- fork or handoff ----------

// A new agent in a category continues from the category's latest agent
// (forkSourceFor). Forking copies that agent's whole conversation, and every
// step of the new agent reads it again, so a long one (above HANDOFF_ABOVE
// tokens) is not forked: the new agent starts fresh with a handoff Haiku
// writes from it (src/handoff.js), plus the category's shared notes. If the
// handoff cannot be written, it forks as before.
const HANDOFF_ABOVE = 60000;
// note(text): shows what it is doing (on the new agent's booting tile).
async function startFrom(forkFrom, note = flashComposerNote) {
  if (!forkFrom) return { forkFrom: null };
  let session = state.sessions.find(s => s.id === forkFrom.sessionId);
  if (!session) { await loadSessions(); session = state.sessions.find(s => s.id === forkFrom.sessionId); }
  if (!session?.file) return { forkFrom };
  const size = await window.deck.sessionContextSize(session.file).catch(() => 0);
  if (size <= HANDOFF_ABOVE) return { forkFrom };
  note('Writing a handoff…');
  const text = await window.deck.sessionHandoff(session.file, forkFrom.title).catch(() => null);
  if (!text) return { forkFrom };
  const safe = forkFrom.title.replace(/"/g, "'");
  return {
    forkFrom: null,
    preamble: `<handoff from="${safe}">\nYou continue the work of an earlier agent in this project. Its conversation is not copied; this is its handoff:\n\n${text}\n</handoff>\n\n`,
    handoffFrom: { title: forkFrom.title, tokens: size },
  };
}

// prepare (optional): slow work before Claude Code can start, such as
// reading a Jira ticket or writing a handoff. It runs after the agent's tile
// exists, so the tile flies to its group and boots up at once instead of
// waiting; prepare(note) shows its progress on the booting tile with
// note(text) and resolves with any of { prompt, forkFrom, preamble,
// handoffFrom } to use instead of the ones passed in.
async function startAgent({ cwd, prompt, permissionMode, choice, resume, groupId, fromRect, forkFrom, preamble = '', handoffFrom = null, images = [], ticket = null, rewindAt, prepare = null }) {
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
  transcript.onEditPrompt = (index, text, opts) => rewindTo(transcript, index, text, opts);
  if (resume) {
    state.history.delete(resume.session.id);
    state.parked.delete(resume.session.id);
  }

  transcript.onUpdate = refreshHub;
  const agent = { id, title, cwd, status: 'starting', sessionId: resume?.session.id || null, view, transcript, unread: false, choice, mode: permissionMode,
    // A resumed session stays in its group. A new one goes to the group picked in the form.
    groupId: resume ? groupOf(resume.session.id) : groupId || null };
  state.agents.set(id, agent);
  // Auto: the rules pick a model now, and Haiku's rating comes while Claude
  // Code starts (see settleAuto). A resumed session keeps what Auto picked.
  let autoRating = null;
  if (choice.model === 'auto') {
    const real = !!prompt && prompt !== RESUME_PROMPT && prompt !== RESTART_PROMPT;
    agent.autoRules = real ? autoModel.rules(prompt, { images: images.length }) : 2;
    // Visual work starts on Opus at once, without Haiku's rating.
    agent.autoVisual = real && !resume?.autoLevel ? autoModel.visual(prompt) : null;
    agent.autoLevel = resume?.autoLevel || (agent.autoVisual ? 3 : autoModel.combine(agent.autoRules, null));
    if (real && !resume?.autoLevel && !agent.autoVisual) autoRating = window.deck.rateTask(prompt).then(rated).catch(() => null);
    if (agent.autoVisual) setTimeout(() => { agent.transcript.note(`Auto picked Opus (visual work: ${agent.autoVisual}).`); showAutoPick(agent); }, 0);
  }
  if (ticket) agent.ticket = ticket;
  if (!resume) summarizeTitle(agent, prompt);
  // What kind of task it is (the Nostromo theme's tank shows it, see tasktype.js).
  if (!resume) taskType.start(agent, prompt);
  else if (prompt !== RESUME_PROMPT && prompt !== RESTART_PROMPT) notePrompt(agent, prompt);
  // In a Unity project: is the Unity bridge set up? (A popup says how, if not.)
  checkUnityBridge(cwd);
  // The chat gets its notes and your message once prepare is done (it can
  // change the message), so they only wait while the tile is in the Hub.
  const fillChat = () => {
    if (forkFrom) {
      agent.forkedFrom = forkFrom;
      transcript.note(`Continues from "${forkFrom.title}", so it knows what that agent did.`);
    }
    if (handoffFrom) {
      transcript.note(`Starts fresh with a handoff from "${handoffFrom.title}": its conversation was ${formatTokens(handoffFrom.tokens)} tokens, too long to copy.`);
    }
    transcript.add({ type: 'user', message: { role: 'user', content: userContent(prompt, images) } });
  };
  if (!prepare) fillChat();
  if (fromRect) {
    // Started from the Hub: stay there and watch the message box become the tile.
    hub.expectArrival(id, fromRect, prompt);
    show('hub');
  } else {
    afterSend(agent, false);
  }

  if (prepare) {
    const note = text => {
      agent.bootNote = text;
      refreshHub();
    };
    const ready = await prepare(note).catch(() => ({}));
    agent.bootNote = null;
    // Removed from the Hub while it was getting ready: nothing to start.
    if (!state.agents.has(id) || agent.removed) return;
    ({ prompt = prompt, forkFrom = forkFrom, preamble = preamble, handoffFrom = handoffFrom } = ready || {});
    fillChat();
    refreshHub();
  }

  try {
    await window.deck.startAgent({
      id,
      cwd,
      permissionMode,
      model: cliModel(agent),
      effort: choice.effort,
      fastMode: choice.fastMode,
      ...(rewindAt === undefined
        ? { resumeId: resume?.session.id || forkFrom?.sessionId, forkSession: resume ? !!resume.moved : !!forkFrom }
        : { resumeId: rewindAt?.session || undefined, forkSession: !!rewindAt, resumeSessionAt: rewindAt?.uuid }),
    });
  } catch (err) {
    agent.status = 'error';
    transcript.note(`Could not start the agent: ${err?.message || err}`, true);
    refreshHub();
    return;
  }
  // A / command must start the message, or Claude Code does not run it: the
  // handoff then goes with your next message.
  if (preamble && isSlashCommand(prompt)) agent.pendingPreamble = preamble;
  if (autoRating) await settleAuto(agent, autoRating);
  await sendToAgent(agent, isSlashCommand(prompt) ? prompt : preamble + prompt, images);
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
  taskType.start(agent, text);
  refreshHub();
  saveHub();
  refreshHeaderIfCurrent(agent.id);
  window.deck.summarizeTitle(text).then(title => {
    if (!title || agent.latestPrompt !== text) return;
    agent.latestTitle = title;
    refreshHub();
    saveHub();
    refreshHeaderIfCurrent(agent.id);
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
  // The tile turns "working" once the chat is back inside it (returnTo holds
  // the tiles still until then), so it closes the same as with "← Hub".
  const toWork = () => { if (wake && ['idle', 'background'].includes(agent.status)) agent.status = 'working'; };
  show('hub');
  if (fromChat && agent.view) {
    // The tile of a continued session is new: draw it now, not in the next frame.
    hub.update(hubItems(), null, state.groups.groups);
    // The hop starts once the tile has faded in under the chat's last frame
    // (see returnTo), not at the same time.
    const back = hub.returnTo(agent.id, agent.view, {
      onSettled: () => {
        toWork();
        if (wake) requestAnimationFrame(() => hub.wake(agent.id));
      },
    });
    continueReview(cur, back);
    return;
  }
  toWork();
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
  clearFollowUps(agent);
  // Auto rates every follow-up again (see followUp in automodel.js) and
  // changes the model when its level changes. The message waits for Haiku's
  // rating, at most 5 seconds; a short "yes, go ahead" does not wait.
  if (agent.choice?.model === 'auto' && agent.autoSent && !isSlashCommand(text)) {
    const current = agent.autoLevel || 2;
    const lastStatus = agent.status;
    let haiku = null;
    if (!autoModel.goesOn(text) && !autoModel.visual(text)) {
      const context = [agent.summaryTitle || agent.title, agent.latestPrompt && agent.latestPrompt !== text ? agent.latestPrompt : ''].filter(Boolean).join(' / ');
      haiku = await Promise.race([window.deck.rateTask(text, context).then(rated).catch(() => null), new Promise(r => setTimeout(() => r(null), 5000))]);
    }
    const level = autoModel.followUp(current, text, haiku, lastStatus);
    if (level !== current) {
      // For the Auto report: this turn switched model (its cache starts over),
      // and whether it stepped up after a failed try.
      agent.autoSwitched = true;
      agent.autoFailStep = level > current && autoModel.stepUp(lastStatus, text);
      agent.autoLevel = level;
      window.deck.setModel(agent.id, cliChoice(agent));
      const why = autoModel.visual(text) ? `visual work: ${autoModel.visual(text)}` : haiku ? `Haiku rated this ${haiku} of 3` : autoModel.stepUp(lastStatus, text) ? 'the last try did not work' : 'from your message';
      agent.transcript.note(`Auto switched to ${autoModel.nameOf(cliModel(agent))} for this (${why}).`);
      showAutoPick(agent);
    }
  }
  if (agent.choice?.model === 'auto') agent.autoSent = true;
  agent.stopped = false;
  if (agent.moved) {
    try {
      await restartInNewFolder(agent);
    } catch (err) {
      agent.status = 'error';
      agent.transcript.note(`Could not start the agent in ${homePath(agent.cwd)}: ${err?.message || err}`, true);
      refreshHub();
      return;
    }
  }
  if (agent.authWait || (agent.sessionId && authWaits().includes(agent.sessionId))) {
    agent.authWait = false;
    saveAuthWaits(authWaits().filter(s => s !== agent.sessionId));
  }
  if (agent.limited || (agent.sessionId && limitWaits()[agent.sessionId])) {
    agent.limited = null;
    const waits = limitWaits();
    delete waits[agent.sessionId];
    saveLimitWaits(waits);
  }
  // After "Undo last prompt", the agent learns that its files are back as
  // they were before its last task (the chat shows your message as you wrote it).
  // A / command (a skill or a custom command) must start the message, or
  // Claude Code does not run it: the notes below then wait for your next message.
  if (!isSlashCommand(text)) {
    if (agent.pendingPreamble) {
      text = agent.pendingPreamble + text;
      agent.pendingPreamble = null;
    }
    if (agent.undoNote) {
      text = `(Before this message I undid every file change of your previous task, so these files are back the way they were before it: ${agent.undoNote.join(', ')}.)\n\n${text}`;
      agent.undoNote = null;
    }
    // The group's shared notes, when the agent has not read this version yet.
    text = notesBlock(agent) + text;
  }
  // Images and videos changed after this moment count as the task's media.
  // A second of slack covers clocks that round file times.
  if (!agent.mediaSince) agent.mediaSince = Date.now() - 1000;
  // The snapshot kept from a task whose background agents woke it up (see
  // the result in onStream): your message starts a new task.
  if (agent.snapshotHeld) {
    agent.snapshot = null;
    agent.snapshotHeld = false;
    agent.taskTurns = null;
  }
  if (!agent.snapshot) {
    agent.snapshotAt = Date.now() - 1000;
    try { agent.snapshot = await window.deck.gitSnapshot(agent.cwd); } catch { agent.snapshot = null; }
  }
  await window.deck.sendMessage(agent.id, text, images);
}

// ---------- going back to one of your messages ----------

// Edit on one of your messages (see Transcript.editPrompt): the conversation
// continues from just before that message, with the new text. Claude Code
// resumes the session up to the answer before the message, as a new session
// (--resume-session-at with --fork-session), so the old one stays in
// History. A running agent restarts in place, in the same tile; a saved
// session starts an agent. With undoFiles, the file changes of the tasks
// that leave the chat are undone first (newest first).
const exitWaiters = new Map();   // agent id -> called when its process has ended

async function rewindTo(transcript, index, text, { undoFiles, files = [] } = {}) {
  const prompt = transcript.prompts[index];
  if (!prompt) return;
  const agent = [...state.agents.values()].find(a => a.transcript === transcript && !a.removed);
  const hist = agent ? null : [...state.history.values()].find(h => h.transcript === transcript);
  if (!agent && !hist) return;
  const cwd = agent ? agent.cwd : hist.cwd || hist.session.cwd;
  if (!cwd) {
    transcript.note('This session has no saved folder, so it cannot continue.', true);
    return;
  }
  if (agent && !(await confirmStop([agent], { action: 'Going back to this message', label: 'Stop and go back' }))) return;

  if (undoFiles) {
    const problems = [];
    for (const f of [...files].reverse()) {
      const r = await window.deck.undoFile(cwd, { path: f.path, from: f.from, status: f.status, lines: f.lines }).catch(err => ({ ok: false, error: String(err) }));
      if (r.ok) f.undone = { previous: r.previous };
      else problems.push(r.error);
    }
    if (problems.length) transcript.note(`Some files were not undone:\n${problems.join('\n')}`, true);
  }
  // Where to continue: after the answer before this message, in the session
  // that answer belongs to. Without one (your first message), from scratch.
  const at = prompt.after ? { uuid: prompt.after.uuid, session: prompt.after.session || agent?.sessionId || hist?.session.id } : null;
  sfx('sent');

  if (hist) {
    transcript.truncateAt(index);
    await startAgent({ cwd, prompt: text, permissionMode: hist.mode, choice: hist.choice, resume: hist, rewindAt: at });
    return;
  }

  // A running agent: stop its process, then start it again with the same id,
  // so its tile, group and place in the Hub stay.
  const ended = new Promise(resolve => exitWaiters.set(agent.id, resolve));
  window.deck.closeAgent(agent.id);
  await Promise.race([ended, new Promise(r => setTimeout(r, 8000))]);
  exitWaiters.delete(agent.id);
  const place = tileOrder.indexOf(orderKey(agent));
  if (place >= 0) tileOrder[place] = agent.id;
  agent.sessionId = null;
  agent.status = 'starting';
  agent.queue = [];
  agent.queueHeld = false;
  renderQueue(agent);
  agent.snapshot = null;
  agent.mediaSince = null;
  clearClashes(agent);
  transcript.truncateAt(index);
  transcript.add({ type: 'user', message: { role: 'user', content: text } });
  notePrompt(agent, text);
  refreshHeaderIfCurrent(agent.id);
  refreshHub();
  try {
    await window.deck.startAgent({
      id: agent.id,
      cwd,
      permissionMode: agent.mode,
      model: cliModel(agent),
      effort: agent.choice?.effort,
      fastMode: agent.choice?.fastMode,
      resumeId: at?.session,
      forkSession: !!at,
      resumeSessionAt: at?.uuid,
    });
  } catch (err) {
    agent.status = 'error';
    transcript.note(`Could not restart the agent: ${err?.message || err}`, true);
    refreshHub();
    return;
  }
  await sendToAgent(agent, text);
}

// ---------- Jira tickets ----------

// The ticket a new agent's message is about: the message is a ticket key
// (or starts with one), or it holds a link to a ticket.
const TICKET_KEY = /^([A-Z][A-Z0-9_]+-\d+)(?=$|[\s:,.])/;
function ticketIn(text) {
  const t = text.trim();
  const lead = t.match(TICKET_KEY);
  if (lead) return lead[1];
  for (const m of t.matchAll(URL_IN_TEXT)) {
    const key = jiraKeyOf(m[0].replace(/[.,;:!?)\]]+$/, ''));
    if (key) return key;
  }
  return null;
}

// The agent's first message: the ticket, then what you wrote about it.
function ticketPrompt(t, typed) {
  let rest = typed.trim().replace(TICKET_KEY, '').replace(/^[\s:,.-]+/, '').trim();
  // Only the ticket's link: nothing more to say.
  if (!rest.replace(URL_IN_TEXT, '').replace(/[\s:,.-]/g, '')) rest = '';
  const lines = [`Jira ticket ${t.key}: ${t.summary}`];
  const meta = [t.type, t.status].filter(Boolean).join(' · ');
  if (meta) lines.push(meta);
  if (t.description) lines.push('', 'Description:', t.description);
  lines.push('', rest || 'Work on this ticket: do what it asks.');
  return lines.join('\n');
}

// After each finished task of an agent that started from a ticket, a button
// under the answer posts that answer to the ticket as a comment.
function addTicketPost(agent, turn, answer) {
  if (!turn || !answer?.trim()) return;
  const row = el('div', 'ticket-post');
  const button = el('button', null, `Post this answer to ${agent.ticket}`);
  button.title = `Adds the answer above as a comment on ${agent.ticket} in Jira`;
  const status = el('span', 'ticket-post-status');
  button.onclick = async () => {
    button.disabled = true;
    status.textContent = 'Posting…';
    const body = answer.trim().slice(0, 30000) + `\n\n(Posted from Agent Hub, by the agent "${agent.title}".)`;
    const r = await window.deck.jiraComment(agent.ticket, body).catch(err => ({ ok: false, error: String(err?.message || err) }));
    if (r.ok) {
      status.textContent = `Posted to ${agent.ticket} ✓`;
      button.remove();
      sfx('approve');
    } else {
      status.textContent = r.error || 'Posting failed.';
      status.classList.add('err');
      button.disabled = false;
      sfx('refuse');
    }
  };
  row.append(button, status);
  agent.transcript.pinned(() => turn.answer.appendChild(row));
}

// ---------- comments from the review ----------

// "Send comments to the agent" in the review puts them into the message
// box of the chat the review was opened from, so you can add to them
// before you press ↩.
window.addEventListener('review-comments', e => {
  const input = $('input');
  input.value = [input.value.trim(), e.detail.text].filter(Boolean).join('\n\n');
  autosize();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  sfx('pick');
});

// ---------- snapshots ahead of time ----------

// Before each message the app records the folder's files (src/git.js), and
// the message waits for that. After the first time it only reads what
// changed, but the first time it reads every code file and text asset of
// the project, which can take a while in a big Unity project. So, a few
// seconds after the app starts, it records the folders of the agents on
// the Hub once in the background, one after another.
function warmSnapshots() {
  const folders = [...new Set([...state.agents.values(), ...state.parked.values()].map(a => a.cwd).filter(f => f && f !== state.config.home))];
  setTimeout(async () => {
    for (const folder of folders) await window.deck.gitSnapshot(folder).catch(() => null);
  }, 8000);
}

// ---------- undo the last prompt ----------

// "Undo last prompt" in the message box puts every file the agent's last
// task changed back the way it was before that task (newest change first,
// see src/undo.js); then it says "Redo last prompt", which puts the agent's
// version back. The files show crossed out in the task's Changes card, and
// the agent is told with your next message. Only while the agent is not
// working, and only when its last task changed files.
// Binary files (and every other file) can be undone when the task has a
// snapshot: their old version comes from it.
function lastTaskFiles(agent) {
  const turn = agent?.transcript?.lastFinished;
  return (turn?.files || []).filter(f => f.status !== 'bin' || turn.snap);
}

function renderUndoButton(agent) {
  const button = $('composer-undo');
  const files = agent && !BUSY.includes(agent.status) ? lastTaskFiles(agent) : [];
  button.classList.toggle('hidden', !files.length || state.current?.kind !== 'agent');
  if (!files.length) return;
  const undone = files.every(f => f.undone);
  const n = files.length;
  button.textContent = undone ? '↷ Redo last prompt' : '↶ Undo last prompt';
  button.title = undone
    ? `Put back the agent's changes to ${n} file${n === 1 ? '' : 's'}`
    : `Put the ${n} file${n === 1 ? '' : 's'} your last message changed back the way ${n === 1 ? 'it was' : 'they were'} before it`;
}

async function undoLastPrompt(agent) {
  const files = lastTaskFiles(agent);
  if (!files.length) return;
  const turn = agent.transcript.lastFinished;
  const redo = files.every(f => f.undone);
  const button = $('composer-undo');
  button.disabled = true;
  const problems = [];
  const done = [];
  for (const f of redo ? files : [...files].reverse().filter(x => !x.undone)) {
    const r = redo
      ? await window.deck.restoreFile(agent.cwd, f.path, f.undone.previous, f.undone.movedBack ? f.from : null).catch(err => ({ ok: false, error: String(err) }))
      : await window.deck.undoFile(agent.cwd, { path: f.path, from: f.from, status: f.status, binary: f.binary, lines: f.lines }, turn?.snap || null).catch(err => ({ ok: false, error: String(err) }));
    if (!r.ok) { problems.push(r.error); continue; }
    f.undone = redo ? null : { previous: r.previous, movedBack: !!r.movedBack };
    done.push(f.path);
  }
  button.disabled = false;
  turn?.answer.querySelector(':scope > .changes')?.syncUndone?.();
  if (done.length) {
    const list = done.length <= 4 ? done.map(p => p.split(SEP).pop()).join(', ') : `${done.length} files`;
    agent.transcript.note(redo ? `Put the changes of your last message back (${list}).` : `Undid the changes of your last message (${list}). The agent hears about it with your next message.`);
  }
  if (problems.length) agent.transcript.note(`Some files were not ${redo ? 'put back' : 'undone'}:\n${problems.join('\n')}`, true);
  // What the agent should know with the next message: the files that are
  // undone now.
  const undoneNow = files.filter(f => f.undone).map(f => f.path);
  agent.undoNote = undoneNow.length ? undoneNow : null;
  sfx(problems.length ? 'refuse' : 'detach');
  renderUndoButton(agent);
}

$('composer-undo').onclick = () => {
  if (state.current?.kind === 'agent') undoLastPrompt(state.current && state.agents.get(state.current.id));
};

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
  if (['idle', 'background'].includes(agent.status)) agent.status = 'working';
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
    // The Auto report learns what 1% of the week is worth (autoreport.js).
    autoReport.noteUsage(msg.rate_limit_info);
    try { localStorage.setItem('usageLimits', JSON.stringify({ limits: usage.limits, at: usage.at })); } catch { /* not important */ }
  } else if (msg.type === 'result') {
    usage.tokens += totalTokens(msg.usage || {});
    usage.tasks++;
    autoReport.noteCost(msg.total_cost_usd);
  } else {
    return;
  }
  hub.setUsage({ ...usage });
}

// ---------- the usage limit ----------

// When your plan's limit is reached, agents stop with "You've hit your
// session limit · resets 10:20pm" (HTTP 429). Each such agent waits (its
// tile says when it continues), and when the limit resets Agent Hub fetches
// the new usage, refreshes the Hub and tells the waiting agents to carry on.
// The waits are kept in local storage, so they survive a restart.
const LIMIT_HIT = /hit your (session |weekly |opus |usage )?limit|usage limit (reached|was hit|hit)|rate_limit/i;
const LIMIT_CONTINUE = 'Your usage limit has reset. Continue where you left off.';

function isLimitHit(msg) {
  return msg?.type === 'result' && msg.is_error && (msg.api_error_status === 429 || LIMIT_HIT.test(msg.result || ''));
}

// When the limit you hit resets, in ms: from the last report of your
// limits, or else from the agent's message ("resets 10:20pm").
function limitResetAt(text) {
  const l = usage.limits;
  const secs = l && l.status === 'rejected' ? l.resetsAt || l.unifiedWindows?.[l.rateLimitType]?.resetsAt : null;
  if (secs && secs * 1000 > Date.now()) return secs * 1000;
  const m = /resets (?:at )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text || '');
  if (m) {
    let h = Number(m[1]);
    if (m[3]) h = (h % 12) + (/pm/i.test(m[3]) ? 12 : 0);
    const d = new Date();
    d.setHours(h, Number(m[2] || 0), 0, 0);
    if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return Date.now() + 15 * 60 * 1000;
}

function limitWaits() {
  try { return JSON.parse(localStorage.getItem('limitWaits') || '{}'); } catch { return {}; }
}
function saveLimitWaits(waits) {
  try { localStorage.setItem('limitWaits', JSON.stringify(waits)); } catch { /* not important */ }
}

// An agent stopped at the limit: it waits for the reset.
function noteLimitHit(a, msg) {
  const at = limitResetAt(msg.result);
  a.limited = { resetAt: at };
  if (a.sessionId) saveLimitWaits({ ...limitWaits(), [a.sessionId]: at });
  a.transcript.note(`Usage limit reached. This agent continues by itself when it resets, at ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`);
  refreshHub();
}

// The tile of an agent that waits for the reset (live or not running).
function limitOf(item) {
  if (item.limited) return item.limited;
  const at = item.sessionId ? limitWaits()[item.sessionId] : null;
  return at ? { resetAt: at } : null;
}

// Every 15 s: once a reset time has passed, fetch the new usage (which
// refreshes the Hub); when the limit is not reached any more, the waiting
// agents continue. While it still is, they wait for its new reset time.
let continuing = false;
async function checkLimitReset() {
  const waits = limitWaits();
  const live = [...state.agents.values()].filter(a => a.limited);
  const due = Math.min(
    ...live.map(a => a.limited.resetAt),
    ...Object.values(waits),
    usage.limits?.status === 'rejected' && usage.limits.resetsAt ? usage.limits.resetsAt * 1000 : Infinity,
  );
  if (continuing || !Number.isFinite(due) || Date.now() < due + 20 * 1000) return;
  continuing = true;
  try {
    await refreshUsage();
    if (usage.limits?.status === 'rejected' && usage.limits.resetsAt * 1000 > Date.now()) {
      // Not reset yet (the limit moved): wait for the new time.
      const at = usage.limits.resetsAt * 1000;
      for (const a of live) a.limited.resetAt = at;
      for (const sid of Object.keys(waits)) waits[sid] = at;
      saveLimitWaits(waits);
      refreshHub();
      return;
    }
    const sessions = new Set(Object.keys(waits));
    for (const a of live) {
      a.limited = null;
      if (a.sessionId) sessions.delete(a.sessionId);
      await sendToHubItem(a.id, LIMIT_CONTINUE).catch(() => {});
    }
    for (const sid of sessions) {
      const runningAgent = [...state.agents.values()].find(x => x.sessionId === sid);
      if (runningAgent) await sendToHubItem(runningAgent.id, LIMIT_CONTINUE).catch(() => {});
      else if (state.parked.has(sid)) await sendToHubItem('p:' + sid, LIMIT_CONTINUE).catch(() => {});
    }
    saveLimitWaits({});
    if (live.length || sessions.size) toast(`Usage limit reset: ${live.length + sessions.size} agent${live.length + sessions.size === 1 ? '' : 's'} continue`);
    refreshHub();
  } finally {
    continuing = false;
  }
}
setInterval(checkLimitReset, 15 * 1000);

// Tokens of each API answer, once per answer: they float off the health bar.
const tickedAnswers = new Set();

window.deck.onEvent((id, msg) => {
  // The agent could not start because claude is not there.
  if (msg.type === 'app_error' && /could not start claude/i.test(msg.message || '') && /ENOENT|not found|no such file/i.test(msg.message || '')) showClaudeMissing();
  noteUsage(msg);
  if (msg.type === 'assistant' && msg.message?.usage && msg.message.id && !tickedAnswers.has(msg.message.id)) {
    tickedAnswers.add(msg.message.id);
    if (tickedAnswers.size > 5000) tickedAnswers.clear();
    hub.tokenTick(tokenParts(msg.message.usage));
  }
  const a = state.agents.get(id);
  if (!a) return;
  a.transcript.add(msg);
  if (msg.type === 'system' && msg.subtype === 'init' && Array.isArray(msg.slash_commands)) rememberSlashCommands(a, msg.slash_commands);
  if (isAuthFailure(msg)) { noteAuthWait(a); noteAuthProblem(); }
  if (msg.type === 'system' && msg.subtype === 'compact_boundary') afterCompact(a);
  if (msg.type === 'assistant') { noteClashes(a, msg.message); taskType.noteMessage(a, msg.message); }
  if (msg.type === 'user' && Array.isArray(msg.message?.content) && msg.message.content.some(b => b?.type === 'tool_result' && b.is_error)) taskType.noteError(a);
  if (msg.type === 'result') clearClashes(a);
  // A finished turn of an Auto agent goes into the Auto report (autoreport.js).
  if (msg.type === 'result' && a.choice?.model === 'auto') {
    autoReport.recordTurn(msg, { family: cliModel(a), title: a.latestTitle || a.summaryTitle || a.title, switched: !!a.autoSwitched, contextBefore: a.autoContext || 0, failedStepUp: !!a.autoFailStep });
    a.autoContext = autoReport.contextOf(msg);
    a.autoSwitched = false;
    a.autoFailStep = false;
  }
  // New textures and videos from this task (see showMedia). Your home folder
  // is too big to search.
  if (msg.type === 'result' && a.mediaSince) {
    const since = a.mediaSince;
    const turn = a.transcript.lastFinished;
    a.mediaSince = null;
    if (a.cwd && a.cwd !== state.config.home) {
      // The task's snapshot gives each changed image's version from before it.
      const snap = a.snapshot;
      window.deck.recentMedia(a.cwd, since).then(files => a.transcript.showMedia(turn, files, snap)).catch(() => {});
    }
  }
  if (msg.type === 'result' && a.snapshot) {
    const snap = a.snapshot;
    const turn = a.transcript.lastFinished;
    // A turn can leave background agents or commands running: they wake the
    // agent up with a turn of its own when they are done, and what they
    // changed belongs to your message too. So the snapshot stays until your
    // next message (sendToAgent), and each turn's card has all of the task
    // so far.
    const earlier = (a.taskTurns || []).filter(t => t && t !== turn);
    a.snapshotHeld = true;
    a.taskTurns = [...earlier, turn];
    // Kept for "Undo last prompt": binary files come back from it.
    if (turn) turn.snap = snap;
    // The card keeps the files the agent touched: in any turn of the task,
    // or in its sub-agents (the background ones are not in the stream).
    const evidence = turn ? window.deck.subagentEvidence(a.sessionId, a.snapshotAt).catch(() => null).then(found => {
      turn.touched = turn.touched || new Set();
      turn.evidence = turn.evidence || [];
      for (const t of earlier) {
        for (const p of t.touched || []) turn.touched.add(p);
        turn.evidence.push(...(t.evidence || []));
      }
      for (const p of found?.touched || []) turn.touched.add(p);
      turn.evidence.push(...(found?.evidence || []));
    }) : Promise.resolve();
    evidence.then(() => window.deck.gitChanges(a.cwd, snap))
      .then(diff => a.transcript.showGitChanges(turn, diff, snap.kind === 'folder'))
      .then(() => saveTurnChanges(turn))
      .then(() => refreshHeaderIfCurrent(a.id))
      .catch(() => {});
  }
  if (msg.type === 'result' && !msg.is_error) learnFrom(a, a.transcript.lastFinished, msg.result);
  if (msg.type === 'result' && !msg.is_error && a.status === 'idle') loadFollowUps(a, a.transcript.lastFinished, msg.result);
  if (msg.type === 'result' && !msg.is_error && a.ticket) addTicketPost(a, a.transcript.lastFinished, msg.result);
  if (msg.type === 'result' && !msg.is_error) {
    // Used to find the most recently finished agent of a Group.
    a.finishedAt = Date.now();
    saveHub();
  }
  // A turn that leaves background jobs running is not the end of the task
  // (status "background"): the notification and sound come when it is.
  const limitHit = isLimitHit(msg);
  if (limitHit) noteLimitHit(a, msg);
  if (msg.type === 'result' && a.status !== 'background') {
    window.deck.notify(a.id, a.title, limitHit ? `Usage limit reached: continues at ${new Date(a.limited.resetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : a.authWait ? 'Signed out: continues after you sign in' : msg.is_error ? 'Stopped with an error' : 'Finished and waiting for you');
    if (playSounds()) {
      if (!msg.is_error) sounds.done();
      else if (!a.stopping && !limitHit && !a.authWait) sounds.error();
    }
    // Stopped before it was done: you pressed Stop, or it ended with an
    // error (not the usage limit or a sign-in, which continue by themselves).
    // Its tile and message box offer Restart (see restartAgent).
    a.stopped = !!a.stopping || (!!msg.is_error && !limitHit && !a.authWait);
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
  if (status !== 'idle') clearFollowUps(a);
  // Its group moved to another folder while it worked (moveGroup): it moves now.
  if (a.moveWhenDone && !BUSY.includes(status)) {
    const folder = a.moveWhenDone;
    a.moveWhenDone = null;
    moveToFolder(a.id, folder);
  }
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
  const isQuestion = req.tool_name === 'AskUserQuestion' && Array.isArray(req.input?.questions);
  const answer = decision => {
    if (a.pendingQuestion?.requestId === req.requestId) a.pendingQuestion = null;
    window.deck.respondPermission(id, req.requestId, decision);
    // Answering its questions sends the agent back to work, like a new
    // message: the chat closes into its tile (unless "Show the Hub after
    // sending" is off). The card shows the answers for a moment first.
    if (isQuestion && decision.behavior === 'allow' && state.current?.kind === 'agent' && state.current.id === id
        && state.config.hubAfterSend !== false) {
      setTimeout(() => { if (state.current?.kind === 'agent' && state.current.id === id) afterSend(a, true); }, 450);
    }
  };
  // A question from Claude (AskUserQuestion) arrives as a permission request;
  // it gets a card with its options instead of Allow/Deny.
  if (!(state.current?.kind === 'agent' && state.current.id === id)) a.unread = true;
  if (isQuestion) {
    a.attention = 'question';
    a.pendingQuestion = { requestId: req.requestId, card: a.transcript.question(req, answer) };
    window.deck.notify(a.id, a.title, `Asks: ${req.input.questions[0]?.question || 'a question'}`);
  } else {
    a.attention = 'approval';
    a.transcript.permission(req, answer);
    window.deck.notify(a.id, a.title, req.title || `Needs approval to use ${req.display_name || req.tool_name}`);
  }
  // A question sounds like one; an approval like a call for attention.
  if (playSounds()) (a.attention === 'question' ? sounds.question : sounds.attention)();
  refreshHeaderIfCurrent(id);
  refreshHub();
});

// What the agent still runs in the background (descriptions), for its tile.
window.deck.onBackground((id, tasks) => {
  const a = state.agents.get(id);
  if (!a) return;
  a.backgroundTasks = tasks;
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
  rememberNotesSeen(a);
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
  // An agent that is going back to one of your messages restarts itself.
  const waiter = exitWaiters.get(id);
  if (waiter) {
    exitWaiters.delete(id);
    waiter();
    return;
  }
  const a = state.agents.get(id);
  if (!a || state.quitting) return;
  clearClashes(a);
  if (code !== 0 && AUTH_FAILURE.test(stderr)) {
    if (a.sessionId) saveAuthWaits([...authWaits(), a.sessionId]);
    noteAuthProblem();
  }
  if (code !== 0 && stderr.trim()) a.transcript.note(stderr.trim().split('\n').slice(-12).join('\n'), true);
  a.transcript.note(`Agent process ended (exit code ${code}).`);
  a.wasBusy = ['working', 'starting', 'waiting', 'stuck'].includes(a.status) && !a.closing;
  a.status = 'exited';
  // Keep the chat open as a history entry, so you can read it and resume it.
  state.agents.delete(id);
  // Its process ended with an error, or in the middle of a task: Restart continues it.
  if (!a.removed && a.sessionId) state.parked.set(a.sessionId, { ...hubInfo(a), stopped: code !== 0 || !!a.stopped || a.wasBusy });
  const session = { id: a.sessionId || id, title: a.title, cwd: a.cwd, file: null, updatedAt: Date.now() };
  state.history.set(session.id, { session, view: a.view, transcript: a.transcript, cwd: a.cwd, choice: a.choice, mode: a.mode, autoLevel: a.autoLevel });
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
    if (!reviewNext()) openKeyAgent();
    return;
  }
  if ((!typed && !hasFiles) || !state.current) return;
  // /diff [what]: the diff of this branch (or of what you name), drawn by
  // Agent Hub without asking the agent (see diffBlock in render.js).
  const diffCommand = /^\/diff(?:\s+([\s\S]*))?$/.exec(typed);
  if (diffCommand && ['agent', 'history'].includes(state.current.kind)) {
    const target = state.current.kind === 'agent' ? state.agents.get(state.current.id) : state.history.get(state.current.id);
    input.value = '';
    autosize();
    target?.transcript.showDiff((diffCommand[1] || '').trim());
    return;
  }
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

  if (state.current.kind === 'hub' && hub.selected.size) {
    await broadcast(text, images);
  } else if (state.current.kind === 'hub') {
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
    // A message that is (or starts with) a Jira ticket brings the ticket along.
    const ticket = ticketIn(text);
    // Reading the ticket and writing a handoff (a long parent is not copied,
    // see startFrom) take a few seconds. They run while the new tile boots
    // up in its group, so pressing Enter shows the agent at once.
    const prepare = async note => {
      let prompt = text;
      if (ticket) {
        note(`Reading ${ticket}…`);
        const details = await window.deck.jiraDetails(ticket).catch(err => ({ error: String(err?.message || err) }));
        if (details.error) flashComposerNote(`Could not read ${ticket} (${details.error}). The agent gets your message as it is.`);
        else prompt = ticketPrompt(details, text);
      }
      return { prompt, ...(await startFrom(forkFrom, note)) };
    };
    if (playSounds()) sounds.created();
    await startAgent({ cwd: d.folder, prompt: text, permissionMode: d.mode, choice: d.choice, groupId: d.groupId, fromRect, images, ticket, prepare });
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
    [...a.view.querySelectorAll('.msg-user')].pop()?.classList.add('just-sent');
    notePrompt(a, text);
    afterSend(a, true);
    await sendToAgent(a, text, images);
  } else if (state.current.kind === 'history') {
    const h = state.history.get(state.current.id);
    const parked = state.parked.get(h.session.id);
    if (parked?.moved) h.moved = true;
    const cwd = parked?.moved ? parked.cwd : h.cwd || h.session.cwd;
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
function sfx(name, ...args) {
  // A hum that is running always stops, even if sounds were turned off since.
  if (playSounds() || (name === 'bootHum' && args[0] === false)) sounds[name]?.(...args);
}
window.uiSound = sfx;

// In the retro theme (theme.js) every key you type in a text box chirps, as
// the letters do on MOTHER's screen in Alien. Enter in the message box sends,
// which has its own sound.
document.addEventListener('keydown', e => {
  if (document.documentElement.dataset.theme !== 'mother' || !playSounds()) return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
  const t = e.target;
  if (!(t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && /^(text|search|number|)$/.test(t.type)) || t?.isContentEditable)) return;
  // Holding a key down: every other repeat, so it does not drone.
  if (e.repeat && (keyRepeats = (keyRepeats + 1) % 2)) return;
  let kind = null;
  if (e.key === 'Backspace' || e.key === 'Delete') kind = 'back';
  else if (e.key === 'Enter') kind = t.id === 'input' && !e.shiftKey ? null : 'enter';
  else if (e.key === ' ') kind = 'space';
  else if (e.key.length === 1) kind = 'char';
  if (kind) sounds.key(kind);
}, true);
let keyRepeats = 0;

// The message box grows with what you type, up to 240px. An empty box is
// one line: measured empty, the browser counts the placeholder, and while
// the box is narrow (flying into a new tile after Enter) that wraps over
// many lines and left the box tall. It is measured again when the window
// changes size.
function autosize() {
  const input = $('input');
  if (!input.value) {
    input.style.height = '';
    return;
  }
  input.style.height = 'auto';
  // scrollHeight leaves out the border, which the height includes.
  const border = input.offsetHeight - input.clientHeight;
  input.style.height = Math.min(input.scrollHeight + border, 240) + 'px';
  updateSlashOverlay();
}

$('input').addEventListener('input', autosize);
window.addEventListener('resize', () => requestAnimationFrame(autosize));
// ↑ in an agent's message box puts your latest message to it back in the
// box (to change or send again); ↑ again goes further back, ↓ forward, and
// past the newest you get back what was in the box. Only from the start of
// the text (↑) or its end (↓), so moving the cursor in what you type still
// works. Typing ends the recall.
const recall = { key: null, index: -1, draft: '', shown: null };
function recallPrompt(step) {
  const cur = state.current;
  const transcript = cur?.kind === 'agent' ? state.agents.get(cur.id)?.transcript : cur?.kind === 'history' ? state.history.get(cur.id)?.transcript : null;
  const prompts = (transcript?.prompts || []).map(p => p.text).filter(Boolean);
  if (!prompts.length) return false;
  const input = $('input');
  const key = viewKey(cur);
  // A new recall unless the box still shows the message this one put there
  // (after sending it, or changing it, it starts again from the newest).
  if (recall.key !== key || input.value !== recall.shown) Object.assign(recall, { key, index: prompts.length, draft: input.value });
  const next = recall.index + step;
  if (next < 0 || next > prompts.length) return false;
  recall.index = next;
  input.value = next === prompts.length ? recall.draft : prompts[next];
  recall.shown = input.value;
  autosize();
  const end = step < 0 ? 0 : input.value.length;
  input.setSelectionRange(end, end);
  if (next === prompts.length) recall.key = null;
  return true;
}
$('input').addEventListener('input', () => { recall.key = null; });

$('input').addEventListener('keydown', e => {
  const box = $('input');
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing
      && ['agent', 'history'].includes(state.current?.kind)) {
    const atStart = box.selectionStart === 0 && box.selectionEnd === 0;
    const atEnd = box.selectionStart === box.value.length && box.selectionEnd === box.value.length;
    const recalling = recall.key === viewKey(state.current) && box.value === recall.shown;
    if (e.key === 'ArrowUp' && (atStart || !box.value) && recallPrompt(-1)) { e.preventDefault(); return; }
    if (e.key === 'ArrowDown' && recalling && atEnd && recallPrompt(1)) { e.preventDefault(); return; }
  }
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

// ---------- suggested follow-ups ----------

// After a task, Haiku suggests the messages you will likely send next
// (suggestFollowUps in agents.js). In the agent's chat they show as chips
// above the message box, and the first one as the box's grey placeholder:
// → (in the empty box) or a click puts one in the box, Alt+1–3 sends one
// right away. They go away with your next message.
const DEFAULT_PLACEHOLDER = 'Message the agent… (↩ to send, ⇧↩ for a new line)';

function loadFollowUps(agent, turn, answer) {
  agent.followUps = null;
  if (state.config.suggestFollowUps === false || !answer?.trim()) return;
  const task = agent.transcript.prompts.filter(p => p.turn === turn).pop()?.text
    || agent.transcript.prompts[agent.transcript.prompts.length - 1]?.text || '';
  const group = findGroup(agent.groupId);
  const notes = sharesNotes(group) ? group?.notes?.text || '' : '';
  agent.followUpsFor = turn;
  window.deck.followUps({ task, answer, notes }).then(list => {
    // Only while the agent still waits for you after that same task.
    if (agent.followUpsFor !== turn || agent.status !== 'idle' || !list?.length) return;
    agent.followUps = list;
    renderFollowUps();
    refreshHub();
  }).catch(() => {});
}

function clearFollowUps(agent) {
  if (!agent) return;
  agent.followUpsFor = null;
  if (!agent.followUps) return;
  agent.followUps = null;
  renderFollowUps();
  refreshHub();
}

function currentFollowUps() {
  const a = state.current?.kind === 'agent' ? state.agents.get(state.current.id) : null;
  return a?.status === 'idle' && !a.pendingQuestion && a.followUps?.length ? a.followUps : null;
}

function renderFollowUps() {
  const input = $('input');
  let box = document.getElementById('followups');
  if (!box) {
    box = el('div', 'followups hidden');
    box.id = 'followups';
    input.before(box);
  }
  const list = currentFollowUps();
  const show = !!list && !input.value.trim();
  box.classList.toggle('hidden', !show);
  if (state.current?.kind === 'agent') input.placeholder = show ? `${list[0]}   (→ to use)` : DEFAULT_PLACEHOLDER;
  if (!show) return;
  box.replaceChildren();
  list.forEach((text, i) => {
    const chip = el('button', 'followup');
    chip.type = 'button';
    chip.title = `Click: put it in the box · Alt+${i + 1}: send it now`;
    chip.append(el('kbd', null, `Alt+${i + 1}`), el('span', null, text));
    chip.onclick = () => fillFollowUp(text);
    box.appendChild(chip);
  });
}

function fillFollowUp(text) {
  const input = $('input');
  input.value = text;
  autosize();
  input.focus();
  input.setSelectionRange(text.length, text.length);
  renderFollowUps();
}

$('input').addEventListener('input', renderFollowUps);
$('input').addEventListener('keydown', e => {
  // → in the empty box takes the first suggestion.
  if (e.key === 'ArrowRight' && !$('input').value && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    const list = currentFollowUps();
    if (list) { e.preventDefault(); fillFollowUp(list[0]); }
  }
});
// ---------- / commands ----------

// A message that starts with /name runs that skill or custom command in
// Claude Code (/auditing:project-audit, /review, /compact …). While you type
// the name, a list above the message box shows the matching commands: ↑ ↓
// to move, Tab or ↩ to take one, Esc to close. The names come from Claude
// Code itself (the list it sends when an agent starts, kept for the Hub's
// box too) and from the command and skill files (src/slashcommands.js),
// which also give the descriptions.
const SLASH_NAME = /^\/[A-Za-z0-9][\w:.-]*(\s|$)/;
function isSlashCommand(text) {
  return SLASH_NAME.test(String(text || '').trimStart()) && !/^\/diff(\s|$)/.test(String(text).trimStart());
}

function rememberSlashCommands(agent, names) {
  agent.slashCommands = names;
  try { localStorage.setItem('slashCommands', JSON.stringify(names)); } catch {}
  slashFiles.clear();
}

const slashFiles = new Map();   // folder -> { at, list: promise }
function slashFolder() {
  const cur = state.current;
  if (cur?.kind === 'agent') return state.agents.get(cur.id)?.cwd || null;
  if (cur?.kind === 'history') return state.history.get(cur.id)?.cwd || null;
  return ensureDraft().folder || state.config?.home || null;
}

async function slashCommandList() {
  const cwd = slashFolder();
  let cached = slashFiles.get(cwd || '');
  if (!cached || Date.now() - cached.at > 30000) {
    cached = { at: Date.now(), list: window.deck.slashCommands(cwd).catch(() => []) };
    slashFiles.set(cwd || '', cached);
  }
  const files = await cached.list;
  const cur = state.current?.kind === 'agent' ? state.agents.get(state.current.id) : null;
  let names = cur?.slashCommands;
  if (!names) { try { names = JSON.parse(localStorage.getItem('slashCommands') || 'null'); } catch { names = null; } }
  const byName = new Map(files.map(c => [c.name, c]));
  const list = [...files];
  for (const n of names || []) if (!byName.has(n)) list.push({ name: n, description: '', hint: '', source: 'claude' });
  if (['agent', 'history'].includes(state.current?.kind)) {
    list.push({ name: 'diff', description: 'The diff of this branch, drawn by Agent Hub (the agent is not asked)', hint: '[what]', source: 'app' });
  }
  return list;
}

// Best matches first: the name starts with what you typed, then the part
// after "plugin:" does, then the name or the description contains it.
function rankSlash(list, query) {
  const q = query.toLowerCase();
  const score = c => {
    const n = c.name.toLowerCase();
    const short = n.includes(':') ? n.slice(n.indexOf(':') + 1) : n;
    if (!q) return 1;
    if (n.startsWith(q)) return 4;
    if (short.startsWith(q)) return 3;
    if (n.includes(q)) return 2;
    if ((c.description || '').toLowerCase().includes(q)) return 1;
    return 0;
  };
  return list.map(c => ({ c, s: score(c) })).filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || a.c.name.localeCompare(b.c.name)).map(x => x.c);
}

const slashMenu = { el: null, items: [], index: 0, query: null };
function closeSlashMenu() {
  slashMenu.el?.remove();
  slashMenu.el = null;
  slashMenu.items = [];
  slashMenu.query = null;
  updateSlashOverlay();
}

// The name being typed: the box starts with / and the cursor is still in
// the first word.
function slashQuery() {
  const box = $('input');
  const m = /^\/([\w:.-]*)$/.exec(box.value.slice(0, box.selectionStart));
  if (!m || box.selectionStart !== box.selectionEnd) return null;
  const rest = box.value.slice(box.selectionStart);
  return /^\S/.test(rest) ? null : m[1];
}

async function updateSlashMenu() {
  const query = slashQuery();
  if (query == null) return closeSlashMenu();
  const items = rankSlash(await slashCommandList(), query);
  if (slashQuery() !== query) return;   // you typed on in the meantime
  if (!items.length) return closeSlashMenu();
  const keep = slashMenu.items[slashMenu.index]?.name;
  slashMenu.items = items;
  slashMenu.query = query;
  slashMenu.index = Math.max(0, items.findIndex(c => c.name === keep));
  renderSlashMenu();
}

// The command in the box, drawn over it: a name you typed in full shows as
// a chip, and while you type one, the rest of the highlighted match shows
// faint after the cursor (Tab or → takes it). The box's own text turns
// transparent meanwhile (its caret and selection stay); the drawing copies
// the box's font, padding and size so the letters land on the same spots.
// Without a / command at the start the box is left as it is.
const MIRRORED = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textTransform', 'textIndent',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'tabSize'];
function slashGhost() {
  const c = slashMenu.el && slashMenu.items[slashMenu.index];
  const box = $('input');
  if (!c || slashMenu.query == null || box.selectionStart !== box.value.length) return '';
  return c.name.toLowerCase().startsWith(slashMenu.query.toLowerCase()) ? c.name.slice(slashMenu.query.length) : '';
}

function updateSlashOverlay() {
  const box = $('input');
  let overlay = document.querySelector('.slash-overlay');
  const slash = box.value.startsWith('/');
  const name = slash && /^\/([A-Za-z0-9][\w:.-]*)(?=\s|$)/.exec(box.value)?.[1];
  const chip = name && overlay?._known?.has(name);
  const ghost = slash ? slashGhost() : '';
  if (!chip && !ghost) {
    overlay?.classList.add('hidden');
    box.classList.remove('slash-mirrored');
    box.spellcheck = true;
    return;
  }
  if (!overlay) {
    overlay = el('div', 'slash-overlay');
    overlay.setAttribute('aria-hidden', 'true');
    box.after(overlay);
  }
  const cs = getComputedStyle(box);
  for (const p of MIRRORED) overlay.style[p] = cs[p];
  overlay.style.borderStyle = 'solid';
  overlay.style.borderColor = 'transparent';
  overlay.style.left = box.offsetLeft + 'px';
  overlay.style.top = box.offsetTop + 'px';
  overlay.style.width = box.offsetWidth + 'px';
  overlay.style.height = box.offsetHeight + 'px';
  // A scrollbar in the box narrows its lines; the drawing's too.
  const bar = box.offsetWidth - box.clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
  overlay.style.paddingRight = `calc(${cs.paddingRight} + ${Math.max(0, bar)}px)`;
  overlay.textContent = '';
  const head = chip ? '/' + name : '';
  if (chip) overlay.append(el('span', 'slash-chip', head));
  overlay.append(document.createTextNode(box.value.slice(head.length)));
  if (ghost) overlay.append(el('span', 'slash-ghost', ghost));
  // A trailing new line needs something after it to take up its line.
  overlay.append('​');
  overlay.scrollTop = box.scrollTop;
  overlay.classList.remove('hidden');
  box.classList.add('slash-mirrored');
  // Spelling marks would underline the command's name.
  box.spellcheck = !chip;
}

// The names a chip is drawn for; kept up to date as the list is fetched.
async function learnSlashNames() {
  const list = await slashCommandList();
  let overlay = document.querySelector('.slash-overlay');
  if (!overlay) {
    overlay = el('div', 'slash-overlay hidden');
    overlay.setAttribute('aria-hidden', 'true');
    $('input').after(overlay);
  }
  overlay._known = new Set(list.map(c => c.name));
  updateSlashOverlay();
}

function renderSlashMenu() {
  if (!slashMenu.el) {
    slashMenu.el = el('div', 'slash-menu');
    document.querySelector('.composer-box').appendChild(slashMenu.el);
  }
  const menu = slashMenu.el;
  menu.textContent = '';
  slashMenu.items.forEach((c, i) => {
    const row = el('div', `slash-row${i === slashMenu.index ? ' on' : ''}`);
    const name = el('span', 'slash-name', '/' + c.name);
    row.append(name);
    if (c.hint) row.append(el('span', 'slash-hint', c.hint));
    row.append(el('span', 'slash-desc', c.description || (c.source === 'claude' ? 'Claude Code command' : '')));
    if (c.source === 'plugin' || c.source === 'project') row.append(el('span', 'slash-source', c.source));
    row.title = c.description || '';
    row.onmousedown = e => { e.preventDefault(); pickSlash(i); };
    row.onmousemove = () => { if (slashMenu.index !== i) { slashMenu.index = i; renderSlashMenu(); } };
    menu.appendChild(row);
  });
  menu.querySelector('.slash-row.on')?.scrollIntoView({ block: 'nearest' });
  updateSlashOverlay();
}

function pickSlash(i) {
  const c = slashMenu.items[i];
  if (!c) return;
  const box = $('input');
  const rest = box.value.slice(box.selectionStart).replace(/^\S*/, '');
  const head = `/${c.name}`;
  box.value = head + (rest.startsWith(' ') ? rest : ' ' + rest);
  box.setSelectionRange(head.length + 1, head.length + 1);
  box.dispatchEvent(new Event('input'));
  closeSlashMenu();
  sfx('tick');
}

$('input').addEventListener('input', () => {
  updateSlashMenu();
  if ($('input').value.startsWith('/')) learnSlashNames();
});
$('input').addEventListener('scroll', () => {
  const overlay = document.querySelector('.slash-overlay');
  if (overlay) overlay.scrollTop = $('input').scrollTop;
});
$('input').addEventListener('click', () => { updateSlashMenu(); });
$('input').addEventListener('blur', () => setTimeout(closeSlashMenu, 120));
// Runs before the box's other keys (↩ sends, ↑ recalls your last message).
$('input').addEventListener('keydown', e => {
  if (!slashMenu.el || e.isComposing) return;
  const n = slashMenu.items.length;
  let handled = true;
  if (e.key === 'ArrowDown') slashMenu.index = (slashMenu.index + 1) % n;
  else if (e.key === 'ArrowUp') slashMenu.index = (slashMenu.index - 1 + n) % n;
  else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
    // ↩ on a name you typed in full sends it, like without the list.
    const exact = slashMenu.items[slashMenu.index]?.name === slashMenu.query;
    if (e.key === 'Enter' && exact) { closeSlashMenu(); return; }
    pickSlash(slashMenu.index);
  } else if (e.key === 'ArrowRight' && slashGhost()) pickSlash(slashMenu.index);
  else if (e.key === 'Escape') closeSlashMenu();
  else handled = false;
  if (!handled) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (slashMenu.el) renderSlashMenu();
}, true);

// Alt+1–3 sends that suggestion right away (Ctrl+1–9 switch agents).
document.addEventListener('keydown', e => {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !/^Digit[1-9]$/.test(e.code)) return;
  const list = currentFollowUps();
  const text = list?.[Number(e.code.slice(5)) - 1];
  if (!text) return;
  e.preventDefault();
  $('input').value = text;
  sendFromComposer();
});



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

// Restart: an agent that stopped before it was done (you pressed Stop, or
// it ended with an error or its process ended) continues its task. A
// running agent gets a message that tells it so; one whose process ended
// starts again on its saved session first (like after closing the app).
const RESTART_PROMPT = 'Your last task was stopped before it was done. Continue it where you left off.';
async function restartAgent(id) {
  const live = state.agents.get(id);
  if (live) {
    if (!live.stopped || !['idle', 'error'].includes(live.status)) return;
    live.stopped = false;
    sfx('sent');
    // The tile keeps the title of the task it continues.
    live.transcript.add({ type: 'user', message: { role: 'user', content: RESTART_PROMPT } });
    live.status = 'working';
    hub.wake(live.id);
    refreshHub();
    refreshHeaderIfCurrent(live.id);
    await sendToAgent(live, RESTART_PROMPT);
    return;
  }
  const sessionId = id.startsWith('p:') ? id.slice(2) : id;
  const p = state.parked.get(sessionId);
  if (!p?.stopped) return;
  const session = state.sessions.find(s => s.id === sessionId) || { id: sessionId, title: p.title, cwd: p.cwd, file: null };
  if (!session.file) await loadSessions();
  const saved = state.sessions.find(s => s.id === sessionId);
  if (!saved?.file) { toast('Its saved session was not found, so it cannot restart.'); return; }
  p.stopped = false;
  sfx('sent');
  try {
    const h = await loadHistory({ ...saved, title: p.title || saved.title });
    await startAgent({ cwd: h.cwd || saved.cwd || p.cwd, prompt: RESTART_PROMPT, permissionMode: p.mode, choice: p.choice, resume: h });
    // The tile keeps the title of the task it continues.
    const a = [...state.agents.values()].find(x => x.sessionId === sessionId || x.view === h.view);
    if (a && p.latestTitle) { a.latestTitle = p.latestTitle; a.latestPrompt = p.latestPrompt; refreshHub(); }
  } catch (err) {
    p.stopped = true;
    toast(`Could not restart: ${err?.message || err}`);
  }
  saveHub();
}

// The Restart button in the message box, for the agent (or saved session) on screen.
function renderRestartButton() {
  const cur = state.current;
  const b = $('composer-restart');
  if (!b) return;
  const live = cur?.kind === 'agent' ? state.agents.get(cur.id) : null;
  const parked = cur?.kind === 'history' ? state.parked.get(cur.id) : null;
  const show = live ? !!live.stopped && ['idle', 'error'].includes(live.status) : !!parked?.stopped;
  b.classList.toggle('hidden', !show);
  b.dataset.id = live ? live.id : cur?.id || '';
}
$('composer-restart').onclick = () => { const id = $('composer-restart').dataset.id; if (id) restartAgent(id); };
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
$('open-settings').onclick = () => { setHistoryOpen(false); showSettings(); };

// The Settings screen (settings.js). Saved settings apply right away: new
// agents use the new defaults, and the Hub's message box picks them up.
function showSettings() {
  openSettings(state.config, {
    onSaved: config => {
      state.config = config;
      applyTheme(config.theme, { curved: config.curvedScreen !== false });
      if (state.current?.kind === 'hub' && state.draft) {
        state.draft.choice = defaultChoice();
        state.draft.mode = defaultMode();
        show('hub');
      }
      renderSettingsButton();
      sfx('approve');
    },
  });
}
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
      && !document.querySelector('.group-panel, .model-menu:not(.hidden), .lightbox, .uml-full, .settings-modal')) {
    e.preventDefault();
    if (!reviewNext()) openKeyAgent();
  }
  // Tab never moves the focus around the app; it opens the next agent to
  // check. In the Hub with none to check, it chooses the next agent of the
  // selected group instead (⇧Tab the previous one).
  if (e.key === 'Tab' && !isMod(e) && !e.altKey && !e.target.closest?.('.settings-modal')) {
    e.preventDefault();
    if (!document.querySelector('.group-panel, .model-menu:not(.hidden), .lightbox, .uml-full')) {
      if (state.current?.kind === 'hub' && !reviewQueue().length && hub.moveKeyAgent(e.shiftKey ? -1 : 1)) return;
      checkNext();
    }
  }
  // In the Hub, with the message box empty: ← → choose an agent of the
  // selected group, ↑ ↓ another group (see hub.moveKeyAgent).
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) && !isMod(e) && !e.altKey && !e.shiftKey
      && state.current?.kind === 'hub' && (!typing || (e.target.id === 'input' && !e.target.value))
      && !document.querySelector('.group-panel, .model-menu:not(.hidden), .lightbox, .uml-full, .settings-modal, .quit-modal, .slash-menu, .usage-rail.open')) {
    const moved = e.key === 'ArrowLeft' ? hub.moveKeyAgent(-1) : e.key === 'ArrowRight' ? hub.moveKeyAgent(1)
      : hub.moveKeyGroup(e.key === 'ArrowUp' ? -1 : 1);
    if (moved) e.preventDefault();
  }
  // Esc leaves an agent (or a saved session, a new agent, or the branch
  // diff view) for the Hub. The Stop button in the top bar stops a running turn.
  if (e.key === 'Escape' && !e.popupWasOpen && ['agent', 'history', 'new', 'branches'].includes(state.current?.kind)) {
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
  if (e.key === 'Escape') e.popupWasOpen = !!document.querySelector('.model-menu:not(.hidden), .group-panel, .uml-full, .uml-detail, .lightbox, .settings-modal, .quit-modal');
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
  if (document.querySelector('.quit-modal, .settings-modal, .group-panel, .model-menu:not(.hidden), .lightbox, .uml-full, .uml-detail, .usage-rail.open')) return;
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
  const limits = { longMs: (c.stuckAfterSeconds || 30) * 1000 };
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
  applyTheme(state.config.theme, { curved: state.config.curvedScreen !== false });
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
  await loadAgentList();
  warmSnapshots();
  // Without Claude Code no agent can start: say so, and how to install it.
  window.deck.setupClaude().then(r => { if (!r.found) showClaudeMissing(); }).catch(() => {});
  // Agents that were waiting for a sign-in when the app closed: offer it again.
  if (authWaits().length) setTimeout(noteAuthProblem, 1500);
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
