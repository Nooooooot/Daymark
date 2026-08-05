const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');
const { shell } = require('electron');
const { OAuth2Client } = require('google-auth-library');
const { google } = require('googleapis');
const { AuthStorage } = require('./auth-storage');

const REDIRECT_PATH = '/oauth/callback';
const REDIRECT_PORT = 42813;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}${REDIRECT_PATH}`;
const SCOPES = [
  'https://www.googleapis.com/auth/drive.appdata',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid'
];

function getProjectRoot() {
  try {
    const { app } = require('electron');
    if (app?.isPackaged) return app.getAppPath();
  } catch {
    /* not in electron yet */
  }
  return path.join(__dirname, '..');
}

function loadOAuthConfig() {
  const projectRoot = getProjectRoot();
  const configPaths = [path.join(projectRoot, 'google-oauth.config.json')];
  try {
    const { app } = require('electron');
    if (app?.isPackaged && process.resourcesPath) {
      configPaths.unshift(path.join(process.resourcesPath, 'google-oauth.config.json'));
    }
  } catch {
    /* not in electron yet */
  }

  const normalize = (raw) => {
    if (!raw) return null;
    if (raw.clientId) {
      return {
        clientId: raw.clientId,
        clientSecret: raw.clientSecret || undefined
      };
    }
    const block = raw.installed || raw.web;
    if (block?.client_id) {
      return {
        clientId: block.client_id,
        clientSecret: block.client_secret || undefined
      };
    }
    return null;
  };

  const tryRead = (filePath) => {
    try {
      if (!fs.existsSync(filePath)) return null;
      return normalize(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    } catch {
      return null;
    }
  };

  let config = null;
  for (const filePath of configPaths) {
    config = tryRead(filePath);
    if (config?.clientId) return config;
  }

  try {
    const files = fs.readdirSync(projectRoot);
    const googleFile = files.find((name) =>
      /^client_secret.*\.json$/i.test(name) || /^client_.*\.apps\.googleusercontent\.com\.json$/i.test(name)
    );
    if (googleFile) {
      config = tryRead(path.join(projectRoot, googleFile));
      if (config?.clientId) return config;
    }
  } catch {
    /* ignore */
  }

  return null;
}

class GoogleAuthManager {
  constructor(userDataPath) {
    this.userDataPath = userDataPath;
    this.authStorage = new AuthStorage(userDataPath);
    this.config = loadOAuthConfig();
    this.oauth2Client = null;
    this.session = null;
    this.initClient();
  }

  initClient() {
    if (!this.config?.clientId) return;
    this.oauth2Client = new OAuth2Client({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret || undefined,
      redirectUri: REDIRECT_URI
    });
  }

  isConfigured() {
    return !!(this.config?.clientId && this.oauth2Client);
  }

  getConfigError() {
    if (this.isConfigured()) return null;
    return 'Google OAuth 설정 파일을 찾을 수 없습니다. google-oauth.config.json 또는 Google에서 받은 client_secret JSON 파일을 프로젝트 폴더에 넣어 주세요.';
  }

  getSession() {
    return this.session;
  }

  async restoreSession() {
    if (!this.isConfigured()) return null;
    const saved = this.authStorage.load();
    if (!saved?.refresh_token && !saved?.access_token) return null;
    if (saved.autoLogin === false) return null;

    this.oauth2Client.setCredentials({
      refresh_token: saved.refresh_token,
      access_token: saved.access_token,
      expiry_date: saved.expiry_date
    });

    try {
      if (saved.refresh_token) {
        const { credentials } = await this.oauth2Client.refreshAccessToken();
        this.oauth2Client.setCredentials(credentials);
      }
      const email = saved.email || await this.fetchUserEmail();
      this.session = {
        email,
        autoLogin: saved.autoLogin !== false,
        loggedInAt: saved.loggedInAt || new Date().toISOString()
      };
      this.persistTokens({ email, autoLogin: saved.autoLogin !== false });
      return this.session;
    } catch (err) {
      console.error('Auto login failed:', err.message);
      if (saved.autoLogin === false) return null;
      this.authStorage.clear();
      return null;
    }
  }

  async fetchUserEmail() {
    const oauth2 = google.oauth2({ auth: this.oauth2Client, version: 'v2' });
    const res = await oauth2.userinfo.get();
    return res.data.email || '';
  }

  persistTokens({ email, autoLogin = true }) {
    const creds = this.oauth2Client.credentials;
    const saved = this.authStorage.load() || {};
    this.authStorage.save({
      refresh_token: creds.refresh_token || saved.refresh_token,
      access_token: creds.access_token,
      expiry_date: creds.expiry_date,
      email: email || saved.email || this.session?.email || '',
      autoLogin: autoLogin !== false,
      loggedInAt: new Date().toISOString()
    });
    this.session = {
      email: email || this.session?.email || '',
      autoLogin: autoLogin !== false,
      loggedInAt: new Date().toISOString()
    };
  }

  async login(options = {}) {
    if (!this.isConfigured()) {
      throw new Error(this.getConfigError());
    }

    const tokens = await this.runOAuthFlow({ forceConsent: !!options.forceConsent });
    this.oauth2Client.setCredentials(tokens);
    const email = await this.fetchUserEmail();
    this.persistTokens({ email, autoLogin: options.autoLogin !== false });
    return this.session;
  }

  runOAuthFlow({ forceConsent = false } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const server = http.createServer(async (req, res) => {
        try {
          const reqUrl = new URL(req.url, `http://127.0.0.1:${REDIRECT_PORT}`);
          if (reqUrl.pathname !== REDIRECT_PATH) {
            res.writeHead(404);
            res.end('Not found');
            return;
          }

          if (reqUrl.searchParams.get('error')) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<html><body style="font-family:sans-serif;text-align:center;padding:40px;"><h2>로그인이 취소되었습니다.</h2><p>창을 닫고 앱으로 돌아가세요.</p></body></html>');
            finish(reject, new Error(reqUrl.searchParams.get('error_description') || 'login_cancelled'));
            return;
          }

          const code = reqUrl.searchParams.get('code');
          if (!code) {
            res.writeHead(400);
            res.end('Missing code');
            return;
          }

          const { tokens } = await this.oauth2Client.getToken(code);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body style="font-family:sans-serif;text-align:center;padding:40px;"><h2>로그인 완료!</h2><p>이 창을 닫고 앱으로 돌아가세요.</p><script>setTimeout(()=>window.close(),1500)</script></body></html>');
          finish(resolve, tokens);
        } catch (err) {
          res.writeHead(500);
          res.end('Auth error');
          finish(reject, err);
        }
      });

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        server.close();
        fn(value);
      };

      server.on('error', (err) => finish(reject, err));

      server.listen(REDIRECT_PORT, '127.0.0.1', () => {
        const authUrl = this.oauth2Client.generateAuthUrl({
          access_type: 'offline',
          scope: SCOPES,
          prompt: forceConsent ? 'consent' : 'select_account',
          redirect_uri: REDIRECT_URI,
          include_granted_scopes: true
        });
        shell.openExternal(authUrl);
      });

      setTimeout(() => {
        if (!settled) {
          server.close();
          reject(new Error('login_timeout'));
        }
      }, 5 * 60 * 1000);
    });
  }

  setAutoLogin(enabled) {
    const saved = this.authStorage.load() || {};
    saved.autoLogin = !!enabled;
    if (this.session) this.session.autoLogin = !!enabled;
    if (saved.refresh_token || saved.access_token) {
      this.authStorage.save({ ...saved, autoLogin: !!enabled });
    }
  }

  logout() {
    this.session = null;
    if (this.oauth2Client) this.oauth2Client.setCredentials({});
    this.authStorage.clear();
  }

  getDriveClient() {
    if (!this.oauth2Client?.credentials?.access_token && !this.oauth2Client?.credentials?.refresh_token) {
      throw new Error('not_authenticated');
    }
    return google.drive({ version: 'v3', auth: this.oauth2Client });
  }
}

module.exports = { GoogleAuthManager, loadOAuthConfig };
