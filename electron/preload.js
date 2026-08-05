const { contextBridge, ipcRenderer } = require('electron');

const storageBackend = {
  getItem(key) {
    return ipcRenderer.sendSync('storage-get', key);
  },
  setItem(key, value) {
    ipcRenderer.sendSync('storage-set', key, value);
    ipcRenderer.send('data-changed');
  },
  removeItem(key) {
    ipcRenderer.sendSync('storage-remove', key);
    ipcRenderer.send('data-changed');
  },
  clear() {
    ipcRenderer.sendSync('storage-clear');
    ipcRenderer.send('data-changed');
  },
  get length() {
    return ipcRenderer.sendSync('storage-length');
  },
  key(index) {
    return ipcRenderer.sendSync('storage-key', index);
  }
};

contextBridge.exposeInMainWorld('electronAPI', {
  isDesktop: true,
  storage: storageBackend,
  getDesktopSettings() {
    return ipcRenderer.sendSync('get-desktop-settings');
  },
  setDesktopSettings(settings) {
    return ipcRenderer.sendSync('set-desktop-settings', settings);
  },
  openDataFolder() {
    ipcRenderer.send('open-data-folder');
  },
  testNotification() {
    ipcRenderer.send('test-notification');
  },
  onNavigateTab(callback) {
    ipcRenderer.on('navigate-tab', (_event, tab) => callback(tab));
  },
  getAuthState() {
    return ipcRenderer.invoke('auth-get-state');
  },
  setAutoLogin(enabled) {
    return ipcRenderer.invoke('auth-set-auto-login', enabled);
  },
  logout() {
    return ipcRenderer.invoke('auth-logout');
  },
  syncNow() {
    return ipcRenderer.invoke('sync-now');
  },
  onAuthStateChanged(callback) {
    ipcRenderer.on('auth-state-changed', (_event, state) => callback(state));
  },
  importDataFile() {
    return ipcRenderer.invoke('import-data-file');
  },
  getAppVersion() {
    return ipcRenderer.invoke('app-get-version');
  },
  checkForUpdates() {
    return ipcRenderer.invoke('app-check-updates');
  }
});
