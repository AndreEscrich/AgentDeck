// The Project health view (the heartbeat button on the Hub's left side):
// what in the live game needs your attention, read by the main process
// (src/health.js) from a Tactile BI project health dashboard, with a tab per
// project (Settings → Project health has the list).
//
// Top to bottom, so the most important comes first:
//  1. Needs attention: the warnings from crashes and player support
//     together, worst first. A click shows the part it belongs to.
//  2. The numbers at a glance: the four stability rates (crashes, ANRs,
//     out-of-memory kills, Unity exceptions, per 1,000 daily players, against
//     the 30 days before, with a line of the last 30 days) and this week's
//     support numbers.
//  3. The details, in two parts: Crashes & exceptions (the crash groups,
//     Unity exceptions and handled errors that hit the most devices, each
//     with "Find the cause", which starts an agent on it), and Player support
//     (Claude's written read of the messages, the topics against last week
//     and the latest conversations, with "Digest with an agent").

class HealthView {
  // onDigest(project): start the support digest agent. onInvestigate(project,
  // item): start an agent on one crash or exception. onSettings(): open Settings.
  constructor({ onDigest, onInvestigate, onSettings }) {
    this.onDigest = onDigest;
    this.onInvestigate = onInvestigate;
    this.onSettings = onSettings;
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
        el('p', null, 'Project health reads the crashes and the player support messages from Tactile BI with the app\'s own sign-in, so it costs no tokens. Connect opens Tactile BI\'s sign-in page in your browser; sign in there and come back.'));
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
    // The projects, a tab each (the first with warnings until you pick one).
    const list = s.projects || [];
    if (!list.length) {
      const c = el('div', 'tickets-connect');
      c.append(el('h3', null, 'No projects yet'), el('p', null, 'Add your game\'s player support dashboard from Tactile BI in Settings → Project health: paste its link, or pick it from the support dashboards Tactile BI has.'));
      const go = el('button', 'gallery-use', 'Open Settings');
      go.type = 'button';
      go.onclick = () => this.onSettings?.();
      c.append(go);
      box.append(c);
      this.view.replaceChildren(box);
      return;
    }
    let p = list.find(x => x.id === this.projectId);
    if (!p) { p = list.find(x => x.report?.warnings?.length) || list[0]; this.projectId = p.id; }
    if (list.length > 1) {
      const tabs = el('div', 'tickets-tabs health-tabs');
      for (const x of list) {
        const b = el('button', 'tickets-tab' + (x.id === p.id ? ' on' : ''));
        b.type = 'button';
        b.append(el('span', null, x.name));
        const n = x.report?.warnings?.length || 0;
        if (n) b.append(el('span', 'health-tab-count', String(n)));
        b.onclick = () => { this.projectId = x.id; this.topic = null; this.part = null; this.spot = null; this.render(); };
        tabs.append(b);
      }
      box.append(tabs);
    }
    const r = p.report;
    const head = el('div', 'health-head');
    head.append(el('h2', null, 'Project health'), el('span', 'health-sub', p.name));
    const when = el('span', 'health-when', r?.at ? `Read ${timeAgoText(r.at)}` : 'Reading…');
    const refresh = el('button', 'icon gallery-refresh', '↻');
    refresh.type = 'button';
    refresh.title = 'Read the dashboard again (runs its charts again)';
    refresh.onclick = async () => {
      refresh.disabled = true;
      when.textContent = 'Reading…';
      const out = await window.deck.healthCheck(true);
      if (out?.error) { when.textContent = out.error; refresh.disabled = false; return; }
      this.render(out);
    };
    const dash = el('a', 'gallery-action', 'Open dashboard');
    dash.href = p.dashboardUrl || 'https://bi.tactilews.com';
    dash.target = '_blank';
    head.append(when, refresh, dash);
    box.append(head);
    if (r?.error) box.append(el('div', 'tp-error', r.error));
    if (!r?.stats) {
      box.append(el('div', 'gallery-note', 'Reading the dashboard from Tactile BI…'));
      this.view.replaceChildren(box);
      if (!r) window.deck.healthCheck(false).then(out => this.render(out));
      return;
    }
    const c = r.crashes;
    // The part shown below: Crashes or Player support. Until you pick one,
    // the part of the first warning.
    if (!this.part || (this.part === 'crashes' && !c)) this.part = r.warnings.find(w => w.tab)?.tab === 'support' || !c ? 'support' : 'crashes';

