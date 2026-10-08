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
  idle: 'Done',
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

function folderName(p) {
  return (p || '').split('/').filter(Boolean).pop() || p || '';
}

class Hub {
  // onOpen(agentId) opens an agent's chat and returns its chat element;
  // onNew() opens a new agent.
  constructor(container, { onOpen, onNew }) {
    this.onOpen = onOpen;
    this.tiles = new Map();          // agent id -> { el, parts, status }
    this.arrivals = new Map();       // agent id -> where its message box was, for the morph animation
    this.completed = 0;              // agents that finished a task this session

    this.root = el('div', 'hub');
    const head = el('div', 'hub-head');
    this.counters = el('div', 'hub-counters');
    const newBtn = el('button', 'primary', '+ New agent');
    newBtn.onclick = onNew;
    head.append(el('h2', null, 'Hub'), this.counters, newBtn);

    this.grid = el('div', 'hub-grid');
    this.empty = el('div', 'hub-empty');
    const emptyBtn = el('button', 'primary', '+ Start an agent');
    emptyBtn.onclick = onNew;
    this.empty.append(el('div', 'hub-empty-tank'), el('p', null, 'No agents running.'), emptyBtn);

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

    const info = el('div', 'hub-info');
    const title = el('div', 'hub-title');
    const meta = el('div', 'hub-meta');
    const statusRow = el('div', 'hub-status');
    const statusDot = el('span', 'dot');
    const statusText = el('span');
    const timer = el('span', 'hub-timer');
    statusRow.append(statusDot, statusText, timer);
    const activity = el('div', 'hub-activity');
    const stats = el('div', 'hub-stats');
    info.append(title, meta, statusRow, activity, stats);

    tile.append(tank, info);
    const entry = { el: tile, status: null, fresh: true, level: 0, arrival, parts: { liquid, icon, title, meta, statusDot, statusText, timer, activity, stats } };
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

  update(agents, currentId) {
    const seen = new Set();
    let order = 0;
    for (const agent of agents) {
      seen.add(agent.id);
      const entry = this.tiles.get(agent.id) || this.createTile(agent);
      const { el: tile, parts } = entry;
      tile.style.order = String(order++);
      if (!tile.parentNode) this.grid.appendChild(tile);
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
      parts.icon.textContent = agent.status === 'idle' ? '✓' : agent.status === 'error' ? '✕' : '';
      parts.title.textContent = agent.title;
      parts.title.title = agent.title;
      const model = agent.choice?.model && agent.choice.model !== 'default' ? agent.choice.model : 'default model';
      parts.meta.textContent = `${folderName(agent.cwd)} · ${model}`;
      parts.meta.title = agent.cwd;
      parts.statusDot.className = `dot ${agent.status}`;
      parts.statusText.textContent = HUB_STATUS_TEXT[agent.status] || agent.status;
      parts.activity.textContent = agent.transcript.activity || '';

      const t = agent.transcript;
      const bits = [];
      if (agent.status === 'idle' && t.lastTurn) {
        bits.push(`${t.lastTurn.stepCount} steps`);
        if (t.lastTurn.changedFiles) bits.push(`${t.lastTurn.changedFiles} file${t.lastTurn.changedFiles === 1 ? '' : 's'} changed`);
        if (t.lastTurn.costUsd) bits.push(`$${t.lastTurn.costUsd.toFixed(2)}`);
      } else if (t.stepCount) {
        bits.push(`${t.stepCount} step${t.stepCount === 1 ? '' : 's'}`);
      }
      parts.stats.textContent = bits.join(' · ');
      this.updateTimer(agent, parts.timer);
    }

    for (const [id, entry] of this.tiles) {
      if (!seen.has(id)) {
        entry.el.remove();
        this.tiles.delete(id);
      }
    }

    const count = s => agents.filter(a => a.status === s).length;
    const parts = [];
    if (count('working') + count('starting')) parts.push(`<b>${count('working') + count('starting')}</b> working`);
    if (count('waiting')) parts.push(`<b class="attn">${count('waiting')}</b> need${count('waiting') === 1 ? 's' : ''} you`);
    if (count('idle')) parts.push(`<b class="ok">${count('idle')}</b> waiting for a message`);
    parts.push(`<b>${this.completed}</b> task${this.completed === 1 ? '' : 's'} done this session`);
    this.counters.innerHTML = parts.join('<span class="sep">·</span>');

    this.empty.classList.toggle('hidden', agents.length > 0);
    this.grid.classList.toggle('hidden', agents.length === 0);
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

  // Clicking a tile: its tank grows until it covers the chat area and the
  // liquid rises to the top, then the chat fades in.
  async open(agentId) {
    const entry = this.tiles.get(agentId);
    const target = document.getElementById('views')?.getBoundingClientRect();
    if (!entry || !target || this.opening) {
      this.onOpen(agentId);
      return;
    }
    this.opening = true;
    const tank = entry.el.querySelector('.tank');
    const from = tank.getBoundingClientRect();
    const ghost = el('div', `zoom-ghost state-${entry.status}`);
    const liquid = el('div', 'liquid');
    liquid.style.height = `${entry.level}%`;
    ghost.appendChild(liquid);
    Object.assign(ghost.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
    document.body.appendChild(ghost);
    entry.el.classList.add('opening');

    const timing = { duration: 460, easing: 'cubic-bezier(.65,0,.25,1)', fill: 'forwards' };
    const grow = ghost.animate([
      { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`, borderRadius: '14px 14px 22px 22px' },
      { left: `${target.left}px`, top: `${target.top}px`, width: `${target.width}px`, height: `${target.height}px`, borderRadius: '0px' },
    ], timing);
    liquid.animate([{ height: `${entry.level}%` }, { height: '115%' }], timing);
    await grow.finished.catch(() => {});

    const view = this.onOpen(agentId);
    view?.classList.add('entering');
    setTimeout(() => view?.classList.remove('entering'), 500);
    await ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 320, easing: 'ease-out', fill: 'forwards' }).finished.catch(() => {});
    ghost.remove();
    entry.el.classList.remove('opening');
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
