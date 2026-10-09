// Your Claude Code activity, shown in the Hub when no agents are there: a
// calendar with one square per day (darker = more use), totals, streaks, your
// most used model and your busiest day. The data comes from Claude Code's
// session files (src/activity.js).

// One amber hue from dark to bright (dark background: more = brighter).
// Checked with the dataviz validator: even lightness steps, one hue, and the
// weakest step at 2.1:1 against the card. Days without use are a neutral grey.
const ACTIVITY_LEVELS = ['#2a241e', '#624619', '#8f651d', '#bd8522', '#f0b142'];

const ACTIVITY_METRICS = {
  tokens: { label: 'Tokens', unit: 'tokens' },
  prompts: { label: 'Messages', unit: 'messages' },
  sessions: { label: 'Sessions', unit: 'sessions' },
};

function shortNumber(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}

function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function modelName(id) {
  // claude-opus-5-5 -> Opus 5.5, claude-sonnet-4-6 -> Sonnet 4.6
  const m = id.match(/claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/);
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
}

class ActivityPanel {
  // compact: the smaller view in the usage card.
  constructor(box, { compact = false } = {}) {
    this.box = box;
    this.compact = compact;
    this.metric = 'tokens';
    this.asTable = false;
    this.data = null;
    this.loadedAt = 0;
  }

  // Reads the numbers (quick after the first time) and draws the view.
  async load({ ifOlderThan = 0 } = {}) {
    if (this.loading || (this.data && Date.now() - this.loadedAt < ifOlderThan)) return;
    this.loading = true;
    try {
      this.show(await window.deck.activity());
      this.onLoaded?.(this.data);
    } catch { /* keep what is shown */ }
    this.loading = false;
  }

  show(data) {
    this.data = data;
    this.loadedAt = Date.now();
    this.render();
  }

  stats() {
    const days = this.data.days;
    const byDate = new Map(days.map(d => [d.date, d]));
    const active = d => d && (d.prompts > 0 || d.tokens > 0);
    // Streaks: days in a row with activity. Today without activity yet does
    // not end the current streak.
    const today = new Date();
    let current = 0;
    const cursor = new Date(today);
    if (!active(byDate.get(dayKey(cursor)))) cursor.setDate(cursor.getDate() - 1);
    while (active(byDate.get(dayKey(cursor)))) { current++; cursor.setDate(cursor.getDate() - 1); }
    let longest = 0;
    let run = 0;
    let prev = null;
    for (const d of days.filter(active)) {
      const date = new Date(d.date + 'T12:00:00');
      run = prev && Math.round((date - prev) / 86400000) === 1 ? run + 1 : 1;
      longest = Math.max(longest, run);
      prev = date;
    }
    const sum = k => days.reduce((n, d) => n + d[k], 0);
    const topModel = Object.entries(this.data.models).sort((a, b) => b[1] - a[1])[0];
    const busiest = [...days].sort((a, b) => b[this.metric] - a[this.metric])[0];
    const hours = this.data.hours || [];
    const peakHour = hours.indexOf(Math.max(...hours));
    return {
      tokens: sum('tokens'), output: sum('output'), prompts: sum('prompts'),
      sessions: sum('sessions'), activeDays: days.filter(active).length,
      current, longest, topModel: topModel ? modelName(topModel[0]) : '—', busiest, peakHour,
    };
  }

  render() {
    const box = this.box;
    box.textContent = '';
    if (!this.data?.days?.length) return;
    const s = this.stats();

    const head = el('div', 'act-head');
    head.appendChild(el('div', 'act-title', 'Your activity'));
    const seg = el('div', 'act-metrics');
    for (const [key, m] of Object.entries(ACTIVITY_METRICS)) {
      const b = el('button', key === this.metric ? 'on' : '', m.label);
      b.type = 'button';
      b.onclick = () => { window.uiSound?.('select'); this.metric = key; this.render(); };
      seg.appendChild(b);
    }
    const tableBtn = el('button', 'act-table-btn' + (this.asTable ? ' on' : ''), this.asTable ? 'Calendar' : 'Table');
    tableBtn.type = 'button';
    tableBtn.title = this.asTable ? 'Show the calendar' : 'Show the days as a table';
    tableBtn.onclick = () => { window.uiSound?.('select'); this.asTable = !this.asTable; this.render(); };
    head.append(seg, tableBtn);
    box.appendChild(head);

    const tiles = el('div', 'act-tiles');
    const tile = (value, label, sub) => {
      const t = el('div', 'act-tile');
      t.append(el('div', 'act-value', value), el('div', 'act-label', label));
      if (sub) t.appendChild(el('div', 'act-sub', sub));
      tiles.appendChild(t);
    };
    tile(shortNumber(s.tokens), 'Tokens', `${shortNumber(s.output)} written by Claude`);
    tile(s.prompts.toLocaleString(), 'Messages', 'that you sent');
    tile(s.sessions.toLocaleString(), 'Sessions');
    tile(String(s.activeDays), 'Active days');
    tile(`${s.current} ${s.current === 1 ? 'day' : 'days'}`, 'Current streak', `Longest: ${s.longest} ${s.longest === 1 ? 'day' : 'days'}`);
    tile(s.topModel, 'Most used model');
    box.appendChild(tiles);

    box.appendChild(this.asTable ? this.table() : this.calendar());

    const notes = el('div', 'act-notes');
    if (s.busiest) {
      const d = new Date(s.busiest.date + 'T12:00:00');
      notes.appendChild(el('span', null, `Busiest day: ${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} · ${shortNumber(s.busiest[this.metric])} ${ACTIVITY_METRICS[this.metric].unit}`));
    }
    if (s.peakHour >= 0 && (this.data.hours || [])[s.peakHour] > 0) {
      notes.appendChild(el('span', null, `Most messages between ${String(s.peakHour).padStart(2, '0')}:00 and ${String((s.peakHour + 1) % 24).padStart(2, '0')}:00`));
    }
    notes.appendChild(el('span', 'act-source', 'From Claude Code sessions on this Mac'));
    box.appendChild(notes);
  }

