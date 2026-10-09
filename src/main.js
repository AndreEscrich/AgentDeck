const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Menu, protocol, net, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { AgentManager, fetchModels, summarizeTitle, fetchUsage } = require('./agents');
const { listSessions, loadTranscript, PROJECTS_DIR } = require('./sessions');
const git = require('./git');
const { repoOf } = require('./repos');
const media = require('./media');
const jira = require('./jira');
const connectors = require('./connectors');
const { activity } = require('./activity');
const updates = require('./updates');
const undo = require('./undo');
const csharp = require('./csharp');

// The window loads images and videos from disk through media:// (see media.js).
// "stream" lets video players read a file piece by piece.
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// Settings you can edit by hand. The app writes this file with the defaults
// the first time it starts; use "Settings" in the sidebar to open it.
const DEFAULT_CONFIG = {
  claudePath: '',                       // empty means: look in the usual install folders
  defaultPermissionMode: 'bypassPermissions', // default | acceptEdits | auto | plan | bypassPermissions
  defaultModel: 'opus',                 // a value from the model menu; "opus" is always the latest Opus
  defaultEffort: 'medium',              // low | medium | high | xhigh | max; empty means the model's default
  defaultFastMode: false,
  stuckAfterSeconds: 30,                // waiting this long for Unity to be ready marks the agent as stuck
  defaultFolder: '',
  extraArgs: [],                        // extra command-line flags for every agent
  env: {},                              // extra environment variables for every agent
  notifyWhenDone: true,
  sounds: true,                         // a sound when you start an agent and when one finishes
  hubAfterSend: true,                   // show the Hub after you send a message
  summarizeTitles: true,                // title new agents with a short summary of your message
};

let win;
let configPath;
let groupsPath;

// Your session groups: { groups: [{ id, name, collapsed }], assignments: { sessionId: groupId } }.
function readGroups() {
  try {
    return JSON.parse(fs.readFileSync(groupsPath, 'utf8'));
  } catch {
    return { groups: [], assignments: {} };
  }
}

// Shows a native right-click menu and resolves with the id of the item you
// picked, or null when you close the menu without picking anything.
function popupMenu(items) {
  return new Promise(resolve => {
    let done = false;
    const pick = id => { if (!done) { done = true; resolve(id); } };
    const build = list => list.map(item => item.type === 'separator' ? { type: 'separator' } : {
      label: item.label,
      enabled: item.enabled !== false,
      type: item.checked != null ? 'checkbox' : 'normal',
      checked: !!item.checked,
      submenu: item.submenu ? build(item.submenu) : undefined,
      click: item.submenu ? undefined : () => pick(item.id),
    });
    Menu.buildFromTemplate(build(items)).popup({ window: win, callback: () => setTimeout(() => pick(null), 100) });
  });
}

function getConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// The version shown in the top bar. The stable copy (on master) shows the
// version from package.json. The dev copy shows master's major.minor version
// and, as the patch number, how many commits it is ahead of master, so
// 0.3.4 dev is master 0.3.x plus four commits.
function appVersion() {
  const dir = app.getAppPath();
  const run = args => new Promise(resolve => {
    execFile('git', ['-C', dir, ...args], { timeout: 10000 }, (err, out) => resolve(err ? null : out.trim()));
  });
  const stable = { version: app.getVersion(), dev: false };
  return (async () => {
    const branch = await run(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!branch || branch === 'master') return stable;
    const pkg = await run(['show', 'master:package.json']);
    const ahead = await run(['rev-list', '--count', 'master..HEAD']);
    if (!pkg || ahead == null) return stable;
    try {
      const [major, minor] = JSON.parse(pkg).version.split('.');
      return { version: `${major}.${minor}.${ahead}`, dev: true };
    } catch {
      return stable;
    }
  })();
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

const agents = new AgentManager({ send, getConfig });

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 480,
    backgroundColor: '#1f1913',
    // The top bar is part of the page. macOS keeps its window buttons at the
    // top left; on Windows the minimize, maximize and close buttons are drawn
    // at the top right in the app's colors.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' }
      : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#1f1913', symbolColor: '#f1e7dc', height: 52 } }),
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Windows would show a File/Edit/View menu whose shortcuts (Ctrl+0, Ctrl+R)
  // clash with the app's own. Copy and paste keep working without it.
  if (process.platform !== 'darwin') win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Closing the window with busy agents asks first, then quits the app.
  win.on('close', event => allowStop(event));
  // The taskbar button stops flashing when you come back.
  win.on('focus', () => win.flashFrame(false));
  // Links in agent replies open in the normal browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Tell the window to reload the sidebar when Claude Code writes a session file,
// including sessions you run in the terminal or another app.
function watchSessions() {
  if (!fs.existsSync(PROJECTS_DIR)) return;
  let timer = null;
  try {
    fs.watch(PROJECTS_DIR, { recursive: true }, (_event, file) => {
      if (!file || !file.endsWith('.jsonl')) return;
      clearTimeout(timer);
      timer = setTimeout(() => send('sessions:changed'), 1500);
    });
  } catch { /* watching is a convenience; the refresh button still works */ }
}

// The app is called Agent Hub, but its settings (config.json, groups.json,
// snapshots, the Hub's saved agents) stay in the folder from when it was
// called AgentDeck. Electron would otherwise pick a folder named after the app.
// Tests set AGENTDECK_USER_DATA to a folder of their own, so they never
// touch your real settings, groups and Hub.
app.setPath('userData', process.env.AGENTDECK_USER_DATA || path.join(app.getPath('appData'), 'agentdeck'));

// Windows groups taskbar buttons and shows notifications by this id. It keeps
// the old name, so Windows treats the renamed app as the same app.
const APP_ID = 'com.agentdeck.app';
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

// Windows shows notifications only for an app id that a Start Menu shortcut
// carries. Gives the Agent Hub shortcut that id, or makes the shortcut (for
// this copy) when there is none; `npm run make-app` in the stable copy points
// it there again.
function registerForNotifications() {
  if (process.platform !== 'win32') return;
  const link = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Agent Hub.lnk');
  try {
    if (fs.existsSync(link)) {
      if (shell.readShortcutLink(link).appUserModelId !== APP_ID) {
        shell.writeShortcutLink(link, 'update', { appUserModelId: APP_ID });
      }
    } else {
      shell.writeShortcutLink(link, 'create', {
        target: process.execPath,
        args: `"${app.getAppPath()}"`,
        cwd: app.getAppPath(),
        icon: path.join(__dirname, '..', 'build', 'icon.ico'),
        iconIndex: 0,
        description: 'Agent Hub',
        appUserModelId: APP_ID,
      });
    }
  } catch { /* without it there are no notifications, but everything else works */ }
}

app.whenReady().then(() => {
  media.registerProtocol(protocol, net, path.join(app.getPath('userData'), 'media-previews'));
  ipcMain.handle('media:recent', (_e, cwd, sinceMs) => media.recentMedia(cwd, sinceMs));
  ipcMain.handle('jira:issue', (_e, key) => jira.issue(key));
  ipcMain.handle('jira:details', (_e, key) => jira.details(key));
  ipcMain.handle('jira:comment', (_e, key, body) => jira.comment(key, body));
  ipcMain.handle('activity:get', () => activity(path.join(app.getPath('userData'), 'activity-cache.json')));
  ipcMain.handle('connectors:list', (_e, cwd) => connectors.list(getConfig(), cwd));
  ipcMain.handle('connectors:cached', () => connectors.cached());
  ipcMain.handle('connectors:login', (_e, id) => connectors.login(getConfig(), id));
  ipcMain.handle('connectors:cancelLogin', (_e, id) => connectors.cancelLogin(id));
  ipcMain.handle('connectors:add', (_e, spec) => connectors.add(getConfig(), spec));
  ipcMain.handle('connectors:remove', (_e, spec) => connectors.remove(getConfig(), spec));
  // Shows the Agent Hub icon in the Dock also when you run `npm start`.
  if (app.dock) app.dock.setIcon(path.join(__dirname, '..', 'build', 'icon.png'));
  configPath = path.join(app.getPath('userData'), 'config.json');
  groupsPath = path.join(app.getPath('userData'), 'groups.json');
  if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));

  ipcMain.handle('config:get', () => ({ ...getConfig(), home: require('os').homedir() }));
  ipcMain.handle('config:open', () => shell.openPath(configPath));
  // The Settings screen: its values replace those in config.json; settings
  // it does not show (added by hand) stay.
  ipcMain.handle('config:save', (_e, values) => {
    let current = {};
    try { current = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { /* start from the defaults */ }
    const next = { ...DEFAULT_CONFIG, ...current };
    for (const [key, value] of Object.entries(values || {})) {
      if (key in DEFAULT_CONFIG && typeof value === typeof DEFAULT_CONFIG[key] && Array.isArray(value) === Array.isArray(DEFAULT_CONFIG[key])) next[key] = value;
    }
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2));
    return { ...getConfig(), home: require('os').homedir() };
  });
  ipcMain.handle('app:quit', () => quitNow());
  ipcMain.handle('usage:fetch', () => fetchUsage(getConfig()));
  ipcMain.handle('app:version', () => appVersion());
  ipcMain.handle('update:latest', () => latestUpdate);
  ipcMain.handle('app:changelog', () => updates.changelog(app.getAppPath()));
  ipcMain.handle('update:apply', () => applyUpdate());
  ipcMain.handle('sessions:list', () => listSessions());
  ipcMain.handle('git:snapshot', (_e, cwd) => git.snapshot(cwd, path.join(app.getPath('userData'), 'snapshots')));
  ipcMain.handle('git:changes', (_e, cwd, snap) => git.changesSince(cwd, snap));
  ipcMain.handle('files:undo', (_e, cwd, file) => undo.undoFile(cwd, file));
  ipcMain.handle('files:versions', (_e, cwd, file) => undo.versions(cwd, file));
  ipcMain.handle('files:restore', (_e, cwd, p, previous) => undo.restoreFile(cwd, p, previous));
  ipcMain.handle('repo:of', (_e, cwd) => repoOf(cwd));
  // Which of these files still exist (for the Changes card).
  ipcMain.handle('fs:existing', (_e, paths) => (Array.isArray(paths) ? paths : []).filter(p => typeof p === 'string' && fs.existsSync(p)));
  // The namespace of C# files, for their titles in the Changes card: the
  // first "namespace X" line in the first 256 KB, or null.
  ipcMain.handle('cs:model', (_e, cwd, files) => csharp.model(cwd, files));
  // A file the diagram shows but the task did not change: open it in your editor.
  ipcMain.handle('file:open', (_e, p) => (typeof p === 'string' && fs.existsSync(p) ? shell.openPath(p) : 'Not found'));
  ipcMain.handle('cs:namespaces',(_e, paths) => Promise.all((Array.isArray(paths) ? paths : []).slice(0, 500).map(async p => {
    if (typeof p !== 'string' || !/\.cs$/i.test(p)) return null;
    try {
      const handle = await fs.promises.open(p, 'r');
      try {
        const { buffer, bytesRead } = await handle.read(Buffer.alloc(256 * 1024), 0, 256 * 1024, 0);
        return /^[ \t]*namespace[ \t]+([A-Za-z_][\w.]*)/m.exec(buffer.toString('utf8', 0, bytesRead))?.[1] || null;
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  })));
  ipcMain.handle('groups:get', () => readGroups());
  ipcMain.handle('groups:save', (_e, data) => fs.writeFileSync(groupsPath, JSON.stringify(data, null, 2)));
  ipcMain.handle('menu:popup', (_e, items) => popupMenu(items));
  ipcMain.handle('sessions:load', (_e, file) => loadTranscript(file));
  ipcMain.handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('agent:start', (_e, opts) => agents.start(opts));
  ipcMain.handle('agent:send', (_e, id, text, images) => agents.sendMessage(id, text, images));
  ipcMain.handle('agent:setModel', (_e, id, choice) => agents.setModel(id, choice));
  let models = null;
  ipcMain.handle('models:list', async () => {
    if (!models) models = await fetchModels(getConfig());
    return models;
  });
  ipcMain.handle('agent:respondPermission', (_e, id, requestId, decision) => agents.respondPermission(id, requestId, decision));
  ipcMain.handle('agent:setPermissionMode', (_e, id, mode) => agents.setPermissionMode(id, mode));
  ipcMain.handle('agent:interrupt', (_e, id) => agents.interrupt(id));
  ipcMain.handle('agent:close', (_e, id) => agents.close(id));
  // The number of agents that wait for you, as a red badge on the Dock icon
  // (on Windows, on the taskbar button; the window draws that badge). The icon
  // bounces once (on Windows, the taskbar button flashes) when one more starts
  // waiting while you are elsewhere.
  let attention = 0;
  ipcMain.handle('attention', (_e, count, badge) => {
    if (process.platform === 'darwin' && app.dock) {
      app.setBadgeCount(count);
      if (count > attention && !win.isFocused()) app.dock.bounce('informational');
    } else {
      const image = count && badge ? nativeImage.createFromDataURL(badge) : null;
      win.setOverlayIcon(image, count ? `${count} waiting for you` : '');
      if (count > attention && !win.isFocused()) win.flashFrame(true);
    }
    attention = count;
  });
  ipcMain.handle('agent:context', (_e, id) => agents.contextUsage(id));
  ipcMain.handle('agent:title', (_e, text) => (getConfig().summarizeTitles ? summarizeTitle(getConfig(), text) : null));
  // Clicking a notification opens its agent. The app keeps each notification
  // until it closes, or Windows would forget the click handler.
  const shown = new Set();
  ipcMain.handle('notify', (_e, id, title, body) => {
    if (getConfig().notifyWhenDone && !win.isFocused()) {
      // The app plays its own sounds, so the notification stays silent then.
      const n = new Notification({ title, body, silent: getConfig().sounds !== false });
      shown.add(n);
      n.on('click', () => {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        send('notification:open', id);
      });
      n.on('close', () => shown.delete(n));
      n.show();
    }
  });

  registerForNotifications();
  createWindow();
  watchForUpdates();
  watchSessions();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// Quitting (or closing the window) stops the agents. When some are still
// busy, the app asks first. If you quit anyway, the window first saves which
// agents were busy, so they continue the next time the app opens.
let quitConfirmed = false;
function allowStop(event) {
  const busy = agents.activeCount();
  if (quitConfirmed || !busy || !win || win.isDestroyed()) return true;
  event.preventDefault();
  // The window asks, in the app itself (see confirmQuit in app.js). If the
  // window cannot answer (it crashed), the system dialog asks instead.
  if (win.webContents.isCrashed()) {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Quit', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: busy === 1 ? '1 agent is still working' : `${busy} agents are still working`,
      detail: 'Quitting stops them now. They continue where they stopped the next time you open the app.',
    });
    if (choice === 0) quitNow();
    return false;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  send('app:confirmQuit');
  return false;
}

// The stable copy looks for a new version on GitHub a little after it
// opens, then every 30 minutes, and tells the window when there is one.
let latestUpdate = null;
function watchForUpdates() {
  const look = async () => {
    const found = await updates.check(app.getAppPath());
    if (JSON.stringify(found) === JSON.stringify(latestUpdate)) return;
    latestUpdate = found;
    send('update:available', found);
  };
  setTimeout(look, 15 * 1000);
  setInterval(look, 30 * 60 * 1000);
}

// Moves the stable copy to the new version and restarts the app. The window
// has already asked about busy agents; like quitting, they continue after
// the restart. When the new version needs other packages, a separate shell
// installs them after the app has quit, then opens it again.
async function applyUpdate() {
  const result = await updates.apply(app.getAppPath());
  if (!result.ok) return result;
  if (result.packagesChanged) updates.installAndRelaunch(app.getAppPath(), result);
  else app.relaunch({ args: [app.getAppPath()] });
  quitNow();
  return result;
}


// The agents' state is saved by the window (app:quitting), then the app quits.
function quitNow() {
  quitConfirmed = true;
  send('app:quitting');
  setTimeout(() => app.quit(), 300);
}

app.on('before-quit', event => {
  if (allowStop(event)) agents.closeAll();
});
// Quit normally (and stop the agents) also when the app is stopped with
// Ctrl-C in the terminal that runs `npm start`.
process.on('SIGINT', () => app.quit());
app.on('window-all-closed', () => {
  agents.closeAll();
  if (process.platform !== 'darwin') app.quit();
});
