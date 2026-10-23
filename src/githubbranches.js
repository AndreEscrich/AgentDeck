// Your GitHub work in the Branches view (renderer/branches.js), when
// Settings → Branch diff → GitHub is on: your open pull requests, and the
// branches you pushed in the last 90 days (GitHub keeps your events that
// long) that have no pull request, are not deleted and have commits their
// base does not. gh's login says who you are.
//
// A branch's base is its repository's default branch, or for a fork its
// parent's (where its pull requests go). A pull request or branch is
// compared with its base from where they last met (git merge-base), so what
// came in from the base is left out, as GitHub shows it. The repository is
// cloned once (bare, without file contents until they are needed) into the
// same cache as the packages' (see packagediff.js), and its changed C# files
// are written into a cache folder for the diagram and the full-file views.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { findGh } = require('./github');
const { git, clone } = require('./packagediff');

const NAME = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;
const BIG = 2 * 1024 * 1024;

function gh(args) {
  return new Promise(resolve => {
    execFile(findGh(), args, { timeout: 30000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: err.code === 'ENOENT' ? 'The gh command was not found. Install it (brew install gh) and sign in (gh auth login).' : String(stderr || err.message).trim().split('\n')[0] });
      try { resolve({ ok: true, out: JSON.parse(stdout) }); } catch { resolve({ ok: false, error: 'gh gave an answer that is not JSON.' }); }
    });
  });
}

