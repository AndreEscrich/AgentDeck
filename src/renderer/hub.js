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
  starting: 'Starting',
  working: 'Working',
  waiting: 'Needs you',
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
  constructor(container, { onOpen, onRemove, onRemoveGroup, onContext, onHistory, onSettings, onLanded, onReplay }) {
    this.onOpen = onOpen;
    this.onReplay = onReplay;
    this.onLanded = onLanded;
    this.onRemoveGroup = onRemoveGroup;
    this.onRemove = onRemove;
    this.onContext = onContext;
    this.sections = new Map();       // group id ('' for no group) + repository -> { el, name, repo, count, grid }
    this.tiles = new Map();          // agent id -> { el, parts, status }
    this.arrivals = new Map();       // agent id -> where its message box was, for the morph animation
    this.completed = 0;              // agents that finished a task this session

    this.root = el('div', 'hub');
    const head = el('div', 'hub-head');
    this.counters = el('div', 'hub-counters');
    const historyBtn = el('button', null, 'History');
    historyBtn.title = 'Saved sessions (⌘\\)';
    historyBtn.onclick = onHistory;
    const settingsBtn = el('button', null, 'Settings');
    settingsBtn.onclick = onSettings;
    head.append(el('h2', null, 'Hub'), this.counters, historyBtn, settingsBtn);

    // One section per group, each with its own grid of tiles.
    this.grid = el('div', 'hub-board');
    this.empty = el('div', 'hub-empty');
    this.empty.append(el('div', 'hub-empty-tank'), el('p', null, 'No agents yet. Describe a task in the box below to start one.'));

    this.root.append(head, this.grid, this.empty);
    container.appendChild(this.root);
  }

  createTile(agent) {
    // A new tile springs in, or, when it was started from the Hub's message
    // box, stays hidden until the box has morphed into it (see morph()).
    const arrival = this.arrivals.get(agent.id);
    this.arrivals.delete(agent.id);
    const tile = el('div', arrival ? 'hub-tile arriving' : 'hub-tile spawn');
    // Where in its breathing and floating the tile starts (see styles.css).
    tile.style.setProperty('--phase', `-${(Math.random() * 5).toFixed(2)}s`);
    tile.addEventListener('animationend', e => { if (e.animationName === 'spawn') tile.classList.remove('spawn'); });
    tile.onclick = () => this.open(agent.id);
    tile.oncontextmenu = e => { e.preventDefault(); this.onContext?.(agent.id); };
    const remove = el('button', 'tile-remove', '×');
    remove.title = 'Remove from the Hub';
    remove.onclick = e => { e.stopPropagation(); this.onRemove?.(agent.id); };

    const tank = el('div', 'tank');
    const liquid = el('div', 'liquid');
    const bubbles = el('div', 'bubbles');
    for (let i = 0; i < BUBBLE_COUNT; i++) {
      const b = el('span');
      b.style.setProperty('--x', `${10 + Math.random() * 80}%`);
      b.style.setProperty('--d', `${(Math.random() * 2.4).toFixed(2)}s`);
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

    tile.append(remove, tank, info);
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
    // While the app is in the background (or replaying), the tiles keep the
    // state you last saw; thaw() catches them up.
    if (this.frozen || this.replaying) return;
    this.render(agents, currentId, groups);
  }

  // The app went to the background: tiles stop changing until thaw().
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
    const seen = new Set();
    const counts = new Map();
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
      const grid = this.section(key, groupKey, agent.repo || '').grid;
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
        if (agent.status === 'idle' && ['working', 'waiting', 'starting'].includes(before)) {
          this.completed++;
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
      this.updateTimer(agent, parts.timer);
    }

    for (const [id, entry] of this.tiles) {
      if (!seen.has(id)) {
        entry.el.remove();
        this.tiles.delete(id);
      }
    }

    // A panel is a Group: one Category plus one folder; its agents share
    // context. Panels follow your Category order ("No category" last), and within a Category the
    // repository names in alphabetical order. Empty panels hide.
    const groupOrder = [...groups.map(g => g.id), ''];
    const rank = sec => {
      const i = groupOrder.indexOf(sec.groupKey);
      return i < 0 ? groupOrder.length : i;
    };
    const sorted = [...this.sections.values()].sort((a, b) => rank(a) - rank(b) || a.repo.localeCompare(b.repo));
    sorted.forEach((sec, i) => {
      const n = counts.get(sec.key) || 0;
      sec.el.classList.toggle('hidden', !n);
      sec.count.textContent = String(n);
      sec.name.textContent = sec.groupKey ? groups.find(g => g.id === sec.groupKey)?.name || 'Category' : 'No category';
      sec.repoEl.textContent = sec.repo;
      sec.el.style.order = String(i);
    });

    const count = s => agents.filter(a => a.status === s).length;
    const parts = [];
    if (count('working') + count('starting')) parts.push(`<b>${count('working') + count('starting')}</b> working`);
    if (count('waiting')) parts.push(`<b class="attn">${count('waiting')}</b> need${count('waiting') === 1 ? 's' : ''} you`);
    if (count('idle')) parts.push(`<b class="ok">${count('idle')}</b> completed`);
    parts.push(`<b>${this.completed}</b> task${this.completed === 1 ? '' : 's'} done this session`);
    this.counters.innerHTML = parts.join('<span class="sep">·</span>');

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
      sec = { key, groupKey, repo, el: elSec, name, repoEl, count, grid };
      remove.onclick = e => {
        e.stopPropagation();
        const ids = [...this.tiles].filter(([, t]) => t.el.parentNode === grid && !t.removing).map(([id]) => id);
        if (ids.length) this.onRemoveGroup?.(ids);
      };
      this.sections.set(key, sec);
    }
    return sec;
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

  updateTimer(agent, node) {
    const started = agent.transcript.turnStartedAt;
    if (started && (agent.status === 'working' || agent.status === 'waiting' || agent.status === 'starting')) {
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
      { ...box(from), borderRadius: '12px', backgroundColor: '#1e2028', borderColor: '#d97757', easing: 'cubic-bezier(.3,0,.2,1)' },
      { ...box({ ...lift, width: to.width, height: to.height }), borderRadius: '14px 14px 22px 22px', backgroundColor: '#0f1016', borderColor: '#2c2f3d', offset: 0.38, easing: 'cubic-bezier(.55,0,.25,1)' },
      { ...box(to), borderRadius: '14px 14px 22px 22px', backgroundColor: '#0f1016', borderColor: '#2c2f3d' },
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
    copy.remove();
    entry.el.classList.remove('opening');
    this.replay(entry.el, 'landed', 600);
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
