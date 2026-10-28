// The model menu: a button that shows the current choice ("Opus · High") and
// opens a menu with the models, their descriptions, the effort levels the
// selected model supports, and fast mode. The model list comes from the CLI,
// so it matches what the Claude desktop app offers for your account.
//
// With Codex on too (Settings → Providers), the menu lists Claude's models
// and Codex's, and a choice says which provider it is on ({ provider,
// model, effort, fastMode }). An agent with a session stays on its provider
// (setLocked): its conversation lives with that provider.

const FALLBACK_MODELS = [
  { value: 'default', displayName: 'Default (recommended)', description: 'Claude Code picks the model' },
  { value: 'opus', displayName: 'Opus', description: 'For everyday, complex tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Efficient for routine tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
  { value: 'haiku', displayName: 'Haiku', description: 'Fastest for quick answers' },
];

const EFFORT_NAMES = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' };
const PROVIDER_NAMES = { claude: 'Claude', codex: 'Codex' };

let sharedModels = FALLBACK_MODELS;
let codexModels = [];
// Which providers are on (Settings → Providers), see setProviders.
const providersOn = { claude: true, codex: false };
const pickers = [];

// Codex's menu works like Claude's: Auto, then the newest Sol, Terra and
// Luna, and apart from them Astra, for exceptions. A choice saves the family
// ("sol"), and the newest model of it runs (resolveModel in codex.js), like
// Claude's "opus". Auto picks Luna, Terra or Sol for each task, the way
// Claude's Auto picks Haiku, Sonnet or Opus (automodel.js, level 1 to 3).
const CODEX_FAMILIES = ['sol', 'terra', 'luna', 'astra'];
const CODEX_AUTO_FAMILIES = ['luna', 'terra', 'sol'];
const FAMILY_NAMES = { sol: 'Sol', terra: 'Terra', luna: 'Luna', astra: 'Astra' };
const CODEX_AUTO = {
  value: 'auto', displayName: 'Auto', description: 'Picks Sol, Terra or Luna for each task', provider: 'codex',
  supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
};
const latestCodex = family => codexModels.find(m => m.family === family && m.latest) || null;
// A family as a menu entry: its newest model, named by the family.
const familyEntry = family => {
  const m = latestCodex(family);
  return m ? { ...m, value: family, displayName: FAMILY_NAMES[family], description: `${m.displayName}: ${m.description}` } : null;
};
const codexModelByValue = value => {
  if (!value || value === 'auto' || value === 'default') return CODEX_AUTO;
  if (CODEX_FAMILIES.includes(value)) return familyEntry(value) || { value, displayName: FAMILY_NAMES[value], description: '', provider: 'codex' };
  return codexModels.find(m => m.value === value) || { value, displayName: value, description: '', provider: 'codex' };
};
// The menu's entries; while the list is not loaded (or names no families), Auto alone.
function codexMenuModels() {
  const families = CODEX_FAMILIES.map(familyEntry).filter(Boolean);
  return families.length ? families : codexModels;
}
// A saved Codex model as the menu's choice: nothing is Auto, and a model id
// that is its family's newest is the family.
function codexChoiceModel(value) {
  if (!value || value === 'default') return 'auto';
  const m = codexModelByValue(value);
  return m.latest && m.family ? m.family : value;
}
const codexAutoFamily = level => CODEX_AUTO_FAMILIES[Math.max(1, Math.min(3, level || 2)) - 1];
const providerOf = value => (value?.provider === 'codex' ? 'codex' : 'claude');
const bothOn = () => providersOn.claude && providersOn.codex;

// The menu: Auto, then the newest Opus, Sonnet and Haiku, and apart from
// them Fable, for exceptions (the older versions and "Default" stay out of
// it, but a choice saved before still shows its name on the button).
// Auto picks Opus, Sonnet or Haiku for each task (see automodel.js).
const AUTO = {
  value: 'auto', displayName: 'Auto', description: 'Picks Opus, Sonnet or Haiku for each task',
  supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'],
};
const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];
const modelByValue = value => (value === 'auto' ? AUTO : sharedModels.find(m => m.value === value)) || sharedModels[0];
function menuModels() {
  const best = new Map();   // family -> { model, version }
  for (const m of sharedModels) {
    const match = /^(fable|opus|sonnet|haiku)\s*([\d.]*)/i.exec(m.displayName || '') || /^(fable|opus|sonnet|haiku)$/i.exec(m.value || '');
    if (!match) continue;
    const family = match[1].toLowerCase();
    const version = (match[2] || '').split('.').map(Number);
    const newer = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); return false; };
    const known = best.get(family);
    // The alias (value "opus") wins a tie: it follows the newest version.
    if (!known || newer(version, known.version) || (!newer(known.version, version) && m.value === family)) best.set(family, { model: m, version });
  }
  const list = FAMILIES.map(f => best.get(f)?.model).filter(Boolean);
  return list.length ? [AUTO, ...list] : [AUTO, ...sharedModels];
}
const isFable = m => /^fable/i.test(m.displayName || '') || m.value === 'fable';

