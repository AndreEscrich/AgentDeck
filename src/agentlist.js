// Every agent you have had, by session id, with its title, folder, category
// and whether it is on the Hub (agents.json in the app's folder). History and
// the Hub rebuild from it when their own saved state is gone.
//
// remember() changes only the entries it gets, on the newest file: two
// copies of the app open at once (the stable one and the dev one) update the
// same list without undoing each other's changes, unlike a whole-file save.

const fs = require('fs');
const path = require('path');

let file = null;

function init(userData) {
  file = path.join(userData, 'agents.json');
}

function read() {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function write(data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

// entries: [{ sessionId, ...fields }]. Fields left out keep their value.
function remember(entries) {
  if (!file || !Array.isArray(entries)) return;
  const data = read();
  let changed = false;
  for (const e of entries) {
    if (!e || typeof e.sessionId !== 'string' || !/^[\w-]{8,64}$/.test(e.sessionId)) continue;
    const before = data[e.sessionId] || {};
    const next = { ...before, ...e, updatedAt: Date.now() };
    delete next.sessionId;
    const { updatedAt: _a, ...oldRest } = before;
    const { updatedAt: _b, ...newRest } = next;
    if (JSON.stringify(oldRest) === JSON.stringify(newRest)) continue;
    data[e.sessionId] = next;
    changed = true;
  }
  if (changed) write(data);
}

function list() {
  if (!file) return [];
  return Object.entries(read()).map(([sessionId, e]) => ({ sessionId, ...e }));
}

module.exports = { init, remember, list };
