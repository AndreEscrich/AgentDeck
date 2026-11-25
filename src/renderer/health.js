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
    // One scale for all their lines (the busiest day of any of them), so a
    // big crash stands out against the small ones.
    // 25 at least, so small ones still have a visible curve.
    this.dayMax = Math.max(25, ...[...(c.exceptions || []), ...(c.groups || [])].flatMap(x => x.trend?.devices || []));
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
      } else graph = t ? dayLine(t, days, this.dayMax) : el('div', 'health-days-none', x.id ? '' : 'no group id');
      const n = x.devices ?? x.players ?? 0;
      const num = el('div', 'health-item-n', n.toLocaleString());
      num.title = kind === 'errors' ? `${n} players, ${x.events.toLocaleString()} times` : `${n} devices, ${x.events.toLocaleString()} times`;
      row.append(main, graph, num);
      if (kind !== 'errors') {
        const item = { kind: kind === 'crashes' ? 'crash' : 'exception', ...x, rangeDays: days };
        row.append(this.agentButton(p, item));
        // A click: its window, with a bigger graph and where it happens.
        if (x.id) {
          row.classList.add('clickable');
          row.title = 'Click for its days in detail, where it happens and its top frame';
          row.onclick = e => { if (!e.target.closest('button')) this.openCrash(p, item, row); };
        }
      }
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

// One crash's devices per day, the last 30 days and today so far, as a
// smooth filled curve on the scale all of the tab's crashes share (max: the
// busiest day of any of them, 25 at least), so a big crash draws a tall
// curve and a small one stays near the floor. The picked range has a faint
// band behind it; today, still filling, is dashed. A day at 0.5% of the
// players or more has a red dot, a spiking day an amber one.
function dayLine(t, days, max = Math.max(25, ...t.devices)) {
  const w = 120, h = 30, n = t.devices.length;
  const x = i => (n === 1 ? w / 2 : i / (n - 1) * (w - 4) + 2);
  const y = v => h - 2 - Math.min(1, v / max) * (h - 4);
  const pts = t.devices.map((v, i) => [x(i), y(v)]);
  const full = t.today ? n - 1 : n;                        // the full days
  const from = Math.max(0, full - Math.max(1, days));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('class', 'health-days');
  const level = t.hot ? 'hot' : t.spiking ? 'spike' : 'now';
  let dots = '';
  t.devices.forEach((v, i) => {
    if (t.hot && t.shareAt === t.dates[i]) dots += `<circle class="hot" cx="${x(i).toFixed(2)}" cy="${y(v).toFixed(2)}" r="2.3"/>`;
    else if (t.spiking && i >= n - 2 && v === Math.max(t.devices[n - 1], t.devices[n - 2])) dots += `<circle class="spike" cx="${x(i).toFixed(2)}" cy="${y(v).toFixed(2)}" r="2.3"/>`;
  });
  const line = smoothPath(pts.slice(0, full));
  svg.innerHTML = `<rect class="band" x="${(x(from) - 1.5).toFixed(2)}" y="0" width="${(x(n - 1) - x(from) + 3).toFixed(2)}" height="${h}"/>`
    + `<path class="area ${level}" d="${smoothPath(pts)} L${x(n - 1).toFixed(2)},${h - 2} L${x(0).toFixed(2)},${h - 2} Z"/>`
    + `<line class="floor" x1="0" x2="${w}" y1="${h - 1.5}" y2="${h - 1.5}"/>`
    + `<path class="line ${level}" d="${line}"/>`
    + (t.today ? `<path class="line ${level} today" d="${smoothPath(pts.slice(full - 1))}"/>` : '') + dots;
  const wrap = el('div', 'health-days-wrap');
  wrap.append(svg);
  const fmt = (d, i) => (t.today && i === n - 1 ? 'today so far' : new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }));
  wrap.title = `Devices per day, the last 30 days and today (top of the scale: ${max}, the same for all):\n`
    + t.dates.slice(-7).map((d, i) => `${fmt(d, n - 7 + i)}: ${t.devices[n - 7 + i]}`).join('\n')
    + (t.share ? `\nPeak in this range: ${pctText(t.share)} of the day's players.` : '')
    + '\nClick for more.';
  return wrap;
}

