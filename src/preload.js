// The only functions the window can call. Everything else (files, processes)
// stays in the main process.

const { contextBridge, ipcRenderer } = require('electron');

function on(channel, fn) {
  const listener = (_e, ...args) => fn(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('deck', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  openConfig: () => ipcRenderer.invoke('config:open'),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  loadTranscript: file => ipcRenderer.invoke('sessions:load', file),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  startAgent: opts => ipcRenderer.invoke('agent:start', opts),
  sendMessage: (id, text) => ipcRenderer.invoke('agent:send', id, text),
  interrupt: id => ipcRenderer.invoke('agent:interrupt', id),
  closeAgent: id => ipcRenderer.invoke('agent:close', id),
  notify: (title, body) => ipcRenderer.invoke('notify', title, body),
  onEvent: fn => on('agent:event', fn),
  onStatus: fn => on('agent:status', fn),
  onSession: fn => on('agent:session', fn),
  onExit: fn => on('agent:exit', fn),
  onSessionsChanged: fn => on('sessions:changed', fn),
});
