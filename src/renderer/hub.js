// The Hub: one tile per running agent. Each tile has a glass tank whose
// liquid color shows the agent's state:
//   starting: blue, the tank fills up
//   working: amber, waves and rising bubbles; the level climbs with each step
//   waiting: orange and agitated: choppy liquid, the tile wiggles and glows,
//            a "?" (question) or "!" (approval) badge sends out a signal ring
//   idle: green, a burst and a check mark when the agent has just finished
//   error: red, the tile shakes once
//
// Tiles are kept between updates and only their fields change, so running
// animations do not restart every time an event comes in.

// The name an agent shows: the one you gave it (Rename… in its tile's menu),
// else the summary of its latest message, else its title. Names you give
// are kept by session (localStorage agentNames), so they stay after a
// restart and when the agent continues in a new session (see setAgentName
// in app.js).
function agentNames() {
  try { return JSON.parse(localStorage.getItem('agentNames') || '{}'); } catch { return {}; }
}
function customNameOf(x) {
  return x?.customName || (x?.sessionId && agentNames()[x.sessionId]) || null;
}
function agentName(x) {
  return customNameOf(x) || x?.latestTitle || x?.title || '';
}

const HUB_STATUS_TEXT = {
  starting: 'Booting up…',
  working: 'Working',
  waiting: 'Needs you',
  stuck: 'Stuck',
  background: 'Running in the background',
  idle: 'Completed',
  error: 'Error',
  exited: 'Stopped',
};

// TactileSVN's button: a folder with a branch line.
const TSVN_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 4.5v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3h-4a1 1 0 0 0-1 1.5z"/><circle cx="6" cy="9.2" r="1.1"/><circle cx="10.5" cy="9.2" r="1.1"/><path d="M7.1 9.2h2.3"/></svg>';

const BUBBLE_COUNT = 7;
const BURST_COUNT = 14;

function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

