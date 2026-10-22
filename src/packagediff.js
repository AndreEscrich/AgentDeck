// The packages a branch changed in a Unity project's Packages/manifest.json,
// as if their changes were the project's own: for each package whose version
// changed, the diff of its git repository between the two versions, with
// its files under Packages/<package name>/ (beside the manifest), so the
// Branches view shows them with the rest and the class diagram reads their
// C# files.
//
// A version is a git URL with a commit, tag or branch after # (and a folder
// after ?path=), or a registry version (1.5.0), which is the repository's
// tag v1.5.0 (or 1.5.0). The repository is the git URL's (either side), or
// for a registry package on GitHub Packages (npm.pkg.github.com/@org, from
// packages-lock.json) github.com/<org>/<name without "com.<org>.">.
//
// Commits marked [skip ci] (template, lint and formatting updates) are left
// out (see skipCi).
//
// The repositories are cloned once (bare, without file contents until they
// are needed) into the cache folder and fetched again when a version is not
// there yet. Your own git credentials are used: any user name or token
// written into a URL is taken out first, never used and never shown.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const BIG = 2 * 1024 * 1024;

function git(args, { cwd, timeout = 180000 } = {}) {
  return new Promise(resolve => {
    execFile('git', args, {
      cwd, timeout, maxBuffer: 300 * 1024 * 1024, windowsHide: true,
      // A missing password fails instead of waiting for someone to type it.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: err.code === 'ENOENT' ? 'The git command was not found.' : clean(String(stderr || err.message).trim().split('\n').slice(-3).join(' ')) });
      else resolve({ ok: true, out: stdout });
    });
  });
}

// Takes credentials out of any URL in a text (user:token@host).
const clean = s => String(s).replace(/(\w+:\/\/)[^/@\s]+@/g, '$1');

// "git+https://user:token@github.com/org/repo.git?path=/sub#ref" -> { url, sub, ref }.
function parseGit(value) {
  const v = String(value || '');
  if (!/^(git\+|https?:\/\/|ssh:\/\/|git@)/.test(v) || !/\.git\b|github\.com/.test(v)) return null;
  const [main, ref = ''] = v.split('#');
  const [base, query = ''] = main.split('?');
  const sub = (/(?:^|&)path=([^&]*)/.exec(query)?.[1] || '').replace(/^\/+|\/+$/g, '');
  return { url: clean(base.replace(/^git\+/, '')), sub, ref };
}

// The changed lines of the manifest's diff: name -> { from, to }.
function manifestChanges(block) {
  const before = new Map();
  const after = new Map();
  for (const line of block.split('\n')) {
    const m = /^([+-])\s*"([^"]+)"\s*:\s*"([^"]*)"/.exec(line);
    if (!m) continue;
    (m[1] === '-' ? before : after).set(m[2], m[3]);
  }
  const changes = new Map();
  // Package names (com.company.package), not the scoped registries' fields.
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    if (!/^[a-z0-9_-]+(.[a-z0-9_-]+)+$/i.test(name)) continue;
    const from = before.get(name) ?? null;
    const to = after.get(name) ?? null;
    if (from !== to) changes.set(name, { from, to });
  }
  return changes;
}

// Registry scopes from packages-lock.json's diff and context lines: name -> url.
function registryUrls(lockBlock) {
  const urls = new Map();
  let name = null;
  for (const line of String(lockBlock || '').split('\n')) {
    const n = /^[ +-]\s{4}"([^"]+)"\s*:\s*\{/.exec(line);
    if (n) name = n[1];
    const u = /^[ +-]\s*"url"\s*:\s*"([^"]+)"/.exec(line);
    if (u && name) urls.set(name, u[1]);
  }
  return urls;
}

// Where a package's repository is, from either side or its registry.
function repoOf(name, change, registry) {
  for (const side of [change.to, change.from]) {
    const g = parseGit(side);
    if (g) return { url: g.url, sub: g.sub };
  }
  const scope = /npm\.pkg\.github\.com\/@([\w.-]+)/i.exec(registry || '');
  if (scope) {
    const org = scope[1];
    const short = name.replace(new RegExp(`^com\\.${org.replace(/\W/g, '\\$&')}\\.`), '').replace(/^.*\./, '');
    return { url: `https://github.com/${org}/${short}.git`, sub: '' };
  }
  // No registry known: com.<org>.<name> is github.com/<org>/<name>, if there is one.
  const m = /^com.([w-]+).(.+)$/.exec(name);
  return m ? { url: `https://github.com/${m[1]}/${m[2]}.git`, sub: '' } : null;
}

