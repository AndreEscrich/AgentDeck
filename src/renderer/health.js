// The Project health view (the heartbeat button on the Hub's left side):
// what in the live game needs your attention, read by the main process
// (src/health.js). The first section is player support: the warnings at the
// top, this week's numbers, the topics against last week, and the latest
// conversations. "Digest with an agent" starts an agent in the game project
// with its UserSupportDigest skill, which sorts the messages into real bugs
// and checks them against the code.

class HealthView {
  // onDigest(): start the digest agent.
  constructor({ onDigest }) {
    this.onDigest = onDigest;
    this.view = el('div', 'view health-view hidden');
    $('views').appendChild(this.view);
    this.summary = null;
    this.open_ = new Set();   // conversations shown in full
  }

  open() {
    window.deck.healthSummary().then(s => { this.render(s); window.deck.healthSeen().then(r => this.onSeen?.(r)); });
  }

  update(summary) {
    this.summary = summary;
    if (!this.view.classList.contains('hidden')) this.render(summary);
  }

  render(s = this.summary) {
    this.summary = s;
    const box = el('div', 'health');
    if (!s?.connected) {
      const c = el('div', 'tickets-connect');
      c.append(el('h3', null, 'Connect Agent Hub to Tactile BI'),
        el('p', null, 'Project health reads the player support messages from Tactile BI with the app\'s own sign-in, so it costs no tokens. Connect opens Tactile BI\'s sign-in page in your browser; sign in there and come back.'));
      const go = el('button', 'gallery-use', 'Connect');
      go.type = 'button';
      go.onclick = async () => {
        go.disabled = true;
        go.textContent = 'Waiting for the sign-in in your browser…';
        const r = await window.deck.healthConnect();
        if (r?.error) { go.disabled = false; go.textContent = 'Connect'; c.append(el('p', 'tickets-error', r.error)); return; }
        this.render(await window.deck.healthSummary());
      };
      c.append(go);
      box.append(c);
      this.view.replaceChildren(box);
      return;
    }
    const r = s.report;
    const head = el('div', 'health-head');
    head.append(el('h2', null, 'Player support'), el('span', 'health-sub', r?.title || ''));
    const when = el('span', 'health-when', r?.at ? `Read ${timeAgoText(r.at)}` : 'Reading…');
    const refresh = el('button', 'icon gallery-refresh', '↻');
    refresh.type = 'button';
    refresh.title = 'Read the messages again (runs the BI chart again)';
    refresh.onclick = async () => {
      refresh.disabled = true;
      when.textContent = 'Reading…';
      const out = await window.deck.healthCheck(true);
      this.render(out?.error ? { ...this.summary, report: { ...(this.summary?.report || {}), error: out.error } } : out);
    };
    const dash = el('a', 'gallery-action', 'Open dashboard');
    dash.href = r?.dashboardUrl || 'https://bi.tactilews.com';
    dash.target = '_blank';
    const digest = el('button', 'gallery-use', 'Digest with an agent');
    digest.type = 'button';
    digest.title = 'Start an agent in the game project with its UserSupportDigest skill: it sorts the messages into real bugs and checks them against the code (uses tokens)';
    digest.onclick = () => this.onDigest?.();
    head.append(when, refresh, dash, digest);
    box.append(head);
    if (r?.error) box.append(el('div', 'tp-error', r.error));
    if (!r?.stats) {
      box.append(el('div', 'gallery-note', 'Reading the support messages from Tactile BI…'));
      this.view.replaceChildren(box);
      if (!r) window.deck.healthCheck(false).then(out => this.render(out));
      return;
    }
    // What needs your attention.
    if (r.warnings.length) {
      const list = el('div', 'health-warnings');
      for (const w of r.warnings) {
        const card = el('div', `health-warning ${w.level}`);
        card.append(el('span', 'health-warning-mark', w.level === 'high' ? '!' : '•'));
        const text = el('div', 'health-warning-text');
        text.append(el('div', 'health-warning-title', w.title), el('div', 'health-warning-sub', w.text));
        card.append(text);
        if (w.topic) {
          card.classList.add('clickable');
          card.title = `Show the ${w.topic} conversations`;
          card.onclick = () => { this.topic = this.topic === w.topic ? null : w.topic; this.render(); };
        }
        list.append(card);
      }
      box.append(list);
    } else box.append(el('div', 'health-ok', '✓ Nothing unusual in player support right now.'));
    // This week's numbers.
    const st = r.stats;
    const change = st.before ? Math.round((st.week - st.before) / st.before * 100) : null;
    const tiles = el('div', 'health-stats');
    const tile = (n, label, sub = '', cls = '') => { const t = el('div', 'health-stat ' + cls); t.append(el('div', 'health-stat-n', String(n)), el('div', 'health-stat-label', label), el('div', 'health-stat-sub', sub)); return t; };
    tiles.append(
      tile(st.day, 'last 24 hours'),
      tile(st.week, 'this week', change === null ? '' : `${change >= 0 ? '+' : ''}${change}% vs last week`, change !== null && change >= 50 ? 'up' : ''),
      tile(st.conversations, 'players this week'),
      tile(st.week ? `${Math.round(st.unhappy / st.week * 100)}%` : '–', 'unhappy', `${st.unhappy} messages`));
    box.append(tiles);
    // Topics, this week against last week.
    const topics = el('div', 'health-card');
    topics.append(el('h3', null, 'Topics · this week against last week'));
    const max = Math.max(1, ...r.topics.map(t => Math.max(t.week, t.before)));
    for (const tp of r.topics.slice(0, 10)) {
      const row = el('button', 'health-topic' + (this.topic === tp.name ? ' on' : ''));
      row.type = 'button';
      const bars = el('span', 'health-bars');
      const now = el('span', 'health-bar now'); now.style.width = `${tp.week / max * 100}%`;
      const before = el('span', 'health-bar before'); before.style.width = `${tp.before / max * 100}%`;
      bars.append(now, before);
      const diff = tp.week - tp.before;
      row.append(el('span', 'health-topic-name', tp.name), bars, el('span', 'health-topic-n', `${tp.week}`),
        el('span', 'health-topic-diff ' + (diff > 0 ? 'up' : diff < 0 ? 'down' : ''), diff > 0 ? `+${diff}` : diff < 0 ? `${diff}` : '='));
      row.title = `${tp.name}: ${tp.week} messages this week, ${tp.before} last week. Click to show its conversations.`;
      row.onclick = () => { this.topic = this.topic === tp.name ? null : tp.name; this.render(); };
      topics.append(row);
    }
    // The latest conversations (3 days), filtered by the picked topic.
    const convs = el('div', 'health-card');
    const shown = r.recent.filter(c => !this.topic || c.messages.some(m => m.topic === this.topic));
    const ch = el('h3', null, `Latest conversations · 3 days${this.topic ? ` · ${this.topic}` : ''}`);
    if (this.topic) {
      const clear = el('button', 'tp-link', 'Show all');
      clear.type = 'button';
      clear.onclick = () => { this.topic = null; this.render(); };
      ch.append(' ', clear);
    }
    convs.append(ch);
    if (!shown.length) convs.append(el('div', 'gallery-note', 'No conversations.'));
    for (const c of shown) {
      const open = this.open_.has(c.id);
      const row = el('div', 'health-conv' + (c.unhappy ? ' unhappy' : '') + (open ? ' open' : ''));
      const top = el('div', 'health-conv-top');
      top.append(el('span', 'health-dot'), el('span', 'health-chip', c.topic), el('span', 'health-conv-time', timeAgoText(Date.parse(c.at))),
        el('span', 'health-conv-count', c.messages.length > 1 ? `${c.messages.length} messages` : ''));
      row.append(top);
      for (const m of open ? c.messages : c.messages.slice(-1)) row.append(el('div', 'health-msg', m.text));
      row.title = open ? 'Click to show only the latest message' : 'Click to show the whole conversation';
      row.onclick = () => { if (open) this.open_.delete(c.id); else this.open_.add(c.id); this.render(); };
      convs.append(row);
    }
    const cols = el('div', 'health-cols');
    cols.append(topics, convs);
    box.append(cols);
    const foot = el('div', 'health-foot');
    const out = el('button', 'tp-link', `Signed in to Tactile BI${s.email ? ` as ${s.email}` : ''} · Sign out`);
    out.type = 'button';
    out.onclick = async () => this.render(await window.deck.healthDisconnect().then(() => window.deck.healthSummary()));
    foot.append(el('span', null, `${st.total} messages in the last 30 days. The app reads them every 30 minutes (free) and runs the chart again every 3 hours.`), out);
    box.append(foot);
    this.view.replaceChildren(box);
  }
}

function timeAgoText(ms) {
  const s = (Date.now() - ms) / 1000;
  if (!ms || s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

window.HealthView = HealthView;
