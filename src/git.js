// Finds out which files an agent changed during one turn, including changes
// made by shell commands, by comparing the working tree to a snapshot taken
// before the turn started.
//
// `git stash create` writes a commit object of the current working tree
// (tracked files, with any uncommitted changes) and prints its hash. It does
// not touch your files, the index or your stash list. Untracked files are not
// in that commit, so we also remember the list of untracked files.

const { execFile } = require('child_process');

function git(cwd, args, { allowExitCodes = [0] } = {}) {
  return new Promise(resolve => {
    execFile('git', ['-C', cwd, ...args], { maxBuffer: 50 * 1024 * 1024, timeout: 30000 }, (err, stdout) => {
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
      resolve(allowExitCodes.includes(code) ? stdout : null);
    });
  });
}

async function untrackedFiles(cwd) {
  const out = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  return out ? out.split('\0').filter(Boolean) : [];
}

// Returns null when cwd is not inside a git repository.
async function snapshot(cwd) {
  const top = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return null;
  const head = (await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']))?.trim();
  if (!head) return null; // a repository without commits
  const stash = (await git(cwd, ['stash', 'create']))?.trim();
  return { base: stash || head, untracked: await untrackedFiles(cwd) };
}

// Unified diff of everything that changed since the snapshot, with paths
// relative to cwd.
async function changesSince(cwd, snap) {
  if (!snap) return null;
  const parts = [];
  const tracked = await git(cwd, ['diff', '--no-color', '--no-ext-diff', '--relative', snap.base, '--']);
  if (tracked == null) return null;
  parts.push(tracked);

  const before = new Set(snap.untracked);
  const added = (await untrackedFiles(cwd)).filter(f => !before.has(f)).slice(0, 200);
  for (const file of added) {
    // `git diff --no-index` exits with 1 when the files differ, which they always do here.
    const diff = await git(cwd, ['diff', '--no-color', '--no-index', '--', '/dev/null', file], { allowExitCodes: [0, 1] });
    if (diff) parts.push(diff);
  }
  return parts.join('');
}

module.exports = { snapshot, changesSince };
