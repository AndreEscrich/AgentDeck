// The Auto model report: is Auto (automodel.js) worth it, compared with
// running everything on Opus at medium effort?
//
// Every turn an Auto agent finishes is kept: the model it ran on, its
// tokens (new input, cache reads, cache writes, output) and what it cost,
// from Claude Code's own count (the result message's modelUsage, at API list
// prices). Next to it, what the same turn would have cost on Opus: the same
// tokens at Opus's prices, except that the cache Auto had to build again
// after switching model counts as cache reads (on Opus all along, the cache
// would have been there). Haiku's ratings are Auto's own cost and count on
// its side.
//
// The report speaks in your plan's weekly usage ("2.4% of your week") rather
// than dollars, which a subscription does not bill. Claude Code only says how
// much of the week is used (a whole percent), so the report learns what 1%
// is worth: each time the week's percentage goes up, it sets that rise
// against what this app's agents spent (at list prices) since the last rise.
// Use outside the app (claude.ai, other Claude Code windows) also moves the
// percentage, which makes 1% look cheaper than it is; the report says so.
// Until it has seen a few percent of the week go by, it shows dollars.
//
// Effort: each turn keeps the effort it ran at. Higher effort means more
// thinking, which Claude Code counts as output tokens, so Opus at medium
// would have written a different amount. The report estimates that from
// your own turns: per model, how much output a turn writes for each token it
// reads, at each effort against medium (see effortFactors). The Opus side's
// output tokens are scaled by that, once there are enough turns to say.
//
// Assumptions, said in the report too: Opus would have read and written as
// many tokens as the model Auto picked (output scaled for effort) (it may write fewer, or need fewer
// steps on hard tasks); quality is not in the numbers, so the report also
// counts how often Auto had to step up after a failed try (a sign it picked
// too small).
//
// Kept in this window's local storage (the last 3000 turns).

