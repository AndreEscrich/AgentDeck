// Notifications from Tactile PM, like PM's own bell, read with the app's
// PM sign-in (src/pmclient.js).
//
// PM's tools have no list of notifications, so the app makes its own. Every
// 2 minutes, while you are signed in, it asks PM for the tickets that
// changed since the last look and that are yours: assigned to you, with you
// as Assignee 2, or reported by you. It compares each one with what it saw
// before and keeps a notification for:
//
//  - a new ticket for you (assigned to you by someone else),
//  - a status change ("In QA → Done"),
//  - a new comment by someone else,
//  - a new subtask on one of your tickets.
//
// Changes you made from this app are left out. The first look only learns
// what is there, so you are not flooded with old changes. Notifications are
// kept in pm-notifications.json in the app's settings folder (the newest
// 200), with which ones you read.

const fs = require('fs');
const path = require('path');
const pm = require('./pmclient');

const EVERY_MS = 2 * 60 * 1000;
const KEEP = 200;
let file = null;
let state = null;     // { since, seen: { key: snapshot }, items: [notification], projects: [] }
let onChange = () => {};
let timer = null;
let checking = null;
const ownWrites = new Map();   // key -> time this app last changed it

function load() {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function save() {
  try { fs.writeFileSync(file, JSON.stringify(state)); } catch { /* kept for this run */ }
}

function setup(userData, notify) {
  file = path.join(userData, 'pm-notifications.json');
  state = load() || { since: null, seen: {}, items: [], projects: [] };
  onChange = notify;
  clearInterval(timer);
  timer = setInterval(() => check().catch(() => {}), EVERY_MS);
  setTimeout(() => check().catch(() => {}), 8000);
}

// The app changed this ticket: its next change is not news to you.
function wrote(key) { ownWrites.set(key, Date.now()); }
function byApp(key, at) {
  const t = ownWrites.get(key);
  return t && Math.abs(new Date(at).getTime() - t) < 3 * 60 * 1000;
}

function summary() {
  return { unread: state.items.filter(n => !n.read).length, items: state.items };
}

// A reporter is an email in PM. Comments carry both a person's email and
// name, so the notifier learns names from them (kept in state.names).
function nameOf(email) {
  if (!email) return '';
  const known = state.names?.[String(email).toLowerCase()];
  if (known) return known;
  const name = pm.personName(email);
  return name;
}

function snapshot(t) {
  return { statusId: t.statusId || '', assigneeId: t.assigneeId || '', updatedAt: t.updatedAt || '', title: t.title || '' };
}

async function search(tql, projectId) {
  const args = { tql, limit: 200, descriptionMaxLength: 0, returnStyleMetadata: true };
  if (projectId) args.projectId = projectId;
  const r = await pm.callTool('pm_search_tasks', args);
  return r?.items || [];
}

// One look at PM. Resolves with the summary.
function check() {
  if (!pm.status().connected) return Promise.resolve(summary());
  checking ||= (async () => {
    const started = new Date().toISOString();
    const first = !state.since;
    // A little overlap, so a change saved while we looked is not missed.
    // The first look learns all your tickets (no time limit), so a later
    // change to an old ticket is not taken for a new assignment.
    const since = first ? '' : new Date(new Date(state.since).getTime() - 60 * 1000).toISOString();
    const after = (first ? '' : ` AND updatedAt > "${since}"`) + ' ORDER BY updatedAt DESC';
    const lists = await Promise.all([
      search(`assignee = currentUser()${after}`),
      search(`author = currentUser()${after}`),
      ...(state.projects || []).map(p => search(`assignee2 = currentUser()${after}`, p).catch(() => [])),
    ]);
    const changed = new Map();
    for (const t of lists.flat()) if (t?.key) changed.set(t.key, t);
    const me = (pm.status().email || '').toLowerCase();
    const projects = new Set(state.projects || []);
    const fresh = [];
    const add = (t, kind, text, at, extra = {}) => {
      const id = `${t.key}:${kind}:${at}`;
      if (state.items.some(n => n.id === id)) return;
      fresh.push({ id, key: t.key, title: t.title || '', type: t.type || '', kind, text, at, read: false, ...extra });
    };
    for (const t of changed.values()) {
      projects.add((t.key || '').split('-')[0]);
      const before = state.seen[t.key];
      state.seen[t.key] = snapshot(t);
      if (first) continue;
      if (before && before.updatedAt === t.updatedAt) continue;
      const mine = lists[0].includes(t);   // assigned to you now
      const byMe = String(t.author || '').toLowerCase() === me;
      if (mine && !before && t.createdAt > since && !byMe) {
        add(t, 'new', `${nameOf(t.author) || 'Someone'} created it for you`, t.createdAt);
      } else if (mine && (!before || before.assigneeId !== t.assigneeId) && !byApp(t.key, t.updatedAt)) {
        add(t, 'assigned', 'Assigned to you', t.updatedAt);
      }
      const move = t.lastStatusTransition;
      if (move?.changedAt && move.changedAt > since && (!before || before.statusId !== t.statusId) && !byApp(t.key, move.changedAt)) {
        add(t, 'status', `${move.from || '?'} → ${move.to || t.resolvedStatusName || '?'}`, move.changedAt, { category: t.styleMetadata?.status?.lifecycleCategory || '' });
      }
      // Comments and subtasks: read only for the tickets that changed.
      const [comments, subs] = await Promise.all([
        pm.callTool('pm_list_comments', { key: t.key }).catch(() => []),
        pm.callTool('pm_list_subtasks', { key: t.key }).catch(() => []),
      ]);
      for (const c of Array.isArray(comments) ? comments : []) {
        if (c.authorEmail && c.authorName && !c.authorName.includes('@')) (state.names ||= {})[c.authorEmail.toLowerCase()] = c.authorName;
        if (!c.createdAt || c.createdAt <= since || c.deletedAt) continue;
        if (String(c.authorEmail || '').toLowerCase() === me) continue;
        const text = String(c.content || '').replace(/<img[^>]*>/g, ' [image] ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
        add(t, 'comment', `${c.authorName || 'Someone'}: ${text.slice(0, 160)}`, c.createdAt, { by: c.authorName || '' });
      }
      for (const s of Array.isArray(subs) ? subs : []) {
        if (!s.createdAt || s.createdAt <= since || byApp(t.key, s.createdAt)) continue;
        if (String(s.author || '').toLowerCase() === me) continue;
        add(t, 'subtask', `${nameOf(s.author) || 'Someone'} added ${s.key}: ${s.title || ''}`, s.createdAt);
      }
    }
    state.projects = [...projects].filter(Boolean);
    state.since = started;
    if (fresh.length) {
      fresh.sort((a, b) => (a.at < b.at ? 1 : -1));
      state.items = [...fresh, ...state.items].slice(0, KEEP);
    }
    // Keep what was seen of the 3000 most recently changed tickets.
    const seen = Object.entries(state.seen);
    if (seen.length > 3000) state.seen = Object.fromEntries(seen.sort((a, b) => (a[1].updatedAt < b[1].updatedAt ? 1 : -1)).slice(0, 3000));
    save();
    const out = summary();
    if (fresh.length) onChange(out, fresh);
    return out;
  })().finally(() => { checking = null; });
  return checking;
}

function markRead(ids) {
  const all = !Array.isArray(ids);
  for (const n of state.items) if (all || ids.includes(n.id)) n.read = true;
  save();
  const out = summary();
  onChange(out, []);
  return out;
}

function clear() {
  state.items = [];
  save();
  const out = summary();
  onChange(out, []);
  return out;
}

module.exports = { setup, check, summary, markRead, clear, wrote };
