// Moves the tested changes from the `dev` branch to `master`, and updates the
// stable copy (the folder on `master`) that the Agent Hub app runs. Works the
// same on macOS and Windows.
//
// Run it from the dev folder:
//   npm run promote                  move dev to master
//   npm run promote -- 0.3.0         also set the version to 0.3.0 and tag it v0.3.0
//   npm run promote -- 0.3.0 --push  also upload master, dev and the tag to GitHub
//
// Afterwards, quit and reopen Agent Hub to use the new version.

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEV = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const push = args.includes('--push');
const version = args.find(a => !a.startsWith('--')) || '';

const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
const fail = msg => { console.error(msg); process.exit(1); };
// npm is npm.cmd on Windows, which needs the shell to start.
const npm = (cwd, ...a) => {
  const r = spawnSync('npm', a, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) fail(`npm ${a.join(' ')} failed.`);
};

if (git(DEV, 'branch', '--show-current') !== 'dev') fail('Run this from the folder that is on the dev branch.');
if (git(DEV, 'status', '--porcelain')) fail('The dev folder has uncommitted changes. Commit them first.');

// The stable copy is the worktree that has master checked out.
let stable = null;
let current = null;
for (const line of git(DEV, 'worktree', 'list', '--porcelain').split(/\r?\n/)) {
  if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
  if (line === 'branch refs/heads/master') stable = current;
}
if (!stable) fail('No folder has the master branch checked out.');

// The packages in package-lock.json, without the app's own version number,
// which changes with every release.
const packagesAt = rev => {
  try {
    const lock = JSON.parse(git(stable, 'show', `${rev}:package-lock.json`));
    const packages = { ...lock.packages };
    if (packages['']) packages[''] = { ...packages[''], version: undefined };
    return packages;
  } catch {
    return null;
  }
};

// Checked before anything changes, so the same command can run again once
// the cause is gone.
try {
  execFileSync('git', ['-C', DEV, 'merge-base', '--is-ancestor', 'master', 'dev']);
} catch {
  fail('master has commits that dev does not (a pull request merged on GitHub?). Merge master into dev first: git merge master');
}
// npm ci deletes node_modules first and stops at the first file it can't
// delete: on Windows, Electron's, while Agent Hub runs from it. The app then
// has neither its packages nor all of Electron, and does not start again.
if (JSON.stringify(packagesAt('HEAD')) !== JSON.stringify(packagesAt('dev'))) {
  const exe = path.join(stable, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (process.platform === 'win32' && fs.existsSync(exe)) {
    // A running program can be renamed but not opened for writing.
    try {
      fs.closeSync(fs.openSync(exe, 'r+'));
    } catch {
      fail('This release installs new packages in the stable copy, which Agent Hub is running from. Quit Agent Hub, then run this again.');
    }
  }
}

if (version) {
  npm(DEV, 'version', version, '--no-git-tag-version');
  execFileSync('git', ['-C', DEV, 'commit', '-qam', `Release v${version}`]);
}

const oldHead = git(stable, 'rev-parse', 'HEAD');
execFileSync('git', ['-C', stable, 'merge', '--ff-only', '-q', 'dev'], { stdio: 'inherit' });
const newHead = git(stable, 'rev-parse', 'HEAD');
if (version) git(stable, 'tag', `v${version}`);

if (oldHead === newHead) {
  console.log('master already has everything from dev.');
} else {
  console.log(`master moved from ${oldHead.slice(0, 7)} to ${newHead.slice(0, 7)}:`);
  console.log(git(stable, 'log', '--oneline', `${oldHead}..${newHead}`));
}

const before = packagesAt(oldHead);
const after = packagesAt(newHead);
const packagesChanged = JSON.stringify(before) !== JSON.stringify(after);
if (packagesChanged) {
  console.log('Packages changed, installing them in the stable copy…');
  npm(stable, 'ci');
  // npm ci removes Electron itself (node_modules/electron/dist) and, since
  // Electron 42, does not download it again: the Windows app runs from there.
  const r = spawnSync(process.execPath, [path.join(stable, 'node_modules', 'electron', 'install.js')], { cwd: stable, stdio: 'inherit' });
  if (r.status !== 0) fail('Downloading Electron failed.');
}

// A new Electron version or a new icon needs a rebuilt app.
const changed = file => git(stable, 'diff', '--name-only', oldHead, newHead, '--', file) !== '';
const electronChanged = before?.['node_modules/electron']?.version !== after?.['node_modules/electron']?.version;
if (electronChanged || ['build/icon.png', 'build/icon.ico', 'scripts/make-app.sh', 'scripts/make-app-win.ps1'].some(changed)) {
  console.log('Rebuilding the Agent Hub app…');
  const r = spawnSync(process.execPath, [path.join(stable, 'scripts', 'make-app.js')], { cwd: stable, stdio: 'inherit' });
  if (r.status !== 0) fail('Rebuilding the app failed.');
}

if (push) {
  execFileSync('git', ['-C', DEV, 'push', '-q', 'origin', 'master', 'dev'], { stdio: 'inherit' });
  if (version) execFileSync('git', ['-C', DEV, 'push', '-q', 'origin', `v${version}`], { stdio: 'inherit' });
  console.log('Uploaded to GitHub.');
}

console.log('Done. Quit and reopen Agent Hub to use the new version.');
