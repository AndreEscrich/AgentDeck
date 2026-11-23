// Project health (the heartbeat button on the Hub's left side): checks that
// tell you when something in the live game needs your attention. The first
// one is player support.
//
// Player support reads the message log of a Tactile BI dashboard (by default
// Morten's "Enchanted Inn – User Support Messages": one row per player
// message, with its topic, tone, English text and conversation) through the
// app's own Tactile BI sign-in (src/mcpclient.js), so no model reads it and
// it costs no tokens:
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

const DEFAULTS = {
  title: 'Enchanted Inn',
  dashboardId: '6b03de6c242cddc2eec4407d',
  filterGroup: '6b03de6c242cddc2eec4407c',
  messagesChart: '6b03e160242cddc2eec440a3',
  days: '30',
};
const READ_EVERY = 30 * 60 * 1000;
const RUN_EVERY = 3 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

let file = null;
let state = null;   // { seen: [warning ids], lastRun: time, report }
let onChange = () => {};
let timer = null;
let busy = null;
let getConfig = () => ({});

function setup(userData, config, notify) {
  bi.setup(userData);
  file = path.join(userData, 'health.json');
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { state = {}; }
  state.seen ||= [];
  getConfig = config;
  onChange = notify;
  clearInterval(timer);
  timer = setInterval(() => check().catch(() => {}), READ_EVERY);
  setTimeout(() => check().catch(() => {}), 15000);
}

function save() {
  try { fs.writeFileSync(file, JSON.stringify(state)); } catch { /* kept for this run */ }
}

function settings() {
  const c = getConfig().healthSupport || {};
  const own = Object.fromEntries(Object.entries(c).filter(([, v]) => v));
  // Another dashboard: Enchanted Inn's filter group does not belong to it.
  if (own.dashboardId && own.dashboardId !== DEFAULTS.dashboardId && !own.filterGroup) own.filterGroup = '';
  return { ...DEFAULTS, ...own };
}

function summary() {
  const report = state.report || null;
  const warnings = report?.warnings || [];
  return { connected: bi.status().connected, email: bi.status().email, report, unseen: warnings.filter(w => !state.seen.includes(w.id)).length };
}

// The chart's rows, run again first when the last run is old (or force).
async function readRows(force) {
  const s = settings();
  const args = { chartId: s.messagesChart, filterOverrides: { daterange: String(s.days) } };
  if (s.filterGroup) args.activeFilterGroupId = s.filterGroup;
  const run = async () => {
    await bi.callTool('bi_run_chart', { ...args, dashboardId: s.dashboardId });
    state.lastRun = Date.now();
  };
  if (force || Date.now() - (state.lastRun || 0) > RUN_EVERY) await run().catch(() => {});
  let data = await bi.callTool('bi_get_chart_data', args);
  if (data?.cached === false) { await run(); data = await bi.callTool('bi_get_chart_data', args); }
  const q = data?.queryResults?.[0];
  if (!q?.columns) throw new Error('Tactile BI sent no messages for that chart.');
  const col = Object.fromEntries(q.columns.map((c, i) => [c.name, i]));
  return (q.rows || []).map(r => ({
    topic: r[col.message_topic] || r[col.topic] || 'Other',
    tone: r[col.tone_heuristic] || '',
    text: r[col.message_en] || r[col.message_original] || '',
    original: r[col.message_original] || '',
    conversation: r[col.conversation_id] || '',
    at: r[col.sent_at] || r[col.message_date] || '',
  })).filter(m => m.at);
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

// One look. Resolves with the summary.
function check(force = false) {
  // Off in Settings → Project health: no reading at all.
  if (!bi.status().connected || getConfig().featureHealth === false) return Promise.resolve(summary());
  busy ||= (async () => {
    const s = settings();
    try {
      const messages = await readRows(force);
      state.report = { at: Date.now(), title: s.title, dashboardUrl: `https://bi.tactilews.com/dashboards/${s.dashboardId}${s.filterGroup ? `?filterGroup=${s.filterGroup}` : ''}`, ...analyse(messages), error: null };
    } catch (err) {
      if (err.notConnected) state.report = null;
      else state.report = { ...(state.report || {}), error: err.message, errorAt: Date.now() };
    }
    save();
    const out = summary();
    onChange(out);
    return out;
  })().finally(() => { busy = null; });
  return busy;
}

function markSeen() {
  const ids = (state.report?.warnings || []).map(w => w.id);
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
  state.report = null;
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

module.exports = { setup, summary, check, markSeen, connect, disconnect, digestFolder, analyse };