// A model's name without its version ("Opus", not "Opus 5.5") when it is the
// family's alias, which always runs the newest version; a pinned older
// version keeps its number ("Opus 4.8").
function shortName(model) {
  if (model.provider === 'codex') return model.displayName;
  const name = model.displayName.replace(/\s*\(recommended\)/i, '');
  return /^(fable|opus|sonnet|haiku)$/i.test(model.value || '') ? name.replace(/\s+[\d.]+$/, '') : name;
}

class ModelPicker {
  // onChange(value) runs after the person changes something in the menu.
  constructor(anchor, { onChange, openUp = true } = {}) {
    this.onChange = onChange;
    this.value = { model: 'default', effort: '', fastMode: false };

    this.root = el('div', 'model-picker');
    this.button = el('button', 'model-btn');
    this.button.type = 'button';
    this.menu = el('div', 'model-menu hidden' + (openUp ? ' up' : ' down'));
    this.root.append(this.button, this.menu);
    anchor.appendChild(this.root);

    this.button.onclick = e => {
      e.stopPropagation();
      this.menu.classList.contains('hidden') ? this.open() : this.close();
    };
    this.menu.onclick = e => e.stopPropagation();
    document.addEventListener('click', () => this.close());
    document.addEventListener('keydown', e => { if (e.key === 'Escape') this.close(); });

    pickers.push(this);
    this.renderButton();
  }

  get model() {
    return providerOf(this.value) === 'codex' ? codexModelByValue(this.value.model) : modelByValue(this.value.model);
  }

  // An agent with a session can only change models of its own provider.
  setLocked(provider) {
    this.locked = provider || null;
  }

  // With Auto: the model it picked for the agent on screen ("Sonnet"), shown
  // on the button as "Auto → Sonnet"; null when it has not picked yet.
  setResolved(name) {
    this.resolved = name || null;
    this.renderButton();
  }

  setValue(value) {
    this.value = { provider: 'claude', model: 'default', effort: '', fastMode: false, ...value };
    if (!this.value.model) this.value.model = this.value.provider === 'codex' ? 'auto' : 'default';
    this.renderButton();
    if (!this.menu.classList.contains('hidden')) this.renderMenu();
  }

  renderButton() {
    const parts = [shortName(this.model) + (this.value.model === 'auto' && this.resolved ? ` → ${this.resolved}` : '')];
    if (bothOn() || providerOf(this.value) === 'codex') parts.unshift(PROVIDER_NAMES[providerOf(this.value)]);
    if (this.value.effort) parts.push(EFFORT_NAMES[this.value.effort] || this.value.effort);
    this.button.textContent = parts.join(' · ') + (this.value.fastMode ? ' ⚡' : '') + ' ▾';
    this.button.title = this.model.description || '';
  }

  open() {
    for (const p of pickers) if (p !== this) p.close();
    this.renderMenu();
    this.menu.classList.remove('hidden');
    window.uiSound?.('tick');
  }

  close() {
    if (!this.menu.classList.contains('hidden')) window.uiSound?.('tickDown');
    this.menu.classList.add('hidden');
  }

