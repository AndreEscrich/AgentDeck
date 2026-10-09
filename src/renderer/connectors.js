// The Connectors dialog, like the one in the Claude desktop app: a search
// field and a list of every connector (MCP server) your agents get, with
// their status, Connect for the ones that need a sign-in, and buttons to add
// your own or browse the directory on claude.ai.
//
// Everything goes through Claude Code's `claude mcp` commands
// (src/connectors.js), so agents get exactly what this list shows. Changes
// apply to agents started afterwards.
//
// The dialog is built once; only the list and the status lines are drawn
// again, so the search field keeps what you type while a check runs.

const CONNECTOR_GROUPS = [
  { status: 'auth', title: 'Needs sign-in' },
  { status: 'connected', title: 'Connected' },
  { status: 'pending', title: 'Waiting for approval' },
  { status: 'failed', title: 'Failed to connect' },
  { status: 'unknown', title: 'Other' },
];

const SOURCE_LABEL = { 'claude.ai': 'claude.ai', user: 'Added by you', local: 'This folder only', project: 'Project' };

// A calm color per connector for its letter icon, always the same for a name.
const AVATAR_COLORS = ['#6c7fd8', '#4f9e8a', '#b07a3e', '#a0619a', '#5a8fb8', '#8c8a3e', '#b85c5c', '#6a9a4f'];
function avatarColor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function hostOf(target) {
  const m = String(target).match(/^https?:\/\/([^/\s]+)/i);
  return m ? m[1] : String(target).replace(/\s*\((HTTP|SSE|stdio)\)\s*$/i, '');
}

class ConnectorsDialog {
  // folder(): the folder whose connectors to list (connectors can also be
  // set up for one folder only).
  constructor({ folder }) {
    this.folder = folder;
    this.list = null;
    this.checking = false;
    this.signingIn = new Set();   // connector ids waiting for you in the browser
    this.build();
  }

  build() {
    this.overlay = el('div', 'conn-overlay hidden');
    const dialog = el('div', 'conn-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-label', 'Connectors');

    const head = el('div', 'conn-dialog-head');
    const close = el('button', 'icon conn-close', '✕');
    close.title = 'Close (Esc)';
    close.onclick = () => this.close();
    this.refreshBtn = el('button', 'icon conn-refresh', '↻');
    this.refreshBtn.title = 'Check all connectors again';
    this.refreshBtn.onclick = () => this.refresh();
    const titles = el('div', 'conn-titles');
    titles.append(el('div', 'conn-dialog-title', 'Connectors'),
      el('div', 'conn-dialog-sub', 'Tools and data your agents can use. Changes apply to agents you start afterwards.'));
    head.append(titles, this.refreshBtn, close);

    this.search = document.createElement('input');
    this.search.type = 'search';
    this.search.className = 'conn-search';
    this.search.placeholder = 'Search connectors';
    this.search.oninput = () => this.renderList();

    this.summary = el('div', 'conn-summary');
    this.message = el('div', 'conn-message hidden');
    this.listEl = el('div', 'conn-list');

    this.footer = el('div', 'conn-footer');
    const add = el('button', 'primary', '+ Add custom connector');
    add.onclick = () => this.showAddForm();
    const browse = el('button', null, 'Browse on claude.ai');
    browse.title = 'Add connectors from the directory to your claude.ai account (the same ones the Claude desktop app has)';
    browse.onclick = () => window.open('https://claude.ai/settings/connectors', '_blank');
    this.footer.append(add, browse);

    dialog.append(head, this.search, this.summary, this.message, this.listEl, this.footer);
    this.overlay.appendChild(dialog);
    // A click outside the dialog, or Esc, closes it.
    this.overlay.addEventListener('mousedown', e => { if (e.target === this.overlay) this.close(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && this.isOpen()) {
        e.stopImmediatePropagation();
        e.preventDefault();
        if (this.footer.querySelector('form')) this.hideAddForm();
        else this.close();
      }
    }, true);
    document.body.appendChild(this.overlay);
  }

  isOpen() {
    return !this.overlay.classList.contains('hidden');
  }

  // Shows the last known list right away, then checks again.
  async open() {
    this.overlay.classList.remove('hidden');
    this.search.value = '';
    setTimeout(() => this.search.focus());
    if (!this.list) this.list = await window.deck.connectors.cached().catch(() => null);
    this.renderList();
    this.refresh();
  }

  close() {
    this.overlay.classList.add('hidden');
    this.hideAddForm();
  }

  say(text, error = false) {
    this.message.textContent = text || '';
    this.message.classList.toggle('hidden', !text);
    this.message.classList.toggle('err', !!error);
  }

  async refresh() {
    if (this.checking) return;
    this.checking = true;
    this.renderList();
    try {
      this.list = await window.deck.connectors.list(this.folder());
    } catch {
      this.say('Could not read the connectors from Claude Code.', true);
    }
    this.checking = false;
    // A sign-in is done once the connector shows as connected.
    for (const id of [...this.signingIn]) {
      if (this.list?.find(c => c.id === id)?.status === 'connected') this.signingIn.delete(id);
    }
    this.renderList();
  }

  // Opens the sign-in page in your browser. For claude.ai connectors you
  // approve on claude.ai; the list then checks every 15 seconds for a few
  // minutes until the connector shows as connected.
  async connect(c) {
    this.signingIn.add(c.id);
    this.say(`Finish signing in to ${c.name} in your browser.`);
    this.renderList();
    const result = await window.deck.connectors.login(c.id).catch(() => ({ ok: false }));
    if (!result.ok && c.source !== 'claude.ai') {
      this.signingIn.delete(c.id);
      this.say(`Signing in to ${c.name} did not finish. ${result.message || ''}`.trim(), true);
      this.renderList();
      return;
    }
    let tries = 0;
    const poll = async () => {
      if (!this.signingIn.has(c.id) || tries++ > 12) {
        this.signingIn.delete(c.id);
        this.renderList();
        return;
      }
      await this.refresh();
      if (this.signingIn.has(c.id)) setTimeout(poll, 15000);
      else this.say(`${c.name} is connected. Agents you start from now on can use it.`);
    };
    poll();
  }

