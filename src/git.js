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
//    and records code files and text assets there (see CODE_ONLY), so "Undo
//    last prompt" can put back prefabs, scenes and the like too. Git reads your files
//    but writes nothing into your folder. Packages inside the folder that are
//    git repositories of their own (embedded Unity packages) get snapshot
//    kind 1, because git does not look inside a nested repository.

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// For kind 2: ignore everything, then allow folders, code files and assets
// stored as text back in. Unity saves prefabs, scenes, materials, animations
// and most settings as text (YAML), and every asset has a .meta file; these
// are what an agent changes besides code. Textures, models and sounds stay
// out: they can be gigabytes, and agents rarely change them.
const CODE_ONLY = [
  '*', '!*/',
  '!*.cs', '!*.shader', '!*.hlsl', '!*.cginc', '!*.compute', '!*.asmdef', '!*.asmref',
  '!*.js', '!*.ts', '!*.tsx', '!*.py', '!*.java', '!*.kt', '!*.swift', '!*.m', '!*.mm', '!*.h', '!*.cpp', '!*.c',
  '!*.prefab', '!*.unity', '!*.asset', '!*.mat', '!*.anim', '!*.controller', '!*.overrideController', '!*.mask', '!*.meta',
  '!*.playable', '!*.signal', '!*.spriteatlas', '!*.spriteatlasv2', '!*.physicMaterial', '!*.physicsMaterial2D', '!*.preset',
  '!*.shadergraph', '!*.shadersubgraph', '!*.vfx', '!*.uss', '!*.uxml', '!*.tss', '!*.inputactions', '!*.guiskin', '!*.fontsettings',
  '!*.renderTexture', '!*.lighting', '!*.terrainlayer', '!*.brush', '!*.flare', '!*.giparams', '!*.mixer',
  '!*.json', '!*.xml', '!*.yaml', '!*.yml', '!*.txt', '!*.csv', '!*.md', '!*.html', '!*.css',
  'node_modules/', '.svn/', '.git/',
  // Baked lighting is big, binary and rebuilt by Unity.
  'LightingData.asset', '*.lighting.asset',
];
const GENERATED = ['Library', 'Temp', 'Logs', 'obj', 'Build', 'Builds', 'UserSettings', 'MemoryCaptures', 'Recordings'];

function excludes(project) {
  const anchors = project ? ['', project + '/'] : [''];
  return [...CODE_ONLY, ...anchors.flatMap(a => GENERATED.map(name => `/${a}${name}/`))];
}

const NOT_PROJECTS = new Set(['Assets', 'Packages', 'node_modules', ...GENERATED]);

async function unityProjects(cwd, depth = 3, rel = '') {
  const here = path.join(cwd, rel);
  if (fs.existsSync(path.join(here, 'ProjectSettings', 'ProjectVersion.txt'))) return [rel];
  if (depth === 0) return [];
  const entries = await fs.promises.readdir(here, { withFileTypes: true }).catch(() => []);
  const found = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || NOT_PROJECTS.has(e.name)) continue;
    found.push(...await unityProjects(cwd, depth - 1, rel ? `${rel}/${e.name}` : e.name));
  }
  return found;
}

// Git variables the app may have been started with (by a hook or a script
// that git ran) would point every command at that repository instead of the
// folder it names: they are left out.
const GIT_ENV = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES)$/;
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !GIT_ENV.test(k)));

// The last error of a git command, for the snapshot log (logSnapshot).
let lastGitError = '';
function git(args, { cwd, gitDir, workTree, allowExitCodes = [0], timeout = 60000 } = {}) {
  const prefix = [];
  if (gitDir) prefix.push('--git-dir', gitDir);
  if (workTree) prefix.push('--work-tree', workTree);
  if (cwd) prefix.push('-C', cwd);
  return new Promise(resolve => {
    execFile('git', [...prefix, ...args], { maxBuffer: 50 * 1024 * 1024, timeout, env: gitEnv }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
      if (!allowExitCodes.includes(code)) lastGitError = `git ${args[0]}: ${err?.killed ? 'timed out' : String(stderr || err?.message || code).trim().split('\n').slice(-2).join(' ')}`;
      resolve(allowExitCodes.includes(code) ? stdout : null);
    });
  });
}

