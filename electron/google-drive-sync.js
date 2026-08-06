const { google } = require('googleapis');
const { mergeSyncPayloads, dataEquals } = require('./sync-merge');

const DRIVE_FILE_NAME = 'task-app-sync.json';
const MIME_TYPE = 'application/json';

const SYNC_DATA_KEYS = [
  'notion_app_tasks',
  'notion_app_anniversaries',
  'notion_app_categories',
  'notion_app_ann_categories',
  'notion_app_theme',
  'notion_app_show_lunar',
  'notion_app_plan_reset_hour',
  'notion_app_distant_schedule_days',
  'notion_app_completed_hold_days',
  'notion_app_plan_date',
  'notion_app_hub_categories',
  'desktop_settings'
];

class GoogleDriveSync {
  constructor(authManager, storage) {
    this.authManager = authManager;
    this.storage = storage;
    this.fileId = null;
    this.syncTimer = null;
    this.pullTimer = null;
    this.syncing = false;
    this.lastSyncAt = null;
    this.lastSyncError = null;
    this.onStorageReload = null;
    this.onSyncStatusChanged = null;
    this.PULL_INTERVAL_MS = 3000;
    this.pendingLocalUpload = false;
  }

  getStatus() {
    return {
      lastSyncAt: this.lastSyncAt,
      lastSyncError: this.lastSyncError,
      syncing: this.syncing,
      email: this.authManager.getSession()?.email || null
    };
  }

  exportLocalData() {
    const data = {};
    SYNC_DATA_KEYS.forEach((key) => {
      const value = this.storage.getRaw(key);
      if (value !== undefined) data[key] = value;
    });
    return data;
  }

  buildPayload() {
    const data = this.exportLocalData();
    const meta = this.storage.getSyncMeta();
    return {
      version: 2,
      updatedAt: new Date().toISOString(),
      deviceId: meta.deviceId,
      deletions: this.storage.getDeletions(),
      data
    };
  }

  scheduleUpload(delayMs = 300) {
    this.pendingLocalUpload = true;
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.upload().catch((err) => {
        this.lastSyncError = err.message;
        console.error('Scheduled sync failed:', err);
      });
    }, delayMs);
  }

  scheduleUploadImmediate() {
    this.pendingLocalUpload = true;
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.upload(true).catch((err) => {
        this.lastSyncError = err.message;
        console.error('Immediate sync failed:', err);
      });
    }, 0);
  }

  startBackgroundSync() {
    this.stopBackgroundSync();
    this.pullTimer = setInterval(() => {
      this.pullAndMerge().catch((err) => {
        this.lastSyncError = err.message;
        console.error('Background pull failed:', err);
      });
    }, this.PULL_INTERVAL_MS);
  }

  stopBackgroundSync() {
    if (this.pullTimer) {
      clearInterval(this.pullTimer);
      this.pullTimer = null;
    }
  }

  async findOrCreateFile(drive) {
    const listRes = await drive.files.list({
      spaces: 'appDataFolder',
      fields: 'files(id, name, modifiedTime)',
      q: `name='${DRIVE_FILE_NAME}' and trashed=false`,
      pageSize: 1
    });

    if (listRes.data.files?.length) {
      this.fileId = listRes.data.files[0].id;
      return this.fileId;
    }

    const createRes = await drive.files.create({
      requestBody: {
        name: DRIVE_FILE_NAME,
        parents: ['appDataFolder']
      },
      media: {
        mimeType: MIME_TYPE,
        body: JSON.stringify({ version: 2, updatedAt: new Date(0).toISOString(), data: {}, deletions: {} })
      },
      fields: 'id'
    });
    this.fileId = createRes.data.id;
    return this.fileId;
  }

  async downloadRemote(drive) {
    const fileId = await this.findOrCreateFile(drive);
    const res = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'text' }
    );
    try {
      return JSON.parse(res.data);
    } catch {
      return { version: 2, updatedAt: new Date(0).toISOString(), data: {}, deletions: {} };
    }
  }

  async pullAndMerge() {
    if (this.pendingLocalUpload) return;
    this.syncing = true;
    this.lastSyncError = null;
    try {
      const drive = this.authManager.getDriveClient();
      const remote = await this.downloadRemote(drive);
      const localMeta = this.storage.getSyncMeta();
      const localData = this.exportLocalData();
      const localHasData = SYNC_DATA_KEYS.some((key) => localData[key] !== undefined);
      const remoteHasData = remote?.data && Object.keys(remote.data).length > 0;

      if (!remoteHasData && !localHasData) {
        this.lastSyncAt = new Date().toISOString();
        return;
      }

      if (!remoteHasData && localHasData) {
        await this.upload(true);
        return;
      }

      if (remoteHasData && !localHasData) {
        this.storage.applySyncPayload(remote.data, remote.updatedAt, {
          deletions: remote.deletions || {},
          clearLocalEdit: true
        });
        this.onStorageReload?.();
        this.lastSyncAt = new Date().toISOString();
        return;
      }

      const merged = mergeSyncPayloads({
        localData,
        remoteData: remote.data,
        localDeletions: this.storage.getDeletions(),
        remoteDeletions: remote.deletions || {},
        localEditedAt: localMeta.localEditedAt || null,
        remoteUpdatedAt: remote.updatedAt || null
      });

      const localChanged = !dataEquals(localData, merged.data);
      const remoteChanged = !dataEquals(remote.data, merged.data);
      const deletionsChanged = JSON.stringify(this.storage.getDeletions()) !== JSON.stringify(merged.deletions);

      if (localChanged) {
        this.storage.applySyncPayload(merged.data, null, { deletions: merged.deletions });
        this.onStorageReload?.();
      } else if (deletionsChanged) {
        this.storage.setDeletions(merged.deletions);
      }

      if (localMeta.localEditedAt) {
        await this.upload(true);
      } else {
        this.storage.setSyncMeta({ updatedAt: remote.updatedAt || localMeta.updatedAt });
        this.storage.clearLocalEdit();
      }

      this.lastSyncAt = new Date().toISOString();
      return merged;
    } finally {
      this.syncing = false;
      this.onSyncStatusChanged?.();
    }
  }

  async upload(force = false) {
    if (this.syncing && !force) return;
    this.syncing = true;
    this.lastSyncError = null;
    try {
      const drive = this.authManager.getDriveClient();
      const fileId = await this.findOrCreateFile(drive);
      const payload = this.buildPayload();
      this.storage.setSyncMeta({ updatedAt: payload.updatedAt });
      this.storage.clearLocalEdit();

      await drive.files.update({
        fileId,
        media: {
          mimeType: MIME_TYPE,
          body: JSON.stringify(payload)
        }
      });

      this.lastSyncAt = new Date().toISOString();
      this.pendingLocalUpload = false;
      setTimeout(() => {
        this.pullAndMerge().catch((err) => {
          this.lastSyncError = err.message;
          console.error('Post-upload pull failed:', err);
        });
      }, 400);
      return payload.updatedAt;
    } catch (err) {
      this.lastSyncError = err.message;
      throw err;
    } finally {
      this.syncing = false;
      this.onSyncStatusChanged?.();
    }
  }

  async syncNow() {
    clearTimeout(this.syncTimer);
    if (this.pendingLocalUpload) {
      await this.upload(true);
    }
    await this.pullAndMerge();
    return this.getStatus();
  }
}

module.exports = { GoogleDriveSync, SYNC_DATA_KEYS };
