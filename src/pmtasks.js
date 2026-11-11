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
  for (const k of batch) queue.delete(k);
  let found = {};
  try { found = await read(batch); } catch { /* none read */ }
  load();
  for (const [k, resolvers] of waiting) {
    const t = found[k];
    let result = null;
    if (t && typeof t.title === 'string') {
      const status = t.resolvedStatusName || t.status || '';
      saved[k] = { at: Date.now(), title: t.title, status, category: category(status), type: t.fieldNames?.taskTypeDefinitionId || t.type || '' };
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

module.exports = { setup, task, category };
