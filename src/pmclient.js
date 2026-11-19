// Agent Hub's own sign-in to Tactile PM, and PM's tools called directly.
//
// The PM connector your agents use comes from claude.ai, which keeps its
// sign-in on Anthropic's servers, so without this the app can only reach PM
// through Haiku (see readPmTasks in agents.js), which costs tokens and takes
// seconds. PM's connector server (pm-mcp.tactilews.com) also lets any MCP
// client sign in by itself, the standard way (OAuth 2.1 with PKCE):
//
//  1. Connect registers the app with PM (registration_endpoint) and opens
//     PM's sign-in page in your browser.
//  2. After you sign in, PM sends the browser back to a small web server the
//     app runs on 127.0.0.1 for that moment, with a one-time code.
//  3. The app trades the code for an access key and a renewal key
//     (token_endpoint), and keeps them in pm-auth.json in the app's settings
//     folder, encrypted with the system's keychain (Electron's safeStorage).
//  4. Calls go to https://pm-mcp.tactilews.com/mcp as MCP JSON-RPC requests
//     (initialize, then tools/call), with the access key. An expired key is
//     renewed with the renewal key; when that fails too, the app asks you to
//     connect again.
//
// No model reads the answers, so the calls cost no tokens and take well
// under a second. This sign-in is separate from claude.ai's: signing out
// here does not touch the connector your agents use.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const SERVER = 'https://pm-mcp.tactilews.com';
const MCP_URL = `${SERVER}/mcp`;
const CLIENT_NAME = 'Agent Hub';

let authFile = null;
let auth = null;        // { clientId, redirectUri, accessToken, refreshToken, expiresAt, email }
let session = null;     // { id, at } the MCP session from initialize
let pending = null;     // the sign-in under way: Promise
let electron = null;

// Each copy of the app (the main one, the dev one) keeps its own sign-in
// file: they share the settings folder, but Windows ties what safeStorage
// encrypts to the program that saved it, so one copy cannot read the
// other's, and before, whichever saved last signed the other out. The file
// is named after the program's path; an older shared pm-auth.json is used
// once if this copy can read it.
function setup(userData) {
  const tag = require('crypto').createHash('sha1').update(String(process.execPath).toLowerCase()).digest('hex').slice(0, 10);
  authFile = path.join(userData, `pm-auth-${tag}.json`);
  electron = require('electron');
  auth = load();
  if (!auth) {
    auth = load(path.join(userData, 'pm-auth.json'));
    if (auth) save();
  }
}

function load(file = authFile) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
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

function status() {
  return { connected: !!auth?.refreshToken || !!auth?.accessToken, email: auth?.email || null, connecting: !!pending };
}

function disconnect() {
  auth = null;
  session = null;
  save();
  return status();
}

const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function postForm(url, fields) {
  const res = await electron.net.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(fields).toString(),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) throw new Error(json?.error_description || json?.error || `PM answered ${res.status}`);
  return json;
}

function keep(tokens) {
  auth.accessToken = tokens.access_token;
  if (tokens.refresh_token) auth.refreshToken = tokens.refresh_token;
  auth.expiresAt = Date.now() + (Number(tokens.expires_in) || 3600) * 1000;
  save();
}

