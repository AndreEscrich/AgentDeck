// Checking an agent's work after a turn that changed code, before it counts
// as done (Settings → Agents → Verify; Tactile Create's "verification
// depth"). The app runs the checks itself, so an agent cannot hand back work
// that does not compile by saying it does. Levels: compile, or tests (compile,
// then the tests).
//
// What runs depends on the project:
//   Unity        the project's Unity bridge (com.tactilegames.unity-mcp, the
//                server in Library/McpServer that agents use too) in the open
//                Editor: unity_recompile, then unity_run_tests (EditMode).
//                Without an open Editor nothing can be checked.
//   Game Engine  its CLI: gameengine check (type check, validate, a cook and
//                a smoke run), then gameengine test.
//   TypeScript   the project's own tsc --noEmit, then its npm test script.
// Other projects have nothing to check: detect() says so and no check runs.
//
// run(config, cwd, level) resolves with { ok, blocked, kind, gates: [{ name,
// ok, summary, details }] }: blocked (a reason) when the checks could not
// run at all (no Editor open), ok when every gate passed.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { unityRoot } = require('./setupcheck');
const { childEnv, killTree } = require('./platform');

const MAX_DETAILS = 40;   // lines of errors handed to the agent

// The folder above cwd (or cwd) that has this file, within a few levels.
function findUp(cwd, file, levels = 6) {
  let dir = path.resolve(cwd || '.');
  for (let i = 0; i < levels; i++) {
    if (fs.existsSync(path.join(dir, file))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

// The Game Engine's CLI for a project: the project's own engine checkout,
// else the installed editor's.
function gameEngineCli(root) {
  const rel = path.join('tools', 'cli', 'bin', 'gameengine.mjs');
  const candidates = [
    path.join(root, '.gameengine', 'engine', rel),
    process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Tactile Game Engine', 'resources', 'engine', rel) : null,
    process.platform === 'darwin' ? path.join('/Applications', 'Tactile Game Engine.app', 'Contents', 'Resources', 'engine', rel) : null,
  ].filter(Boolean);
  return candidates.find(c => fs.existsSync(c)) || null;
}

// What can be checked in cwd: { kind: 'unity'|'gameengine'|'typescript', root, … } or null.
function detect(cwd) {
  if (!cwd) return null;
  const unity = unityRoot(cwd);
  if (unity && fs.existsSync(path.join(unity, 'Library', 'McpServer', 'index.js'))) return { kind: 'unity', root: unity };
  const engine = findUp(cwd, 'project.gameengine.json');
  if (engine && gameEngineCli(engine)) return { kind: 'gameengine', root: engine, cli: gameEngineCli(engine) };
  const ts = findUp(cwd, 'tsconfig.json');
  if (ts) {
    const tsc = path.join(ts, 'node_modules', 'typescript', 'bin', 'tsc');
    let test = null;
    try { test = JSON.parse(fs.readFileSync(path.join(ts, 'package.json'), 'utf8')).scripts?.test || null; } catch { test = null; }
    if (/no test specified/.test(test || '')) test = null;
    if (fs.existsSync(tsc) || test) return { kind: 'typescript', root: ts, tsc: fs.existsSync(tsc) ? tsc : null, test };
  }
  return null;
}

// Runs a command; resolves with { code, out } (stdout and stderr together).
function command(cmd, args, { cwd, env, timeout = 10 * 60 * 1000, shell = false } = {}) {
  return new Promise(resolve => {
    let out = '';
    let proc;
    try {
      proc = spawn(cmd, args, { cwd, env, shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, out: err.message });
      return;
    }
    proc.stdout.on('data', d => { out = (out + d).slice(-400000); });
    proc.stderr.on('data', d => { out = (out + d).slice(-400000); });
    const timer = setTimeout(() => { out += '\n(timed out)'; killTree(proc); }, timeout);
    proc.on('error', err => { clearTimeout(timer); resolve({ code: -1, out: out + err.message }); });
    proc.on('close', code => { clearTimeout(timer); resolve({ code, out }); });
  });
}

const tailLines = (text, n = MAX_DETAILS) => String(text || '').trim().split(/\r?\n/).slice(-n).join('\n');

// ---------- Unity ----------

// Calls tools of the project's Unity bridge, the MCP server agents use
// (Library/McpServer/index.js, which knows how to wait for a recompile, a
// domain reload or a test run), over its stdin and stdout.
function unityBridge(root, env) {
  const proc = spawn('node', [path.join('Library', 'McpServer', 'index.js')], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let nextId = 1;
  const waiting = new Map();
  proc.stdout.on('data', d => {
    buffer += d;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const w = msg.id != null && waiting.get(msg.id);
      if (w) { waiting.delete(msg.id); w(msg); }
    }
  });
  proc.stderr.on('data', () => {});
  const failAll = reason => { for (const w of waiting.values()) w({ error: { message: reason } }); waiting.clear(); };
  proc.on('error', err => failAll(err.message));
  proc.on('close', () => failAll('The Unity bridge stopped.'));
  const request = (method, params, timeout) => new Promise(resolve => {
    const id = nextId++;
    const timer = setTimeout(() => { waiting.delete(id); resolve({ error: { message: 'timed out' } }); }, timeout);
    waiting.set(id, msg => { clearTimeout(timer); resolve(msg); });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return {
    async start() {
      const r = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agent-hub-verify', version: '1' } }, 30000);
      if (r.error) throw new Error(r.error.message);
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    },
    // The tool's answer, parsed from its text (the bridge answers in JSON).
    async call(name, args, timeout) {
      const r = await request('tools/call', { name, arguments: args }, timeout);
      if (r.error) throw new Error(r.error.message);
      const text = (r.result?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      if (r.result?.isError) throw new Error(text || `${name} failed`);
      try { return JSON.parse(text); } catch { return { text }; }
    },
    close() { killTree(proc); },
  };
}

function unityErrors(result) {
  const list = Array.isArray(result?.errors) ? result.errors : [];
  return list.slice(0, MAX_DETAILS).map(e => (typeof e === 'string' ? e
    : `${e.file || e.path || ''}${e.line ? `(${e.line}${e.column ? `,${e.column}` : ''})` : ''}: ${e.message || e.text || JSON.stringify(e)}`)).join('\n');
}

async function unityGates(root, level, env) {
  const { editors } = require('./unityapp');
  const open = (await editors().catch(() => [])).some(e => path.resolve(e.project).toLowerCase() === path.resolve(root).toLowerCase());
  if (!open) return { blocked: 'The Unity Editor is not open for this project, so nothing could be compiled or tested.' };
  const bridge = unityBridge(root, env);
  const gates = [];
  try {
    await bridge.start();
    const compile = await bridge.call('unity_recompile', {}, 5 * 60 * 1000);
    const errorCount = compile.errorCount ?? (Array.isArray(compile.errors) ? compile.errors.length : 0);
    const compiled = compile.compilationSucceeded !== false && !errorCount;
    gates.push({ name: 'compile', ok: compiled, summary: compiled ? 'Unity compiled it without errors' : `${errorCount} compile error${errorCount === 1 ? '' : 's'}`, details: compiled ? '' : unityErrors(compile) });
    if (compiled && level === 'tests') {
      const t = await bridge.call('unity_run_tests', { mode: 'EditMode' }, 20 * 60 * 1000);
      const failed = t.failCount || 0;
      const passed = t.passCount || 0;
      const ok = !failed && !t.error && t.started !== false;
      const names = Array.isArray(t.failedTests) ? t.failedTests.slice(0, MAX_DETAILS).map(f => (typeof f === 'string' ? f : `${f.name || f.fullName || ''}: ${f.message || ''}`.trim())).join('\n') : '';
      gates.push({
        name: 'tests', ok,
        summary: ok ? (passed ? `${passed} EditMode test${passed === 1 ? '' : 's'} passed` : 'No EditMode tests ran') : t.error ? `The tests did not run: ${t.error}` : `${failed} of ${failed + passed} EditMode tests failed`,
        details: ok ? '' : names || String(t.error || ''),
      });
    }
  } catch (err) {
    return { blocked: `The Unity bridge did not answer: ${err.message}`, gates };
  } finally {
    bridge.close();
  }
  return { gates };
}

// ---------- Game Engine and TypeScript ----------

async function gameEngineGates(info, level, env) {
  const gates = [];
  const check = await command('node', [info.cli, 'check', '--json'], { cwd: info.root, env });
  let parsed = null;
  try { parsed = JSON.parse(check.out.slice(check.out.indexOf('{'), check.out.lastIndexOf('}') + 1)); } catch { parsed = null; }
  const failing = (parsed?.checks || []).filter(c => !c.ok);
  const ok = parsed ? parsed.ok !== false && !failing.length : check.code === 0;
  gates.push({
    name: 'compile', ok,
    summary: ok ? 'gameengine check passed (type check, validate, cook, smoke run)' : `gameengine check failed: ${failing.map(c => c.name).join(', ') || 'see the output'}`,
    details: ok ? '' : failing.length ? failing.map(c => `${c.name}: ${c.detail}`).join('\n\n') : tailLines(check.out),
  });
  if (ok && level === 'tests') {
    const t = await command('node', [info.cli, 'test'], { cwd: info.root, env });
    gates.push({ name: 'tests', ok: t.code === 0, summary: t.code === 0 ? 'gameengine test passed' : 'gameengine test failed', details: t.code === 0 ? '' : tailLines(t.out) });
  }
  return { gates };
}

async function typeScriptGates(info, level, env) {
  const gates = [];
  if (info.tsc) {
    const c = await command('node', [info.tsc, '--noEmit', '-p', info.root], { cwd: info.root, env });
    gates.push({ name: 'compile', ok: c.code === 0, summary: c.code === 0 ? 'tsc --noEmit found no errors' : 'tsc --noEmit found errors', details: c.code === 0 ? '' : tailLines(c.out) });
    if (c.code !== 0) return { gates };
  }
  if (level === 'tests' && info.test) {
    const t = await command('npm', ['test'], { cwd: info.root, env, shell: process.platform === 'win32' });
    gates.push({ name: 'tests', ok: t.code === 0, summary: t.code === 0 ? 'npm test passed' : 'npm test failed', details: t.code === 0 ? '' : tailLines(t.out) });
  }
  return { gates };
}

// One check at a time per project: two agents finishing together would
// otherwise recompile the same Editor at once.
const running = new Map();   // root -> promise

async function run(config, cwd, level) {
  if (level !== 'compile' && level !== 'tests') return { ok: true, gates: [] };
  const info = detect(cwd);
  if (!info) return { ok: true, kind: null, gates: [] };
  const env = childEnv(config.env);
  const previous = running.get(info.root) || Promise.resolve();
  const mine = previous.catch(() => {}).then(async () => {
    const r = info.kind === 'unity' ? await unityGates(info.root, level, env)
      : info.kind === 'gameengine' ? await gameEngineGates(info, level, env)
        : await typeScriptGates(info, level, env);
    const gates = r.gates || [];
    return { kind: info.kind, blocked: r.blocked || null, gates, ok: !r.blocked && gates.every(g => g.ok) };
  });
  running.set(info.root, mine);
  try { return await mine; } finally { if (running.get(info.root) === mine) running.delete(info.root); }
}

module.exports = { run, detect };