// The git refs a version may be: a commit or a tag/branch after #, or a
// registry version's tag.
function refsOf(value) {
  if (!value) return [];
  const g = parseGit(value);
  if (g) return g.ref ? [g.ref] : ['HEAD'];
  if (/^\d+\.\d+/.test(value)) return [`refs/tags/v${value}`, `refs/tags/${value}`];
  return [];
}

const label = value => {
  const g = parseGit(value);
  if (!g) return value;
  return /^[0-9a-f]{40}$/i.test(g.ref) ? g.ref.slice(0, 7) : g.ref || 'latest';
};

// The repository's bare clone in the cache, with the commits these refs need.
async function clone(url, root) {
  const dir = path.join(root, url.replace(/^\w+:\/\/|^git@/, '').replace(/[^\w.-]+/g, '_'));
  if (!fs.existsSync(path.join(dir, 'HEAD'))) {
    fs.mkdirSync(root, { recursive: true });
    const r = await git(['clone', '--bare', '--filter=blob:none', '--quiet', url, dir], { timeout: 600000 });
    if (!r.ok) return { ok: false, error: r.error };
  }
  return { ok: true, dir };
}

async function resolve(dir, refs) {
  for (const ref of refs) {
    const r = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: dir });
    if (r.ok && r.out.trim()) return r.out.trim();
  }
  return null;
}

async function resolveOrFetch(dir, refs) {
  let sha = await resolve(dir, refs);
  if (sha) return sha;
  await git(['fetch', '--quiet', '--tags', '--force', 'origin', '+refs/heads/*:refs/heads/*'], { cwd: dir, timeout: 600000 });
  sha = await resolve(dir, refs);
  if (sha) return sha;
  // A commit no branch or tag has: ask for it by name.
  for (const ref of refs.filter(r => /^[0-9a-f]{7,40}$/i.test(r))) {
    await git(['fetch', '--quiet', 'origin', ref], { cwd: dir, timeout: 600000 });
  }
  return resolve(dir, refs);
}

const SKIP_CI = /\[(skip ci|ci skip|no ci|skip actions|actions skip)\]/i;

// The commits from..to, oldest first, and which of them to leave out:
// { base, paths, skipped, kept, onlySkipped }. base: where the comparison
// starts (after the [skip ci] commits that come first); paths: when one
// comes later, the files the other commits touched (in the repository),
// else null for all.
async function skipCi(dir, from, to) {
  const all = { base: from, paths: null, skipped: 0, kept: 0, onlySkipped: false };
  const log = await git(['log', '--reverse', '--format=%x01%H%x09%s', '--name-only', `${from}..${to}`], { cwd: dir });
  if (!log.ok) return all;
  const commits = log.out.split('\x01').filter(Boolean).map(entry => {
    const [head, ...files] = entry.split('\n');
    const [sha, subject = ''] = head.split('\t');
    return { sha, skip: SKIP_CI.test(subject), files: files.map(f => f.trim()).filter(Boolean) };
  });
  // Going back (an older version), or nothing marked: compare as it is.
  if (!commits.length || !commits.some(c => c.skip)) return { ...all, kept: commits.length };
  let base = from;
  let i = 0;
  while (i < commits.length && commits[i].skip) base = commits[i++].sha;
  const rest = commits.slice(i);
  const skipped = commits.filter(c => c.skip).length;
  if (!rest.length) return { ...all, skipped, onlySkipped: true };
  const later = rest.some(c => c.skip);
  return {
    base, skipped, kept: rest.filter(c => !c.skip).length, onlySkipped: false,
    paths: later ? new Set(rest.filter(c => !c.skip).flatMap(c => c.files)) : null,
  };
}

