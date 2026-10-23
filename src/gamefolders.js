// Auto game folder: with Settings → New agents → Games folder set and Auto
// game folder on, a new agent whose message is about one game works in that
// game's folder instead of the one picked in the message box, for that agent
// only. A message about no game, or about several, keeps the picked folder.
//
// Two steps, so most messages decide at once:
// - quick (instant): the message names a game the app knows. It knows each
//   game folder's name ("MergeTavern", "Merge Tavern"), its Unity product
//   name from ProjectSettings ("Enchanted Inn"), their initials ("MT", "EI";
//   initials two games share are left out), and every name it learned. A
//   ticket whose project key is one of those initials ("SCM-4498") counts too.
// - lookup (a few seconds, only when quick cannot tell): Haiku decides, with
//   your global CLAUDE.md as notes, and reads the PM task first when the
//   message points at one (pickGame in agents.js). What it finds is saved in
//   game-folders.json, so the next message with that name is quick: the name
//   it found for the game ("SCW", "Lily's Garden"), the task's game, and the
//   names in the message that turned out to be no game ("RV", "UI"), so they
//   never ask Haiku again. Edit or delete the file to correct what it learned.

const fs = require('fs');
const path = require('path');

let storePath = null;
let store = null;
const gameLists = new Map();   // games folder -> { at, games }
const LIST_KEEP_MS = 10 * 60 * 1000;

function init(userData) {
  storePath = path.join(userData, 'game-folders.json');
}

// { names: { normalized name: game folder name, or null for no game }, tasks: { key: game or null } }
function learned() {
  if (!store) {
    try { store = JSON.parse(fs.readFileSync(storePath, 'utf8')); } catch { store = {}; }
    store.names = store.names || {};
    store.tasks = store.tasks || {};
  }
  return store;
}

function saveLearned() {
  try { fs.writeFileSync(storePath, JSON.stringify(learned(), null, 2)); } catch { /* learned again next time */ }
}

// Lower case, apostrophes dropped, anything else that is not a letter or digit a space.
const normalize = text => String(text || '').toLowerCase().replace(/['’`]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const words = name => String(name || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
const initials = name => words(name).split(/[^A-Za-z0-9]+/).filter(w => /^[A-Za-z]/.test(w)).map(w => w[0].toUpperCase()).join('');

function productName(dir) {
  try {
    const fd = fs.openSync(path.join(dir, 'ProjectSettings', 'ProjectSettings.asset'), 'r');
    const buf = Buffer.alloc(16384);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return (/^\s*productName:\s*(.+)$/m.exec(buf.toString('utf8', 0, n)) || [])[1]?.trim() || '';
  } catch {
    return '';
  }
}

// The games in the games folder: [{ name, dir, product, names, abbrevs }].
// Read the first time it is needed and kept for 10 minutes.
function gamesIn(root) {
  const known = gameLists.get(root);
  if (known && Date.now() - known.at < LIST_KEEP_MS) return known.games;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')); } catch { /* no such folder */ }
  const games = entries.map(e => {
    const dir = path.join(root, e.name);
    const unity = path.join(dir, 'Unity');
    const product = productName(fs.existsSync(unity) ? unity : dir);
    const names = new Set();
    for (const n of [e.name, words(e.name), product, words(product)]) {
      const norm = normalize(n);
      if (norm.length >= 3) { names.add(norm); names.add(norm.replace(/ /g, '')); }
    }
    const abbrevs = new Set([initials(e.name), initials(product)].filter(a => a.length >= 2 && a.length <= 5));
    return { name: e.name, dir, product, names, abbrevs };
  });
  // Initials two games share say nothing (MansionStory and MarbleStars are both MS).
  const count = new Map();
  for (const g of games) for (const a of g.abbrevs) count.set(a, (count.get(a) || 0) + 1);
  for (const g of games) for (const a of [...g.abbrevs]) if (count.get(a) > 1) g.abbrevs.delete(a);
  gameLists.set(root, { at: Date.now(), games });
  return games;
}

// The PM or Jira task a message points at: a link to it, or its key.
const TASK = /(?:^|[^A-Za-z0-9-])([A-Z][A-Z0-9]{1,9}-\d+)\b/;
const taskIn = text => (TASK.exec(String(text || '')) || [])[1] || null;

const SEVERAL = /\b(other|all( the)?|every|each|both|several|multiple) games\b/i;

// Text without code blocks and links, where names of games are not.
const prose = text => String(text || '').slice(0, 4000).replace(/```[\s\S]*?(```|$)/g, ' ').replace(/https?:\/\/\S+/g, ' ');

// Names in the message that may be a game: capitals (SCW) and phrases of
// capitalized words (Lily's Garden, Penny & Flo).
function candidates(text) {
  const found = new Set();
  for (const m of text.matchAll(/\b[A-Z]{2,5}\b/g)) found.add(m[0]);
  for (const m of text.matchAll(/\b[A-Z][a-z]+(?:['’]s)?(?:\s+(?:&\s+)?[A-Z][a-z]+(?:['’]s)?)+/g)) found.add(m[0]);
  return [...found];
}

