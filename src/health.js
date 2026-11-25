// Project health (the heartbeat button on the Hub's left side): what in the
// live game needs your attention, from a Tactile BI project health
// dashboard: crashes and exceptions, and player support.
//
// Each project (Settings → Project health) is a Tactile BI dashboard.
// Enchanted Inn's "Project Health" dashboard is the first one until you
// change the list. Adding one only takes the dashboard's link: the app finds
// its charts itself, by their titles (crashCharts, resolve). It reads them
// through the app's own Tactile BI sign-in (src/mcpclient.js), so no model
// reads them and it costs no tokens:
//
//  - every 30 minutes it reads the charts' cached rows (free);
//  - every few hours it asks BI to run them again first, so new data comes in
//    (small BigQuery queries, refused by BI above its cost cap);
//  - from the crash charts (Embrace's crashes, ANRs, out-of-memory kills,
//    Unity exceptions and handled errors, per 1,000 daily players) it raises
//    a warning for: a rate that grows against the period before, a day with
//    far more than usual, an app version with far more than the others, and
//    a new crash or exception that already hits many devices;
//  - from the support message log (one row per player message, with its
//    topic, tone, English text and conversation) it raises a warning for: a
//    topic that grows fast, a day with far more messages than usual, several
//    players with the same complaint in the last 3 days, and mostly unhappy
//    messages. The dashboard's written analysis of the messages (a text
//    chart Claude keeps up to date) shows too.
//
// Warnings you have not looked at show as a red count on the button; opening
// the view marks them seen (kept in health.json in the settings folder). The
// deeper look is an agent: on the support messages with the game project's
// UserSupportDigest skill, or on one crash or exception, started from the
// view.

const fs = require('fs');
const path = require('path');
const { makeClient } = require('./mcpclient');

const bi = makeClient({ server: 'https://bi-mcp.tactilews.com', name: 'bi', label: 'Tactile BI' });

// The list until you change it: Enchanted Inn's project health dashboard
// (crashes and player support).
const DEFAULT_PROJECTS = [{
  id: 'ei', name: 'Enchanted Inn',
  dashboardId: '6b06d906d5aa60cf42fd3829', filterGroup: '', chartId: '6b06d9d6e82664c3b1e2d899',
}];
const DAYS = '30';
const READ_EVERY = 30 * 60 * 1000;
const RUN_EVERY = 3 * 60 * 60 * 1000;
const CRASH_RUN_EVERY = 6 * 60 * 60 * 1000;   // the crash charts change once a day (today is left out)
const DAY = 24 * 60 * 60 * 1000;

let file = null;
let state = null;   // { seen: [warning ids], lastRun: { project: time }, reports: { project: report } }
let onChange = () => {};
let timer = null;
let busy = null;
let getConfig = () => ({});

function setup(userData, config, notify) {
  bi.setup(userData);
  file = path.join(userData, 'health.json');
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { state = {}; }
  state.seen ||= [];
  state.reports ||= {};
  if (typeof state.lastRun !== 'object' || !state.lastRun) state.lastRun = {};
  delete state.report;   // from before projects
  getConfig = config;
  onChange = notify;
  clearInterval(timer);
  timer = setInterval(() => check().catch(() => {}), READ_EVERY);
  setTimeout(() => check().catch(() => {}), 15000);
}

function save() {
  try { fs.writeFileSync(file, JSON.stringify(state)); } catch { /* kept for this run */ }
}

// The projects to watch (Settings → Project health): [{ id, name,
// dashboardId, filterGroup, chartId, folder }]. Until you change the list:
// Enchanted Inn. An older single dashboard setting (healthSupport) counts as
// one project.
function projects() {
  const c = getConfig();
  if (Array.isArray(c.healthProjects)) return c.healthProjects.filter(p => p?.dashboardId && p?.chartId);
  const old = c.healthSupport || {};
  if (old.dashboardId && old.messagesChart && old.dashboardId !== DEFAULT_PROJECTS[0].dashboardId) {
    return [{ id: 'p1', name: old.title || 'Player support', dashboardId: old.dashboardId, filterGroup: old.filterGroup || '', chartId: old.messagesChart }];
  }
  return DEFAULT_PROJECTS;
}