// branchText: the branch's diff (git format). cwd: the folder its files are
// in (the package's C# files are written there too). Resolves with
// { diff, notes, packages: [{ name, from, to, files }] }.
async function packageDiffs(branchText, { cwd, cacheRoot, progress = () => {} } = {}) {
  const blocks = branchText.split(/(?=^diff --git )/m);
  const manifest = blocks.find(b => /^diff --git a\/(\S*\/)?Packages\/manifest\.json /m.test(b));
  if (!manifest) return { diff: '', notes: [], packages: [] };
  const folder = (/^diff --git a\/((\S*\/)?Packages)\/manifest\.json /m.exec(manifest)?.[1]) || 'Packages';
  const lock = blocks.find(b => /^diff --git a\/(\S*\/)?Packages\/packages-lock\.json /m.test(b));
  const registry = registryUrls(lock);
  const changes = manifestChanges(manifest);
  const notes = [];
  const packages = [];
  let diff = '';
  for (const [name, change] of changes) {
    if (!change.from || !change.to) {
      notes.push(`Package ${name} ${change.from ? 'removed' : 'added'} (${label(change.from || change.to)}); its files are not shown.`);
      continue;
    }
    const repo = repoOf(name, change, registry.get(name));
    const fromRefs = refsOf(change.from);
    const toRefs = refsOf(change.to);
    if (!repo || !fromRefs.length || !toRefs.length) {
      notes.push(`Package ${name}: ${label(change.from)} → ${label(change.to)} (not a git or GitHub Packages version, so its changes are not shown).`);
      continue;
    }
    progress({ stage: 'packages', name });
    const c = await clone(repo.url, path.join(cacheRoot, 'packages'));
    if (!c.ok) { notes.push(`Package ${name}: could not read ${repo.url} (${c.error}).`); continue; }
    const [from, to] = [await resolveOrFetch(c.dir, fromRefs), await resolveOrFetch(c.dir, toRefs)];
    if (!from || !to) {
      notes.push(`Package ${name}: could not find ${!from ? label(change.from) : label(change.to)} in ${repo.url}.`);
      continue;
    }
    // Commits marked [skip ci] (formatting, template and lint updates) are
    // left out: when they come first, the comparison starts after them; one
    // in between leaves out the files only such commits touched.
    const skip = await skipCi(c.dir, from, to);
    if (skip.onlySkipped) {
      notes.push(`Package ${name}: ${label(change.from)} → ${label(change.to)}, only commits marked [skip ci] (${skip.skipped}), so nothing is shown.`);
      continue;
    }
    // A package in a folder of its repository (?path=): only that folder,
    // with paths from there.
    const prefix = `${folder}/${name}/`;
    const args = ['diff', '--no-color', '--no-ext-diff', '-M', `--src-prefix=a/${prefix}`, `--dst-prefix=b/${prefix}`];
    if (repo.sub) args.push(`--relative=${repo.sub}`);
    args.push(skip.base, to);
    const d = await git(args, { cwd: c.dir, timeout: 600000 });
    if (!d.ok) { notes.push(`Package ${name}: could not compare the versions (${d.error}).`); continue; }
    // .meta files are left out, as in the branch's own diff; so are very big
    // files, and hidden ones (.github, .editorconfig), which Unity does not load.
    let files = 0;
    const kept = [];
    // Its folder holds only what this comparison shows (an earlier one may differ).
    fs.rmSync(path.join(cwd, ...prefix.split('/').filter(Boolean)), { recursive: true, force: true });
    for (const block of d.out.split(/(?=^diff --git )/m)) {
      if (!block.startsWith('diff --git ')) continue;
      const rel = /^diff --git a\/\S+ b\/(\S+)/.exec(block)?.[1] || '';
      if (/\.meta$/i.test(rel) || block.length > BIG || rel.slice(prefix.length).split('/').some(p => p.startsWith('.'))) continue;
      if (skip.paths) {
        const inRepo = p => (repo.sub ? `${repo.sub}/` : '') + p.slice(prefix.length);
        const old = /^diff --git a\/(\S+) b\//.exec(block)?.[1] || rel;
        if (!skip.paths.has(inRepo(rel)) && !skip.paths.has(inRepo(old))) continue;
      }
      kept.push(block);
      files++;
      // Its C# files at the new version, for the diagram and the full-file view.
      if (/\.cs$/i.test(rel) && !/^deleted file mode/m.test(block)) {
        const inRepo = (repo.sub ? `${repo.sub}/` : '') + rel.slice(prefix.length);
        const body = await git(['show', `${to}:${inRepo}`], { cwd: c.dir });
        if (body.ok) {
          const file = path.join(cwd, ...rel.split('/'));
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, body.out);
        }
      }
    }
    diff += (diff && !diff.endsWith('\n') ? '\n' : '') + kept.join('');
    packages.push({ name, from: label(change.from), to: label(change.to), files });
    const left = skip.skipped ? `; ${skip.skipped} commit${skip.skipped === 1 ? '' : 's'} marked [skip ci] left out` : '';
    notes.push(`Package ${name}: ${label(change.from)} → ${label(change.to)}, ${files} file${files === 1 ? '' : 's'} changed by ${skip.kept} commit${skip.kept === 1 ? '' : 's'}${left} (${repo.url.replace(/\.git$/, '')}), shown with the branch's own.`);
  }
  return { diff, notes, packages };
}

module.exports = { packageDiffs, manifestChanges, parseGit, clean, git, clone };
