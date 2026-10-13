// The Branches view (renderer/branches.js): an SVN branch's own changes, as
// a diff and a class diagram. The branches are those under
// <svnServer>/<project>/branches (Settings → Branch diff project).
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
// Only reading commands run (svn ls, log, info, mergeinfo, diff, cat), with
// --non-interactive, so a missing password fails instead of waiting.

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { svnToGit } = require('./branchdiff');

const DEFAULT_SERVER = 'svn+ssh://svn@tactile.build';

function svn(args, { timeout = 120000 } = {}) {
  return new Promise(resolve => {
    execFile('svn', [...args, '--non-interactive'], { maxBuffer: 120 * 1024 * 1024, timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: String(stderr || err.message).trim().split('\n').slice(0, 6).join('\n') });
      else resolve({ ok: true, out: stdout });
    });
  });
}

const unxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (xml, name) => { const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(xml); return m ? unxml(m[1]) : null; };

function projectUrl(config) {
  const server = String(config.svnServer || DEFAULT_SERVER).replace(/\/+$/, '');
  const project = String(config.svnProject || '').trim().replace(/^\/+|\/+$/g, '');
  if (!project) return null;
  return `${server}/${project}`;
}

// Feature branches are named <person>_<feature> (ariel_GachaCardOffer).
// Release branches (0.29.x, 0.7.x_MysteryConcept) and other names are left
// out of the list.
const RELEASE = /^d+.d+/;
const FEATURE = /^[A-Za-z][A-Za-z0-9.-]*_[A-Za-z0-9]/;
const isFeatureBranch = name => !RELEASE.test(name) && FEATURE.test(name);

// The feature branches, newest first: [{ name, revision, author, date }],
// and how many other branches were left out (hidden).
async function listBranches(config) {
  const root = projectUrl(config);
  if (!root) return { ok: false, error: 'Set the project in Settings → Branch diff project.' };
  const r = await svn(['ls', '--xml', `${root}/branches`], { timeout: 60000 });
  if (!r.ok) return { ok: false, error: r.error, url: `${root}/branches` };
  const branches = [];
  for (const m of r.out.matchAll(/<entry\s+kind="dir"\s*>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    branches.push({
      name: tag(e, 'name'),
      revision: Number(/<commit\s+revision="(\d+)"/.exec(e)?.[1] || 0),
      author: tag(e, 'author') || '',
      date: tag(e, 'date') || '',
    });
  }
  branches.sort((a, b) => b.revision - a.revision);
  const features = branches.filter(b => isFeatureBranch(b.name));
  return { ok: true, url: `${root}/branches`, branches: features, hidden: branches.length - features.length };
}

// Revisions from svn mergeinfo --show-revs: "r123" lines, "r124*" for partial.
const revisions = text => [...String(text).matchAll(/^r(\d+)/gm)].map(m => Number(m[1]));

// Resolves with { ok, diff, title, cwd, base, notes } or { ok: false, error }.
async function branchDiff(config, branch, cacheRoot) {
  const root = projectUrl(config);
  if (!root) return { ok: false, error: 'Set the project in Settings → Branch diff project.' };
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
  const streamed = await svnDiffStream(['diff', '--ignore-properties', `${parentUrl}@${base}`, `${url}@${head}`], name => {
    if (!touched(name)) { hidden++; return false; }
    if (/\.meta$/i.test(name)) { metaCount++; return false; }
    return true;
  }, name => tooBig.push(name));
  if (!streamed.ok) return { ok: false, error: streamed.error };
  const text = streamed.blocks.map(block => svnToGit(block)).join('\n');

  // The branch's changed C# files at its latest revision, for the diagram
  // and the full-file views.
  const cwd = path.join(cacheRoot, sanitize(config.svnProject), `${sanitize(branch)}@${head}`);
  // A deleted file has nothing to fetch: svn cat fails for it and it is skipped.
  const changed = [...text.matchAll(/^diff --git a\/(.+?) b\/\1$/gm)].map(m => m[1]);
  const csFiles = changed.filter(p => /\.cs$/i.test(p)).slice(0, 300);
  const marker = path.join(cwd, '.agenthub-complete');
  if (!fs.existsSync(marker)) {
    fs.mkdirSync(cwd, { recursive: true });
    let next = 0;
    const worker = async () => {
      while (next < csFiles.length) {
        const rel = csFiles[next++];
        const r = await svn(['cat', `${url}/${rel.split('/').map(encodeURIComponent).join('/')}@${head}`], { timeout: 60000 });
        if (!r.ok) continue;   // a deleted file, or one svn cannot give
        const file = path.join(cwd, ...rel.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, r.out);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    fs.writeFileSync(marker, new Date().toISOString());
  }

  const notes = [];
  notes.push(`${own.length} commit${own.length === 1 ? '' : 's'} of its own; ${merges} merge${merges === 1 ? '' : 's'} from ${parentName} left out. Compared with ${parentName}@r${base}${mergedUpTo > copyRev ? ` (the newest ${parentName} revision merged in)` : ` (where the branch was copied from)`}, up to r${head}.`);
  if (hidden) notes.push(`${hidden} file${hidden === 1 ? '' : 's'} that only merges changed ${hidden === 1 ? 'is' : 'are'} not shown.`);
  if (metaCount) notes.push(`${metaCount} .meta file${metaCount === 1 ? '' : 's'} not shown.`);
  if (tooBig.length) notes.push(`Too large to show: ${tooBig.slice(0, 6).join(', ')}${tooBig.length > 6 ? ` and ${tooBig.length - 6} more` : ''}.`);
  if (gaps.length) notes.push(`${gaps.length} older ${parentName} revision${gaps.length === 1 ? ' was' : 's were'} never merged into the branch (${gaps.slice(0, 8).map(r => 'r' + r).join(', ')}${gaps.length > 8 ? ', …' : ''}). In files the branch also changed, ${gaps.length === 1 ? 'its changes show' : 'their changes show'} reversed.`);
  return { ok: true, diff: text, title: `${branch} (r${base}…r${head})`, cwd, base, head, parent: parentName, notes, commits: own.reverse() };
}

// svn diff, read as it streams, one file ("Index: path") at a time.
// want(name) says whether to keep a file; one larger than BIG is dropped and
// named to tooBig(name). Resolves with { ok, blocks } (svn's own format).
const BIG = 2 * 1024 * 1024;
function svnDiffStream(args, want, tooBig) {
  return new Promise(resolve => {
    const child = spawn('svn', [...args, '--non-interactive'], { windowsHide: true });
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
    child.on('error', err => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
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

module.exports = { listBranches, branchDiff, projectUrl, DEFAULT_SERVER };
