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

const HUB_STATUS_TEXT = {
  starting: 'Booting up…',
  working: 'Working',
  waiting: 'Needs you',
  stuck: 'Stuck',
  idle: 'Completed',
  error: 'Error',
  exited: 'Stopped',
};

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
  constructor(container, { onOpen, onRemove, onInterrupt, onRemoveGroup, onContext, onLanded, onReplay, onTab, onReorder, onDragSound, onPickGroup }) {
    // Clicking a Group panel (not a tile) points the message box at that Group.
    this.onPickGroup = onPickGroup;
    this.selectedKey = null;
    this.onOpen = onOpen;
    this.onInterrupt = onInterrupt;
    this.onReorder = onReorder;
    this.onDragSound = onDragSound;
    this.onReplay = onReplay;
    this.onLanded = onLanded;
    this.onRemoveGroup = onRemoveGroup;
    this.onRemove = onRemove;
    this.onContext = onContext;
    this.sections = new Map();       // group id ('' for no group) + repository -> { el, name, repo, count, grid }
    this.tiles = new Map();          // agent id -> { el, parts, status }
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

    this.root.append(this.grid, this.empty);

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
      menuItem('Connectors…', 'Jira, Slack, Notion and more for your agents', () => this.onOpenConnectors?.()),
      menuItem('Settings file…', 'Defaults, limits and the claude path', () => this.onOpenSettings?.()),
    );
    // The floating bar on the left edge: the settings button, then Usage.
    const nav = el('nav', 'hub-nav');
    nav.append(this.settingsBtn, this.usageTab);
    this.rail.append(nav, this.usage, this.settingsMenu);
    // A button opens its card, or closes it when it is already open.
    const showPanel = panel => {
      const same = this.rail.classList.contains('open') && this.rail.dataset.panel === panel;
      this.rail.dataset.panel = panel;
      this.rail.classList.toggle('open', !same);
      window.uiSound?.(same ? 'tickDown' : 'tick');
      if (!same && panel === 'usage') this.onOpenUsage?.();
    };
    this.rail.dataset.panel = 'usage';
    this.usageTab.onclick = () => showPanel('usage');
    this.settingsBtn.onclick = () => showPanel('settings');
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
    this.setUsage(null);
  }

  // usage: { limits: rate_limit_info from Claude Code or null, at: when it
  // arrived, tokens: tokens your agents used since the app opened, tasks }.
  setUsage(usage) {
    this.usageData = usage;
    this.renderUsage();
  }

  renderUsage() {
    const u = this.usageData;
    this.renderUsageTab(u?.limits?.unifiedWindows);
    const box = this.usageMain;
    box.textContent = '';
    box.appendChild(el('div', 'usage-title', 'Usage'));
    const windows = u?.limits?.unifiedWindows;
    const meters = [['five_hour', 'Current session', '5-hour limit'], ['seven_day', 'This week', 'all models']];
    if (windows) {
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
        meter.append(top, bar, el('div', 'usage-note', `${note} · resets ${Hub.resetText(w.resetsAt)}`));
        box.appendChild(meter);
      }
      if (u.limits.status && u.limits.status !== 'allowed') box.appendChild(el('div', 'usage-warn', 'Limit reached: agents wait until it resets'));
      const age = Date.now() - (u.at || 0);
      if (age > 10 * 60 * 1000) box.appendChild(el('div', 'usage-note', `as of ${Hub.ago(age)} ago`));
    } else {
      box.appendChild(el('div', 'usage-note', 'Shows your plan limits after an agent\'s first reply.'));
    }
    const tokens = u?.tokens || 0;
    const since = el('div', 'usage-since');
    since.append(el('span', 'usage-label', 'Since Agent Hub opened'),
      el('span', 'usage-big', tokens ? `${formatTokens(tokens)} tokens` : '—'),
      el('span', 'usage-note', `${u?.tasks || 0} task${u?.tasks === 1 ? '' : 's'}`));
    box.appendChild(since);
  }

  // The tab shows the session and the week as two small upright meters,
  // with the session's percentage under them.
  renderUsageTab(windows) {
    const tab = this.usageTab;
    tab.textContent = '';
    const bars = el('div', 'usage-tab-bars');
    for (const key of ['five_hour', 'seven_day']) {
      const pct = windows?.[key] ? Math.max(0, Math.min(100, Math.round((windows[key].utilization || 0) * 100))) : 0;
      const bar = el('span', `usage-tab-bar ${pct >= 90 ? 'high' : pct >= 70 ? 'mid' : 'low'}`);
      const fill = el('span');
      fill.style.height = `${pct}%`;
      bar.appendChild(fill);
      bars.appendChild(bar);
    }
    const session = windows?.five_hour ? `${Math.round((windows.five_hour.utilization || 0) * 100)}%` : '–';
    tab.append(bars, el('span', 'usage-tab-pct', session), el('span', 'usage-tab-label', 'Usage'));
  }

  // "in 2h 05m", "Fri 18:00" for later than a day.
  static resetText(seconds) {
    if (!seconds) return 'later';
    const ms = seconds * 1000 - Date.now();
    if (ms <= 0) return 'now';
    if (ms < 24 * 3600 * 1000) {
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      return h ? `in ${h}h ${String(m).padStart(2, '0')}m` : `in ${m}m`;
    }
    return new Date(seconds * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
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
    const tile = el('div', arrival ? 'hub-tile arriving' : 'hub-tile spawn');
    // Each tile gets its own starting point (--phase), pace (--tempo, 85-120%)
    // and wave position (--wave-delay) for every looping animation, so tiles
    // side by side never move in step (see styles.css).
    tile.style.setProperty('--phase', `-${(Math.random() * 9).toFixed(2)}s`);
    tile.style.setProperty('--tempo', (0.85 + Math.random() * 0.35).toFixed(3));
    tile.style.setProperty('--wave-delay', `-${(Math.random() * 30).toFixed(2)}s`);
    tile.addEventListener('animationend', e => { if (e.animationName === 'spawn') tile.classList.remove('spawn'); });
    // A click opens the agent, unless it was the end of dragging the tile.
    tile.onclick = () => { if (!this.justDragged) this.open(agent.id); };
    tile.addEventListener('pointerdown', e => this.press(e, agent.id));
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
    tank.append(liquid, bubbles, el('div', 'tank-shine'), icon, ping, badge, burst);

    // Under the tank: the task title, then its status and time.
    const info = el('div', 'hub-info');
    const title = el('div', 'hub-title');
    const statusRow = el('div', 'hub-status');
    const statusDot = el('span', 'dot');
    const statusText = el('span');
    const timer = el('span', 'hub-timer');
    statusRow.append(statusDot, statusText, timer);
    info.append(title, statusRow);

    tile.append(remove, stop, tank, info);
    const entry = { el: tile, status: null, fresh: true, level: 0, arrival, parts: { liquid, icon, badge, title, statusDot, statusText, timer } };
    this.tiles.set(agent.id, entry);
    return entry;
  }

  // The liquid level: low while starting, climbing with the step count while
  // working, full when done.
  levelFor(agent) {
    const steps = agent.transcript.stepCount;
    switch (agent.status) {
      case 'starting': return 22;
      case 'working':
      case 'stuck':
      case 'waiting': return Math.min(88, 30 + steps * 4);
      case 'idle': return 100;
      case 'error': return 60;
      default: return 12;
    }
  }

  // groups: [{ id, name }] in display order. Each agent has a groupId (or
  // null) and a repo name; there is one panel per group and repository.
  update(agents, currentId, groups = []) {
    this.latest = [agents, currentId, groups];
    // While the app is minimized (or replaying), the tiles keep the
    // state you last saw; thaw() catches them up.
    if (this.frozen || this.replaying || this.drag) return;
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
      const { el: tile, parts } = entry;
      tile.style.order = String(order++);
      const groupKey = groups.some(g => g.id === agent.groupId) ? agent.groupId : '';
      const key = `${groupKey}\n${agent.repo || ''}`;
      counts.set(key, (counts.get(key) || 0) + 1);
      if (!firstAt.has(key)) firstAt.set(key, order);
      const sec = this.section(key, groupKey, agent.repo || '');
      if (!seenSections.has(sec)) { seenSections.add(sec); sec.cwd = agent.cwd; }
      const grid = sec.grid;
      if (tile.parentNode !== grid) grid.appendChild(tile);
      if (entry.arrival) {
        const info = entry.arrival;
        entry.arrival = null;
        requestAnimationFrame(() => this.morph(entry, info));
      }

      // Play the one-time animations when the state changes.
      const before = entry.status;
      if (before !== agent.status) {
        tile.classList.remove(`state-${before}`);
        tile.classList.add(`state-${agent.status}`);
        if (agent.status === 'idle' && ['working', 'waiting', 'starting', 'stuck'].includes(before)) {
          this.replay(tile, 'celebrate', 1600);
        }
        if (agent.status === 'error' && before) this.replay(tile, 'shake', 700);
        entry.status = agent.status;
      }
      tile.classList.toggle('current', agent.id === currentId);
      tile.classList.toggle('unread', !!agent.unread);

      // A new tank starts empty and fills up, so the browser must draw it
      // empty once before the level changes.
      if (entry.fresh) {
        entry.fresh = false;
        parts.liquid.style.height = '0%';
        void parts.liquid.offsetHeight;
      }
      entry.level = this.levelFor(agent);
      parts.liquid.style.height = `${entry.level}%`;
      parts.icon.textContent = { idle: '✓', error: '✕' }[agent.status] || '';
      // After a follow-up message, the tile shows that message (summarized).
      parts.title.textContent = agent.latestTitle || agent.title;
      parts.title.title = agent.latestPrompt
        ? `${agent.latestPrompt}\n\nTask: ${agent.title}\n${agent.cwd}`
        : `${agent.title}\n${agent.cwd}`;
      parts.statusDot.className = `dot ${agent.status}`;
      parts.statusText.textContent = HUB_STATUS_TEXT[agent.status] || agent.status;
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
        parts.statusText.title = '';
      }
      this.updateTimer(agent, parts.timer);
    }

    for (const [id, entry] of this.tiles) {
      if (!seen.has(id)) {
        entry.el.remove();
        this.tiles.delete(id);
      }
    }

    // A panel is a Group: one Category plus one folder; its agents share
    // context. Panels stand in the order their first agent came (agents
    // arrive in the order they started, see hubItems in app.js), so a new
    // group appears below the others. Empty panels hide.
    const rank = sec => (firstAt.has(sec.key) ? firstAt.get(sec.key) : Infinity);
    const sorted = [...this.sections.values()].sort((a, b) => rank(a) - rank(b));
    sorted.forEach((sec, i) => {
      const n = counts.get(sec.key) || 0;
      sec.el.classList.toggle('hidden', !n);
      sec.count.textContent = String(n);
      sec.name.textContent = sec.groupKey ? groups.find(g => g.id === sec.groupKey)?.name || 'Category' : 'No category';
      sec.repoEl.textContent = sec.repo;
      sec.el.style.order = String(i);
    });

    this.empty.classList.toggle('hidden', agents.length > 0);
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
      const remove = el('button', 'section-remove', '× Remove group');
      remove.title = 'Remove this group and all its agents from the Hub';
      head.append(name, repoEl, count, remove);
      const grid = el('div', 'hub-grid');
      elSec.append(head, grid);
      this.grid.appendChild(elSec);
      sec = { key, groupKey, repo, el: elSec, name, repoEl, count, grid, cwd: null };
      elSec.classList.toggle('selected', key === this.selectedKey);
      elSec.title = 'Click to start the next agent in this group';
      elSec.addEventListener('click', e => {
        if (e.target.closest('.hub-tile, button')) return;
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

  // Outlines the panel the message box points at (key: Category id + "\n" + repository).
  markSelected(key) {
    this.selectedKey = key;
    for (const sec of this.sections.values()) sec.el.classList.toggle('selected', sec.key === key);
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
        this.startDrag(entry, sx, sy);
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
  startDrag(entry, sx, sy) {
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
      tile, grid, slot,
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
    this.onReorder?.(ids);
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
  setTabHint(hint) {
    this.tabHint.classList.toggle('hidden', !hint);
    if (!hint) return;
    this.tabHint.style.setProperty('--next', hint.color);
    this.tabHintText.textContent = `to check ${hint.count} agent${hint.count === 1 ? '' : 's'} ·`;
    this.tabHintName.textContent = hint.name;
    this.tabHint.title = `Press Tab to open "${hint.name}" first`;
  }

  updateTimer(agent, node) {
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
    if (entry) this.replay(entry.el, 'wake', 900);
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
  async returnTo(agentId, view) {
    const entry = this.tiles.get(agentId);
    const area = document.getElementById('views');
    if (!entry || !area || this.opening) return;
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
      .finished.catch(() => {}).then(() => copy.remove());
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
