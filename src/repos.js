// Finds the repository an agent works in: the nearest folder, going up from
// the agent's folder, that holds a .git or .svn entry. The Hub groups agents
// by group and by this repository.

const fs = require('fs');
const os = require('os');
const path = require('path');

const cache = new Map();

function isRepoRoot(dir) {
  return fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, '.svn'));
}

// Returns { root, name }. Without a repository, the folder itself is used.
function repoOf(cwd) {
  if (!cwd) return null;
  if (cache.has(cwd)) return cache.get(cwd);
  const home = os.homedir();
  let dir = path.resolve(cwd);
  let root = null;
  while (dir !== path.dirname(dir) && dir !== home) {
    if (isRepoRoot(dir)) {
      root = dir;
      break;
    }
    dir = path.dirname(dir);
  }
  root = root || path.resolve(cwd);
  const result = { root, name: path.basename(root) };
  cache.set(cwd, result);
  return result;
}

module.exports = { repoOf };