const dashboardUrl = p => `https://bi.tactilews.com/dashboards/${p.dashboardId}${p.filterGroup ? `?filterGroup=${p.filterGroup}` : ''}`;

function summary() {
  const list = projects().map(p => ({ id: p.id, name: p.name, folder: p.folder || '', dashboardUrl: dashboardUrl(p), chartId: p.chartId, dashboardId: p.dashboardId, report: state.reports[p.id] || null }));
  const unseen = list.reduce((n, p) => n + (p.report?.warnings || []).filter(w => !state.seen.includes(w.id)).length, 0);
  return { connected: bi.status().connected, email: bi.status().email, projects: list, unseen };
}

// A project's message rows, its chart run again first when the last run is
// old (or force).
async function readRows(p, force) {
  const args = { chartId: p.chartId, filterOverrides: { daterange: DAYS } };
  if (p.filterGroup) args.activeFilterGroupId = p.filterGroup;
  const run = async () => {
    await bi.callTool('bi_run_chart', { ...args, dashboardId: p.dashboardId });
    state.lastRun[p.id] = Date.now();
  };
  if (force || Date.now() - (state.lastRun[p.id] || 0) > RUN_EVERY) await run().catch(() => {});
  let data = await bi.callTool('bi_get_chart_data', args);
  if (data?.cached === false) { await run(); data = await bi.callTool('bi_get_chart_data', args); }
  return messagesOf(data);
}

// The messages in a chart's data, or an error when it is not a message log.
function messagesOf(data) {
  const q = data?.queryResults?.[0];
  if (!q?.columns) throw new Error('Tactile BI sent no rows for that chart.');
  const col = Object.fromEntries(q.columns.map((c, i) => [c.name, i]));
  const text = col.message_en ?? col.message ?? col.message_original ?? col.text ?? col.body;
  const at = col.sent_at ?? col.created_at ?? col.timestamp ?? col.message_date ?? col.date;
  if (text === undefined || at === undefined) throw new Error('That chart is not a message log: it needs a message text column (message_en or message) and a time column (sent_at or message_date).');
  return (q.rows || []).map(r => ({
    topic: r[col.message_topic ?? col.topic] || 'Other',
    tone: r[col.tone_heuristic ?? col.tone ?? col.sentiment] || '',
    text: r[text] || r[col.message_original] || '',
    original: r[col.message_original] || '',
    conversation: r[col.conversation_id ?? col.conversation ?? col.user_id] || '',
    at: r[at] || '',
  })).filter(m => m.at);
}

// Adding a project from a dashboard's link (or id): its title, and its
// message log chart, found by itself: the table charts, those named like a
// message log first, and the first whose rows are messages.
async function resolve(link) {
  const dashboardId = /dashboards\/([a-f0-9]{24})/i.exec(link)?.[1] || (/^[a-f0-9]{24}$/i.test(String(link).trim()) ? String(link).trim() : '');
  if (!dashboardId) throw new Error('Paste the link of a Tactile BI dashboard (https://bi.tactilews.com/dashboards/…).');
  const filterGroup = /filterGroup=([a-f0-9]{24})/i.exec(link)?.[1] || '';
  const chartInLink = /[?&]chart=([a-f0-9]{24})/i.exec(link)?.[1] || '';
  const st = await bi.callTool('bi_get_dashboard_structure', { dashboardId });
  const charts = [];
  for (const tab of st?.tabs || []) {
    for (const c of tab.unsectionedCharts || []) charts.push({ ...c, section: '' });
    for (const sec of tab.sections || []) for (const c of sec.charts || []) charts.push({ ...c, section: sec.name || '' });
  }
  const named = c => /message|log|conversation|ticket/i.test(`${c.title} ${c.section}`);
  const order = [...charts.filter(c => c.chartId === chartInLink), ...charts.filter(c => c.chartType === 'table' && named(c)), ...charts.filter(c => c.chartType === 'table' && !named(c))];
  const tried = new Set();
  for (const c of order) {
    if (tried.has(c.chartId)) continue;
    tried.add(c.chartId);
    const args = { chartId: c.chartId, filterOverrides: { daterange: DAYS } };
    if (filterGroup) args.activeFilterGroupId = filterGroup;
    try {
      let data = await bi.callTool('bi_get_chart_data', args);
      if (data?.cached === false) { await bi.callTool('bi_run_chart', { ...args, dashboardId }); data = await bi.callTool('bi_get_chart_data', args); }
      const messages = messagesOf(data);
      const title = String(st.title || 'Player support');
      return {
        id: 'p' + dashboardId.slice(-8), dashboardId, filterGroup, chartId: c.chartId, chartTitle: c.title,
        // "Enchanted Inn – User Support Messages" → "Enchanted Inn".
        name: title.split(/\s+[–—-]\s+/)[0].replace(/\s+project health$/i, '').trim() || title, dashboardTitle: title, messages: messages.length,
      };
    } catch { /* not a message log: the next one */ }
  }
  throw new Error(`"${st?.title || 'That dashboard'}" has no message log chart: a table with one row per message (a text column like message_en and a time column like sent_at).`);
}

