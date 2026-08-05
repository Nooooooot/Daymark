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
    this.cache[key] = value;
    this.touchSyncMeta();
    this.persist();
  }

  removeItem(key) {
    delete this.cache[key];
    this.touchSyncMeta();
    this.persist();
  }

  clear() {
    const meta = this.cache.sync_meta;
    this.cache = {};
    if (meta !== undefined) this.cache.sync_meta = meta;
    this.touchSyncMeta();
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
    this.touchSyncMeta();
    this.persist();
    return merged;
  }

  getDataDir() {
    return this.dataDir;
  }

  applySyncPayload(data, updatedAt) {
    if (!data || typeof data !== 'object') return;
    Object.entries(data).forEach(([key, value]) => {
      if (LOCAL_ONLY_KEYS.has(key)) return;
      this.cache[key] = value;
    });
    this.setSyncMeta({ updatedAt: updatedAt || new Date().toISOString() });
    this.persist({ notify: false });
  }

  importFromBrowserExport(exportObj) {
    Object.entries(exportObj).forEach(([key, value]) => {
      this.cache[key] = typeof value === 'string' ? value : JSON.stringify(value);
    });
    this.touchSyncMeta();
    this.persist();
  }
}

module.exports = { AppStorage, DEFAULT_DESKTOP_SETTINGS };
