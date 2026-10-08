// The Hub: one tile per running agent. Each tile has a glass tank whose
// liquid color shows the agent's state:
//   starting: blue, the tank fills up
//   working: amber, waves and rising bubbles; the level climbs with each step
//   waiting: orange, the tank pulses and a "!" badge bounces (needs approval)
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
  constructor(container, { onOpen, onRemove, onContext, onHistory, onSettings }) {
    this.onOpen = onOpen;
    this.onRemove = onRemove;
    this.onContext = onContext;
    this.sections = new Map();       // group id ('' for no group) -> { el, name, count, grid }
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
    tank.append(liquid, bubbles, el('div', 'tank-shine'), icon, badge, burst);

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
    const entry = { el: tile, status: null, fresh: true, level: 0, arrival, parts: { liquid, icon, title, statusDot, statusText, timer } };
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

  // groups: [{ id, name }] in display order. Each agent has a groupId (or null).
  update(agents, currentId, groups = []) {
    const seen = new Set();
    const counts = new Map();
    let order = 0;
    for (const agent of agents) {
      seen.add(agent.id);
      const entry = this.tiles.get(agent.id) || this.createTile(agent);
      if (entry.removing) continue;
      const { el: tile, parts } = entry;
      tile.style.order = String(order++);
      const key = groups.some(g => g.id === agent.groupId) ? agent.groupId : '';
      counts.set(key, (counts.get(key) || 0) + 1);
      const grid = this.section(key, groups).grid;
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
      parts.title.textContent = agent.title;
      parts.title.title = `${agent.title}\n${agent.cwd}`;
      parts.statusDot.className = `dot ${agent.status}`;
      parts.statusText.textContent = HUB_STATUS_TEXT[agent.status] || agent.status;
      this.updateTimer(agent, parts.timer);
    }

    for (const [id, entry] of this.tiles) {
      if (!seen.has(id)) {
        entry.el.remove();
        this.tiles.delete(id);
      }
    }

    // Sections follow your group order, "No group" last; empty ones hide.
    const keys = [...groups.map(g => g.id), ''];
    for (const [key, sec] of this.sections) {
      const n = counts.get(key) || 0;
      sec.el.classList.toggle('hidden', !n);
      sec.count.textContent = String(n);
      sec.name.textContent = key ? groups.find(g => g.id === key)?.name || 'Group' : 'No group';
      sec.el.style.order = String(keys.indexOf(key) < 0 ? keys.length : keys.indexOf(key));
    }

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

  section(key, groups) {
    let sec = this.sections.get(key);
    if (!sec) {
      const elSec = el('section', 'hub-section');
      const head = el('div', 'hub-section-head');
      const name = el('span', 'hub-section-name');
      const count = el('span', 'hub-section-count');
      head.append(name, count);
      const grid = el('div', 'hub-grid');
      elSec.append(head, grid);
      this.grid.appendChild(elSec);
      sec = { el: elSec, name, count, grid };
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
    await ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, fill: 'forwards' }).finished.catch(() => {});
    ghost.remove();
  }

  // "Back to work": the tile hops and its tank flashes when you send a
  // follow-up message to an agent.
  wake(agentId) {
    const entry = this.tiles.get(agentId);
    if (entry) this.replay(entry.el, 'wake', 900);
  }

  // Where an opening tile pauses: in the middle of the chat area, about 1.5
  // times its size. Returns the rectangle and the scale.
  middleRect(tile, area) {
    const scale = Math.max(1.15, Math.min(1.6, (area.width * 0.4) / tile.width));
    const width = tile.width * scale;
    const height = tile.height * scale;
    return {
      scale,
      left: area.left + (area.width - width) / 2,
      top: area.top + (area.height - height) / 2,
      width,
      height,
    };
  }

  // A copy of a tile, fixed on top of everything, for the animations below.
  tileCopy(entry, rect) {
    const copy = entry.el.cloneNode(true);
    copy.classList.remove('spawn', 'landed', 'wake', 'celebrate', 'current', 'opening');
    copy.classList.add('tile-lid');
    Object.assign(copy.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    document.body.appendChild(copy);
    return copy;
  }

  // Clicking a tile morphs it into the agent's chat, in two phases:
  // 1. the tile lifts off, moves to the middle of the chat area and grows,
  //    while its tank flips open upward like a lid and its text fades;
  // 2. the chat grows out of that enlarged tile to the whole area, while the
  //    tile fades into it.
  async open(agentId) {
    const entry = this.tiles.get(agentId);
    const area = document.getElementById('views');
    if (!entry || !area || this.opening) {
      this.onOpen(agentId);
      return;
    }
    this.opening = true;
    const from = entry.el.getBoundingClientRect();
    const to = area.getBoundingClientRect();
    const mid = this.middleRect(from, to);
    const copy = this.tileCopy(entry, from);
    entry.el.classList.add('opening');

    // Phase 1: move and grow (transform keeps the tile's proportions).
    const lift = `translate(${mid.left - from.left}px, ${mid.top - from.top}px) scale(${mid.scale})`;
    const move = copy.animate(
      [{ transform: 'none', boxShadow: '0 0 0 rgba(0,0,0,0)' }, { transform: lift, boxShadow: '0 30px 70px rgba(0,0,0,0.6)' }],
      { duration: 240, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'forwards' },
    );
    copy.querySelector('.tank')?.animate(
      [{ transform: 'perspective(700px) rotateX(0deg)', opacity: 1 }, { transform: 'perspective(700px) rotateX(-78deg)', opacity: 0.35 }],
      { duration: 200, delay: 90, easing: 'ease-in', fill: 'forwards' },
    );
    copy.querySelector('.hub-info')?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, delay: 80, fill: 'forwards' });
    await move.finished.catch(() => {});

    // Phase 2: the chat grows out of the enlarged tile.
    const view = await this.onOpen(agentId);
    const outline = (r, radius) => `inset(${Math.max(0, r.top - to.top)}px ${Math.max(0, to.right - r.left - r.width)}px ${Math.max(0, to.bottom - r.top - r.height)}px ${Math.max(0, r.left - to.left)}px round ${radius}px)`;
    const grow = view?.animate(
      [{ clipPath: outline(mid, 16 * mid.scale), opacity: 0.35 }, { clipPath: 'inset(0px 0px 0px 0px round 0px)', opacity: 1 }],
      { duration: 280, easing: 'cubic-bezier(.2,.8,.2,1)' },
    );
    const fade = copy.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: 'ease-out', fill: 'forwards' });
    await Promise.all([grow?.finished, fade.finished].map(p => p?.catch(() => {})));
    copy.remove();
    entry.el.classList.remove('opening');
    this.opening = false;
  }

  // Going back: the reverse. A dark panel the size of the chat area shrinks
  // to an enlarged tile in the middle, turns into the tile with its lid
  // closing, and the tile flies back to its place and settles. Call it after
  // the Hub is visible again.
  async returnTo(agentId) {
    const entry = this.tiles.get(agentId);
    const area = document.getElementById('views');
    if (!entry || !area || this.opening) return;
    entry.el.scrollIntoView({ block: 'nearest' });
    const full = area.getBoundingClientRect();
    const home = entry.el.getBoundingClientRect();
    const mid = this.middleRect(home, full);
    this.opening = true;
    entry.el.classList.add('opening');

    const box = r => ({ left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    const panel = el('div', 'close-ghost');
    Object.assign(panel.style, box(full));
    document.body.appendChild(panel);
    await panel.animate(
      [{ ...box(full), borderRadius: '0px' }, { ...box(mid), borderRadius: `${16 * mid.scale}px` }],
      { duration: 240, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' },
    ).finished.catch(() => {});

    const copy = this.tileCopy(entry, home);
    const lifted = `translate(${mid.left - home.left}px, ${mid.top - home.top}px) scale(${mid.scale})`;
    panel.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'forwards' });
    copy.querySelector('.tank')?.animate(
      [{ transform: 'perspective(700px) rotateX(-78deg)', opacity: 0.35 }, { transform: 'perspective(700px) rotateX(0deg)', opacity: 1 }],
      { duration: 200, easing: 'ease-out', fill: 'forwards' },
    );
    copy.querySelector('.hub-info')?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 60, fill: 'forwards' });
    await copy.animate(
      [{ transform: lifted, boxShadow: '0 30px 70px rgba(0,0,0,0.6)' }, { transform: 'none', boxShadow: '0 0 0 rgba(0,0,0,0)' }],
      { duration: 260, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'forwards' },
    ).finished.catch(() => {});

    panel.remove();
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
