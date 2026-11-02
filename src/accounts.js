// The Claude accounts in Settings → Account: the one Claude Code is signed in
// with, and the others you signed in with before, so you can switch back
// without signing in again.
//
// Claude Code keeps its login in two places:
//   the tokens    macOS: the keychain item "Claude Code-credentials";
//                 Windows and Linux: ~/.claude/.credentials.json.
//                 Both hold JSON: { claudeAiOauth: {...}, mcpOAuth: {...} }
//   the account   "oauthAccount" in ~/.claude.json (email, organization, ...)
// With CLAUDE_CONFIG_DIR set, both live in that folder instead, and the
// keychain item's name ends with the first 8 characters of the folder's
// SHA-256.
//
// Switching saves the tokens of the account you leave (they change when
// Claude Code refreshes them) and puts the saved ones of the other account in
// their place. Only claudeAiOauth changes; the connectors' logins (mcpOAuth)
// stay. The saved tokens go in the keychain too, one item per account
// ("Agent Hub Claude account"), and in a file only you can read on Windows
// and Linux. The account details (no secrets) are in claude-accounts.json.

const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const isMac = process.platform === 'darwin';
const SAVED_SERVICE = 'Agent Hub Claude account';
let file = null;

function setFile(f) { file = f; }

function configDir(config) {
  const dir = config.env?.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR;
  return dir ? { dir, custom: true } : { dir: path.join(os.homedir(), '.claude'), custom: false };
}
function globalFile(config) {
  const { dir, custom } = configDir(config);
  return custom ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json');
}
function keychainService(config) {
  const { dir, custom } = configDir(config);
  return 'Claude Code-credentials' + (custom ? '-' + crypto.createHash('sha256').update(dir).digest('hex').slice(0, 8) : '');
}
const user = () => os.userInfo().username;

// The keychain, through the security command: it is the program the items
// let in, so reading them asks for nothing (Claude Code does the same).
function keychainRead(service, account) {
  return new Promise(resolve => {
    execFile('security', ['find-generic-password', '-a', account, '-s', service, '-w'], { timeout: 15000 }, (err, out) => {
      resolve(err ? null : out.trim());
    });
  });
}
function keychainWrite(service, account, text) {
  // Through stdin, so the secret is not in the process list; written as hex,
  // so no character needs quoting.
  const line = `add-generic-password -U -a "${account}" -s "${service}" -X "${Buffer.from(text, 'utf8').toString('hex')}"\n`;
  return new Promise((resolve, reject) => {
    const p = spawn('security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => (code === 0 && !err.trim() ? resolve() : reject(new Error(err.trim() || `security exited with ${code}`))));
    p.stdin.end(line);
  });
}
function keychainDelete(service, account) {
  return new Promise(resolve => execFile('security', ['delete-generic-password', '-a', account, '-s', service], { timeout: 15000 }, () => resolve()));
}

async function readCredentials(config) {
  try {
    const text = isMac
      ? await keychainRead(keychainService(config), user())
      : fs.readFileSync(path.join(configDir(config).dir, '.credentials.json'), 'utf8');
    return text ? JSON.parse(text) : null;
  } catch { return null; }
}
async function writeCredentials(config, creds) {
  const text = JSON.stringify(creds);
  if (isMac) return keychainWrite(keychainService(config), user(), text);
  writePrivate(path.join(configDir(config).dir, '.credentials.json'), text);
}

// Write to a new file and rename it over the old one, so Claude Code never
// reads half a file.
function writePrivate(target, text, mode = 0o600) {
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, target);
}

function readGlobal(config) {
  try { return JSON.parse(fs.readFileSync(globalFile(config), 'utf8')); } catch { return null; }
}

// The saved accounts: [{ id, email, name, orgName, plan, account, savedAt,
// oauth? }]. oauth (the tokens) is only in the file on Windows and Linux.
function loadSaved() {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}
function storeSaved(list) {
  writePrivate(file, JSON.stringify(list, null, 2));
}
async function savedTokens(entry) {
  if (!isMac) return entry.oauth || null;
  const text = await keychainRead(SAVED_SERVICE, entry.id);
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

// The account Claude Code is signed in with now, with its tokens.
async function current(config) {
  const account = readGlobal(config)?.oauthAccount;
  const creds = await readCredentials(config);
  if (!account?.accountUuid || !creds?.claudeAiOauth?.refreshToken) return null;
  return { account, oauth: creds.claudeAiOauth };
}

// Saves (or updates) the account Claude Code is signed in with now.
async function remember(config) {
  const now = await current(config);
  if (!now) return null;
  const { account, oauth } = now;
  // Two organizations of one person are two accounts.
  const id = `${account.accountUuid}:${account.organizationUuid || ''}`;
  const entry = {
    id,
    email: account.emailAddress || '',
    name: account.displayName || account.fullName || '',
    orgName: account.organizationName || '',
    plan: oauth.subscriptionType || '',
    account,
    savedAt: Date.now(),
  };
  if (isMac) await keychainWrite(SAVED_SERVICE, id, JSON.stringify(oauth));
  else entry.oauth = oauth;
  const list = loadSaved().filter(a => a.id !== id);
  list.push(entry);
  storeSaved(list);
  return id;
}

// What Settings shows. A saved login whose refresh token has expired needs
// a new sign-in.
async function list(config) {
  const currentId = await remember(config).catch(() => null);
  const accounts = [];
  for (const a of loadSaved()) {
    const oauth = a.id === currentId ? null : await savedTokens(a);
    const expired = a.id !== currentId && (!oauth || (oauth.refreshTokenExpiresAt && oauth.refreshTokenExpiresAt < Date.now()));
    accounts.push({ id: a.id, email: a.email, name: a.name, orgName: a.orgName, plan: a.plan, current: a.id === currentId, expired: !!expired });
  }
  accounts.sort((a, b) => (b.current - a.current) || a.email.localeCompare(b.email) || a.orgName.localeCompare(b.orgName));
  return { accounts, signedIn: !!currentId };
}

async function switchTo(config, id) {
  const entry = loadSaved().find(a => a.id === id);
  if (!entry) throw new Error('That account is not saved any more.');
  const oauth = await savedTokens(entry);
  if (!oauth) throw new Error('Its login is not saved. Sign in with it again.');
  await remember(config).catch(() => {});
  const creds = (await readCredentials(config)) || {};
  creds.claudeAiOauth = oauth;
  await writeCredentials(config, creds);
  const global = readGlobal(config);
  if (global) {
    global.oauthAccount = entry.account;
    let mode = 0o600;
    try { mode = fs.statSync(globalFile(config)).mode & 0o777; } catch { /* a new file */ }
    writePrivate(globalFile(config), JSON.stringify(global, null, 2), mode);
  }
  return true;
}

async function forget(config, id) {
  const now = await current(config);
  const entry = loadSaved().find(a => a.id === id);
  if (!entry) return;
  if (now && `${now.account.accountUuid}:${now.account.organizationUuid || ''}` === id) throw new Error('You are signed in with this account. Switch to another one first.');
  if (isMac) await keychainDelete(SAVED_SERVICE, id);
  storeSaved(loadSaved().filter(a => a.id !== id));
}

module.exports = { setFile, list, remember, switchTo, forget };
