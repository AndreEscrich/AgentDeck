// Makes Agent Hub clickable: on macOS it builds ~/Applications/Agent Hub.app
// (make-app.sh), on Windows it creates Desktop and Start menu shortcuts
// (make-app-win.ps1). Both run the code in this folder directly.
//
// Run: npm run make-app            (from the stable copy, the folder on master)
//      npm run make-app -- --force (from another branch anyway)

const { spawnSync } = require('child_process');
const path = require('path');

const force = process.argv.includes('--force');

// Since Electron 42, `npm install` (and `npm ci`) no longer download Electron
// itself into node_modules/electron/dist; its install-electron script does.
// The app is a copy of that download, so it is fetched first when missing.
const project = path.join(__dirname, '..');
const dist = path.join(project, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'Electron.app');
if (!require('fs').existsSync(dist)) {
  const install = path.join(project, 'node_modules', 'electron', 'install.js');
  console.log('Downloading Electron…');
  const got = spawnSync(process.execPath, [install], { cwd: project, stdio: 'inherit' });
  if (got.status !== 0) process.exit(got.status ?? 1);
}

const result = process.platform === 'win32'
  ? spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'make-app-win.ps1'), ...(force ? ['-Force'] : [])], { stdio: 'inherit' })
  : spawnSync('bash', [path.join(__dirname, 'make-app.sh'), ...(force ? ['--force'] : [])], { stdio: 'inherit' });
process.exit(result.status ?? 1);
