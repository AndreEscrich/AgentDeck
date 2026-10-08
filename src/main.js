const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const { AgentManager, fetchModels, summarizeTitle } = require('./agents');
const { listSessions, loadTranscript, PROJECTS_DIR } = require('./sessions');
const git = require('./git');
const { repoOf } = require('./repos');

// Settings you can edit by hand. The app writes this file with the defaults
// the first time it starts; use "Settings" in the sidebar to open it.
const DEFAULT_CONFIG = {
  claudePath: '',                       // empty means: look in the usual install folders
  defaultPermissionMode: 'bypassPermissions', // default | acceptEdits | auto | plan | bypassPermissions
  defaultModel: 'opus',                 // a value from the model menu; "opus" is always the latest Opus
  defaultEffort: 'medium',              // low | medium | high | xhigh | max; empty means the model's default
  defaultFastMode: false,
  defaultFolder: '',
  extraArgs: [],                        // extra command-line flags for every agent
  env: {},                              // extra environment variables for every agent
  notifyWhenDone: true,
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
    backgroundColor: '#16171d',
    // The top bar is part of the page. macOS keeps its window buttons at the
    // top left; on Windows the minimize, maximize and close buttons are drawn
    // at the top right in the app's colors.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' }
      : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#16171d', symbolColor: '#e6e6ea', height: 52 } }),
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
if (process.platform === 'win32') app.setAppUserModelId('com.agentdeck.app');

app.whenReady().then(() => {
  // Shows the Agent Hub icon in the Dock also when you run `npm start`.
  if (app.dock) app.dock.setIcon(path.join(__dirname, '..', 'build', 'icon.png'));
  configPath = path.join(app.getPath('userData'), 'config.json');
  groupsPath = path.join(app.getPath('userData'), 'groups.json');
  if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));

  ipcMain.handle('config:get', () => ({ ...getConfig(), home: require('os').homedir() }));
  ipcMain.handle('config:open', () => shell.openPath(configPath));
  ipcMain.handle('sessions:list', () => listSessions());
  ipcMain.handle('git:snapshot', (_e, cwd) => git.snapshot(cwd, path.join(app.getPath('userData'), 'snapshots')));
  ipcMain.handle('git:changes', (_e, cwd, snap) => git.changesSince(cwd, snap));
  ipcMain.handle('repo:of', (_e, cwd) => repoOf(cwd));
  ipcMain.handle('groups:get', () => readGroups());
  ipcMain.handle('groups:save', (_e, data) => fs.writeFileSync(groupsPath, JSON.stringify(data, null, 2)));
  ipcMain.handle('menu:popup', (_e, items) => popupMenu(items));
  ipcMain.handle('sessions:load', (_e, file) => loadTranscript(file));
  ipcMain.handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('agent:start', (_e, opts) => agents.start(opts));
  ipcMain.handle('agent:send', (_e, id, text) => agents.sendMessage(id, text));
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
  // The number of agents that wait for you, as a red badge on the Dock icon.
  // The icon bounces once when one more starts waiting while you are elsewhere.
  let attention = 0;
  ipcMain.handle('attention', (_e, count) => {
    if (process.platform === 'darwin' && app.dock) {
      app.setBadgeCount(count);
      if (count > attention && !win.isFocused()) app.dock.bounce('informational');
    }
    attention = count;
  });
  ipcMain.handle('agent:context', (_e, id) => agents.contextUsage(id));
  ipcMain.handle('agent:title', (_e, text) => (getConfig().summarizeTitles ? summarizeTitle(getConfig(), text) : null));
  ipcMain.handle('notify', (_e, title, body) => {
    if (getConfig().notifyWhenDone && !win.isFocused()) {
      const n = new Notification({ title, body });
      n.on('click', () => win.show());
      n.show();
    }
  });

  createWindow();
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
  const choice = dialog.showMessageBoxSync(win, {
    type: 'warning',
    buttons: ['Quit', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: busy === 1 ? '1 agent is still working' : `${busy} agents are still working`,
    detail: 'Quitting stops them now. They continue where they stopped the next time you open the app.',
  });
  if (choice === 0) {
    quitConfirmed = true;
    win.webContents.send('app:quitting');
    setTimeout(() => app.quit(), 300);
  }
  return false;
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
