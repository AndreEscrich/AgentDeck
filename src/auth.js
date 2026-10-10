// Signing Claude Code in again, from inside the app, when its saved login
// has expired (see showLoginCard in app.js).
//
//   claude auth login   opens the sign-in page in your browser and waits
//   claude auth status  { loggedIn, email, ... } as JSON
//
// login() streams the command's output to the window ('auth:output'), so the
// card can show the sign-in link and ask for a code when the browser can't
// hand it back by itself; input() writes that code to the command.

const os = require('os');
const { spawnClaude, killTree, childEnv } = require('./platform');

let proc = null;

function login(config, send) {
  if (proc) killTree(proc);
  return new Promise(resolve => {
    const p = spawnClaude(config.claudePath, ['auth', 'login'],
      { cwd: os.homedir(), env: childEnv(config.env), stdio: ['pipe', 'pipe', 'pipe'] });
    proc = p;
    let out = '';
    const onData = d => {
      const text = d.toString('utf8');
      out = (out + text).slice(-8000);
      send('auth:output', text);
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    const timer = setTimeout(() => killTree(p), 10 * 60 * 1000);
    const done = code => {
      clearTimeout(timer);
      if (proc === p) proc = null;
      resolve({ ok: code === 0, message: out.trim().split('\n').slice(-3).join('\n') });
    };
    p.on('error', err => { out += err.message; done(-1); });
    p.on('close', done);
  });
}

function input(text) {
  if (proc && proc.stdin.writable) proc.stdin.write(String(text).trim() + '\n');
}

function cancel() {
  if (proc) killTree(proc);
}

function status(config) {
  return new Promise(resolve => {
    const p = spawnClaude(config.claudePath, ['auth', 'status', '--json'],
      { cwd: os.homedir(), env: childEnv(config.env), stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    const timer = setTimeout(() => killTree(p), 20000);
    p.on('error', () => { clearTimeout(timer); resolve(null); });
    p.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out)); } catch { resolve(null); }
    });
  });
}

module.exports = { login, input, cancel, status };
