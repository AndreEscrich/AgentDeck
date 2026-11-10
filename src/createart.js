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
//
// A Create Art connector from your claude.ai account keeps its sign-in on
// Anthropic's servers, where the app cannot read it. Then the card offers a
// sign-in of its own (connect): a Create Art connector in Claude Code
// (tactile-create-art, user scope), signed in with claude mcp login. Claude
// Code then lists only that one, not the claude.ai one with the same
// address, so agents do not get Create Art's tools twice.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BUDGET_URL = 'https://createart.tactilews.com/api/rate-limit';
const MCP_URL = 'https://createart.tactilews.com/mcp';
const NAME = 'tactile-create-art';
const isCreateArt = url => /^https:\/\/createart\.tactilews\.com\//.test(url || '');

// Claude Code's own settings (~/.claude.json): the connectors you added
// (mcpServers) and the claude.ai connectors it has connected.
function claudeJson() {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')); } catch { return {}; }
}

// The name of a Create Art connector you added in Claude Code, or null.
function ownConnector() {
  const servers = claudeJson().mcpServers || {};
  return Object.keys(servers).find(name => isCreateArt(servers[name]?.url)) || null;
}

// Without a sign-in the app can read: { signIn: 'add' } when Create Art is a
// claude.ai connector only, { signIn: 'login' } when your own connector is
// not signed in yet; null when there is no Create Art connector.
function missingSignIn() {
  if (ownConnector()) return { signIn: 'login' };
  const account = claudeJson().claudeAiMcpEverConnected;
  return Array.isArray(account) && account.some(n => /create\s*art/i.test(n)) ? { signIn: 'add' } : null;
}

// The card's Sign in button: adds the connector when it is not there, then
// signs in in a terminal window (see connectors.login).
async function connect(config) {
  const connectors = require('./connectors');
  let name = ownConnector();
  if (!name) {
    const added = await connectors.add(config, { name: NAME, url: MCP_URL, transport: 'http' });
    if (!added.ok) return { ok: false, message: added.message || 'Could not add the connector.' };
    name = NAME;
  }
  return connectors.login(config, name);
}

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
  const own = ownConnector();
  const entry = Object.entries(creds?.mcpOAuth || {}).find(([key, v]) => key.startsWith(`${NAME}|`) || (own && key.startsWith(`${own}|`)) || isCreateArt(v?.serverUrl))?.[1];
  if (!entry?.accessToken) return missingSignIn();
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

module.exports = { budget, connect };
