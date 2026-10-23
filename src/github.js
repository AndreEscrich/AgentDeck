// Looks up GitHub links for the cards they become in the chat (see
// githubCard in renderer/render.js), with the GitHub command-line tool (gh),
// which uses your own GitHub login, so private repositories work too. Without
// gh (or without a login) public repositories are read from GitHub's API
// without one. Answers are kept for 2 minutes.
//
// what: { kind: 'pull'|'issue'|'commit'|'repo'|'run'|'release', owner, repo, id }
// Resolves with { title, state, label, detail, author } or null:
//   state: open | closed | merged | draft | success | failure | running | …

const { execFile } = require('child_process');
const fs = require('fs');

const KEEP_MS = 2 * 60 * 1000;
const cache = new Map();   // api path -> { at, promise }
const NAME = /^[\w.-]{1,100}$/;

function findGh() {
  return ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', 'C:\\Program Files\\GitHub CLI\\gh.exe'].find(p => fs.existsSync(p)) || 'gh';
}

function viaGh(apiPath) {
  return new Promise(resolve => {
    execFile(findGh(), ['api', apiPath], { timeout: 10000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '1' } },
      (err, stdout) => {
        if (err) return resolve(undefined);
        try { resolve(JSON.parse(stdout)); } catch { resolve(undefined); }
      });
  });
}

async function viaWeb(apiPath) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const { net } = require('electron');
    const res = await net.fetch(`https://api.github.com/${apiPath}`, { signal: controller.signal, credentials: 'omit', headers: { Accept: 'application/vnd.github+json' } });
    clearTimeout(timer);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function api(apiPath) {
  const hit = cache.get(apiPath);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.promise;
  const promise = viaGh(apiPath).then(r => (r === undefined ? viaWeb(apiPath) : r));
  cache.set(apiPath, { at: Date.now(), promise });
  return promise;
}

const firstLine = s => String(s || '').split('\n')[0].trim();

async function lookup(what) {
  if (!what || !NAME.test(what.owner || '') || !NAME.test(what.repo || '')) return null;
  const base = `repos/${what.owner}/${what.repo}`;
  const id = String(what.id || '');
  switch (what.kind) {
    case 'pull': {
      if (!/^\d+$/.test(id)) return null;
      const p = await api(`${base}/pulls/${id}`);
      if (!p) return null;
      const state = p.merged_at ? 'merged' : p.state === 'closed' ? 'closed' : p.draft ? 'draft' : 'open';
      return { title: p.title, state, label: { merged: 'Merged', closed: 'Closed', draft: 'Draft', open: 'Open' }[state],
        detail: p.additions != null ? `+${p.additions} −${p.deletions}` : '', author: p.user?.login || '' };
    }
    case 'issue': {
      if (!/^\d+$/.test(id)) return null;
      const i = await api(`${base}/issues/${id}`);
      if (!i) return null;
      // The issues API also answers for pull requests.
      if (i.pull_request) return lookup({ ...what, kind: 'pull' });
      const state = i.state === 'open' ? 'open' : i.state_reason === 'not_planned' ? 'skipped' : 'done';
      return { title: i.title, state, label: { open: 'Open', done: 'Closed', skipped: 'Not planned' }[state], detail: '', author: i.user?.login || '' };
    }
    case 'commit': {
      if (!/^[0-9a-f]{7,40}$/i.test(id)) return null;
      const c = await api(`${base}/commits/${id}`);
      if (!c) return null;
      return { title: firstLine(c.commit?.message), state: 'commit', label: '',
        detail: c.stats ? `+${c.stats.additions} −${c.stats.deletions}` : '', author: c.author?.login || c.commit?.author?.name || '' };
    }
    case 'run': {
      if (!/^\d+$/.test(id)) return null;
      const r = await api(`${base}/actions/runs/${id}`);
      if (!r) return null;
      const state = r.status !== 'completed' ? 'running' : r.conclusion === 'success' ? 'success' : r.conclusion === 'cancelled' || r.conclusion === 'skipped' ? 'closed' : 'failure';
      return { title: r.display_title || r.name, state, label: { running: 'Running', success: 'Passed', closed: r.conclusion, failure: 'Failed' }[state] || '',
        detail: r.name && r.display_title ? r.name : '', author: r.actor?.login || '' };
    }
    case 'release': {
      const r = await api(`${base}/releases/tags/${encodeURIComponent(id)}`);
      if (!r) return null;
      return { title: r.name || r.tag_name, state: r.prerelease ? 'draft' : 'open', label: r.prerelease ? 'Pre-release' : '', detail: r.tag_name, author: r.author?.login || '' };
    }
    case 'repo': {
      const r = await api(base);
      if (!r) return null;
      // Descriptions may hold emoji codes (:rocket:), which only GitHub draws.
      return { title: (r.description || '').replace(/:[a-z0-9_+-]+:\s*/gi, '').trim(), state: r.private ? 'private' : 'repo', label: r.private ? 'Private' : '', detail: '', author: '' };
    }
    default:
      return null;
  }
}

module.exports = { lookup, findGh };
