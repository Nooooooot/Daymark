const { app, dialog, BrowserWindow } = require('electron');
const { autoUpdater } = require('electron-updater');

let trayRef = null;
let pendingInstall = false;
let manualCheckResolver = null;
let manualCheckTimer = null;

function getParentWindow() {
  return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
}

function showDialog(options) {
  return dialog.showMessageBox(getParentWindow(), { noLink: true, ...options });
}

function resolveManualCheck(result) {
  if (!manualCheckResolver) return;
  const resolve = manualCheckResolver;
  manualCheckResolver = null;
  if (manualCheckTimer) {
    clearTimeout(manualCheckTimer);
    manualCheckTimer = null;
  }
  resolve(result);
}

function initAutoUpdater() {
  if (!app.isPackaged) {
    return {
      checkForUpdates: async () => ({
        ok: false,
        message: '개발 모드에서는 업데이트 확인을 사용할 수 없습니다.'
      })
    };
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    resolveManualCheck({
      ok: true,
      status: 'available',
      message: `새 버전 v${info.version}을(를) 사용할 수 있습니다.`
    });

    showDialog({
      type: 'info',
      title: 'Daymark 업데이트',
      message: `새 버전 v${info.version}을(를) 사용할 수 있습니다.`,
      detail: '지금 다운로드하시겠습니까?',
      buttons: ['다운로드', '나중에'],
      defaultId: 0,
      cancelId: 1
    }).then(({ response }) => {
      if (response === 0) {
        autoUpdater.downloadUpdate().catch((err) => {
          console.error('Download failed:', err);
        });
      }
    });
  });

  autoUpdater.on('update-not-available', () => {
    resolveManualCheck({
      ok: true,
      status: 'latest',
      message: '현재 최신 버전입니다.'
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    if (!trayRef) return;
    const percent = Math.round(progress.percent || 0);
    trayRef.setToolTip(`Daymark · 업데이트 다운로드 ${percent}%`);
  });

  autoUpdater.on('update-downloaded', () => {
    if (trayRef) trayRef.setToolTip('Daymark');
    pendingInstall = true;
    showDialog({
      type: 'info',
      title: 'Daymark 업데이트',
      message: '업데이트 다운로드가 완료되었습니다.',
      detail: '지금 재시작하면 새 버전이 적용됩니다.',
      buttons: ['지금 재시작', '나중에'],
      defaultId: 0,
      cancelId: 1
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });

  autoUpdater.on('error', (err) => {
    if (trayRef) trayRef.setToolTip('Daymark');
    console.error('Auto update error:', err);
    resolveManualCheck({
      ok: false,
      message: err.message || '업데이트 확인에 실패했습니다.'
    });
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('Startup update check failed:', err.message);
    });
  }, 8000);

  return {
    checkForUpdates: () => new Promise((resolve) => {
      if (pendingInstall) {
        resolve({
          ok: true,
          status: 'ready',
          message: '이미 다운로드된 업데이트가 있습니다. 재시작하면 적용됩니다.'
        });
        return;
      }

      manualCheckResolver = resolve;
      autoUpdater.checkForUpdates().catch((err) => {
        resolveManualCheck({
          ok: false,
          message: err.message || '업데이트 확인에 실패했습니다.'
        });
      });

      manualCheckTimer = setTimeout(() => {
        resolveManualCheck({
          ok: false,
          message: '업데이트 서버 응답 시간이 초과되었습니다.'
        });
      }, 30000);
    })
  };
}

let updaterApi = null;

function setupAutoUpdater(tray) {
  trayRef = tray;
  if (!updaterApi) updaterApi = initAutoUpdater();
  return updaterApi;
}

function getUpdaterApi() {
  if (!updaterApi) updaterApi = initAutoUpdater();
  return updaterApi;
}

module.exports = {
  setupAutoUpdater,
  getUpdaterApi
};
