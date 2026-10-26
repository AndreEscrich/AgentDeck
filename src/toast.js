// The app's own notifications: the agent's Hub tile, liquid and all, in a
// small window in the corner of the screen, above everything, while the app
// is in the background (Settings → Notifications). Windows' notifications
// cannot look like that: Windows draws them itself.
//
// One window holds them all (toast.html), sized to fit them: up to four stand
// side by side, the newest on the right. A click opens the agent; each goes
// by itself after a while (one that needs you stays longer).

const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

let win = null;
let ready = null;
let open = () => {};

function ensure() {
  if (win && !win.isDestroyed()) return ready;
  win = new BrowserWindow({
    width: 10,
    height: 10,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Showing one never takes the keyboard from what you are typing in.
    focusable: false,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'toast-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  ready = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  win.loadFile(path.join(__dirname, 'renderer', 'toast.html'));
  win.on('closed', () => { win = null; });
  return ready;
}

// The page tells how much room its tiles take; the window takes exactly that,
// in the bottom right corner of the main screen, above the taskbar.
function fit(width, height) {
  if (!win || win.isDestroyed()) return;
  if (!width || !height) {
    win.hide();
    return;
  }
  const area = screen.getPrimaryDisplay().workArea;
  const w = Math.min(Math.ceil(width), area.width);
  const h = Math.min(Math.ceil(height), area.height);
  win.setBounds({ x: area.x + area.width - w, y: area.y + area.height - h, width: w, height: h });
  if (!win.isVisible()) win.showInactive();
}

// onOpen(id): a click on an agent's tile.
function init({ onOpen }) {
  open = onOpen;
  const ours = e => win && !win.isDestroyed() && e.sender === win.webContents;
  ipcMain.on('toast:size', (e, width, height) => { if (ours(e)) fit(width, height); });
  ipcMain.on('toast:open', (e, id) => { if (ours(e)) open(id); });
}

// item: { id, title, body, tile (the tile's HTML), theme }
async function show(item) {
  await ensure();
  if (win && !win.isDestroyed()) win.webContents.send('toast:add', item);
}

// Back in the app: the Hub shows the same, so the corner empties.
function clear() {
  if (win && !win.isDestroyed()) win.webContents.send('toast:clear');
}

function destroy() {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}

module.exports = { init, show, clear, destroy };
