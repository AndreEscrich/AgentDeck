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
  const icon = image.resize({ width: 1024, height: 1024 });
  fs.writeFileSync(out, icon.toPNG());
  console.log('wrote', out, image.getSize());

  // Windows uses an .ico file: a list of the same picture in several sizes.
  // Each size is stored as PNG data, which Windows supports since Vista.
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = sizes.map(size => icon.resize({ width: size, height: size, quality: 'best' }).toPNG());
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0);             // reserved
  header.writeUInt16LE(1, 2);             // 1 = icon
  header.writeUInt16LE(sizes.length, 4);  // number of pictures
  let offset = header.length;
  sizes.forEach((size, i) => {
    const entry = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, entry);     // width (0 means 256)
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1); // height
    header.writeUInt16LE(1, entry + 4);                   // color planes
    header.writeUInt16LE(32, entry + 6);                  // bits per pixel
    header.writeUInt32LE(pngs[i].length, entry + 8);      // size of the data
    header.writeUInt32LE(offset, entry + 12);             // where the data starts
    offset += pngs[i].length;
  });
  const ico = path.join(__dirname, '..', 'build', 'icon.ico');
  fs.writeFileSync(ico, Buffer.concat([header, ...pngs]));
  console.log('wrote', ico);
  app.exit(0);
});
