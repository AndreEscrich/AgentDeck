// Finds the repository an agent works in: the nearest folder, going up from
// the agent's folder, that holds a .git or .svn entry. The Hub groups agents
// by group and by this repository.

const { execFile } = require('child_process');
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
  const folder = path.resolve(cwd);
  // The repository's name plus the folder inside it, for example
  // "MyGame/Unity" when .svn is in MyGame and the agent works in
  // MyGame/Unity. Without a repository: the folder's last two parts.
  const name = root
    ? [path.basename(root), path.relative(root, folder)].filter(Boolean).join('/')
    : folder.split(path.sep).filter(Boolean).slice(-2).join('/');
  root = root || folder;
  const result = { root, name };
  cache.set(cwd, result);
  return result;
}

// The branch a repository's working copy is on: { vcs, name } or null.
// git: from .git/HEAD (a worktree's .git file points to its own); a
// detached HEAD is its short commit. svn: its URL relative to the
// repository (^/branches/name/Unity: "name", ^/trunk: "trunk"), from the
// working copy (svn info does not go to the server for this).
function branchOf(cwd) {
  const repo = repoOf(cwd);
  if (!repo) return Promise.resolve(null);
  const dotGit = path.join(repo.root, '.git');
  try {
    if (fs.existsSync(dotGit)) {
      let gitDir = dotGit;
      if (fs.statSync(dotGit).isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
        if (m) gitDir = path.resolve(repo.root, m[1].trim());
      }
      const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
      const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
      return Promise.resolve({ vcs: 'git', name: ref ? ref[1] : head.slice(0, 7) });
    }
  } catch { return Promise.resolve(null); }
  if (!fs.existsSync(path.join(repo.root, '.svn'))) return Promise.resolve(null);
  return new Promise(resolve => {
    execFile('svn', ['info', '--show-item', 'relative-url', '--non-interactive', repo.root], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const url = stdout.trim().replace(/^\^\//, '');
      const m = /^(?:.*?\/)?(trunk|branches\/[^/]+|tags\/[^/]+)(?:\/|$)/.exec(url);
      resolve({ vcs: 'svn', name: m ? m[1].replace(/^(branches|tags)\//, '') : url || null });
    });
  });
}

module.exports = { repoOf, branchOf };
