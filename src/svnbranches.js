// The Branches view (renderer/branches.js): an SVN branch's own changes, as
// a diff and a class diagram. The branches are those under
// <svnServer>/<project>/branches (Settings → Branch diff project).
//
// "Its own changes" leaves out what came in from trunk: the diff is taken
// from trunk at the newest trunk revision merged into the branch (or where
// the branch was copied from, when nothing was merged yet) to the branch's
// latest revision. Merged trunk changes are on both sides, so they cancel
// out; svn:mergeinfo property changes are left out. When trunk revisions
// older than that one were never merged (a partial or cherry-picked merge),
// their changes show reversed, and the result says so.
//
// The diagram and the full-file views read files from a folder: the branch's
// changed C# files are fetched (svn cat) into a cache folder in the app's
// settings folder, one per branch revision.
//
// Only reading commands run (svn ls, log, info, mergeinfo, diff, cat), with
// --non-interactive, so a missing password fails instead of waiting.

const { execFile } = require('child_process');
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

// The branches, newest first: [{ name, revision, author, date }].
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
  return { ok: true, url: `${root}/branches`, branches };
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

  // Where the branch was copied from: the first revision of its history.
  const first = await svn(['log', '--xml', '-v', '--stop-on-copy', '-r', '1:HEAD', '-l', '1', url], { timeout: 120000 });
  if (!first.ok) return { ok: false, error: first.error };
  const relPath = decodeURIComponent(url.slice(reposRoot.length));
  let copyFrom = null;
  let copyRev = 0;
  for (const p of first.out.matchAll(/<path\b([^>]*)>([^<]*)<\/path>/g)) {
    const attrs = p[1];
    if (unxml(p[2]) !== relPath) continue;
    copyFrom = unxml(/copyfrom-path="([^"]*)"/.exec(attrs)?.[1] || '') || null;
    copyRev = Number(/copyfrom-rev="(\d+)"/.exec(attrs)?.[1] || 0);
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

  const diff = await svn(['diff', '--ignore-properties', `${parentUrl}@${base}`, `${url}@${head}`], { timeout: 300000 });
  if (!diff.ok) return { ok: false, error: diff.error };
  const text = svnToGit(diff.out);

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
  notes.push(`From ${parentName}@r${base}${mergedUpTo > copyRev ? ` (the newest ${parentName} revision merged into the branch)` : ` (where the branch was copied from ${parentName})`} to ${branch}@r${head}. Merges from ${parentName} are left out.`);
  if (gaps.length) notes.push(`${gaps.length} older ${parentName} revision${gaps.length === 1 ? ' was' : 's were'} never merged into the branch (${gaps.slice(0, 8).map(r => 'r' + r).join(', ')}${gaps.length > 8 ? ', …' : ''}): ${gaps.length === 1 ? 'its changes show' : 'their changes show'} reversed.`);
  return { ok: true, diff: text, title: `${branch} (r${base}…r${head})`, cwd, base, head, parent: parentName, notes };
}

function sanitize(s) {
  return String(s || '').replace(/[^\w.@-]+/g, '_').slice(0, 80);
}

module.exports = { listBranches, branchDiff, projectUrl, DEFAULT_SERVER };
