// Looks up Jira tickets for the ticket cards in the chat, with the Atlassian
// command-line tool (acli), which uses your own Jira login. Returns
// { key, summary, status, category, type } or null when the tool is missing,
// not logged in, or the ticket cannot be read. Answers are kept for 5 minutes.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
const KEEP_MS = 5 * 60 * 1000;
const cache = new Map();   // ticket key -> { at, promise }

function findAcli() {
  const candidates = ['/opt/homebrew/bin/acli', '/usr/local/bin/acli', path.join(os.homedir(), '.local/bin/acli'), path.join(os.homedir(), '.local', 'bin', 'acli.exe')];
  return candidates.find(p => fs.existsSync(p)) || 'acli';
}

function fetchIssue(key) {
  return new Promise(resolve => {
    execFile(findAcli(), ['jira', 'workitem', 'view', key, '--fields', 'summary,status,issuetype', '--json'],
      { timeout: 15000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve(null);
        try {
          const f = JSON.parse(stdout).fields || {};
          resolve({
            key,
            summary: f.summary || '',
            status: f.status?.name || '',
            // new (To Do), indeterminate (In Progress) or done, for the color.
            category: f.status?.statusCategory?.key || '',
            type: f.issuetype?.name || '',
          });
        } catch {
          resolve(null); // acli prints an error message instead of JSON
        }
      });
  });
}

function issue(key) {
  if (typeof key !== 'string' || !KEY.test(key)) return Promise.resolve(null);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.promise;
  const promise = fetchIssue(key);
  cache.set(key, { at: Date.now(), promise });
  return promise;
}

// Jira Cloud gives the description as a document tree (Atlassian Document
// Format); this makes plain text of it, with "- " for list items.
function adfText(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.type === 'text') out.push(node.text || '');
  else if (node.type === 'hardBreak') out.push('\n');
  else if (node.type === 'mention') out.push(node.attrs?.text || '');
  else if (node.type === 'inlineCard') out.push(node.attrs?.url || '');
  if (node.type === 'listItem') out.push('- ');
  if (node.type === 'codeBlock') out.push('```\n');
  for (const child of node.content || []) adfText(child, out);
  if (node.type === 'codeBlock') out.push('\n```');
  // A list item's paragraph already ends its line.
  if (['paragraph', 'heading', 'codeBlock', 'blockquote', 'rule'].includes(node.type)) out.push('\n');
  return out;
}

function plainDescription(d) {
  if (!d) return '';
  if (typeof d === 'string') return d.trim();
  return adfText(d).join('').replace(/\n{3,}/g, '\n\n').trim();
}

// The ticket with its description, for an agent that starts from it.
// Resolves with { key, summary, status, type, description } or { error }.
function details(key) {
  if (typeof key !== 'string' || !KEY.test(key)) return Promise.resolve({ error: 'Not a ticket key.' });
  return new Promise(resolve => {
    execFile(findAcli(), ['jira', 'workitem', 'view', key, '--fields', 'summary,status,issuetype,description', '--json'],
      { timeout: 20000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT') return resolve({ error: 'The Atlassian CLI (acli) is not installed.' });
        if (err) return resolve({ error: (stderr || err.message || '').trim().split('\n').pop() || 'acli failed.' });
        try {
          const f = JSON.parse(stdout).fields || {};
          resolve({
            key,
            summary: f.summary || '',
            status: f.status?.name || '',
            type: f.issuetype?.name || '',
            description: plainDescription(f.description).slice(0, 20000),
          });
        } catch {
          resolve({ error: stdout.trim().split('\n').pop() || 'acli did not answer with the ticket.' });
        }
      });
  });
}

// Adds a comment to a ticket. Resolves with { ok: true } or { ok: false, error }.
function comment(key, body) {
  if (typeof key !== 'string' || !KEY.test(key) || typeof body !== 'string' || !body.trim()) {
    return Promise.resolve({ ok: false, error: 'Nothing to post.' });
  }
  const run = args => new Promise(resolve => {
    execFile(findAcli(), args, { timeout: 30000 }, (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true });
      if (err.code === 'ENOENT') return resolve({ ok: false, error: 'The Atlassian CLI (acli) is not installed.' });
      resolve({ ok: false, error: (stderr || stdout || err.message || '').trim().split('\n').pop() });
    });
  });
  return (async () => {
    const first = await run(['jira', 'workitem', 'comment', 'create', '--key', key, '--body', body]);
    if (first.ok || /not installed/.test(first.error)) return first;
    // Older versions of acli have no "create" step.
    const second = await run(['jira', 'workitem', 'comment', '--key', key, '--body', body]);
    return second.ok ? second : first;
  })();
}

module.exports = { issue, details, comment };