  change(patch) {
    const next = { ...this.value, ...patch };
    // Keep only settings the newly selected model supports.
    const model = providerOf(next) === 'codex' ? codexModelByValue(next.model) : modelByValue(next.model);
    if (!(model.supportedEffortLevels || []).includes(next.effort)) next.effort = '';
    if (!model.supportsFastMode) next.fastMode = false;
    this.setValue(next);
    window.uiSound?.('select');
    this.onChange?.(this.value);
  }

  renderMenu() {
    const menu = this.menu;
    menu.innerHTML = '';

    const current = providerOf(this.value);
    const show = p => (this.locked ? this.locked === p : providersOn[p] || current === p);
    const both = show('claude') && show('codex');
    const row = (m, provider, extra = '') => {
      const selected = provider === current && m.value === this.value.model;
      const item = el('div', 'menu-item' + (selected ? ' selected' : '') + extra);
      const text = el('div', 'menu-text');
      text.append(el('div', 'menu-name', shortName(m)), el('div', 'menu-desc', m.description || ''));
      item.append(text, el('span', 'menu-check', selected ? '✓' : ''));
      item.onclick = () => this.change({ provider, model: m.value, ...(provider === 'codex' ? { fastMode: false } : {}) });
      menu.appendChild(item);
    };
    if (show('claude')) {
      menu.appendChild(el('div', 'menu-label', both ? 'Claude' : 'Model'));
      for (const m of menuModels()) {
        // Fable stands apart, below a line: the exception, not an everyday pick.
        if (isFable(m)) menu.appendChild(el('div', 'menu-sep-label', 'For exceptions'));
        row(m, 'claude', (isFable(m) ? ' exception' : '') + (m.value === 'auto' ? ' auto' : ''));
      }
    }
    if (show('codex')) {
      menu.appendChild(el('div', 'menu-label', both ? 'Codex' : 'Model'));
      row(CODEX_AUTO, 'codex', ' codex auto');
      for (const m of codexMenuModels()) {
        if (m.family === 'astra') menu.appendChild(el('div', 'menu-sep-label', 'For exceptions'));
        row(m, 'codex', ' codex' + (m.family === 'astra' ? ' exception' : ''));
      }
    }

    const model = this.model;
    if (model.supportsEffort && model.supportedEffortLevels?.length) {
      menu.appendChild(el('div', 'menu-label', 'Effort'));
      const seg = el('div', 'segmented');
      const levels = ['', ...model.supportedEffortLevels];
      for (const level of levels) {
        const b = el('button', level === this.value.effort ? 'on' : '', level ? EFFORT_NAMES[level] || level : 'Auto');
        b.type = 'button';
        b.title = level ? `Use ${EFFORT_NAMES[level] || level} effort` : this.value.model === 'auto' ? 'Auto picks the effort for each task, with the model' : "Use the model's default effort";
        b.onclick = () => this.change({ effort: level });
        seg.appendChild(b);
      }
      menu.appendChild(seg);
    }

    if (model.supportsFastMode) {
      const row = el('div', 'menu-toggle');
      const box = el('span', 'switch' + (this.value.fastMode ? ' on' : ''));
      row.onclick = () => this.change({ fastMode: !this.value.fastMode });
      const text = el('div', 'menu-text');
      text.append(el('div', 'menu-name', 'Fast mode'), el('div', 'menu-desc', 'Faster output from the same model, and uses your limits faster'));
      row.append(text, box);
      menu.appendChild(row);
    }
  }
}

// The permission mode menu. It decides which tool calls the agent may make
// without asking you first.
const PERMISSION_MODES = [
  { value: 'bypassPermissions', label: 'Bypass permissions', short: 'Bypass', description: 'Does everything without asking you' },
  { value: 'auto', label: 'Auto', short: 'Auto', description: 'A classifier approves safe actions and asks you about risky ones' },
  { value: 'acceptEdits', label: 'Accept edits', short: 'Accept edits', description: 'Edits files without asking, asks before commands' },
  { value: 'default', label: 'Ask permissions', short: 'Ask', description: 'Asks before edits and commands' },
  { value: 'plan', label: 'Plan', short: 'Plan', description: 'Read-only: explores and proposes a plan before changing anything' },
];