  // Levels 1-4 by quartile of the days with any value, so one huge day does
  // not wash out the rest.
  levelOf(values) {
    const sorted = values.filter(v => v > 0).sort((a, b) => a - b);
    const q = p => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] || 0;
    const cuts = [q(0.25), q(0.5), q(0.75)];
    return v => (v <= 0 ? 0 : v <= cuts[0] ? 1 : v <= cuts[1] ? 2 : v <= cuts[2] ? 3 : 4);
  }

  calendar() {
    const metric = this.metric;
    const byDate = new Map(this.data.days.map(d => [d.date, d]));
    const level = this.levelOf(this.data.days.map(d => d[metric]));

    // Weeks run Monday to Sunday. Show at least 26 weeks, at most a year,
    // starting at the week of your first session.
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const monday = d => { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
    const first = new Date(this.data.days[0].date + 'T12:00:00');
    const weeksSinceFirst = Math.ceil((monday(today) - monday(first)) / (7 * 86400000)) + 1;
    const weeks = Math.min(53, Math.max(26, weeksSinceFirst));
    const start = monday(today);
    start.setDate(start.getDate() - 7 * (weeks - 1));

    const wrap = el('div', 'act-calendar');
    const months = el('div', 'act-months');
    const body = el('div', 'act-body');
    const labels = el('div', 'act-weekdays');
    ['Mon', '', 'Wed', '', 'Fri', '', ''].forEach(t => labels.appendChild(el('span', null, t)));
    const grid = el('div', 'act-grid');
    grid.style.gridTemplateColumns = `repeat(${weeks}, var(--cell))`;
    months.style.gridTemplateColumns = `repeat(${weeks}, var(--cell))`;
    const tip = el('div', 'act-tip hidden');

    let lastMonth = -1;
    for (let w = 0; w < weeks; w++) {
      const weekStart = new Date(start);
      weekStart.setDate(start.getDate() + 7 * w);
      const m = el('span');
      if (weekStart.getMonth() !== lastMonth) {
        m.textContent = weekStart.toLocaleDateString(undefined, { month: 'short' });
        lastMonth = weekStart.getMonth();
      }
      months.appendChild(m);
      for (let i = 0; i < 7; i++) {
        const date = new Date(weekStart);
        date.setDate(weekStart.getDate() + i);
        const cell = el('span', 'act-cell');
        cell.style.gridColumn = String(w + 1);
        cell.style.gridRow = String(i + 1);
        if (date > today) { cell.classList.add('future'); grid.appendChild(cell); continue; }
        const d = byDate.get(dayKey(date));
        const lv = level(d ? d[metric] : 0);
        cell.style.background = ACTIVITY_LEVELS[lv];
        const label = `${date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}\n`
          + (d ? `${shortNumber(d.tokens)} tokens · ${d.prompts} messages · ${d.sessions} sessions` : 'No activity');
        cell.setAttribute('aria-label', label.replace('\n', ': '));
        cell.onmouseenter = () => {
          tip.textContent = label;
          tip.classList.remove('hidden');
          const r = cell.getBoundingClientRect();
          const box = this.box.getBoundingClientRect();
          tip.style.left = `${r.left - box.left + r.width / 2}px`;
          tip.style.top = `${r.top - box.top}px`;
        };
        cell.onmouseleave = () => tip.classList.add('hidden');
        grid.appendChild(cell);
      }
    }
    body.append(labels, grid);

    const legend = el('div', 'act-legend');
    legend.appendChild(el('span', null, 'Less'));
    for (const c of ACTIVITY_LEVELS) { const sw = el('span', 'act-swatch'); sw.style.background = c; legend.appendChild(sw); }
    legend.appendChild(el('span', null, 'More'));

    // The tip belongs to the whole view: the calendar scrolls sideways, which
    // would cut off a tip that sticks out above it.
    wrap.append(months, body, legend);
    this.box.appendChild(tip);
    // When the calendar is wider than its box, start at the newest weeks.
    requestAnimationFrame(() => { wrap.scrollLeft = wrap.scrollWidth; });
    return wrap;
  }

  // The same numbers as a table, newest day first (only days with activity).
  table() {
    const wrap = el('div', 'act-table-wrap');
    const t = document.createElement('table');
    t.className = 'act-table';
    t.innerHTML = '<thead><tr><th>Day</th><th>Tokens</th><th>Messages</th><th>Sessions</th></tr></thead>';
    const tb = document.createElement('tbody');
    for (const d of [...this.data.days].reverse()) {
      const tr = document.createElement('tr');
      const date = new Date(d.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
      for (const v of [date, shortNumber(d.tokens), d.prompts, d.sessions]) tr.appendChild(el('td', null, String(v)));
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    wrap.appendChild(t);
    return wrap;
  }
}

window.ActivityPanel = ActivityPanel;
