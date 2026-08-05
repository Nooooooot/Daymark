const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');

const AUTH_FILE = 'auth.json';

class AuthStorage {
  constructor(userDataPath) {
    this.authPath = path.join(userDataPath, AUTH_FILE);
  }

  load() {
    try {
      if (!fs.existsSync(this.authPath)) return null;
      const raw = JSON.parse(fs.readFileSync(this.authPath, 'utf8'));
      return this.decryptRecord(raw);
    } catch (err) {
      console.error('Auth load failed:', err);
      return null;
    }
  }

  save(record) {
    try {
      const encrypted = this.encryptRecord(record);
      fs.writeFileSync(this.authPath, JSON.stringify(encrypted, null, 2), 'utf8');
    } catch (err) {
      console.error('Auth save failed:', err);
      throw err;
    }
  }

  clear() {
    try {
      if (fs.existsSync(this.authPath)) fs.unlinkSync(this.authPath);
    } catch (err) {
      console.error('Auth clear failed:', err);
    }
  }

  encryptRecord(record) {
    if (!safeStorage.isEncryptionAvailable()) {
      return { ...record, _plain: true };
    }
    const copy = { ...record };
    if (copy.refresh_token) {
      copy.refresh_token = safeStorage.encryptString(copy.refresh_token).toString('base64');
      copy._enc_refresh = true;
    }
    if (copy.access_token) {
      copy.access_token = safeStorage.encryptString(copy.access_token).toString('base64');
      copy._enc_access = true;
    }
    delete copy._plain;
    return copy;
  }

  decryptRecord(raw) {
    if (!raw) return null;
    const copy = { ...raw };
    if (copy._plain) {
      delete copy._plain;
      return copy;
    }
    if (copy._enc_refresh && copy.refresh_token) {
      copy.refresh_token = safeStorage.decryptString(Buffer.from(copy.refresh_token, 'base64'));
    }
    if (copy._enc_access && copy.access_token) {
      copy.access_token = safeStorage.decryptString(Buffer.from(copy.access_token, 'base64'));
    }
    delete copy._enc_refresh;
    delete copy._enc_access;
    return copy;
  }
}

module.exports = { AuthStorage };
