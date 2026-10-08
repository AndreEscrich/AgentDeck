// Renders build/icon.html to build/icon.png (1024x1024, transparent) with
// Electron itself, so no image tools need to be installed.
// Run: npx electron scripts/render-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024, height: 1024, show: false, frame: false, transparent: true,
    webPreferences: { offscreen: true },
  });
  win.webContents.setZoomFactor(1);
  await win.loadFile(path.join(__dirname, '..', 'build', 'icon.html'));
  await new Promise(r => setTimeout(r, 500));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.writeFileSync(out, image.resize({ width: 1024, height: 1024 }).toPNG());
  console.log('wrote', out, image.getSize());
  app.exit(0);
});
