// Agent Hub's own sign-in to one of Tactile's MCP servers (Tactile BI, and
// any other that works like Tactile PM's), and its tools called directly.
// The same steps as src/pmclient.js, for any server:
//
//  1. Connect registers the app with the server and opens its sign-in page
//     in your browser.
//  2. After you sign in, the browser comes back to a small web server the app
//     runs on 127.0.0.1 for that moment, with a one-time code.
//  3. The app trades the code for an access key and a renewal key, kept in
//     <name>-auth-<copy>.json in the app's settings folder, encrypted with
//     the system's keychain (Electron's safeStorage).
//  4. Tool calls are MCP JSON-RPC requests (initialize, then tools/call) with
//     the access key, renewed by itself when it expires.
//
// No model reads the answers, so these calls cost no tokens. This sign-in is
// separate from claude.ai's connectors, which your agents use.
//
// makeClient({ server: 'https://bi-mcp.tactilews.com', name: 'bi', label:
// 'Tactile BI' }) returns { setup, status, connect, disconnect, callTool }.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const CLIENT_NAME = 'Agent Hub';
const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function makeClient({ server, name, label }) {
  const MCP_URL = `${server}/mcp`;
  let authFile = null;
  let auth = null;        // { clientId, redirectUri, accessToken, refreshToken, expiresAt, email }
  let session = null;
  let pending = null;
  let electron = null;

  // Each copy of the app keeps its own sign-in file (see pmclient.js setup).
  function setup(userData) {
    const tag = crypto.createHash('sha1').update(String(process.execPath).toLowerCase()).digest('hex').slice(0, 10);
    authFile = path.join(userData, `${name}-auth-${tag}.json`);
    electron = require('electron');
    auth = load();
  }

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(authFile, 'utf8'));
      if (raw.encrypted && electron.safeStorage.isEncryptionAvailable()) {
        return JSON.parse(electron.safeStorage.decryptString(Buffer.from(raw.encrypted, 'base64')));
      }
      return raw.plain || null;
    } catch { return null; }
  }

  function save() {
    try {
      if (!auth) { fs.rmSync(authFile, { force: true }); return; }
      const json = JSON.stringify(auth);
      const out = electron.safeStorage.isEncryptionAvailable()
        ? { encrypted: electron.safeStorage.encryptString(json).toString('base64') }
        : { plain: auth };
      fs.writeFileSync(authFile, JSON.stringify(out), { mode: 0o600 });
    } catch { /* kept for this run */ }
  }

  const status = () => ({ connected: !!auth?.refreshToken || !!auth?.accessToken, email: auth?.email || null, connecting: !!pending });

  function disconnect() {
    auth = null;
    session = null;
    save();
    return status();
  }

  function notConnected(text = `Not connected to ${label}.`) {
    const err = new Error(text);
    err.notConnected = true;
    return err;
  }

  async function postForm(url, fields) {
    const res = await electron.net.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(fields).toString(),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok) throw new Error(json?.error_description || json?.error || `${label} answered ${res.status}`);
    return json;
  }

  function keep(tokens) {
    auth.accessToken = tokens.access_token;
    if (tokens.refresh_token) auth.refreshToken = tokens.refresh_token;
    auth.expiresAt = Date.now() + (Number(tokens.expires_in) || 3600) * 1000;
    save();
  }

  // The browser sign-in. Resolves with status() once you signed in.
  function connect() {
    if (pending) return pending;
    pending = (async () => {
      const verifier = b64url(crypto.randomBytes(32));
      const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
      const state = b64url(crypto.randomBytes(16));
      let finish;
      const got = new Promise((resolve, reject) => { finish = { resolve, reject }; });
      const web = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
        const ok = url.searchParams.get('state') === state && url.searchParams.get('code');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>Agent Hub</title><body style="font:16px system-ui;background:#1d1813;color:#f3ead9;display:grid;place-items:center;height:90vh">${ok ? `Agent Hub is connected to ${label}. You can close this tab.` : 'The sign-in did not work. Go back to Agent Hub and try again.'}</body>`);
        if (ok) finish.resolve(url.searchParams.get('code'));
        else finish.reject(new Error(url.searchParams.get('error_description') || url.searchParams.get('error') || 'The sign-in did not work.'));
      });
      await new Promise((resolve, reject) => { web.once('error', reject); web.listen(0, '127.0.0.1', resolve); });
      const redirectUri = `http://127.0.0.1:${web.address().port}/callback`;
      const timeout = setTimeout(() => finish.reject(new Error('The sign-in took more than 5 minutes. Try again.')), 5 * 60 * 1000);
      try {
        const reg = await electron.net.fetch(`${server}/mcp/auth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ client_name: CLIENT_NAME, redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
        });
        const client = await reg.json().catch(() => null);
        if (!reg.ok || !client?.client_id) throw new Error(client?.error_description || `${label} refused to register the app (${reg.status}).`);
        const url = new URL(`${server}/mcp/auth/authorize`);
        for (const [k, v] of Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state, resource: MCP_URL })) url.searchParams.set(k, v);
        await electron.shell.openExternal(url.toString());
        const code = await got;
        const tokens = await postForm(`${server}/mcp/auth/token`, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: client.client_id, code_verifier: verifier, resource: MCP_URL });
        auth = { clientId: client.client_id, redirectUri };
        keep(tokens);
        session = null;
        return status();
      } finally {
        clearTimeout(timeout);
        web.close();
      }
    })().finally(() => { pending = null; });
    return pending;
  }

  let renewing = null;
  async function accessToken() {
    if (!auth?.accessToken && !auth?.refreshToken) throw notConnected();
    if (auth.accessToken && Date.now() < (auth.expiresAt || 0) - 60 * 1000) return auth.accessToken;
    if (!auth.refreshToken) throw notConnected();
    renewing ||= postForm(`${server}/mcp/auth/token`, { grant_type: 'refresh_token', refresh_token: auth.refreshToken, client_id: auth.clientId, resource: MCP_URL })
      .then(tokens => { keep(tokens); return auth.accessToken; })
      .catch(err => { disconnect(); throw notConnected(`${label} ended the sign-in (${err.message}). Connect again.`); })
      .finally(() => { renewing = null; });
    return renewing;
  }

  let nextId = 1;
  async function rpc(method, params, { notify = false, retried = false } = {}) {
    const token = await accessToken();
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, 'mcp-protocol-version': '2025-06-18' };
    if (session?.id) headers['mcp-session-id'] = session.id;
    const body = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: nextId++, method, params };
    const res = await electron.net.fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) });
    if (res.status === 401 && !retried) { auth.expiresAt = 0; return rpc(method, params, { notify, retried: true }); }
    if (res.status === 404 && session?.id && !retried && method !== 'initialize') {
      session = null;
      await startSession();
      return rpc(method, params, { notify, retried: true });
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid && method === 'initialize') session = { id: sid };
    if (notify) return null;
    const text = await res.text();
    if (!res.ok) throw new Error(`${label} answered ${res.status}: ${text.slice(0, 200)}`);
    let msg = null;
    if (/^\s*\{/.test(text)) msg = JSON.parse(text);
    else for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try { const m = JSON.parse(line.slice(5)); if (m.id === body.id) msg = m; } catch { /* another event */ }
    }
    if (!msg) throw new Error(`${label} sent no answer.`);
    if (msg.error) throw new Error(msg.error.message || `${label} refused the request.`);
    return msg.result;
  }

  let starting = null;
  function startSession() {
    if (session) return Promise.resolve();
    starting ||= (async () => {
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: CLIENT_NAME, version: electron.app.getVersion() } });
      await rpc('notifications/initialized', {}, { notify: true });
    })().finally(() => { starting = null; });
    return starting;
  }

  // Calls one of the server's tools and returns its answer: the JSON in its
  // text, or the text itself.
  async function callTool(tool, args) {
    await startSession();
    const result = await rpc('tools/call', { name: tool, arguments: args || {} });
    const text = (result?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    if (result?.isError) throw new Error(text.slice(0, 1200) || `${tool} failed.`);
    try { return JSON.parse(text); } catch { return text; }
  }

  return { setup, status, connect, disconnect, callTool };
}

module.exports = { makeClient };
