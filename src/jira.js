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
  const candidates = ['/opt/homebrew/bin/acli', '/usr/local/bin/acli', path.join(os.homedir(), '.local/bin/acli')];
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

module.exports = { issue };
