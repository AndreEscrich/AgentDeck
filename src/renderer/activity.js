// Where your tokens go: one chart of the tokens your Claude Code sessions
// used per day, stacked by category, with a legend that is also the
// breakdown (tokens, share, messages, tokens per message; click a row to hide
// or show that category). Shown in the usage card, and in the Hub when no
// agents are there. The data comes from Claude Code's session files
// (src/activity.js), each API answer counted once.

// Categories in the charts, in this fixed order (the dark steps of the
// default categorical palette, checked with the dataviz validator against the
// panel: CVD separation, lightness band, 3:1 contrast). More than five fold
// into "Other", a neutral grey.
const CATEGORY_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'];
const OTHER_COLOR = '#6f6a62';
// Agents without a category: always a neutral light brown (deliberately low
// in colour, like "Other"; the 2px gaps and the legend keep it apart from
// the yellow when they sit next to each other).
const NONE_COLOR = '#a68a64';

function shortNumber(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(n));
}

function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const ACT_SVG_NS = 'http://www.w3.org/2000/svg';
function actSvg(tag, attrs = {}) {
  const node = document.createElementNS(ACT_SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

class ActivityPanel {
  // compact: the smaller view in the usage card.
  constructor(box, { compact = false } = {}) {
    this.box = box;
    this.compact = compact;
    this.range = 30;          // days in the chart
    this.hidden = new Set();  // categories you hid by clicking their row
    this.data = null;
    this.loadedAt = 0;
    try {
      const saved = JSON.parse(localStorage.getItem('activityView') || '{}');
      if ([7, 30, 90].includes(saved.range)) this.range = saved.range;
    } catch { /* defaults */ }
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

  remember() {
    try { localStorage.setItem('activityView', JSON.stringify({ range: this.range })); } catch { /* not important */ }
  }

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
      if (c.key === 'none') continue;
      totals.set(c.key, (totals.get(c.key) || 0) + s.tokens);
    }
    const ranked = [...totals].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    return new Map(ranked.slice(0, CATEGORY_COLORS.length).map((k, i) => [k, CATEGORY_COLORS[i]]));
  }

  // The numbers for the chosen range: the days, each series' tokens per day,
  // and each category's totals.
  model() {
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
    const seriesOf = key => (key === 'none' || colors.has(key) ? key : 'other');
    const names = new Map([['other', 'Other']]);
    const perDay = new Map(dates.map(d => [d, new Map()]));
    const cats = new Map();
    for (const [id, s] of Object.entries(this.data.sessions || {})) {
      const c = this.categoryFor(id, s);
      names.set(c.key, c.name);
      let tokens = 0;
      let prompts = 0;
      for (const [date, t] of Object.entries(s.days || {})) {
        if (!inRange.has(date)) continue;
        tokens += t;
        const day = perDay.get(date);
        day.set(seriesOf(c.key), (day.get(seriesOf(c.key)) || 0) + t);
      }
      for (const [date, n] of Object.entries(s.promptDays || {})) if (inRange.has(date)) prompts += n;
      if (!tokens && !prompts) continue;
      const cat = cats.get(c.key) || { key: c.key, name: c.name, series: seriesOf(c.key), tokens: 0, prompts: 0, sessions: 0 };
      cat.tokens += tokens;
      cat.prompts += prompts;
      cat.sessions++;
      cats.set(c.key, cat);
    }
    // Stacked from the most tokens in the range (at the bottom) to the least,
    // in the same order in every bar.
    const rangeTotal = k => dates.reduce((n, d) => n + (perDay.get(d).get(k) || 0), 0);
    const series = ['none', ...colors.keys(), 'other'].filter(k => rangeTotal(k) > 0).sort((a, b) => rangeTotal(b) - rangeTotal(a));
    const color = k => (k === 'none' ? NONE_COLOR : colors.get(k) || OTHER_COLOR);
    return { dates, perDay, series, names, color, cats: [...cats.values()].sort((a, b) => b.tokens - a.tokens) };
  }

  render() {
    const box = this.box;
    box.textContent = '';
    if (!this.data?.sessions) return;
    const m = this.model();

    // Title, range and how to draw it.
    const head = el('div', 'act-head');
    head.appendChild(el('div', 'act-title', 'Where the tokens go'));
    const seg = (options, current, pick) => {
      const s = el('div', 'act-metrics');
      for (const [value, label, title] of options) {
        const b = el('button', value === current ? 'on' : '', label);
        b.type = 'button';
        if (title) b.title = title;
        b.onclick = () => { window.uiSound?.('select'); pick(value); this.remember(); this.render(); };
        s.appendChild(b);
      }
      return s;
    };
    head.appendChild(seg([[7, '7 days'], [30, '30 days'], [90, '90 days']], this.range, v => { this.range = v; }));
    box.appendChild(head);

    if (!m.cats.length) {
      box.appendChild(el('div', 'act-empty', 'No tokens used in this time.'));
      return;
    }

    // The headline: tokens in the range, a day on average, and against the
    // range before it.
    const total = m.cats.reduce((n, c) => n + c.tokens, 0);
    const prev = this.previousTotal();
    const headline = el('div', 'act-headline');
    const change = prev ? Math.round(((total - prev) / prev) * 100) : null;
    headline.append(
      el('span', 'act-big', shortNumber(total)),
      el('span', 'act-big-label', `tokens in ${this.range} days`),
      el('span', 'act-big-sub', `${shortNumber(total / this.range)} a day on average`),
    );
    // Against the range before it: a percentage, or how many times as much
    // when that was little.
    if (change != null) {
      const text = change > 300 ? `▲ ${Math.round(total / prev)}× the ${this.range} days before` : `${change > 0 ? '▲' : '▼'} ${Math.abs(change)}% vs the ${this.range} days before`;
      headline.appendChild(el('span', `act-change ${change > 0 ? 'up' : 'down'}`, text));
    }
    box.appendChild(headline);

    box.appendChild(this.chart(m));
    box.appendChild(this.legend(m, total));
  }

  // Tokens in the same number of days before the chosen range.
  previousTotal() {
    const start = new Date();
    start.setHours(12, 0, 0, 0);
    start.setDate(start.getDate() - this.range);
    const keys = new Set();
    for (let i = 0; i < this.range; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() - i);
      keys.add(dayKey(d));
    }
    let n = 0;
    for (const s of Object.values(this.data.sessions || {})) for (const [date, t] of Object.entries(s.days || {})) if (keys.has(date)) n += t;
    return n;
  }

  // The chart: tokens per day, stacked by category. A tooltip per day lists
  // every category's tokens.
  chart(m) {
    const wrap = el('div', 'act-chart');
    const shown = m.series.filter(k => !this.hidden.has(k));
    const value = (date, k) => m.perDay.get(date).get(k) || 0;
    const dayTotal = date => shown.reduce((n, k) => n + value(date, k), 0);
    const W = 640;
    const H = this.compact ? 150 : 200;
    const padL = 44;
    const padB = 20;
    const plotW = W - padL - 6;
    const plotH = H - padB - 8;
    const n = m.dates.length;
    const max = Math.max(1, ...m.dates.map(dayTotal));
    const y = v => 8 + plotH - (v / max) * plotH;
    const svg = actSvg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'act-svg', role: 'img', 'aria-label': 'Tokens per day, stacked by category' });

    // Three recessive gridlines with their values.
    for (const f of [0, 0.5, 1]) {
      const yy = y(max * f);
      svg.appendChild(actSvg('line', { x1: padL, x2: W - 6, y1: yy, y2: yy, class: f ? 'act-grid' : 'act-axis' }));
      const label = actSvg('text', { x: padL - 6, y: yy + 3.5, class: 'act-ylabel', 'text-anchor': 'end' });
      label.textContent = shortNumber(max * f);
      svg.appendChild(label);
    }
    // Dates under the plot: the first, the last and a few between.
    const every = Math.ceil(n / 6);
    m.dates.forEach((date, i) => {
      if (!(i === n - 1 || (i % every === 0 && n - 1 - i >= every / 2))) return;
      const t = actSvg('text', { x: padL + (i + 0.5) * (plotW / n), y: H - 4, class: 'act-xlabel', 'text-anchor': 'middle' });
      t.textContent = new Date(date + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      svg.appendChild(t);
    });

    const slot = plotW / n;
    const cx = i => padL + (i + 0.5) * slot;
    // Stacked columns, 2px apart, the top one rounded.
    const bw = Math.max(2, slot - 2);
    m.dates.forEach((date, i) => {
      let base = 0;
      shown.forEach((k, si) => {
        const v = value(date, k);
        if (!v) return;
        const top = y(base + v);
        const h = Math.max(0.5, y(base) - top - (si ? 1 : 0));
        const last = !shown.slice(si + 1).some(k2 => value(date, k2));
        svg.appendChild(actSvg('rect', { x: padL + i * slot + 1, y: top, width: bw, height: h, rx: last ? 2.5 : 0, fill: m.color(k) }));
        base += v;
      });
    });

    // Hover: a guide line and a tooltip with the day's numbers.
    const guide = actSvg('line', { y1: 8, y2: 8 + plotH, class: 'act-guide' });
    guide.style.display = 'none';
    svg.appendChild(guide);
    const tip = el('div', 'act-tip hidden');
    const hit = actSvg('rect', { x: padL, y: 0, width: plotW, height: H - padB, fill: 'transparent' });
    hit.addEventListener('pointermove', e => {
      const r = svg.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * W;
      const i = Math.max(0, Math.min(n - 1, Math.floor((x - padL) / slot)));
      const date = m.dates[i];
      guide.setAttribute('x1', cx(i));
      guide.setAttribute('x2', cx(i));
      guide.style.display = '';
      const tot = dayTotal(date);
      const label = new Date(date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
      tip.textContent = `${label} · ${shortNumber(tot)} tokens`
        + [...shown].reverse().filter(k => value(date, k)).map(k => `\n${m.names.get(k)}: ${shortNumber(value(date, k))}${tot ? ` (${Math.round((value(date, k) / tot) * 100)}%)` : ''}`).join('');
      tip.classList.remove('hidden');
      const wr = wrap.getBoundingClientRect();
      tip.style.left = `${e.clientX - wr.left}px`;
      tip.style.top = `${(8 / H) * r.height + r.top - wr.top}px`;
    });
    hit.addEventListener('pointerleave', () => { guide.style.display = 'none'; tip.classList.add('hidden'); });
    svg.appendChild(hit);
    wrap.append(svg, tip);
    return wrap;
  }

  // The legend and the breakdown in one: per category its colour, name,
  // tokens and share in the range, messages you sent and tokens per message.
  // Clicking a row hides or shows its series in the chart.
  legend(m, total) {
    const table = el('div', 'act-legend-table');
    const head = el('div', 'act-lt-row act-lt-head');
    head.append(el('span'), el('span', null, 'Category'), el('span', null, 'Tokens'), el('span', null, 'Share'), el('span', null, 'Messages'), el('span', null, 'Per message'));
    table.appendChild(head);
    for (const c of m.cats.slice(0, 10)) {
      const row = el('button', 'act-lt-row' + (this.hidden.has(c.series) ? ' off' : ''));
      row.type = 'button';
      row.title = this.hidden.has(c.series) ? 'Show in the chart' : 'Hide from the chart';
      const sw = el('span', 'act-swatch');
      sw.style.background = m.color(c.series);
      const pct = total ? (c.tokens / total) * 100 : 0;
      const shareCell = el('span', 'act-lt-share');
      const bar = el('span', 'act-lt-bar');
      const fill = el('span');
      fill.style.width = `${pct}%`;
      fill.style.background = m.color(c.series);
      bar.appendChild(fill);
      shareCell.append(bar, el('span', null, `${Math.round(pct)}%`));
      row.append(sw, el('span', 'act-lt-name', c.name), el('span', 'act-lt-num', shortNumber(c.tokens)), shareCell,
        el('span', 'act-lt-num', String(c.prompts)), el('span', 'act-lt-num', c.prompts ? shortNumber(c.tokens / c.prompts) : '—'));
      row.onclick = () => {
        if (this.hidden.has(c.series)) this.hidden.delete(c.series);
        else this.hidden.add(c.series);
        window.uiSound?.('select');
        this.render();
      };
      table.appendChild(row);
    }
    if (m.cats.length > 10) table.appendChild(el('div', 'act-empty', `and ${m.cats.length - 10} more categories`));
    return table;
  }
}

window.ActivityPanel = ActivityPanel;