  async remove(c) {
    if (!confirm(`Remove the connector "${c.name}"? Agents started afterwards no longer get it.`)) return;
    const result = await window.deck.connectors.remove({ id: c.id, source: c.source, cwd: this.folder() });
    this.say(result.ok ? `Removed ${c.name}.` : result.message || 'Removing failed.', !result.ok);
    await this.refresh();
  }

  renderList() {
    const list = this.list || [];
    const count = s => list.filter(c => c.status === s).length;
    const parts = [];
    if (count('connected')) parts.push(`${count('connected')} connected`);
    if (count('auth')) parts.push(`${count('auth')} need sign-in`);
    if (count('failed')) parts.push(`${count('failed')} failed`);
    this.summary.textContent = this.checking ? `Checking your connectors…${parts.length ? '  ' + parts.join(' · ') : ''}` : parts.join(' · ') || (this.list ? 'No connectors yet' : '');
    this.refreshBtn.classList.toggle('spinning', this.checking);

    const q = this.search.value.trim().toLowerCase();
    const matches = list.filter(c => !q || c.name.toLowerCase().includes(q) || c.target.toLowerCase().includes(q));
    this.listEl.textContent = '';
    for (const group of CONNECTOR_GROUPS) {
      const items = matches.filter(c => c.status === group.status).sort((a, b) => a.name.localeCompare(b.name));
      if (!items.length) continue;
      this.listEl.appendChild(el('div', 'conn-group', `${group.title} · ${items.length}`));
      for (const c of items) this.listEl.appendChild(this.row(c));
    }
    if (!matches.length) {
      this.listEl.appendChild(el('div', 'conn-empty', this.list ? (q ? `No connector matches "${this.search.value.trim()}".` : 'No connectors.') : 'Checking your connectors…'));
    }
  }

  row(c) {
    const row = el('div', `conn-row status-${c.status}`);
    row.title = `${c.target}${c.detail ? '\n' + c.detail : ''}`;
    const avatar = el('span', 'conn-avatar', (c.name.match(/[A-Za-z0-9]/) || ['?'])[0].toUpperCase());
    avatar.style.background = avatarColor(c.name);
    const text = el('div', 'conn-text');
    const waiting = this.signingIn.has(c.id);
    const status = waiting ? 'Waiting for sign-in…'
      : c.status === 'connected' ? 'Connected'
      : c.status === 'auth' ? 'Needs sign-in'
      : c.status === 'failed' ? `Failed${c.detail ? ': ' + c.detail.slice(0, 80) : ''}`
      : c.status;
    text.append(el('div', 'conn-name', c.name), el('div', 'conn-meta', `${hostOf(c.target)} · ${SOURCE_LABEL[c.source] || c.source}`));
    const right = el('div', 'conn-right');
    if (c.status === 'connected') {
      right.appendChild(el('span', 'conn-state ok', '✓ Connected'));
    } else if (c.status === 'auth' || c.status === 'failed') {
      const connect = el('button', 'conn-btn', waiting ? 'Waiting…' : 'Connect');
      connect.disabled = waiting;
      connect.onclick = () => this.connect(c);
      right.appendChild(connect);
      if (c.status === 'failed') right.title = status;
    } else {
      right.appendChild(el('span', 'conn-state', status));
    }
    if (c.source === 'user' || c.source === 'local') {
      const remove = el('button', 'conn-btn conn-remove', '✕');
      remove.title = `Remove ${c.name}`;
      remove.onclick = () => this.remove(c);
      right.appendChild(remove);
    }
    row.append(avatar, text, right);
    return row;
  }

  showAddForm() {
    this.hideAddForm();
    const form = document.createElement('form');
    form.className = 'conn-form';
    form.innerHTML = `
      <div class="conn-form-title">Add a custom connector</div>
      <label>Name <input name="name" placeholder="my-docs" required></label>
      <label>URL <input name="url" placeholder="https://example.com/mcp" required></label>
      <div class="conn-form-row">
        <label>Type <select name="transport"><option value="http">HTTP (most connectors)</option><option value="sse">SSE (older connectors)</option></select></label>
        <label>Header (optional) <input name="header" placeholder="Authorization: Bearer …"></label>
      </div>
      <div class="conn-form-buttons"><button type="button" class="cancel">Cancel</button><button type="submit" class="primary">Add</button></div>`;
    form.onsubmit = async e => {
      e.preventDefault();
      const spec = { name: form.name.value.trim(), url: form.url.value.trim(), transport: form.transport.value, header: form.header.value.trim() || undefined };
      const result = await window.deck.connectors.add(spec);
      if (!result.ok) {
        this.say(result.message || 'Adding failed.', true);
        return;
      }
      this.say(`Added ${spec.name}. If it needs a sign-in, click Connect.`);
      this.hideAddForm();
      await this.refresh();
    };
    form.querySelector('.cancel').onclick = () => this.hideAddForm();
    this.footer.classList.add('hidden');
    this.footer.after(form);
    setTimeout(() => form.name.focus());
  }

  hideAddForm() {
    this.overlay.querySelector('.conn-form')?.remove();
    this.footer?.classList.remove('hidden');
  }
}

window.ConnectorsDialog = ConnectorsDialog;