// Connect: the browser sign-in. Resolves with status() once you signed in,
// or rejects (closed the page, waited more than 5 minutes).
function connect() {
  if (pending) return pending;
  pending = (async () => {
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    // The page PM sends the browser back to, on a free port of this computer.
    let finish;
    const got = new Promise((resolve, reject) => { finish = { resolve, reject }; });
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      const ok = url.searchParams.get('state') === state && url.searchParams.get('code');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>Agent Hub</title><body style="font:16px system-ui;background:#1d1813;color:#f3ead9;display:grid;place-items:center;height:90vh">${ok ? 'Agent Hub is connected to Tactile PM. You can close this tab.' : 'The sign-in did not work. Go back to Agent Hub and try again.'}</body>`);
      if (ok) finish.resolve(url.searchParams.get('code'));
      else finish.reject(new Error(url.searchParams.get('error_description') || url.searchParams.get('error') || 'The sign-in did not work.'));
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
    const timeout = setTimeout(() => finish.reject(new Error('The sign-in took more than 5 minutes. Try again.')), 5 * 60 * 1000);
    try {
      const reg = await electron.net.fetch(`${SERVER}/mcp/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ client_name: CLIENT_NAME, redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
      });
      const client = await reg.json().catch(() => null);
      if (!reg.ok || !client?.client_id) throw new Error(client?.error_description || `PM refused to register the app (${reg.status}).`);
      const url = new URL(`${SERVER}/mcp/auth/authorize`);
      for (const [k, v] of Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state, resource: MCP_URL })) url.searchParams.set(k, v);
      await electron.shell.openExternal(url.toString());
      const code = await got;
      const tokens = await postForm(`${SERVER}/mcp/auth/token`, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: client.client_id, code_verifier: verifier, resource: MCP_URL });
      auth = { clientId: client.client_id, redirectUri };
      keep(tokens);
      session = null;
      // Who signed in, for Settings and the view.
      try { auth.email = (await callTool('pm_whoami', {}))?.email || null; save(); } catch { /* shown without */ }
      return status();
    } finally {
      clearTimeout(timeout);
      server.close();
    }
  })().finally(() => { pending = null; });
  return pending;
}

let renewing = null;
async function accessToken() {
  if (!auth?.accessToken && !auth?.refreshToken) throw notConnected();
  if (auth.accessToken && Date.now() < (auth.expiresAt || 0) - 60 * 1000) return auth.accessToken;
  if (!auth.refreshToken) throw notConnected();
  renewing ||= postForm(`${SERVER}/mcp/auth/token`, { grant_type: 'refresh_token', refresh_token: auth.refreshToken, client_id: auth.clientId, resource: MCP_URL })
    .then(tokens => { keep(tokens); return auth.accessToken; })
    .catch(err => { disconnect(); throw notConnected(`PM ended the sign-in (${err.message}). Connect again.`); })
    .finally(() => { renewing = null; });
  return renewing;
}

function notConnected(text = 'Not connected to Tactile PM. Connect in the Tickets view.') {
  const err = new Error(text);
  err.notConnected = true;
  return err;
}

let nextId = 1;
// One JSON-RPC request. The answer comes as JSON or as a short event
// stream (text/event-stream) with the answer in a data: line.
async function rpc(method, params, { notify = false, retried = false } = {}) {
  const token = await accessToken();
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, 'mcp-protocol-version': '2025-06-18' };
  if (session?.id) headers['mcp-session-id'] = session.id;
  const body = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: nextId++, method, params };
  const res = await electron.net.fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  if (res.status === 401 && !retried) {
    auth.expiresAt = 0;   // renew and try once more
    return rpc(method, params, { notify, retried: true });
  }
  if (res.status === 404 && session?.id && !retried && method !== 'initialize') {
    session = null;       // the server forgot the session: start a new one
    await startSession();
    return rpc(method, params, { notify, retried: true });
  }
  const sid = res.headers.get('mcp-session-id');
  if (sid && method === 'initialize') session = { id: sid, at: Date.now() };
  if (notify) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`PM answered ${res.status}: ${text.slice(0, 200)}`);
  let msg = null;
  if (/^\s*\{/.test(text)) msg = JSON.parse(text);
  else for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try { const m = JSON.parse(line.slice(5)); if (m.id === body.id) msg = m; } catch { /* another event */ }
  }
  if (!msg) throw new Error('PM sent no answer.');
  if (msg.error) throw new Error(msg.error.message || 'PM refused the request.');
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

