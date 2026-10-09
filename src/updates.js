// Updates for the stable copy (the folder on master). The app asks GitHub
// whether master has moved on, and the top bar offers the new version. On a
// click the stable copy moves forward to it and the app restarts. The dev
// copy never checks: you update it yourself.

const { execFile, spawn } = require('child_process');

// Git never asks for a password here: without a terminal it would wait forever.
const run = (dir, args, timeout = 30000) => new Promise(resolve => {
  execFile('git', ['-C', dir, ...args], { timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, windowsHide: true },
    (err, out) => resolve(err ? null : out.trim()));
});

// The packages in package-lock.json at a commit, without the app's own
// version number, which changes with every release (as in promote.js).
async function packagesAt(dir, rev) {
  try {
    const lock = JSON.parse(await run(dir, ['show', `${rev}:package-lock.json`]));
    const packages = { ...lock.packages };
    if (packages['']) packages[''] = { ...packages[''], version: undefined };
    return packages;
  } catch {
    return null;
  }
}

// Resolves with { version, behind, commits } when GitHub's master is ahead
// of this copy, or null when there is nothing to update (or no way to tell).
async function check(dir) {
  if (await run(dir, ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'master') return null;
  if (await run(dir, ['fetch', '-q', 'origin', 'master'], 60000) == null) return null;
  // Only a plain step forward: a copy with commits of its own is left alone.
  if (await run(dir, ['merge-base', '--is-ancestor', 'HEAD', 'origin/master']) == null) return null;
  const behind = Number(await run(dir, ['rev-list', '--count', 'HEAD..origin/master']));
  if (!behind) return null;
  let version = null;
  try { version = JSON.parse(await run(dir, ['show', 'origin/master:package.json'])).version; } catch {}
  const log = await run(dir, ['log', '--format=%s', '-n', '15', 'HEAD..origin/master']);
  const commits = (log || '').split(/\r?\n/).filter(s => s && !/^Release v/.test(s) && !/^Merge /.test(s));
  return { version, behind, commits };
}

// Moves the stable copy forward to GitHub's master. Resolves with
// { ok: true, packagesChanged, electronChanged } or { ok: false, error }.
async function apply(dir) {
  const oldHead = await run(dir, ['rev-parse', 'HEAD']);
  if (await run(dir, ['status', '--porcelain']) !== '') {
    return { ok: false, error: `${dir} has changes of its own. Commit or undo them first.` };
  }
  const merged = await new Promise(resolve => {
    execFile('git', ['-C', dir, 'merge', '--ff-only', '-q', 'origin/master'], { timeout: 60000, windowsHide: true },
      (err, _out, stderr) => resolve(err ? (stderr || err.message).trim() : null));
  });
  if (merged != null) return { ok: false, error: merged || 'git merge failed.' };
  const newHead = await run(dir, ['rev-parse', 'HEAD']);
  const before = await packagesAt(dir, oldHead);
  const after = await packagesAt(dir, newHead);
  return {
    ok: true,
    packagesChanged: JSON.stringify(before) !== JSON.stringify(after),
    electronChanged: before?.['node_modules/electron']?.version !== after?.['node_modules/electron']?.version,
  };
}

// New packages can't be installed while this app runs from them (Windows
// locks electron.exe), so a separate shell waits for the app to quit,
// installs them, rebuilds the clickable app if Electron changed, and opens
// the app again.
function installAndRelaunch(dir, { electronChanged }) {
  const electron = process.execPath;
  const makeApp = electronChanged ? 'node scripts/make-app.js' : null;
  if (process.platform === 'win32') {
    const steps = ['timeout /t 3 /nobreak >nul', 'npm ci', makeApp, `start "" "${electron}" .`].filter(Boolean);
    spawn('cmd.exe', ['/d', '/c', steps.join(' & ')], { cwd: dir, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    const steps = ['sleep 3', 'npm ci', makeApp, `"${electron}" . &`].filter(Boolean);
    spawn('/bin/sh', ['-lc', steps.join('; ')], { cwd: dir, detached: true, stdio: 'ignore' }).unref();
  }
}

// The changelog behind the version in the top bar, made from git: one entry
// per release tag (vX.Y.Z, newest first) with the commits since the release
// before it. Commits after the newest release (the dev copy) come first, as
// "not released yet". Release and merge commits are left out.
// Resolves with [{ version, date, unreleased, changes: [text] }].
async function changelog(dir, { releases = 20 } = {}) {
  const tagList = await run(dir, ['tag', '-l', 'v*', '--sort=-v:refname']);
  const tags = (tagList || '').split(/\r?\n/).filter(t => /^v\d+\.\d+\.\d+$/.test(t)).slice(0, releases + 1);
  const subjects = async range => {
    const out = await run(dir, ['log', '--no-merges', '--format=%s', range]);
    return (out || '').split(/\r?\n/).filter(s => s && !/^Release v/.test(s) && !/^Merge /.test(s));
  };
  const entries = [];
  const unreleased = tags.length ? await subjects(`${tags[0]}..HEAD`) : [];
  if (unreleased.length) entries.push({ version: null, date: null, unreleased: true, changes: unreleased });
  for (let i = 0; i < Math.min(tags.length, releases); i++) {
    const tag = tags[i];
    const prev = tags[i + 1];
    const changes = await subjects(prev ? `${prev}..${tag}` : tag);
    const date = await run(dir, ['log', '-1', '--format=%cs', tag]);
    entries.push({ version: tag.slice(1), date, unreleased: false, changes: prev ? changes : changes.slice(0, 40) });
  }
  return entries;
}

module.exports = { check, apply, installAndRelaunch, changelog };