    // 1. What needs your attention, crashes and support together, worst first.
    if (r.warnings.length) {
      const list = el('div', 'health-warnings');
      list.append(el('div', 'health-section-label', `Needs attention · ${r.warnings.length}`));
      // The worst five; the rest behind "Show more", so the numbers stay in view.
      const shownW = this.allWarnings ? r.warnings : r.warnings.slice(0, 5);
      for (const w of shownW) {
        const card = el('div', `health-warning ${w.level}`);
        card.append(el('span', 'health-warning-mark', w.level === 'high' ? '!' : '•'));
        const text = el('div', 'health-warning-text');
        text.append(el('div', 'health-warning-title', w.title), el('div', 'health-warning-sub', w.text));
        card.append(text, el('span', 'health-warning-tag ' + (w.tab || 'support'), w.tab === 'crashes' ? 'Crashes' : 'Support'));
        if (w.item) card.append(this.agentButton(p, w.item));
        card.classList.add('clickable');
        card.title = w.tab === 'crashes' ? 'Show the crashes' : w.topic ? `Show the ${w.topic} conversations` : 'Show the player support';
        card.onclick = e => {
          if (e.target.closest('button')) return;
          this.part = w.tab === 'crashes' ? 'crashes' : 'support';
          if (w.topic) this.topic = w.topic;
          if (w.item) this.spot = w.item.id || w.item.what;
          this.render();
          requestAnimationFrame(() => this.view.querySelector('.health-spot, .health-parts')?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
        };
        list.append(card);
      }
      if (r.warnings.length > 5) {
        const more = el('button', 'tp-link health-more', this.allWarnings ? 'Show fewer' : `Show ${r.warnings.length - 5} more`);
        more.type = 'button';
        more.onclick = () => { this.allWarnings = !this.allWarnings; this.render(); };
        list.append(more);
      }
      box.append(list);
    } else box.append(el('div', 'health-ok', '✓ Nothing unusual in crashes or player support right now.'));

    // 2. The numbers at a glance: stability and support side by side.
    const glance = el('div', 'health-glance');
    if (c?.rates?.length) {
      const g = el('div', 'health-glance-group');
      g.append(el('div', 'health-section-label', 'Stability · per 1,000 daily players, last 30 days'));
      const tiles = el('div', 'health-stats');
      const names = { Crash: 'Crashes', ANR: 'ANRs', 'Out of memory': 'Out of memory', 'Unity exception': 'Unity exceptions' };
      const tips = { Crash: 'The game closed by a native crash', ANR: 'Android: the app stopped answering (per 1,000 Android players)', 'Out of memory': 'The system killed the game for using too much memory (almost all iOS)', 'Unity exception': 'An unhandled C# exception: the game goes on, but the code that threw stopped' };
      for (const x of c.rates) {
        const ch = Math.round(x.change * 100);
        const t = el('div', 'health-stat' + (ch >= 10 ? ' worse' : ch <= -10 ? ' better' : ''));
        t.title = `${tips[x.type] || x.type}. ${x.events.toLocaleString()} in the last 30 days on ${x.devices.toLocaleString()} devices. The 30 days before: ${x.before} per 1,000 daily players.`;
        t.append(el('div', 'health-stat-n', x.per1k >= 10 ? String(Math.round(x.per1k)) : String(x.per1k)), el('div', 'health-stat-label', names[x.type] || x.type),
          el('div', 'health-stat-sub', `${ch > 0 ? '▲ +' : ch < 0 ? '▼ ' : ''}${ch}% vs before`));
        if (x.line.length > 2) t.append(sparkline(x.line));
        tiles.append(t);
      }
      g.append(tiles);
      glance.append(g);
    }
    const st = r.stats;
    const change = st.before ? Math.round((st.week - st.before) / st.before * 100) : null;
    const sg = el('div', 'health-glance-group');
    sg.append(el('div', 'health-section-label', 'Player support · this week'));
    const stiles = el('div', 'health-stats');
    const tile = (n, label, sub = '', cls = '') => { const t = el('div', 'health-stat ' + cls); t.append(el('div', 'health-stat-n', String(n)), el('div', 'health-stat-label', label), el('div', 'health-stat-sub', sub)); return t; };
    stiles.append(
      tile(st.week, 'messages', change === null ? '' : `${change > 0 ? '▲ +' : change < 0 ? '▼ ' : ''}${change}% vs before`, change !== null && change >= 50 ? 'worse' : ''),
      tile(st.conversations, 'players writing in'),
      tile(st.day, st.dateOnly ? 'today so far' : 'last 24 hours'),
      tile(st.week ? `${Math.round(st.unhappy / st.week * 100)}%` : '–', 'unhappy', `${st.unhappy} messages`, st.week >= 10 && st.unhappy / st.week >= 0.5 ? 'worse' : ''));
    sg.append(stiles);
    glance.append(sg);
    box.append(glance);

    // 3. The details: Crashes or Player support.
    const parts = el('div', 'tickets-tabs health-parts');
    const partBtn = (id, label, n) => {
      const b = el('button', 'tickets-tab' + (this.part === id ? ' on' : ''));
      b.type = 'button';
      b.append(el('span', null, label));
      if (n) b.append(el('span', 'health-tab-count', String(n)));
      b.onclick = () => { this.part = id; this.render(); };
      return b;
    };
    const count = tab => r.warnings.filter(w => (w.tab || 'support') === tab).length;
    if (c) parts.append(partBtn('crashes', 'Crashes & exceptions', count('crashes')));
    parts.append(partBtn('support', 'Player support', count('support')));
    box.append(parts);
    if (r.crashError) box.append(el('div', 'tp-error', `Crashes: ${r.crashError}`));
    if (this.part === 'crashes' && c) this.renderCrashes(box, p, c);
    else this.renderSupport(box, p, r);

    const foot = el('div', 'health-foot');
    const out = el('button', 'tp-link', `Signed in to Tactile BI${s.email ? ` as ${s.email}` : ''} · Sign out`);
    out.type = 'button';
    out.onclick = async () => this.render(await window.deck.healthDisconnect().then(() => window.deck.healthSummary()));
    foot.append(el('span', null, 'The app reads the dashboard every 30 minutes (free) and runs its charts again every few hours. Crash numbers leave out today, which is still filling.'), out);
    box.append(foot);
    this.view.replaceChildren(box);
  }

