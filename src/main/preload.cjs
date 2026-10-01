const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('instagramManager', {
  invoke: (name, ...args) => ipcRenderer.invoke(name, ...args),
  onTrayAction: callback => ipcRenderer.on('tray-action', (_event, action) => callback(action)),
  onUpdateStatus: callback => ipcRenderer.on('updates:status', (_event, status) => callback(status))
});
