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
const before = packagesAt(oldHead);
const after = packagesAt(newHead);
const packagesChanged = JSON.stringify(before) !== JSON.stringify(after);
if (packagesChanged) {
  console.log('Packages changed, installing them in the stable copy…');
  npm(stable, 'ci');
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
