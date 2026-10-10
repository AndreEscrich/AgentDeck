// Diffs that an agent (or you, with /diff) asks Agent Hub to show: a branch,
// a commit, uncommitted changes. The agent writes the command in a
// ```agenthub-diff block instead of pasting the diff (see DIFF_PROMPT in
// agents.js), and the window draws the result as a Changes card.
//
// Only read-only diff commands run: git diff, git show and svn diff, without
// a shell, and without the options that write files or run other programs.

const { execFile } = require('child_process');

// Splits a command line into words; quotes group words.
function words(command) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(command))) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// Options that write files, run programs or point git elsewhere.
const UNSAFE = /^(--output|--ext-diff|--textconv|--exec|--upload-pack|--git-dir|--work-tree|--no-index|--namespace|-o.*|-c|-C)(=|$)/;

function run(cmd, args, cwd) {
  return new Promise(resolve => {
    execFile(cmd, args, { cwd, maxBuffer: 80 * 1024 * 1024, timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !stdout) resolve({ ok: false, error: String(stderr || err.message).trim().split('\n').slice(0, 6).join('\n') });
      else resolve({ ok: true, out: stdout });
    });
  });
}

// svn diff, in the shape of git's: "Index: path" starts a file.
// prefix: the folder (inside the working copy) that the paths are relative
// to, when the diff was of a URL.
function svnToGit(text, prefix = '') {
  const p = prefix ? prefix.replace(/\/$/, '') + '/' : '';
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const index = /^Index: (.+)$/.exec(line);
    if (index) { out.push(`diff --git a/${p}${index[1]} b/${p}${index[1]}`); continue; }
    if (/^=+$/.test(line)) continue;
    if (/^--- .*\t\((nonexistent|revision 0)\)$/.test(line)) { out.push('new file mode 100644'); continue; }
    const plus = /^\+\+\+ (.+?)\t\(.*\)$/.exec(line);
    if (plus) { out.push(`+++ b/${p}${plus[1]}`); continue; }
    const minus = /^--- (.+?)\t\(.*\)$/.exec(line);
    if (minus) { out.push(`--- a/${p}${minus[1]}`); continue; }
    out.push(line);
  }
  return out.join('\n');
}

// A diff of a URL (^/project/branches/name/Unity/Assets/Code) names its files
// from that URL. Where that is in your working copy: the URL's path after
// the working copy's own (same branch), or after the branch part (another
// branch, or trunk, with the same layout).
async function svnPrefix(cwd, args) {
  const url = args.find(a => /^(\^\/|[a-z+]+:\/\/)/i.test(a));
  if (!url) return '';
  const info = await run('svn', ['info', '--show-item', 'relative-url'], cwd);
  const mine = info.ok ? info.out.trim().replace(/\/$/, '') : '';
  const target = url.replace(/^[a-z+]+:\/\/[^/]+/i, '').replace(/\/$/, '');
  if (mine && target.startsWith(mine + '/')) return target.slice(mine.length + 1);
  const branchless = u => u.replace(/^\^?\/?/, '').replace(/^(.*?\/)?(trunk|branches\/[^/]+|tags\/[^/]+)\//, '');
  const rel = branchless(target);
  const base = branchless(mine + '/');
  return base && rel.startsWith(base) ? rel.slice(base.length).replace(/^\//, '') : '';
}

// The branch this one split off from: origin's default branch, or a local
// main, master or develop.
async function baseOf(cwd) {
  const remote = await run('git', ['rev-parse', '--abbrev-ref', 'origin/HEAD'], cwd);
  const candidates = [remote.ok ? remote.out.trim() : null, 'origin/main', 'origin/master', 'main', 'master', 'develop'].filter(Boolean);
  const current = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).out?.trim();
  for (const ref of candidates) {
    if (ref === current) continue;
    const base = await run('git', ['merge-base', 'HEAD', ref], cwd);
    if (base.ok && base.out.trim()) return { ref, base: base.out.trim() };
  }
  return null;
}

// Resolves with { ok, diff, title } or { ok: false, error }. An empty
// command: this branch against where it split off (in git), or the
// uncommitted changes (in svn).
async function runDiff(cwd, command) {
  if (!cwd) return { ok: false, error: 'This agent has no folder.' };
  let w = words(command);
  if (!w.length) {
    const inGit = (await run('git', ['rev-parse', '--show-toplevel'], cwd)).ok;
    if (!inGit) w = ['svn', 'diff'];
    else {
      const b = await baseOf(cwd);
      if (!b) return { ok: false, error: 'Could not find the branch this one split off from (no main, master or develop). Name one: /diff main' };
      const r = await runDiff(cwd, `git diff ${b.base}`);
      return r.ok ? { ...r, title: `This branch since it split off ${b.ref}` } : r;
    }
  }
  // "/diff main" means "git diff main".
  if (w[0] !== 'git' && w[0] !== 'svn') w = ['git', 'diff', ...w];
  const [tool, sub, ...rest] = w;
  const allowed = tool === 'git' ? ['diff', 'show'].includes(sub) : sub === 'diff';
  if (!allowed) return { ok: false, error: `Only git diff, git show and svn diff can be shown here, not "${w.slice(0, 2).join(' ')}".` };
  const unsafe = rest.find(a => UNSAFE.test(a));
  if (unsafe) return { ok: false, error: `The option ${unsafe} is not allowed here.` };
  const title = w.join(' ');
  if (tool === 'svn') {
    const r = await run('svn', ['diff', ...rest], cwd);
    return r.ok ? { ok: true, diff: svnToGit(r.out, await svnPrefix(cwd, rest)), title } : r;
  }
  const args = ['-c', 'core.quotepath=false', sub, '--no-color', '--no-ext-diff', '--no-textconv',
    ...(sub === 'show' ? ['--format='] : ['--ignore-cr-at-eol']), ...rest];
  const r = await run('git', args, cwd);
  return r.ok ? { ok: true, diff: r.out, title } : r;
}

module.exports = { runDiff, words };