class ModePicker {
  constructor(anchor, { onChange, openUp = true } = {}) {
    this.onChange = onChange;
    this.value = 'bypassPermissions';
    this.root = el('div', 'model-picker');
    this.button = el('button', 'model-btn');
    this.button.type = 'button';
    this.menu = el('div', 'model-menu hidden' + (openUp ? ' up' : ' down'));
    this.root.append(this.button, this.menu);
    anchor.appendChild(this.root);

    this.button.onclick = e => {
      e.stopPropagation();
      this.menu.classList.contains('hidden') ? this.open() : this.close();
    };
    this.menu.onclick = e => e.stopPropagation();
    document.addEventListener('click', () => this.close());
    document.addEventListener('keydown', e => { if (e.key === 'Escape') this.close(); });
    pickers.push(this);
    this.renderButton();
  }

  get mode() {
    // "manual" is the newer CLI name for the mode we call "default".
    const value = this.value === 'manual' ? 'default' : this.value;
    return PERMISSION_MODES.find(m => m.value === value) || { value, label: value, short: value, description: '' };
  }

  setValue(value) {
    this.value = value || 'bypassPermissions';
    this.renderButton();
    if (!this.menu.classList.contains('hidden')) this.renderMenu();
  }

  renderButton() {
    this.button.textContent = this.mode.short + ' ▾';
    this.button.title = `Permissions: ${this.mode.label}. ${this.mode.description}`;
    this.button.classList.toggle('danger-text', this.mode.value === 'bypassPermissions');
  }

  open() {
    for (const p of pickers) if (p !== this) p.close();
    this.renderMenu();
    this.menu.classList.remove('hidden');
    window.uiSound?.('tick');
  }

  close() {
    if (!this.menu.classList.contains('hidden')) window.uiSound?.('tickDown');
    this.menu.classList.add('hidden');
  }

  renderMenu() {
    this.menu.innerHTML = '';
    this.menu.appendChild(el('div', 'menu-label', 'Permissions'));
    for (const m of PERMISSION_MODES) {
      const selected = m.value === this.mode.value;
      const row = el('div', 'menu-item' + (selected ? ' selected' : ''));
      const text = el('div', 'menu-text');
      text.append(el('div', 'menu-name', m.label), el('div', 'menu-desc', m.description));
      row.append(text, el('span', 'menu-check', selected ? '✓' : ''));
      row.onclick = () => {
        this.setValue(m.value);
        this.close();
        window.uiSound?.('select');
        this.onChange?.(m.value);
      };
      this.menu.appendChild(row);
    }
  }
}

// Loads the account's model lists once and updates every picker on screen.
async function loadModels() {
  const [models, codex] = await Promise.all([
    providersOn.claude ? window.deck.listModels().catch(() => null) : null,
    providersOn.codex ? window.deck.listCodexModels().catch(() => null) : null,
  ]);
  if (Array.isArray(models) && models.length) sharedModels = models;
  if (Array.isArray(codex) && codex.length) codexModels = codex;
  for (const p of pickers) p.setValue(p.value);
}

// Codex's model list, also while Codex is still off (Settings lists its
// models as soon as you turn it on). Resolves with the list, [] when Codex
// could not be asked.
async function loadCodexModels() {
  const codex = await window.deck.listCodexModels().catch(() => null);
  if (Array.isArray(codex) && codex.length) {
    codexModels = codex;
    for (const p of pickers) p.setValue(p.value);
  }
  return codexModels;
}

// Which providers are on, from the settings.
function setProviders(config) {
  const before = providersOn.codex;
  providersOn.claude = config.claudeEnabled !== false;
  providersOn.codex = !!config.codexEnabled;
  if (providersOn.codex && !before) loadModels();
  for (const p of pickers) if (p instanceof ModelPicker) p.renderButton();
}

window.ModelPicker = ModelPicker;
window.ModePicker = ModePicker;
window.loadModels = loadModels;
window.setProviders = setProviders;
window.loadCodexModels = loadCodexModels;
window.codexModelByValue = codexModelByValue;
window.codexMenuModels = codexMenuModels;
window.codexAutoFamily = codexAutoFamily;
window.codexChoiceModel = codexChoiceModel;
window.FAMILY_NAMES = FAMILY_NAMES;
window.PROVIDER_NAMES = PROVIDER_NAMES;
