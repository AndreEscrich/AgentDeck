// The model menu: a button that shows the current choice ("Opus · High") and
// opens a menu with the models, their descriptions, the effort levels the
// selected model supports, and fast mode. The model list comes from the CLI,
// so it matches what the Claude desktop app offers for your account.

const FALLBACK_MODELS = [
  { value: 'default', displayName: 'Default (recommended)', description: 'Claude Code picks the model' },
  { value: 'opus', displayName: 'Opus', description: 'For everyday, complex tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Efficient for routine tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
  { value: 'haiku', displayName: 'Haiku', description: 'Fastest for quick answers' },
];

const EFFORT_NAMES = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

let sharedModels = FALLBACK_MODELS;
const pickers = [];

function shortName(model) {
  return model.displayName.replace(/\s*\(recommended\)/i, '');
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
    return sharedModels.find(m => m.value === this.value.model) || sharedModels[0];
  }

  setValue(value) {
    this.value = { model: 'default', effort: '', fastMode: false, ...value };
    if (!this.value.model) this.value.model = 'default';
    this.renderButton();
    if (!this.menu.classList.contains('hidden')) this.renderMenu();
  }

  renderButton() {
    const parts = [shortName(this.model)];
    if (this.value.effort) parts.push(EFFORT_NAMES[this.value.effort] || this.value.effort);
    this.button.textContent = parts.join(' · ') + (this.value.fastMode ? ' ⚡' : '') + ' ▾';
    this.button.title = this.model.description || '';
  }

  open() {
    for (const p of pickers) if (p !== this) p.close();
    this.renderMenu();
    this.menu.classList.remove('hidden');
  }

  close() {
    this.menu.classList.add('hidden');
  }

  change(patch) {
    const next = { ...this.value, ...patch };
    // Keep only settings the newly selected model supports.
    const model = sharedModels.find(m => m.value === next.model) || sharedModels[0];
    if (!(model.supportedEffortLevels || []).includes(next.effort)) next.effort = '';
    if (!model.supportsFastMode) next.fastMode = false;
    this.setValue(next);
    this.onChange?.(this.value);
  }

  renderMenu() {
    const menu = this.menu;
    menu.innerHTML = '';

    menu.appendChild(el('div', 'menu-label', 'Model'));
    for (const m of sharedModels) {
      const row = el('div', 'menu-item' + (m.value === this.value.model ? ' selected' : ''));
      const text = el('div', 'menu-text');
      text.append(el('div', 'menu-name', m.displayName), el('div', 'menu-desc', m.description || ''));
      row.append(text, el('span', 'menu-check', m.value === this.value.model ? '✓' : ''));
      row.onclick = () => this.change({ model: m.value });
      menu.appendChild(row);
    }

    const model = this.model;
    if (model.supportsEffort && model.supportedEffortLevels?.length) {
      menu.appendChild(el('div', 'menu-label', 'Effort'));
      const seg = el('div', 'segmented');
      const levels = ['', ...model.supportedEffortLevels];
      for (const level of levels) {
        const b = el('button', level === this.value.effort ? 'on' : '', level ? EFFORT_NAMES[level] || level : 'Auto');
        b.type = 'button';
        b.title = level ? `Use ${EFFORT_NAMES[level] || level} effort` : "Use the model's default effort";
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

// Loads the account's model list once and updates every picker on screen.
async function loadModels() {
  const models = await window.deck.listModels();
  if (Array.isArray(models) && models.length) {
    sharedModels = models;
    for (const p of pickers) p.setValue(p.value);
  }
}

window.ModelPicker = ModelPicker;
window.loadModels = loadModels;
