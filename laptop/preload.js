const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('simple', {
  isTest: process.argv.includes('--simple-test'),
  getState: () => ipcRenderer.invoke('get-state'),
  onState: (callback) => ipcRenderer.on('state', (_event, state) => callback(state)),
  onToast: (callback) => ipcRenderer.on('toast', (_event, text) => callback(text)),
  pickDropFolder: () => ipcRenderer.invoke('pick-drop-folder'),
  setDrop: (on) => ipcRenderer.invoke('set-drop', on),
  // Simple Drop: files dragged onto the window
  sendFiles: (files) => ipcRenderer.invoke('send-files', Array.from(files).map((f) => webUtils.getPathForFile(f))),
  newQr: () => ipcRenderer.invoke('new-qr'),
  unpair: () => ipcRenderer.invoke('unpair'),
  setClipboardSync: (on) => ipcRenderer.invoke('set-clipboard-sync', on),
});
