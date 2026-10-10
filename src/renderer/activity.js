// Your Claude Code activity, shown in the Hub when no agents are there: a
// calendar with one square per day (darker = more use), totals, streaks, your
// most used model and your busiest day. The data comes from Claude Code's
// session files (src/activity.js).

// One amber hue from dark to bright (dark background: more = brighter).
// Checked with the dataviz validator: even lightness steps, one hue, and the
// weakest step at 2.1:1 against the card. Days without use are a neutral grey.
const ACTIVITY_LEVELS = ['#2a241e', '#624619', '#8f651d', '#bd8522', '#f0b142'];

// Categories in the charts, in this fixed order (the dark steps of the
// default categorical palette, checked with the dataviz validator against the
// panel: CVD separation, lightness band, 3:1 contrast). More than five fold
// into "Other", a neutral grey.
const CATEGORY_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'];
const OTHER_COLOR = '#6f6a62';

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
    this.range = 30;   // days in the charts
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
    if (this.data.sessions) box.appendChild(this.charts());

    const notes = el('div', 'act-notes');
    if (s.busiest) {
      const d = new Date(s.busiest.date + 'T12:00:00');
      notes.appendChild(el('span', null, `Busiest day: ${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} · ${shortNumber(s.busiest[this.metric])} ${ACTIVITY_METRICS[this.metric].unit}`));
    }
    if (s.peakHour >= 0 && (this.data.hours || [])[s.peakHour] > 0) {
      notes.appendChild(el('span', null, `Most messages between ${String(s.peakHour).padStart(2, '0')}:00 and ${String((s.peakHour + 1) % 24).padStart(2, '0')}:00`));
    }
    notes.appendChild(el('span', 'act-source', 'From Claude Code sessions on this computer'));
    box.appendChild(notes);
  }

  // ---------- tokens over time and by category ----------

  // Which category a session belongs to: { key, name } from the app (see
  // ActivityPanel.categoryOf in app.js), or one of the two kinds without one.
  categoryFor(id, s) {
    return ActivityPanel.categoryOf?.(id, s)
      || (s.fromHub ? { key: 'none', name: 'No category' } : { key: 'outside', name: 'Outside Agent Hub' });
  }

  // Colors follow the category, not its place in the chosen range: the five
  // categories with the most tokens overall keep their color, the rest are
  // "Other" (grey).
  categoryColors() {
    const totals = new Map();
    for (const [id, s] of Object.entries(this.data.sessions || {})) {
      const c = this.categoryFor(id, s);
      totals.set(c.key, (totals.get(c.key) || 0) + s.tokens);
    }
    const ranked = [...totals].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    return new Map(ranked.slice(0, CATEGORY_COLORS.length).map((k, i) => [k, CATEGORY_COLORS[i]]));
  }

  charts() {
    const wrap = el('div', 'act-charts');
    const head = el('div', 'act-head');
    head.appendChild(el('div', 'act-title', 'Where the tokens go'));
    const seg = el('div', 'act-metrics');
    for (const n of [7, 30, 90]) {
      const b = el('button', n === this.range ? 'on' : '', `${n} days`);
      b.type = 'button';
      b.onclick = () => { window.uiSound?.('select'); this.range = n; this.render(); };
      seg.appendChild(b);
    }
    head.appendChild(seg);
    wrap.appendChild(head);

    // The days of the range, oldest first.
    const dates = [];
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    for (let i = this.range - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      dates.push(dayKey(d));
    }
    const inRange = new Set(dates);
    const colors = this.categoryColors();
    const series = key => (colors.has(key) ? key : 'other');
    const names = new Map([['other', 'Other']]);
    const perDay = new Map(dates.map(d => [d, new Map()]));
    const cats = new Map();   // category key -> { name, tokens, prompts, sessions }
    for (const [id, s] of Object.entries(this.data.sessions || {})) {
      const c = this.categoryFor(id, s);
      names.set(c.key, c.name);
      let tokens = 0, prompts = 0;
      for (const [date, t] of Object.entries(s.days || {})) {
        if (!inRange.has(date)) continue;
        tokens += t;
        const day = perDay.get(date);
        day.set(series(c.key), (day.get(series(c.key)) || 0) + t);
      }
      for (const [date, n] of Object.entries(s.promptDays || {})) if (inRange.has(date)) prompts += n;
      if (!tokens && !prompts) continue;
      const cat = cats.get(c.key) || { key: c.key, name: c.name, tokens: 0, prompts: 0, sessions: 0 };
      cat.tokens += tokens;
      cat.prompts += prompts;
      cat.sessions++;
      cats.set(c.key, cat);
    }
    if (!cats.size) {
      wrap.appendChild(el('div', 'act-empty', 'No tokens used in this time.'));
      return wrap;
    }
    const color = key => colors.get(key) || OTHER_COLOR;
    // Stack order: the colored categories in their color order, Other last (on top).
    const order = [...colors.keys(), 'other'].filter(k => dates.some(d => perDay.get(d).get(k)));

    // Legend: every series in the chart, named (identity is never color alone).
    const legend = el('div', 'act-chart-legend');
    for (const k of order) {
      const item = el('span', 'act-legend-item');
      const sw = el('span', 'act-swatch');
      sw.style.background = color(k);
      item.append(sw, el('span', null, names.get(k)));
      legend.appendChild(item);
    }

    // 1. Tokens per day, stacked by category.
    const chart = el('div', 'act-chart');
    chart.appendChild(el('div', 'act-chart-title', 'Tokens per day'));
    chart.appendChild(legend);
    const max = Math.max(1, ...dates.map(d => [...perDay.get(d).values()].reduce((a, b) => a + b, 0)));
    const plot = el('div', 'act-plot');
    // Three recessive gridlines with their values.
    for (const f of [1, 0.5]) {
      const line = el('div', 'act-gridline');
      line.style.bottom = `${f * 100}%`;
      line.appendChild(el('span', null, shortNumber(max * f)));
      plot.appendChild(line);
    }
    const cols = el('div', 'act-cols');
    const tip = el('div', 'act-tip hidden');
    dates.forEach((date, i) => {
      const day = perDay.get(date);
      const total = [...day.values()].reduce((a, b) => a + b, 0);
      const col = el('div', 'act-col');
      for (const k of order) {
        const v = day.get(k);
        if (!v) continue;
        const segm = el('span');
        segm.style.height = `${(v / max) * 100}%`;
        segm.style.background = color(k);
        col.appendChild(segm);
      }
      const label = new Date(date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
      col.setAttribute('aria-label', `${label}: ${shortNumber(total)} tokens`);
      col.onmouseenter = () => {
        tip.textContent = `${label} · ${shortNumber(total)} tokens`
          + order.filter(k => day.get(k)).reverse().map(k => `\n${names.get(k)}: ${shortNumber(day.get(k))}`).join('');
        tip.classList.remove('hidden');
        const r = col.getBoundingClientRect();
        const b = this.box.getBoundingClientRect();
        tip.style.left = `${r.left - b.left + r.width / 2}px`;
        tip.style.top = `${r.top - b.top + r.height - (total / max) * r.height}px`;
      };
      col.onmouseleave = () => tip.classList.add('hidden');
      cols.appendChild(col);
    });
    plot.appendChild(cols);
    chart.appendChild(plot);
    // A few dates under the bars: the first, the last and some between.
    const xs = el('div', 'act-xlabels');
    const every = Math.ceil(dates.length / 6);
    dates.forEach((date, i) => {
      const show = i === dates.length - 1 || (i % every === 0 && dates.length - 1 - i >= every / 2);
      xs.appendChild(el('span', null, show ? new Date(date + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : ''));
    });
    chart.appendChild(xs);
    wrap.appendChild(chart);
    this.box.appendChild(tip);

    // 2. Tokens by category, and per message you sent: what kind of work costs most.
    const byCat = el('div', 'act-chart');
    byCat.appendChild(el('div', 'act-chart-title', 'By category'));
    const rows = [...cats.values()].sort((a, b) => b.tokens - a.tokens);
    const top = Math.max(1, rows[0].tokens);
    const list = el('div', 'act-cat-list');
    for (const c of rows.slice(0, 8)) {
      const row = el('div', 'act-cat-row');
      const sw = el('span', 'act-swatch');
      sw.style.background = color(c.key);
      const name = el('span', 'act-cat-name', c.name);
      const bar = el('div', 'act-cat-bar');
      const fill = el('span');
      fill.style.width = `${Math.max(0.5, (c.tokens / top) * 100)}%`;
      fill.style.background = color(c.key);
      bar.appendChild(fill);
      const per = c.prompts ? `${shortNumber(c.tokens / c.prompts)} per message` : 'no messages';
      const value = el('span', 'act-cat-value', shortNumber(c.tokens));
      const sub = el('span', 'act-cat-sub', `${c.prompts} ${c.prompts === 1 ? 'message' : 'messages'} · ${per}`);
      row.title = `${c.name}: ${c.tokens.toLocaleString()} tokens in ${c.sessions} ${c.sessions === 1 ? 'session' : 'sessions'}, ${c.prompts} messages you sent`;
      row.append(sw, name, bar, value, sub);
      list.appendChild(row);
    }
    if (rows.length > 8) list.appendChild(el('div', 'act-cat-more', `and ${rows.length - 8} more`));
    byCat.appendChild(list);
    wrap.appendChild(byCat);
    return wrap;
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
