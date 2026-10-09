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
  const model = settingsSelect(sharedModels.map(m => [m.value, shortName(m)]), config.defaultModel || 'default');
  const effort = settingsSelect(EFFORT_OPTIONS, config.defaultEffort || '');
  const fast = settingsInput('checkbox', config.defaultFastMode);

  // The app
  const hubAfterSend = settingsInput('checkbox', config.hubAfterSend !== false);
  const titles = settingsInput('checkbox', config.summarizeTitles !== false);
  const notify = settingsInput('checkbox', config.notifyWhenDone !== false);
  const sounds = settingsInput('checkbox', config.sounds !== false);

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
      settingsField('Model', null, model),
      settingsField('Effort', null, effort),
      settingsField('Fast mode', 'Faster answers from the same model', fast)),
    section('The app',
      settingsField('Show the Hub after sending', 'Off: stay in the chat after you send a message', hubAfterSend),
      settingsField('Short titles', 'Name new agents with a summary of your message, written by Haiku', titles),
      settingsField('Notifications', 'When an agent finishes or needs you while the app is in the background', notify),
      settingsField('Sounds', 'For everything you and the agents do', sounds)),
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
      hubAfterSend: hubAfterSend.checked,
      summarizeTitles: titles.checked,
      notifyWhenDone: notify.checked,
      sounds: sounds.checked,
      stuckAfterSeconds: number(stuckAfter, 30),
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
