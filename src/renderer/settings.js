// The Settings screen: every setting in config.json as a form. Saving writes
// config.json (see config:save in main.js) and applies at once; the file
// stays the place for anything the form does not show.

const EFFORT_OPTIONS = [['', 'Model default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']];

function settingsField(label, hint, control) {
  const row = el('label', 'settings-field');
  const text = el('div', 'settings-label');
  text.append(el('div', 'settings-name', label));
  if (hint) text.append(el('div', 'settings-hint', hint));
  row.append(text, control);
  return row;
}

function settingsSelect(options, value) {
  const select = document.createElement('select');
  for (const [v, label] of options) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    select.appendChild(o);
  }
  // A value the list does not know (set by hand in config.json) stays.
  if (!options.some(([v]) => v === value)) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = value;
    select.appendChild(o);
  }
  select.value = value;
  return select;
}

function settingsInput(type, value, attrs = {}) {
  const input = document.createElement('input');
  input.type = type;
  if (type === 'checkbox') input.checked = !!value;
  else input.value = value ?? '';
  Object.assign(input, attrs);
  return input;
}

function settingsText(value, placeholder) {
  const area = document.createElement('textarea');
  area.rows = 3;
  area.value = value;
  area.placeholder = placeholder;
  area.spellcheck = false;
  return area;
}