// A smooth line through points ([x, y], x growing) that never overshoots
// them (monotone cubic: a peak stays a peak, the floor stays the floor).
function smoothPath(pts) {
  const n = pts.length;
  if (!n) return '';
  if (n === 1) return `M${pts[0][0]},${pts[0][1]}`;
  const dx = [], m = [], tan = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; m[i] = dx[i] ? (pts[i + 1][1] - pts[i][1]) / dx[i] : 0; }
  tan[0] = m[0]; tan[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) tan[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (!m[i]) { tan[i] = 0; tan[i + 1] = 0; continue; }
    const a = tan[i] / m[i], b = tan[i + 1] / m[i], q = a * a + b * b;
    if (q > 9) { const k = 3 / Math.sqrt(q); tan[i] = k * a * m[i]; tan[i + 1] = k * b * m[i]; }
  }
  let d = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], h3 = dx[i] / 3;
    d += ` C${(x0 + h3).toFixed(2)},${(y0 + tan[i] * h3).toFixed(2)} ${(x1 - h3).toFixed(2)},${(y1 - tan[i + 1] * h3).toFixed(2)} ${x1.toFixed(2)},${y1.toFixed(2)}`;
  }
  return d;
}

// ---------- one crash in detail ----------

// Its window: it grows out of its row, like a ticket. Its days as a big
// chart (devices and events, the last 30 days and today), where it happens
// (app versions, OS versions, device models, countries) and its top frame
// as Embrace has it, with its crash group id to find the whole stack in
// Embrace (its BigQuery export has only that first frame).
HealthView.prototype.openCrash = async function (p, x, row) {
  if (this.view.querySelector('.health-crash-shade')) return;
  const shade = el('div', 'review-shade top health-crash-shade');
  const box = el('div', 'review-confirm health-crash');
  const close = async () => {
    document.removeEventListener('keydown', onKey, true);
    window.uiSound?.('close');
    const r = await morphClose(box, row, { backdrop: shade });
    r?.done?.();
    shade.remove();
  };
  const onKey = e => { if (isBackKey(e)) { e.preventDefault(); e.stopImmediatePropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  shade.onmousedown = e => { if (e.target === shade) close(); };
  const head = el('div', 'health-crash-head');
  const title = el('div', 'health-crash-title');
  title.append(el('span', 'health-crash-kind', x.kind === 'exception' ? 'Unity exception' : x.type === 'Out of memory' ? 'Out of memory' : 'Native crash'), el('h3', null, x.what));
  const shut = el('button', 'icon tp-close', '✕');
  shut.type = 'button';
  shut.title = 'Close (Esc)';
  shut.onclick = close;
  head.append(title, this.agentButton(p, x), shut);
  const full = el('div', 'health-crash-full', x.method || x.frame || x.what);
  const body = el('div', 'health-crash-body');
  body.append(loading('Reading its days and where it happens from Tactile BI…'));
  box.append(head, full, body);
  shade.append(box);
  this.view.append(shade);
  window.uiSound?.('open');
  morphOpen(box, row, { backdrop: shade });

  const d = await window.deck.healthCrash(p.id, x.id).catch(e => ({ error: String(e?.message || e) }));
  if (!box.isConnected) return;
  if (d?.error) { body.replaceChildren(el('div', 'tp-error', d.error)); return; }
  body.replaceChildren();
  // The days: the last 30 and today, every day (0 on a day without it).
  const now = Date.now(), DAY = 864e5;
  const dates = [];
  for (let i = 30; i >= 0; i--) dates.push(new Date(now - i * DAY).toISOString().slice(0, 10));
  const by = new Map(d.days.map(r => [r.key, r]));
  const devices = dates.map(k => by.get(k)?.devices || 0), events = dates.map(k => by.get(k)?.events || 0);
  const tot = (list, k) => list.reduce((a, r) => a + r[k], 0);
  const stats = el('div', 'health-crash-stats');
  const stat = (n, label) => { const t = el('div', 'health-crash-stat'); t.append(el('b', null, n), el('span', null, label)); return t; };
  const peak = Math.max(...devices);
  const peakAt = dates[devices.indexOf(peak)];
  const players = d.dau[peakAt] || d.dau[dates[dates.length - 2]] || 0;
  stats.append(stat(tot(d.days, 'devices').toLocaleString(), 'devices, 30 days'), stat(tot(d.days, 'events').toLocaleString(), 'times'),
    stat(devices[devices.length - 1].toLocaleString(), 'devices today so far'),
    stat(peak.toLocaleString(), `on its worst day (${new Date(peakAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })})`),
    ...(players ? [stat(pctText(peak / players), 'of that day\'s players')] : []));
  body.append(stats, bigChart(d));
  // Where it happens.
  const grid = el('div', 'health-crash-grid');
  const part = (label, list) => {
    const card = el('div', 'health-crash-part');
    card.append(el('div', 'health-section-label', label));
    if (!list.length) { card.append(el('div', 'gallery-note', 'Nothing.')); return card; }
    const max = Math.max(1, ...list.map(r => r.devices));
    for (const r of list) {
      const line = el('div', 'health-crash-row');
      const bar = el('span', 'health-crash-bar');
      const fill = el('span'); fill.style.width = `${Math.max(3, r.devices / max * 100)}%`;
      bar.append(fill);
      line.append(el('span', 'health-crash-key', r.key), bar, el('span', 'health-crash-n', r.devices.toLocaleString()));
      line.title = `${r.key}: ${r.devices} devices, ${r.events} times`;
      card.append(line);
    }
    return card;
  };
  grid.append(part('App versions', d.version), part('OS versions', d.os), part('Devices', d.device), part('Countries', d.country));
  body.append(grid);
  // The top frame, and the way to the whole stack.
  const frame = el('div', 'health-crash-frame');
  frame.append(el('div', 'health-section-label', 'Stack trace'));
  const f = d.frame[0] || {};
  const lines = [['Method', f.method], ['File', f.file && f.file !== '<Unknown File>' ? f.file : ''], ['Line', f.line], ['Symbol', f.symbol], ['Module', f.module],
    ['Message', f.message], ['Type', f.type || f.errorType], ['Stack', f.stackTraceType]].filter(([, v]) => v);
  const code = el('div', 'health-crash-code');
  code.append(el('div', 'health-crash-code-top', `at ${f.method || f.symbol || f.module || x.what}${f.file && f.file !== '<Unknown File>' ? ` (${f.file}${f.line ? ':' + f.line : ''})` : ''}`));
  for (const [k, v] of lines) { const r2 = el('div', 'health-crash-kv'); r2.append(el('span', null, k), el('code', null, String(v))); code.append(r2); }
  frame.append(code);
  if (d.frame.length > 1) frame.append(el('div', 'health-card-note', `${d.frame.length} different top frames in this group; the one on the most devices.`));
  const gid = el('div', 'health-crash-id');
  const copy = el('button', 'tp-link', 'Copy');
  copy.type = 'button';
  copy.onclick = () => { window.deck.copyText?.(x.id) ?? navigator.clipboard.writeText(x.id); copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1200); };
  gid.append(el('span', null, 'Embrace crash group'), el('code', null, x.id), copy);
  frame.append(gid, el('div', 'health-card-note', 'Embrace\'s export to BigQuery keeps only this first frame of the stack, never the rest. The whole stack trace is in Embrace: search this crash group id there.'));
  body.append(frame);
};

// A crash's devices, big: a smooth filled curve per app version (the four
// on the most devices, the rest together), by hour over the last 48 hours
// (in your time) or by day over the last 30 days and today. Dashed lines
// across; hover an hour or a day for its numbers.
const VERSION_COLORS = ['#e8c547', '#3fb6a0', '#c061cb', '#5a8de0', '#9a8f80'];
function bigChart(d) {
  const wrap = el('div', 'health-big-wrap');
  const top = el('div', 'health-big-top');
  const modes = el('div', 'health-ranges');
  let mode = d.hourv.length ? 'hours' : 'days';
  const chart = el('div');
  const legend = el('div', 'health-big-legend');
  const draw = () => {
    for (const b of modes.children) b.classList.toggle('on', b.dataset.mode === mode);
    const hourly = mode === 'hours';
    // The slots: the last 48 hours (UTC keys, shown in your time), or the
    // last 30 days and today.
    const keys = [], now = Date.now();
    if (hourly) for (let i = 47; i >= 0; i--) keys.push(new Date(now - i * 3600e3).toISOString().slice(0, 13));
    else for (let i = 30; i >= 0; i--) keys.push(new Date(now - i * 864e5).toISOString().slice(0, 10));
    const rows = hourly ? d.hourv : d.dayv;
    const total = new Map();
    for (const r of rows) total.set(r.version, (total.get(r.version) || 0) + r.devices);
    const ranked = [...total].sort((a, b) => b[1] - a[1]).map(([v]) => v);
    const shown = ranked.slice(0, 4);
    const series = [...shown, ...(ranked.length > 4 ? ['Other versions'] : [])];
    const val = new Map(series.map(v => [v, keys.map(() => 0)]));
    const at = new Map(keys.map((k, i) => [k, i]));
    for (const r of rows) {
      const i = at.get(r.key);
      if (i === undefined) continue;
      const v = shown.includes(r.version) ? r.version : 'Other versions';
      val.get(v)[i] += r.devices;
    }
    const w = 860, h = 210, l = 34, b = 22, t = 10, r = 12, n = keys.length;
    const max = Math.max(5, ...series.flatMap(v => val.get(v)));
    const nice = max <= 10 ? Math.ceil(max / 2) * 2 : Math.ceil(max / 5) * 5;
    const X = i => l + i / (n - 1) * (w - l - r);
    const Y = v => t + (1 - v / nice) * (h - t - b);
    let g = '';
    for (let k = 0; k <= 5; k++) {
      const v = nice * k / 5;
      g += `<line class="grid${k ? '' : ' base'}" x1="${l}" x2="${w - r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="axis" x="${l - 6}" y="${(Y(v) + 3.5).toFixed(1)}" text-anchor="end">${Math.round(v * 10) / 10}</text>`;
    }
    const label = (k, i) => {
      const dt = hourly ? new Date(k + ':00:00Z') : new Date(k);
      if (hourly) {
        if (dt.getHours() === 0) return dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
        return dt.getHours() % 6 === 0 ? dt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
      }
      return i === n - 1 ? 'today' : i % 5 === 0 ? dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
    };
    keys.forEach((k, i) => { const s2 = label(k, i); if (s2) g += `<text class="axis" x="${X(i).toFixed(1)}" y="${h - 6}" text-anchor="middle">${s2}</text>`; });
    // The biggest behind, the smaller in front.
    [...series].reverse().forEach(v => {
      const c = VERSION_COLORS[series.indexOf(v)] || VERSION_COLORS[4];
      const pts = val.get(v).map((y, i) => [X(i), Y(y)]);
      const line = smoothPath(pts);
      g += `<path d="${line} L${X(n - 1).toFixed(1)},${Y(0).toFixed(1)} L${X(0).toFixed(1)},${Y(0).toFixed(1)} Z" fill="${c}" fill-opacity="0.22"/><path d="${line}" fill="none" stroke="${c}" stroke-width="1.6" stroke-linejoin="round"/>`;
    });
    // Hover: one strip per slot, its numbers.
    const slot = (w - l - r) / (n - 1);
    keys.forEach((k, i) => {
      const dt = hourly ? new Date(k + ':00:00Z') : new Date(k);
      const when = hourly ? `${dt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, ${dt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
        : i === n - 1 ? 'Today so far' : dt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
      const parts = series.map(v => [v, val.get(v)[i]]).filter(([, c]) => c);
      const sum = parts.reduce((a, [, c]) => a + c, 0);
      g += `<g class="slot"><rect x="${(X(i) - slot / 2).toFixed(1)}" y="${t}" width="${slot.toFixed(1)}" height="${h - t - b}"/><title>${when}: ${sum} devices${parts.length ? '\n' + parts.map(([v, c]) => `${v}: ${c}`).join('\n') : ''}</title></g>`;
    });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('class', 'health-big');
    svg.innerHTML = g;
    chart.replaceChildren(svg);
    legend.replaceChildren(...series.map((v, i) => {
      const k = el('span', 'k');
      k.style.setProperty('--c', VERSION_COLORS[i] || VERSION_COLORS[4]);
      k.textContent = `${v} · ${(v === 'Other versions' ? ranked.slice(4).reduce((a, x) => a + total.get(x), 0) : total.get(v)).toLocaleString()}`;
      return k;
    }), el('span', 'health-big-note', hourly ? 'Devices per hour, in your time' : 'Devices per day; today is still filling'));
    if (!series.length) legend.replaceChildren(el('span', 'health-big-note', hourly ? 'None in the last 48 hours.' : 'None in the last 30 days.'));
  };
  for (const [m, label] of [['hours', 'Last 48 hours'], ['days', '30 days']]) {
    const bt = el('button', 'health-range', label);
    bt.type = 'button';
    bt.dataset.mode = m;
    bt.onclick = () => { mode = m; draw(); };
    modes.append(bt);
  }
  top.append(el('span', 'health-section-label', 'Devices by app version'), modes);
  wrap.append(top, chart, legend);
  draw();
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
