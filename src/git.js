// Finds out which files an agent changed during one turn, including changes
// made by shell commands, by comparing the files to a snapshot taken before
// the turn started. There are two kinds of snapshot:
//
// 1. The folder is a git repository. `git stash create` writes a commit object
//    of the current working tree (tracked files, with any uncommitted changes)
//    and prints its hash. It does not touch your files, the index or your
//    stash list. Untracked files are not in that commit, so we also remember
//    the list of untracked files.
//
// 2. The folder is not a git repository (for example an SVN checkout). The
//    app keeps its own git repository for that folder in its settings folder
//    and records only code files there (see CODE_ONLY). Git reads your files
//    but writes nothing into your folder. Packages inside the folder that are
//    git repositories of their own (embedded Unity packages) get snapshot
//    kind 1, because git does not look inside a nested repository.

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// For kind 2: ignore everything, then allow folders and code files back in.
const CODE_ONLY = [
  '*', '!*/',
  '!*.cs', '!*.shader', '!*.hlsl', '!*.cginc', '!*.compute', '!*.asmdef', '!*.asmref',
  '!*.js', '!*.ts', '!*.tsx', '!*.py', '!*.java', '!*.kt', '!*.swift', '!*.m', '!*.mm', '!*.h', '!*.cpp', '!*.c',
  '/Library/', '/Temp/', '/Logs/', '/obj/', '/Build/', '/Builds/', 'node_modules/', '.svn/', '.git/',
];

function git(args, { cwd, gitDir, workTree, allowExitCodes = [0] } = {}) {
  const prefix = [];
  if (gitDir) prefix.push('--git-dir', gitDir);
  if (workTree) prefix.push('--work-tree', workTree);
  if (cwd) prefix.push('-C', cwd);
  return new Promise(resolve => {
    execFile('git', [...prefix, ...args], { maxBuffer: 50 * 1024 * 1024, timeout: 60000 }, (err, stdout) => {
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
      resolve(allowExitCodes.includes(code) ? stdout : null);
    });
  });
}

// ---------- kind 1: the folder is a git repository ----------

async function untrackedFiles(cwd) {
  const out = await git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd });
  return out ? out.split('\0').filter(Boolean) : [];
}

async function repoSnapshot(cwd) {
  const head = (await git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd }))?.trim();
  if (!head) return null; // a repository without commits
  const stash = (await git(['stash', 'create'], { cwd }))?.trim();
  return { kind: 'git', base: stash || head, untracked: await untrackedFiles(cwd) };
}

// prefix puts a folder in front of every path, for nested repositories.
async function repoChanges(cwd, snap, prefix = '') {
  const prefixes = prefix ? [`--src-prefix=a/${prefix}/`, `--dst-prefix=b/${prefix}/`] : [];
  const tracked = await git(['diff', '--no-color', '--no-ext-diff', '--relative', ...prefixes, snap.base, '--'], { cwd });
  if (tracked == null) return null;
  const parts = [tracked];
  const before = new Set(snap.untracked);
  const added = (await untrackedFiles(cwd)).filter(f => !before.has(f)).slice(0, 200);
  for (const file of added) {
    // `git diff --no-index` exits with 1 when the files differ, which they always do here.
    const diff = await git(['diff', '--no-color', '--no-index', ...prefixes, '--', '/dev/null', file], { cwd, allowExitCodes: [0, 1] });
    if (diff) parts.push(diff);
  }
  return parts.join('');
}

// ---------- kind 2: the app's own repository for a folder ----------

// Two agents in the same folder share one private repository, so its
// commands must not run at the same time.
const locks = new Map();
function withLock(key, fn) {
  const run = (locks.get(key) || Promise.resolve()).then(fn, fn);
  locks.set(key, run.catch(() => {}));
  return run;
}

async function privateRepo(cwd, root) {
  const dir = path.join(root, crypto.createHash('sha1').update(cwd).digest('hex').slice(0, 16) + '.git');
  if (!fs.existsSync(path.join(dir, 'HEAD'))) {
    fs.mkdirSync(dir, { recursive: true });
    await git(['init', '-q', '--bare', dir]);
    for (const [k, v] of [['core.bare', 'false'], ['core.autocrlf', 'false'], ['core.quotepath', 'false'], ['advice.addEmbeddedRepo', 'false']]) {
      await git(['config', k, v], { gitDir: dir });
    }
    fs.writeFileSync(path.join(dir, 'folder.txt'), cwd + '\n');
  }
  fs.mkdirSync(path.join(dir, 'info'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'info', 'exclude'), CODE_ONLY.join('\n') + '\n');
  return dir;
}

// Records the code files and returns the hash of that state (a git tree).
async function recordTree(dir, cwd) {
  const ok = await git(['add', '-A', '.'], { gitDir: dir, workTree: cwd });
  if (ok == null) return null;
  return (await git(['write-tree'], { gitDir: dir, workTree: cwd }))?.trim() || null;
}

// Embedded packages that are git repositories show up as "gitlinks" (mode 160000).
async function nestedRepos(dir, cwd) {
  const out = await git(['ls-files', '-s', '-z'], { gitDir: dir, workTree: cwd });
  if (!out) return [];
  return out.split('\0').filter(l => l.startsWith('160000 ')).map(l => l.split('\t')[1]).filter(Boolean);
}

async function folderSnapshot(cwd, root) {
  const dir = await privateRepo(cwd, root);
  return withLock(dir, async () => {
    const tree = await recordTree(dir, cwd);
    if (!tree) return null;
    const nested = [];
    for (const rel of await nestedRepos(dir, cwd)) {
      const snap = await repoSnapshot(path.join(cwd, rel));
      if (snap) nested.push({ path: rel, snap });
    }
    return { kind: 'folder', dir, tree, nested };
  });
}

async function folderChanges(cwd, snap) {
  const tree = await withLock(snap.dir, () => recordTree(snap.dir, cwd));
  if (!tree) return null;
  const parts = [];
  if (tree !== snap.tree) {
    const diff = await git(['diff', '--no-color', '--no-ext-diff', snap.tree, tree], { gitDir: snap.dir });
    if (diff) parts.push(diff);
  }
  for (const n of snap.nested) {
    const diff = await repoChanges(path.join(cwd, n.path), n.snap, n.path);
    if (diff) parts.push(diff);
  }
  // Removes data that no snapshot refers to any more, when there is enough of it.
  git(['gc', '--auto', '--quiet'], { gitDir: snap.dir });
  return parts.join('');
}

// ---------- public ----------

// root is the folder where the app keeps its private repositories.
async function snapshot(cwd, root) {
  if (await git(['rev-parse', '--show-toplevel'], { cwd })) return repoSnapshot(cwd);
  if (!root || !fs.existsSync(cwd)) return null;
  // Your home folder (or a folder above it) holds far too many files to record.
  if (os.homedir().startsWith(path.resolve(cwd))) return null;
  return folderSnapshot(cwd, root);
}

// Unified diff of everything that changed since the snapshot, with paths
// relative to cwd.
async function changesSince(cwd, snap) {
  if (!snap) return null;
  if (snap.kind === 'folder') return folderChanges(cwd, snap);
  return repoChanges(cwd, snap);
}

module.exports = { snapshot, changesSince };