const autoReport = (() => {
  const KEY = 'autoReport';
  const MAX = 3000;
  // Claude Opus 5.5 list prices, dollars per million tokens. Cache writes:
  // 1.25x input for the 5-minute cache, 2x for the 1-hour one.
  const OPUS = { input: 4, output: 20, read: 0.2, write5m: 5, write1h: 8 };
  // How much of the week must have gone by before the percentages are shown.
  const CALIBRATED = 2;

  function fresh() {
    return { since: Date.now(), turns: [], ratings: 0, ratingCost: 0, ratingLog: [], cal: { cost: 0, pct: 0, costSince: 0, lastUtil: null, lastResets: null } };
  }
  function load() {
    try {
      const data = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (data && Array.isArray(data.turns)) {
        data.ratingLog = data.ratingLog || [];
        data.cal = data.cal || fresh().cal;
        return data;
      }
    } catch { /* start over */ }
    return fresh();
  }
  function save(data) {
    if (data.turns.length > MAX) data.turns = data.turns.slice(-MAX);
    if (data.ratingLog.length > MAX) data.ratingLog = data.ratingLog.slice(-MAX);
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* full: not important */ }
  }

  // ---------- what 1% of the week is worth ----------

  // Every finished turn of any agent (and every helper call the app makes):
  // what it cost at list prices, until the week's percentage next goes up.
  function noteCost(cost) {
    const c = Number(cost) || 0;
    if (!c) return;
    const data = load();
    data.cal.costSince += c;
    save(data);
  }

  // Claude Code's usage limits (a rate_limit_event's rate_limit_info).
  function noteUsage(info) {
    const week = info?.unifiedWindows?.seven_day;
    if (!week || typeof week.utilization !== 'number') return;
    const util = week.utilization * 100;
    const data = load();
    const cal = data.cal;
    if (cal.lastResets === week.resetsAt && cal.lastUtil != null && util > cal.lastUtil) {
      // The week went up: what was spent since the last rise bought that much.
      cal.cost += cal.costSince;
      cal.pct += util - cal.lastUtil;
      cal.costSince = 0;
      cal.lastUtil = util;
    } else if (cal.lastResets !== week.resetsAt || cal.lastUtil == null || util < cal.lastUtil) {
      // A new week (or the first look): start counting from here.
      cal.lastResets = week.resetsAt;
      cal.lastUtil = util;
      cal.costSince = 0;
    }
    save(data);
  }

  // Dollars (list price) per 1% of the week, or null while it is still learning.
  function perPercent(data = load()) {
    return data.cal.pct >= CALIBRATED && data.cal.cost > 0 ? data.cal.cost / data.cal.pct : null;
  }

  // ---------- the turns ----------

  // A Haiku rating that Auto asked for, with its cost.
  function noteRating(cost) {
    const data = load();
    data.ratings++;
    data.ratingCost += Number(cost) || 0;
    data.ratingLog.push({ at: Date.now(), cost: Number(cost) || 0 });
    data.cal.costSince += Number(cost) || 0;
    save(data);
  }

  // How big the conversation was at the end of a turn: what its last request
  // read (new, from cache and written to cache). The next turn's switch of
  // model has to build a cache of about this much again.
  function contextOf(msg) {
    const its = msg.usage?.iterations;
    const last = Array.isArray(its) && its.length ? its[its.length - 1] : msg.usage;
    if (!last) return 0;
    return (last.input_tokens || 0) + (last.cache_read_input_tokens || 0) + (last.cache_creation_input_tokens || 0);
  }

  // A finished turn of an Auto agent. info: { family ("haiku"), title (the
  // summary of the message that started the turn), switched (the model
  // changed for this turn), contextBefore (the conversation's size before
  // it), failedStepUp (it stepped up after a failed try or "still broken"),
  // effort (what it ran at; '' is the model's default) }.
  function recordTurn(msg, info) {
    const usage = msg.modelUsage || {};
    const entries = Object.entries(usage);
    if (!entries.length) return;
    const actual = Number(msg.total_cost_usd) || entries.reduce((s, [, u]) => s + (Number(u.costUSD) || 0), 0);
    // The model Auto picked; other models in the turn (Claude Code's own small
    // helpers) would have run on Opus too, so they cost the same both ways.
    const main = entries.find(([k]) => k.toLowerCase().includes(info.family)) || null;
    const others = entries.filter(e => e !== main).reduce((s, [, u]) => s + (Number(u.costUSD) || 0), 0);
    const t = main ? main[1] : {};
    const tokens = {
      input: t.inputTokens || 0,
      output: t.outputTokens || 0,
      read: t.cacheReadInputTokens || 0,
      write: t.cacheCreationInputTokens || 0,
    };
    // The share of cache writes that went to the 1-hour cache (it costs more).
    const cc = msg.usage?.cache_creation || {};
    const w1h = cc.ephemeral_1h_input_tokens || 0;
    const w5m = cc.ephemeral_5m_input_tokens || 0;
    const share1h = w1h + w5m ? w1h / (w1h + w5m) : 1;
    const writePrice = share1h * OPUS.write1h + (1 - share1h) * OPUS.write5m;
    let opus = (tokens.input * OPUS.input + tokens.output * OPUS.output + tokens.read * OPUS.read + tokens.write * writePrice) / 1e6;
    // After a switch, the cache it built again would have been read on Opus.
    const rebuilt = info.switched ? Math.min(tokens.write, info.contextBefore || 0) : 0;
    opus -= rebuilt * (writePrice - OPUS.read) / 1e6;
    const data = load();
    data.turns.push({
      at: Date.now(), title: String(info.title || '').slice(0, 80), model: info.family,
      switched: !!info.switched, failedStepUp: !!info.failedStepUp, rebuilt, effort: info.effort || '',
      tokens, actual, opus: opus + others,
    });
    save(data);
  }

  function reset() {
    const data = load();
    const next = fresh();
    next.cal = data.cal;   // what 1% of the week is worth is still true
    save(next);
  }

  // ---------- numbers ----------

  // How much output a turn writes for each token it reads (new, from cache
  // and written to cache): it grows with effort and does not depend much on
  // how long the turn is. Per model and effort, from your own turns.
  const ENOUGH = 5;   // turns of a model and effort before it is used
  const readOf = t => t.tokens.input + t.tokens.read + t.tokens.write;
  function effortFactors(turns) {
    const sums = {};
    for (const t of turns) {
      if (!t.effort || !readOf(t)) continue;
      const k = `${t.model}:${t.effort}`;
      const v = sums[k] || (sums[k] = { turns: 0, out: 0, read: 0 });
      v.turns++;
      v.out += t.tokens.output;
      v.read += readOf(t);
    }
    // Against the same model at medium: the factor Opus at medium's output
    // would have had (1 when there are too few turns to say).
    const factor = {};
    for (const [k, v] of Object.entries(sums)) {
      const [model, effort] = k.split(':');
      const med = sums[`${model}:medium`];
      if (effort === 'medium' || !med || v.turns < ENOUGH || med.turns < ENOUGH || !v.out) continue;
      factor[k] = Math.max(0.3, Math.min(3, (med.out / med.read) / (v.out / v.read)));
    }
    return factor;
  }

  function summary() {
    const data = load();
    // The Opus side with its output scaled for effort (see effortFactors).
    const factors = effortFactors(data.turns);
    let unadjusted = 0;
    data.turns = data.turns.map(t => {
      if (!t.effort || t.effort === 'medium') return t;
      const f = factors[`${t.model}:${t.effort}`];
      if (!f) { unadjusted++; return t; }
      return { ...t, opusRaw: t.opus, effortFactor: f, opus: t.opus + (f - 1) * t.tokens.output * OPUS.output / 1e6 };
    });
    const s = { since: data.since, turns: data.turns.length, actual: 0, opus: 0, ratings: data.ratings, ratingCost: data.ratingCost, switches: 0, failedStepUps: 0, rebuilt: 0, byModel: {}, perPercent: perPercent(data), cal: data.cal };
    for (const t of data.turns) {
      s.actual += t.actual;
      s.opus += t.opus;
      if (t.switched) s.switches++;
      if (t.failedStepUp) s.failedStepUps++;
      s.rebuilt += t.rebuilt || 0;
      const m = s.byModel[t.model] || (s.byModel[t.model] = { turns: 0, tokens: 0, actual: 0, opus: 0 });
      m.turns++;
      m.tokens += t.tokens.input + t.tokens.output + t.tokens.read + t.tokens.write;
      m.actual += t.actual;
      m.opus += t.opus;
    }
    s.total = s.actual + s.ratingCost;
    s.saved = s.opus - s.total;
    s.percent = s.opus ? (s.saved / s.opus) * 100 : 0;
    s.turnList = data.turns;
    s.ratingLog = data.ratingLog;
    s.unadjusted = unadjusted;
    // Per model and effort: turns, output per turn, spent, and on Opus.
    s.byEffort = {};
    for (const t of data.turns) {
      const k = `${t.model}:${t.effort || ''}`;
      const e = s.byEffort[k] || (s.byEffort[k] = { model: t.model, effort: t.effort || '', turns: 0, output: 0, actual: 0, opus: 0, factor: t.effortFactor || null });
      e.turns++;
      e.output += t.tokens.output;
      e.actual += t.actual;
      e.opus += t.opus;
    }
    return s;
  }

  const NAMES = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' };
  const EFFORTS = { '': 'default', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
  const runName = t => `${NAMES[t.model] || t.model}${t.effort ? ` · ${EFFORTS[t.effort] || t.effort}` : ''}`;
  const count = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

  // An amount in the report's unit: % of the week when known, else dollars.
  function unit(per) {
    if (per) {
      return {
        long: v => { const p = v / per; return Math.abs(p) < 0.005 ? '0%' : `${Math.abs(p) >= 10 ? p.toFixed(0) : Math.abs(p) >= 1 ? p.toFixed(1) : p.toFixed(2)}%`; },
        name: 'of your week',
      };
    }
    return {
      long: v => (Math.abs(v) >= 100 ? `$${v.toFixed(0)}` : Math.abs(v) >= 1 ? `$${v.toFixed(2)}` : v > 0 && v < 0.001 ? '<$0.001' : `$${v.toFixed(3)}`),
      name: 'at API prices',
    };
  }

  // ---------- the report ----------

  const SVG = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs = {}) => {
    const node = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };
  const tip = (node, text) => { const t = svg('title'); t.textContent = text; node.appendChild(t); return node; };

  // Cumulative cost over the turns: Auto's line and the all-Opus line; the
  // space between is green where Auto is cheaper, red where it costs more.
  function cumulativeChart(s, u) {
    const W = 560;
    const H = 150;
    const P = { l: 44, r: 10, t: 10, b: 20 };
    const events = [
      ...s.turnList.map(t => ({ at: t.at, auto: t.actual, opus: t.opus })),
      ...s.ratingLog.map(r => ({ at: r.at, auto: r.cost, opus: 0 })),
    ].sort((a, b) => a.at - b.at);
    const pts = [{ auto: 0, opus: 0 }];
    for (const e of events) {
      const last = pts[pts.length - 1];
      pts.push({ auto: last.auto + e.auto, opus: last.opus + e.opus });
    }
    const max = Math.max(1e-9, ...pts.map(p => Math.max(p.auto, p.opus)));
    const x = i => P.l + (i / Math.max(1, pts.length - 1)) * (W - P.l - P.r);
    const y = v => H - P.b - (v / max) * (H - P.t - P.b);
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'ar-chart' });
    for (const f of [0, 0.5, 1]) {
      root.appendChild(svg('line', { x1: P.l, x2: W - P.r, y1: y(max * f), y2: y(max * f), class: 'ar-grid' }));
      const label = svg('text', { x: P.l - 6, y: y(max * f) + 4, class: 'ar-axis', 'text-anchor': 'end' });
      label.textContent = u.long(max * f);
      root.appendChild(label);
    }
    // The gap between the lines, turn by turn.
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const good = b.auto <= b.opus;
      root.appendChild(svg('polygon', {
        points: `${x(i - 1)},${y(a.auto)} ${x(i)},${y(b.auto)} ${x(i)},${y(b.opus)} ${x(i - 1)},${y(a.opus)}`,
        class: good ? 'ar-gap good' : 'ar-gap bad',
      }));
    }
    const line = (key, cls) => root.appendChild(svg('polyline', { points: pts.map((p, i) => `${x(i)},${y(p[key])}`).join(' '), class: cls }));
    line('opus', 'ar-line opus');
    line('auto', 'ar-line auto');
    const end = pts[pts.length - 1];
    const lab = (v, text, cls) => {
      const t = svg('text', { x: W - P.r - 4, y: Math.max(P.t + 12, y(v) - 6), class: `ar-end ${cls}`, 'text-anchor': 'end' });
      t.textContent = text;
      root.appendChild(t);
    };
    lab(end.opus, `All on Opus ${u.long(end.opus)}`, 'opus');
    lab(end.auto, `Auto ${u.long(end.auto)}`, 'auto');
    return root;
  }

  // One bar per turn: how much it saved (up, green) or lost (down, red)
  // against Opus. A dot under it is the model; ↻ a switch, ▲ a step up
  // after a failed try. Hover a bar for the turn.
  function perTurnChart(s, u, onPick) {
    const turns = s.turnList.slice(-60);
    const W = 560;
    const H = 140;
    const P = { l: 8, r: 8, t: 8, b: 26 };
    const max = Math.max(1e-9, ...turns.map(t => Math.abs(t.opus - t.actual)));
    const zero = P.t + (H - P.t - P.b) / 2;
    const half = (H - P.t - P.b) / 2;
    const bw = (W - P.l - P.r) / Math.max(turns.length, 12);
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'ar-chart' });
    root.appendChild(svg('line', { x1: P.l, x2: W - P.r, y1: zero, y2: zero, class: 'ar-grid strong' }));
    turns.forEach((t, i) => {
      const d = t.opus - t.actual;
      const h = Math.max(1.5, (Math.abs(d) / max) * half);
      const x0 = P.l + i * bw + bw * 0.15;
      const g = svg('g', { class: 'ar-turn' });
      g.appendChild(svg('rect', { x: x0, y: d >= 0 ? zero - h : zero, width: bw * 0.7, height: h, class: d >= 0 ? 'ar-bar good' : 'ar-bar bad', rx: 1.5 }));
      g.appendChild(svg('circle', { cx: x0 + bw * 0.35, cy: H - P.b + 8, r: 3, class: `ar-dot ${t.model}` }));
      if (t.switched || t.failedStepUp) {
        const mark = svg('text', { x: x0 + bw * 0.35, y: H - 3, class: 'ar-mark', 'text-anchor': 'middle' });
        mark.textContent = t.failedStepUp ? '▲' : '↻';
        g.appendChild(mark);
      }
      // A wide invisible target, so thin bars are easy to point at.
      g.appendChild(svg('rect', { x: P.l + i * bw, y: P.t, width: bw, height: H - P.t, class: 'ar-hit' }));
      tip(g, `${t.title || '(untitled)'}\n${runName(t)}: ${u.long(t.actual)} · on Opus ${u.long(t.opus)}\n${d >= 0 ? 'Saved' : 'Lost'} ${u.long(Math.abs(d))}${t.switched ? ' · switched model' : ''}${t.failedStepUp ? ' · stepped up after a failed try' : ''}\n${new Date(t.at).toLocaleString()}`);
      g.addEventListener('click', () => onPick?.(t));
      root.appendChild(g);
    });
    return root;
  }

  // The model mix as one bar: the share of turns, and the share of what was spent.
  function mixBar(label, parts) {
    const box = el('div', 'ar-mix');
    box.appendChild(el('div', 'ar-mix-label', label));
    const bar = el('div', 'ar-mix-bar');
    const total = parts.reduce((s, p) => s + p.value, 0) || 1;
    for (const p of parts) {
      if (!p.value) continue;
      const seg = el('div', `ar-mix-seg ${p.cls}`, p.value / total >= 0.12 ? `${p.name} ${Math.round((p.value / total) * 100)}%` : '');
      seg.style.flexGrow = String(p.value);
      seg.title = `${p.name}: ${Math.round((p.value / total) * 100)}%`;
      bar.appendChild(seg);
    }
    box.appendChild(bar);
    return box;
  }

  function open() {
    if (document.querySelector('.auto-report-modal')) return;
    const s = summary();
    const u = unit(s.perPercent);
    const overlay = el('div', 'quit-modal auto-report-modal');
    const card = el('div', 'quit-card auto-report-card');
    const top = el('div', 'ar-top');
    top.append(el('div', 'quit-title', 'Auto model report'), el('div', 'auto-report-since', `${s.turns} turn${s.turns === 1 ? '' : 's'} on Auto since ${new Date(s.since).toLocaleDateString()} · amounts ${u.name}`));
    card.appendChild(top);
    if (!s.perPercent) {
      const learned = s.cal.pct ? ` (${s.cal.pct.toFixed(0)}% seen so far)` : '';
      card.appendChild(el('div', 'ar-calibrating', `Learning what 1% of your week is worth${learned}: until ${CALIBRATED}% of the week has gone by, amounts are in dollars at API prices.`));
    }
    if (!s.turns) {
      card.appendChild(el('p', 'quit-text', 'No turns on Auto yet. Pick Auto in the model menu (it is the default for new agents); each turn an Auto agent finishes is counted here.'));
    } else {
      // The verdict, in one line and three numbers.
      const good = s.saved >= 0;
      const verdict = el('div', `ar-verdict ${Math.abs(s.percent) < 1 ? '' : good ? 'good' : 'bad'}`);
      verdict.textContent = Math.abs(s.percent) < 1 ? 'Auto costs about the same as running everything on Opus.'
        : good ? `Auto saved ${u.long(s.saved)} ${u.name}: ${s.percent.toFixed(0)}% less than all on Opus.`
        : `Auto cost ${u.long(-s.saved)} ${u.name} more than all on Opus (${(-s.percent).toFixed(0)}% more).`;
      card.appendChild(verdict);
      // Auto against Opus as two bars.
      const versus = el('div', 'ar-versus');
      const bigger = Math.max(s.total, s.opus) || 1;
      for (const [name, value, cls] of [['Auto (with Haiku\'s ratings)', s.total, 'auto'], ['All on Opus, medium (estimate)', s.opus, 'opus']]) {
        const row = el('div', 'ar-vs-row');
        const bar = el('div', `ar-vs-bar ${cls}`);
        bar.style.width = `${Math.max(2, (value / bigger) * 100)}%`;
        const track = el('div', 'ar-vs-track');
        track.appendChild(bar);
        row.append(el('span', 'ar-vs-name', name), track, el('span', 'ar-vs-value', u.long(value)));
        versus.appendChild(row);
      }
      card.appendChild(versus);

      card.appendChild(el('div', 'ar-sub', 'Spent over time'));
      card.appendChild(el('div', 'ar-help', 'Green between the lines is what Auto saved so far; red is where it cost more.'));
      card.appendChild(cumulativeChart(s, u));

      card.appendChild(el('div', 'ar-sub', 'Saved or lost, turn by turn'));
      card.appendChild(el('div', 'ar-help', 'Up and green: cheaper than Opus. Down and red: dearer. The dot is the model; ↻ a model switch, ▲ a step up after a failed try. Point at a bar for the turn, click it to find it below.'));
      const list = el('div', 'auto-report-recent');
      card.appendChild(perTurnChart(s, u, t => {
        const row = list.querySelector(`[data-at="${t.at}"]`);
        if (row) { row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 1200); }
      }));
      const legend = el('div', 'ar-legend');
      for (const m of ['haiku', 'sonnet', 'opus']) {
        const item = el('span', 'ar-legend-item');
        item.append(el('span', `ar-legend-dot ${m}`), document.createTextNode(NAMES[m]));
        legend.appendChild(item);
      }
      card.appendChild(legend);

      card.appendChild(el('div', 'ar-sub', 'Model mix'));
      const models = ['haiku', 'sonnet', 'opus'].map(m => ({ m, d: s.byModel[m] || { turns: 0, actual: 0, opus: 0, tokens: 0 } }));
      card.appendChild(mixBar('Turns', models.map(({ m, d }) => ({ name: NAMES[m], value: d.turns, cls: m }))));
      card.appendChild(mixBar('Spent', models.map(({ m, d }) => ({ name: NAMES[m], value: d.actual, cls: m }))));
      const table = el('div', 'auto-report-table');
      const row = (cells, cls = '') => {
        const r = el('div', 'auto-report-row' + (cls ? ' ' + cls : ''));
        for (const c of cells) r.appendChild(el('span', null, c));
        return r;
      };
      table.appendChild(row(['Model', 'Turns', 'Tokens', 'Spent', 'On Opus', 'Saved'], 'head'));
      for (const { m, d } of models) {
        if (!d.turns) continue;
        table.appendChild(row([NAMES[m], String(d.turns), count(d.tokens), u.long(d.actual), u.long(d.opus), u.long(d.opus - d.actual)]));
      }
      table.appendChild(row(['Haiku ratings', String(s.ratings), '', u.long(s.ratingCost), '—', u.long(-s.ratingCost)]));
      card.appendChild(table);

      // The same turns by model and effort.
      card.appendChild(el('div', 'ar-sub', 'Effort'));
      card.appendChild(el('div', 'ar-help', 'Higher effort thinks longer, which counts as output. "On Opus" is Opus at medium: for other efforts its output is scaled by how much output your turns write at that effort against medium (× in the last column), once each has 5 turns.'));
      const efforts = el('div', 'auto-report-table');
      efforts.appendChild(row(['Run at', 'Turns', 'Output / turn', 'Spent', 'On Opus', 'Output ×'], 'head'));
      const order = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
      const runs = Object.values(s.byEffort).sort((a, b) => ['haiku', 'sonnet', 'opus'].indexOf(a.model) - ['haiku', 'sonnet', 'opus'].indexOf(b.model) || order.indexOf(a.effort) - order.indexOf(b.effort));
      for (const e of runs) {
        const scaled = e.effort === 'medium' ? '1' : e.factor ? e.factor.toFixed(2) : e.effort ? 'not yet' : '—';
        efforts.appendChild(row([runName(e), String(e.turns), count(Math.round(e.output / e.turns)), u.long(e.actual), u.long(e.opus), scaled]));
      }
      card.appendChild(efforts);

      const facts = el('ul', 'auto-report-facts');
      facts.append(
        el('li', null, `Model switches between messages: ${s.switches} (about ${count(s.rebuilt)} tokens of cache built again, counted as cache reads on the Opus side).`),
        el('li', null, `Stepped up after a failed try or "still broken": ${s.failedStepUps} time${s.failedStepUps === 1 ? '' : 's'}. Often means Auto picked too small; if this grows, Auto costs you time even when it saves usage.`),
        el('li', null, s.perPercent
          ? `1% of your week is worth about $${s.perPercent.toFixed(2)} at API prices, learned from ${s.cal.pct.toFixed(0)}% of your weeks. Use outside this app also moves the percentage, so the true share can be smaller.`
          : 'The Opus side is an estimate at API list prices.'),
        el('li', null, 'The Opus side assumes Opus would have read and written as many tokens as the model Auto picked, with its output scaled for effort where there are enough turns (see Effort).'),
        ...(s.unadjusted ? [el('li', null, `${s.unadjusted} turn${s.unadjusted === 1 ? '' : 's'} ran at an effort other than medium without enough turns yet to scale them: on the Opus side they count as if Opus at medium had written as much output.`)] : []),
      );
      card.appendChild(facts);

      card.appendChild(el('div', 'ar-sub', 'Turns, latest first'));
      const maxTurn = Math.max(1e-9, ...s.turnList.map(t => Math.max(t.actual, t.opus)));
      for (const t of s.turnList.slice(-40).reverse()) {
        const r = el('div', 'auto-report-turn');
        r.dataset.at = String(t.at);
        const bars = el('div', 'ar-turn-bars');
        const a = el('div', 'ar-turn-bar auto');
        a.style.width = `${(t.actual / maxTurn) * 100}%`;
        const o = el('div', 'ar-turn-bar opus');
        o.style.width = `${(t.opus / maxTurn) * 100}%`;
        bars.append(o, a);
        const d = t.opus - t.actual;
        r.append(
          el('span', `auto-report-model ${t.model}`, NAMES[t.model] || t.model),
          el('span', 'auto-report-title', t.title || '(untitled)'),
          bars,
          el('span', `auto-report-num ${d >= 0 ? 'good' : 'bad'}`, `${d >= 0 ? '−' : '+'}${u.long(Math.abs(d))}${t.switched ? ' ↻' : ''}${t.failedStepUp ? ' ▲' : ''}`),
        );
        r.title = `${t.title}\n${runName(t)}: ${u.long(t.actual)} · on Opus ${u.long(t.opus)}\n${new Date(t.at).toLocaleString()}`;
        list.appendChild(r);
      }
      card.appendChild(list);
    }
    const buttons = el('div', 'quit-buttons');
    const resetBtn = el('button', 'quit-stay', 'Start over');
    resetBtn.title = 'Forget the turns counted so far (what 1% of your week is worth is kept)';
    const close = el('button', 'quit-go', 'Close');
    buttons.append(resetBtn, close);
    card.appendChild(buttons);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    const shut = () => {
      document.removeEventListener('keydown', onKey, true);
      overlay.classList.remove('show');
      setTimeout(() => overlay.remove(), 200);
    };
    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); shut(); } };
    document.addEventListener('keydown', onKey, true);
    close.onclick = shut;
    overlay.onclick = e => { if (e.target === overlay) shut(); };
    resetBtn.onclick = () => { reset(); shut(); setTimeout(open, 220); };
  }

  return { noteRating, noteCost, noteUsage, recordTurn, contextOf, summary, open, reset };
})();

window.autoReport = autoReport;