class Hub {
  // onOpen(agentId) opens an agent's chat and returns its chat element.
  // New agents start only from the message box under the Hub.
  // onRemove(agentId) removes a tile's agent; onContext(agentId) shows its
  // right-click menu.
  constructor(container, { onOpen, onRemove, onInterrupt, onRestart, onRemoveGroup, onContext, onLanded, onReplay, onTab, onReorder, onReorderGroups, onDragSound, onPickGroup }) {
    // Clicking a Group panel (not a tile) points the message box at that Group.
    this.onPickGroup = onPickGroup;
    this.onOpenUnity = null;   // set by the app: open or focus Unity for a folder
    this.selectedKey = null;
    this.onOpen = onOpen;
    this.onInterrupt = onInterrupt;
    this.onRestart = onRestart;
    this.onReorder = onReorder;
    this.onReorderGroups = onReorderGroups;
    this.onDragSound = onDragSound;
    this.onReplay = onReplay;
    this.onLanded = onLanded;
    this.onRemoveGroup = onRemoveGroup;
    this.onRemove = onRemove;
    this.onContext = onContext;
    this.sections = new Map();       // group id ('' for no group) + repository -> { el, name, repo, count, grid }
    this.repos = new Map();          // repository -> { el, name, count, unity, body }: holds that repository's category panels
    this.tiles = new Map();          // agent id -> { el, parts, status }
    // Tiles you Ctrl+clicked: your next message in the Hub goes to each of
    // them (see broadcast in app.js).
    this.selected = new Set();
    this.arrivals = new Map();       // agent id -> where its message box was, for the morph animation

    this.root = el('div', 'hub');
    // Shown when Tab has agents to check: the key, how many, and the first one.
    this.tabHint = el('button', 'hub-tab-hint hidden');
    this.tabHint.type = 'button';
    this.tabHintText = el('span', 'hub-tab-text');
    this.tabHintName = el('span', 'hub-tab-name');
    this.tabHint.append(el('kbd', null, 'Tab'), this.tabHintText, this.tabHintName);
    this.tabHint.onclick = () => onTab?.();
    // The app puts the Tab button above the message box (see app.js).

    // One section per group, each with its own grid of tiles.
    this.grid = el('div', 'hub-board');
    this.empty = el('div', 'hub-empty');
    this.empty.append(el('div', 'hub-empty-tank'), el('p', null, 'No agents yet. Describe a task in the box below to start one.'));
    // Your Claude Code activity (renderer/activity.js fills it).
    this.activityBox = el('div', 'hub-activity');
    this.empty.appendChild(this.activityBox);

    // Your session's usage as a health bar across the top of the Hub (see
    // renderHealth): what is left of the 5-hour limit, losing chunks as your
    // agents use tokens. Clicking it opens the usage card. With Claude and
    // Codex both on, it has one part per provider, side by side.
    this.health = el('button', 'hub-health');
    this.health.type = 'button';
    this.health.title = 'Usage: click for details';
    this.healthSegs = { claude: Hub.healthSeg(), codex: Hub.healthSeg() };
    this.health.append(this.healthSegs.claude.el, this.healthSegs.codex.el);
    this.health.onclick = () => { clearTimeout(this.hoverOpen); this.rail.classList.remove('from-health'); this.showPanel?.('usage'); };
    // Pointing at the bar for a quarter of a second opens the usage card under it; it
    // closes again when the pointer leaves both the bar and the card.
    const openFromHover = () => {
      if (this.rail.classList.contains('open')) return;
      this.rail.classList.add('from-health');
      this.showPanel?.('usage');
      this.openedByHover = true;
    };
    const closeSoon = () => {
      clearTimeout(this.hoverOpen);
      if (!this.openedByHover) return;
      clearTimeout(this.hoverClose);
      this.hoverClose = setTimeout(() => {
        if (this.health.matches(':hover') || this.usage.matches(':hover')) return;
        this.openedByHover = false;
        if (this.rail.classList.contains('open') && this.rail.dataset.panel === 'usage') {
          this.rail.classList.remove('open');
          window.uiSound?.('tickDown');
        }
      }, 300);
    };
    this.health.addEventListener('pointerenter', () => { clearTimeout(this.hoverClose); this.hoverOpen = setTimeout(openFromHover, 250); });
    this.health.addEventListener('pointerleave', closeSoon);

    this.root.append(this.health, this.grid, this.empty);

    // Your plan's usage (see setUsage): a small tab pinned to the left edge
    // of the Hub. Clicking it opens the usage card beside it; clicking
    // anywhere else, or Esc, closes it again.
    this.rail = el('div', 'usage-rail');
    this.usageTab = el('button', 'usage-tab');
    this.usageTab.type = 'button';
    this.usageTab.title = 'Usage';
    // The card has your plan's usage on the left and your Claude Code
    // activity (renderer/activity.js fills it) on the right.
    this.usage = el('aside', 'hub-usage usage-card');
    this.usageMain = el('div', 'usage-main');
    this.usageActivityBox = el('div', 'usage-activity');
    this.usage.append(this.usageMain, this.usageActivityBox);
    this.usage.addEventListener('pointerenter', () => clearTimeout(this.hoverClose));
    this.usage.addEventListener('pointerleave', () => this.health.dispatchEvent(new Event('pointerleave')));
    // A small settings button above the usage tab opens a short menu in the
    // same place: Connectors (a dialog, see renderer/connectors.js) and the
    // settings file. The app sets onOpenConnectors and onOpenSettings.
    this.settingsBtn = el('button', 'hub-settings-btn');
    this.settingsBtn.type = 'button';
    this.settingsBtn.title = 'Settings';
    this.settingsBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';
    this.settingsMenu = el('aside', 'hub-usage hub-settings-menu');
    const menuItem = (label, hint, action) => {
      const b = el('button', 'hub-menu-item');
      b.type = 'button';
      b.append(el('span', 'hub-menu-label', label), el('span', 'hub-menu-hint', hint));
      b.onclick = () => { this.rail.classList.remove('open'); action(); };
      return b;
    };
    this.settingsMenu.append(
      menuItem('Settings…', 'Defaults, limits and the claude path', () => this.onOpenSettings?.()),
      menuItem('Connectors…', 'Jira, Slack, Notion and more for your agents', () => this.onOpenConnectors?.()),
    );
    // The Branches view (renderer/branches.js): an SVN branch's own changes.
    this.branchesBtn = el('button', 'hub-settings-btn hub-branches-btn');
    this.branchesBtn.type = 'button';
    this.branchesBtn.title = 'Branch diff: what an SVN branch changed';
    this.branchesBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="7" r="2.2"/><path d="M6 7.2v9.6M18 9.2c0 4.5-6 3.8-11 7.6"/></svg>';
    this.branchesBtn.onclick = () => { this.rail.classList.remove('open'); this.onOpenBranches?.(); };
    // The floating bar on the left edge: Settings on its own at the top, then
    // the branch diff and Usage together.
    const nav = el('nav', 'hub-nav');
    this.settingsBtn.classList.add('hub-nav-settings');
    nav.append(this.settingsBtn, this.branchesBtn, this.usageTab);
    this.rail.append(nav, this.usage, this.settingsMenu);
    // A button opens its card, or closes it when it is already open.
    const showPanel = this.showPanel = panel => {
      const same = this.rail.classList.contains('open') && this.rail.dataset.panel === panel;
      this.rail.dataset.panel = panel;
      this.rail.classList.toggle('open', !same);
      window.uiSound?.(same ? 'tickDown' : 'tick');
      if (!same && panel === 'usage') this.onOpenUsage?.();
    };
    this.rail.dataset.panel = 'usage';
    this.usageTab.onclick = () => showPanel('usage');
    this.settingsBtn.onclick = () => { this.rail.classList.remove('from-health'); showPanel('settings'); };
    document.addEventListener('pointerdown', e => {
      if (this.rail.classList.contains('open') && !this.rail.contains(e.target)) {
        this.rail.classList.remove('open');
        window.uiSound?.('tickDown');
      }
    }, true);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && this.rail.classList.contains('open')) {
        e.stopImmediatePropagation();
        this.rail.classList.remove('open');
        window.uiSound?.('tickDown');
      }
    }, true);
    container.append(this.rail, this.root);
    // The groups shrink to fit the window's height (see fitToHeight).
    this.container = container;
    new ResizeObserver(() => requestAnimationFrame(() => this.fitToHeight())).observe(container);
    this.setUsage(null);
  }

  // usage: { claude, codex, tokens: tokens your agents used since the app
  // opened, tasks }. claude and codex: { limits: rate_limit_info or null,
  // at: when it arrived }, or null while that provider is off.
  setUsage(usage) {
    this.usageData = usage;
    this.renderUsage();
    // While a limit is reached, the countdown and the tiles' "continues in" tick.
    clearInterval(this.limitTick);
    if (Hub.providers(usage).some(p => usage[p].limits?.status === 'rejected')) this.limitTick = setInterval(() => { this.renderUsage(); if (this.latest) this.update(...this.latest); }, 30 * 1000);
  }

  // The providers that are on, Claude first.
  static providers(usage) {
    return ['claude', 'codex'].filter(p => usage?.[p]);
  }

  renderUsage() {
    const u = this.usageData;
    this.renderUsageTab(u);
    this.renderHealth();
    const box = this.usageMain;
    box.textContent = '';
    box.appendChild(el('div', 'usage-title', 'Usage'));
    const providers = Hub.providers(u);
    const meters = [['five_hour', 'Current session', '5-hour limit'], ['seven_day', 'This week', 'all models']];
    for (const p of providers) {
      const data = u[p];
      if (providers.length > 1) box.appendChild(el('div', `usage-provider ${p}`, PROVIDER_NAMES[p]));
      const windows = data.limits?.unifiedWindows;
      if (!windows) {
        box.appendChild(el('div', 'usage-note', p === 'codex' ? 'Shows Codex\'s limits once Codex answers.' : 'Shows your plan limits after an agent\'s first reply.'));
        continue;
      }
      for (const [key, label, note] of meters) {
        const w = windows[key];
        if (!w) continue;
        const pct = Math.max(0, Math.min(100, Math.round((w.utilization || 0) * 100)));
        const level = pct >= 90 ? 'high' : pct >= 70 ? 'mid' : 'low';
        const meter = el('div', `usage-meter ${level}`);
        const top = el('div', 'usage-row');
        top.append(el('span', 'usage-label', label), el('span', 'usage-pct', `${pct}%`));
        const bar = el('div', 'usage-bar');
        const fill = el('div', 'usage-fill');
        fill.style.width = `${pct}%`;
        bar.appendChild(fill);
        meter.append(top, bar, el('div', 'usage-note', `${p === 'codex' && key === 'seven_day' ? 'Codex' : note} · resets ${Hub.resetFull(w.resetsAt)}`));
        box.appendChild(meter);
      }
      if (data.limits.status === 'rejected') box.appendChild(el('div', 'usage-warn', `Limit reached: it resets ${Hub.resetFull(data.limits.resetsAt)}, and waiting ${PROVIDER_NAMES[p]} agents continue then${providers.length > 1 ? `; new agents start on ${PROVIDER_NAMES[providers.find(o => o !== p)]}` : ''}`));
      const age = Date.now() - (data.at || 0);
      if (age > 10 * 60 * 1000) box.appendChild(el('div', 'usage-note', `as of ${Hub.ago(age)} ago`));
    }
    const tokens = u?.tokens || 0;
    const since = el('div', 'usage-since');
    since.append(el('span', 'usage-label', 'Since Agent Hub opened'),
      el('span', 'usage-big', tokens ? `${formatTokens(tokens)} tokens` : '—'),
      el('span', 'usage-note', `${u?.tasks || 0} task${u?.tasks === 1 ? '' : 's'}`));
    box.appendChild(since);
  }

  // The tab shows each provider's session and week as two small upright
  // meters, with the session's percentage under them.
  renderUsageTab(u) {
    const tab = this.usageTab;
    tab.textContent = '';
    const providers = Hub.providers(u);
    for (const p of providers.length ? providers : ['claude']) {
      const windows = u?.[p]?.limits?.unifiedWindows;
      const bars = el('div', `usage-tab-bars ${p}`);
      for (const key of ['five_hour', 'seven_day']) {
        const pct = windows?.[key] ? Math.max(0, Math.min(100, Math.round((windows[key].utilization || 0) * 100))) : 0;
        const bar = el('span', `usage-tab-bar ${pct >= 90 ? 'high' : pct >= 70 ? 'mid' : 'low'}`);
        const fill = el('span');
        fill.style.height = `${pct}%`;
        bar.appendChild(fill);
        bars.appendChild(bar);
      }
      const session = windows?.five_hour ? `${Math.round((windows.five_hour.utilization || 0) * 100)}%` : '–';
      tab.append(bars, el('span', 'usage-tab-pct', session));
      if (providers.length > 1) bars.title = PROVIDER_NAMES[p];
    }
    tab.append(el('span', 'usage-tab-label', 'Usage'));
    this.limitTimer?.remove();
    this.limitTimer = null;
  }

  // One provider's part of the health bar.
  static healthSeg() {
    const seg = { el: el('div', 'health-seg'), left: null, pending: null, timer: null };
    const track = el('div', 'health-track');
    seg.ghost = el('div', 'health-ghost');
    seg.fill = el('div', 'health-fill');
    const ticks = el('div', 'health-ticks');
    for (let i = 0; i < 9; i++) ticks.appendChild(el('span'));
    seg.float = el('div', 'health-floats');
    track.append(seg.ghost, seg.fill, ticks, seg.float);
    seg.label = el('span', 'health-label', 'Tokens');
    seg.text = el('span', 'health-text', '');
    seg.week = el('span', 'health-week');
    seg.el.append(seg.label, track, seg.text, seg.week);
    return seg;
  }

  // The health bar: what is left of the session's limit. When it drops, a
  // lighter "ghost" stays at the old level for a moment and then catches up,
  // like a game's health bar taking damage. One part per provider that is on.
  renderHealth() {
    const providers = Hub.providers(this.usageData);
    const shown = providers.length ? providers : ['claude'];
    const split = shown.length > 1;
    this.health.classList.toggle('split', split);
    for (const p of ['claude', 'codex']) {
      const seg = this.healthSegs[p];
      seg.el.classList.toggle('hidden', !shown.includes(p));
      seg.el.classList.toggle(p, true);
      if (!shown.includes(p)) continue;
      seg.label.textContent = split ? PROVIDER_NAMES[p] : 'Tokens';
      this.renderHealthSeg(seg, this.usageData?.[p]?.limits, split ? PROVIDER_NAMES[p] : null);
    }
  }

  renderHealthSeg(seg, l, name) {
    const w = l?.unifiedWindows;
    const used = w?.five_hour ? Math.max(0, Math.min(100, (w.five_hour.utilization || 0) * 100)) : null;
    const resets = l?.status === 'rejected' ? l.resetsAt || w?.[l.rateLimitType]?.resetsAt : w?.five_hour?.resetsAt;
    const limited = l?.status === 'rejected' && resets && resets * 1000 > Date.now();
    const left = limited ? 0 : used == null ? null : 100 - used;
    seg.el.classList.toggle('unknown', left == null);
    seg.el.classList.toggle('limited', !!limited);
    seg.el.classList.remove('low', 'mid', 'high');
    if (left != null) seg.el.classList.add(left <= 10 ? 'low' : left <= 30 ? 'mid' : 'high');
    const pct = left ?? 0;
    const before = seg.left;
    seg.left = pct;
    seg.fill.style.width = `${pct}%`;
    if (before == null || pct >= before) {
      // Going up (a reset) or the first value: the ghost follows at once.
      seg.ghost.style.transitionDelay = '0s';
      seg.ghost.style.width = `${pct}%`;
    } else {
      // Damage: the bar flashes, the ghost lingers, then drains to the new level.
      seg.el.classList.remove('hit');
      void seg.el.offsetWidth;
      seg.el.classList.add('hit');
      seg.ghost.style.transitionDelay = '0.6s';
      seg.ghost.style.width = `${pct}%`;
    }
    seg.text.textContent = limited
      ? (name ? `Limit reached · resets ${Hub.resetText(resets)}` : `Limit reached · resets ${Hub.resetText(resets)}, then waiting agents continue`)
      : left == null ? (name ? 'Shows after its first reply' : 'Usage shows after an agent\'s first reply')
      : `${Math.round(left)}% left${resets ? ` · resets ${Hub.resetText(resets)}` : ''}`;
    const week = w?.seven_day ? Math.round((w.seven_day.utilization || 0) * 100) : null;
    seg.week.textContent = week == null ? '' : `Week ${week}%`;
  }

  // Tokens an agent just used: a number that floats off the bar's end.
  // One answer's tokens float off its provider's part of the health bar,
  // weighted roughly as they count against your usage: new input, cache
  // writes and output in full, cache reads (the conversation read again from
  // the prompt cache, most of a long conversation's tokens) at a tenth, as in
  // the API's prices. Pointing at the number holds it and shows the
  // breakdown; the health bar's tooltip keeps the last one.
  // parts: { input, cacheWrite, cacheRead, output }.
  tokenTick(parts, provider = 'claude') {
    const seg = this.healthSegs[provider] || this.healthSegs.claude;
    if (!parts || !seg.float.isConnected) return;
    const p = seg.pending = seg.pending || { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    for (const k of Object.keys(p)) p[k] += parts[k] || 0;
    if (seg.timer) return;
    seg.timer = setTimeout(() => {
      const t = seg.pending;
      seg.pending = null;
      seg.timer = null;
      const weighted = Math.round(t.input + t.cacheWrite + t.output + t.cacheRead / 10);
      if (!weighted) return;
      const detail = [
        `${formatTokens(t.input)} new`, `${formatTokens(t.cacheWrite)} written to the cache`,
        `${formatTokens(t.cacheRead)} read from the cache (counted at a tenth)`, `${formatTokens(t.output)} output`,
      ].join(' · ');
      const f = el('span', 'health-float', `−${formatTokens(weighted)}`);
      f.title = `This step: about ${formatTokens(weighted)} tokens of your usage\n${detail}`;
      f.style.left = `${Math.max(4, Math.min(92, seg.left ?? 50))}%`;
      seg.float.appendChild(f);
      this.health.title = `Usage: click for details\nLast step: about ${formatTokens(weighted)} tokens (${detail})`;
      seg.fill.classList.remove('pulse');
      void seg.fill.offsetWidth;
      seg.fill.classList.add('pulse');
      // Pointing at it holds it, so the breakdown can be read.
      let gone = setTimeout(() => f.remove(), 1400);
      f.onmouseenter = () => { clearTimeout(gone); f.classList.add('held'); };
      f.onmouseleave = () => { f.classList.remove('held'); gone = setTimeout(() => f.remove(), 500); };
    }, 350);
  }

  // "in 2h 05m", "Fri 18:00" for later than a day.
  static resetText(seconds) {
    if (!seconds) return 'later';
    const ms = seconds * 1000 - Date.now();
    if (ms <= 0) return 'now';
    if (ms < 24 * 3600 * 1000) {
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      return h ? `in ${h}h ${String(m).padStart(2, '0')}m` : m ? `in ${m}m` : 'in under a minute';
    }
    return new Date(seconds * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }

  // For the usage window: when it resets, also as a date and time.
  // "in 2h 05m · today 18:30", "in 20h 10m · tomorrow 09:00", "Fri 17 Oct, 18:00".
  static resetFull(seconds) {
    if (!seconds) return 'later';
    const d = new Date(seconds * 1000);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    const day = d.toDateString() === now.toDateString() ? 'today'
      : d.toDateString() === tomorrow.toDateString() ? 'tomorrow' : null;
    const date = day ? `${day} ${time}` : `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${time}`;
    const ms = d.getTime() - Date.now();
    return ms > 0 && ms < 24 * 3600 * 1000 ? `${Hub.resetText(seconds)} · ${date}` : ms <= 0 ? 'now' : date;
  }

  static ago(ms) {
    const m = Math.round(ms / 60000);
    return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
  }

  createTile(agent) {
    // A new tile springs in, or, when it was started from the Hub's message
    // box, stays hidden until the box has morphed into it (see morph()).
    const arrival = this.arrivals.get(agent.id);
    this.arrivals.delete(agent.id);
    const entry = this.buildTile(agent, arrival);
    this.tiles.set(agent.id, entry);
    return entry;
  }

  // A copy of the agent's tile as the Hub would draw it now, for the
  // notification in the corner of the screen (toast.html). Made fresh, so
  // it is up to date even while the Hub's own tiles stand still (freeze()).
  snapshot(agent) {
    const entry = this.buildTile(agent, null);
    this.paint(entry, agent, null);
    return entry.el;
  }

  buildTile(agent, arrival) {
    const tile = el('div', arrival ? 'hub-tile arriving' : 'hub-tile spawn');
    // Each tile gets its own starting point (--phase), pace (--tempo, 85-120%)
    // and wave position (--wave-delay) for every looping animation, so tiles
    // side by side never move in step (see styles.css).
    tile.style.setProperty('--phase', `-${(Math.random() * 9).toFixed(2)}s`);
    tile.style.setProperty('--tempo', (0.85 + Math.random() * 0.35).toFixed(3));
    tile.style.setProperty('--wave-delay', `-${(Math.random() * 30).toFixed(2)}s`);
    // The retro theme draws new tiles with its own animation (mu-draw).
    tile.addEventListener('animationend', e => { if (e.target === tile && ['spawn', 'mu-draw'].includes(e.animationName)) tile.classList.remove('spawn'); });
    // A click opens the agent, unless it was the end of dragging the tile.
    tile.onclick = e => {
      if (this.justDragged) return;
      if (e.ctrlKey || e.metaKey) { this.toggleSelected(agent.id); return; }
      this.open(agent.id);
    };
    tile.addEventListener('pointerdown', e => this.press(e, agent.id));
    // The tile leans toward the pointer, and its liquid tilts with it.
    tile.addEventListener('pointermove', e => {
      if (this.drag || e.pointerType !== 'mouse') return;
      const r = tile.getBoundingClientRect();
      const dx = (e.clientX - r.left) / r.width - 0.5;
      const dy = (e.clientY - r.top) / r.height - 0.5;
      tile.style.setProperty('--ry', `${(dx * 10).toFixed(2)}deg`);
      tile.style.setProperty('--rx', `${(-dy * 10).toFixed(2)}deg`);
      tile.style.setProperty('--lean', `${(dx * 7).toFixed(2)}deg`);
    });
    tile.addEventListener('pointerleave', () => {
      for (const p of ['--rx', '--ry', '--lean']) tile.style.removeProperty(p);
    });
    tile.oncontextmenu = e => { e.preventDefault(); this.onContext?.(agent.id); };
    const remove = el('button', 'tile-remove', '×');
    remove.title = 'Remove from the Hub';
    remove.onclick = e => { e.stopPropagation(); this.onRemove?.(agent.id); };
    // While the agent works: stop its current task (it stays in the Hub).
    const stop = el('button', 'tile-stop');
    stop.title = 'Stop the current task';
    stop.appendChild(el('span'));
    stop.onclick = e => { e.stopPropagation(); this.onInterrupt?.(agent.id); };

    const tank = el('div', 'tank');
    const liquid = el('div', 'liquid');
    const bubbles = el('div', 'bubbles');
    for (let i = 0; i < BUBBLE_COUNT; i++) {
      const b = el('span');
      b.style.setProperty('--x', `${10 + Math.random() * 80}%`);
      b.style.setProperty('--d', `${(Math.random() * 2.4).toFixed(2)}s`);
      b.style.setProperty('--bd', `${(2.1 + Math.random() * 1.4).toFixed(2)}s`);   // each bubble rises at its own speed
      b.style.setProperty('--s', `${4 + Math.round(Math.random() * 6)}px`);
      bubbles.appendChild(b);
    }
    const burst = el('div', 'burst');
    for (let i = 0; i < BURST_COUNT; i++) {
      const p = el('span');
      p.style.setProperty('--a', `${(360 / BURST_COUNT) * i}deg`);
      burst.appendChild(p);
    }
    const icon = el('div', 'tank-icon');
    const badge = el('div', 'tank-badge', '!');
    const ping = el('div', 'tank-ping');
    // The Nostromo theme draws its terrain scan here instead (scanreveal.js).
    const scan = el('canvas', 'tank-scan');
    tank.append(liquid, bubbles, scan, el('div', 'tank-shine'), icon, ping, badge, burst);

    // Under the tank: the task title, then its status and time.
    const info = el('div', 'hub-info');
    const title = el('div', 'hub-title');
    // What the agent is doing right now, in plain words (stepPhrase in render.js).
    const step = el('div', 'hub-step hidden');
    const statusRow = el('div', 'hub-status');
    const statusDot = el('span', 'dot');
    const statusText = el('span');
    const timer = el('span', 'hub-timer');
    statusRow.append(statusDot, statusText, timer);
    // The model it runs on (with Auto: the one Auto picked), see modelOf. On
    // its own line: in the status row it wrapped or not depending on how long
    // the timer was, so a working tile kept changing height, and the Hub
    // resized every tile to fit (see fitToHeight).
    const model = el('span', 'hub-model hidden');
    // Another working agent changes the same file (see noteClashes in app.js).
    const clash = el('div', 'hub-clash hidden');
    info.append(title, step, statusRow, model, clash);

    // Stopped before it was done: continue its task (restartAgent in app.js).
    const restart = el('button', 'tile-restart', '↻');
    restart.title = 'Restart: continue the task it was doing when it stopped';
    restart.onclick = e => { e.stopPropagation(); this.onRestart?.(agent.id); };
    // The background jobs it waits for circle the tank (paintOrbit).
    const orbit = el('div', 'tank-orbit');
    tile.append(remove, stop, restart, tank, orbit, info);
    return { el: tile, status: null, fresh: true, level: 0, arrival, parts: { liquid, icon, badge, title, step, statusDot, statusText, timer, model, clash, orbit } };
  }

  // The liquid level: low while starting, climbing with the step count while
  // working, full when done.
  levelFor(agent) {
    const steps = agent.transcript.stepCount;
    switch (agent.status) {
      case 'starting': return 22;
      case 'working':
      case 'stuck':
      case 'background':
      case 'waiting': return Math.min(88, 30 + steps * 4);
      case 'idle': return 100;
      case 'error': return 60;
      default: return 12;
    }
  }

  // groups: [{ id, name }] in display order. Each agent has a groupId (or
  // null) and a repo name; there is one panel per group and repository.
  // Selects or unselects a tile (on: true/false, or the other way round).
  toggleSelected(id, on = !this.selected.has(id), notify = true) {
    if (on) this.selected.add(id);
    else this.selected.delete(id);
    this.tiles.get(id)?.el.classList.toggle('selected', on);
    if (notify) this.onSelect?.([...this.selected]);
  }

  clearSelection() {
    for (const id of this.selected) this.tiles.get(id)?.el.classList.remove('selected');
    this.selected.clear();
    this.onSelect?.([]);
  }

  update(agents, currentId, groups = []) {
    this.latest = [agents, currentId, groups];
    // Tiles that are gone leave the selection.
    const ids = new Set(agents.map(a => a.id));
    const before = this.selected.size;
    for (const id of [...this.selected]) if (!ids.has(id)) this.selected.delete(id);
    if (this.selected.size !== before) this.onSelect?.([...this.selected]);
    // While the app is minimized (or replaying), the tiles keep the
    // state you last saw; thaw() catches them up.
    // While a chat shrinks back into its tile (returnTo), the tiles hold still.
    if (this.frozen || this.replaying || this.drag || this.holding) return;
    this.render(agents, currentId, groups);
  }

  // The app was minimized: tiles stop changing until thaw().
  freeze() {
    this.frozen = true;
  }

  // The app is back in front. The tiles whose state changed in the meantime
  // move to their new state one after another, each with its usual
  // animation (finished, needs you, error). instant skips the replay.
  async thaw({ instant = false } = {}) {
    if (!this.frozen) return;
    this.frozen = false;
    if (!this.latest) return;
    const changed = this.latest[0].filter(a => {
      const entry = this.tiles.get(a.id);
      return entry && entry.status && entry.status !== a.status && !entry.removing;
    });
    if (instant || !changed.length) {
      this.render(...this.latest);
      return;
    }
    // A stand-in for each changed agent that still has its old state.
    const pending = new Map(changed.map(a => [a.id, this.tiles.get(a.id).status]));
    const staged = () => this.latest[0].map(a => (pending.has(a.id) ? Object.assign(Object.create(a), { status: pending.get(a.id) }) : a));
    this.replaying = true;
    this.render(staged(), this.latest[1], this.latest[2]);
    const wait = ms => new Promise(r => setTimeout(r, ms));
    await wait(250);
    for (const a of changed) {
      // The tile may have been removed while the replay runs.
      if (!this.tiles.has(a.id)) continue;
      const before = pending.get(a.id);
      pending.delete(a.id);
      this.render(staged(), this.latest[1], this.latest[2]);
      // The sound of the new state plays with its animation.
      this.onReplay?.(a, before);
      await wait(550);
    }
    this.replaying = false;
    this.render(...this.latest);
  }

  // Draws the tile in the agent's state: level, icon, title, status, model.
  paint(entry, agent, currentId) {
    const { el: tile, parts } = entry;
    // Play the one-time animations when the state changes.
    const before = entry.status;
    if (before !== agent.status) {
      tile.classList.remove(`state-${before}`);
      tile.classList.add(`state-${agent.status}`);
      // Finished: the tank sloshes up to the brim and the check pops in.
      // Other changes give the tile a small wobble.
      if (agent.status === 'idle' && ['working', 'waiting', 'starting', 'stuck', 'background'].includes(before)) {
        this.replay(tile, 'finish', 1300);
      } else if (agent.status === 'error' && before) this.replay(tile, 'shake', 700);
      else if (before) this.replay(tile, 'wob', 600);
      entry.status = agent.status;
    }
    tile.classList.toggle('current', agent.id === currentId);
    // Thinking (no tool running): slow bubbles that gather at the surface.
    tile.classList.toggle('thinking', agent.status === 'working' && agent.transcript?.liveStep === 'Thinking…');
    tile.classList.toggle('unread', !!agent.unread);
    tile.classList.toggle('stopped', !!agent.stopped && ['idle', 'error', 'exited'].includes(agent.status));

    // A new tank starts empty and fills up, so the browser must draw it
    // empty once before the level changes.
    if (entry.fresh) {
      entry.fresh = false;
      parts.liquid.style.height = '0%';
      void parts.liquid.offsetHeight;
    }
    entry.level = this.levelFor(agent);
    tile.dataset.level = String(entry.level);
    // What kind of task (the Nostromo theme's tank draws a screen per kind).
    tile.dataset.task = window.taskType ? taskType.kindOf(agent) : 'none';
    parts.liquid.style.height = `${entry.level}%`;
    // Waiting for the usage limit to reset (limitOf in app.js): a clock, and when it continues.
    const limited = agent.limited || null;
    tile.classList.toggle('limited', !!limited);
    // Signed out: waits for you to sign in again, then continues.
    const authWait = !limited && !!agent.authWait;
    tile.classList.toggle('authwait', authWait);
    const stoppedNow = !!agent.stopped && ['idle', 'error', 'exited'].includes(agent.status);
    parts.icon.textContent = limited ? '⏳' : authWait ? '🔑' : stoppedNow ? '■' : { idle: '✓', error: '✕' }[agent.status] || '';
    // After a follow-up message, the tile shows that message (summarized).
    if (!entry.renaming) parts.title.textContent = agentName(agent);
    tile.classList.toggle('named', !!customNameOf(agent));
    const busy = ['working', 'starting', 'stuck', 'waiting'].includes(agent.status);
    const stepText = limited ? `Waiting for ${PROVIDER_NAMES[limited.provider] || 'Claude'}'s usage limit to reset`
      : authWait ? 'Waiting for you to sign in to Claude'
      : agent.status === 'background' && agent.backgroundTasks?.length
      ? `Waiting for: ${agent.backgroundTasks.join(', ')}`
      : busy ? agent.transcript.liveStep : null;
    parts.step.classList.toggle('hidden', !stepText);
    if (stepText && parts.step.textContent !== stepText) {
      parts.step.textContent = stepText;
      parts.step.title = stepText;
      parts.step.classList.remove('changed');
      void parts.step.offsetWidth;
      parts.step.classList.add('changed');
    }
    parts.title.title = agent.latestPrompt
      ? `${agent.latestPrompt}\n\nTask: ${agent.title}\n${agent.cwd}`
      : `${agent.title}\n${agent.cwd}`;
    parts.statusDot.className = `dot ${agent.status}`;
    parts.statusText.textContent = limited ? `${PROVIDER_NAMES[limited.provider] || 'Claude'} limit · continues ${Hub.resetText(limited.resetAt / 1000)}`
      : authWait ? 'Signed out · continues after you sign in'
      // Getting ready before Claude Code starts (a Jira ticket, a handoff).
      : agent.status === 'starting' && agent.bootNote ? `Booting up · ${agent.bootNote}`
      : agent.stopped && ['idle', 'error', 'exited'].includes(agent.status) ? 'Stopped before it was done'
      : HUB_STATUS_TEXT[agent.status] || agent.status;
    // What a waiting agent needs from you: an answer or an approval.
    const needs = agent.status === 'waiting' ? agent.attention || 'approval' : null;
    tile.classList.toggle('needs-question', needs === 'question');
    parts.badge.textContent = needs === 'question' ? '?' : '!';
    if (needs) parts.statusText.textContent = needs === 'question' ? 'Asks you a question' : 'Needs approval';
    // What a stuck agent keeps doing, and for how long.
    if (agent.status === 'stuck' && agent.stuck) {
      const mins = Math.max(1, Math.round((Date.now() - agent.stuck.since) / 60000));
      // Connector tools are named mcp__<server>__<tool>; show "server · tool".
      const [prefix, server, ...rest] = agent.stuck.name.split('__');
      const tool = prefix === 'mcp' && rest.length ? `${server} · ${rest.join('__')}` : agent.stuck.name;
      parts.statusText.textContent = `Stuck · ${tool}`;
      parts.statusText.title = `${agent.stuck.count ? `${agent.stuck.count} times in a row: ` : 'Running for '}${agent.stuck.summary} · ${mins} min`;
      parts.badge.textContent = '⏳';
    } else {
      // Which background jobs a "background" agent waits for.
      parts.statusText.title = agent.status === 'background' && agent.backgroundTasks?.length ? `Waiting for: ${agent.backgroundTasks.join(', ')}` : '';
    }
    this.updateTimer(agent, parts.timer);
    const model = this.modelOf?.(agent) || null;
    parts.model.classList.toggle('hidden', !model);
    if (model) {
      if (parts.model.textContent !== model.label) parts.model.textContent = model.label;
      parts.model.title = model.title || '';
      parts.model.classList.toggle('fable', !!model.fable);
      parts.model.classList.toggle('auto', !!model.auto);
    }
    this.paintOrbit(parts.orbit, agent.status === 'background' ? agent.backgroundTasks || [] : []);
    const clashes = agent.clashes ? [...agent.clashes.values()] : [];
    parts.clash.classList.toggle('hidden', !clashes.length);
    if (clashes.length) {
      const files = [...new Set(clashes.flatMap(c => [...c.files]))];
      parts.clash.textContent = `⚠ Same file${files.length === 1 ? '' : 's'}`;
      parts.clash.title = `Also being changed by ${clashes.map(c => `"${c.title}"`).join(', ')}:\n${files.join('\n')}`;
    }
  }

  // A moon per background job, circling the tank on a tilted ring, spread
  // evenly round it. A job that ends pops its moon; a new one rises in.
  paintOrbit(orbit, jobs) {
    const left = [...jobs];
    for (const moon of orbit.querySelectorAll('.moon:not(.popping)')) {
      const i = left.indexOf(moon.dataset.job);
      if (i >= 0) { left.splice(i, 1); continue; }
      moon.classList.add('popping');
      setTimeout(() => moon.remove(), 600);
    }
    for (const job of left) {
      const moon = el('span', 'moon');
      moon.dataset.job = job;
      const y = el('span');
      y.appendChild(el('i'));
      moon.appendChild(y);
      orbit.appendChild(moon);
    }
    const live = [...orbit.querySelectorAll('.moon:not(.popping)')];
    live.forEach((moon, i) => { moon.style.setProperty('--i', String(i)); moon.style.setProperty('--n', String(live.length)); });
    orbit.classList.toggle('has-moons', live.length > 0);
  }

  // The agent added to its category's notes: a drop leaves the surface of
  // its liquid and falls into its panel's Notes button, which gulps it.
  noteDrop(agentId) {
    const tile = this.tiles.get(agentId)?.el;
    const chip = tile?.closest('.hub-section')?.querySelector('.section-notes');
    if (!tile || !chip || !tile.getClientRects().length || !chip.getClientRects().length) return;
    const from = tile.querySelector('.liquid')?.getBoundingClientRect() || tile.getBoundingClientRect();
    const to = chip.getBoundingClientRect();
    const drop = el('div', 'note-drop');
    drop.style.setProperty('--c1', getComputedStyle(tile).getPropertyValue('--c1').trim() || '#8df4ff');
    document.body.appendChild(drop);
    const x0 = from.left + from.width / 2, y0 = from.top;
    const x1 = to.left + to.width / 2, y1 = to.top + to.height / 2;
    drop.animate(Hub.arc(x0, y0, x1, y1, Math.min(70, Math.max(30, Math.abs(x1 - x0) * 0.15)), t => (t < 0.1 ? 0.4 + t * 6 : 1 - t * 0.35)),
      { duration: 900, easing: 'cubic-bezier(.4,0,.6,1)' }).finished.then(() => {
      drop.remove();
      this.replay(chip, 'gulp', 600);
    }, () => drop.remove());
  }

  // Keyframes along a parabola from (x0, y0) up by lift and over to (x1, y1).
  static arc(x0, y0, x1, y1, lift, scale = () => 1) {
    const frames = [];
    for (let k = 0; k <= 12; k++) {
      const t = k / 12;
      frames.push({ transform: `translate(${x0 + (x1 - x0) * t}px, ${y0 + (y1 - y0) * t - lift * 4 * t * (1 - t)}px) scale(${scale(t)})` });
    }
    return frames;
  }

  // A tile held over another agent's tank and let go there (see moveDrag):
  // it tips over and its liquid pours across into the other tank, which
  // fills up; then onPour hands the agent's result over.
  async pour(fromId, toId) {
    const src = this.tiles.get(fromId)?.el;
    const dst = this.tiles.get(toId)?.el;
    if (!src || !dst) return;
    const a = src.querySelector('.tank').getBoundingClientRect();
    const b = dst.querySelector('.tank').getBoundingClientRect();
    const right = b.left > a.left;
    src.style.setProperty('--tip', right ? '14deg' : '-14deg');
    src.classList.add('tipping');
    this.onDragSound?.('pick');
    const color = getComputedStyle(src).getPropertyValue('--c1').trim() || '#8df4ff';
    const x0 = right ? a.right - 8 : a.left + 8, y0 = a.top + 6;
    const x1 = b.left + b.width / 2, y1 = b.top + b.height * 0.3;
    const lift = Math.min(80, Math.max(36, Math.abs(x1 - x0) * 0.25));
    const drops = [];
    for (let n = 0; n < 18; n++) {
      const d = el('div', 'pour-drop');
      d.style.setProperty('--c1', color);
      document.body.appendChild(d);
      const size = 0.6 + Math.random() * 0.7;
      drops.push(d.animate(Hub.arc(x0, y0, x1, y1, lift, () => size),
        { duration: 600, delay: 200 + n * 40, easing: 'cubic-bezier(.45,0,.7,1)', fill: 'backwards' })
        .finished.then(() => d.remove(), () => d.remove()));
    }
    setTimeout(() => this.replay(dst, 'filling', 1000), 700);
    await Promise.all(drops);
    setTimeout(() => this.onDragSound?.('drop'), 0);
    src.classList.remove('tipping');
    await new Promise(r => setTimeout(r, 350));
    this.onPour?.(fromId, toId);
  }

  render(agents, currentId, groups = []) {
    const seenSections = new Set();   // the first agent of each panel gives the panel its folder
    const seen = new Set();
    const counts = new Map();
    const firstAt = new Map();   // panel key -> place of its first agent
    let order = 0;
    for (const agent of agents) {
      seen.add(agent.id);
      const entry = this.tiles.get(agent.id) || this.createTile(agent);
      if (entry.removing) continue;
      const { el: tile } = entry;
      tile.style.order = String(order++);
      const groupKey = groups.some(g => g.id === agent.groupId) ? agent.groupId : '';
      const key = `${groupKey}\n${agent.repo || ''}`;
      counts.set(key, (counts.get(key) || 0) + 1);
      if (!firstAt.has(key)) firstAt.set(key, order);
      const sec = this.section(key, groupKey, agent.repo || '');
      if (!seenSections.has(sec)) { seenSections.add(sec); sec.cwd = agent.cwd; sec.root = agent.repoRoot || agent.repo || ''; }
      const grid = sec.grid;
      if (tile.parentNode !== grid) grid.appendChild(tile);
      if (entry.arrival) {
        const info = entry.arrival;
        entry.arrival = null;
        // When repositories slide to new places (a numbered copy appeared,
        // see the repository order below), the box flies once they stand
        // still, to where the tile ends up.
        this.whenStill(entry.el).then(() => this.morph(entry, info));
      }

      this.paint(entry, agent, currentId);
    }

    for (const [id, entry] of this.tiles) {
      if (!seen.has(id)) {
        entry.el.remove();
        this.tiles.delete(id);
      }
    }

    // A panel is a Group: one Category plus one folder; its agents share
    // context. Panels you have dragged stand in the order you gave them
    // (groupOrder, set by the app); the others follow in the order their
    // first agent came (agents arrive in the order they started, see
    // hubItems in app.js), so a new group appears below the others. Empty
    // panels hide.
    const placed = new Map((this.groupOrder || []).map((key, i) => [key, i]));
    const rank = sec => (firstAt.has(sec.key) ? firstAt.get(sec.key) : Infinity);
    const place = sec => (placed.has(sec.key) ? placed.get(sec.key) : Infinity);
    const sorted = [...this.sections.values()].sort((a, b) => place(a) - place(b) || rank(a) - rank(b));
    sorted.forEach((sec, i) => {
      const n = counts.get(sec.key) || 0;
      sec.el.classList.toggle('hidden', !n);
      sec.count.textContent = String(n);
      const group = sec.groupKey ? groups.find(g => g.id === sec.groupKey) : null;
      sec.name.textContent = sec.groupKey ? group?.name || 'Category' : 'No category';
      // No category: a looser, open panel, because its agents do not share what they know.
      sec.el.classList.toggle('loose', !sec.groupKey);
      // Shared notes: only for a category; the number of notes when it has some.
      const noteCount = group?.shareLearnings === false ? 0 : (group?.notes?.text || '').split('\n').filter(l => l.trim()).length;
      sec.notes.classList.toggle('hidden', !group);
      sec.notes.classList.toggle('has-notes', noteCount > 0);
      sec.notes.textContent = group?.shareLearnings === false ? 'Notes off' : noteCount ? `Notes · ${noteCount}` : 'Notes';
      // In its repository's container, a panel names only the folder inside
      // the repository it works in (MyGame/Unity: "Unity"), if any.
      const root = sec.root ?? sec.repo;
      sec.repoEl.textContent = sec.repo.startsWith(root + '/') ? sec.repo.slice(root.length + 1) : sec.repo === root ? '' : sec.repo;
      sec.el.style.order = String(i);
    });

    // Two levels: a container per repository, holding its category panels.
    // A repository stands where its first panel stands; inside it, the
    // panels keep their order.
    const repoCounts = new Map();
    const repoFirst = new Map();
    const repoCwds = new Map();
    sorted.forEach((sec, i) => {
      const n = counts.get(sec.key) || 0;
      const name = sec.root ?? sec.repo;
      const repo = this.repoBox(name);
      if (sec.el.parentNode !== repo.body && !sec.el.classList.contains('dragging-group')) repo.body.appendChild(sec.el);
      if (!n) return;
      repoCounts.set(name, (repoCounts.get(name) || 0) + n);
      if (!repoFirst.has(name)) repoFirst.set(name, i);
      if (!repoCwds.has(name)) repoCwds.set(name, []);
      if (sec.cwd) repoCwds.get(name).push(sec.cwd);
    });
    // Copies of one repository (MyGame, MyGame2, MyGame3: the same name with
    // a number at the end) stay together, in the order of their numbers, at
    // the place of the first of them; no number counts as 1.
    const family = name => {
      const m = /^(.*?)[-_ ]?(\d+)$/.exec(name);
      return m && m[1] ? { base: m[1].toLowerCase(), n: Number(m[2]) } : { base: name.toLowerCase(), n: 1 };
    };
    const shown = [...repoFirst.keys()].sort((a, b) => repoFirst.get(a) - repoFirst.get(b));
    const repoPlace = new Map();
    for (const name of shown) {
      if (repoPlace.has(name)) continue;
      const base = family(name).base;
      const kin = shown.filter(other => family(other).base === base).sort((a, b) => family(a).n - family(b).n || a.localeCompare(b));
      for (const k of kin) repoPlace.set(k, repoPlace.size);
    }
    // The containers slide to their new places (measured before and after).
    const moving = [...this.repos.values()].filter(r => !r.el.classList.contains('hidden') && repoPlace.has(r.name) && String(repoPlace.get(r.name)) !== r.el.style.order);
    const before = !this.drag && moving.length ? new Map([...this.repos.values()].map(r => [r, r.el.getBoundingClientRect()])) : null;
    for (const [name, repo] of this.repos) {
      const n = repoCounts.get(name) || 0;
      repo.el.classList.toggle('hidden', !n);
      repo.el.style.order = String(repoPlace.get(name) ?? 1000);
      repo.count.textContent = `${n} agent${n === 1 ? '' : 's'}`;
      repo.cwds = repoCwds.get(name) || [];
      const b = repo.cwds.map(c => this.branchOf?.(c)).find(Boolean);
      repo.branch.classList.toggle('hidden', !b);
      if (b && repo.branch.dataset.name !== b.name) {
        repo.branch.dataset.name = b.name;
        repo.branch.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="7" r="2.2"/><path d="M6 7.2v9.6M18 9.2c0 4.5-6 3.8-11 7.6"/></svg>';
        repo.branch.appendChild(document.createTextNode(b.name));
        repo.branch.title = `${b.vcs === 'svn' ? 'SVN' : 'Git'} branch: ${b.name}`;
      }
    }
    if (before) {
      for (const [repo, r] of before) {
        if (repo.el.classList.contains('hidden') || !r.height) continue;
        const dy = r.top - repo.el.getBoundingClientRect().top;
        if (Math.abs(dy) < 1) continue;
        repo.el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: 420, easing: 'cubic-bezier(.2,.9,.25,1.04)' });
        this.repoSlideUntil = performance.now() + 440;
      }
    }
    if (this.unityStates) this.setUnity(this.unityStates);
    if (this.svnStates) this.setTactileSvn(this.svnStates);
    this.ensureKeyAgent();

    this.empty.classList.toggle('hidden', agents.length > 0);
    requestAnimationFrame(() => this.fitToHeight());
    this.grid.classList.toggle('hidden', agents.length === 0);
  }

  // A panel's title is "Category — folder".
  section(key, groupKey, repo) {
    let sec = this.sections.get(key);
    if (!sec) {
      const elSec = el('section', 'hub-section');
      const head = el('div', 'hub-section-head');
      const name = el('span', 'hub-section-name');
      const repoEl = el('span', 'hub-section-repo');
      const count = el('span', 'hub-section-count');
      // Without a category the agents are separate tasks (see forkSourceFor in app.js).
      const loneHint = el('span', 'hub-section-hint', 'separate tasks · no shared context');
      const notes = el('button', 'section-notes', 'Notes');
      notes.title = 'The notes every agent in this category reads and adds to';
      notes.onclick = e => { e.stopPropagation(); this.onOpenNotes?.(sec.groupKey); };
      const remove = el('button', 'section-remove', '× Remove group');
      remove.title = 'Remove this group and all its agents from the Hub';
      // A group in a Unity project: open its Unity Editor, or bring it to
      // the front when it is open (the app sets its state, see setUnity).
      const unity = el('button', 'section-unity hidden');
      unity.type = 'button';
      unity.onclick = e => { e.stopPropagation(); if (sec.cwd) this.onOpenUnity?.(sec.cwd); };
      // Move the whole group to another folder (another repository): its
      // agents continue their conversations there (see moveGroup in app.js).
      const move = el('button', 'section-move', '⇄ Folder');
      move.title = 'Move this group to another folder or repository; its agents continue there';
      const idsHere = () => [...this.tiles].filter(([, t]) => t.el.parentNode === grid && !t.removing).map(([id]) => id);
      move.onclick = e => { e.stopPropagation(); this.onMoveGroup?.(idsHere(), sec.cwd, sec.groupKey || null); };
      elSec.addEventListener('contextmenu', e => {
        if (e.target.closest('.hub-tile')) return;
        e.preventDefault();
        this.onMoveGroup?.(idsHere(), sec.cwd, sec.groupKey || null);
      });
      head.append(name, repoEl, count, loneHint, notes, move, unity, remove);
      const grid = el('div', 'hub-grid');
      elSec.append(head, grid);   // render puts it into its repository's container
      sec = { key, groupKey, repo, el: elSec, name, repoEl, count, notes, unity, grid, cwd: null };
      elSec.classList.toggle('selected', key === this.selectedKey);
      elSec.title = 'Click to start the next agent in this group';
      // The title row is the handle for dragging the whole panel.
      head.title = 'Drag to move this group';
      head.addEventListener('pointerdown', e => this.pressGroup(e, sec));
      elSec.addEventListener('click', e => {
        if (this.justDragged || e.target.closest('.hub-tile, button')) return;
        // Ctrl+click on a panel selects all its agents (or none, when all were).
        if (e.ctrlKey || e.metaKey) {
          const ids = [...this.tiles].filter(([, t]) => t.el.parentNode === grid && !t.removing).map(([id]) => id);
          const all = ids.every(id => this.selected.has(id));
          for (const id of ids) this.toggleSelected(id, !all, false);
          this.onSelect?.([...this.selected]);
          return;
        }
        if (sec.cwd) this.onPickGroup?.(sec.groupKey || null, sec.cwd);
      });
      remove.onclick = e => {
        e.stopPropagation();
        const ids = [...this.tiles].filter(([, t]) => t.el.parentNode === grid && !t.removing).map(([id]) => id);
        if (ids.length) this.onRemoveGroup?.(ids);
      };
      this.sections.set(key, sec);
    }
    return sec;
  }

  // The container of a repository: its name, how many agents it has, the
  // Unity button, and its category panels below.
  repoBox(name) {
    let repo = this.repos.get(name);
    if (repo) return repo;
    const box = el('div', 'hub-repo');
    const head = el('div', 'hub-repo-head');
    const title = el('span', 'hub-repo-name', name || 'No folder');
    // The branch its working copy is on (git or svn), when known.
    const branch = el('span', 'hub-repo-branch hidden');
    const count = el('span', 'hub-repo-count');
    const unity = el('button', 'section-unity hidden');
    unity.type = 'button';
    unity.onclick = e => { e.stopPropagation(); if (repo.cwd) this.onOpenUnity?.(repo.cwd); };
    // An SVN working copy, with TactileSVN installed: open or focus it there.
    const tsvn = el('button', 'section-unity repo-tsvn hidden');
    tsvn.type = 'button';
    tsvn.onclick = e => { e.stopPropagation(); if (repo.svnCwd) this.onOpenTactileSvn?.(repo.svnCwd); };
    head.append(title, branch, count, unity, tsvn);
    const body = el('div', 'hub-repo-body');
    box.append(head, body);
    this.grid.appendChild(box);
    repo = { name, el: box, title, branch, count, unity, tsvn, body, cwds: [], cwd: null, svnCwd: null };
    // Drag a repository by its title row to put it before or after the others.
    head.addEventListener('pointerdown', e => this.pressGroup(e, repo));
    this.repos.set(name, repo);
    return repo;
  }

  // The TactileSVN buttons of the repositories: states maps a folder to what
  // window.deck.tactileSvnStatus says about it ({ available, root }).
  setTactileSvn(states) {
    this.svnStates = states;
    for (const repo of this.repos.values()) {
      repo.svnCwd = (repo.cwds || []).find(c => states.get(c)?.available) || null;
      repo.tsvn.classList.toggle('hidden', !repo.svnCwd);
      if (!repo.svnCwd) continue;
      repo.tsvn.innerHTML = `${TSVN_ICON}<span>TactileSVN</span>`;
      repo.tsvn.title = `Show ${states.get(repo.svnCwd).root} in TactileSVN (brings its window to the front when it is open)`;
    }
  }

  // The Unity buttons of the groups: states maps a folder to what
  // window.deck.unityStatus says about it ({ unity, running, version }).
  setUnity(states) {
    // Each panel's own button stays hidden: the repository's title row has it.
    for (const sec of this.sections.values()) sec.unity.classList.add('hidden');
    this.unityStates = states;
    // The repository's button opens the first of its folders that is a Unity project.
    for (const sec of this.repos.values()) {
      sec.cwd = (sec.cwds || []).find(c => states.get(c)?.unity) || null;
      const st = sec.cwd ? states.get(sec.cwd) : null;
      sec.unity.classList.toggle('hidden', !st?.unity);
      if (!st?.unity) continue;
      sec.unity.innerHTML = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M8 1.5 14 5v6l-6 3.5L2 11V5z"/><path d="M8 8v6.5M8 8l6-3M8 8 2 5"/></svg><span>${st.running ? 'Focus Unity' : 'Open Unity'}</span>`;
      sec.unity.classList.toggle('running', !!st.running);
      sec.unity.title = st.running ? 'Bring this project\'s Unity Editor to the front' : `Open this project in Unity${st.version ? ' ' + st.version : ''}`;
    }
  }

  // Outlines the panel the message box points at (key: Category id + "\n" + repository).
  markSelected(key) {
    this.selectedKey = key;
    for (const sec of this.sections.values()) sec.el.classList.toggle('selected', sec.key === key);
    this.ensureKeyAgent();
  }

  // ---------- choosing with the keyboard ----------

  // The selected group (where the message box points) always has one agent
  // chosen, outlined on its tile: the one chosen there last, else its first.
  // ← → (and Tab when no agent needs you) choose another in the group, ↑ ↓
  // another group; ↩ in the empty box opens the chosen agent (see app.js).
  groupTiles(sec) {
    return [...this.tiles].filter(([, t]) => t.el.parentNode === sec.grid && !t.removing)
      .sort((a, b) => Number(a[1].el.style.order) - Number(b[1].el.style.order)).map(([id]) => id);
  }

  selectedSection() {
    const sec = this.sections.get(this.selectedKey);
    return sec && !sec.el.classList.contains('hidden') ? sec : null;
  }

  ensureKeyAgent() {
    this.keyAgentBy = this.keyAgentBy || new Map();
    const sec = this.selectedSection();
    const ids = sec ? this.groupTiles(sec) : [];
    if (!ids.includes(this.keyAgentId)) {
      const last = sec && this.keyAgentBy.get(sec.key);
      this.keyAgentId = ids.includes(last) ? last : ids[0] || null;
    }
    if (sec && this.keyAgentId) this.keyAgentBy.set(sec.key, this.keyAgentId);
    for (const [id, t] of this.tiles) t.el.classList.toggle('key-focus', id === this.keyAgentId);
  }

  moveKeyAgent(step) {
    const sec = this.selectedSection();
    if (!sec) return false;
    const ids = this.groupTiles(sec);
    if (!ids.length) return false;
    const at = Math.max(0, ids.indexOf(this.keyAgentId));
    this.keyAgentId = ids[(at + step + ids.length) % ids.length];
    this.ensureKeyAgent();
    this.tiles.get(this.keyAgentId)?.el.scrollIntoView({ block: 'nearest' });
    window.uiSound?.('tick');
    return true;
  }

  // The groups in the order they stand: by repository, then within it.
  orderedSections() {
    const repoOrder = sec => Number(sec.el.closest('.hub-repo')?.style.order || 0);
    return [...this.sections.values()].filter(sec => !sec.el.classList.contains('hidden') && sec.cwd)
      .sort((a, b) => repoOrder(a) - repoOrder(b) || Number(a.el.style.order) - Number(b.el.style.order));
  }

  moveKeyGroup(step) {
    const list = this.orderedSections();
    if (!list.length) return false;
    const at = list.findIndex(sec => sec.key === this.selectedKey);
    const next = list[at < 0 ? (step > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, at + step))];
    if (next.key === this.selectedKey) return false;
    this.onPickGroup?.(next.groupKey || null, next.cwd);
    next.el.scrollIntoView({ block: 'nearest' });
    return true;
  }

  // The tank drains, the tile tips over and shrinks with a puff of
  // particles. Resolves when the animation is over.
  async removeTile(agentId) {
    const entry = this.tiles.get(agentId);
    if (!entry || entry.removing) return;
    entry.removing = true;
    entry.parts.liquid.style.height = '0%';
    entry.el.classList.add('removing');
    await new Promise(r => setTimeout(r, 650));
  }

  // ---------- sorting tiles by dragging them ----------

  // A press on a tile becomes a drag once the mouse has moved a few pixels;
  // a press without moving stays a click.
  press(e, agentId) {
    if (e.button !== 0 || e.target.closest('.tile-remove, .tile-stop') || this.drag || this.opening) return;
    const entry = this.tiles.get(agentId);
    if (!entry || entry.removing || !entry.el.parentNode) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const move = ev => {
      if (!this.drag) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
        this.startDrag(entry, sx, sy, agentId);
      }
      this.moveDrag(ev);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (this.drag) this.endDrag();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  // Picks the tile up: it leaves the row and follows the mouse, a little
  // bigger and tilted, while a slot keeps its place in the row.
  startDrag(entry, sx, sy, id) {
    const tile = entry.el;
    const grid = tile.parentNode;
    const r = tile.getBoundingClientRect();
    tile.classList.remove('tilt');
    tile.style.removeProperty('--rx');
    tile.style.removeProperty('--ry');
    const byOrder = (a, b) => Number(a.style.order) - Number(b.style.order);
    const row = [...grid.children].filter(c => c.classList.contains('hub-tile') && !c.classList.contains('removing')).sort(byOrder);
    const slot = el('div', 'hub-tile-slot');
    slot.style.height = `${r.height}px`;
    slot.style.order = tile.style.order;
    slot.style.setProperty('--slot', getComputedStyle(tile).getPropertyValue('--c1').trim() || '#6b708c');
    grid.appendChild(slot);
    this.drag = {
      id, tile, grid, slot,
      start: row.indexOf(tile),
      siblings: row.filter(t => t !== tile),
      orders: row.map(t => t.style.order),
      index: row.indexOf(tile),
      offX: sx - r.left,
      offY: sy - r.top,
      lastX: sx,
      centers: new Map(),
    };
    for (const s of this.drag.siblings) {
      const sr = s.getBoundingClientRect();
      this.drag.centers.set(s, sr.left + sr.width / 2);
    }
    Object.assign(tile.style, { position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, margin: '0' });
    tile.classList.add('dragging');
    document.body.classList.add('grabbing');
    this.onDragSound?.('pick');
  }

  moveDrag(ev) {
    const d = this.drag;
    d.tile.style.left = `${ev.clientX - d.offX}px`;
    d.tile.style.top = `${ev.clientY - d.offY}px`;
    // It sways a little with the movement, like something held by its top.
    const sway = Math.max(-7, Math.min(7, (ev.clientX - d.lastX) * 0.6));
    d.lastX = ev.clientX;
    d.tile.style.setProperty('--sway', `${(sway - 1.5).toFixed(1)}deg`);
    // Held a moment over another agent's tank: letting go there pours this
    // agent's result into it (pour()); the tile goes back to its place.
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const over = under?.closest('.tank') ? under.closest('.hub-tile') : null;
    const target = over && over !== d.tile && !over.classList.contains('removing') ? over : null;
    if (target !== d.hover) {
      clearTimeout(d.dwell);
      d.hover?.classList.remove('pour-target');
      d.tile.classList.remove('pouring');
      d.hover = target;
      d.pour = null;
      const toId = target && [...this.tiles].find(([, t]) => t.el === target)?.[0];
      if (toId && this.canPour?.(d.id, toId)) {
        d.dwell = setTimeout(() => {
          d.pour = toId;
          target.classList.add('pour-target');
          d.tile.classList.add('pouring');
          this.onDragSound?.('shift');
        }, 350);
      }
    }
    // The slot goes before the first tile whose middle is right of the mouse.
    const index = d.siblings.filter(s => d.centers.get(s) < ev.clientX).length;
    if (index !== d.index) {
      d.index = index;
      this.placeSlot();
      this.onDragSound?.('shift');
    }
  }

  // Moves the slot to d.index; the tiles around it slide to their new places
  // (they are measured before and after, then animated from old to new).
  placeSlot() {
    const d = this.drag;
    const row = [...d.siblings];
    row.splice(d.index, 0, d.slot);
    const before = new Map(row.map(e => [e, e.getBoundingClientRect()]));
    for (const e of row) for (const a of e.getAnimations()) if (a.id === 'flip') a.cancel();
    row.forEach((e, i) => { e.style.order = d.orders[i]; });
    for (const e of row) {
      const after = e.getBoundingClientRect();
      if (e !== d.slot) d.centers.set(e, after.left + after.width / 2);
      const dx = before.get(e).left - after.left;
      if (Math.abs(dx) < 0.5) continue;
      const a = e.animate([{ transform: `translateX(${dx}px)` }, { transform: 'translateX(0)' }],
        { duration: 320, easing: 'cubic-bezier(.2,.9,.25,1.08)' });
      a.id = 'flip';
    }
  }

  // Drops the tile: it falls into the slot, squashes a little as it lands
  // and settles. Then the new order is saved.
  async endDrag() {
    const d = this.drag;
    clearTimeout(d.dwell);
    d.hover?.classList.remove('pour-target');
    d.tile.classList.remove('pouring');
    // Pouring: the tile goes back where it was first, then pours.
    if (d.pour && d.index !== d.start) {
      d.index = d.start;
      this.placeSlot();
    }
    this.justDragged = true;
    setTimeout(() => { this.justDragged = false; }, 60);
    for (const a of d.slot.getAnimations()) a.cancel();
    const to = d.slot.getBoundingClientRect();
    const from = d.tile.getBoundingClientRect();
    d.tile.classList.remove('dragging');
    d.tile.classList.add('dropping');
    const fall = d.tile.animate([
      { left: `${from.left}px`, top: `${from.top}px`, transform: `scale(1.07) rotate(${d.tile.style.getPropertyValue('--sway') || '-1.5deg'})` },
      { left: `${to.left}px`, top: `${to.top}px`, transform: 'scale(0.96, 0.98) rotate(0deg)', offset: 0.72 },
      { left: `${to.left}px`, top: `${to.top}px`, transform: 'scale(1)' },
    ], { duration: 420, easing: 'cubic-bezier(.35,.0,.25,1)' });
    setTimeout(() => this.onDragSound?.('drop'), 300);
    await fall.finished.catch(() => {});
    d.tile.style.order = d.slot.style.order;
    for (const p of ['position', 'left', 'top', 'width', 'height', 'margin', '--sway']) d.tile.style.removeProperty(p);
    d.tile.classList.remove('dropping');
    document.body.classList.remove('grabbing');
    d.slot.remove();
    this.drag = null;
    const ids = [...d.grid.children]
      .filter(c => c.classList.contains('hub-tile'))
      .sort((a, b) => Number(a.style.order) - Number(b.style.order))
      .map(t => [...this.tiles].find(([, entry]) => entry.el === t)?.[0])
      .filter(Boolean);
    if (d.pour) this.pour(d.id, d.pour);
    else this.onReorder?.(ids);
    if (this.latest) this.render(...this.latest);
  }

  // ---------- fitting the groups to the window ----------

  // Inside a group the tiles share the row's width, so more agents make
  // them narrower. This does the same for the height: when the groups do
  // not fit under each other in the window, every tile gets narrower (and,
  // because the tank keeps its shape, shorter) until they all fit. The
  // tiles never get wider than 240px or narrower than 90px; below that the
  // Hub scrolls. When the tiles get small (under 170px), the groups also
  // tighten their padding and the space between them ("tight"), and they
  // loosen again once there is room for tiles of 215px.
  //
  // A tile's height follows its width: the tank's height is its width times
  // its shape (3/4), plus the fixed parts (padding, title, status). Those are
  // measured on one tile of each group, so the width that fits can be
  // computed at once instead of tried out.
  fitToHeight() {
    const view = this.container;
    if (!view || this.drag || !view.clientHeight || view.classList.contains('hidden')) return;
    const sections = [...this.sections.values()].map(s => s.el).filter(s => !s.classList.contains('hidden') && !s.classList.contains('removing-group'));
    if (!sections.length) return;
    const avail = view.clientHeight - (this.root.offsetHeight - this.grid.offsetHeight);
    const gap = parseFloat(getComputedStyle(this.grid).rowGap) || 0;
    // Per group: its height without the tiles' tanks, the tank's shape, and
    // the widest a tile can be in its row (the row's width shared by its tiles).
    const parts = [];
    // Everything on the board but the tanks: the board's height minus the
    // tank of each panel (a panel's tiles stand in one row).
    let fixed = this.grid.offsetHeight;
    for (const sec of sections) {
      const tiles = [...sec.querySelectorAll('.hub-tile')].filter(t => !t.classList.contains('removing') && !t.classList.contains('dragging'));
      const tank = tiles[0]?.querySelector('.tank');
      if (!tank?.offsetWidth) continue;
      const tile = tiles[0];
      const row = tile.parentNode;
      const rowGap = parseFloat(getComputedStyle(row).columnGap) || 0;
      parts.push({
        shape: tank.offsetHeight / tank.offsetWidth,
        padX: tile.offsetWidth - tank.offsetWidth,
        share: (row.clientWidth - rowGap * (tiles.length - 1)) / tiles.length,
      });
      fixed -= tank.offsetHeight;
    }
    if (!parts.length) return;
    const height = w => fixed + parts.reduce((sum, p) => sum + (Math.min(w, p.share) - p.padX) * p.shape, 0);
    // The widest tile size (90–240px) at which everything fits. A few pixels
    // to spare: a title can wrap onto a second line when the tile gets narrower.
    let lo = 90;
    let hi = 240;
    if (height(hi) <= avail - 8) lo = hi;
    else for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; if (height(mid) <= avail - 8) lo = mid; else hi = mid; }
    const width = Math.round(lo);
    const tight = this.grid.classList.contains('tight');
    // Once it went tight, it stays tight until the window's size or the
    // number of tiles changes: with some layouts the tight padding fits tiles
    // of 215px while the loose padding only fits tiles under 170px, and the
    // padding then flipped every frame.
    const key = `${view.clientWidth}x${view.clientHeight}:${sections.length}:${this.grid.querySelectorAll('.hub-tile').length}`;
    if ((!tight && width < 170) || (tight && width >= 215 && this.tightKey !== key)) {
      if (!tight) this.tightKey = key;
      // The padding changes the measurements: fit again with the new padding.
      this.grid.classList.toggle('tight', !tight);
      requestAnimationFrame(() => this.fitToHeight());
      return;
    }
    if (Math.abs(width - (this.tileMax || 240)) < 2) return;
    this.tileMax = width;
    this.grid.style.setProperty('--tile-max', `${width}px`);
  }

  // ---------- sorting groups by dragging them ----------

  // Like a tile: a press on a panel's title row becomes a drag once the
  // mouse has moved a few pixels. The panel is lifted and follows the mouse
  // up and down, a dashed slot shows where it lands, and the other panels
  // slide out of the way.
  pressGroup(e, sec) {
    if (e.button !== 0 || e.target.closest('button') || this.drag || this.opening) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const move = ev => {
      if (!this.drag) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
        this.startGroupDrag(sec, sy);
      }
      if (this.drag?.kind === 'group') this.moveGroupDrag(ev);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (this.drag?.kind === 'group') this.endGroupDrag();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  startGroupDrag(sec, sy) {
    const panel = sec.el;
    const r = panel.getBoundingClientRect();
    const byOrder = (a, b) => Number(a.style.order) - Number(b.style.order);
    // A panel moves among the panels of its own repository; a repository
    // among the repositories.
    const box = panel.parentNode;
    const kind = panel.classList.contains('hub-repo') ? 'hub-repo' : 'hub-section';
    const list = [...box.children]
      .filter(c => c.classList.contains(kind) && !c.classList.contains('hidden') && !c.classList.contains('removing-group'))
      .sort(byOrder);
    const slot = el('div', 'hub-section-slot');
    slot.style.height = `${r.height}px`;
    slot.style.order = panel.style.order;
    box.appendChild(slot);
    this.drag = {
      kind: 'group', panel, slot, box, isPanel: kind === 'hub-section', target: null,
      siblings: list.filter(p => p !== panel),
      orders: list.map(p => p.style.order),
      index: list.indexOf(panel),
      offY: sy - r.top,
      lastY: sy,
      centers: new Map(),
    };
    for (const s of this.drag.siblings) {
      const sr = s.getBoundingClientRect();
      this.drag.centers.set(s, sr.top + sr.height / 2);
    }
    Object.assign(panel.style, { position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, margin: '0' });
    panel.classList.add('dragging-group');
    document.body.classList.add('grabbing');
    this.onDragSound?.('pick');
  }

  moveGroupDrag(ev) {
    const d = this.drag;
    d.panel.style.top = `${ev.clientY - d.offY}px`;
    // It tilts a little with the movement, like a tray carried by one end.
    const sway = Math.max(-0.35, Math.min(0.35, (ev.clientY - d.lastY) * 0.03));
    d.lastY = ev.clientY;
    d.panel.style.setProperty('--sway', `${sway.toFixed(2)}deg`);
    // A category panel over another repository's container: dropping it
    // there moves the group to that repository (onDropGroup). The container
    // lights up and the slot waits at its end.
    if (d.isPanel) {
      const over = [...this.repos.values()].find(r => {
        if (r.el.classList.contains('hidden') || r.body === d.box) return false;
        const b = r.el.getBoundingClientRect();
        return ev.clientY >= b.top && ev.clientY <= b.bottom && ev.clientX >= b.left && ev.clientX <= b.right;
      }) || null;
      if (over !== d.target) {
        d.target?.el.classList.remove('drop-target');
        d.target = over;
        if (over) {
          over.el.classList.add('drop-target');
          d.slot.style.order = '9999';
          over.body.appendChild(d.slot);
        } else {
          d.box.appendChild(d.slot);
          this.placeGroupSlot();
        }
        this.onDragSound?.('shift');
      }
      if (over) return;
    }
    // The slot goes before the first panel whose middle is below the mouse.
    const index = d.siblings.filter(s => d.centers.get(s) < ev.clientY).length;
    if (index !== d.index) {
      d.index = index;
      this.placeGroupSlot();
      this.onDragSound?.('shift');
    }
  }

  // Moves the slot to d.index; the panels around it slide to their new
  // places (measured before and after, then animated from old to new).
  placeGroupSlot() {
    const d = this.drag;
    const list = [...d.siblings];
    list.splice(d.index, 0, d.slot);
    const before = new Map(list.map(e => [e, e.getBoundingClientRect()]));
    for (const e of list) for (const a of e.getAnimations()) if (a.id === 'flip') a.cancel();
    list.forEach((e, i) => { e.style.order = d.orders[i]; });
    for (const e of list) {
      const after = e.getBoundingClientRect();
      if (e !== d.slot) d.centers.set(e, after.top + after.height / 2);
      const dy = before.get(e).top - after.top;
      if (Math.abs(dy) < 0.5) continue;
      const a = e.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }],
        { duration: 340, easing: 'cubic-bezier(.2,.9,.25,1.06)' });
      a.id = 'flip';
    }
  }

  // Drops the panel into the slot, where it settles; then the new order of
  // the groups is saved (onReorderGroups).
  async endGroupDrag() {
    const d = this.drag;
    this.justDragged = true;
    setTimeout(() => { this.justDragged = false; }, 60);
    for (const a of d.slot.getAnimations()) a.cancel();
    const to = d.slot.getBoundingClientRect();
    const from = d.panel.getBoundingClientRect();
    d.panel.classList.remove('dragging-group');
    d.panel.classList.add('dropping-group');
    const fall = d.panel.animate([
      { top: `${from.top}px`, transform: `scale(1.015) rotate(${d.panel.style.getPropertyValue('--sway') || '0deg'})` },
      { top: `${to.top}px`, transform: 'scale(0.995, 0.99) rotate(0deg)', offset: 0.75 },
      { top: `${to.top}px`, transform: 'scale(1)' },
    ], { duration: 380, easing: 'cubic-bezier(.35,.0,.25,1)' });
    setTimeout(() => this.onDragSound?.('drop'), 260);
    await fall.finished.catch(() => {});
    const target = d.target;
    if (!target) d.panel.style.order = d.slot.style.order;
    for (const p of ['position', 'left', 'top', 'width', 'margin', '--sway']) d.panel.style.removeProperty(p);
    d.panel.classList.remove('dropping-group');
    document.body.classList.remove('grabbing');
    d.slot.remove();
    this.drag = null;
    // Dropped on another repository: its agents move there (moveGroupTo in
    // app.js); the panel follows them into that container.
    if (target) {
      target.el.classList.remove('drop-target');
      const sec = [...this.sections.values()].find(x => x.el === d.panel);
      if (sec) {
        const ids = [...this.tiles].filter(([, t]) => t.el.parentNode === sec.grid && !t.removing).map(([id]) => id);
        this.onDropGroup?.(ids, sec.cwd, sec.groupKey || null, target.cwds || []);
      }
      if (this.latest) this.render(...this.latest);
      return;
    }
    // The panels in their repositories' order, then their own.
    const repoOrder = s => Number(s.el.closest('.hub-repo')?.style.order || 0);
    const keys = [...this.sections.values()]
      .filter(s => !s.el.classList.contains('hidden'))
      .sort((a, b) => repoOrder(a) - repoOrder(b) || Number(a.el.style.order) - Number(b.el.style.order))
      .map(s => s.key);
    this.onReorderGroups?.(keys);
    if (this.latest) this.render(...this.latest);
  }

  // Removes a whole group: its tiles drop out one after another, left to
  // right, then the panel folds shut. Resolves when it is gone.
  async removeGroup(agentIds) {
    const entries = agentIds.map(id => this.tiles.get(id)).filter(Boolean);
    if (!entries.length) return;
    const sec = [...this.sections.values()].find(s => s.grid.contains(entries[0].el));
    sec?.el.classList.add('removing-group');
    const STAGGER = 90;
    entries.forEach((entry, i) => setTimeout(() => {
      entry.removing = true;
      entry.parts.liquid.style.height = '0%';
      entry.el.classList.add('removing');
    }, i * STAGGER));
    await new Promise(r => setTimeout(r, (entries.length - 1) * STAGGER + 600));
    if (!sec) return;
    const fold = sec.el.animate([
      { height: `${sec.el.offsetHeight}px`, opacity: 1, transform: 'none' },
      { height: '0px', paddingTop: '0px', paddingBottom: '0px', opacity: 0, transform: 'scaleX(0.96)' },
    ], { duration: 320, easing: 'cubic-bezier(.5,0,.75,0)', fill: 'forwards' });
    await fold.finished.catch(() => {});
    // The panel stays hidden until a new agent lands in it again.
    sec.el.classList.add('hidden');
    sec.el.classList.remove('removing-group');
    fold.cancel();
  }

  // hint: { count, name, color } for the Tab button in the header, or null.
  // Renames a tile in place: its title becomes a text field. Enter or a click
  // elsewhere keeps the name, Esc keeps the old one. done(name or null).
  renameTile(agentId, current, done) {
    const entry = this.tiles.get(agentId);
    if (!entry || entry.renaming) return;
    entry.renaming = true;
    const input = document.createElement('input');
    input.className = 'hub-rename';
    input.value = current;
    input.maxLength = 80;
    input.placeholder = 'Name this agent';
    entry.parts.title.replaceChildren(input);
    input.focus();
    input.select();
    let finished = false;
    const finish = keep => {
      if (finished) return;
      finished = true;
      entry.renaming = false;
      done(keep ? input.value.trim() : null);
    };
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    // A click in the field stays in it (a click on the tile opens the agent).
    for (const ev of ['mousedown', 'click', 'dblclick', 'pointerdown']) input.addEventListener(ev, e => e.stopPropagation());
  }

  setTabHint(hint) {
    this.tabHint.classList.toggle('hidden', !hint);
    if (!hint) return;
    this.tabHint.style.setProperty('--next', hint.color);
    this.tabHintText.textContent = `to check ${hint.count} agent${hint.count === 1 ? '' : 's'} ·`;
    this.tabHintName.textContent = hint.name;
    this.tabHint.title = `Press Tab to open "${hint.name}" first`;
  }

  updateTimer(agent, node) {
    // A tile waiting for the usage limit says when it continues instead.
    if (agent.limited || agent.authWait) { node.textContent = ''; return; }
    const started = agent.transcript.turnStartedAt;
    if (started && ['working', 'waiting', 'starting', 'stuck'].includes(agent.status)) {
      node.textContent = formatDuration(Date.now() - started);
    } else if (agent.status === 'idle' && agent.transcript.lastTurn) {
      node.textContent = formatDuration(agent.transcript.lastTurn.durationMs);
    } else {
      node.textContent = '';
    }
  }

  // Only the timers change every second.
  tick(agents) {
    for (const agent of agents) {
      const entry = this.tiles.get(agent.id);
      if (entry) this.updateTimer(agent, entry.parts.timer);
    }
    // The "resets in" times count down once a minute.
    const minute = Math.floor(Date.now() / 60000);
    if (minute !== this.usageMinute) {
      this.usageMinute = minute;
      this.renderUsage();
    }
  }

  // Call before the agent's tile exists: its tile will grow out of the
  // message box at rect (with the typed text) instead of springing in.
  expectArrival(agentId, rect, text) {
    this.arrivals.set(agentId, { rect, text });
  }

  // The message box lifts, shrinks to the size of a tank while the text fades
  // and the liquid starts to fill, then flies to the tile's place in the grid.
  // Resolves once a new tile stands where it stays: no repository is
  // sliding, and its place did not change between two looks 80 ms apart.
  // Its repository's name can arrive a moment after the tile (see repoName
  // in app.js), which moves the tile to another container. At most 1.5 s.
  async whenStill(tile) {
    const until = performance.now() + 1500;
    const wait = ms => new Promise(r => setTimeout(r, ms));
    await new Promise(r => requestAnimationFrame(r));
    let last = null;
    let same = 0;
    while (performance.now() < until) {
      const slide = (this.repoSlideUntil || 0) - performance.now();
      if (slide > 0) { await wait(slide); last = null; same = 0; continue; }
      const r = tile.getBoundingClientRect();
      const at = `${Math.round(r.left)},${Math.round(r.top)}`;
      if (at === last && ++same >= 2) return;
      if (at !== last) same = 0;
      last = at;
      await wait(80);
    }
  }

  async morph(entry, { rect: from, text }) {
    const tile = entry.el;
    // Without a visible Hub there is nowhere to fly to.
    if (!tile.offsetParent) {
      tile.classList.remove('arriving');
      return;
    }
    tile.scrollIntoView({ block: 'nearest' });
    const to = tile.querySelector('.tank').getBoundingClientRect();

    const ghost = el('div', 'zoom-ghost morph-ghost state-starting');
    const label = el('div', 'morph-text', text);
    const liquid = el('div', 'liquid');
    ghost.append(liquid, label);
    Object.assign(ghost.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
    document.body.appendChild(ghost);

    const lift = {
      left: from.left + (from.width - to.width) / 2,
      top: Math.max(to.top + 40, from.top - to.height - 30),
    };
    const duration = 950;
    const box = r => ({ left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    const flight = ghost.animate([
      { ...box(from), borderRadius: '12px', backgroundColor: '#221c16', borderColor: '#e9a23b', easing: 'cubic-bezier(.3,0,.2,1)' },
      { ...box({ ...lift, width: to.width, height: to.height }), borderRadius: '14px 14px 22px 22px', backgroundColor: '#120e0b', borderColor: '#3a3027', offset: 0.38, easing: 'cubic-bezier(.55,0,.25,1)' },
      { ...box(to), borderRadius: '14px 14px 22px 22px', backgroundColor: '#120e0b', borderColor: '#3a3027' },
    ], { duration, fill: 'forwards' });
    label.animate([{ opacity: 1 }, { opacity: 0, offset: 0.3 }, { opacity: 0 }], { duration, fill: 'forwards' });
    liquid.animate([{ height: '0%' }, { height: '0%', offset: 0.25 }, { height: `${Math.max(entry.level, 22)}%` }], { duration, fill: 'forwards', easing: 'ease-out' });
    await flight.finished.catch(() => {});

    tile.classList.remove('arriving');
    this.replay(tile, 'landed', 600);
    this.onLanded?.(entry);
    await ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, fill: 'forwards' }).finished.catch(() => {});
    ghost.remove();
  }

  // "Back to work": the tile hops and its tank flashes when you send a
  // follow-up message to an agent.
  wake(agentId) {
    const entry = this.tiles.get(agentId);
    if (!entry) return;
    // The hop replaces the small wobble of the state change.
    entry.el.classList.remove('wob');
    this.replay(entry.el, 'wake', 900);
  }

  // A copy of a tile, fixed on top of everything, for the animations below.
  tileCopy(entry, rect) {
    const copy = entry.el.cloneNode(true);
    // No pulse or glow on the copy: only the moving card should catch the eye.
    copy.classList.remove('spawn', 'landed', 'wake', 'celebrate', 'current', 'opening', 'unread');
    copy.classList.add('tile-lid');
    Object.assign(copy.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    document.body.appendChild(copy);
    return copy;
  }

  // The chat shrunk evenly to fit inside a tile, centered in it, as a
  // transform relative to the chat area. Also returns the scale.
  static thumb(tile, area) {
    const scale = (tile.width - 16) / area.width;
    const x = tile.left + (tile.width - area.width * scale) / 2 - area.left;
    const y = tile.top + (tile.height - area.height * scale) / 2 - area.top;
    return { transform: `translate(${x}px, ${y}px) scale(${scale})`, scale };
  }

  // While it animates, the chat sits above the tile copy, scales from its top
  // left corner and has its own background.
  static liftView(view, on) {
    if (!view) return;
    Object.assign(view.style, on
      ? { zIndex: '60', transformOrigin: '0 0', background: 'var(--bg)' }
      : { zIndex: '', transformOrigin: '', background: '' });
  }

  // Moves and scales the tile's rectangle `from` onto the rectangle `to`.
  static cover(from, to) {
    return `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width}, ${to.height / from.height})`;
  }

  // Clicking a tile: its tank and text fade away and the agent's chat
  // appears inside it, shrunk to fit. Then, in one smooth movement, the tile
  // and the chat inside it grow until the chat fills the window, while the
  // Hub fades out underneath.
  async open(agentId) {
    const entry = this.tiles.get(agentId);
    const area = document.getElementById('views');
    const hubView = document.getElementById('hub-view');
    if (!entry || !area || this.opening) {
      this.onOpen(agentId);
      return;
    }
    this.opening = true;
    const from = entry.el.getBoundingClientRect();
    const to = area.getBoundingClientRect();
    const copy = this.tileCopy(entry, from);
    entry.el.classList.add('opening');

    const view = await this.onOpen(agentId);
    // Keep the Hub underneath while the chat grows over it.
    hubView.classList.remove('hidden');
    const thumb = Hub.thumb(from, to);
    Hub.liftView(view, true);

    const timing = { duration: 420, easing: 'cubic-bezier(.35,0,.15,1)', fill: 'forwards' };
    const runs = [
      copy.animate([
        { transform: 'none', opacity: 1 },
        { opacity: 1, offset: 0.8 },
        { transform: Hub.cover(from, to), opacity: 0 },
      ], timing),
      copy.querySelector('.hub-info')?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 100, fill: 'forwards' }),
      copy.querySelector('.tank')?.animate(
        [{ transform: 'perspective(700px) rotateX(0deg)' }, { transform: 'perspective(700px) rotateX(-75deg)' }],
        { duration: 220, easing: 'ease-in', fill: 'forwards' },
      ),
      // The colored tank is gone while the copy is still about tile size,
      // so its color never fills the window.
      copy.querySelector('.tank')?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'ease-out', fill: 'forwards' }),
      view?.animate([
        { transform: thumb.transform, clipPath: `inset(0px 0px 0px 0px round ${12 / thumb.scale}px)`, opacity: 0 },
        { opacity: 1, offset: 0.12 },
        { transform: 'none', clipPath: 'inset(0px 0px 0px 0px round 0px)', opacity: 1 },
      ], timing),
      hubView.animate([{ opacity: 1 }, { opacity: 0 }], timing),
    ];
    await Promise.all(runs.map(a => a?.finished.catch(() => {})));

    // The chat is on screen now; the Hub goes back to hidden.
    if (view && !view.classList.contains('hidden')) hubView.classList.add('hidden');
    for (const a of runs) a?.cancel();
    Hub.liftView(view, false);
    copy.remove();
    entry.el.classList.remove('opening');
    this.opening = false;
  }

  // Going back, the exact reverse: the chat shrinks with the tile until it
  // fits inside it, then the tile's tank and text come back, and the Hub
  // fades in underneath. `view` is the chat that was on screen. Call
  // it right after the Hub is shown again.
  //
  // Until the tile is fully back, the tiles do not change: a message you just
  // sent changes the agent to "working", and its tile would wobble and refill
  // under the shrinking chat. onSettled runs once it is over, right before the
  // tiles catch up.
  async returnTo(agentId, view, { onSettled } = {}) {
    const entry = this.tiles.get(agentId);
    const area = document.getElementById('views');
    if (!entry || !area || this.opening) { onSettled?.(); return; }
    this.holding = true;
    entry.el.scrollIntoView({ block: 'nearest' });
    const full = area.getBoundingClientRect();
    const home = entry.el.getBoundingClientRect();
    this.opening = true;
    entry.el.classList.add('opening');
    const copy = this.tileCopy(entry, home);
    // The chat stays on top of the Hub while it shrinks.
    view?.classList.remove('hidden');
    const thumb = Hub.thumb(home, full);
    Hub.liftView(view, true);

    const timing = { duration: 420, easing: 'cubic-bezier(.35,0,.15,1)', fill: 'forwards' };
    const runs = [
      copy.animate([
        { transform: Hub.cover(home, full), opacity: 0 },
        { opacity: 1, offset: 0.2 },
        { transform: 'none', opacity: 1 },
      ], timing),
      copy.querySelector('.hub-info')?.animate([{ opacity: 0 }, { opacity: 0, offset: 0.75 }, { opacity: 1 }], { duration: 420, fill: 'forwards' }),
      copy.querySelector('.tank')?.animate(
        [{ transform: 'perspective(700px) rotateX(-75deg)' }, { transform: 'perspective(700px) rotateX(0deg)' }],
        { duration: 220, delay: 200, easing: 'ease-out', fill: 'forwards' },
      ),
      // The colored tank appears only when the copy is almost back to tile size.
      copy.querySelector('.tank')?.animate([{ opacity: 0 }, { opacity: 0, offset: 0.7 }, { opacity: 1 }], { duration: 420, fill: 'forwards' }),
      view?.animate([
        { transform: 'none', clipPath: 'inset(0px 0px 0px 0px round 0px)', opacity: 1 },
        { opacity: 1, offset: 0.85 },
        { transform: thumb.transform, clipPath: `inset(0px 0px 0px 0px round ${12 / thumb.scale}px)`, opacity: 0 },
      ], timing),
      document.getElementById('hub-view').animate([{ opacity: 0 }, { opacity: 1 }], timing),
    ];
    await Promise.all(runs.map(a => a?.finished.catch(() => {})));

    // Unless you opened something else in the meantime, the chat goes back to hidden.
    if (!document.getElementById('hub-view').classList.contains('hidden')) view?.classList.add('hidden');
    for (const a of runs) a?.cancel();
    Hub.liftView(view, false);
    // The copy is a still picture of the tile; the tile itself is moving
    // (liquid, glow, float). Instead of swapping one for the other, the tile
    // fades in under the copy while the copy fades out, so the motion eases in.
    entry.el.classList.remove('opening');
    entry.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: 'ease-out' });
    copy.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 320, easing: 'ease-in', fill: 'forwards' })
      .finished.catch(() => {}).then(() => {
        copy.remove();
        this.holding = false;
        onSettled?.();
        if (this.latest) this.update(...this.latest);
      });
    this.opening = false;
  }

  // Restarts a CSS animation by removing and adding its class.
  replay(node, className, ms) {
    node.classList.remove(className);
    void node.offsetWidth;
    node.classList.add(className);
    setTimeout(() => node.classList.remove(className), ms);
  }
}

window.Hub = Hub;