// Dashboards to pick from: Tactile BI's dashboards whose title says health
// (crashes and support) or support.
async function findDashboards() {
  const [health, support] = await Promise.all(['health', 'support'].map(search => bi.callTool('bi_list_dashboards', { search, limit: 30 }).catch(() => null)));
  const seen = new Set();
  return [...(health?.dashboards || []), ...(support?.dashboards || [])].filter(d => !seen.has(d._id) && seen.add(d._id)).map(d => ({ id: d._id, title: d.title, updatedAt: d.updatedAt }));
}

// The numbers and the warnings from the messages.
function analyse(messages, now = Date.now()) {
  const t = m => Date.parse(m.at) || 0;
  const within = (from, to) => messages.filter(m => t(m) > now - from && t(m) <= now - to);
  const last24 = within(DAY, 0), last7 = within(7 * DAY, 0), prev7 = within(14 * DAY, 7 * DAY), last3 = within(3 * DAY, 0);
  const count = (list, key) => list.reduce((map, m) => map.set(key(m), (map.get(key(m)) || 0) + 1), new Map());
  const topicsNow = count(last7, m => m.topic), topicsBefore = count(prev7, m => m.topic);
  const topics = [...new Set([...topicsNow.keys(), ...topicsBefore.keys()])]
    .map(name => ({ name, week: topicsNow.get(name) || 0, before: topicsBefore.get(name) || 0 }))
    .sort((a, b) => b.week - a.week || b.before - a.before);
  const negative = list => list.filter(m => /neg/i.test(m.tone)).length;
  const conversations = list => new Set(list.map(m => m.conversation)).size;
  const week = Math.floor(now / (7 * DAY));
  const warnings = [];
  // Topics that grow fast this week.
  for (const tp of topics) {
    if (tp.week >= 5 && tp.week >= Math.max(2, tp.before) * 1.5 && !/thank/i.test(tp.name)) {
      warnings.push({ id: `grow:${tp.name}:${week}`, level: tp.week >= 10 && tp.week >= tp.before * 2.5 ? 'high' : 'medium', topic: tp.name,
        title: `${tp.name} grows: ${tp.week} messages this week`, text: `Last week: ${tp.before}. Players write about it ${tp.before ? `${Math.round(tp.week / tp.before * 10) / 10} times as often` : 'for the first time this month'}.` });
    }
  }
  // A day with far more messages than usual.
  const dailyBefore = within(8 * DAY, DAY).length / 7;
  if (last24.length >= 6 && last24.length >= dailyBefore * 2) {
    warnings.push({ id: `day:${Math.floor(now / DAY)}`, level: 'high', title: `${last24.length} messages in the last 24 hours`,
      text: `Usually about ${Math.round(dailyBefore)} a day. Something may have broken in the last release or event.` });
  }
  // The same complaint from several players in the last 3 days.
  const unhappy = last3.filter(m => /neg/i.test(m.tone) && !/thank/i.test(m.topic));
  for (const [name, n] of count(unhappy, m => m.topic)) {
    const players = conversations(unhappy.filter(m => m.topic === name));
    if (players >= 3) {
      warnings.push({ id: `players:${name}:${Math.floor(now / (3 * DAY))}`, level: players >= 5 ? 'high' : 'medium', topic: name,
        title: `${players} players complain about ${name.toLowerCase()} in 3 days`, text: `${n} unhappy messages since ${new Date(now - 3 * DAY).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}. Worth a look for a bug.` });
    }
  }
  // Mostly unhappy messages this week.
  if (last7.length >= 10 && negative(last7) / last7.length >= 0.6) {
    warnings.push({ id: `mood:${week}`, level: 'medium', title: `${Math.round(negative(last7) / last7.length * 100)}% of this week's messages are unhappy`,
      text: `${negative(last7)} of ${last7.length} messages.` });
  }
  const order = { high: 0, medium: 1 };
  warnings.sort((a, b) => order[a.level] - order[b.level]);
  // The latest conversations (3 days), newest first, each with its messages.
  const byConv = new Map();
  for (const m of [...last3].sort((a, b) => t(a) - t(b))) {
    if (!byConv.has(m.conversation)) byConv.set(m.conversation, []);
    byConv.get(m.conversation).push(m);
  }
  const recent = [...byConv.entries()].map(([id, list]) => ({ id, messages: list, at: list[list.length - 1].at, topic: list[list.length - 1].topic, unhappy: list.some(m => /neg/i.test(m.tone)) }))
    .sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 40);
  return {
    // A log with only the day of each message (message_date) has no hours:
    // the view then says "today" and shows dates instead of "3 h ago".
    stats: { day: last24.length, week: last7.length, before: prev7.length, conversations: conversations(last7), unhappy: negative(last7), total: messages.length,
      dateOnly: messages.length > 0 && messages.every(m => /^\d{4}-\d{2}-\d{2}$/.test(String(m.at))) },
    topics, warnings, recent,
  };
}

