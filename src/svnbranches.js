// The Branches view (renderer/branches.js): an SVN branch's own changes, as
// a diff and a class diagram. The branches are those under
// <svnServer>/<project>/branches, for each project in Settings → Branch diff,
// whose names start with one of the names there (all when there are none).
//
// "Its own changes" leaves out what came in from trunk, two ways at once:
// - The diff is taken from trunk at the newest trunk revision merged into the
//   branch (or where the branch was copied from, when nothing was merged yet)
//   to the branch's latest revision. Merged trunk changes are on both sides,
//   so they cancel out; svn:mergeinfo property changes are left out.
// - A merge from trunk is a commit that changes the properties of the
//   branch's root folder (its svn:mergeinfo, "." modified). Only files that
//   the branch's other commits (its own) touched are shown, so a file that
//   changed only through merges, or through older trunk revisions that were
//   never merged, is left out.
// The branch's own commits come with the result, for the view to list.
//
// The diagram and the full-file views read files from a folder: the branch's
// changed C# files are fetched (svn cat) into a cache folder in the app's
// settings folder, one per branch revision.
//
// With Settings → Branch diff → GitHub on, your GitHub pull requests and
// branches are listed with them (see githubbranches.js).
//
// Only reading commands run (svn ls, log, info, mergeinfo, diff, cat), with
// --non-interactive, so a missing password fails instead of waiting; for a
// package it changed, git clone, fetch, diff and show (see packagediff.js).

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { svnToGit } = require('./branchdiff');
const { packageDiffs } = require('./packagediff');

const DEFAULT_SERVER = 'svn+ssh://svn@tactile.build';

const SVN_MISSING = process.platform === 'win32'
  ? 'The svn command was not found. Install TortoiseSVN with "command line client tools" turned on, then restart Agent Hub.'
  : 'The svn command was not found. Install it (brew install subversion), then restart Agent Hub.';

// Each svn+ssh call opens an ssh connection, which takes most of a call's
// time (about a second). On macOS and Linux they share one connection that
// stays open for a minute (ssh ControlMaster), unless you set SVN_SSH
// yourself; Windows' ssh cannot. Read at each call: main.js extends PATH
// after this file is loaded.
const svnEnv = () => (process.platform === 'win32' || process.env.SVN_SSH
  ? process.env
  : { ...process.env, SVN_SSH: 'ssh -o ControlMaster=auto -o ControlPath=/tmp/agenthub-svn-%C -o ControlPersist=60' });

function svn(args, { timeout = 120000 } = {}) {
  return new Promise(resolve => {
    execFile('svn', [...args, '--non-interactive'], { maxBuffer: 120 * 1024 * 1024, timeout, windowsHide: true, env: svnEnv() }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: err.code === 'ENOENT' ? SVN_MISSING : String(stderr || err.message).trim().split('\n').slice(0, 6).join('\n') });
      else resolve({ ok: true, out: stdout });
    });
  });
}

const unxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (xml, name) => { const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(xml); return m ? unxml(m[1]) : null; };

// The projects to list. None: every project on the server (see allProjects).
function projects(config) {
  const list = Array.isArray(config.svnProjects) ? config.svnProjects : [];
  return [...new Set(list.map(p => String(p || '').trim().replace(/^\/+|\/+$/g, '')).filter(Boolean))];
}

// The branch names to list: their starts, lowercase (all when empty).
function branchFilter(config) {
  const list = Array.isArray(config.svnBranchFilter) ? config.svnBranchFilter : [];
  return list.map(f => String(f || '').trim().toLowerCase()).filter(Boolean);
}

function projectUrl(config, project) {
  const server = String(config.svnServer || DEFAULT_SERVER).replace(/\/+$/, '');
  return `${server}/${project}`;
}

