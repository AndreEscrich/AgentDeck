// Project health (the heartbeat button on the Hub's left side): checks that
// tell you when something in the live game needs your attention. The first
// one is player support.
//
// Player support has a list of projects (Settings → Project health), each a
// Tactile BI dashboard with a message log: one row per player message, with
// its topic, tone, English text and conversation (Enchanted Inn's, Morten's
// "User Support Messages", is the first one until you change the list).
// Adding one only takes the dashboard's link: the app finds the message log
// chart itself (resolve). It reads them through the app's own Tactile BI
// sign-in (src/mcpclient.js), so no model reads them and it costs no tokens:
//
//  - every 30 minutes it reads the chart's cached rows (free);
//  - at most every 3 hours it asks BI to run the chart again first, so new
//    messages come in (a small BigQuery query, refused by BI above its cost
//    cap);
//  - it counts the messages per topic, this week against last week, and
//    raises a warning for: a topic that grows fast, a day with far more
//    messages than usual, several players with the same complaint in the
//    last 3 days, and mostly unhappy messages.
//
// Warnings you have not looked at show as a red count on the button; opening
// the view marks them seen (kept in health.json in the settings folder). The
// deeper digest (which messages are real bugs, checked against the code) is
// an agent with the game project's UserSupportDigest skill, started from the
// view.

const fs = require('fs');
const path = require('path');
const { makeClient } = require('./mcpclient');

const bi = makeClient({ server: 'https://bi-mcp.tactilews.com', name: 'bi', label: 'Tactile BI' });

// The list until you change it: Enchanted Inn's support dashboard.
const DEFAULT_PROJECTS = [{
  id: 'ei', name: 'Enchanted Inn',
  dashboardId: '6b03de6c242cddc2eec4407d', filterGroup: '6b03de6c242cddc2eec4407c', chartId: '6b03e160242cddc2eec440a3',
}];
const DAYS = '30';
const READ_EVERY = 30 * 60 * 1000;
const RUN_EVERY = 3 * 60 * 60 * 1000;
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
  const list = projects().map(p => ({ id: p.id, name: p.name, folder: p.folder || '', dashboardUrl: dashboardUrl(p), chartId: p.chartId, report: state.reports[p.id] || null }));
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
        name: title.split(/\s+[–—-]\s+/)[0].trim() || title, dashboardTitle: title, messages: messages.length,
      };
    } catch { /* not a message log: the next one */ }
  }
  throw new Error(`"${st?.title || 'That dashboard'}" has no message log chart: a table with one row per message (a text column like message_en and a time column like sent_at).`);
}

// Support dashboards to pick from: Tactile BI's dashboards whose title says
// support.
async function findDashboards() {
  const r = await bi.callTool('bi_list_dashboards', { search: 'support', limit: 30 });
  return (r?.dashboards || []).map(d => ({ id: d._id, title: d.title, updatedAt: d.updatedAt }));
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
    stats: { day: last24.length, week: last7.length, before: prev7.length, conversations: conversations(last7), unhappy: negative(last7), total: messages.length },
    topics, warnings, recent,
  };
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
        // Each warning belongs to its project (seen per project).
        for (const w of report.warnings) w.id = `${p.id}:${w.id}`;
        state.reports[p.id] = { at: Date.now(), ...report, error: null };
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

module.exports = { setup, summary, check, markSeen, connect, disconnect, digestFolder, analyse, resolve, findDashboards };
