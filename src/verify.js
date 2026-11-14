// Checking an agent's work in a Unity project after a turn that changed its
// C#, before it counts as done (Settings → Agents → Checks before done;
// Tactile Create's "verification depth"). The app runs the checks itself, so
// an agent cannot hand back work that does not compile by saying it does.
// Levels: compile, or tests (compile, then the EditMode tests).
//
// It goes through the project's Unity bridge (com.tactilegames.unity-mcp,
// the server in Library/McpServer that agents use too) to the open Editor:
// unity_recompile, then unity_run_tests. Without an open Editor nothing can
// be checked. A folder that is not such a Unity project has nothing to check:
// detect() says so and no check runs.
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

// What can be checked in cwd: { kind: 'unity', root } or null.
function detect(cwd) {
  if (!cwd) return null;
  const unity = unityRoot(cwd);
  if (unity && fs.existsSync(path.join(unity, 'Library', 'McpServer', 'index.js'))) return { kind: 'unity', root: unity };
  return null;
}

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
    const r = await unityGates(info.root, level, env);
    const gates = r.gates || [];
    return { kind: info.kind, blocked: r.blocked || null, gates, ok: !r.blocked && gates.every(g => g.ok) };
  });
  running.set(info.root, mine);
  try { return await mine; } finally { if (running.get(info.root) === mine) running.delete(info.root); }
}

module.exports = { run, detect };