// Opens the screen. config: the settings now; onSaved(config) after a save.
function openSettings(config, { onSaved } = {}) {
  if (document.querySelector('.settings-modal')) return;
  const overlay = el('div', 'settings-modal');
  const card = el('div', 'settings-card');
  const head = el('div', 'settings-head');
  head.append(el('div', 'settings-title', 'Settings'));
  const body = el('div', 'settings-body');

  // New agents
  const folder = settingsInput('text', config.defaultFolder, { placeholder: 'The folder of the agent you started last' });
  const pick = el('button', null, 'Choose…');
  pick.type = 'button';
  pick.onclick = async e => {
    e.preventDefault();
    const chosen = await window.deck.pickFolder();
    if (chosen) folder.value = chosen;
  };
  const folderRow = el('div', 'settings-inline');
  folderRow.append(folder, pick);
  const mode = settingsSelect(PERMISSION_MODES.map(m => [m.value, m.label]), config.defaultPermissionMode || 'bypassPermissions');
  // The same choices as the model menu (Auto, Opus, Sonnet, Haiku, Fable); a
  // saved choice that is no longer in it stays listed so it is not lost.
  const modelChoices = menuModels().map(m => [m.value, shortName(m)]);
  if (config.defaultModel && !modelChoices.some(([v]) => v === config.defaultModel)) modelChoices.push([config.defaultModel, shortName(modelByValue(config.defaultModel))]);
  const model = settingsSelect(modelChoices, config.defaultModel || 'auto');
  const reportBtn = el('button', 'settings-btn', 'Open report');
  reportBtn.type = 'button';
  reportBtn.onclick = () => autoReport.open();
  const effort = settingsSelect(EFFORT_OPTIONS, config.defaultEffort || '');
  const fast = settingsInput('checkbox', config.defaultFastMode);
  const compact = settingsSelect([['150k', '150k tokens'], ['200k', '200k tokens'], ['300k', '300k tokens'], ['500k', '500k tokens'], ['auto', 'When Claude Code decides']], config.autoCompact || '200k');

  // The app
  const hubAfterSend = settingsInput('checkbox', config.hubAfterSend !== false);
  const titles = settingsInput('checkbox', config.summarizeTitles !== false);
  const followUps = settingsInput('checkbox', config.suggestFollowUps !== false);
  const notify = settingsInput('checkbox', config.notifyWhenDone !== false);
  const sounds = settingsInput('checkbox', config.sounds !== false);
  const theme = settingsSelect(THEMES, config.theme || 'default');
  const curved = settingsInput('checkbox', config.curvedScreen !== false);

  // Branch diff
  const svnProject = settingsInput('text', config.svnProject || '', { placeholder: 'MergeTavern' });

  // Stuck agents
  const stuckAfter = settingsInput('number', config.stuckAfterSeconds, { min: 5, step: 5 });

  // Claude Code
  const claudePath = settingsInput('text', config.claudePath, { placeholder: 'Found by itself: the newest Claude Code installed' });
  const extraArgs = settingsText((config.extraArgs || []).join('\n'), 'One flag or value per line, for example\n--add-dir\nC:\\Some\\Folder');
  const env = settingsText(Object.entries(config.env || {}).map(([k, v]) => `${k}=${v}`).join('\n'), 'One per line: NAME=value');

  const section = (title, ...rows) => {
    const s = el('div', 'settings-section');
    s.append(el('div', 'settings-section-title', title), ...rows);
    return s;
  };
  body.append(
    section('New agents',
      settingsField('Folder', 'Where a new agent works until you pick one in the Hub', folderRow),
      settingsField('Permissions', null, mode),
      settingsField('Model', 'Auto picks Opus, Sonnet or Haiku for each task', model),
      settingsField('Auto model report', 'What Auto cost against running everything on Opus at medium effort', reportBtn),
      settingsField('Effort', null, effort),
      settingsField('Fast mode', 'Faster answers from the same model', fast),
      settingsField('Compact the conversation at', 'Every step re-reads the whole conversation, so long tasks get expensive. Smaller: less usage, but the agent remembers fewer details from early in the task', compact)),
    section('The app',
      settingsField('Theme', 'Nostromo: the screens of the ship’s computer in Alien, on an old tube', theme),
      settingsField('Curved screen', 'Nostromo only: the screen has the bulging shape of a tube’s glass, with scanlines that bow with it', curved),
      settingsField('Show the Hub after sending', 'Off: stay in the chat after you send a message', hubAfterSend),
      settingsField('Short titles', 'Name new agents with a summary of your message, written by Haiku', titles),
      settingsField('Suggest follow-ups', 'After a task, the messages you will likely send next, written by Haiku. → or a click puts one in the box, Alt+1–3 sends it', followUps),
      settingsField('Notifications', 'When an agent finishes or needs you while the app is in the background', notify),
      settingsField('Sounds', 'For everything you and the agents do', sounds)),
    section('Branch diff',
      settingsField('Project', `The Branches view lists ${(config.svnServer || 'svn+ssh://svn@tactile.build').replace(/\/+$/, '')}/<project>/branches`, svnProject)),
    section('Stuck agents',
      settingsField('Waiting for Unity for', 'Seconds. An agent only counts as stuck while it waits for Unity to be ready', stuckAfter)),
    section('Claude Code',
      settingsField('Claude Code program', 'Empty: the app finds it', claudePath),
      settingsField('Extra flags', 'Added to every agent', extraArgs),
      settingsField('Environment variables', 'For every agent', env)),
  );

  const problem = el('div', 'settings-problem hidden');
  const foot = el('div', 'settings-foot');
  const file = el('button', 'link', 'Open config.json');
  file.type = 'button';
  file.title = 'The file with these settings';
  file.onclick = () => window.deck.openConfig();
  const cancel = el('button', null, 'Cancel');
  cancel.type = 'button';
  const save = el('button', 'settings-save', 'Save');
  save.type = 'button';
  foot.append(file, problem, cancel, save);
  card.append(head, body, foot);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));
  window.uiSound?.('open');

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 200);
  };
  const number = (input, fallback) => {
    const n = Number(input.value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const submit = async () => {
    const envVars = {};
    for (const line of env.value.split('\n').map(l => l.trim()).filter(Boolean)) {
      const eq = line.indexOf('=');
      if (eq < 1) {
        problem.textContent = `"${line}" is not NAME=value.`;
        problem.classList.remove('hidden');
        env.focus();
        return;
      }
      envVars[line.slice(0, eq).trim()] = line.slice(eq + 1);
    }
    const next = {
      defaultFolder: folder.value.trim(),
      defaultPermissionMode: mode.value,
      defaultModel: model.value,
      defaultEffort: effort.value,
      defaultFastMode: fast.checked,
      autoCompact: compact.value,
      hubAfterSend: hubAfterSend.checked,
      summarizeTitles: titles.checked,
      suggestFollowUps: followUps.checked,
      notifyWhenDone: notify.checked,
      sounds: sounds.checked,
      theme: theme.value,
      curvedScreen: curved.checked,
      stuckAfterSeconds: number(stuckAfter, 30),
      svnProject: svnProject.value.trim().replace(/^\/+|\/+$/g, ''),
      claudePath: claudePath.value.trim(),
      extraArgs: extraArgs.value.split('\n').map(l => l.trim()).filter(Boolean),
      env: envVars,
    };
    save.disabled = true;
    try {
      const saved = await window.deck.saveConfig(next);
      close();
      onSaved?.(saved);
    } catch (err) {
      problem.textContent = `Could not save: ${err?.message || err}`;
      problem.classList.remove('hidden');
      save.disabled = false;
    }
  };
  const onKey = e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopImmediatePropagation(); submit(); }
  };
  document.addEventListener('keydown', onKey, true);
  cancel.onclick = close;
  save.onclick = submit;
  overlay.onclick = e => { if (e.target === overlay) close(); };
}

window.openSettings = openSettings;
