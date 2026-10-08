// Makes AgentDeck clickable: on macOS it builds ~/Applications/AgentDeck.app
// (make-app.sh), on Windows it creates Desktop and Start menu shortcuts
// (make-app-win.ps1). Both run the code in this folder directly.
//
// Run: npm run make-app            (from the stable copy, the folder on master)
//      npm run make-app -- --force (from another branch anyway)

const { spawnSync } = require('child_process');
const path = require('path');

const force = process.argv.includes('--force');
const result = process.platform === 'win32'
  ? spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'make-app-win.ps1'), ...(force ? ['-Force'] : [])], { stdio: 'inherit' })
  : spawnSync('bash', [path.join(__dirname, 'make-app.sh'), ...(force ? ['--force'] : [])], { stdio: 'inherit' });
process.exit(result.status ?? 1);