// [{ source: 'github', kind: 'pull'|'branch', project (owner/repo), name,
// branch, number, title, draft, url, sha, author, date }], newest first.
async function listGithub() {
  const user = await gh(['api', 'user']);
  if (!user.ok) return { ok: false, error: user.error };
  const login = user.out.login;
  const [prs, events] = await Promise.all([
    gh(['search', 'prs', '--author', '@me', '--state', 'open', '--json', 'number,title,repository,updatedAt,isDraft,url', '--limit', '100']),
    gh(['api', `users/${login}/events?per_page=100`, '--paginate', '--slurp']),
  ]);
  if (!prs.ok) return { ok: false, error: prs.error, login };
  const items = [];
  const withPull = new Set();   // owner/repo:branch
  await Promise.all(prs.out.map(async p => {
    const repo = p.repository?.nameWithOwner;
    if (!NAME.test(repo || '')) return;
    const pull = await gh(['api', `repos/${repo}/pulls/${p.number}`]);
    const head = pull.ok ? pull.out.head : null;
    if (head?.repo?.full_name === repo) withPull.add(`${repo}:${head.ref}`);
    items.push({
      source: 'github', kind: 'pull', project: repo, name: p.title, branch: head?.ref || '', number: p.number,
      title: p.title, draft: !!p.isDraft, url: p.url, sha: head?.sha || '', author: login, date: p.updatedAt,
    });
  }));
  // The branches you pushed to, newest push first; one deleted after its
  // last push is gone.
  const pushed = new Map();   // owner/repo:branch -> { repo, branch, date }
  const deleted = new Map();
  for (const e of (events.ok ? events.out.flat() : [])) {
    const repo = e.repo?.name;
    if (!NAME.test(repo || '')) continue;
    const branch = e.type === 'PushEvent' ? String(e.payload?.ref || '').replace(/^refs\/heads\//, '')
      : (e.type === 'CreateEvent' || e.type === 'DeleteEvent') && e.payload?.ref_type === 'branch' ? e.payload.ref : '';
    if (!branch) continue;
    const key = `${repo}:${branch}`;
    if (e.type === 'DeleteEvent') { if (!deleted.has(key) || deleted.get(key) < e.created_at) deleted.set(key, e.created_at); continue; }
    if (!pushed.has(key) || pushed.get(key).date < e.created_at) pushed.set(key, { repo, branch, date: e.created_at });
  }
  const bases = new Map();   // owner/repo -> promise of its base
  const baseOf = repo => {
    if (!bases.has(repo)) bases.set(repo, branchBase(repo));
    return bases.get(repo);
  };
  await Promise.all([...pushed].map(async ([key, b]) => {
    if (withPull.has(key) || (deleted.has(key) && deleted.get(key) >= b.date)) return;
    const base = await baseOf(b.repo);
    if (!base || (base.repo === b.repo && base.branch === b.branch)) return;
    const head = base.repo === b.repo ? b.branch : `${b.repo.split('/')[0]}:${b.branch}`;
    const cmp = await gh(['api', `repos/${base.repo}/compare/${encodeURIComponent(base.branch)}...${encodeURIComponent(head)}`, '--jq', '{ahead: .ahead_by, sha: .commits[-1].sha, date: .commits[-1].commit.committer.date}']);
    if (!cmp.ok || !cmp.out.ahead) return;   // deleted, or all in the default branch
    items.push({
      source: 'github', kind: 'branch', project: b.repo, name: b.branch, branch: b.branch, number: 0,
      title: '', draft: false, url: `https://github.com/${b.repo}/tree/${b.branch}`, sha: cmp.out.sha || '', author: login, date: cmp.out.date || b.date,
    });
  }));
  items.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  return { ok: true, login, items };
}

// A branch's base: { repo, branch }, its repository's default branch or,
// for a fork, its parent's; null when it cannot be read.
async function branchBase(repo) {
  const r = await gh(['api', `repos/${repo}`]);
  if (!r.ok) return null;
  const from = r.out.parent || r.out;
  return { repo: from.full_name, branch: from.default_branch };
}

// item: { kind, project, number, branch }. Resolves like branchDiff in
// svnbranches.js, with progress steps of the same kinds.
async function githubDiff(item, cacheRoot, progress = () => {}) {
  const repo = String(item?.project || '');
  if (!NAME.test(repo)) return { ok: false, error: 'No repository.' };
  const pull = item.kind === 'pull';
  if (pull ? !/^\d+$/.test(String(item.number)) : !item.branch) return { ok: false, error: 'No branch.' };
  progress({ stage: 'history' });

  // What to compare: the pull request's head with its base, or the branch
  // with its base (see branchBase), fetched into refs/base/.
  let base, baseRepo, headRef, title;
  if (pull) {
    const p = await gh(['api', `repos/${repo}/pulls/${item.number}`]);
    if (!p.ok) return { ok: false, error: p.error };
    base = p.out.base.ref;
    baseRepo = repo;
    headRef = `refs/pull/${item.number}/head`;
    title = `${repo}#${item.number} ${p.out.head.ref}`;
  } else {
    const b = await branchBase(repo);
    if (!b) return { ok: false, error: `Could not read ${repo} on GitHub.` };
    base = b.branch;
    baseRepo = b.repo;
    headRef = `refs/heads/${item.branch}`;
    title = `${repo} ${item.branch}`;
  }
  const baseRef = `refs/base/${base}`;
  const c = await clone(`https://github.com/${repo}.git`, path.join(cacheRoot, 'packages'));
  if (!c.ok) return { ok: false, error: c.error };
  for (const [remote, refspec] of [[baseRepo === repo ? 'origin' : `https://github.com/${baseRepo}.git`, `+refs/heads/${base}:${baseRef}`], ['origin', `+${headRef}:${headRef}`]]) {
    const fetched = await git(['fetch', '--quiet', '--force', remote, refspec], { cwd: c.dir, timeout: 600000 });
    if (!fetched.ok) return { ok: false, error: fetched.error };
  }
  if (baseRepo !== repo) base = `${baseRepo.split('/')[0]}/${base}`;
  const head = (await git(['rev-parse', `${headRef}^{commit}`], { cwd: c.dir })).out?.trim();
  const from = (await git(['merge-base', baseRef, headRef], { cwd: c.dir })).out?.trim();
  if (!head || !from) return { ok: false, error: `Could not find where it meets ${base}.` };

  // Its own commits (merges from the base left out), newest first.
  const log = await git(['log', '--no-merges', '--format=%x01%H%x09%an%x09%aI%x09%s', '--name-only', `${from}..${head}`], { cwd: c.dir });
  const commits = (log.out || '').split('\x01').filter(Boolean).map(entry => {
    const [line, ...files] = entry.split('\n');
    const [sha, author, date, message = ''] = line.split('\t');
    return { sha, author, date, message, files: files.filter(f => f.trim()).length };
  });
  const merges = Number((await git(['rev-list', '--count', '--merges', `${from}..${head}`], { cwd: c.dir })).out?.trim() || 0);
  const names = (await git(['diff', '--name-only', from, head], { cwd: c.dir })).out?.split('\n').filter(Boolean) || [];
  progress({
    stage: 'history', merges, parent: base, commitCount: commits.length,
    paths: names.filter(f => !/\.meta$/i.test(f)).slice(0, 5000),
    commits: commits.slice(0, 60).map(x => ({ ...x, message: x.message.split('\n')[0] })),
  });

  progress({ stage: 'diff', files: [], base: from.slice(0, 7), parent: base });
  const d = await git(['diff', '--no-color', '--no-ext-diff', '-M', from, head], { cwd: c.dir, timeout: 600000 });
  if (!d.ok) return { ok: false, error: d.error };
  let metaCount = 0;
  const tooBig = [];
  const kept = [];
  for (const block of d.out.split(/(?=^diff --git )/m)) {
    if (!block.startsWith('diff --git ')) continue;
    const rel = /^diff --git a\/\S+ b\/(\S+)/.exec(block)?.[1] || '';
    if (/\.meta$/i.test(rel)) { metaCount++; continue; }
    if (block.length > BIG) { tooBig.push(rel); continue; }
    kept.push({ rel, block });
  }
  progress({ stage: 'diff', files: kept.map(k => k.rel), base: from.slice(0, 7), parent: base });

  // Its changed C# files at its head, for the diagram and the full-file views.
  const cwd = path.join(cacheRoot, 'github', repo.replace(/[^\w.-]+/g, '_'), `${String(pull ? item.number : item.branch).replace(/[^\w.-]+/g, '_')}@${head.slice(0, 12)}`);
  const marker = path.join(cwd, '.agenthub-complete');
  const cs = kept.filter(k => /\.cs$/i.test(k.rel) && !/^deleted file mode/m.test(k.block));
  if (fs.existsSync(marker)) progress({ stage: 'fetch', done: 0, total: 0 });
  else {
    fs.mkdirSync(cwd, { recursive: true });
    let done = 0;
    progress({ stage: 'fetch', done, total: cs.length });
    for (const k of cs) {
      const body = await git(['show', `${head}:${k.rel}`], { cwd: c.dir });
      done++;
      if (done % 5 === 0 || done === cs.length) progress({ stage: 'fetch', done, total: cs.length });
      if (!body.ok) continue;
      const file = path.join(cwd, ...k.rel.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body.out);
    }
    fs.writeFileSync(marker, new Date().toISOString());
  }

  const notes = [`${commits.length} commit${commits.length === 1 ? '' : 's'} of its own${merges ? `; ${merges} merge${merges === 1 ? '' : 's'} from ${base} left out` : ''}. Compared with ${base}@${from.slice(0, 7)} (where they last met), up to ${head.slice(0, 7)}.`];
  if (metaCount) notes.push(`${metaCount} .meta file${metaCount === 1 ? '' : 's'} not shown.`);
  if (tooBig.length) notes.push(`Too large to show: ${tooBig.slice(0, 6).join(', ')}${tooBig.length > 6 ? ` and ${tooBig.length - 6} more` : ''}.`);
  return { ok: true, diff: kept.map(k => k.block).join(''), title: `${title} (${from.slice(0, 7)}…${head.slice(0, 7)})`, cwd, parent: base, notes, commits };
}

module.exports = { listGithub, githubDiff };
