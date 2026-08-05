const { google } = require('googleapis');

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
  'notion_app_plan_date',
  'desktop_settings'
];

class GoogleDriveSync {
  constructor(authManager, storage) {
    this.authManager = authManager;
    this.storage = storage;
    this.fileId = null;
    this.syncTimer = null;
    this.syncing = false;
    this.lastSyncAt = null;
    this.lastSyncError = null;
    this.onStorageReload = null;
  }

  getStatus() {
    return {
      lastSyncAt: this.lastSyncAt,
      lastSyncError: this.lastSyncError,
      syncing: this.syncing,
      email: this.authManager.getSession()?.email || null
    };
  }

  buildPayload() {
    const data = {};
    SYNC_DATA_KEYS.forEach((key) => {
      const value = this.storage.getRaw(key);
      if (value !== undefined) data[key] = value;
    });
    const meta = this.storage.getSyncMeta();
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      deviceId: meta.deviceId,
      data
    };
  }

  scheduleUpload(delayMs = 2500) {
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.upload().catch((err) => {
        this.lastSyncError = err.message;
        console.error('Scheduled sync failed:', err);
      });
    }, delayMs);
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
        body: JSON.stringify({ version: 1, updatedAt: new Date(0).toISOString(), data: {} })
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
      return { version: 1, updatedAt: new Date(0).toISOString(), data: {} };
    }
  }

  async pullAndMerge() {
    this.syncing = true;
    this.lastSyncError = null;
    try {
      const drive = this.authManager.getDriveClient();
      const remote = await this.downloadRemote(drive);
      const localMeta = this.storage.getSyncMeta();
      const remoteUpdated = remote?.updatedAt ? Date.parse(remote.updatedAt) : 0;
      const localUpdated = localMeta.updatedAt ? Date.parse(localMeta.updatedAt) : 0;

      const localHasData = SYNC_DATA_KEYS.some((key) => this.storage.getRaw(key) !== undefined);
      const remoteHasData = remote?.data && Object.keys(remote.data).length > 0;

      if (remoteHasData) {
        if (!localHasData || remoteUpdated > localUpdated) {
          this.storage.applySyncPayload(remote.data, remote.updatedAt);
          this.onStorageReload?.();
        } else if (localUpdated > remoteUpdated) {
          await this.upload(true);
        }
      } else if (localHasData) {
        await this.upload(true);
      }

      this.lastSyncAt = new Date().toISOString();
      return { remoteUpdated, localUpdated };
    } finally {
      this.syncing = false;
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

      await drive.files.update({
        fileId,
        media: {
          mimeType: MIME_TYPE,
          body: JSON.stringify(payload)
        }
      });

      this.lastSyncAt = new Date().toISOString();
      return payload.updatedAt;
    } catch (err) {
      this.lastSyncError = err.message;
      throw err;
    } finally {
      this.syncing = false;
    }
  }

  async syncNow() {
    clearTimeout(this.syncTimer);
    await this.pullAndMerge();
    await this.upload(true);
    return this.getStatus();
  }
}

module.exports = { GoogleDriveSync, SYNC_DATA_KEYS };
