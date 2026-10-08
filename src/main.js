const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const fs = require('fs');
const path = require('path');
const { AgentManager, fetchModels } = require('./agents');
const { listSessions, loadTranscript, PROJECTS_DIR } = require('./sessions');

// Settings you can edit by hand. The app writes this file with the defaults
// the first time it starts; use "Settings" in the sidebar to open it.
const DEFAULT_CONFIG = {
  claudePath: '',                       // empty means: look in the usual install folders
  defaultPermissionMode: 'acceptEdits', // default | acceptEdits | plan | bypassPermissions
  defaultModel: 'default',              // a value from the model menu, e.g. "opus[1m]" or "sonnet"
  defaultEffort: '',                    // low | medium | high | xhigh | max; empty means the model's default
  defaultFastMode: false,
  defaultFolder: '',
  extraArgs: [],                        // extra command-line flags for every agent
  env: {},                              // extra environment variables for every agent
  notifyWhenDone: true,
};

let win;
let configPath;

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
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#16171d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
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

app.whenReady().then(() => {
  configPath = path.join(app.getPath('userData'), 'config.json');
  if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));

  ipcMain.handle('config:get', () => getConfig());
  ipcMain.handle('config:open', () => shell.openPath(configPath));
  ipcMain.handle('sessions:list', () => listSessions());
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
  ipcMain.handle('agent:interrupt', (_e, id) => agents.interrupt(id));
  ipcMain.handle('agent:close', (_e, id) => agents.close(id));
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

app.on('before-quit', () => agents.closeAll());
app.on('window-all-closed', () => {
  agents.closeAll();
  if (process.platform !== 'darwin') app.quit();
});
