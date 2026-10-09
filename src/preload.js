// The only functions the window can call. Everything else (files, processes)
// stays in the main process.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

function on(channel, fn) {
  const listener = (_e, ...args) => fn(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('deck', {
  platform: process.platform,   // 'darwin' on macOS, 'win32' on Windows
  getConfig: () => ipcRenderer.invoke('config:get'),
  openConfig: () => ipcRenderer.invoke('config:open'),
  appVersion: () => ipcRenderer.invoke('app:version'),
  fetchUsage: () => ipcRenderer.invoke('usage:fetch'),
  repoOf: cwd => ipcRenderer.invoke('repo:of', cwd),
  existingFiles: paths => ipcRenderer.invoke('fs:existing', paths),
  csNamespaces: paths => ipcRenderer.invoke('cs:namespaces', paths),
  getGroups: () => ipcRenderer.invoke('groups:get'),
  saveGroups: data => ipcRenderer.invoke('groups:save', data),
  popupMenu: items => ipcRenderer.invoke('menu:popup', items),
  gitSnapshot: cwd => ipcRenderer.invoke('git:snapshot', cwd),
  gitChanges: (cwd, snap) => ipcRenderer.invoke('git:changes', cwd, snap),
  activity: () => ipcRenderer.invoke('activity:get'),
  connectors: {
    list: cwd => ipcRenderer.invoke('connectors:list', cwd),
    cached: () => ipcRenderer.invoke('connectors:cached'),
    login: id => ipcRenderer.invoke('connectors:login', id),
    cancelLogin: id => ipcRenderer.invoke('connectors:cancelLogin', id),
    add: spec => ipcRenderer.invoke('connectors:add', spec),
    remove: spec => ipcRenderer.invoke('connectors:remove', spec),
  },
  jiraIssue: key => ipcRenderer.invoke('jira:issue', key),
  recentMedia: (cwd, sinceMs) => ipcRenderer.invoke('media:recent', cwd, sinceMs),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  loadTranscript: file => ipcRenderer.invoke('sessions:load', file),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  startAgent: opts => ipcRenderer.invoke('agent:start', opts),
  sendMessage: (id, text, images) => ipcRenderer.invoke('agent:send', id, text, images),
  // Where a dropped file is on disk (Electron no longer puts it on the File).
  pathForFile: file => { try { return webUtils.getPathForFile(file) || null; } catch { return null; } },
  setModel: (id, choice) => ipcRenderer.invoke('agent:setModel', id, choice),
  listModels: () => ipcRenderer.invoke('models:list'),
  respondPermission: (id, requestId, decision) => ipcRenderer.invoke('agent:respondPermission', id, requestId, decision),
  setPermissionMode: (id, mode) => ipcRenderer.invoke('agent:setPermissionMode', id, mode),
  interrupt: id => ipcRenderer.invoke('agent:interrupt', id),
  closeAgent: id => ipcRenderer.invoke('agent:close', id),
  setAttention: (count, badge) => ipcRenderer.invoke('attention', count, badge),
  contextUsage: id => ipcRenderer.invoke('agent:context', id),
  summarizeTitle: text => ipcRenderer.invoke('agent:title', text),
  notify: (id, title, body) => ipcRenderer.invoke('notify', id, title, body),
  onEvent: fn => on('agent:event', fn),
  onStatus: fn => on('agent:status', fn),
  onSession: fn => on('agent:session', fn),
  onModel: fn => on('agent:model', fn),
  onPermission: fn => on('agent:permission', fn),
  onPermissionCancel: fn => on('agent:permissionCancel', fn),
  onMode: fn => on('agent:mode', fn),
  onExit: fn => on('agent:exit', fn),
  onSessionsChanged: fn => on('sessions:changed', fn),
  onQuitting: fn => on('app:quitting', fn),
  onConfirmQuit: fn => on('app:confirmQuit', fn),
  quit: () => ipcRenderer.invoke('app:quit'),
  onNotificationOpen: fn => on('notification:open', fn),
});
