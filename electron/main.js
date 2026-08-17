const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  shell,
  dialog
} = require('electron');
const fs = require('fs');
const path = require('path');
const { AppStorage } = require('./storage');
const { NotificationScheduler } = require('./notifications');
const { GoogleAuthManager } = require('./google-auth');
const { GoogleDriveSync } = require('./google-drive-sync');
const { setupAutoUpdater, getUpdaterApi } = require('./updater');

let mainWindow = null;
let loginWindow = null;
let tray = null;
let storage = null;
let authManager = null;
let driveSync = null;
let notificationScheduler = null;
let isQuitting = false;
let isAuthenticated = false;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (isAuthenticated) showMainWindow();
    else showLoginWindow();
  });
}

if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-features', 'OverlayScrollbars,WindowsOverlayScrollbars');
}

function getAssetPath(...parts) {
  return path.join(__dirname, '..', 'assets', ...parts);
}

function getDialogParent() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  if (loginWindow && !loginWindow.isDestroyed()) return loginWindow;
  return null;
}

function getAppIconCandidates() {
  const candidates = [];
  if (process.platform === 'win32') {
    // Packaged install: prefer loose file outside asar (Windows + nativeImage are flaky with .ico inside asar)
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, 'icon.ico'));
      candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'icon.ico'));
    }
    candidates.push(getAssetPath('icon.ico'));
  }
  candidates.push(getAssetPath('icon.png'));
  return candidates;
}

function getAppIconPath() {
  for (const candidate of getAppIconCandidates()) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore unreadable paths
    }
  }
  return getAssetPath('icon.png');
}

function loadAppIcon() {
  for (const candidate of getAppIconCandidates()) {
    try {
      if (!candidate || !fs.existsSync(candidate)) continue;
      // Windows .ico: createFromPath handles multi-size; createFromBuffer often fails for ico
      let image = nativeImage.createFromPath(candidate);
      if (image.isEmpty() && !/\.ico$/i.test(candidate)) {
        image = nativeImage.createFromBuffer(fs.readFileSync(candidate));
      }
      // Icons inside asar can fail with createFromPath — copy to temp and reload
      if (image.isEmpty() && candidate.includes('app.asar')) {
        const tmp = path.join(app.getPath('temp'), 'daymark-app-icon' + path.extname(candidate));
        fs.copyFileSync(candidate, tmp);
        image = nativeImage.createFromPath(tmp);
      }
      if (!image.isEmpty()) return image;
    } catch {
      // try next candidate
    }
  }
  return nativeImage.createEmpty();
}

function loadTrayIcon() {
  const image = loadAppIcon();
  if (image.isEmpty()) return image;
  return image.resize({ width: 32, height: 32, quality: 'best' });
}

