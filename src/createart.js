// Your Tactile Create Art budget (the tactile-create-art connector), for the
// Hub's usage card: { spentUsd, limitUsd, resetsAt } this month, as Create
// Art's server counts it (the same budget Tactile Create shows).
//
// It asks Create Art with the sign-in Claude Code keeps for the connector
// (Connectors → Connect): ~/.claude/.credentials.json, or on macOS the
// Keychain item "Claude Code-credentials". The token is only read, stays in
// this process and goes only to createart.tactilews.com. It is never
// renewed here: Claude Code renews it when an agent uses the connector, and
// a renewal here would make Claude Code's copy stale.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BUDGET_URL = 'https://createart.tactilews.com/api/rate-limit';

function credentials() {
  return new Promise(resolve => {
    try {
      resolve(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8')));
      return;
    } catch { /* not in a file: the Keychain on macOS */ }
    if (process.platform !== 'darwin') return resolve(null);
    execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 10000 }, (err, stdout) => {
      try { resolve(err ? null : JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

// Resolves with null when the connector is not signed in, { expired: true }
// when its sign-in has run out, { error } when Create Art did not answer,
// else { spentUsd, limitUsd, resetsAt }.
async function budget() {
  const creds = await credentials();
  const entry = Object.entries(creds?.mcpOAuth || {}).find(([key, v]) => key.startsWith('tactile-create-art|') || /createart\.tactilews\.com/.test(v?.serverUrl || ''))?.[1];
  if (!entry?.accessToken) return null;
  if (entry.expiresAt && entry.expiresAt < Date.now()) return { expired: true };
  try {
    const res = await fetch(BUDGET_URL, {
      headers: { Authorization: `Bearer ${entry.accessToken}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 401) return { expired: true };
    if (!res.ok) return { error: `Create Art answered ${res.status}` };
    const b = (await res.json())?.budget;
    if (typeof b?.spentUsd !== 'number' || typeof b?.limitUsd !== 'number') return { error: 'Create Art sent no budget' };
    return { spentUsd: b.spentUsd, limitUsd: b.limitUsd, resetsAt: b.resetsAt || null };
  } catch {
    return { error: 'Could not reach Create Art' };
  }
}

module.exports = { budget };
