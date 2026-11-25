// The Project health view (the heartbeat button on the Hub's left side):
// what in the live game needs your attention, read by the main process
// (src/health.js) from a Tactile BI project health dashboard, with a tab per
// project (Settings → Project health has the list).
//
// Two tabs that never mix: Crashes & exceptions, and Player support. Each
// has, top to bottom, its own warnings (worst first), its numbers at a
// glance, then its details:
//  - Crashes & exceptions, in their order of importance: Unity exceptions
//    first, then handled errors, then native crashes. Each crash and
//    exception has its devices per day for the last 30 days as small bars
//    (the picked range brighter), its share of the day's players, and
//    "Find the cause", which starts an agent on it.
//  - Player support: Claude's written read of the messages, the topics
//    against the time before and the latest conversations.
//
// Red only means a real issue: a crash or exception that hits 0.5% of a
// day's players or more. Everything else worth a look is amber. While
// something is being read, a spinner says so.

const HEALTH_RANK = { 'Unity exception': 0, ANR: 1, 'Out of memory': 2, Crash: 3 };

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
    this.reading = false;     // the dashboard is being read (the refresh spins)
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
        const ws = x.report?.warnings || [];
        if (ws.length) b.append(el('span', 'health-tab-count' + (ws.some(w => w.level === 'high') ? ' high' : ''), String(ws.length)));
        b.onclick = () => { this.projectId = x.id; this.topic = null; this.spot = null; this.render(); };
        tabs.append(b);
      }
      box.append(tabs);
    }
    const r = p.report;
    const head = el('div', 'health-head');
    head.append(el('h2', null, 'Project health'), el('span', 'health-sub', p.name));
    // The range the numbers, lists, topics and conversations cover (24 hours
    // until you pick another; remembered). The warnings keep their own.
    if (this.range === undefined) { try { this.range = Number(localStorage.getItem('healthRange')) || 1; } catch { this.range = 1; } }
    if (![1, 3, 7].includes(this.range)) this.range = 1;
    const ranges = el('div', 'health-ranges');
    for (const [days, label] of [[1, '24h'], [3, '3 days'], [7, '7 days']]) {
      const b = el('button', 'health-range' + (this.range === days ? ' on' : ''), label);
      b.type = 'button';
      b.title = days === 1 ? 'The last 24 hours (for crashes: the last full day, because today is still filling)' : `The last ${days} days`;
      b.onclick = () => { this.range = days; try { localStorage.setItem('healthRange', String(days)); } catch { /* this run only */ } this.render(); };
      ranges.append(b);
    }
    head.append(ranges);
    const when = el('span', 'health-when');
    if (this.reading || !r?.at) when.append(spinner(), 'Reading…');
    else when.append(`Read ${timeAgoText(r.at)}`);
    const refresh = el('button', 'icon gallery-refresh' + (this.reading ? ' spinning' : ''), '↻');
    refresh.type = 'button';
    refresh.disabled = this.reading;
    refresh.title = 'Read the dashboard again (runs its charts again)';
    refresh.onclick = async () => {
      this.reading = true;
      this.lists?.clear();
      this.render();
      const out = await window.deck.healthCheck(true);
      this.reading = false;
      this.render(out?.error ? undefined : out);
    };
    const dash = el('a', 'gallery-action', 'Open dashboard');
    dash.href = p.dashboardUrl || 'https://bi.tactilews.com';
    dash.target = '_blank';
    head.append(when, refresh, dash);
    box.append(head);
    if (r?.error) box.append(el('div', 'tp-error', r.error));
    if (!r?.stats) {
      box.append(loading('Reading the dashboard from Tactile BI…'));
      this.view.replaceChildren(box);
      if (!r && !this.firstRead) { this.firstRead = true; window.deck.healthCheck(false).then(out => { this.firstRead = false; this.render(out); }); }
      return;
    }
    const c = r.crashes;
    // The two parts, as tabs that never mix: Crashes & exceptions first (they
    // matter most), then Player support. Remembered.
    if (this.part === undefined) { try { this.part = localStorage.getItem('healthPart') || 'crashes'; } catch { this.part = 'crashes'; } }
    if (this.part === 'crashes' && !c) this.part = 'support';
    const warnings = tab => (r.warnings || []).filter(w => (w.tab || 'support') === tab);
    const parts = el('div', 'tickets-tabs health-parts');
    const partBtn = (id, label) => {
      const b = el('button', 'tickets-tab' + (this.part === id ? ' on' : ''));
      b.type = 'button';
      b.append(el('span', null, label));
      const ws = warnings(id);
      if (ws.length) b.append(el('span', 'health-tab-count' + (ws.some(w => w.level === 'high') ? ' high' : ''), String(ws.length)));
      b.onclick = () => { this.part = id; try { localStorage.setItem('healthPart', id); } catch { /* this run only */ } this.render(); };
      return b;
    };
    if (c) parts.append(partBtn('crashes', 'Crashes & exceptions'));
    parts.append(partBtn('support', 'Player support'));
    box.append(parts);
    if (this.part === 'crashes' && c) {
      if (r.crashError) box.append(el('div', 'tp-error', `Crashes: ${r.crashError}`));
      this.renderWarnings(box, p, warnings('crashes'), 'crashes');
      this.renderCrashes(box, p, c);
    } else {
      this.renderWarnings(box, p, warnings('support'), 'support');
      this.renderSupport(box, p, r);
    }

    const foot = el('div', 'health-foot');
    const out = el('button', 'tp-link', `Signed in to Tactile BI${s.email ? ` as ${s.email}` : ''} · Sign out`);
    out.type = 'button';
    out.onclick = async () => this.render(await window.deck.healthDisconnect().then(() => window.deck.healthSummary()));
    foot.append(el('span', null, 'The app reads the dashboard every 30 minutes (free) and runs its charts again every few hours. Crash numbers leave out today, which is still filling.'), out);
    box.append(foot);
    const keep = this.view.querySelector('.health')?.scrollTop;
    this.view.replaceChildren(box);
    if (keep) box.scrollTop = keep;
  }

  // One part's warnings, worst first: the worst five, the rest behind "Show more".
  renderWarnings(box, p, ws, tab) {
    if (!ws.length) {
      box.append(el('div', 'health-ok', tab === 'crashes' ? '✓ Nothing unusual in crashes or exceptions right now.' : '✓ Nothing unusual in player support right now.'));
      return;
    }
    const list = el('div', 'health-warnings');
    list.append(el('div', 'health-section-label', `Needs attention · ${ws.length}`));
    const all = this.allWarnings === tab;
    for (const w of all ? ws : ws.slice(0, 5)) {
      const card = el('div', `health-warning ${w.level}`);
      card.append(el('span', 'health-warning-mark', w.level === 'high' ? '!' : '•'));
      const text = el('div', 'health-warning-text');
      text.append(el('div', 'health-warning-title', w.title), el('div', 'health-warning-sub', w.text));
      card.append(text);
      if (w.item) card.append(this.agentButton(p, w.item));
      if (w.item || w.topic) {
        card.classList.add('clickable');
        card.title = w.item ? 'Show it in the list below' : `Show the ${w.topic} conversations`;
        card.onclick = e => {
          if (e.target.closest('button')) return;
          if (w.topic) this.topic = w.topic;
          if (w.item) this.spot = w.item.id || w.item.what;
          this.render();
          requestAnimationFrame(() => this.view.querySelector('.health-spot, .health-cols')?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
        };
      }
      list.append(card);
    }
    if (ws.length > 5) {
      const more = el('button', 'tp-link health-more', all ? 'Show fewer' : `Show ${ws.length - 5} more`);
      more.type = 'button';
      more.onclick = () => { this.allWarnings = all ? null : tab; this.render(); };
      list.append(more);
    }
    box.append(list);
  }

  // The crash part: the stability numbers, then Unity exceptions, handled
  // errors and native crashes, in that order.
  renderCrashes(box, p, c) {
    const days = this.range || 1;
    // The numbers at a glance, Unity exceptions first.
    const rates = [...(c.byRange?.[days] || c.rates || [])].sort((a, b) => (HEALTH_RANK[a.type] ?? 9) - (HEALTH_RANK[b.type] ?? 9));
    if (rates.length) {
      const g = el('div', 'health-glance-group');
      g.append(el('div', 'health-section-label', `Stability · per 1,000 daily players · ${days === 1 ? 'last full day' : `last ${days} days`}`));
      const tiles = el('div', 'health-stats');
      const names = { Crash: 'Native crashes', ANR: 'ANRs', 'Out of memory': 'Out of memory', 'Unity exception': 'Unity exceptions' };
      const tips = { Crash: 'The game closed by a native crash', ANR: 'Android: the app stopped answering (per 1,000 Android players)', 'Out of memory': 'The system killed the game for using too much memory (almost all iOS)', 'Unity exception': 'An unhandled C# exception: the game goes on, but the code that threw stopped' };
      for (const x of rates) {
        const ch = Math.round(x.change * 100);
        const t = el('div', 'health-stat' + (ch >= 10 ? ' worse' : ch <= -10 ? ' better' : ''));
        const until = x.until ? ` up to ${new Date(x.until).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : '';
        t.title = `${tips[x.type] || x.type}. ${x.events.toLocaleString()} in the ${days === 1 ? 'last full day' : `last ${days} days`}${until}. The ${days === 1 ? 'day' : `${days} days`} before: ${x.before ?? '–'} per 1,000 daily players. The line: the last ${x.line.length} days.`;
        t.append(el('div', 'health-stat-n', x.per1k >= 10 ? String(Math.round(x.per1k)) : String(x.per1k)), el('div', 'health-stat-label', names[x.type] || x.type),
          el('div', 'health-stat-sub', `${ch > 0 ? '▲ +' : ch < 0 ? '▼ ' : ''}${ch}% vs before`));
        if (x.line.length > 2) t.append(sparkline(x.line));
        tiles.append(t);
      }
      g.append(tiles);
      box.append(g);
    }
    // The lists for the picked range, read from Tactile BI when first needed
    // (healthRange), with each one's days; a spinner until then.
    this.lists ||= new Map();
    const key = `${p.id}:${days}`;
    const got = this.lists.get(key);
    if (!got || (!got.loading && Date.now() - got.at > 30 * 60 * 1000)) {
      this.lists.set(key, { loading: true, at: Date.now(), data: got?.data || null });
      window.deck.healthRange(p.id, days).then(r => {
        this.lists.set(key, { at: Date.now(), data: r && !r.error ? r : got?.data || null, error: r?.error || '' });
        if (this.range === days && this.part === 'crashes' && !this.view.classList.contains('hidden')) this.render();
      });
    }
    const now = this.lists.get(key);
    const span = days === 1 ? '24 hours' : `${days} days`;
    if (now?.error) box.append(el('div', 'tp-error', `Crashes for the last ${span}: ${now.error}`));
    if (!now?.data) {
      // Failed: the error above, and a way to try again (no endless spinner).
      if (now?.error && !now.loading) {
        const again = el('button', 'tp-link', 'Try again');
        again.type = 'button';
        again.onclick = () => { this.lists.delete(key); this.render(); };
        box.append(again);
      } else box.append(loading(`Reading the crashes and exceptions of the last ${span} from Tactile BI…`));
      return;
    }
    if (now.loading) box.append(loading(`Reading the last ${span} again…`, true));
    if (now.data.trendError) box.append(el('div', 'health-card-note', `The days of each crash could not be read: ${now.data.trendError}`));
    c = { ...c, ...now.data };
    const since = new Date(Date.now() - days * 864e5).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    box.append(
      this.crashList(p, 'Unity exceptions', c.exceptions, 'C# exceptions nobody caught, by the method that threw. The game goes on, but that code stopped. Most devices first.', 'exceptions', days),
      this.crashList(p, 'Handled errors', c.errors, 'Errors the game reports on purpose without crashing, most players first.', 'errors', days),
      this.crashList(p, 'Native crashes', c.groups, `Native crashes that closed the game since ${since}, by crash group, most devices first. ANRs and out-of-memory kills have no stack, so they are only in the numbers above.`, 'crashes', days));
  }

  // A list of crashes, exceptions or handled errors: each with its days
  // (bars), its devices, its share of the day's players and, for crashes
  // and exceptions, "Find the cause".
  crashList(p, title, items, note, kind, days) {
    const card = el('div', 'health-card');
    card.append(el('h3', null, title), el('div', 'health-card-note', note));
    if (!items?.length) { card.append(el('div', 'gallery-note', 'None in this time.')); return card; }
    const all = this.allOf === kind;
    const max = Math.max(1, ...items.map(x => x.devices || x.players || 0));
    for (const x of all ? items : items.slice(0, 8)) {
      const t = x.trend;
      const row = el('div', 'health-item' + ((x.id || x.what) === this.spot ? ' health-spot' : '') + (t?.hot ? ' hot' : ''));
      const main = el('div', 'health-item-main');
      const name = el('div', 'health-item-name', x.what);
      name.title = x.method || x.frame || x.what;
      const meta = el('div', 'health-item-meta');
      if (t?.hot) meta.append(el('span', 'health-share hot', `${pctText(t.share)} of players`));
      if (t?.spiking) meta.append(el('span', 'health-spiking', 'spiking'));
      if (x.isNew) meta.append(el('span', 'health-new', 'new'));
      if (x.platform || x.platforms) meta.append(el('span', 'health-chip', x.platform || x.platforms.replace(',', ' · ')));
      if (x.signal && x.signal !== x.what) meta.append(el('span', 'health-chip', x.signal));
      if (x.versions?.length) meta.append(el('span', null, `latest ${x.versions[0]}`));
      if (x.first) meta.append(el('span', null, `since ${new Date(x.first).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`));
      else if (x.last) meta.append(el('span', null, `last ${new Date(x.last).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`));
      if (t && !t.hot && t.share > 0) meta.append(el('span', 'health-share', `${pctText(t.share)} of players`));
      main.append(name, meta);
      // Its days (crashes and exceptions); a bar for the handled errors.
      let graph;
      if (kind === 'errors') {
        graph = el('div', 'health-item-bar');
        const fill = el('span'); fill.style.width = `${Math.max(2, (x.players || 0) / max * 100)}%`;
        graph.append(fill);
      } else graph = t ? dayBars(t, days) : el('div', 'health-days-none', x.id ? '' : 'no group id');
      const n = x.devices ?? x.players ?? 0;
      const num = el('div', 'health-item-n', n.toLocaleString());
      num.title = kind === 'errors' ? `${n} players, ${x.events.toLocaleString()} times` : `${n} devices, ${x.events.toLocaleString()} times`;
      row.append(main, graph, num);
      if (kind !== 'errors') row.append(this.agentButton(p, { kind: kind === 'crashes' ? 'crash' : 'exception', ...x, rangeDays: days }));
      else row.append(el('span'));
      card.append(row);
    }
    if (items.length > 8) {
      const more = el('button', 'tp-link', all ? 'Show fewer' : `Show all ${items.length}`);
      more.type = 'button';
      more.onclick = () => { this.allOf = all ? null : kind; this.render(); };
      card.append(more);
    }
    return card;
  }

  // The support part: its numbers, Claude's written read of the messages,
  // the topics against the time before and the latest conversations.
  renderSupport(box, p, r) {
    const days = this.range || 1;
    const span = days === 1 ? '24 hours' : `${days} days`;
    const sr = r.byRange?.[days];
    const st = sr?.stats || { messages: r.stats.week, before: r.stats.before, players: r.stats.conversations, unhappy: r.stats.unhappy };
    const change = st.before ? Math.round((st.messages - st.before) / st.before * 100) : null;
    const sg = el('div', 'health-glance-group');
    sg.append(el('div', 'health-section-label', `Player support · last ${span}${r.stats.dateOnly && days === 1 ? ' (today and yesterday: the log has dates, not hours)' : ''}`));
    const stiles = el('div', 'health-stats');
    const tile = (n, label, sub = '', cls = '') => { const t = el('div', 'health-stat ' + cls); t.append(el('div', 'health-stat-n', String(n)), el('div', 'health-stat-label', label), el('div', 'health-stat-sub', sub)); return t; };
    const top = (sr?.topics || r.topics).find(x => x.week > 0);
    stiles.append(
      tile(st.messages, 'messages', change === null ? '' : `${change > 0 ? '▲ +' : change < 0 ? '▼ ' : ''}${change}% vs before`, change !== null && change >= 50 && st.messages >= 5 ? 'worse' : ''),
      tile(st.players, 'players writing in'),
      tile(st.messages ? `${Math.round(st.unhappy / st.messages * 100)}%` : '–', 'unhappy', `${st.unhappy} messages`, st.messages >= 10 && st.unhappy / st.messages >= 0.5 ? 'worse' : ''));
    if (top) { const t = tile(top.week, 'top topic', top.name); t.classList.add('topic'); stiles.append(t); }
    sg.append(stiles);
    box.append(sg);

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
    // Topics in the picked range against the same time before it.
    const sr2 = sr || { topics: r.topics, recent: r.recent };
    const topics = el('div', 'health-card');
    topics.append(el('h3', null, `Topics · last ${span} against the ${span} before`));
    if (!sr2.topics.some(t => t.week || t.before)) topics.append(el('div', 'gallery-note', 'No messages in this time.'));
    const max = Math.max(1, ...sr2.topics.map(t => Math.max(t.week, t.before)));
    for (const tp of sr2.topics.slice(0, 10)) {
      const row = el('button', 'health-topic' + (this.topic === tp.name ? ' on' : ''));
      row.type = 'button';
      const bars = el('span', 'health-bars');
      const nowBar = el('span', 'health-bar now'); nowBar.style.width = `${tp.week / max * 100}%`;
      const before = el('span', 'health-bar before'); before.style.width = `${tp.before / max * 100}%`;
      bars.append(nowBar, before);
      const diff = tp.week - tp.before;
      row.append(el('span', 'health-topic-name', tp.name), bars, el('span', 'health-topic-n', `${tp.week}`),
        el('span', 'health-topic-diff ' + (diff > 0 ? 'up' : diff < 0 ? 'down' : ''), diff > 0 ? `+${diff}` : diff < 0 ? `${diff}` : '='));
      row.title = `${tp.name}: ${tp.week} messages in the last ${span}, ${tp.before} the ${span} before. Click to show its conversations.`;
      row.onclick = () => { this.topic = this.topic === tp.name ? null : tp.name; this.render(); };
      topics.append(row);
    }
    // The latest conversations, filtered by the picked topic.
    const convs = el('div', 'health-card');
    const shown = sr2.recent.filter(cv => !this.topic || cv.messages.some(m => m.topic === this.topic));
    const ch = el('h3', null, `Conversations · last ${span}${this.topic ? ` · ${this.topic}` : ''}`);
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
      const top2 = el('div', 'health-conv-top');
      const at = r.stats.dateOnly ? new Date(cv.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : timeAgoText(Date.parse(cv.at));
      top2.append(el('span', 'health-dot'), el('span', 'health-chip', cv.topic), el('span', 'health-conv-time', at),
        el('span', 'health-conv-count', cv.messages.length > 1 ? `${cv.messages.length} messages` : ''));
      row.append(top2);
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

// "0.62%", "0.05%": a share of the day's players.
function pctText(x) {
  const v = x * 100;
  return `${v >= 1 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100}%`;
}

// A spinning circle, for whatever is being read.
function spinner() {
  return el('span', 'health-spinner');
}
// A line that says what is being read, with the spinner. small: under
// something already shown.
function loading(text, small = false) {
  const d = el('div', 'health-loading' + (small ? ' small' : ''));
  d.append(spinner(), el('span', null, text));
  return d;
}

// One crash's devices per day, the last 30 days, as small bars: the days of
// the picked range brighter, a spiking last day amber, a day at 0.5% of the
// players or more red. Its tooltip says each of the last days.
function dayBars(t, days) {
  const w = 120, h = 26, n = t.devices.length, max = Math.max(1, ...t.devices);
  const bw = w / n;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'health-days');
  let bars = '';
  t.devices.forEach((v, i) => {
    const bh = v ? Math.max(1.5, v / max * (h - 2)) : 0.8;
    const recent = i >= n - days;
    const cls = t.dates && t.shareAt === t.dates[i] && t.hot ? 'hot' : recent && i === n - 1 && t.spiking ? 'spike' : recent ? 'now' : 'old';
    bars += `<rect class="${cls}" x="${(i * bw + 0.4).toFixed(2)}" y="${(h - bh).toFixed(2)}" width="${Math.max(0.6, bw - 0.8).toFixed(2)}" height="${bh.toFixed(2)}" rx="0.6"/>`;
  });
  svg.innerHTML = bars;
  const wrap = el('div', 'health-days-wrap');
  wrap.append(svg);
  const fmt = d => new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  wrap.title = `Devices per day, the last ${n} days (${fmt(t.dates[0])} – ${fmt(t.dates[n - 1])}):\n`
    + t.dates.slice(-7).map((d, i) => `${fmt(d)}: ${t.devices[n - 7 + i]}`).join('\n')
    + (t.share ? `\nPeak in this range: ${pctText(t.share)} of the day's players.` : '');
  return wrap;
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
