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
// Assumptions, said in the report too: Opus would have read and written as
// many tokens as the model Auto picked (it may write fewer, or need fewer
// steps on hard tasks); quality is not in the money, so the report also
// counts how often Auto had to step up after a failed try (a sign it picked
// too small). On a subscription the dollars are not billed: they show how
// much of your limits each side uses, relative to each other.
//
// Kept in this window's local storage (the last 3000 turns).

const autoReport = (() => {
  const KEY = 'autoReport';
  const MAX = 3000;
  // Claude Opus 5.5 list prices, dollars per million tokens. Cache writes:
  // 1.25x input for the 5-minute cache, 2x for the 1-hour one.
  const OPUS = { input: 4, output: 20, read: 0.2, write5m: 5, write1h: 8 };

  function load() {
    try {
      const data = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (data && Array.isArray(data.turns)) return data;
    } catch { /* start over */ }
    return { since: Date.now(), turns: [], ratings: 0, ratingCost: 0 };
  }
  function save(data) {
    if (data.turns.length > MAX) data.turns = data.turns.slice(-MAX);
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* full: not important */ }
  }

  // A Haiku rating that Auto asked for, with its cost.
  function noteRating(cost) {
    const data = load();
    data.ratings++;
    data.ratingCost += Number(cost) || 0;
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

  // A finished turn of an Auto agent. info: { family ("haiku"), title,
  // switched (the model changed for this turn), contextBefore (the
  // conversation's size before it), failedStepUp (it stepped up after a
  // failed try or "still broken") }.
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
      switched: !!info.switched, failedStepUp: !!info.failedStepUp, rebuilt,
      tokens, actual, opus: opus + others,
    });
    save(data);
  }

  function reset() {
    save({ since: Date.now(), turns: [], ratings: 0, ratingCost: 0 });
  }

  const money = n => (n >= 100 ? `${n.toFixed(0)}` : n >= 1 ? `${n.toFixed(2)}` : n > 0 && n < 0.001 ? '<$0.001' : `${n.toFixed(3)}`);
  const count = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
  const NAMES = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' };

  function summary() {
    const data = load();
    const s = { since: data.since, turns: data.turns.length, actual: 0, opus: 0, ratings: data.ratings, ratingCost: data.ratingCost, switches: 0, failedStepUps: 0, rebuilt: 0, byModel: {} };
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
    s.recent = data.turns.slice(-12).reverse();
    return s;
  }

  // The report, as a card over the window.
  function open() {
    if (document.querySelector('.auto-report-modal')) return;
    const s = summary();
    const overlay = el('div', 'quit-modal auto-report-modal');
    const card = el('div', 'quit-card auto-report-card');
    card.appendChild(el('div', 'quit-title', 'Auto model report'));
    card.appendChild(el('div', 'auto-report-since', `${s.turns} turn${s.turns === 1 ? '' : 's'} on Auto since ${new Date(s.since).toLocaleDateString()}`));
    if (!s.turns) {
      card.appendChild(el('p', 'quit-text', 'No turns on Auto yet. Pick Auto in the model menu (it is the default for new agents); each turn an Auto agent finishes is counted here.'));
    } else {
      const head = el('div', 'auto-report-head');
      const stat = (label, value, cls = '') => {
        const b = el('div', 'auto-report-stat ' + cls);
        b.append(el('div', 'auto-report-value', value), el('div', 'auto-report-label', label));
        return b;
      };
      head.append(
        stat('Auto (with Haiku\'s ratings)', money(s.total)),
        stat('All on Opus, medium (estimate)', money(s.opus)),
        Math.abs(s.percent) < 1
          ? stat('Even: about the same as Opus', '±0%')
          : stat(s.saved > 0 ? 'Saved' : 'Lost', `${money(Math.abs(s.saved))} · ${Math.abs(s.percent).toFixed(0)}%`, s.saved > 0 ? 'good' : 'bad'),
      );
      card.appendChild(head);
      const table = el('div', 'auto-report-table');
      const row = (cells, cls = '') => {
        const r = el('div', 'auto-report-row' + (cls ? ' ' + cls : ''));
        for (const c of cells) r.appendChild(el('span', null, c));
        return r;
      };
      table.appendChild(row(['Model', 'Turns', 'Tokens', 'Cost', 'On Opus'], 'head'));
      for (const name of ['haiku', 'sonnet', 'opus']) {
        const m = s.byModel[name];
        if (!m) continue;
        table.appendChild(row([NAMES[name], String(m.turns), count(m.tokens), money(m.actual), money(m.opus)]));
      }
      table.appendChild(row(['Haiku ratings', String(s.ratings), '', money(s.ratingCost), '—']));
      card.appendChild(table);
      const facts = el('ul', 'auto-report-facts');
      facts.append(
        el('li', null, `Model switches between messages: ${s.switches} (about ${count(s.rebuilt)} tokens of cache built again, counted as cache reads on the Opus side).`),
        el('li', null, `Stepped up after a failed try or "still broken": ${s.failedStepUps} time${s.failedStepUps === 1 ? '' : 's'}. Often means Auto picked too small; if this grows, Auto costs you time even when it saves money.`),
        el('li', null, 'The Opus side assumes Opus would have read and written as many tokens as the model Auto picked. API list prices; on a subscription they show how much of your limits each side uses.'),
      );
      card.appendChild(facts);
      const recent = el('div', 'auto-report-recent');
      recent.appendChild(el('div', 'auto-report-sub', 'Latest turns'));
      for (const t of s.recent) {
        const row = el('div', 'auto-report-turn');
        row.append(
          el('span', 'auto-report-model ' + t.model, NAMES[t.model] || t.model),
          el('span', 'auto-report-title', t.title || '(untitled)'),
          el('span', 'auto-report-num', `${money(t.actual)} vs ${money(t.opus)}${t.switched ? ' · switched' : ''}${t.failedStepUp ? ' · stepped up' : ''}`),
        );
        recent.appendChild(row);
      }
      card.appendChild(recent);
    }
    const buttons = el('div', 'quit-buttons');
    const resetBtn = el('button', 'quit-stay', 'Start over');
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

  return { noteRating, recordTurn, contextOf, summary, open, reset };
})();

window.autoReport = autoReport;
