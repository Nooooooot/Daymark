const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('loginAPI', {
  getInitState() {
    return ipcRenderer.invoke('login-get-init-state');
  },
  startLogin(options) {
    return ipcRenderer.invoke('login-start', options || {});
  }
});
