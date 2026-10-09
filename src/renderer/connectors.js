// The Connectors panel in the Hub: the same connectors (MCP servers) the
// Claude desktop app has, plus the ones you add yourself, with their status.
// You can sign in to a connector, add one by URL, and remove one you added.
// Everything goes through Claude Code's `claude mcp` commands (src/connectors.js),
// so agents get exactly what this panel shows. Changes apply to agents
// started afterwards.

const CONNECTOR_STATUS = {
  connected: { label: 'Connected', order: 1 },
  auth: { label: 'Needs sign-in', order: 0 },
  pending: { label: 'Waiting for approval', order: 2 },
  failed: { label: 'Failed', order: 3 },
  unknown: { label: 'Unknown', order: 4 },
};

const SOURCE_LABEL = { 'claude.ai': 'claude.ai', user: 'Yours', local: 'This folder', project: 'Project' };

class ConnectorsPanel {
  // box: the element to draw into. folder(): the folder whose connectors to
  // list (local and project connectors depend on it).
  constructor(box, { folder }) {
    this.box = box;
    this.folder = folder;
    this.list = null;
    this.checking = false;
    this.query = '';
    this.signingIn = new Set();   // connector ids waiting for you in the browser
    this.message = null;          // { text, error }
    this.render();
  }

  // Called when the panel opens: show the last known list, then check again.
  async open() {
    if (!this.list) this.list = await window.deck.connectors.cached().catch(() => null);
    this.render();
    this.refresh();
  }

  async refresh() {
    if (this.checking) return;
    this.checking = true;
    this.render();
    try {
      this.list = await window.deck.connectors.list(this.folder());
    } catch {
      this.message = { text: 'Could not read the connectors from Claude Code.', error: true };
    }
    this.checking = false;
    // A sign-in is done once the connector shows as connected.
    for (const id of [...this.signingIn]) {
      if (this.list?.find(c => c.id === id)?.status === 'connected') this.signingIn.delete(id);
    }
    this.render();
  }

  // Opens the sign-in page in your browser. For claude.ai connectors you
  // approve on claude.ai; the panel then checks every 15 seconds for a few
  // minutes until the connector shows as connected.
  async connect(c) {
    this.signingIn.add(c.id);
    this.message = { text: `Finish signing in to ${c.name} in your browser.` };
    this.render();
    const result = await window.deck.connectors.login(c.id).catch(() => ({ ok: false }));
    if (!result.ok && c.source !== 'claude.ai') {
      this.signingIn.delete(c.id);
      this.message = { text: `Signing in to ${c.name} did not finish. ${result.message || ''}`.trim(), error: true };
      this.render();
      return;
    }
    let tries = 0;
    const poll = async () => {
      if (!this.signingIn.has(c.id) || tries++ > 12) {
        this.signingIn.delete(c.id);
        this.render();
        return;
      }
      await this.refresh();
      if (this.signingIn.has(c.id)) setTimeout(poll, 15000);
      else this.message = { text: `${c.name} is connected. Agents you start from now on can use it.` };
      this.render();
    };
    poll();
  }

  async remove(c) {
    if (!confirm(`Remove the connector "${c.name}"? Agents started afterwards no longer get it.`)) return;
    const result = await window.deck.connectors.remove({ id: c.id, source: c.source, cwd: this.folder() });
    this.message = result.ok ? { text: `Removed ${c.name}.` } : { text: result.message || 'Removing failed.', error: true };
    await this.refresh();
  }

  async add(form) {
    const spec = {
      name: form.name.value.trim(),
      url: form.url.value.trim(),
      transport: form.transport.value,
      header: form.header.value.trim() || undefined,
    };
    const result = await window.deck.connectors.add(spec);
    if (!result.ok) {
      this.message = { text: result.message || 'Adding failed.', error: true };
      this.render();
      return;
    }
    this.message = { text: `Added ${spec.name}. If it needs a sign-in, click Connect.` };
    this.adding = false;
    await this.refresh();
  }