// Each snapshot, in <root>/snapshot-log.txt (the newest lines kept): the
// folder, how it went and how long it took, to find out why a task got no
// Changes card.
function logSnapshot(root, cwd, what, started) {
  if (!root) return;
  try {
    const file = path.join(root, 'snapshot-log.txt');
    fs.mkdirSync(root, { recursive: true });
    const line = `${new Date().toISOString()} ${Date.now() - started}ms ${what} :: ${cwd}\n`;
    let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    text = (text + line).split('\n').slice(-500).join('\n');
    fs.writeFileSync(file, text);
  } catch { /* the log is only a help */ }
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
  // Line endings alone do not count: an agent that rewrites a CRLF file
  // with LF would otherwise show every line as removed and added again.
  // Moves are paired by the window (pairMoves in diffview.js): git pairs any
  // two files that are half the same, such as a view removed and a new one
  // made from the same template.
  const tracked = await git(['diff', '--no-color', '--no-ext-diff', '--ignore-cr-at-eol', '--no-renames', '--relative', ...prefixes, snap.base, '--'], { cwd });
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

const privateDir = (cwd, root) => path.join(root, crypto.createHash('sha1').update(cwd).digest('hex').slice(0, 16) + '.git');

async function privateRepo(cwd, root, project) {
  const dir = privateDir(cwd, root);
  if (!fs.existsSync(path.join(dir, 'HEAD'))) {
    fs.mkdirSync(dir, { recursive: true });
    await git(['init', '-q', '--bare', dir]);
    for (const [k, v] of [['core.bare', 'false'], ['core.autocrlf', 'false'], ['core.quotepath', 'false'], ['advice.addEmbeddedRepo', 'false']]) {
      await git(['config', k, v], { gitDir: dir });
    }
    fs.writeFileSync(path.join(dir, 'folder.txt'), cwd + '\n');
  }
  fs.mkdirSync(path.join(dir, 'info'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'info', 'exclude'), excludes(project).join('\n') + '\n');
  return dir;
}

// Records the code files and returns the hash of that state (a git tree).
async function recordTree(dir, cwd) {
  const ok = await git(['add', '-A', '.'], { gitDir: dir, workTree: cwd, timeout: 30 * 60000 });
  if (ok == null) return null;
  return (await git(['write-tree'], { gitDir: dir, workTree: cwd }))?.trim() || null;
}

// Embedded packages that are git repositories show up as "gitlinks" (mode 160000).
async function nestedRepos(dir, cwd) {
  const out = await git(['ls-files', '-s', '-z'], { gitDir: dir, workTree: cwd });
  if (!out) return [];
  return out.split('\0').filter(l => l.startsWith('160000 ')).map(l => l.split('\t')[1]).filter(Boolean);
}

// The other files (images, sounds, models and the like, which the snapshot
// does not record): their paths only, so files added or removed during the
// task are known without reading them. Folders git leaves out as a whole
// (Library/, Temp/) count as one entry and are skipped.
const OTHER_SKIP = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$|\.(tmp|swp|lock)$|~$/i;
async function otherFiles(dir, cwd) {
  const out = await git(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], { gitDir: dir, workTree: cwd });
  if (out == null) return null;
  return new Set(out.split('\0').filter(p => p && !p.endsWith('/') && !OTHER_SKIP.test(p)));
}
// Kept here, by snapshot, so the snapshot itself stays small (it goes to
// the window and into the saved Changes cards).
const otherLists = new Map();   // snapshot id -> Set of paths

async function folderSnapshot(cwd, root, project) {
  const dir = await privateRepo(cwd, root, project);
  return withLock(dir, async () => {
    const tree = await recordTree(dir, cwd);
    if (!tree) return null;
    const others = await otherFiles(dir, cwd).catch(() => null);
    const othersId = others ? crypto.randomUUID() : null;
    if (others) {
      otherLists.set(othersId, others);
      // A few hundred tasks at most are kept.
      if (otherLists.size > 300) otherLists.delete(otherLists.keys().next().value);
    }
    const nested = [];
    for (const rel of await nestedRepos(dir, cwd)) {
      const snap = await repoSnapshot(path.join(cwd, rel));
      if (snap) nested.push({ path: rel, snap });
    }
    // The newest state recorded, for a task that cannot wait for its own (quickSnapshot).
    try { fs.writeFileSync(path.join(dir, LAST), JSON.stringify({ tree, at: Date.now() })); } catch { /* only the quick one misses it */ }
    return { kind: 'folder', dir, tree, nested, othersId };
  });
}

// A snapshot at once, when a task cannot wait for its own (a big Unity
// project's first one after the app starts takes minutes): the newest state
// the app recorded of the folder before, even from an earlier session, with
// since: the task's start. Comparing with it (folderChanges) counts only the
// files changed after that moment, so what changed in between (your work,
// other agents) stays out. null for a git repository (its own snapshot is
// quick) or a folder never recorded.
const LAST = 'last-snapshot.json';
async function quickSnapshot(cwd, root) {
  if (!root || !fs.existsSync(cwd)) return null;
  if (await git(['rev-parse', '--show-toplevel'], { cwd })) return null;
  const dir = privateDir(cwd, root);
  if (!fs.existsSync(path.join(dir, 'HEAD'))) { logSnapshot(root, cwd, 'quick: never recorded', Date.now()); return null; }
  let tree = null;
  try { tree = JSON.parse(fs.readFileSync(path.join(dir, LAST), 'utf8')).tree; } catch { /* recorded before this was kept */ }
  // The state of the last recording is in the repository's index; reading
  // it does not wait for a recording that is running now.
  if (!tree) tree = (await git(['write-tree'], { gitDir: dir, workTree: cwd }))?.trim() || null;
  logSnapshot(root, cwd, tree ? 'quick: the newest recorded state' : 'quick: none', Date.now());
  if (!tree) return null;
  return { kind: 'folder', dir, tree, nested: [], othersId: null, since: Date.now() - 1000 };
}