// ---------- crashes ----------

// The crash charts of a dashboard, found by their titles (Enchanted Inn's
// Project Health names): { stability, daily, versions, groups, exceptions,
// errors, analysis }. Read again once a day, so a renamed or added chart
// comes in.
const CRASH_TITLES = {
  stability: c => c.chartType === 'table' && /stability/i.test(c.title),
  daily: c => /^daily events per/i.test(c.title),
  versions: c => /by app version/i.test(c.title) && !/^daily/i.test(c.title),
  groups: c => /top crash groups/i.test(c.title),
  exceptions: c => /top unity exceptions/i.test(c.title),
  errors: c => /top handled errors/i.test(c.title),
  analysis: c => c.chartType === 'text' && /sentiment analysis/i.test(c.title) && !/refresh|how to/i.test(c.title),
};
async function crashCharts(p) {
  state.charts ||= {};
  const hit = state.charts[p.dashboardId];
  if (hit && Date.now() - hit.at < DAY) return hit.ids;
  const st = await bi.callTool('bi_get_dashboard_structure', { dashboardId: p.dashboardId });
  const charts = [];
  for (const tab of st?.tabs || []) {
    for (const c of tab.unsectionedCharts || []) charts.push(c);
    for (const sec of tab.sections || []) charts.push(...(sec.charts || []));
  }
  const ids = {};
  for (const [key, match] of Object.entries(CRASH_TITLES)) ids[key] = charts.find(match)?.chartId || '';
  state.charts[p.dashboardId] = { at: Date.now(), ids };
  return ids;
}

// One chart's rows as objects ({ column: value }), its default view (the
// dashboard's own range, 30 days), run again first when that is old.
async function chartRows(p, chartId, force) {
  const args = { chartId };
  if (p.filterGroup) args.activeFilterGroupId = p.filterGroup;
  state.lastRun ||= {};
  const key = `${p.id}:${chartId}`;
  const run = async () => {
    await bi.callTool('bi_run_chart', { ...args, dashboardId: p.dashboardId });
    state.lastRun[key] = Date.now();
  };
  if (force || Date.now() - (state.lastRun[key] || 0) > CRASH_RUN_EVERY) await run().catch(() => {});
  let data = await bi.callTool('bi_get_chart_data', args);
  if (data?.cached === false) { await run(); data = await bi.callTool('bi_get_chart_data', args); }
  const q = data?.queryResults?.[0];
  if (!q?.columns) return [];
  return (q.rows || []).map(r => Object.fromEntries(q.columns.map((c, i) => [c.name, r[i]])));
}