function applyAutoLaunch(enabled) {
  app.setLoginItemSettings({
    openAtLogin: !!enabled,
    path: process.execPath,
    args: process.platform === 'win32' ? ['--hidden'] : []
  });
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function showLoginWindow() {
  if (loginWindow) {
    loginWindow.show();
    loginWindow.focus();
    return;
  }
  loginWindow = new BrowserWindow({
    width: 480,
    height: 560,
    resizable: false,
    maximizable: false,
    minimizable: true,
    autoHideMenuBar: true,
    title: 'Daymark · 로그인',
    icon: loadAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'login-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  loginWindow.loadFile(path.join(__dirname, '..', 'src', 'login.html'));
  loginWindow.on('closed', () => {
    loginWindow = null;
    if (!isAuthenticated && !isQuitting && !tray) {
      app.quit();
    } else if (!isAuthenticated && !isQuitting) {
      // 로그인 창만 닫힌 경우 트레이에서 다시 열 수 있도록 유지
    }
  });
}

function createMainWindow() {
  if (mainWindow) return;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'Daymark',
    icon: loadAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'task-app.html'));

  mainWindow.once('ready-to-show', () => {
    const hiddenLaunch = process.argv.includes('--hidden');
    if (!hiddenLaunch) mainWindow.show();
    mainWindow.webContents.send('auth-state-changed', getAuthStatePayload());
  });

  mainWindow.on('close', (event) => {
    const settings = storage.getDesktopSettings();
    if (!isQuitting && settings.minimizeToTray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.on('focus', () => {
    if (isAuthenticated) {
      driveSync.pullAndMerge().catch((err) => {
        console.error('Focus pull failed:', err.message);
      });
    }
  });
}

function getAuthStatePayload() {
  const session = authManager?.getSession();
  const syncStatus = driveSync?.getStatus() || {};
  return {
    isAuthenticated: !!session,
    email: session?.email || null,
    autoLogin: session?.autoLogin !== false,
    sync: syncStatus
  };
}

async function enterAuthenticatedApp({ showWindow = true } = {}) {
  isAuthenticated = true;
  if (loginWindow) {
    loginWindow.close();
    loginWindow = null;
  }
  if (!mainWindow) createMainWindow();
  if (showWindow) showMainWindow();
  refreshTrayMenu();
  mainWindow?.webContents.send('auth-state-changed', getAuthStatePayload());
  driveSync.startBackgroundSync();
}

async function bootstrapAuth() {
  if (!authManager.isConfigured()) return false;
  const session = await authManager.restoreSession();
  if (!session) return false;

  try {
    await driveSync.pullAndMerge();
    driveSync.onStorageReload = () => {
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('sync-data-changed');
      }
    };
    driveSync.onSyncStatusChanged = () => {
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('auth-state-changed', getAuthStatePayload());
      }
    };
    await enterAuthenticatedApp({ showWindow: !process.argv.includes('--hidden') });
    return true;
  } catch (err) {
    console.error('Sync on startup failed:', err.message);
    await enterAuthenticatedApp({ showWindow: !process.argv.includes('--hidden') });
    return true;
  }
}

function buildTrayMenu() {
  const settings = storage.getDesktopSettings();
  const session = authManager?.getSession();
  const syncStatus = driveSync?.getStatus();

  const menu = [
    {
      label: '앱 열기',
      click: () => {
        if (isAuthenticated) showMainWindow();
        else showLoginWindow();
      }
    }
  ];

  if (isAuthenticated) {
    menu.push({
      label: '오늘 할 일',
      click: () => {
        showMainWindow();
        mainWindow?.webContents.send('navigate-tab', 'today');
      }
    });
  }

  menu.push({ type: 'separator' });

  if (session?.email) {
    menu.push({ label: `Google: ${session.email}`, enabled: false });
    menu.push({
      label: '지금 동기화',
      click: async () => {
        try {
          await driveSync.syncNow();
        } catch (err) {
          console.error('Manual sync failed:', err);
        }
      }
    });
    menu.push({
      label: '로그아웃',
      click: async () => {
        await handleLogout();
      }
    });
    menu.push({ type: 'separator' });
  }

  menu.push(
    {
      label: 'Windows 시작 시 실행',
      type: 'checkbox',
      checked: settings.autoLaunch,
      click: (menuItem) => {
        const next = storage.setDesktopSettings({ autoLaunch: menuItem.checked });
        applyAutoLaunch(next.autoLaunch);
      }
    },
    {
      label: '알림 받기',
      type: 'checkbox',
      checked: settings.notificationsEnabled,
      click: (menuItem) => {
        storage.setDesktopSettings({ notificationsEnabled: menuItem.checked });
      }
    },
    {
      label: '종료 시 트레이로 최소화',
      type: 'checkbox',
      checked: settings.minimizeToTray,
      click: (menuItem) => {
        storage.setDesktopSettings({ minimizeToTray: menuItem.checked });
      }
    },
    { type: 'separator' },
    { type: 'separator' },
    {
      label: '업데이트 확인',
      click: async () => {
        const result = await getUpdaterApi().checkForUpdates();
        if (result.status === 'available') return;
        dialog.showMessageBox(getDialogParent(), {
          type: result.ok ? 'info' : 'warning',
          title: 'Daymark 업데이트',
          message: result.message,
          buttons: ['확인'],
          noLink: true
        });
      }
    },
    {
      label: '데이터 폴더 열기',
      click: () => shell.openPath(storage.getDataDir())
    },
    { type: 'separator' },
    {
      label: '종료',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  );

  if (syncStatus?.lastSyncError) {
    menu.splice(3, 0, {
      label: `동기화 오류: ${syncStatus.lastSyncError}`.slice(0, 60),
      enabled: false
    });
  }

  return Menu.buildFromTemplate(menu);
}

function createTray() {
  tray = new Tray(loadTrayIcon());
  tray.setToolTip('Daymark');
  tray.setContextMenu(buildTrayMenu());
  setupAutoUpdater(tray);
  tray.on('double-click', () => {
    if (isAuthenticated) showMainWindow();
    else showLoginWindow();
  });
  tray.on('click', () => {
    if (isAuthenticated) showMainWindow();
    else showLoginWindow();
  });
}

function refreshTrayMenu() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

async function handleLogout() {
  try {
    isAuthenticated = false;
    driveSync.stopBackgroundSync();
    authManager.logout();
    if (mainWindow) {
      mainWindow.close();
      mainWindow = null;
    }
    refreshTrayMenu();
    showLoginWindow();
  } catch (err) {
    console.error('Logout failed:', err);
  }
}

function registerIpcHandlers() {
  ipcMain.on('storage-get', (event, key) => {
    event.returnValue = storage.getItem(key);
  });
  ipcMain.on('storage-set', (event, key, value) => {
    event.returnValue = storage.setItem(key, value);
  });
  ipcMain.on('storage-remove', (event, key) => {
    event.returnValue = storage.removeItem(key);
  });
  ipcMain.on('storage-clear', (event) => {
    storage.clear();
    if (isAuthenticated) driveSync.scheduleUploadImmediate();
    event.returnValue = true;
  });
  ipcMain.on('storage-length', (event) => {
    event.returnValue = storage.length;
  });
  ipcMain.on('storage-key', (event, index) => {
    event.returnValue = storage.key(index);
  });

  ipcMain.on('sync-record-deletion', (event, collection, id) => {
    storage.recordDeletion(collection, id);
    if (isAuthenticated) driveSync.scheduleUploadImmediate();
    event.returnValue = true;
  });

  ipcMain.on('sync-flush-upload', (event) => {
    if (isAuthenticated) driveSync.scheduleUploadImmediate();
    event.returnValue = true;
  });

  ipcMain.on('get-desktop-settings', (event) => {
    event.returnValue = storage.getDesktopSettings();
  });
  ipcMain.on('set-desktop-settings', (event, settings) => {
    const next = storage.setDesktopSettings(settings || {});
    applyAutoLaunch(next.autoLaunch);
    refreshTrayMenu();
    if (isAuthenticated) driveSync.scheduleUpload();
    event.returnValue = next;
  });

  ipcMain.handle('login-get-init-state', async () => ({
    configError: authManager.getConfigError(),
    autoLogin: authManager.authStorage.load()?.autoLogin !== false
  }));

  ipcMain.handle('login-start', async (_event, options) => {
    try {
      authManager.setAutoLogin(options?.autoLogin !== false);
      await authManager.login({
        autoLogin: options?.autoLogin !== false,
        forceConsent: true
      });
      await driveSync.pullAndMerge();
      await enterAuthenticatedApp();
      return { ok: true, email: authManager.getSession()?.email };
    } catch (err) {
      console.error('Login failed:', err);
      return { ok: false, error: translateAuthError(err.message) };
    }
  });

  ipcMain.handle('auth-get-state', async () => getAuthStatePayload());

  ipcMain.handle('auth-set-auto-login', async (_event, enabled) => {
    authManager.setAutoLogin(!!enabled);
    return getAuthStatePayload();
  });

  ipcMain.handle('auth-logout', async () => {
    await handleLogout();
    return { ok: true };
  });

  ipcMain.handle('sync-now', async () => {
    if (!isAuthenticated) throw new Error('not_authenticated');
    await driveSync.syncNow();
    return getAuthStatePayload();
  });

  ipcMain.handle('sync-get-remote-debug', async () => {
    if (!isAuthenticated) throw new Error('not_authenticated');
    try {
      const snapshot = await driveSync.getRemoteDebugSnapshot();
      return { ok: true, snapshot };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('app-get-version', () => app.getVersion());

  ipcMain.handle('app-check-updates', async () => getUpdaterApi().checkForUpdates());

  ipcMain.handle('focus-main-window', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.focus();
    return true;
  });

  ipcMain.handle('import-data-file', async () => {
    const win = mainWindow || loginWindow;
    const result = await dialog.showOpenDialog(win, {
      title: '브라우저 데이터 가져오기',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths[0]) {
      return { ok: false, cancelled: true };
    }

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
    } catch {
      return { ok: false, error: 'JSON 파일을 읽을 수 없습니다.' };
    }

    const data = parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
    const importKeys = Object.keys(data).filter((k) => k.startsWith('notion_app_') || k === 'desktop_settings');
    if (importKeys.length === 0) {
      return { ok: false, error: '가져올 데이터가 없습니다. task-app-export.json 파일인지 확인해 주세요.' };
    }

    const subset = {};
    importKeys.forEach((k) => { subset[k] = data[k]; });
    storage.importFromBrowserExport(subset);

    if (isAuthenticated) {
      try {
        await driveSync.upload(true);
      } catch (err) {
        console.error('Upload after import failed:', err.message);
      }
    }

    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('sync-data-changed');
    }
    return { ok: true, imported: importKeys.length };
  });

  ipcMain.on('open-data-folder', () => {
    shell.openPath(storage.getDataDir());
  });

  ipcMain.on('test-notification', () => {
    notificationScheduler?.notifyNow('Daymark', '알림이 정상적으로 동작합니다.');
  });

  ipcMain.on('navigate-tab', (_event, tab) => {
    mainWindow?.webContents.send('navigate-tab', tab);
  });
}

function translateAuthError(code) {
  const map = {
    login_cancelled: '로그인이 취소되었습니다.',
    login_timeout: '로그인 시간이 초과되었습니다. 다시 시도해 주세요.',
    access_denied: 'Google Drive 접근 권한이 거부되었습니다.'
  };
  return map[code] || code || '로그인에 실패했습니다.';
}

app.whenReady().then(async () => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.daymark.app');
  }

  storage = new AppStorage(app.getPath('userData'));
  authManager = new GoogleAuthManager(app.getPath('userData'));
  driveSync = new GoogleDriveSync(authManager, storage);

  driveSync.onStorageReload = () => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('sync-data-changed');
    }
  };

  driveSync.onSyncStatusChanged = () => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('auth-state-changed', getAuthStatePayload());
    }
  };

  storage.onDataChanged = () => {
    refreshTrayMenu();
    if (isAuthenticated) driveSync.scheduleUpload();
  };

  registerIpcHandlers();
  createTray();

  const settings = storage.getDesktopSettings();
  applyAutoLaunch(settings.autoLaunch);

  notificationScheduler = new NotificationScheduler(storage, () => mainWindow);
  notificationScheduler.start();

  const authed = await bootstrapAuth();
  if (!authed) {
    showLoginWindow();
  }

  app.on('activate', () => {
    if (isAuthenticated) {
      if (!mainWindow) createMainWindow();
      showMainWindow();
    } else {
      showLoginWindow();
    }
  });
});

app.on('before-quit', async () => {
  isQuitting = true;
  notificationScheduler?.stop();
  driveSync?.stopBackgroundSync();
  if (isAuthenticated) {
    try {
      await driveSync.upload(true);
    } catch (err) {
      console.error('Final sync failed:', err.message);
    }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (isQuitting) app.quit();
  }
});