  render() {
    const box = this.box;
    box.textContent = '';
    const head = el('div', 'conn-head');
    const refresh = el('button', 'icon conn-refresh', this.checking ? '…' : '↻');
    refresh.title = 'Check all connectors again';
    refresh.onclick = () => this.refresh();
    head.append(el('div', 'usage-title', 'Connectors'), refresh);
    box.appendChild(head);

    const list = this.list || [];
    const count = s => list.filter(c => c.status === s).length;
    const parts = [];
    if (count('connected')) parts.push(`${count('connected')} connected`);
    if (count('auth')) parts.push(`${count('auth')} need sign-in`);
    if (count('failed')) parts.push(`${count('failed')} failed`);
    box.appendChild(el('div', 'conn-summary', this.checking && !this.list ? 'Checking your connectors…' : parts.join(' · ') || 'No connectors yet'));

    if (this.message) box.appendChild(el('div', 'conn-message' + (this.message.error ? ' err' : ''), this.message.text));

    if (list.length > 8) {
      const search = document.createElement('input');
      search.type = 'search';
      search.placeholder = 'Search connectors…';
      search.className = 'conn-search';
      search.value = this.query;
      search.oninput = () => { this.query = search.value; this.renderRows(rows); };
      box.appendChild(search);
    }
    const rows = el('div', 'conn-list');
    box.appendChild(rows);
    this.renderRows(rows);

    // Adding: your own connector by URL, or one from Anthropic's directory on claude.ai.
    const actions = el('div', 'conn-actions');
    if (this.adding) {
      actions.appendChild(this.addForm());
    } else {
      const addBtn = el('button', 'primary', '+ Add connector');
      addBtn.onclick = () => { this.adding = true; this.render(); };
      const browse = el('button', null, 'Browse on claude.ai');
      browse.title = 'Add connectors from the directory to your claude.ai account (the same ones the Claude desktop app has)';
      browse.onclick = () => window.open('https://claude.ai/settings/connectors', '_blank');
      actions.append(addBtn, browse);
    }
    box.appendChild(actions);
    box.appendChild(el('div', 'conn-note', 'Changes apply to agents you start afterwards.'));
  }

  renderRows(rows) {
    rows.textContent = '';
    const q = this.query.trim().toLowerCase();
    const list = (this.list || [])
      .filter(c => !q || c.name.toLowerCase().includes(q) || c.target.toLowerCase().includes(q))
      .sort((a, b) => (CONNECTOR_STATUS[a.status]?.order ?? 9) - (CONNECTOR_STATUS[b.status]?.order ?? 9) || a.name.localeCompare(b.name));
    for (const c of list) {
      const row = el('div', `conn-row status-${c.status}`);
      row.title = `${c.target}${c.detail ? '\n' + c.detail : ''}`;
      const text = el('div', 'conn-text');
      const status = this.signingIn.has(c.id) ? 'Waiting for sign-in…' : CONNECTOR_STATUS[c.status]?.label || c.status;
      text.append(el('div', 'conn-name', c.name), el('div', 'conn-meta', `${SOURCE_LABEL[c.source] || c.source} · ${status}`));
      row.append(el('span', `conn-dot ${c.status}`), text);
      if (c.status === 'auth' || c.status === 'failed') {
        const connect = el('button', 'conn-btn', this.signingIn.has(c.id) ? 'Waiting…' : 'Connect');
        connect.disabled = this.signingIn.has(c.id);
        connect.onclick = () => this.connect(c);
        row.appendChild(connect);
      }
      if (c.source === 'user' || c.source === 'local') {
        const remove = el('button', 'conn-btn conn-remove', '✕');
        remove.title = `Remove ${c.name}`;
        remove.onclick = () => this.remove(c);
        row.appendChild(remove);
      }
      rows.appendChild(row);
    }
    if (!list.length && this.list) rows.appendChild(el('div', 'conn-meta', q ? 'No connector matches.' : 'No connectors.'));
  }

  addForm() {
    const form = document.createElement('form');
    form.className = 'conn-form';
    form.innerHTML = `
      <label>Name <input name="name" placeholder="my-docs" required></label>
      <label>URL <input name="url" placeholder="https://example.com/mcp" required></label>
      <label>Type <select name="transport"><option value="http">HTTP (most connectors)</option><option value="sse">SSE (older connectors)</option></select></label>
      <label>Header (optional) <input name="header" placeholder="Authorization: Bearer …"></label>
      <div class="conn-form-buttons"><button type="button" class="cancel">Cancel</button><button type="submit" class="primary">Add</button></div>`;
    form.onsubmit = e => { e.preventDefault(); this.add(form); };
    form.querySelector('.cancel').onclick = () => { this.adding = false; this.render(); };
    setTimeout(() => form.name.focus());
    return form;
  }
}

window.ConnectorsPanel = ConnectorsPanel;
