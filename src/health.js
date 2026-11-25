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
// Red is kept for a real issue: one crash or exception that hits 0.5% of
// the daily players or more on a day (its devices that day against the
// day's players). Everything else that is worth a look is amber.
//
// Each crash and exception also gets its devices per day for the last 30
// days (one small query on the dashboard's own crash table, every few
// hours), so the view can draw it and see one spiking.
//
// Red warnings you have not looked at show as a red count on the button; opening
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
  const unseen = list.reduce((n, p) => n + (p.report?.warnings || []).filter(w => w.level === 'high' && !state.seen.includes(w.id)).length, 0);
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

// The support numbers for one of the view's ranges (1, 3 or 7 days): the
// messages in it against the same time just before, by topic, and its
// conversations. A log with only dates counts a message at the end of its
// day, so "the last 24 hours" covers today and yesterday.
function supportRange(messages, days, now = Date.now()) {
  const span = days * DAY;
  const t = m => (/^\d{4}-\d{2}-\d{2}$/.test(String(m.at)) ? Date.parse(m.at) + DAY - 1 : Date.parse(m.at) || 0);
  const inNow = messages.filter(m => t(m) > now - span);
  const inBefore = messages.filter(m => t(m) > now - 2 * span && t(m) <= now - span);
  const count = (list, key) => list.reduce((map, m) => map.set(key(m), (map.get(key(m)) || 0) + 1), new Map());
  const a = count(inNow, m => m.topic), b = count(inBefore, m => m.topic);
  const topics = [...new Set([...a.keys(), ...b.keys()])].map(name => ({ name, week: a.get(name) || 0, before: b.get(name) || 0 }))
    .sort((x, y) => y.week - x.week || y.before - x.before);
  const byConv = new Map();
  for (const m of [...inNow].sort((x, y) => t(x) - t(y))) {
    if (!byConv.has(m.conversation)) byConv.set(m.conversation, []);
    byConv.get(m.conversation).push(m);
  }
  const recent = [...byConv.entries()].map(([id, list]) => ({ id, messages: list, at: list[list.length - 1].at, topic: list[list.length - 1].topic, unhappy: list.some(m => /neg/i.test(m.tone)) }))
    .sort((x, y) => (x.at < y.at ? 1 : -1)).slice(0, 60);
  return { days, stats: { messages: inNow.length, before: inBefore.length, players: new Set(inNow.map(m => m.conversation)).size, unhappy: inNow.filter(m => /neg/i.test(m.tone)).length }, topics, recent };
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
    byRange: Object.fromEntries([1, 3, 7].map(n => [n, supportRange(messages, n, now)])),
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
  if (hit && Date.now() - hit.at < DAY && 'table' in hit.ids) return hit.ids;
  const st = await bi.callTool('bi_get_dashboard_structure', { dashboardId: p.dashboardId });
  const charts = [];
  for (const tab of st?.tabs || []) {
    for (const c of tab.unsectionedCharts || []) charts.push(c);
    for (const sec of tab.sections || []) charts.push(...(sec.charts || []));
  }
  const ids = {};
  for (const [key, match] of Object.entries(CRASH_TITLES)) ids[key] = charts.find(match)?.chartId || '';
  // The BigQuery table the crash groups come from (its query's FROM), for
  // each crash's days (crashTrends).
  ids.table = '';
  try {
    const chart = ids.groups ? await bi.callTool('bi_get_chart', { chartId: ids.groups }) : null;
    const q = chart?.queryIds?.[0] ? await bi.callTool('bi_get_query', { queryId: chart.queryIds[0] }) : null;
    const t = /FROM\s+`([\w-]+\.[\w-]+\.[\w-]+)`/i.exec(q?.query || '')?.[1];
    if (t) ids.table = t;
  } catch { /* no days per crash then */ }
  state.charts[p.dashboardId] = { at: Date.now(), ids };
  return ids;
}