// Every project on the server worth reading: its top folders, without those
// nobody committed to for a year (old games, art and test projects) and
// those that had no branches folder at the revision they still have (in
// noBranches: project -> revision). The trailing @ keeps svn from reading
// the user@host part of the url as a revision.
const INACTIVE_DAYS = 365;
async function allProjects(config, noBranches) {
  const server = String(config.svnServer || DEFAULT_SERVER).replace(/\/+$/, '');
  const r = await svn(['ls', '--xml', `${server}/@`], { timeout: 60000 });
  if (!r.ok) return r;
  const since = Date.now() - INACTIVE_DAYS * 86400000;
  const projects = [];
  let inactive = 0, without = 0;
  for (const m of r.out.matchAll(/<entry\s+kind="dir"\s*>([\s\S]*?)<\/entry>/g)) {
    const name = tag(m[1], 'name');
    const revision = Number(/<commit\s+revision="(\d+)"/.exec(m[1])?.[1] || 0);
    if (!name || name === 'branches') continue;
    if ((Date.parse(tag(m[1], 'date')) || 0) < since) inactive++;
    else if (noBranches[name] === revision) without++;
    else projects.push({ name, revision });
  }
  return { ok: true, projects, inactive, without };
}

// svn's answer for a folder that is not there.
const NOT_FOUND = /W160013|E200009|E170000|non-existent|not found/i;

// Feature branches are named <person>_<feature> (ariel_GachaCardOffer).
// Release branches (0.29.x, 0.7.x_MysteryConcept) and other names are left
// out of the list.
const RELEASE = /^\d+\.\d+/;
const FEATURE = /^[A-Za-z][A-Za-z0-9.-]*_[A-Za-z0-9]/;
const isFeatureBranch = name => !RELEASE.test(name) && FEATURE.test(name);

// The feature branches of every project, newest first:
// [{ project, name, revision, author, date }], and per project its url, how
// many other branches were left out (hidden), how many the name filter left
// out (filtered), or why it could not be read (error). With every project
// (all), those without a branches folder are left out, and 32 are read at a
// time; the projects found without one are kept in <cacheDir>/svn-projects.json
// for allProjects to skip. The list is kept in <cacheDir>/branch-list.json,
// for cachedBranches.
async function listBranches(config, cacheDir) {
  // Your GitHub pull requests and branches, read meanwhile (see githubbranches.js).
  const github = config.githubBranches ? require('./githubbranches').listGithub() : null;
  let names = projects(config);
  const all = !names.length;
  const projectsFile = path.join(cacheDir, 'svn-projects.json');
  let noBranches = {};
  let skipped = null;
  const revisions = new Map();
  if (all) {
    try { noBranches = JSON.parse(fs.readFileSync(projectsFile, 'utf8')).noBranches || {}; } catch { /* reads them all */ }
    const r = await allProjects(config, noBranches);
    if (!r.ok) return { ok: false, error: r.error };
    for (const p of r.projects) revisions.set(p.name, p.revision);
    names = r.projects.map(p => p.name);
    skipped = { inactive: r.inactive, inactiveDays: INACTIVE_DAYS, noBranches: r.without };
  }
  const starts = branchFilter(config);
  const wanted = name => !starts.length || starts.some(s => name.toLowerCase().startsWith(s));
  const branches = [];
  const read = async project => {
    const url = `${projectUrl(config, project)}/branches`;
    const r = await svn(['ls', '--xml', url], { timeout: 60000 });
    if (!r.ok) {
      if (!all || !NOT_FOUND.test(r.error)) return { project, url, error: r.error };
      noBranches[project] = revisions.get(project);
      if (skipped) skipped.noBranches++;
      return null;
    }
    let hidden = 0, filtered = 0, count = 0;
    for (const m of r.out.matchAll(/<entry\s+kind="dir"\s*>([\s\S]*?)<\/entry>/g)) {
      const e = m[1];
      const name = tag(e, 'name');
      if (!isFeatureBranch(name)) { hidden++; continue; }
      if (!wanted(name)) { filtered++; continue; }
      count++;
      branches.push({
        project,
        name,
        revision: Number(/<commit\s+revision="(\d+)"/.exec(e)?.[1] || 0),
        author: tag(e, 'author') || '',
        date: tag(e, 'date') || '',
      });
    }
    return { project, url, count, hidden, filtered };
  };
  const found = new Array(names.length);
  let next = 0;
  const worker = async () => { while (next < names.length) { const i = next++; found[i] = await read(names[i]); } };
  await Promise.all(Array.from({ length: Math.min(32, names.length) }, worker));
  const sources = found.filter(Boolean);
  if (github) {
    const g = await github;
    sources.push({ project: 'GitHub', github: true, url: `https://github.com/${g.login || ''}`, ...(g.ok ? { count: g.items.length, hidden: 0, filtered: 0 } : { error: g.error }) });
    if (g.ok) branches.push(...g.items);
  }
  if (!sources.length) return { ok: false, error: 'No project on the server has a branches folder.' };
  if (sources.every(s => s.error)) return { ok: false, error: sources.map(s => `${s.project}: ${s.error}`).join('\n') };
  branches.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0) || b.revision - a.revision);
  const result = { ok: true, branches, sources, filter: starts, all, skipped };
  try {
    if (all) fs.writeFileSync(projectsFile, JSON.stringify({ noBranches }));
    fs.writeFileSync(path.join(cacheDir, 'branch-list.json'), JSON.stringify({ key: listKey(config), at: Date.now(), result }));
  } catch { /* read in full and shown without a cache next time */ }
  return result;
}