async function readCrashes(p, force) {
  const ids = await crashCharts(p);
  if (!ids.stability) return null;   // a support-only dashboard
  const read = id => (id ? chartRows(p, id, force).catch(() => []) : Promise.resolve([]));
  const [stability, daily, versions, groups, exceptions, errors] = [
    await read(ids.stability), await read(ids.daily), await read(ids.versions), await read(ids.groups), await read(ids.exceptions), await read(ids.errors)];
  let analysis = null;
  if (ids.analysis) {
    const c = await bi.callTool('bi_get_chart', { chartId: ids.analysis }).catch(() => null);
    if (c?.config?.text?.content) analysis = { text: c.config.text.content, at: c.updatedAt || '' };
  }
  return { stability, daily, versions, groups, exceptions, errors, analysis };
}

const CRASH_TYPES = ['Crash', 'ANR', 'Out of memory', 'Unity exception'];
const TYPE_WORDS = { Crash: 'crashes', ANR: 'ANRs (app not responding)', 'Out of memory': 'out-of-memory kills', 'Unity exception': 'Unity exceptions' };
const median = xs => { const a = xs.filter(x => Number.isFinite(x)).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };
// TactileModules.MergeGameUI.BoardInput.HideHover → BoardInput.HideHover;
// a compiler-made name (Foo+<Bar>d__9.MoveNext) → Foo.Bar.
const shortMethod = m => {
  const s = String(m || '').replace(/\+<([^>]+)>d__\d+\.MoveNext$/, '.$1').replace(/\.\.ctor$/, '.constructor');
  return s.split('.').slice(-2).join('.') || s;
};
const shortFrame = f => {
  const s = String(f || '');
  if (!s || s === '(no frame)') return '';
  return s.replace(/\(.*\)$/s, '').replace(/^-\[|\]$/g, '').replace(/^.*::(?=[^:]+::[^:]+$)/, '').slice(0, 90);
};

