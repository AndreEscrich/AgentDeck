// Tactile PM tasks for the task cards in the chat (like Jira's, see
// jira.js): a link to pm.tactilews.com/pm/items/KEY shows the task's key,
// title, type and status.
//
// The Tactile PM connector usually comes from claude.ai, which keeps its
// sign-in where the app cannot read it, so the app cannot ask PM itself:
// Haiku reads the tasks with the connector (readPmTasks in agents.js). That
// takes a few seconds and a little usage, so the keys asked for within a
// moment go in one request, and the answers are kept in pm-tasks.json in
// the app's settings folder. A kept task shows at once; one older than 10
// minutes is read again for the next time it is shown.
//
// task(key) resolves with { key, title, status, category, type } or null.
// splitInfo(key) resolves with { type, subtasks } (the number of subtasks,
// counted only for a Story) or null, for the ⑂ Split button.

const fs = require('fs');
const path = require('path');

const KEY = /^[A-Z][A-Z0-9]{1,9}-\d+$/;
const FRESH_MS = 10 * 60 * 1000;
const FAILED_MS = 2 * 60 * 1000;   // a key that could not be read is not asked for again before this
const BATCH = 8;

let file = null;
let saved = null;              // key -> { at, title, status, category, type }
const failed = new Map();      // key -> when it could not be read
let queue = new Map();         // key -> [resolve]
const counting = new Set();    // keys in the queue whose subtasks are counted too
let timer = null;
let running = false;
let read = null;               // keys -> promise of { KEY: task JSON }

function setup(f, reader) { file = f; read = reader; }

function load() {
  if (saved) return saved;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { saved = {}; }
  return saved;
}
function store() {
  try {
    // The 500 seen last are enough.
    const keep = Object.entries(saved).sort((a, b) => b[1].at - a[1].at).slice(0, 500);
    saved = Object.fromEntries(keep);
    fs.writeFileSync(file, JSON.stringify(saved));
  } catch { /* kept in memory */ }
}

// To Do, In Progress or Done, for the card's colour (as Jira's categories).
function category(status) {
  const s = String(status || '').toLowerCase();
  if (/done|closed|resolved|released|complete|shipped|won't|wont|cancel/.test(s)) return 'done';
  if (/^(to ?do|backlog|open|new|ready|todo|triage|planned)/.test(s)) return 'new';
  return 'indeterminate';
}

const card = (key, t) => ({ key, title: t.title, status: t.status, category: t.category, type: t.type });

function task(key) {
  if (typeof key !== 'string' || !KEY.test(key) || !read) return Promise.resolve(null);
  const hit = load()[key];
  if (hit) {
    if (Date.now() - hit.at > FRESH_MS) ask(key);   // for the next time
    return Promise.resolve(card(key, hit));
  }
  if (Date.now() - (failed.get(key) || 0) < FAILED_MS) return Promise.resolve(null);
  return ask(key);
}

// For the ⑂ Split button: the type, and for a Story its number of subtasks.
// A kept count younger than FRESH_MS answers at once.
function splitInfo(key) {
  if (typeof key !== 'string' || !KEY.test(key) || !read) return Promise.resolve(null);
  const hit = load()[key];
  const info = t => (t ? { type: t.type || '', subtasks: typeof t.subtasks === 'number' ? t.subtasks : null } : null);
  if (hit && typeof hit.subtasks === 'number' && Date.now() - (hit.subAt || 0) < FRESH_MS) return Promise.resolve(info(hit));
  if (hit && hit.type && !/story/i.test(hit.type)) return Promise.resolve(info(hit));
  if (Date.now() - (failed.get(key) || 0) < FAILED_MS) return Promise.resolve(info(hit));
  counting.add(key);
  return ask(key).then(() => info(saved[key]));
}

function ask(key) {
  return new Promise(resolve => {
    if (!queue.has(key)) queue.set(key, []);
    queue.get(key).push(resolve);
    clearTimeout(timer);
    timer = setTimeout(run, 400);
  });
}

async function run() {
  if (running || !queue.size) return;
  running = true;
  const batch = [...queue.keys()].slice(0, BATCH);
  const waiting = batch.map(k => [k, queue.get(k)]);
  const countFor = batch.filter(k => counting.has(k));
  for (const k of batch) { queue.delete(k); counting.delete(k); }
  let found = {};
  try { found = await read(batch, countFor); } catch { /* none read */ }
  load();
  for (const [k, resolvers] of waiting) {
    const t = found[k];
    let result = null;
    if (t && typeof t.title === 'string') {
      const status = t.resolvedStatusName || t.status || '';
      const before = saved[k];
      saved[k] = { at: Date.now(), title: t.title, status, category: category(status), type: t.itemType === 'subtask' ? 'Subtask' : t.fieldNames?.taskTypeDefinitionId || t.type || '' };
      if (typeof t.subtaskCount === 'number') { saved[k].subtasks = t.subtaskCount; saved[k].subAt = Date.now(); }
      else if (before && typeof before.subtasks === 'number') { saved[k].subtasks = before.subtasks; saved[k].subAt = before.subAt; }
      result = card(k, saved[k]);
      failed.delete(k);
    } else {
      failed.set(k, Date.now());
      if (saved[k]) result = card(k, saved[k]);   // the older answer
    }
    for (const r of resolvers) r(result);
  }
  store();
  running = false;
  if (queue.size) run();
}

// Tasks an agent's own PM tool calls returned (created, searched, read): kept
// like an answer from Haiku, so their cards show at once without asking.
// list: [{ key, title, status, type }]
function seed(list) {
  if (!Array.isArray(list) || !file) return;
  load();
  let changed = false;
  for (const t of list) {
    if (!t || typeof t.key !== 'string' || !KEY.test(t.key) || typeof t.title !== 'string' || !t.title) continue;
    const status = String(t.status || saved[t.key]?.status || '');
    const before = saved[t.key];
    saved[t.key] = { at: Date.now(), title: t.title, status, category: category(status), type: String(t.type || before?.type || '') };
    if (typeof before?.subtasks === 'number') { saved[t.key].subtasks = before.subtasks; saved[t.key].subAt = before.subAt; }
    failed.delete(t.key);
    changed = true;
  }
  if (changed) store();
}

module.exports = { setup, task, splitInfo, category, seed };
