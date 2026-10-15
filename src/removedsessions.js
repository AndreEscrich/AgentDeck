// Sessions you removed from History. Claude Code's own session files stay
// where they are (claude --resume still finds them); Agent Hub leaves these
// sessions out of History and out of Your activity (the token graphs).
// Kept as a list of session ids in removed-sessions.json in the app's
// settings folder.

const fs = require('fs');

let file = null;
let ids = null;

function setFile(p) {
  file = p;
  ids = null;
}

function list() {
  if (!ids) {
    try { ids = new Set(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { ids = new Set(); }
  }
  return ids;
}

function save() {
  try { fs.writeFileSync(file, JSON.stringify([...list()])); } catch { /* not important enough to fail */ }
}

// Removes these sessions from History; restore() puts them back (Undo).
function remove(sessionIds) {
  for (const id of Array.isArray(sessionIds) ? sessionIds : []) if (typeof id === 'string') list().add(id);
  save();
  return true;
}

function restore(sessionIds) {
  for (const id of Array.isArray(sessionIds) ? sessionIds : []) list().delete(id);
  save();
  return true;
}

module.exports = { setFile, list, remove, restore };