  // The crash part: the crash groups and Unity exceptions as short lists, the
  // ones that hit the most devices first, and the handled errors.
  renderCrashes(box, p, c) {
    const list = (title, items, note, kind) => {
      const card = el('div', 'health-card');
      card.append(el('h3', null, title), el('div', 'health-card-note', note));
      if (!items.length) { card.append(el('div', 'gallery-note', 'None in the last 30 days.')); return card; }
      const all = this.allOf === kind;
      const max = Math.max(1, ...items.map(x => x.devices || x.players || 0));
      for (const x of all ? items : items.slice(0, 8)) {
        const row = el('div', 'health-item' + ((x.id || x.what) === this.spot ? ' health-spot' : ''));
        const main = el('div', 'health-item-main');
        const name = el('div', 'health-item-name', x.what);
        name.title = x.method || x.frame || x.what;
        const meta = el('div', 'health-item-meta');
        if (x.isNew) meta.append(el('span', 'health-new', 'new'));
        if (x.platform || x.platforms) meta.append(el('span', 'health-chip', x.platform || x.platforms.replace(',', ' · ')));
        if (x.signal && x.signal !== x.what) meta.append(el('span', 'health-chip', x.signal));
        if (x.versions?.length) meta.append(el('span', null, `latest ${x.versions[0]}`));
        if (x.first) meta.append(el('span', null, `since ${new Date(x.first).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`));
        else if (x.last) meta.append(el('span', null, `last ${new Date(x.last).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`));
        main.append(name, meta);
        const n = x.devices ?? x.players ?? 0;
        const bar = el('div', 'health-item-bar');
        const fill = el('span'); fill.style.width = `${Math.max(2, n / max * 100)}%`;
        bar.append(fill);
        const num = el('div', 'health-item-n', n.toLocaleString());
        num.title = kind === 'errors' ? `${n} players, ${x.events.toLocaleString()} times` : `${n} devices, ${x.events.toLocaleString()} times`;
        row.append(main, bar, num);
        if (kind !== 'errors') row.append(this.agentButton(p, { kind: kind === 'crashes' ? 'crash' : 'exception', ...x }));
        card.append(row);
      }
      if (items.length > 8) {
        const more = el('button', 'tp-link', all ? 'Show fewer' : `Show all ${items.length}`);
        more.type = 'button';
        more.onclick = () => { this.allOf = all ? null : kind; this.render(); };
        card.append(more);
      }
      return card;
    };
    const cols = el('div', 'health-crash-cols');
    cols.append(
      list('Crashes', c.groups, 'Native crashes that closed the game, by crash group, most devices first. ANRs and out-of-memory kills have no stack, so they are only in the numbers above.', 'crashes'),
      list('Unity exceptions', c.exceptions, 'C# exceptions nobody caught, by the method that threw. The game goes on, but that code stopped.', 'exceptions'));
    box.append(cols, list('Handled errors', c.errors, 'Errors the game reports on purpose without crashing, most players first.', 'errors'));
  }

