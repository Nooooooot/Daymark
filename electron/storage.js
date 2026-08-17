const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_DESKTOP_SETTINGS = {
  autoLaunch: true,
  notificationsEnabled: true,
  notifyAnniversaries: true,
  notifyTasks: true,
  notifyTime: '09:00',
  minimizeToTray: true
};

const LOCAL_ONLY_KEYS = new Set(['sync_meta']);

class AppStorage {
  constructor(userDataPath) {
    this.dataDir = path.join(userDataPath, 'data');
    this.storePath = path.join(this.dataDir, 'store.json');
    this.cache = {};
    this.onDataChanged = null;
    this.load();
    this.ensureDeviceId();
  }

  load() {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
      if (fs.existsSync(this.storePath)) {
        this.cache = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
      } else {
        this.cache = {};
        this.persist({ notify: false });
      }
    } catch (err) {
      console.error('Storage load failed:', err);
      this.cache = {};
    }
  }

  ensureDeviceId() {
    const meta = this.getSyncMeta();
    if (!meta.deviceId) {
      meta.deviceId = crypto.randomUUID();
      this.setSyncMeta(meta);
    }
  }

  persist({ notify = true } = {}) {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
      fs.writeFileSync(this.storePath, JSON.stringify(this.cache, null, 2), 'utf8');
      if (notify) this.onDataChanged?.();
    } catch (err) {
      console.error('Storage persist failed:', err);
    }
  }

  getRaw(key) {
    return this.cache[key];
  }

  getItem(key) {
    const value = this.cache[key];
    return value === undefined ? null : String(value);
  }

  setItem(key, value) {
    const next = value === undefined || value === null ? '' : String(value);
    if (this.cache[key] === next) return false;
    this.cache[key] = next;
    this.touchLocalEdit();
    this.persist();
    return true;
  }

  removeItem(key) {
    if (!(key in this.cache)) return false;
    delete this.cache[key];
    this.touchLocalEdit();
    this.persist();
    return true;
  }

  clear() {
    const meta = this.cache.sync_meta;
    this.cache = {};
    if (meta !== undefined) this.cache.sync_meta = meta;
    this.touchLocalEdit();
    this.persist();
  }

  get length() {
    return Object.keys(this.cache).length;
  }

  key(index) {
    return Object.keys(this.cache)[index] ?? null;
  }

  getSyncMeta() {
    try {
      const raw = this.cache.sync_meta;
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  setSyncMeta(partial) {
    const merged = { ...this.getSyncMeta(), ...partial };
    this.cache.sync_meta = JSON.stringify(merged);
    this.persist({ notify: false });
    return merged;
  }

  touchSyncMeta() {
    this.setSyncMeta({ updatedAt: new Date().toISOString() });
  }

  touchLocalEdit() {
    this.setSyncMeta({ localEditedAt: new Date().toISOString() });
  }

  clearLocalEdit() {
    const meta = this.getSyncMeta();
    delete meta.localEditedAt;
    this.setSyncMeta(meta);
  }

  getEffectiveLocalUpdated() {
    const meta = this.getSyncMeta();
    const synced = meta.updatedAt ? Date.parse(meta.updatedAt) : 0;
    const edited = meta.localEditedAt ? Date.parse(meta.localEditedAt) : 0;
    return Math.max(synced, edited);
  }

  getDeletions() {
    const meta = this.getSyncMeta();
    return {
      tasks: meta.deletedTasks || {},
      anniversaries: meta.deletedAnniversaries || {},
      ann_categories: meta.deletedAnnCategories || {},
      categories: meta.deletedCategories || {}
    };
  }

  setDeletions(deletions = {}) {
    this.setSyncMeta({
      deletedTasks: deletions.tasks || {},
      deletedAnniversaries: deletions.anniversaries || {},
      deletedAnnCategories: deletions.ann_categories || {},
      deletedCategories: deletions.categories || {}
    });
  }

  recordDeletion(collection, id) {
    const mapKey = {
      tasks: 'deletedTasks',
      anniversaries: 'deletedAnniversaries',
      ann_categories: 'deletedAnnCategories',
      categories: 'deletedCategories'
    }[collection];
    if (!mapKey) return;
    const meta = this.getSyncMeta();
    const bucket = { ...(meta[mapKey] || {}) };
    bucket[String(id)] = new Date().toISOString();
    this.setSyncMeta({ [mapKey]: bucket });
    this.touchLocalEdit();
  }

  getDesktopSettings() {
    const raw = this.cache.desktop_settings;
    if (!raw) return { ...DEFAULT_DESKTOP_SETTINGS };
    try {
      return { ...DEFAULT_DESKTOP_SETTINGS, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_DESKTOP_SETTINGS };
    }
  }

  setDesktopSettings(settings) {
    const merged = { ...this.getDesktopSettings(), ...settings };
    this.cache.desktop_settings = JSON.stringify(merged);
    this.touchLocalEdit();
    this.persist();
    return merged;
  }

  getDataDir() {
    return this.dataDir;
  }

  applySyncPayload(data, updatedAt, options = {}) {
    if (!data || typeof data !== 'object') return;
    Object.entries(data).forEach(([key, value]) => {
      if (LOCAL_ONLY_KEYS.has(key)) return;
      this.cache[key] = value;
    });
    const metaPatch = {};
    if (updatedAt) metaPatch.updatedAt = updatedAt;
    if (options.deletions) {
      metaPatch.deletedTasks = options.deletions.tasks || {};
      metaPatch.deletedAnniversaries = options.deletions.anniversaries || {};
      metaPatch.deletedAnnCategories = options.deletions.ann_categories || {};
      metaPatch.deletedCategories = options.deletions.categories || {};
    }
    this.setSyncMeta(metaPatch);
    if (options.clearLocalEdit) this.clearLocalEdit();
    this.persist({ notify: false });
  }

  importFromBrowserExport(exportObj) {
    Object.entries(exportObj).forEach(([key, value]) => {
      this.cache[key] = typeof value === 'string' ? value : JSON.stringify(value);
    });
    this.touchLocalEdit();
    this.persist();
  }
}

module.exports = { AppStorage, DEFAULT_DESKTOP_SETTINGS };
