// Keeps each task's Changes card after the app restarts. When a task ends,
// the app compares the folder with the snapshot from before the task (see
// git.js), which also finds files that shell commands or the Unity Editor
// changed, and files that moved. A saved session only has the agent's
// Edit/Write reports, so without this file the card (and its class diagram)
// would lose those files after a restart or an update.
//
// One JSON file per task, named after the uuid of the task's last answer
// (the same in the live stream and in Claude Code's saved session):
// { files: [{ path, status, lines, from }], snap }.

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 8 * 1024 * 1024;
const KEEP_DAYS = 120;
const ID = /^[A-Za-z0-9-]{8,64}$/;

function save(dir, id, data) {
  if (!ID.test(String(id)) || !data || !Array.isArray(data.files)) return false;
  const files = data.files.map(f => ({ path: f.path, status: f.status, lines: f.lines, from: f.from || undefined, binary: f.binary || undefined }));
  const text = JSON.stringify({ files, snap: data.snap || null, savedAt: Date.now() });
  if (text.length > MAX_BYTES) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, id + '.json'), text);
    return true;
  } catch {
    return false;
  }
}

// ids: uuids; resolves with { id: { files, snap } } for the ones that are saved.
async function load(dir, ids) {
  const out = {};
  for (const id of (Array.isArray(ids) ? ids : []).slice(0, 2000)) {
    if (!ID.test(String(id))) continue;
    try {
      out[id] = JSON.parse(await fs.promises.readFile(path.join(dir, id + '.json'), 'utf8'));
    } catch { /* not saved */ }
  }
  return out;
}

// Any other JSON kept the same way (an agent's Changes card, see
// updateSession in app.js), by session id.
function saveJson(dir, id, data) {
  if (!ID.test(String(id)) || !data) return false;
  const text = JSON.stringify({ ...data, savedAt: Date.now() });
  if (text.length > MAX_BYTES) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, id + '.json'), text);
    return true;
  } catch {
    return false;
  }
}

// Removes the files of tasks older than KEEP_DAYS.
function prune(dir) {
  const limit = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
  fs.promises.readdir(dir).then(names => {
    for (const n of names) {
      const p = path.join(dir, n);
      fs.promises.stat(p).then(s => { if (s.mtimeMs < limit) fs.promises.unlink(p).catch(() => {}); }).catch(() => {});
    }
  }).catch(() => {});
}

module.exports = { save, saveJson, load, prune };
