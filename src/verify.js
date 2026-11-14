// Checking an agent's work in a Unity project after a turn that changed its
// C#, before it counts as done (Settings → Agents → Checks before done;
// Tactile Create's "verification depth"). The app runs the checks itself, so
// an agent cannot hand back work that does not compile by saying it does.
// Levels: compile, or tests (compile, then the EditMode tests).
//
// It talks to the open Editor through the Editor side of the project's
// Unity bridge (com.tactilegames.unity-mcp, the one agents use too): a
// recompile, then the EditMode tests. Without an open Editor nothing can be
// checked. A folder that is not such a Unity project has nothing to check:
// detect() says so and no check runs.
//
// run(config, cwd, level) resolves with { ok, blocked, kind, gates: [{ name,
// ok, summary, details }] }: blocked (a reason) when the checks could not
// run at all (no Editor open), ok when every gate passed.

const fs = require('fs');
const path = require('path');
const { unityRoot } = require('./setupcheck');

const MAX_DETAILS = 40;   // lines of errors handed to the agent

// What can be checked in cwd: { kind: 'unity', root } or null.
function detect(cwd) {
  if (!cwd) return null;
  const unity = unityRoot(cwd);
  if (unity && fs.existsSync(path.join(unity, 'Library', 'McpServer', 'index.js'))) return { kind: 'unity', root: unity };
  return null;
}

// ---------- Unity ----------

// The Editor's side of the Unity bridge answers HTTP at the address the
// package writes to Library/McpServer/bridge-url. /compile/status and /ping
// answer at once, also while the Editor is in the background (where Windows
// and macOS slow it down); the other routes wait for its main thread.
function bridgeUrl(root) {
  try { return fs.readFileSync(path.join(root, 'Library', 'McpServer', 'bridge-url'), 'utf8').trim() || null; } catch { return null; }
}

async function post(base, route, body = {}, timeout = 60000) {
  const res = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`Unity answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Until the Editor answers again and is ready (after a recompile it reloads).
async function waitReady(base, timeout = 5 * 60 * 1000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const ping = await post(base, '/ping', {}, 10000);
      if ((!ping.phase || ping.phase === 'ready') && !ping.isCompiling) return ping;
    } catch { /* reloading */ }
    await sleep(1000);
  }
  throw new Error('Unity did not get ready again within 5 minutes.');
}

// Recompiles and resolves with the errors of that compile. Unity starts the
// compile a little after it is asked to, a while later when its window is in
// the background, so "not compiling" right after the request means nothing:
// the result only counts once the compile was seen (compiling, or the
// Editor away for its reload) and has settled. Without that, the errors of
// the compile before would come back as if they were this one's.
async function recompile(base) {
  await post(base, '/compile/recompile', {}, 3 * 60 * 1000);
  const start = Date.now();
  let seen = false;
  let idleSince = 0;
  while (Date.now() - start < 10 * 60 * 1000) {
    let status = null;
    try { status = await post(base, '/compile/status', {}, 10000); } catch { seen = true; idleSince = 0; }
    if (status?.isCompiling) { seen = true; idleSince = 0; }
    else if (status && seen) {
      idleSince = idleSince || Date.now();
      if (Date.now() - idleSince > 1500) break;
    } else if (status && Date.now() - start > 120000) {
      throw new Error('Unity did not start compiling within 2 minutes.');
    }
    await sleep(400);
  }
  await waitReady(base);
  return post(base, '/compile/errors', {}, 3 * 60 * 1000);
}

// Runs the EditMode tests and resolves with the status of that run (its runId).
async function editModeTests(base) {
  const started = await post(base, '/tests/run-editmode', {}, 3 * 60 * 1000);
  if (started.started === false) return { completed: true, error: started.reason || started.error || 'The tests did not start.' };
  const start = Date.now();
  while (Date.now() - start < 30 * 60 * 1000) {
    await sleep(2000);
    let status;
    try { status = await post(base, '/tests/status', {}, 3 * 60 * 1000); } catch { continue; }
    if (status.runId === started.runId && status.completed) return status;
  }
  return { completed: true, error: 'The tests did not finish within 30 minutes.' };
}

function unityErrors(result) {
  const list = Array.isArray(result?.errors) ? result.errors : [];
  return list.slice(0, MAX_DETAILS).map(e => (typeof e === 'string' ? e
    : e.message && /\(\d+,\d+\): error/.test(e.message) ? e.message
      : `${e.file || ''}${e.line ? `(${e.line}${e.column ? `,${e.column}` : ''})` : ''}: ${e.message || JSON.stringify(e)}`)).join('\n');
}

async function unityGates(root, level) {
  const { editors } = require('./unityapp');
  const open = (await editors().catch(() => [])).some(e => path.resolve(e.project).toLowerCase() === path.resolve(root).toLowerCase());
  const base = bridgeUrl(root);
  if (!open || !base) return { blocked: 'The Unity Editor is not open for this project, so nothing could be compiled or tested.' };
  const gates = [];
  try {
    const compile = await recompile(base);
    const errorCount = compile.errorCount ?? (Array.isArray(compile.errors) ? compile.errors.length : 0);
    const compiled = compile.compilationSucceeded !== false && !errorCount;
    gates.push({ name: 'compile', ok: compiled, summary: compiled ? 'Unity compiled it without errors' : `${errorCount} compile error${errorCount === 1 ? '' : 's'}`, details: compiled ? '' : unityErrors(compile) });
    if (compiled && level === 'tests') {
      const t = await editModeTests(base);
      const failed = t.failCount || 0;
      const passed = t.passCount || 0;
      const ok = !failed && !t.error;
      const names = Array.isArray(t.failedTests) ? t.failedTests.slice(0, MAX_DETAILS).map(f => (typeof f === 'string' ? f : `${f.fullName || f.name || ''}: ${f.message || ''}`.trim())).join('\n') : '';
      gates.push({
        name: 'tests', ok,
        summary: ok ? (passed ? `${passed} EditMode test${passed === 1 ? '' : 's'} passed` : 'No EditMode tests ran') : t.error ? `The tests did not run: ${String(t.error).split('\n')[0]}` : `${failed} of ${failed + passed} EditMode tests failed`,
        details: ok ? '' : names || String(t.error || ''),
      });
    }
  } catch (err) {
    return { blocked: `Unity did not answer: ${err.message}`, gates };
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
  const previous = running.get(info.root) || Promise.resolve();
  const mine = previous.catch(() => {}).then(async () => {
    const r = await unityGates(info.root, level);
    const gates = r.gates || [];
    return { kind: info.kind, blocked: r.blocked || null, gates, ok: !r.blocked && gates.every(g => g.ok) };
  });
  running.set(info.root, mine);
  try { return await mine; } finally { if (running.get(info.root) === mine) running.delete(info.root); }
}

module.exports = { run, detect };