  // The support part: Claude's written read of the messages, the topics
  // against last week and the latest conversations.
  renderSupport(box, p, r) {
    const c = r.crashes;
    if (c?.analysis?.text) {
      const card = el('div', 'health-card health-analysis' + (this.readOpen ? ' open' : ''));
      const h = el('h3', null, 'What players say · Claude\'s read');
      const date = /\*\*Snapshot:\*\*\s*([^·\n]+)/.exec(c.analysis.text)?.[1]?.trim();
      card.append(h, el('div', 'health-card-note', date ? `Written for ${date}. A snapshot: read the numbers above for what changed since.` : 'A snapshot of the message log.'));
      // Closed: the headline and its first points. Open: all of it.
      const text = c.analysis.text.replace(/^# .*\n+/, '').replace(/^\*\*Snapshot:\*\*.*\n+/m, '');
      const short = text.split(/\n(?=## )/)[0];
      card.append(markdown(this.readOpen ? text : short));
      const more = el('button', 'tp-link', this.readOpen ? 'Show less' : 'Read all of it');
      more.type = 'button';
      more.onclick = () => { this.readOpen = !this.readOpen; this.render(); };
      card.append(more);
      box.append(card);
    }
    const actions = el('div', 'health-actions');
    const digest = el('button', 'gallery-use', 'Digest with an agent');
    digest.type = 'button';
    digest.title = 'Start an agent on these messages: it sorts them into real bugs and checks them against the game\'s code, with the project\'s UserSupportDigest skill when it has one (uses tokens)';
    digest.onclick = () => this.onDigest?.(p);
    actions.append(el('span', 'health-card-note', 'An agent can sort the latest messages into real bugs and check them against the code.'), digest);
    box.append(actions);
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
    const shown = r.recent.filter(cv => !this.topic || cv.messages.some(m => m.topic === this.topic));
    const ch = el('h3', null, `Latest conversations · 3 days${this.topic ? ` · ${this.topic}` : ''}`);
    if (this.topic) {
      const clear = el('button', 'tp-link', 'Show all');
      clear.type = 'button';
      clear.onclick = () => { this.topic = null; this.render(); };
      ch.append(' ', clear);
    }
    convs.append(ch);
    if (!shown.length) convs.append(el('div', 'gallery-note', 'No conversations.'));
    for (const cv of shown) {
      const open = this.open_.has(cv.id);
      const row = el('div', 'health-conv' + (cv.unhappy ? ' unhappy' : '') + (open ? ' open' : ''));
      const top = el('div', 'health-conv-top');
      const at = r.stats.dateOnly ? new Date(cv.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : timeAgoText(Date.parse(cv.at));
      top.append(el('span', 'health-dot'), el('span', 'health-chip', cv.topic), el('span', 'health-conv-time', at),
        el('span', 'health-conv-count', cv.messages.length > 1 ? `${cv.messages.length} messages` : ''));
      row.append(top);
      for (const m of open ? cv.messages : cv.messages.slice(-1)) row.append(el('div', 'health-msg', m.text));
      row.title = open ? 'Click to show only the latest message' : 'Click to show the whole conversation';
      row.onclick = () => { if (open) this.open_.delete(cv.id); else this.open_.add(cv.id); this.render(); };
      convs.append(row);
    }
    const cols = el('div', 'health-cols');
    cols.append(topics, convs);
    box.append(cols);
  }

  // A small button that starts an agent on one crash or exception: it finds
  // the cause in the game's code (onInvestigate in app.js).
  agentButton(p, item) {
    const b = el('button', 'gallery-action health-agent', 'Find the cause');
    b.type = 'button';
    b.title = 'Start an agent on this: it looks for the cause in the game\'s code and proposes a fix (uses tokens)';
    b.onclick = e => { e.stopPropagation(); this.onInvestigate?.(p, item); };
    return b;
  }
}

// A small line of a rate over the last 30 days.
function sparkline(values) {
  const w = 120, h = 26, max = Math.max(...values), min = Math.min(...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1) * w).toFixed(1)},${(h - 2 - (max === min ? 0.5 : (v - min) / (max - min)) * (h - 4)).toFixed(1)}`).join(' ');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'health-spark');
  svg.innerHTML = `<polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`;
  return svg;
}

function timeAgoText(ms) {
  const s = (Date.now() - ms) / 1000;
  if (!ms || s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

window.HealthView = HealthView;