// The settings a list was read with.
const listKey = config => JSON.stringify([String(config.svnServer || DEFAULT_SERVER), projects(config), branchFilter(config), !!config.githubBranches]);

// The list listBranches read last with the same settings, with when (at), to
// show while it reads them again; null when there is none.
function cachedBranches(config, cacheDir) {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(cacheDir, 'branch-list.json'), 'utf8'));
    return saved.key === listKey(config) ? { ...saved.result, at: saved.at } : null;
  } catch {
    return null;
  }
}

// Revisions from svn mergeinfo --show-revs: "r123" lines, "r124*" for partial.
const revisions = text => [...String(text).matchAll(/^r(\d+)/gm)].map(m => Number(m[1]));

// Resolves with { ok, diff, title, cwd, base, notes } or { ok: false, error }.
// progress(step) tells how far it has come, for the view to show meanwhile:
// { stage: 'history' } while the log is read, then with what it found
// (commits, merges, parent); { stage: 'diff', files } with the files that
// came in since the last one; { stage: 'fetch', done, total } while the C#
// files are fetched.
async function branchDiff(config, project, branch, cacheRoot, progress = () => {}) {
  const listed = projects(config);
  if (listed.length ? !listed.includes(project) : !/^[^/\\@]+$/.test(project)) return { ok: false, error: `${project || 'No project'} is not in Settings → Branch diff.` };
  const root = projectUrl(config, project);
  if (!/^[^/\\]+$/.test(String(branch || ''))) return { ok: false, error: 'No branch.' };
  const url = `${root}/branches/${encodeURIComponent(branch).replace(/%2B/g, '+')}`;

  // The repository's root, and the branch's latest revision.
  const info = await svn(['info', '--xml', url], { timeout: 60000 });
  if (!info.ok) return { ok: false, error: info.error };
  const reposRoot = tag(info.out, 'root');
  const head = Number(/<commit\s+revision="(\d+)"/.exec(info.out)?.[1] || 0);

  // The branch's history since it was copied, oldest first: its first entry
  // says where it was copied from; each other one is a merge from trunk (it
  // changed the root folder's properties) or a commit of its own.
  progress({ stage: 'history', head });
  const log = await svn(['log', '--xml', '-v', '--stop-on-copy', '-r', '1:HEAD', url], { timeout: 180000 });
  if (!log.ok) return { ok: false, error: log.error };
  const relPath = decodeURIComponent(url.slice(reposRoot.length));
  let copyFrom = null;
  let copyRev = 0;
  const own = [];          // [{ revision, author, date, message, files }]
  const ownFiles = new Set();
  let merges = 0;
  for (const m of log.out.matchAll(/<logentry\s+revision="(\d+)"\s*>([\s\S]*?)<\/logentry>/g)) {
    const revision = Number(m[1]);
    const entry = m[2];
    const paths = [...entry.matchAll(/<path\b([^>]*)>([^<]*)<\/path>/g)].map(p => ({ attrs: p[1], path: unxml(p[2]) }));
    const root = paths.find(p => p.path === relPath);
    if (root && /copyfrom-path="/.test(root.attrs)) {
      copyFrom = unxml(/copyfrom-path="([^"]*)"/.exec(root.attrs)?.[1] || '') || null;
      copyRev = Number(/copyfrom-rev="(\d+)"/.exec(root.attrs)?.[1] || 0);
      continue;
    }
    if (root && /prop-mods="true"/.test(root.attrs)) { merges++; continue; }
    const files = paths.filter(p => p.path.startsWith(relPath + '/')).map(p => p.path.slice(relPath.length + 1));
    for (const file of files) ownFiles.add(file);
    own.push({ revision, author: tag(entry, 'author') || '', date: tag(entry, 'date') || '', message: (tag(entry, 'msg') || '').trim(), files: files.length });
  }
  if (!copyFrom) return { ok: false, error: `Could not find where ${branch} was copied from.` };
  const parentUrl = reposRoot + copyFrom.split('/').map(encodeURIComponent).join('/');
  const parentName = copyFrom.split('/').filter(Boolean).pop();
  progress({
    stage: 'history', head, merges, parent: parentName, commitCount: own.length,
    // The files its commits touched (not folders, not .meta), to show by
    // domain before the diff comes.
    paths: [...ownFiles].filter(f => /\.[^/]+$/.test(f) && !/\.meta$/i.test(f)).slice(0, 5000),
    commits: own.slice(-60).reverse().map(c => ({ revision: c.revision, author: c.author, date: c.date, message: c.message.split('\n')[0], files: c.files })),
  });

  // The newest parent revision merged into the branch, and any older ones
  // that were left out.
  const merged = await svn(['mergeinfo', '--show-revs', 'merged', parentUrl, url]);
  const mergedRevs = merged.ok ? revisions(merged.out) : [];
  const mergedUpTo = mergedRevs.length ? Math.max(...mergedRevs) : 0;
  const base = Math.max(copyRev, mergedUpTo);
  let gaps = [];
  if (mergedUpTo > copyRev) {
    const eligible = await svn(['mergeinfo', '--show-revs', 'eligible', parentUrl, url]);
    if (eligible.ok) gaps = revisions(eligible.out).filter(r => r <= mergedUpTo);
  }

  // Only the files the branch's own commits touched (a folder they added or
  // removed counts for what is inside it). The diff is read as it comes:
  // other files, .meta files and single files over 2 MB are dropped on the
  // way, so a long-lived branch (whose whole diff ran past 120 MB) still fits.
  const touched = file => {
    if (ownFiles.has(file)) return true;
    for (let i = file.lastIndexOf('/'); i > 0; i = file.lastIndexOf('/', i - 1)) if (ownFiles.has(file.slice(0, i))) return true;
    return false;
  };
  let hidden = 0;
  let metaCount = 0;
  const tooBig = [];
  // The files as they come, a few times a second.
  let pending = [];
  const flush = () => { if (pending.length) { progress({ stage: 'diff', files: pending, base, parent: parentName }); pending = []; } };
  const ticker = setInterval(flush, 250);
  progress({ stage: 'diff', files: [], base, parent: parentName });
  const streamed = await svnDiffStream(['diff', '--ignore-properties', `${parentUrl}@${base}`, `${url}@${head}`], name => {
    if (!touched(name)) { hidden++; return false; }
    if (/\.meta$/i.test(name)) { metaCount++; return false; }
    pending.push(name);
    return true;
  }, name => tooBig.push(name));
  clearInterval(ticker);
  flush();
  if (!streamed.ok) return { ok: false, error: streamed.error };
  let text = streamed.blocks.map(block => svnToGit(block)).join('\n');

  // All the branch's changed C# files at its latest revision, for the
  // diagram and the full-file views. A file the branch added is all in the
  // diff, so it is written from there; only edited files are fetched (svn cat).
  // A deleted file has nothing to fetch: the diagram reads it from the diff.
  const cwd = path.join(cacheRoot, sanitize(project), `${sanitize(branch)}@${head}`);
  const write = (rel, content) => {
    const file = path.join(cwd, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  // (v2: earlier versions fetched only the first 300 C# files.)
  const marker = path.join(cwd, '.agenthub-complete-v2');
  if (fs.existsSync(marker)) progress({ stage: 'fetch', done: 0, total: 0 });
  else {
    fs.mkdirSync(cwd, { recursive: true });
    const toFetch = [];
    for (const block of text.split(/(?=^diff --git )/m)) {
      const rel = /^diff --git a\/(.+?) b\//.exec(block)?.[1];
      if (!rel || !/\.cs$/i.test(rel)) continue;
      if (/^deleted file mode/m.test(block)) continue;   // its old lines are all in the diff
      if (/^new file mode/m.test(block)) {
        const body = block.slice(block.indexOf('\n@@') + 1).split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1));
        write(rel, body.join('\n') + '\n');
      } else {
        toFetch.push(rel);
      }
    }
    let next = 0;
    let done = 0;
    progress({ stage: 'fetch', done, total: toFetch.length });
    const worker = async () => {
      while (next < toFetch.length) {
        const rel = toFetch[next++];
        const r = await svn(['cat', `${url}/${rel.split('/').map(encodeURIComponent).join('/')}@${head}`], { timeout: 60000 });
        done++;
        if (done % 5 === 0 || done === toFetch.length) progress({ stage: 'fetch', done, total: toFetch.length });
        if (!r.ok) continue;   // a deleted file, or one svn cannot give
        write(rel, r.out);
      }
    };
    await Promise.all(Array.from({ length: 10 }, worker));
    fs.writeFileSync(marker, new Date().toISOString());
  }

  // Packages whose version it changed in Packages/manifest.json: their
  // repositories' changes between the two versions, shown as its own (see
  // packagediff.js).
  const pkgs = await packageDiffs(text, { cwd, cacheRoot, progress });
  if (pkgs.diff) text += (text.endsWith('\n') ? '' : '\n') + pkgs.diff;

  const notes = [];
  notes.push(`${own.length} commit${own.length === 1 ? '' : 's'} of its own; ${merges} merge${merges === 1 ? '' : 's'} from ${parentName} left out. Compared with ${parentName}@r${base}${mergedUpTo > copyRev ? ` (the newest ${parentName} revision merged in)` : ` (where the branch was copied from)`}, up to r${head}.`);
  if (hidden) notes.push(`${hidden} file${hidden === 1 ? '' : 's'} that only merges changed ${hidden === 1 ? 'is' : 'are'} not shown.`);
  if (metaCount) notes.push(`${metaCount} .meta file${metaCount === 1 ? '' : 's'} not shown.`);
  if (tooBig.length) notes.push(`Too large to show: ${tooBig.slice(0, 6).join(', ')}${tooBig.length > 6 ? ` and ${tooBig.length - 6} more` : ''}.`);
  notes.push(...pkgs.notes);
  if (gaps.length) notes.push(`${gaps.length} older ${parentName} revision${gaps.length === 1 ? ' was' : 's were'} never merged into the branch (${gaps.slice(0, 8).map(r => 'r' + r).join(', ')}${gaps.length > 8 ? ', …' : ''}). In files the branch also changed, ${gaps.length === 1 ? 'its changes show' : 'their changes show'} reversed.`);
  return { ok: true, diff: text, title: `${branch} (r${base}…r${head})`, cwd, base, head, parent: parentName, notes, commits: own.reverse() };
}