// Only the files changed since a moment (a quick snapshot's since): by their
// time on disk; a deleted file by its folder's.
function changedSince(cwd, diff, since) {
  const blocks = diff.split(/(?=^diff --git )/m);
  return blocks.filter(block => {
    const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(block);
    if (!m) return true;
    const file = path.join(cwd, m[2]);
    try { return fs.statSync(file).mtimeMs >= since; } catch { /* deleted */ }
    try { return fs.statSync(path.dirname(file)).mtimeMs >= since; } catch { return true; }
  }).join('');
}

// The other files added or removed since the snapshot, as git diff blocks.
async function otherChanges(cwd, snap) {
  const before = snap.othersId && otherLists.get(snap.othersId);
  if (!before) return '';
  const now = await otherFiles(snap.dir, cwd).catch(() => null);
  if (!now) return '';
  const blocks = [];
  for (const p of now) {
    if (before.has(p)) continue;
    blocks.push(`diff --git a/${p} b/${p}\nnew file mode 100644\nBinary files /dev/null and b/${p} differ\n`);
    if (blocks.length >= 300) break;
  }
  for (const p of before) {
    if (now.has(p)) continue;
    blocks.push(`diff --git a/${p} b/${p}\ndeleted file mode 100644\nBinary files a/${p} and /dev/null differ\n`);
    if (blocks.length >= 600) break;
  }
  return blocks.join('');
}

async function folderChanges(cwd, snap) {
  const tree = await withLock(snap.dir, () => recordTree(snap.dir, cwd));
  if (!tree) return null;
  const parts = [];
  if (tree !== snap.tree) {
    const diff = await git(['diff', '--no-color', '--no-ext-diff', '--ignore-cr-at-eol', '--no-renames', snap.tree, tree], { gitDir: snap.dir });
    if (diff) parts.push(diff);
  }
  for (const n of snap.nested) {
    const diff = await repoChanges(path.join(cwd, n.path), n.snap, n.path);
    if (diff) parts.push(diff);
  }
  const others = await withLock(snap.dir, () => otherChanges(cwd, snap));
  if (others) parts.push(others);
  // Removes data that no snapshot refers to any more, when there is enough of it.
  git(['gc', '--auto', '--quiet'], { gitDir: snap.dir });
  return snap.since ? changedSince(cwd, parts.join(''), snap.since) : parts.join('');
}

// ---------- a file as it was ----------

// The content of one file (path relative to cwd) as the snapshot recorded
// it, as a Buffer; null when the snapshot does not have it. Undo uses it for
// files it cannot rebuild from the diff (binary files).
function show(args, opts) {
  const prefix = [];
  if (opts.gitDir) prefix.push('--git-dir', opts.gitDir);
  if (opts.cwd) prefix.push('-C', opts.cwd);
  return new Promise(resolve => {
    execFile('git', [...prefix, ...args], { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024, timeout: 60000 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

async function fileAt(cwd, snap, rel) {
  if (!snap || typeof rel !== 'string') return null;
  rel = rel.split(path.sep).join('/');
  if (snap.kind === 'folder') {
    // A file inside an embedded package that is a repository of its own.
    const nested = (snap.nested || []).find(n => rel.startsWith(n.path + '/'));
    if (nested) return fileAt(path.join(cwd, nested.path), nested.snap, rel.slice(nested.path.length + 1));
    return show(['show', `${snap.tree}:${rel}`], { gitDir: snap.dir });
  }
  // In a repository, paths in the commit are relative to its top folder.
  const top = (await git(['rev-parse', '--show-prefix'], { cwd }))?.trim() || '';
  return show(['show', `${snap.base}:${top}${rel}`], { cwd });
}

// ---------- public ----------

// root is the folder where the app keeps its private repositories.
async function snapshot(cwd, root) {
  const started = Date.now();
  const done = (snap, what) => { logSnapshot(root, cwd, snap ? `${what}: ${snap.kind}` : `${what}: none${lastGitError ? ` (${lastGitError})` : ''}`, started); return snap; };
  lastGitError = '';
  const top = (await git(['rev-parse', '--show-toplevel'], { cwd }))?.trim();
  if (top) return done(await repoSnapshot(cwd), `git repository ${top}`);
  if (!root || !fs.existsSync(cwd)) return done(null, 'folder missing');
  // Your home folder (or a folder above it) holds far too many files to record.
  if (os.homedir().startsWith(path.resolve(cwd))) return done(null, 'home folder or above');
  const projects = await unityProjects(cwd);
  if (projects.length > 1) return done(null, `${projects.length} Unity projects inside`);
  return done(await folderSnapshot(cwd, root, projects[0] || ''), 'folder');
}

// Unified diff of everything that changed since the snapshot, with paths
// relative to cwd.
async function changesSince(cwd, snap) {
  if (!snap) return null;
  if (snap.kind === 'folder') return folderChanges(cwd, snap);
  return repoChanges(cwd, snap);
}

module.exports = { snapshot, quickSnapshot, changesSince, fileAt };
