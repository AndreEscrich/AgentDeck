// Everything about starting and stopping processes that differs between macOS
// and Windows: where `claude` is installed, how to start it, the environment
// agents get, and how to stop an agent together with the commands it started.

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const isWin = process.platform === 'win32';
const home = os.homedir();

// ---------- finding claude ----------

const CLAUDE_CANDIDATES = isWin
  ? [
      path.join(home, '.local', 'bin', 'claude.exe'),            // native installer
      path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'), // npm install -g
      path.join(home, '.claude', 'local', 'claude.cmd'),
    ]
  : [
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      path.join(home, '.local/bin/claude'),
      path.join(home, '.claude/local/claude'),
    ];

// The Claude desktop app keeps its own copy of Claude Code, one folder per
// version, and updates it automatically. That copy is often newer than a
// Homebrew or npm install, and a newer copy knows about newer models.
const DESKTOP_DIR = isWin
  ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude-code')
  : path.join(home, 'Library/Application Support/Claude/claude-code');

// On macOS the program sits at <version>/<build>/claude.app/Contents/MacOS/claude.
// On Windows we do not rely on an exact layout: we look for claude.exe up to
// three folders deep.
function desktopCandidates() {
  if (!isWin) {
    const found = [];
    let versions = [];
    try { versions = fs.readdirSync(DESKTOP_DIR); } catch { return found; }
    for (const version of versions) {
      let builds = [];
      try { builds = fs.readdirSync(path.join(DESKTOP_DIR, version)); } catch { continue; }
      for (const build of builds) found.push(path.join(DESKTOP_DIR, version, build, 'claude.app/Contents/MacOS/claude'));
    }
    return found;
  }
  const found = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name.toLowerCase() === 'claude.exe') found.push(p);
      else if (e.isDirectory() && depth < 3) walk(p, depth + 1);
    }
  };
  walk(DESKTOP_DIR, 0);
  return found;
}

// Whatever `where claude` finds on Windows (it can list several matches).
function pathCandidates() {
  if (!isWin) return [];
  try {
    return execFileSync('where', ['claude'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
      .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// Install paths contain the version (".../claude-code/2.1.293/...",
// ".../Caskroom/claude-code/2.1.176/..."). When a path does not, we ask the
// program itself.
function versionOf(binary) {
  const fromPath = binary.match(/[\\/](\d+\.\d+\.\d+)[\\/]/);
  if (fromPath) return fromPath[1];
  try {
    const { command, prefix } = claudeCommand(binary);
    const out = execFileSync(command, [...prefix, '--version'], { timeout: 5000, encoding: 'utf8', windowsHide: true });
    return out.match(/\d+\.\d+\.\d+/)?.[0] || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

// Uses the configured path when there is one. Otherwise it picks the newest
// Claude Code installed on this computer. The answer is kept for five
// minutes, so a desktop app update is picked up without restarting AgentDeck.
let cachedClaude = null;
function findClaude(configured) {
  if (configured && fs.existsSync(configured)) return configured;
  if (cachedClaude && Date.now() - cachedClaude.at < 5 * 60 * 1000) return cachedClaude.path;

  let best = null;
  for (const candidate of [...CLAUDE_CANDIDATES, ...pathCandidates(), ...desktopCandidates()]) {
    let real;
    try { real = fs.realpathSync(candidate); } catch { continue; }
    const version = versionOf(real);
    if (!best || compareVersions(version, best.version) > 0) best = { path: real, version };
  }
  cachedClaude = { path: best?.path || 'claude', version: best?.version, at: Date.now() };
  return cachedClaude.path;
}

// ---------- starting claude ----------

// How to start the program at `binary`. On Windows, an npm install is a
// claude.cmd file, which Node can only start through cmd.exe, and cmd.exe
// would mangle our JSON arguments. So we start the JavaScript file that the
// .cmd file points to with node instead.
function claudeCommand(binary) {
  if (isWin && /\.(cmd|bat)$/i.test(binary)) {
    const cli = path.join(path.dirname(binary), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (fs.existsSync(cli)) return { command: 'node', prefix: [cli] };
  }
  return { command: binary, prefix: [] };
}

// Starts claude with these arguments. Each process gets its own process group
// on macOS, so killTree() can stop it together with the commands it started.
function spawnClaude(configuredPath, args, options) {
  const { command, prefix } = claudeCommand(findClaude(configuredPath));
  return spawn(command, [...prefix, ...args], {
    ...options,
    detached: !isWin,   // on Windows, detached would open a console window
    windowsHide: true,
  });
}

// Stops a process and every process it started.
function killTree(proc) {
  if (!proc?.pid) return;
  try {
    if (isWin) spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(-proc.pid, 'SIGTERM'); // a negative pid means the whole process group
  } catch { /* already gone */ }
}

// ---------- the environment for agents ----------

// An app started from Finder gets a short PATH, so agents could not find
// node, git or brew tools. On macOS we ask your login shell for your real
// PATH once, and also add the usual install folders. Windows gives apps the
// full PATH already.
let cachedLoginPath = null;
function loginShellPath() {
  if (isWin) return '';
  if (cachedLoginPath !== null) return cachedLoginPath;
  try {
    // The markers let us find PATH even when shell startup files print text.
    const out = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "__PATH__%s__END__" "$PATH"'],
      { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    cachedLoginPath = out.match(/__PATH__(.*)__END__/)?.[1] || '';
  } catch {
    cachedLoginPath = '';
  }
  return cachedLoginPath;
}

// When the app is itself started from inside a Claude Code session, that
// session's variables (proxy URL, session ids) would make the child talk to
// the wrong endpoint, so we remove them.
function childEnv(extra) {
  const env = { ...process.env };
  if (env.CLAUDECODE) {
    for (const key of Object.keys(env)) {
      if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_') || key.startsWith('CLAUDE_AGENT_SDK_') || key === 'ANTHROPIC_BASE_URL') {
        delete env[key];
      }
    }
  }
  // Added after the clean-up above, so the app's own settings always apply.
  Object.assign(env, extra);
  // Windows usually spells the variable "Path"; keep whichever spelling exists.
  const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
  const extraPath = isWin
    ? [path.join(home, '.local', 'bin'), path.join(process.env.APPDATA || '', 'npm')]
    : ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local/bin')];
  const parts = [
    ...loginShellPath().split(path.delimiter),
    ...extraPath,
    ...(env[pathKey] || (isWin ? '' : '/usr/bin:/bin')).split(path.delimiter),
  ];
  env[pathKey] = [...new Set(parts.filter(Boolean))].join(path.delimiter);
  return env;
}

module.exports = { isWin, findClaude, spawnClaude, killTree, childEnv };
