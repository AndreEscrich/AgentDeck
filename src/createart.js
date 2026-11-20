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
// The connector's sign-in as Claude Code keeps it, or undefined.
async function signIn() {
  const creds = await credentials();
  const own = ownConnector();
  return Object.entries(creds?.mcpOAuth || {}).find(([key, v]) => key.startsWith(`${NAME}|`) || (own && key.startsWith(`${own}|`)) || isCreateArt(v?.serverUrl))?.[1];
}

async function budget() {
  const entry = await signIn();
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

// ---------- the Gallery's builder (renderer/gallery.js) ----------
//
// Create: the collage you made goes to Create Art's edit_image with your
// prompt, and the new image comes back as PNG bytes. It is a creation in
// your Create Art library too (its default folder). The sign-in goes only to
// createart.tactilews.com, the MCP and the image it made.

let mcpSession = null;
let rpcId = 1;
async function mcp(token, method, params, { notify = false, timeout = 30000 } = {}) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, 'mcp-protocol-version': '2025-06-18' };
  if (mcpSession) headers['mcp-session-id'] = mcpSession;
  const body = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: rpcId++, method, params };
  const res = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeout) });
  const sid = res.headers.get('mcp-session-id');
  if (sid && method === 'initialize') mcpSession = sid;
  if (notify) return null;
  const text = await res.text();
  if (res.status === 401) throw Object.assign(new Error('Your Create Art sign-in ran out. Sign in again from the Create Art card on the Hub.'), { expired: true });
  if (res.status === 404 && mcpSession) { mcpSession = null; throw Object.assign(new Error('session'), { again: true }); }
  if (!res.ok) throw new Error(`Create Art answered ${res.status}: ${text.slice(0, 300)}`);
  let msg = null;
  if (/^\s*\{/.test(text)) msg = JSON.parse(text);
  else for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try { const m = JSON.parse(line.slice(5)); if (m.id === body.id) msg = m; } catch { /* another event */ }
  }
  if (!msg) throw new Error('Create Art sent no answer.');
  if (msg.error) throw new Error(msg.error.message || 'Create Art refused the request.');
  return msg.result;
}

async function callTool(token, name, args, timeout) {
  for (let i = 0; ; i++) {
    try {
      if (!mcpSession) {
        await mcp(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-hub', version: '1' } });
        await mcp(token, 'notifications/initialized', {}, { notify: true });
      }
      const r = await mcp(token, 'tools/call', { name, arguments: args }, { timeout });
      const text = (r?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      if (r?.isError) throw new Error(text.slice(0, 600) || `${name} failed.`);
      try { return JSON.parse(text); } catch { return text; }
    } catch (err) {
      if (err.again && i === 0) continue;
      throw err;
    }
  }
}

// The id of the creation in an answer: the first 24-hex id, looked for
// under the names Create Art uses.
function creationId(r) {
  const hex = v => typeof v === 'string' && /^[0-9a-f]{24}$/.test(v) ? v : null;
  if (!r || typeof r !== 'object') return typeof r === 'string' ? (/\b([0-9a-f]{24})\b/.exec(r)?.[1] || null) : null;
  return hex(r.creationId) || hex(r.id) || creationId(r.creation) || creationId(r.result) || hex(r.creation?.id) || null;
}

// { png: Buffer, id } or { error }.
async function editImage({ imageBase64, mimeType, prompt }) {
  const entry = await signIn();
  if (!entry?.accessToken) return { error: 'Sign in to Create Art first (the Create Art card on the Hub).', signIn: true };
  if (entry.expiresAt && entry.expiresAt < Date.now()) return { error: 'Your Create Art sign-in ran out. Sign in again from the Create Art card on the Hub.', signIn: true };
  try {
    const r = await callTool(entry.accessToken, 'edit_image', {
      prompt: String(prompt).slice(0, 4000),
      imageBase64, imageMimeType: mimeType,
      intent: 'A collage made in the Agent Hub Gallery, changed by the prompt',
    }, 10 * 60 * 1000);
    const id = creationId(r);
    if (!id) return { error: 'Create Art made no image.' };
    const res = await fetch(`https://createart.tactilews.com/api/library/${id}/image`, {
      headers: { Authorization: `Bearer ${entry.accessToken}` }, redirect: 'error', signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return { error: `Could not download the image (${res.status}).` };
    return { png: Buffer.from(await res.arrayBuffer()), id };
  } catch (err) {
    return { error: err.name === 'TimeoutError' ? 'Create Art took more than 10 minutes. The image may still show in your Create Art library.' : String(err.message || err).slice(0, 600) };
  }
}

module.exports = { budget, connect, editImage };