// svn diff, read as it streams, one file ("Index: path") at a time.
// want(name) says whether to keep a file; one larger than BIG is dropped and
// named to tooBig(name). Resolves with { ok, blocks } (svn's own format).
const BIG = 2 * 1024 * 1024;
function svnDiffStream(args, want, tooBig) {
  return new Promise(resolve => {
    const child = spawn('svn', [...args, '--non-interactive'], { windowsHide: true, env: svnEnv() });
    const blocks = [];
    let name = null, keep = false, size = 0, lines = [];
    let rest = '';
    let stderr = '';
    const finish = () => {
      if (name && keep) blocks.push(lines.join('\n'));
      name = null; keep = false; size = 0; lines = [];
    };
    const line = l => {
      const index = /^Index: (.+)$/.exec(l);
      if (index) {
        finish();
        name = index[1];
        keep = want(name);
      }
      if (!keep) return;
      size += l.length + 1;
      if (size > BIG) { keep = false; tooBig(name); return; }
      lines.push(l);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      const parts = (rest + chunk).split(/\r?\n/);
      rest = parts.pop();
      for (const l of parts) line(l);
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 600000);
    child.on('error', err => { clearTimeout(timer); resolve({ ok: false, error: err.code === 'ENOENT' ? SVN_MISSING : err.message }); });
    child.on('close', code => {
      clearTimeout(timer);
      if (rest) line(rest);
      finish();
      if (code !== 0 && !blocks.length) resolve({ ok: false, error: stderr.trim().split('\n').slice(0, 6).join('\n') || `svn diff stopped (${code})` });
      else resolve({ ok: true, blocks });
    });
  });
}

function sanitize(s) {
  return String(s || '').replace(/[^\w.@-]+/g, '_').slice(0, 80);
}

module.exports = { listBranches, cachedBranches, branchDiff, projects, DEFAULT_SERVER };