// The games the message names, the longest name winning where names overlap
// ("GameStars CubePop" is not also "GameStars").
function named(games, text) {
  const { names } = learned();
  const plain = ' ' + normalize(text) + ' ';
  const hits = [];
  const add = (game, start, length) => { if (game) hits.push({ game, start, end: start + length }); };
  for (const g of games) {
    for (const n of g.names) for (let i = plain.indexOf(' ' + n + ' '); i >= 0; i = plain.indexOf(' ' + n + ' ', i + 1)) add(g, i, n.length + 2);
    for (const a of g.abbrevs) for (const m of text.matchAll(new RegExp(`\\b${a}\\b`, 'g'))) add(g, -1 - m.index, 0);
  }
  for (const [n, gameName] of Object.entries(names)) {
    const g = gameName && games.find(x => x.name === gameName);
    if (!g) continue;
    if (/^[A-Z0-9]{2,5}$/.test(n)) for (const m of text.matchAll(new RegExp(`\\b${n}\\b`, 'g'))) add(g, -1 - m.index, 0);
    else for (let i = plain.indexOf(' ' + n + ' '); i >= 0; i = plain.indexOf(' ' + n + ' ', i + 1)) add(g, i, n.length + 2);
  }
  const kept = hits.filter(h => h.start < 0 || !hits.some(o => o.game !== h.game && o.start >= 0 && o.start <= h.start && o.end >= h.end && o.end - o.start > h.end - h.start));
  return [...new Set(kept.map(h => h.game))];
}

// The folder to work in for a game: the same place inside it as the picked
// folder has in its own game (MergeTavern/Unity → FlowerGarden/Unity), or its
// Unity folder when the picked folder is not in the games folder.
function folderFor(root, game, current) {
  const rel = current ? path.relative(root, current) : '..';
  const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).slice(1) : null;
  const sub = inside ? path.join(game.dir, ...inside) : path.join(game.dir, 'Unity');
  return fs.existsSync(sub) ? sub : game.dir;
}

const gameOf = (root, current) => {
  const rel = current ? path.relative(root, current) : '..';
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep)[0] : null;
};

function answer(root, game, current, how) {
  if (!game) return { folder: null, how };
  const folder = folderFor(root, game, current);
  return { folder, game: game.name, product: game.product, how, same: gameOf(root, current) === game.name };
}

// The instant step. Resolves with { folder, game, product, how, same } when
// it can tell (folder null: keep the picked folder), or { lookup: true } when
// only Haiku can.
function quick(root, text, current) {
  if (!root) return { folder: null, how: 'off' };
  const games = gamesIn(root);
  if (!games.length) return { folder: null, how: 'no games' };
  const body = prose(text);
  if (SEVERAL.test(body)) return { folder: null, how: 'several games' };
  const hits = named(games, body);
  if (hits.length > 1) return { folder: null, how: 'several games' };
  if (hits.length === 1) return answer(root, hits[0], current, 'name');
  const task = taskIn(text);
  if (task) {
    const { tasks } = learned();
    if (task in tasks) return answer(root, games.find(g => g.name === tasks[task]) || null, current, 'task');
    const project = task.split('-')[0];
    const byKey = games.filter(g => g.abbrevs.has(project) || learned().names[project] === g.name);
    if (byKey.length === 1) return answer(root, byKey[0], current, 'task');
    return { lookup: true, task };
  }
  const { names } = learned();
  const unknown = candidates(body).filter(c => !(normalize(c) in names) && !(c in names));
  return unknown.length ? { lookup: true, unknown } : { folder: null, how: 'no game' };
}

function userNotes() {
  try { return fs.readFileSync(path.join(require('os').homedir(), '.claude', 'CLAUDE.md'), 'utf8').slice(0, 8000); } catch { return ''; }
}

// The slow step: asks Haiku (pick(question, { task }) → { game, name } or
// null), saves what it learned, and resolves like quick.
async function lookup(root, text, current, pick) {
  const q = quick(root, text, current);
  if (!q.lookup) return q;
  const games = gamesIn(root);
  const list = games.map(g => `- ${g.name}: ${[...new Set([words(g.name), g.product, ...g.abbrevs, ...Object.entries(learned().names).filter(([, v]) => v === g.name).map(([k]) => k)].filter(Boolean))].join(', ')}`).join('\n');
  const notes = userNotes();
  const question = [
    'A coding agent is about to work on the message below. Decide which game it is about.',
    'The games, by folder name, with other names they go by:',
    list,
    notes ? '\nNotes from the user\'s own instructions (they may name the games differently):\n' + notes : '',
    q.task ? `\nThe message points at the task ${q.task}. Read it with pm_get_task first; its title, component and description usually name the game.` : '',
    '\nMessage:\n' + prose(text).slice(0, 3000),
    '\nReply with only JSON: {"game": "<folder name>" or "NONE" (no game, or a shared package) or "SEVERAL", "name": "<the words in the message or task that name that game, as written there>"}',
  ].filter(Boolean).join('\n');
  const result = await pick(question, { task: q.task }).catch(() => null);
  if (!result) return { folder: null, how: 'lookup failed' };
  const game = games.find(g => g.name.toLowerCase() === String(result.game || '').toLowerCase()) || null;
  const several = /^several$/i.test(result.game || '');
  const store = learned();
  if (q.task && !several) store.tasks[q.task] = game ? game.name : null;
  const name = String(result.name || '').trim();
  if (game && name.length >= 2 && name.length <= 40) store.names[/^[A-Z0-9]{2,5}$/.test(name) ? name : normalize(name)] = game.name;
  if (!several) for (const c of q.unknown || []) if (normalize(c) !== normalize(name)) store.names[/^[A-Z0-9]{2,5}$/.test(c) ? c : normalize(c)] = null;
  saveLearned();
  if (several) return { folder: null, how: 'several games' };
  return answer(root, game, current, 'lookup');
}

module.exports = { init, quick, lookup };
