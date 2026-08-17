const { google } = require('googleapis');
const { mergeSyncPayloads, dataEquals, payloadEquals } = require('./sync-merge');

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
  'notion_app_hub_categories'
];

const EMPTY_REMOTE = {
  version: 2,
  updatedAt: new Date(0).toISOString(),
  data: {},
  deletions: {}
};

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

  buildPayloadFromData(data, deletions, updatedAt) {
    const meta = this.storage.getSyncMeta();
    return {
      version: 2,
      updatedAt: updatedAt || new Date().toISOString(),
      deviceId: meta.deviceId,
      deletions: deletions || this.storage.getDeletions(),
      data
    };
  }

  buildPayload() {
    return this.buildPayloadFromData(this.exportLocalData());
  }

  mergeWithRemote(remote) {
    const localMeta = this.storage.getSyncMeta();
    const localData = this.exportLocalData();
    return mergeSyncPayloads({
      localData,
      remoteData: remote?.data || {},
      localDeletions: this.storage.getDeletions(),
      remoteDeletions: remote?.deletions || {},
      localEditedAt: localMeta.localEditedAt || null,
      remoteUpdatedAt: remote?.updatedAt || null
    });
  }

  applyMergedToLocal(merged, localData) {
    const localChanged = !dataEquals(localData, merged.data);
    const deletionsChanged = JSON.stringify(this.storage.getDeletions()) !== JSON.stringify(merged.deletions);

    if (localChanged) {
      this.storage.applySyncPayload(merged.data, null, { deletions: merged.deletions });
      this.onStorageReload?.();
    } else if (deletionsChanged) {
      this.storage.setDeletions(merged.deletions);
      this.onStorageReload?.();
    }

    return localChanged || deletionsChanged;
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
      return { ...EMPTY_REMOTE };
    }
  }

  async pullAndMerge() {
    if (this.syncing) return;
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

      const merged = this.mergeWithRemote(remote);
      const applied = this.applyMergedToLocal(merged, localData);
      const remoteDataChanged = !dataEquals(localData, remote?.data || {});

      if (!localMeta.localEditedAt) {
        if (remoteDataChanged && !applied) {
          this.storage.applySyncPayload(merged.data, remote.updatedAt, {
            deletions: merged.deletions,
            clearLocalEdit: true
          });
        }
        this.storage.setSyncMeta({ updatedAt: remote.updatedAt || localMeta.updatedAt });
        this.storage.clearLocalEdit();
        if (remoteDataChanged) {
          this.onStorageReload?.();
        }
      } else {
        await this.upload(true);
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
    const localMeta = this.storage.getSyncMeta();
    if (!force && !localMeta.localEditedAt && !this.pendingLocalUpload) return;

    this.syncing = true;
    this.lastSyncError = null;
    try {
      const drive = this.authManager.getDriveClient();
      const fileId = await this.findOrCreateFile(drive);
      const localData = this.exportLocalData();

      let remote = { ...EMPTY_REMOTE };
      try {
        remote = await this.downloadRemote(drive);
      } catch {
        // remote 없으면 로컬만 업로드
      }

      const remoteHasData = remote?.data && Object.keys(remote.data).length > 0;
      let payload;

      if (remoteHasData) {
        const merged = this.mergeWithRemote(remote);
        this.applyMergedToLocal(merged, localData);
        payload = this.buildPayloadFromData(merged.data, merged.deletions, merged.updatedAt);
      } else {
        payload = this.buildPayload();
      }

      if (remoteHasData && payloadEquals(payload, remote)) {
        this.storage.setSyncMeta({ updatedAt: remote.updatedAt || payload.updatedAt });
        this.storage.clearLocalEdit();
        this.lastSyncAt = new Date().toISOString();
        this.pendingLocalUpload = false;
        return remote.updatedAt;
      }

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
      this.pendingLocalUpload = false;
      this.onSyncStatusChanged?.();
    }
  }

  async syncNow() {
    clearTimeout(this.syncTimer);
    if (this.pendingLocalUpload || this.storage.getSyncMeta().localEditedAt) {
      await this.upload(true);
    }
    await this.pullAndMerge();
    return this.getStatus();
  }

  parseJsonArray(raw) {
    if (!raw) return [];
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  countDeletionEntries(deletions = {}) {
    const buckets = ['tasks', 'anniversaries', 'categories', 'ann_categories'];
    return buckets.reduce((sum, key) => {
      const bucket = deletions[key];
      return sum + (bucket && typeof bucket === 'object' ? Object.keys(bucket).length : 0);
    }, 0);
  }

  /** Drive appDataFolder 원본 JSON 요약 — merge/upload 없이 읽기만 */
  async getRemoteDebugSnapshot() {
    const drive = this.authManager.getDriveClient();
    const listRes = await drive.files.list({
      spaces: 'appDataFolder',
      fields: 'files(id, name, modifiedTime, size)',
      q: `name='${DRIVE_FILE_NAME}' and trashed=false`,
      pageSize: 1
    });

    const file = listRes.data.files?.[0];
    const localMeta = this.storage.getSyncMeta();
    const fetchedAt = new Date().toISOString();

    if (!file) {
      return {
        ok: true,
        exists: false,
        fetchedAt,
        localDeviceId: localMeta.deviceId || null,
        fileName: DRIVE_FILE_NAME
      };
    }

    const res = await drive.files.get(
      { fileId: file.id, alt: 'media' },
      { responseType: 'text' }
    );

    let payload = { ...EMPTY_REMOTE };
    try {
      payload = JSON.parse(res.data);
    } catch {
      payload = { ...EMPTY_REMOTE };
    }

    const data = payload.data || {};
    const tasks = this.parseJsonArray(data.notion_app_tasks);
    const anniversaries = this.parseJsonArray(data.notion_app_anniversaries);
    const categories = this.parseJsonArray(data.notion_app_categories);
    const recentTasks = tasks
      .slice()
      .sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0))
      .slice(0, 5)
      .map((task) => ({
        id: task.id,
        title: task.title || '(제목 없음)',
        modifiedAt: task.modifiedAt || null
      }));

    const updatedAt = payload.updatedAt || null;
    const deviceId = payload.deviceId || null;
    const driveModifiedTime = file.modifiedTime || null;

    return {
      ok: true,
      exists: true,
      fetchedAt,
      fileName: DRIVE_FILE_NAME,
      fileId: file.id,
      fileSize: file.size || null,
      driveModifiedTime,
      updatedAt,
      deviceId,
      localDeviceId: localMeta.deviceId || null,
      uploadedByThisPc: !!(deviceId && localMeta.deviceId && deviceId === localMeta.deviceId),
      version: payload.version ?? null,
      counts: {
        tasks: tasks.length,
        anniversaries: anniversaries.length,
        categories: categories.length,
        deletions: this.countDeletionEntries(payload.deletions || {})
      },
      recentTasks,
      fingerprint: [
        driveModifiedTime,
        updatedAt,
        deviceId,
        tasks.length,
        anniversaries.length,
        recentTasks.map((task) => `${task.id}:${task.modifiedAt || 0}`).join('|')
      ].join('::')
    };
  }
}

module.exports = { GoogleDriveSync, SYNC_DATA_KEYS };