// Calls one of PM's tools (pm_search_tasks, pm_get_task, ...) and returns its
// answer: the JSON in its text, or the text itself.
async function callTool(name, args) {
  await startSession();
  const result = await rpc('tools/call', { name, arguments: args || {} });
  const text = (result?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  if (result?.isError) throw new Error(text.slice(0, 1200) || `${name} failed.`);
  try { return JSON.parse(text); } catch { return text; }
}

// ---------- the Tickets view (renderer/tickets.js) ----------

// A ticket as the view needs it.
// ---------- people's names ----------
//
// PM keeps an assignee as the text it was given plus the person's id. So a
// ticket assigned with an email (an agent or a person typed the email) shows
// "andree@tactile.dk", while the same person on another ticket shows
// "André Escrich González". The app learns each id's name from the tickets
// it reads, and shows that name for the email too.
const nameById = new Map();    // assigneeId -> the name PM shows
const emailById = new Map();   // assigneeId -> an email it was given as
function learn(t) {
  for (const [name, id] of [[t?.assignee, t?.assigneeId], [t?.assignee2, t?.assignee2Id]]) {
    if (!name || !id) continue;
    if (name.includes('@')) emailById.set(id, name.toLowerCase());
    else nameById.set(id, name);
  }
}
// Your own id, read once, so your sign-in email gets your name even before
// a list was read.
let meRead = null;
function learnMe() {
  if (!auth?.email) return Promise.resolve();
  meRead ||= callTool('pm_search_tasks', { tql: 'assignee = currentUser() ORDER BY updatedAt DESC', limit: 1, descriptionMaxLength: 0 })
    .then(r => { const t = r?.items?.[0]; if (t) { learn(t); if (t.assigneeId) emailById.set(t.assigneeId, auth.email.toLowerCase()); } })
    .catch(() => { meRead = null; });
  return meRead;
}

function personName(name, id) {
  if (!name) return '';
  if (id && nameById.has(id)) return nameById.get(id);
  if (name.includes('@')) {
    const email = name.toLowerCase();
    for (const [i, e] of emailById) if (e === email && nameById.has(i)) return nameById.get(i);
  }
  return name;
}

function slim(t) {
  const f = t.fieldNames || {};
  return {
    id: t._id || '', statusId: t.statusId || '', typeId: t.taskTypeDefinitionId || '',
    key: t.key, title: t.title || '', type: f.taskTypeDefinitionId || t.type || '',
    status: t.resolvedStatusName || t.lastStatusTransition?.to || (t.doneAt ? 'Done' : 'To Do'),
    category: t.styleMetadata?.status?.lifecycleCategory || (t.doneAt ? 'done' : t.columnId === 'in-progress' ? 'in_progress' : 'todo'),
    color: t.styleMetadata?.status?.color || null, textColor: t.styleMetadata?.status?.text || null,
    priority: t.priority || '', assignee: personName(t.assignee, t.assigneeId), assigneeId: t.assigneeId || '', sprint: f.sprintId || '', epic: f.epicId || '',
    project: (t.key || '').split('-')[0], projectId: t.projectId || '', updatedAt: t.updatedAt || '', seq: t.sequenceNumber || Number((t.key || '').split('-')[1]) || 0,
  };
}

const LIST_FIELDS = { descriptionMaxLength: 0, returnFieldNames: true, returnStyleMetadata: true, limit: 200 };
const LIST_TQL = {
  // Your tickets in the open sprints, done ones too (like PM's sheet).
  sprint: 'assignee = currentUser() AND sprint IN openSprints() ORDER BY updatedAt DESC',
  // Every ticket of the space that is not done, whoever has it (or nobody).
  all: 'statusCategory != done ORDER BY updatedAt DESC',
};

// The projects of a PM space (Settings → Tactile PM, Enchanted
// Inn by default), for All tickets. Kept for 30 minutes.
let spaceProjects = null;
async function projectsOfSpace(name) {
  const want = String(name || 'Enchanted Inn').trim().toLowerCase();
  if (spaceProjects?.name === want && Date.now() - spaceProjects.at < 30 * 60000) return spaceProjects.keys;
  const [spaces, projects] = await Promise.all([callTool('pm_list_spaces', {}), callTool('pm_list_projects', {})]);
  const space = (Array.isArray(spaces) ? spaces : []).find(s => [s.name, s.key].some(v => String(v || '').trim().toLowerCase() === want));
  if (!space) throw new Error(`Tactile PM has no space named "${name}". Change it in Settings → Tactile PM.`);
  const keys = (Array.isArray(projects) ? projects : []).filter(p => p.spaceId === space._id && !p.isArchived).map(p => p.key).filter(Boolean);
  if (!keys.length) throw new Error(`The space "${space.name}" has no projects.`);
  spaceProjects = { name: want, at: Date.now(), keys };
  return keys;
}

// All tickets: the space's open tickets, up to 600 (newest changes first).
async function spaceTickets(space) {
  const projectIds = await projectsOfSpace(space);
  const items = [];
  let total = 0;
  for (let offset = 0; offset < 600; offset += 200) {
    const r = await callTool('pm_search_tasks', { tql: LIST_TQL.all, projectIds, ...LIST_FIELDS, offset });
    const page = r.items || [];
    total = r.total || total;
    items.push(...page);
    if (page.length < 200 || items.length >= total) break;
  }
  items.forEach(learn);
  return { items: items.map(slim), total: Math.max(total, items.length) };
}

// list: 'sprint' (yours) or 'all' (the space's). Resolves with { items, total }.
async function tickets(list, { space } = {}) {
  if (list === 'all') return spaceTickets(space);
  const r = await callTool('pm_search_tasks', { tql: LIST_TQL.sprint, ...LIST_FIELDS });
  (r.items || []).forEach(learn);
  // These are all yours, so their assignee id is yours: your sign-in email
  // (the reporter of your tickets) gets your name too.
  const mine = (r.items || []).find(t => t.assigneeId)?.assigneeId;
  if (mine && auth?.email) emailById.set(mine, auth.email.toLowerCase());
  return { items: (r.items || []).map(slim), total: r.total || 0 };
}

// One ticket in full: its description (HTML), epic, links and subtasks.
// An epic key ("EI-E72"): the epic, with its tickets from every project.
const EPIC_KEY = /^[A-Z][A-Z0-9]*-E\d+$/;
async function epic(key) {
  const r = await callTool('pm_get_epic', { epic: key, descriptionMaxLength: 0, limit: 500 });
  const e = r?.epic;
  if (!e) throw new Error(`${key} was not found.`);
  (r.tasks || []).forEach(learn);
  return {
    key, isEpic: true, id: e._id || '', project: key.split('-')[0], title: e.name || key, type: 'Epic',
    status: e.status || '', description: e.description || '', author: personName(e.author),
    epicKey: key, epicName: e.name || '', epicColor: e.color || null,
    tasks: (r.tasks || []).map(slim), total: r.total || (r.tasks || []).length,
  };
}

async function ticket(key) {
  if (EPIC_KEY.test(key)) return epic(key);
  const [t, subs] = await Promise.all([
    callTool('pm_get_task', { key }),
    callTool('pm_list_subtasks', { key }).catch(() => []),
  ]);
  if (!t || typeof t !== 'object') throw new Error(`${key} was not found.`);
  await learnMe();
  learn(t);
  if (Array.isArray(subs)) subs.forEach(learn);
  const base = slim(t);
  const subtask = t.itemType === 'subtask';
  // A subtask comes without status colours, so its status comes from the
  // project's statuses, like the subtasks in a list.
  const st = (await statuses(base.project).catch(() => [])).find(s => s.id === t.statusId);
  if (st) Object.assign(base, { status: st.name, category: st.category, color: st.color, textColor: st.text });
  // A subtask names its story only by id: the story gives its key, title
  // and epic, for the Epic › Story › Subtask chain at the top of the panel.
  const parent = subtask && t.parentTaskId
    ? await callTool('pm_get_task', { taskId: t.parentTaskId, projectId: t.projectId }).catch(() => null)
    : null;
  const epicOf = parent?.epic || t.epic;
  return {
    ...base,
    subtask,
    itemType: t.itemType || 'task',
    description: t.description || '',
    author: personName(t.author),
    assignee2: personName(t.assignee2, t.assignee2Id), assignee2Id: t.assignee2Id || '',
    epicName: epicOf?.name || t.fieldNames?.epicId || parent?.fieldNames?.epicId || '',
    epicKey: epicOf?.key || '',
    parentKey: parent?.key || '', parentTitle: parent?.title || '', parentType: parent?.fieldNames?.taskTypeDefinitionId || parent?.type || '',
    // The fields the ticket panel shows and edits.
    priority: t.priority || '', storyPoints: t.storyPoints ?? null, estimate: t.estimate ?? null,
    epicId: t.epicId || '', sprintId: t.sprintId || '', teamId: t.teamId || '', team: t.fieldNames?.teamId || '',
    componentIds: t.componentIds || [], customFields: t.customFields || {}, typeId: t.taskTypeDefinitionId || '',
    parentId: t.parentTaskId || '', watchers: (t.watchers || []).length,
    // A ticket's images and videos: a list, or { media: [...] } (subtasks).
    media: (Array.isArray(t.inlineMedia) ? t.inlineMedia : t.inlineMedia?.media || []).map(m => ({ id: m.mediaId, name: m.fileName, type: m.contentType, url: m.previewUrl })),
    subtasks: subtask ? [] : await slimSubtasks(subs, base.project),
  };
}

// ---------- statuses, subtasks and status changes ----------

// A project's statuses (pm_list_statuses), kept 10 minutes: { id, name,
// category (todo | in_progress | done), color, text }, in PM's order.
const statusCache = new Map();   // project key -> { at, list }
async function statuses(project) {
  const hit = statusCache.get(project);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.list;
  const r = await callTool('pm_list_statuses', { projectId: project });
  const list = (Array.isArray(r) ? r : []).map(s => ({ id: s._id, name: s.name, category: s.lifecycleCategory || 'todo', color: s.color || null, text: s.text || null }));
  statusCache.set(project, { at: Date.now(), list });
  return list;
}

// Subtasks as the view needs them. A subtask's own "status" field is stale
// (it says TODO on done ones), so the name comes from its statusId and the
// project's statuses.
async function slimSubtasks(subs, project) {
  subs = Array.isArray(subs) ? subs : [];
  subs.forEach(learn);
  const list = subs.length ? await statuses(project).catch(() => []) : [];
  const byId = new Map(list.map(s => [s.id, s]));
  return subs.map(s => {
    const st = byId.get(s.statusId);
    const done = st ? st.category === 'done' : !!s.doneAt;
    return {
      id: s._id || '', key: s.key, title: s.title || '', assignee: personName(s.assignee, s.assigneeId), assigneeId: s.assigneeId || '', priority: s.priority || '',
      statusId: s.statusId || '', status: st?.name || s.lastStatusTransition?.to || (s.doneAt ? 'Done' : 'To Do'),
      category: st?.category || (done ? 'done' : s.columnId === 'in-progress' ? 'in_progress' : 'todo'),
      color: st?.color || null, textColor: st?.text || null, done,
      project, subtask: true, seq: s.sequenceNumber || Number((s.key || '').split('-')[1]) || 0,
    };
  });
}

async function subtasks(key) {
  const subs = await callTool('pm_list_subtasks', { key });
  return slimSubtasks(subs, (key || '').split('-')[0]);
}

// Moves a ticket or a subtask to another status. Resolves with the status
// it has now ({ statusId, status, category, color, textColor, done }).
async function setStatus({ key, id, project, statusId, subtask }) {
  const st = (await statuses(project)).find(s => s.id === statusId);
  if (!st) throw new Error('PM does not know that status.');
  // The tools take PM's id; tickets kept from before the app read ids have
  // only their key.
  if (!id) id = (await callTool('pm_get_task', { key }))?._id;
  if (!id) throw new Error(`${key} was not found.`);
  if (subtask) await callTool('pm_update_subtask', { projectId: project, subtaskId: id, statusId });
  else await callTool('pm_update_task', { projectId: project, taskId: id, statusId });
  return { statusId, status: st.name, category: st.category, color: st.color, textColor: st.text, done: st.category === 'done' };
}

// The same answer as readPmTasks in agents.js, read directly: { KEY: task }
// with subtaskCount for the keys in subtasksOf (the ⑂ Split button).
async function readTasks(keys, subtasksOf = []) {
  const out = {};
  await Promise.all(keys.map(async key => {
    const t = await callTool('pm_get_task', { key }).catch(err => { if (err.notConnected) throw err; return null; });
    if (!t || typeof t !== 'object' || t.key !== key) return;
    if (subtasksOf.includes(key)) {
      const story = /story/i.test(t.fieldNames?.taskTypeDefinitionId || t.type || '');
      t.subtaskCount = story ? (await callTool('pm_list_subtasks', { key }).catch(() => [])).length || 0 : 0;
    }
    out[key] = t;
  }));
  return out;
}

// ---------- the ticket panel: options, edits, attachments, comments ----------

const optionCache = new Map();   // project key -> { at, value }
// What the panel's fields can be set to: epics, open sprints, teams,
// components, custom fields and statuses of a project. Kept 10 minutes.
async function options(project) {
  const hit = optionCache.get(project);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
  const list = (name, args) => callTool(name, { projectId: project, ...args }).then(r => (Array.isArray(r) ? r : r?.items || [])).catch(() => []);
  const [epics, sprints, teams, components, fields, sts] = await Promise.all([
    list('pm_list_epics'), list('pm_list_sprints', { status: 'open' }), list('pm_list_teams'),
    list('pm_list_components'), list('pm_list_custom_fields'), statuses(project).catch(() => []),
  ]);
  const value = {
    epics: epics.filter(e => !e.isArchived && !e.deletedAt).map(e => ({ id: e._id, key: e.key || '', name: e.name || e.title || e.key || '', color: e.color || null, createdAt: e.createdAt || '', done: !!(e.doneAt || /done|closed/i.test(e.status || '')) })),
    sprints: sprints.map(x => ({ id: x._id, name: x.name, status: x.status || '' })),
    teams: teams.map(x => ({ id: x._id, name: x.name })),
    components: components.map(x => ({ id: x._id, name: x.name })),
    fields: fields.map(f => ({ id: f._id, name: f.name, type: f.fieldType, values: f.values || f.options || f.allowedValues || [], types: (f.taskTypes || []).map(tt => tt._id) })),
    statuses: sts,
  };
  optionCache.set(project, { at: Date.now(), value });
  return value;
}

const TASK_FIELDS = ['title', 'description', 'assignee', 'assignee2', 'epicId', 'sprintId', 'team', 'componentIds', 'estimate', 'priority', 'storyPoints', 'customFields', 'statusId'];
const SUBTASK_FIELDS = ['title', 'description', 'assignee', 'assignee2', 'estimate', 'priority', 'storyPoints', 'statusId'];

async function idOf(key, id) {
  if (id) return id;
  id = (await callTool('pm_get_task', { key }))?._id;
  if (!id) throw new Error(`${key} was not found.`);
  return id;
}

// Changes some fields of a ticket or subtask and resolves with the ticket
// read again, so names (epic, sprint, team) come back resolved.
async function update({ key, id, project, subtask, fields }) {
  const allowed = subtask ? SUBTASK_FIELDS : TASK_FIELDS;
  const args = {};
  for (const f of allowed) if (fields && f in fields) args[f] = fields[f];
  if (!Object.keys(args).length) throw new Error('Nothing to change.');
  id = await idOf(key, id);
  if (subtask) await callTool('pm_update_subtask', { projectId: project, subtaskId: id, ...args });
  else await callTool('pm_update_task', { projectId: project, taskId: id, ...args });
  return ticket(key);
}

async function createSubtask({ key, id, project, title }) {
  id = await idOf(key, id);
  await callTool('pm_create_subtask', { projectId: project, taskId: id, title });
  return ticket(key);
}

async function attachments({ project, id }) {
  const r = await callTool('pm_list_task_attachments', { projectId: project, taskId: id });
  return (Array.isArray(r) ? r : r?.items || []).map(a => ({
    id: a._id || a.id, name: a.fileName || a.name || 'File', type: a.contentType || a.type || '', size: a.size || 0, at: a.createdAt || '',
  }));
}

async function openAttachment({ project, attachmentId }) {
  const r = await callTool('pm_get_attachment_download_url', { projectId: project, attachmentId });
  const url = r?.previewUrl || r?.downloadUrl;
  if (!url) throw new Error('PM sent no link.');
  await electron.shell.openExternal(url);
  return { ok: true };
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', pdf: 'application/pdf', txt: 'text/plain', log: 'text/plain', json: 'application/json', zip: 'application/zip', csv: 'text/csv' };
// Uploads files (paths on this computer) as attachments of a ticket.
async function attach({ project, projectId, id, paths }) {
  for (const file of paths) {
    const fileName = path.basename(file);
    const contentType = MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';
    const bytes = fs.readFileSync(file);
    const up = await callTool('pm_request_task_attachment_upload', { projectId: project, taskId: id, fileName, contentType });
    if (!up?.signedUrl) throw new Error('PM gave no upload link.');
    const res = await electron.net.fetch(up.signedUrl, { method: 'PUT', headers: { 'content-type': contentType }, body: bytes });
    if (!res.ok) throw new Error(`The upload of ${fileName} failed (${res.status}).`);
    await callTool('pm_confirm_task_attachment', { projectId, taskId: id, fileName, contentType, storagePath: up.storagePath, size: bytes.length });
  }
  return attachments({ project, id });
}

// Comments of a ticket, or of a subtask (which PM finds by its id).
const commentTarget = ({ key, id, project, subtask }) => (subtask && id ? { subtaskId: id, projectId: project } : { key });
async function comments(a) {
  const r = await callTool('pm_list_comments', commentTarget(a));
  return (Array.isArray(r) ? r : r?.items || []).map(c => ({
    id: c._id || c.id, author: c.authorName || c.author || '', content: c.content || '', at: c.createdAt || '', parentId: c.parentCommentId || null, deleted: !!c.deletedAt,
  }));
}

async function addComment(a) {
  await callTool('pm_create_comment', { ...commentTarget(a), content: a.content, authorName: a.authorName || auth?.email || 'Agent Hub' });
  return comments(a);
}

// ---------- workflows: which status a ticket may move to ----------
//
// PM's tools do not say; PM's website reads it from its own API (found in
// its code): a project's issue-type scheme maps each ticket type to a status
// scheme, and a status scheme is either open (any status to any other) or a
// list of transitions { from, to } plus statuses reachable from any status.
// This reads the same, with the app's sign-in, and works out the next
// statuses the way the website does.
const WEB_API = 'https://pm.tactilews.com/api';
async function webApi(pathname) {
  const token = await accessToken();
  const res = await electron.net.fetch(WEB_API + pathname, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
  if (!res.ok) throw new Error(`PM's API answered ${res.status} for ${pathname}`);
  return res.json();
}

const workflowCache = new Map();   // project key -> { at, value }
async function workflows(project) {
  const hit = workflowCache.get(project);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
  const [p, types, typeSchemes, statusSchemes] = await Promise.all([
    callTool('pm_get_project', { projectId: project }),
    callTool('pm_list_task_types', { projectId: project }).catch(() => []),
    webApi('/pm/issue-type-schemes'),
    webApi('/pm/status-schemes'),
  ]);
  const list = v => (Array.isArray(v) ? v : v?.items || v?.data || []);
  const scheme = list(typeSchemes).find(s => s._id === p?.issueTypeSchemeId);
  const byId = new Map(list(statusSchemes).map(s => [s._id, s]));
  const byType = {};
  for (const item of scheme?.items || []) {
    const s = byId.get(item.statusSchemeId);
    if (!s) continue;
    const ids = new Set(s.statusIds || []);
    byType[item.taskTypeDefinitionId] = {
      name: s.name || '', mode: s.workflowMode || 'open', statusIds: s.statusIds || [],
      transitions: (s.transitions || []).filter(t => ids.has(t.from) && ids.has(t.to)),
      allowFromAny: (s.allowFromAnyStatusIds || []).filter(id => ids.has(id)),
      initial: ids.has(s.initialStatusId) ? s.initialStatusId : (s.statusIds || [])[0] || null,
    };
  }
  // The same by the type's name (Story, Bug), for tickets read before the app kept type ids.
  const byName = {};
  for (const tt of Array.isArray(types) ? types : []) if (byType[tt._id]) byName[String(tt.name).toLowerCase()] = byType[tt._id];
  const value = { byType, byName };
  workflowCache.set(project, { at: Date.now(), value });
  return value;
}

module.exports = { setup, status, connect, disconnect, callTool, tickets, ticket, readTasks, statuses, subtasks, setStatus,
  options, update, createSubtask, attachments, openAttachment, attach, comments, addComment, personName, workflows };