// One chart's rows as objects ({ column: value }), its default view (the
// dashboard's own range, 30 days), run again first when that is old.
async function chartRows(p, chartId, force, days = null) {
  const args = { chartId };
  if (p.filterGroup) args.activeFilterGroupId = p.filterGroup;
  if (days) args.filterOverrides = { daterange: String(days) };
  state.lastRun ||= {};
  const key = `${p.id}:${chartId}${days ? `:${days}` : ''}`;
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

// For these crash group ids, one query on the dashboard's crash table (it
// reads only the last 31 days: a few MB), kept an hour:
//  - days: devices and events per day, the last 31 days and today so far
//    (a crash taking off today must show);
//  - hours: per hour (UTC), the last 72 hours, for the 24-hour and 3-day
//    views;
//  - ranges: the devices (players) and events (cases) of exactly the last
//    24 hours, 3 days and 7 days, so the view's numbers are those, not the
//    dashboard's calendar days.
// Resolves with { id: { days: [{ date, devices, events }], hours: [{ hour,
// devices, events }], ranges: { 1|3|7: { devices, events } } } }.
async function crashTrends(p, groupIds, force = false) {
  const ids = await crashCharts(p);
  if (!ids.table) return {};
  const want = [...new Set(groupIds)].filter(x => /^[A-Za-z0-9]{8,64}$/.test(x || '')).slice(0, 150);
  if (!want.length) return {};
  state.trends ||= {};
  const hit = state.trends[p.id]?.v === 2 ? state.trends[p.id] : null;
  const fresh = hit && Date.now() - hit.at < 60 * 60 * 1000 && new Date(hit.at).toDateString() === new Date().toDateString();
  if (!force && fresh && want.every(id => id in hit.byId)) return hit.byId;
  const within = h => `occurredAt >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${h} HOUR)`;
  const sql = `WITH c AS (SELECT crashGroupId AS id, partitionDate, occurredAt, deviceId FROM \`${ids.table}\`
  WHERE partitionDate >= DATE_SUB(CURRENT_DATE(), INTERVAL 31 DAY) AND crashGroupId IN (${want.map(x => `'${x}'`).join(', ')}))
SELECT 'd' AS kind, id, CAST(partitionDate AS STRING) AS k, COUNT(*) AS events, COUNT(DISTINCT deviceId) AS devices FROM c GROUP BY 2, 3
UNION ALL SELECT 'h', id, FORMAT_TIMESTAMP('%Y-%m-%dT%H', occurredAt), COUNT(*), COUNT(DISTINCT deviceId) FROM c WHERE ${within(72)} GROUP BY 2, 3
UNION ALL SELECT 'r1', id, NULL, COUNT(*), COUNT(DISTINCT deviceId) FROM c WHERE ${within(24)} GROUP BY 2
UNION ALL SELECT 'r3', id, NULL, COUNT(*), COUNT(DISTINCT deviceId) FROM c WHERE ${within(72)} GROUP BY 2
UNION ALL SELECT 'r7', id, NULL, COUNT(*), COUNT(DISTINCT deviceId) FROM c WHERE ${within(168)} GROUP BY 2`;
  const r = await bi.callTool('bi_run_sql_preview', { sql, previewLimit: 10000 });
  const col = Object.fromEntries((r?.columns || []).map((c, i) => [c.name, i]));
  const byId = fresh ? { ...hit.byId } : {};
  for (const id of want) byId[id] = { days: [], hours: [], ranges: { 1: { devices: 0, events: 0 }, 3: { devices: 0, events: 0 }, 7: { devices: 0, events: 0 } } };
  for (const row of r?.rows || []) {
    const x = byId[row[col.id]];
    if (!x) continue;
    const v = { devices: Number(row[col.devices]) || 0, events: Number(row[col.events]) || 0 };
    const kind = row[col.kind];
    if (kind === 'd') x.days.push({ date: row[col.k], ...v });
    else if (kind === 'h') x.hours.push({ hour: row[col.k], ...v });
    else x.ranges[kind.slice(1)] = v;
  }
  for (const id of want) { byId[id].days.sort((a, b) => a.date.localeCompare(b.date)); byId[id].hours.sort((a, b) => a.hour.localeCompare(b.hour)); }
  state.trends[p.id] = { v: 2, at: Date.now(), byId };
  return byId;
}

// The trend of one crash for the view: its devices on each of the last 30
// full days and today so far (0 on a day without it; the last one is
// today), its peak share of the day's players in the last `days` days and
// today (today's against yesterday's players: today has none yet), and
// whether it is spiking (yesterday or today at least twice its usual, and
// at least 10 devices).
const SHARE_RED = 0.005;
function trendOf(rec, dau, days, now = Date.now()) {
  if (!rec) return null;
  const rows = rec.days || [];
  const byDate = new Map(rows.map(r => [r.date, r]));
  const dates = [];
  for (let i = 30; i >= 0; i--) dates.push(new Date(now - i * DAY).toISOString().slice(0, 10));
  const devices = dates.map(d => byDate.get(d)?.devices || 0);
  const events = dates.map(d => byDate.get(d)?.events || 0);
  const n = dates.length;
  const players = d => dau[d] || dau[dates[n - 2]] || 0;
  const shares = dates.map((d, i) => (players(d) ? devices[i] / players(d) : 0));
  const recent = shares.slice(-(Math.max(1, days) + 1));
  const peak = Math.max(0, ...recent);
  const peakAt = dates[n - recent.length + recent.indexOf(peak)];
  const last = Math.max(devices[n - 1], devices[n - 2]);
  const usual = median(devices.slice(-16, -2));
  // The last 72 hours, hour by hour (UTC keys up to this hour).
  const byHour = new Map((rec.hours || []).map(r => [r.hour, r]));
  const hourKeys = [];
  for (let i = 71; i >= 0; i--) hourKeys.push(new Date(now - i * 3600e3).toISOString().slice(0, 13));
  const hours = hourKeys.map(k => byHour.get(k)?.devices || 0);
  // This range exactly: its players (devices) and cases (events), and its
  // players against the daily players of those days (about: a player can
  // be counted once over several days).
  const range = rec.ranges?.[days] || null;
  const daily = dates.slice(-(days + 1), -1).map(d => dau[d]).filter(Boolean);
  const avgDau = daily.length ? daily.reduce((a, b) => a + b, 0) / daily.length : players(dates[n - 2]);
  return { dates, devices, events, today: true, hourKeys, hours, range, rangeShare: range && avgDau ? range.devices / avgDau : 0,
    share: peak, shareAt: peakAt, players: players(peakAt), lastShare: shares[n - 1], hot: peak >= SHARE_RED, spiking: last >= 10 && last >= Math.max(1, usual) * 2 };
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

// The crash groups, Unity exceptions and handled errors of a chart read,
// as the view shows them. isNew: first seen in the last 14 days. firstSeen
// (group id → date) comes from the 30-day read when this read is shorter,
// because in a shorter read every group starts inside it.
function listsOf(c, now = Date.now(), firstSeen = null) {
  const num = v => Number(v) || 0;
  const days = d => (now - Date.parse(d)) / DAY;
  const first = r => firstSeen?.get(r.crash_group_id) || r.first_seen || '';
  // Crash groups: the ANR and out-of-memory rows without a stack are the
  // rates already, so they are left out here. The same group can show as a
  // crash and as out of memory: kept once.
  const seen = new Set();
  const groups = (c.groups || []).filter(r => !(r.type !== 'Crash' && (!r.top_frame || r.top_frame === '(no frame)')))
    .filter(r => { const k = r.crash_group_id || `${r.type}${r.signal}${r.top_frame}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .map(r => ({ type: r.type, platform: r.platform || '', what: shortFrame(r.top_frame) || r.signal || 'Unknown native crash', signal: r.signal || '', frame: r.top_frame || '',
      events: num(r.events), devices: num(r.devices), versions: String(r.latest_versions || '').split(',').filter(Boolean), first: first(r), last: r.last_seen || '',
      id: r.crash_group_id || '', isNew: days(first(r)) <= 14 }));
  const exceptions = (c.exceptions || []).map(r => ({ what: shortMethod(r.method), method: r.method || '', platforms: r.platforms || '', events: num(r.exceptions), devices: num(r.devices),
    versions: String(r.latest_versions || '').split(',').filter(Boolean), first: first(r), last: r.last_seen || '', id: r.crash_group_id || '', isNew: days(first(r)) <= 14 }));
  // Handled errors: the same error comes from two sources (clientError and
  // Embrace's log of it): kept once, with the most players.
  const errs = new Map();
  for (const r of c.errors || []) {
    const name = String(r.error || '').replace(/^ClientErrorEvent - /, '');
    const cur = errs.get(name);
    if (!cur || num(r.players) > cur.players) errs.set(name, { what: name, players: num(r.players), events: num(r.events), versions: String(r.latest_versions || '').split(',').filter(Boolean), last: r.last_seen || '' });
  }
  const errors = [...errs.values()].sort((a, b) => b.players - a.players);
  return { groups, exceptions, errors };
}

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
  const { groups, exceptions, errors } = listsOf(c, now);
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
  // The rates for the view's ranges (1, 3 and 7 days), from the daily rows:
  // the last N full days against the N days before.
  const byRange = {};
  for (const n of [1, 3, 7]) {
    byRange[n] = CRASH_TYPES.map(t => {
      const rows = c.daily.filter(r => r.type === t).sort((a, b) => String(a.date).localeCompare(String(b.date)));
      if (rows.length < n) return null;
      const sum = list => { const ev = list.reduce((x, r) => x + num(r.events), 0), dau = list.reduce((x, r) => x + num(r.dau), 0); return { ev, rate: dau ? ev / dau * 1000 : 0 }; };
      const cur = sum(rows.slice(-n)), before = rows.length >= 2 * n ? sum(rows.slice(-2 * n, -n)) : null;
      const r2 = x => Math.round(x * 100) / 100;
      return { type: t, per1k: r2(cur.rate), before: before ? r2(before.rate) : null, change: before?.rate ? cur.rate / before.rate - 1 : 0, events: cur.ev, devices: null,
        line: (daily.get(t) || []).slice(-Math.max(7, 2 * n)), until: rows[rows.length - 1].date };
    }).filter(Boolean);
  }
  // The players of each day (the crash rows' DAU, all platforms), for each
  // crash's share of the day.
  const dau = {};
  for (const r of c.daily) if (r.type === 'Crash' && r.dau) dau[String(r.date).slice(0, 10)] = num(r.dau);
  return { rates, byRange, dau, groups: groups.slice(0, 25), exceptions: exceptions.slice(0, 25), errors: errors.slice(0, 10), analysis: c.analysis || null, warnings,
    versions: newest.map(v => ({ version: v, rates: Object.fromEntries(CRASH_TYPES.map(t => [t, vrows.find(r => r.version === v && r.type === t)?.per1k ?? null])) })) };
}

// The crash lists for a shorter range (1, 3 or 7 days), read when the view
// asks for them: the dashboard's charts with its date filter set to one day
// more, because the filter counts today as the first day ("1" is today only,
// from midnight): 2 days cover the last 24 hours. BI's cached rows, run again
// when they are older than 6 hours. The charts read only those days of their
// date-partitioned tables, so a short range is a small query. "new" still
// comes from the 30-day read.
async function rangeLists(projectId, days) {
  const p = projects().find(x => x.id === projectId);
  if (!p) throw new Error('That project is not in the list any more.');
  const ids = await crashCharts(p);
  if (!ids.groups && !ids.exceptions) return null;
  const read = id => (id ? chartRows(p, id, false, days + 1).catch(() => []) : Promise.resolve([]));
  const [groups, exceptions, errors] = [await read(ids.groups), await read(ids.exceptions), await read(ids.errors)];
  save();
  const r = state.reports[p.id]?.crashes;
  const firstSeen = new Map([...(r?.groups || []), ...(r?.exceptions || [])].filter(x => x.id).map(x => [x.id, x.first]));
  const out = listsOf({ groups, exceptions, errors }, Date.now(), firstSeen);
  const lists = { days, groups: out.groups.slice(0, 25), exceptions: out.exceptions.slice(0, 25), errors: out.errors.slice(0, 10) };
  // Each one's days, and its share of the day's players in this range.
  try {
    const trends = await crashTrends(p, [...lists.groups, ...lists.exceptions].map(x => x.id));
    const dau = r?.dau || {};
    for (const x of [...lists.groups, ...lists.exceptions]) {
      x.trend = trendOf(trends[x.id], dau, days);
      // Exactly the last 24 hours (3, 7 days): not the dashboard's calendar days.
      if (x.trend?.range) { x.devices = x.trend.range.devices; x.events = x.trend.range.events; }
    }
    const inRange = x => !x.trend?.range || x.devices > 0;
    lists.groups = lists.groups.filter(inRange).sort((a, b) => b.devices - a.devices || b.events - a.events);
    lists.exceptions = lists.exceptions.filter(inRange).sort((a, b) => b.devices - a.devices || b.events - a.events);
    save();
  } catch (err) { lists.trendError = err.message; }
  return lists;
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
          if (crashes) await hotWarnings(p, crashes, force).catch(() => {});
        } catch (err) { if (err.notConnected) throw err; crashError = err.message; }
        // Support is never red: red is for a crash at 0.5% of players.
        for (const w of report.warnings) w.level = 'medium';
        const order = { high: 0, medium: 1 };
        report.warnings = [...(crashes?.warnings || []), ...report.warnings].sort((a, b) => order[a.level] - order[b.level] || kindRank(a) - kindRank(b));
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

// Unity exceptions matter most, then handled errors, ANRs and out-of-memory
// kills, and native crashes least: the order of the warnings and lists.
function kindRank(w) {
  const k = w.item?.kind === 'exception' || /exception/i.test(w.id) ? 0 : w.item?.kind === 'error' ? 1 : /ANR|Out of memory/i.test(w.id) ? 2 : w.tab === 'support' ? 4 : 3;
  return k;
}

// The crash warnings, from each crash's days: red for one at 0.5% of a
// day's players or more in the last 3 days; amber for one spiking. The
// rest of the crash warnings are amber.
async function hotWarnings(p, crashes, force) {
  for (const w of crashes.warnings) w.level = 'medium';
  const items = [...crashes.exceptions.map(x => ({ kind: 'exception', ...x })), ...crashes.groups.map(x => ({ kind: 'crash', ...x }))];
  const trends = await crashTrends(p, items.map(x => x.id), force);
  const pct = x => `${Math.round(x * 1000) / 10}%`;
  const day = d => new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  for (const x of items) {
    const t = trendOf(trends[x.id], crashes.dau || {}, 3);
    if (!t) continue;
    const name = x.kind === 'exception' ? `Exception in ${x.what}` : `Crash: ${x.what}`;
    if (t.hot) {
      crashes.warnings.push({ id: `hot:${x.id}:${t.shareAt}`, level: 'high', tab: 'crashes', item: x,
        title: `${name} hits ${pct(t.share)} of players`,
        text: `${t.devices[t.dates.indexOf(t.shareAt)].toLocaleString()} devices ${t.shareAt === t.dates[t.dates.length - 1] ? 'today so far' : `on ${day(t.shareAt)}`}, of about ${(t.players || 0).toLocaleString()} daily players.` });
    } else if (t.spiking) {
      crashes.warnings.push({ id: `spikeitem:${x.id}:${t.dates[t.dates.length - 1]}`, level: 'medium', tab: 'crashes', item: x,
        title: `${name} is spiking`,
        text: `${t.devices[t.devices.length - 1].toLocaleString()} devices today so far, ${t.devices[t.devices.length - 2].toLocaleString()} yesterday; usually about ${Math.round(median(t.devices.slice(-16, -2)))} a day.` });
    }
  }
}

// One crash or exception in detail, for its window in the view: its days
// (the last 30 and today: devices and events), and where it happens (app
// versions, OS versions, device models, countries), and its top frame as
// Embrace has it (method, file, line, symbol, module, message, type).
// Embrace's export has only that first frame, never the whole stack. One
// query on the crash table, for that group and those days (a few MB).
async function crashDetail(projectId, groupId) {
  const p = projects().find(x => x.id === projectId);
  if (!p) throw new Error('That project is not in the list any more.');
  if (!/^[A-Za-z0-9]{8,64}$/.test(groupId || '')) throw new Error('This one has no Embrace crash group id.');
  const ids = await crashCharts(p);
  if (!ids.table) throw new Error('The dashboard\'s crash table was not found.');
  const sql = `WITH c AS (SELECT * FROM \`${ids.table}\` WHERE partitionDate >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY) AND crashGroupId = '${groupId}')
SELECT 'day' AS part, CAST(partitionDate AS STRING) AS k, CAST(NULL AS STRING) AS v, COUNT(*) AS events, COUNT(DISTINCT deviceId) AS devices FROM c GROUP BY 2
UNION ALL SELECT 'dayv', CAST(partitionDate AS STRING), IFNULL(appVersion, '?'), COUNT(*), COUNT(DISTINCT deviceId) FROM c GROUP BY 2, 3
UNION ALL SELECT 'hourv', FORMAT_TIMESTAMP('%Y-%m-%dT%H', occurredAt), IFNULL(appVersion, '?'), COUNT(*), COUNT(DISTINCT deviceId) FROM c WHERE occurredAt >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 49 HOUR) GROUP BY 2, 3
UNION ALL SELECT 'version', IFNULL(appVersion, '?'), NULL, COUNT(*), COUNT(DISTINCT deviceId) FROM c GROUP BY 2
UNION ALL SELECT 'os', CONCAT(IF(platform = 'apple', 'iOS ', 'Android '), IFNULL(osVersion, '?')), NULL, COUNT(*), COUNT(DISTINCT deviceId) FROM c GROUP BY 2
UNION ALL SELECT 'device', TRIM(CONCAT(IFNULL(deviceManufacturer, ''), ' ', IFNULL(deviceModel, '?'))), NULL, COUNT(*), COUNT(DISTINCT deviceId) FROM c GROUP BY 2
UNION ALL SELECT 'country', IFNULL(country, '?'), NULL, COUNT(*), COUNT(DISTINCT deviceId) FROM c GROUP BY 2
UNION ALL SELECT 'frame', TO_JSON_STRING(STRUCT(method, file, line, symbol, module, message, type, errorType, stackTraceType, eventName)), NULL, COUNT(*), COUNT(DISTINCT deviceId) FROM c GROUP BY 2`;
  const r = await bi.callTool('bi_run_sql_preview', { sql, previewLimit: 2000 });
  const col = Object.fromEntries((r?.columns || []).map((c, i) => [c.name, i]));
  // By day and by hour (UTC, the last 48), each per app version.
  const out = { days: [], dayv: [], hourv: [], version: [], os: [], device: [], country: [], frame: [] };
  for (const row of r?.rows || []) {
    const part = row[col.part];
    const item = { key: row[col.k], events: Number(row[col.events]) || 0, devices: Number(row[col.devices]) || 0 };
    if (part === 'day') out.days.push(item);
    else if (part === 'dayv' || part === 'hourv') out[part].push({ ...item, version: row[col.v] });
    else if (part === 'frame') { try { out.frame.push({ ...JSON.parse(item.key), events: item.events, devices: item.devices }); } catch { /* skip */ } }
    else out[part]?.push(item);
  }
  out.days.sort((a, b) => a.key.localeCompare(b.key));
  for (const k of ['version', 'os', 'device', 'country', 'frame']) out[k] = out[k].sort((a, b) => b.devices - a.devices || b.events - a.events).slice(0, 10);
  out.dau = state.reports[p.id]?.crashes?.dau || {};
  return out;
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

module.exports = { setup, summary, check, markSeen, connect, disconnect, digestFolder, analyse, analyseCrashes, rangeLists, crashDetail, resolve, findDashboards };
