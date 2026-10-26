// The notification window's (toast.html) only ways to talk to the app.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('toastHost', {
  onAdd: fn => ipcRenderer.on('toast:add', (_e, item) => fn(item)),
  onClear: fn => ipcRenderer.on('toast:clear', () => fn()),
  size: (width, height) => ipcRenderer.send('toast:size', width, height),
  open: id => ipcRenderer.send('toast:open', id),
});