// The numbers and the warnings from the crash charts.
function analyseCrashes(c, now = Date.now()) {
  const num = v => Number(v) || 0;
  const days = d => (now - Date.parse(d)) / DAY;
  // The rates, with the last 30 days of each as a line.
  const byType = new Map(c.stability.map(r => [r.type, r]));
  const daily = new Map(CRASH_TYPES.map(t => [t, c.daily.filter(r => r.type === t).sort((a, b) => String(a.date).localeCompare(String(b.date))).map(r => num(r.per_1k_dau))]));
  const rates = CRASH_TYPES.filter(t => byType.has(t)).map(t => {
    const r = byType.get(t);
    return { type: t, per1k: num(r.per_1k_dau), before: num(r.per_1k_dau_previous_period), change: num(r.change_vs_previous), events: num(r.events), devices: num(r.devices_affected), line: daily.get(t) || [] };
  });
  // Crash groups: the ANR and out-of-memory rows without a stack are the
  // rates above already, so they are left out here. The same group can show
  // as a crash and as out of memory: kept once.
  const seen = new Set();
  const groups = c.groups.filter(r => !(r.type !== 'Crash' && (!r.top_frame || r.top_frame === '(no frame)')))
    .filter(r => { const k = r.crash_group_id || `${r.type}${r.signal}${r.top_frame}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .map(r => ({ type: r.type, platform: r.platform || '', what: shortFrame(r.top_frame) || r.signal || 'Unknown native crash', signal: r.signal || '', frame: r.top_frame || '',
      events: num(r.events), devices: num(r.devices), versions: String(r.latest_versions || '').split(',').filter(Boolean), first: r.first_seen || '', last: r.last_seen || '',
      id: r.crash_group_id || '', isNew: days(r.first_seen) <= 14 }));
  const exceptions = c.exceptions.map(r => ({ what: shortMethod(r.method), method: r.method || '', platforms: r.platforms || '', events: num(r.exceptions), devices: num(r.devices),
    versions: String(r.latest_versions || '').split(',').filter(Boolean), first: r.first_seen || '', last: r.last_seen || '', id: r.crash_group_id || '', isNew: days(r.first_seen) <= 14 }));
  // Handled errors: the same error comes from two sources (clientError and
  // Embrace's log of it): kept once, with the most players.
  const errs = new Map();
  for (const r of c.errors) {
    const name = String(r.error || '').replace(/^ClientErrorEvent - /, '');
    const cur = errs.get(name);
    if (!cur || num(r.players) > cur.players) errs.set(name, { what: name, players: num(r.players), events: num(r.events), versions: String(r.latest_versions || '').split(',').filter(Boolean), last: r.last_seen || '' });
  }
  const errors = [...errs.values()].sort((a, b) => b.players - a.players);
  // Versions: the rates of the newest ones against the others.
  const vrows = c.versions.map(r => ({ version: r.version, type: r.type, per1k: num(r.per_1k_dau), events: num(r.events) }));
  const versionList = [...new Set(vrows.map(r => r.version))];
  const newest = versionList.slice(-3);

  const warnings = [];
  const week = Math.floor(now / (7 * DAY));
  const fmt = x => (x >= 10 ? Math.round(x) : Math.round(x * 100) / 100);
  // A rate that grows against the period before.
  for (const r of rates) {
    if (r.change >= 0.25 && r.events >= 30) {
      const big = r.change >= 0.5 && r.type !== 'Out of memory';
      warnings.push({ id: `rate:${r.type}:${week}`, level: big ? 'high' : 'medium', tab: 'crashes',
        title: `${TYPE_WORDS[r.type][0].toUpperCase() + TYPE_WORDS[r.type].slice(1)} up ${Math.round(r.change * 100)}%`,
        text: `${fmt(r.per1k)} per 1,000 daily players in the last 30 days, against ${fmt(r.before)} the 30 days before. ${r.devices.toLocaleString()} devices hit.` });
    }
  }
  // A day with far more than usual (yesterday: today is still filling).
  for (const t of CRASH_TYPES) {
    const line = daily.get(t) || [];
    if (line.length < 8) continue;
    const last = line[line.length - 1], usual = median(line.slice(-15, -1));
    const lastRow = c.daily.filter(r => r.type === t).sort((a, b) => String(a.date).localeCompare(String(b.date))).pop();
    if (usual > 0 && last >= usual * 2 && num(lastRow?.events) >= 20) {
      warnings.push({ id: `spike:${t}:${lastRow.date}`, level: 'high', tab: 'crashes',
        title: `${TYPE_WORDS[t][0].toUpperCase() + TYPE_WORDS[t].slice(1)} jumped on ${new Date(lastRow.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`,
        text: `${fmt(last)} per 1,000 daily players, usually about ${fmt(usual)}. ${num(lastRow.events)} that day.` });
    }
  }
  // An app version with far more than the others.
  for (const v of newest) {
    for (const t of CRASH_TYPES) {
      const row = vrows.find(r => r.version === v && r.type === t);
      const others = median(vrows.filter(r => r.version !== v && r.type === t).map(r => r.per1k));
      if (row && others > 0 && row.per1k >= others * 2.5 && row.events >= 30) {
        warnings.push({ id: `version:${v}:${t}`, level: row.per1k >= others * 5 ? 'high' : 'medium', tab: 'crashes',
          title: `${v} has ${Math.round(row.per1k / others)}× the usual ${TYPE_WORDS[t]}`,
          text: `${fmt(row.per1k)} per 1,000 daily players on ${v}, about ${fmt(others)} on the other versions. ${row.events} in the last 30 days.` });
      }
    }
  }
  // A new crash or exception that already hits many devices.
  for (const g of groups) {
    if (g.isNew && g.devices >= 25) warnings.push({ id: `newcrash:${g.id || g.what}`, level: g.devices >= 100 ? 'high' : 'medium', tab: 'crashes', item: { kind: 'crash', ...g },
      title: `New crash: ${g.what}`, text: `${g.devices} devices since ${new Date(g.first).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} (${g.platform}${g.versions[0] ? `, latest ${g.versions[0]}` : ''}).` });
  }
  for (const e of exceptions) {
    if (e.isNew && e.devices >= 25) warnings.push({ id: `newexc:${e.id || e.method}`, level: e.devices >= 100 ? 'high' : 'medium', tab: 'crashes', item: { kind: 'exception', ...e },
      title: `New exception in ${e.what}`, text: `${e.devices} devices since ${new Date(e.first).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}${e.versions[0] ? `, latest ${e.versions[0]}` : ''}.` });
  }
  return { rates, groups: groups.slice(0, 25), exceptions: exceptions.slice(0, 25), errors: errors.slice(0, 10), analysis: c.analysis || null, warnings,
    versions: newest.map(v => ({ version: v, rates: Object.fromEntries(CRASH_TYPES.map(t => [t, vrows.find(r => r.version === v && r.type === t)?.per1k ?? null])) })) };
}

// One look at every project. Resolves with the summary.
function check(force = false) {
  // Off in Settings → Project health: no reading at all.
  if (!bi.status().connected || getConfig().featureHealth === false) return Promise.resolve(summary());
  busy ||= (async () => {
    for (const p of projects()) {
      try {
        const messages = await readRows(p, force);
        const report = analyse(messages);
        for (const w of report.warnings) w.tab = 'support';
        // Crashes, when the dashboard has them. A failure there leaves the
        // support part as it is, with the error.
        let crashes = null, crashError = null;
        try {
          const c = await readCrashes(p, force);
          if (c) crashes = analyseCrashes(c);
        } catch (err) { if (err.notConnected) throw err; crashError = err.message; }
        const order = { high: 0, medium: 1 };
        report.warnings = [...(crashes?.warnings || []), ...report.warnings].sort((a, b) => order[a.level] - order[b.level]);
        if (crashes) delete crashes.warnings;
        // Each warning belongs to its project (seen per project).
        for (const w of report.warnings) w.id = `${p.id}:${w.id}`;
        state.reports[p.id] = { at: Date.now(), ...report, crashes, crashError, error: null };
      } catch (err) {
        if (err.notConnected) { state.reports = {}; break; }
        state.reports[p.id] = { ...(state.reports[p.id] || {}), error: err.message, errorAt: Date.now() };
      }
    }
    // Projects no longer in the list are forgotten.
    const ids = new Set(projects().map(p => p.id));
    for (const id of Object.keys(state.reports)) if (!ids.has(id)) delete state.reports[id];
    save();
    const out = summary();
    onChange(out);
    return out;
  })().finally(() => { busy = null; });
  return busy;
}

function markSeen() {
  const ids = Object.values(state.reports).flatMap(r => (r?.warnings || []).map(w => w.id));
  state.seen = [...new Set([...state.seen, ...ids])].slice(-500);
  save();
  const out = summary();
  onChange(out);
  return out;
}

async function connect() {
  const st = await bi.connect();
  check(true).catch(() => {});
  return st;
}

function disconnect() {
  const st = bi.disconnect();
  state.reports = {};
  save();
  onChange(summary());
  return st;
}

// The folder of a game project with the UserSupportDigest skill, among the
// folders the app knows (the Hub's agents and groups).
function digestFolder(folders) {
  const has = dir => fs.existsSync(path.join(dir, '.claude', 'skills', 'UserSupportDigest', 'SKILL.md'));
  for (const f of folders || []) {
    if (!f) continue;
    // The folder's own subfolders too (MergeTavern → MergeTavern/Unity).
    try { for (const d of fs.readdirSync(f, { withFileTypes: true })) if (d.isDirectory() && !d.name.startsWith('.') && has(path.join(f, d.name))) return path.join(f, d.name); } catch { /* not readable */ }
    let dir = f;
    for (let i = 0; i < 4 && dir; i++) {
      if (has(dir)) return dir;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return null;
}

module.exports = { setup, summary, check, markSeen, connect, disconnect, digestFolder, analyse, analyseCrashes, resolve, findDashboards };
