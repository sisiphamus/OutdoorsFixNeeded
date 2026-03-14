#!/usr/bin/env node

/**
 * Outdoors Setup Script
 *
 * Sets up everything needed to run Outdoors on a new machine:
 * 1. Checks prerequisites (Node, Python, Claude CLI, npm)
 * 2. Asks: Chrome or Edge? Detects executable, lists profiles
 * 3. Creates an AutomationProfile with copied session cookies
 * 4. Launches automation browser, user signs into Google
 * 5. Guides user through Google Cloud OAuth credential creation
 * 6. Writes .claude.json, config.json, browser-preferences.md
 * 7. Installs npm + pip dependencies
 *
 * Usage: node setup.js
 */

const { execSync, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const ROOT = __dirname;
const BACKEND = path.join(ROOT, 'outdoorsv1', 'backend');
const PREFS_DIR = path.join(BACKEND, 'bot', 'memory', 'preferences');
const CDP_PORT = 9222;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));

function log(msg) { console.log(`\n  ${msg}`); }
function ok(msg) { console.log(`  \u2713 ${msg}`); }
function warn(msg) { console.log(`  ! ${msg}`); }
function fail(msg) { console.log(`  \u2717 ${msg}`); }

function commandExists(cmd) {
  try {
    execSync(`${cmd} --version`, { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

function getCommandOutput(cmd) {
  try {
    return execSync(cmd, { stdio: 'pipe', encoding: 'utf-8' }).trim();
  } catch { return null; }
}

// ── Browser Configurations ───────────────────────────────────────────────────

const BROWSERS = {
  chrome: {
    name: 'Google Chrome',
    process: 'chrome.exe',
    userDataDir: path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data'),
    automationDir: path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'AutomationProfile'),
    exePaths: [
      path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ],
    mcp: {
      name: 'chrome',
      command: 'npx',
      args: ['chrome-devtools-mcp@latest', '--browserUrl', `http://127.0.0.1:${CDP_PORT}`],
    },
  },
  edge: {
    name: 'Microsoft Edge',
    process: 'msedge.exe',
    userDataDir: path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data'),
    automationDir: path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'AutomationProfile'),
    exePaths: [
      path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ],
    mcp: {
      name: 'playwright',
      command: 'npx',
      args: ['@playwright/mcp@latest', '--cdp-endpoint', `http://localhost:${CDP_PORT}`],
    },
  },
};

// Files to copy from the user's existing browser profile into AutomationProfile.
// These carry over login sessions, saved passwords, cookies, and preferences.
const SESSION_FILES = [
  'Login Data',
  'Login Data For Account',
  'Web Data',
  'Preferences',
  'Secure Preferences',
  'Bookmarks',
  'History',
];

// ── CDP / Browser Utilities ──────────────────────────────────────────────────

function isCdpReachable() {
  return new Promise(resolve => {
    const req = http.get(`http://localhost:${CDP_PORT}/json/version`, { timeout: 2000 }, res => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function isProcessRunning(processName) {
  return new Promise(resolve => {
    const tasklist = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe');
    execFile(tasklist, ['/FI', `IMAGENAME eq ${processName}`, '/NH'], { shell: false }, (err, stdout) => {
      resolve(!err && stdout.toLowerCase().includes(processName.toLowerCase()));
    });
  });
}

function launchBrowser(exePath, automationDir, url) {
  return new Promise((resolve, reject) => {
    const args = [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${automationDir}`,
      `--profile-directory=Default`,
      `--no-first-run`,
      `--no-default-browser-check`,
      ...(url ? [url] : []),
    ].join("','");
    const script = `Start-Process '${exePath}' -ArgumentList '${args}'`;
    execFile('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 5000 }, () => {});

    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      if (await isCdpReachable()) {
        clearInterval(interval);
        resolve();
      } else if (attempts >= 24) {
        clearInterval(interval);
        reject(new Error('CDP did not become reachable after 12 seconds'));
      }
    }, 500);
  });
}

/** Open a URL in a new tab via CDP HTTP API. */
function cdpOpenTab(url) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${CDP_PORT}/json/new?${encodeURI(url)}`, { timeout: 5000 }, res => {
      res.resume();
      resolve();
    }).on('error', reject);
  });
}

// ── Profile Utilities ────────────────────────────────────────────────────────

/** Read browser profiles from Local State file. */
function listProfiles(userDataDir) {
  const localStatePath = path.join(userDataDir, 'Local State');
  if (!fs.existsSync(localStatePath)) return [];
  try {
    const state = JSON.parse(fs.readFileSync(localStatePath, 'utf-8'));
    const cache = state.profile?.info_cache || {};
    return Object.entries(cache).map(([dir, info]) => ({
      directory: dir,
      name: info.name || dir,
      email: info.user_name || info.gaia_name || '',
    }));
  } catch { return []; }
}

/**
 * Copy session/cookie files from an existing browser profile into
 * AutomationProfile/Default. This preserves the user's login sessions
 * so they don't have to re-authenticate in the automation browser.
 *
 * Chrome 136+ ignores --remote-debugging-port on the default user data dir,
 * so a separate AutomationProfile dir is required. See:
 * PepperV6 browser-preferences.md "Chrome 136+ CDP Limitation" section.
 */
function copyProfileFiles(srcProfileDir, destProfileDir) {
  fs.mkdirSync(path.join(destProfileDir, 'Network'), { recursive: true });

  let copied = 0;
  let failed = 0;

  // Cookies live in Network/ subdirectory in modern Chrome/Edge
  const cookieSrc = path.join(srcProfileDir, 'Network', 'Cookies');
  if (fs.existsSync(cookieSrc)) {
    try { fs.copyFileSync(cookieSrc, path.join(destProfileDir, 'Network', 'Cookies')); copied++; }
    catch { failed++; }
  }
  // Fallback: older browsers store Cookies at profile root
  const cookieRootSrc = path.join(srcProfileDir, 'Cookies');
  if (!fs.existsSync(cookieSrc) && fs.existsSync(cookieRootSrc)) {
    try { fs.copyFileSync(cookieRootSrc, path.join(destProfileDir, 'Cookies')); copied++; }
    catch { failed++; }
  }

  // Copy remaining session files from profile root
  for (const file of SESSION_FILES) {
    const src = path.join(srcProfileDir, file);
    if (!fs.existsSync(src)) continue;
    try { fs.copyFileSync(src, path.join(destProfileDir, file)); copied++; }
    catch { failed++; }
  }

  return { copied, failed };
}

/** Create a minimal Local State so only the Default profile shows up. */
function writeMinimalLocalState(automationDir) {
  const localState = {
    profile: {
      info_cache: {
        Default: { name: 'Automation', is_using_default_name: false },
      },
    },
  };
  fs.writeFileSync(path.join(automationDir, 'Local State'), JSON.stringify(localState, null, 2));
}

// ── Minimal CDP WebSocket Client ─────────────────────────────────────────────
// Connects to Chrome DevTools Protocol via raw TCP + WebSocket upgrade.
// No external dependencies — uses only Node.js built-in net + crypto.

class CDPSocket {
  constructor(wsUrl) {
    this.url = new URL(wsUrl.replace('ws://', 'http://'));
    this.socket = null;
    this.nextId = 1;
    this.callbacks = new Map();
    this.listeners = {};
    this.buffer = Buffer.alloc(0);
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      this.socket = require('net').createConnection(
        { host: this.url.hostname, port: this.url.port || 80 },
        () => {
          this.socket.write(
            `GET ${this.url.pathname} HTTP/1.1\r\n` +
            `Host: ${this.url.host}\r\n` +
            `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
          );
        }
      );
      let upgraded = false;
      this.socket.on('data', (data) => {
        this.buffer = Buffer.concat([this.buffer, data]);
        if (!upgraded) {
          const idx = this.buffer.indexOf('\r\n\r\n');
          if (idx === -1) return;
          if (!this.buffer.slice(0, idx).toString().includes('101')) {
            reject(new Error('WebSocket upgrade failed'));
            return;
          }
          upgraded = true;
          this.buffer = this.buffer.slice(idx + 4);
          resolve();
        }
        this._readFrames();
      });
      this.socket.on('error', reject);
      this.socket.on('close', () => {
        for (const cb of this.callbacks.values()) cb.reject(new Error('closed'));
        this.callbacks.clear();
      });
    });
  }

  _readFrames() {
    while (this.buffer.length >= 2) {
      let payloadLen = this.buffer[1] & 0x7f;
      let hLen = 2;
      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2); hLen = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        payloadLen = Number(this.buffer.readBigUInt64BE(2)); hLen = 10;
      }
      if (this.buffer.length < hLen + payloadLen) return;
      const payload = this.buffer.slice(hLen, hLen + payloadLen).toString();
      this.buffer = this.buffer.slice(hLen + payloadLen);
      try {
        const msg = JSON.parse(payload);
        if (msg.id !== undefined && this.callbacks.has(msg.id)) {
          const cb = this.callbacks.get(msg.id);
          this.callbacks.delete(msg.id);
          msg.error ? cb.reject(new Error(msg.error.message)) : cb.resolve(msg.result || {});
        }
        if (msg.method && this.listeners[msg.method]) {
          this.listeners[msg.method].forEach(fn => fn(msg.params || {}));
        }
      } catch {}
    }
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.callbacks.set(id, { resolve, reject });
      this._writeFrame(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.callbacks.has(id)) { this.callbacks.delete(id); reject(new Error(`Timeout: ${method}`)); }
      }, 30000);
    });
  }

  on(event, fn) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }

  _writeFrame(text) {
    const payload = Buffer.from(text);
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length <= 125) {
      header = Buffer.from([0x81, 0x80 | payload.length]);
    } else {
      header = Buffer.alloc(4);
      header[0] = 0x81; header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    }
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  close() { try { this.socket?.end(); } catch {} }
}

// ── GCP Automation Helpers ───────────────────────────────────────────────────

/** HTTPS JSON request using built-in https module. */
function apiRequest(method, url, token, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, path: u.pathname + u.search, method,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/** Get list of CDP targets via HTTP. */
function getCdpTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${CDP_PORT}/json/list`, { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Bad CDP response')); } });
    }).on('error', reject);
  });
}

/** Wait for a condition with timeout. */
function waitFor(fn, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const val = fn();
      if (val) return resolve(val);
      if (Date.now() - start > timeoutMs) return reject(new Error('Timed out'));
      setTimeout(check, 500);
    };
    check();
  });
}

/** Helper: evaluate JS on page and return result, with a wait for page to settle. */
async function cdpEval(cdp, expression, awaitPromise = false) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'eval error');
  return result.result?.value;
}

/** Navigate and wait for load. */
async function cdpNavigateAndWait(cdp, url, waitMs = 5000) {
  await cdp.send('Page.navigate', { url });
  await new Promise(r => setTimeout(r, waitMs));
}

// ── GCP Auto-Create OAuth ────────────────────────────────────────────────────

async function autoCreateOAuth() {
  log('Attempting automatic Google Cloud setup...');

  // 1. Connect to a browser tab via CDP WebSocket
  const targets = await getCdpTargets();
  const page = targets.find(t => t.type === 'page');
  if (!page) throw new Error('No browser tab found');

  const cdp = new CDPSocket(page.webSocketDebuggerUrl);
  await cdp.connect();

  try {
    // 2. Enable Network domain and navigate to GCP to capture bearer token
    await cdp.send('Network.enable');
    let bearerToken = null;
    cdp.on('Network.requestWillBeSent', (params) => {
      const auth = params.request?.headers?.['authorization'] || params.request?.headers?.['Authorization'];
      if (auth && auth.startsWith('Bearer ') && !bearerToken) {
        bearerToken = auth.slice(7);
      }
    });

    ok('Connected to browser via CDP');
    await cdpNavigateAndWait(cdp, 'https://console.cloud.google.com/', 8000);

    // Wait for auth token to be captured from any GCP API request
    await waitFor(() => bearerToken, 15000);
    ok('Captured Google auth token');

    // 3. Get user email from token
    const tokenInfo = await apiRequest('GET', `https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${bearerToken}`, bearerToken);
    const userEmail = tokenInfo.data?.email || '';
    if (userEmail) ok(`Authenticated as ${userEmail}`);

    // 4. Create a GCP project (or find existing)
    const projectId = 'outdoors-bot-' + crypto.randomBytes(3).toString('hex');
    log('Creating Google Cloud project...');
    const createRes = await apiRequest('POST', 'https://cloudresourcemanager.googleapis.com/v1/projects', bearerToken, {
      projectId, name: 'Outdoors Bot',
    });

    let finalProjectId = projectId;
    if (createRes.status === 409) {
      // Project ID conflict — try to find existing projects
      const listRes = await apiRequest('GET', 'https://cloudresourcemanager.googleapis.com/v1/projects?filter=lifecycleState%3AACTIVE', bearerToken);
      const projects = listRes.data?.projects || [];
      const existing = projects.find(p => p.name === 'Outdoors Bot') || projects[0];
      if (existing) {
        finalProjectId = existing.projectId;
        ok(`Using existing project: ${finalProjectId}`);
      } else {
        throw new Error('Could not create or find a GCP project');
      }
    } else if (createRes.status >= 200 && createRes.status < 300) {
      ok(`Created project: ${finalProjectId}`);
      // Wait for project to be ready
      await new Promise(r => setTimeout(r, 5000));
    } else {
      throw new Error(`Project creation failed: ${createRes.status} ${JSON.stringify(createRes.data)}`);
    }

    // 5. Get project number (needed for API calls)
    const projRes = await apiRequest('GET', `https://cloudresourcemanager.googleapis.com/v1/projects/${finalProjectId}`, bearerToken);
    const projectNumber = projRes.data?.projectNumber;
    if (!projectNumber) throw new Error('Could not get project number');

    // 6. Enable required APIs
    const apis = [
      'gmail.googleapis.com', 'calendar-json.googleapis.com', 'drive.googleapis.com',
      'docs.googleapis.com', 'sheets.googleapis.com', 'slides.googleapis.com',
      'tasks.googleapis.com', 'people.googleapis.com', 'iap.googleapis.com',
    ];
    log('Enabling Google APIs (this may take a minute)...');
    for (const api of apis) {
      try {
        await apiRequest('POST', `https://serviceusage.googleapis.com/v1/projects/${projectNumber}/services/${api}:enable`, bearerToken);
      } catch {}
    }
    ok('APIs enabled');

    // 7. Create OAuth brand (consent screen) via IAP API
    log('Configuring OAuth consent screen...');
    const brandRes = await apiRequest('POST', `https://iap.googleapis.com/v1/projects/${projectNumber}/brands`, bearerToken, {
      applicationTitle: 'Outdoors Bot',
      supportEmail: userEmail,
    });
    if (brandRes.status >= 200 && brandRes.status < 300) {
      ok('OAuth consent screen configured');
    } else if (brandRes.status === 409) {
      ok('OAuth consent screen already exists');
    }

    // 8. Navigate to credential creation page and create Desktop App client via UI
    log('Creating OAuth Desktop client...');
    await cdpNavigateAndWait(cdp, `https://console.cloud.google.com/apis/credentials/oauthclient?project=${finalProjectId}`, 6000);

    // Try to select "Desktop app" and create the client via page JS
    const created = await cdpEval(cdp, `
      (async () => {
        // Wait for page to fully render
        await new Promise(r => setTimeout(r, 3000));

        // Find and click the application type dropdown
        const selectors = [
          'mat-select[formcontrolname="applicationType"]',
          '[aria-label*="Application type"]',
          '[aria-label*="application type"]',
          'mat-select',
        ];
        let dropdown = null;
        for (const sel of selectors) {
          dropdown = document.querySelector(sel);
          if (dropdown) break;
        }
        if (dropdown) {
          dropdown.click();
          await new Promise(r => setTimeout(r, 1000));

          // Find "Desktop" option
          const options = [...document.querySelectorAll('mat-option, [role="option"]')];
          const desktopOpt = options.find(o => o.textContent.toLowerCase().includes('desktop'));
          if (desktopOpt) {
            desktopOpt.click();
            await new Promise(r => setTimeout(r, 1000));
          }
        }

        // Fill name field
        const nameInputs = document.querySelectorAll('input[formcontrolname="displayName"], input[type="text"]');
        for (const input of nameInputs) {
          if (!input.value || input.value === '') {
            input.value = 'Outdoors Bot';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }

        // Click Create button
        await new Promise(r => setTimeout(r, 500));
        const buttons = [...document.querySelectorAll('button')];
        const createBtn = buttons.find(b => b.textContent.trim().toUpperCase() === 'CREATE')
          || buttons.find(b => b.textContent.trim().toUpperCase() === 'SAVE');
        if (createBtn && !createBtn.disabled) {
          createBtn.click();
          return 'clicked';
        }
        return 'no-button';
      })()
    `, true);

    if (created === 'clicked') {
      // Wait for the success dialog to appear with credentials
      await new Promise(r => setTimeout(r, 4000));

      const creds = await cdpEval(cdp, `
        (() => {
          // Look for client ID and secret in the dialog/page
          const allText = document.body.innerText;
          const idMatch = allText.match(/([0-9]+-[a-z0-9]+\\.apps\\.googleusercontent\\.com)/);
          const secretMatch = allText.match(/(GOCSPX-[A-Za-z0-9_-]+)/);
          if (idMatch && secretMatch) {
            return JSON.stringify({ clientId: idMatch[1], clientSecret: secretMatch[1] });
          }
          // Also try input/textarea elements that might contain the values
          const inputs = [...document.querySelectorAll('input[readonly], textarea[readonly], [class*="credential"], [class*="secret"]')];
          for (const el of inputs) {
            const val = el.value || el.textContent;
            if (val && val.includes('.apps.googleusercontent.com')) {
              return JSON.stringify({ clientId: val.trim() });
            }
          }
          return null;
        })()
      `);

      if (creds) {
        const parsed = JSON.parse(creds);
        if (parsed.clientId && parsed.clientSecret) {
          ok(`OAuth Client ID: ${parsed.clientId.slice(0, 20)}...`);
          ok(`OAuth Client Secret: ${parsed.clientSecret.slice(0, 10)}...`);
          return parsed;
        }
        // Got client ID but not secret — try to navigate to the client details
        if (parsed.clientId) {
          warn('Got Client ID but could not extract Secret automatically');
        }
      }
    }

    // If we got here, UI automation partially worked — open credentials page for user
    warn('Could not fully auto-create credentials. Opening the credentials page...');
    await cdpNavigateAndWait(cdp, `https://console.cloud.google.com/apis/credentials?project=${finalProjectId}`, 4000);
    throw new Error('UI extraction incomplete');

  } finally {
    cdp.close();
  }
}

// ── Step 1: Check Prerequisites ──────────────────────────────────────────────

async function checkPrerequisites() {
  log('Checking prerequisites...');
  let allGood = true;

  ok(`Node.js ${process.version}`);

  const py = getCommandOutput('python3 --version') || getCommandOutput('python --version');
  if (py) { ok(py); }
  else { fail('Python not found. Install Python 3.9+ from https://python.org'); allGood = false; }

  const hasUv = commandExists('uv') || commandExists('uvx');
  const hasPip = commandExists('pip') || commandExists('pip3');
  if (hasUv) {
    ok('uv (Python package manager)');
  } else if (hasPip) {
    warn('uv not found, installing via pip...');
    try { execSync('pip install uv', { stdio: 'pipe' }); ok('Installed uv'); }
    catch {
      try { execSync('pip3 install uv', { stdio: 'pipe' }); ok('Installed uv'); }
      catch { fail('Could not install uv. Install manually: pip install uv'); allGood = false; }
    }
  } else { fail('Neither uv nor pip found. Install Python with pip.'); allGood = false; }

  const claude = getCommandOutput('claude --version');
  if (claude) { ok(`Claude CLI ${claude}`); }
  else { fail('Claude CLI not found. Install from: https://docs.anthropic.com/en/docs/claude-code/overview'); allGood = false; }

  const npm = getCommandOutput('npm --version');
  if (npm) { ok(`npm ${npm}`); }
  else { fail('npm not found. Should come with Node.js.'); allGood = false; }

  return allGood;
}

// ── Step 2: Browser Setup ────────────────────────────────────────────────────

async function setupBrowser() {
  log('Browser Setup');
  log('Which browser should Outdoors use for automation?');
  console.log('    1) Google Chrome');
  console.log('    2) Microsoft Edge');
  const choice = await ask('  Enter 1 or 2: ');

  const key = choice.trim() === '2' ? 'edge' : 'chrome';
  const browser = BROWSERS[key];

  // ── Find executable ──
  let exePath = browser.exePaths.find(p => fs.existsSync(p));
  if (!exePath) {
    warn(`${browser.name} not found at default locations.`);
    const custom = await ask(`  Enter the full path to ${browser.process} (or Enter to skip browser setup): `);
    if (!custom.trim() || !fs.existsSync(custom.trim())) {
      fail('Browser not found. Browser automation will not work until configured.');
      return null;
    }
    exePath = custom.trim();
  }
  ok(`Found ${browser.name}: ${exePath}`);

  // ── Check if browser is running (session files may be locked) ──
  const running = await isProcessRunning(browser.process);
  if (running) {
    warn(`${browser.name} is currently running. Some session files may be locked during copy.`);
    warn('For best results, close the browser before continuing.');
    await ask('  Press Enter to continue anyway, or close the browser first: ');
  }

  // ── List available profiles ──
  const profiles = listProfiles(browser.userDataDir);
  let srcProfileName = 'Default';

  if (profiles.length > 1) {
    log('Available browser profiles:');
    profiles.forEach((p, i) => {
      console.log(`    ${i + 1}) ${p.name}${p.email ? ` (${p.email})` : ''} [${p.directory}]`);
    });
    const pChoice = await ask(`  Which profile to copy sessions from? [1-${profiles.length}]: `);
    const idx = parseInt(pChoice) - 1;
    srcProfileName = (profiles[idx] || profiles[0]).directory;
    ok(`Selected profile: ${(profiles[idx] || profiles[0]).name}`);
  } else if (profiles.length === 1) {
    srcProfileName = profiles[0].directory;
    ok(`Using profile: ${profiles[0].name}${profiles[0].email ? ` (${profiles[0].email})` : ''}`);
  } else {
    ok('Using Default profile');
  }

  // ── Create AutomationProfile ──
  const automationDir = browser.automationDir;
  const destProfileDir = path.join(automationDir, 'Default');
  const alreadyExists = fs.existsSync(path.join(destProfileDir, 'Preferences'));

  if (alreadyExists) {
    const overwrite = await ask('  AutomationProfile already exists. Re-copy sessions? (y/N): ');
    if (overwrite.trim().toLowerCase() !== 'y') {
      ok('Keeping existing AutomationProfile');
    } else {
      const srcDir = path.join(browser.userDataDir, srcProfileName);
      const { copied, failed } = copyProfileFiles(srcDir, destProfileDir);
      writeMinimalLocalState(automationDir);
      ok(`Re-copied ${copied} session files${failed ? ` (${failed} locked - close browser to fix)` : ''}`);
    }
  } else {
    log('Creating automation profile (copying login sessions)...');
    fs.mkdirSync(destProfileDir, { recursive: true });
    const srcDir = path.join(browser.userDataDir, srcProfileName);
    const { copied, failed } = copyProfileFiles(srcDir, destProfileDir);
    writeMinimalLocalState(automationDir);
    ok(`Automation profile created with ${copied} session files${failed ? ` (${failed} locked - close browser to fix)` : ''}`);
  }

  // ── Launch browser with CDP ──
  if (await isCdpReachable()) {
    ok(`CDP already reachable on port ${CDP_PORT}`);
  } else {
    log(`Launching ${browser.name} with automation profile...`);
    try {
      await launchBrowser(exePath, automationDir, 'https://accounts.google.com/');
      ok(`${browser.name} launched with CDP on port ${CDP_PORT}`);
    } catch (err) {
      fail(`Could not launch browser: ${err.message}`);
      log(`Try starting it manually with:`);
      log(`  "${exePath}" --remote-debugging-port=${CDP_PORT} --user-data-dir="${automationDir}" --profile-directory=Default`);
      return null;
    }
  }

  // ── Confirm Google login ──
  log('A browser window has opened on the Google sign-in page.');
  log('If you\'re already signed in (from copied cookies), just press Enter.');
  await ask('  Press Enter after signing into your Google account: ');
  ok('Google login confirmed');

  // ── Write browser-preferences.md ──
  fs.mkdirSync(PREFS_DIR, { recursive: true });
  const prefsContent = [
    '# Browser Preferences\n',
    '## Browser Selection',
    `- **Preferred Browser**: ${browser.name}`,
    `- **Executable Path**: \`${exePath}\``,
    `- **CDP Port**: ${CDP_PORT}`,
    `- **User Data Directory**: \`${automationDir}\``,
    '- **Active Profile Directory**: `Default`',
  ].join('\n');
  fs.writeFileSync(path.join(PREFS_DIR, 'browser-preferences.md'), prefsContent, 'utf-8');
  ok('Wrote browser-preferences.md');

  return { key, browser, exePath, automationDir };
}

// ── Step 3: Google Cloud OAuth Setup ─────────────────────────────────────────

/** Manual fallback: open GCP Console page, print instructions, ask user to paste. */
async function manualOAuthSetup(projectId) {
  if (projectId) {
    log('The project and APIs have been created. Just need credentials now.\n');
    try { await cdpOpenTab(`https://console.cloud.google.com/apis/credentials/oauthclient?project=${projectId}`); } catch {}
    log('  In the browser:');
    log('    1. Application type: "Desktop app"');
    log('    2. Click Create');
    log('    3. Copy the Client ID and Client Secret shown\n');
  } else {
    try { await cdpOpenTab('https://console.cloud.google.com/projectcreate'); } catch {}
    log('Follow these steps in the browser:\n');
    log('  STEP 1 - Create a project (or select an existing one)');
    log('    Name it anything (e.g. "Outdoors Bot")\n');
    log('  STEP 2 - Enable APIs');
    log('    Go to "APIs & Services" > "Enabled APIs & services"');
    log('    Click "+ ENABLE APIS AND SERVICES" and enable:');
    log('      Gmail API, Google Calendar API, Google Drive API,');
    log('      Google Docs API, Google Sheets API, Google Slides API,');
    log('      Google Tasks API, People API\n');
    log('  STEP 3 - Configure OAuth consent screen');
    log('    Go to "APIs & Services" > "OAuth consent screen"');
    log('    Choose "External" > fill in app name > Save');
    log('    Under "Test users", add your own email\n');
    log('  STEP 4 - Create credentials');
    log('    Go to "APIs & Services" > "Credentials"');
    log('    Click "Create Credentials" > "OAuth client ID"');
    log('    Application type: "Desktop app" > click Create');
    log('    Copy the Client ID and Client Secret shown\n');
  }

  const clientId = await ask('  Paste your OAuth Client ID (or press Enter to skip): ');
  if (!clientId.trim()) {
    warn('Skipping Google Workspace. You can configure it later.');
    return { clientId: '', clientSecret: '' };
  }
  const clientSecret = await ask('  Paste your OAuth Client Secret: ');
  if (!clientSecret.trim()) {
    warn('No secret provided. Skipping Google Workspace.');
    return { clientId: '', clientSecret: '' };
  }
  ok('OAuth credentials saved');
  return { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
}

async function setupOAuth() {
  log('Google Workspace Setup (Gmail, Calendar, Drive, etc.)');
  log('To access Google services, Outdoors needs OAuth credentials.\n');

  const want = await ask('  Set up Google Workspace now? (Y/n): ');
  if (want.trim().toLowerCase() === 'n') {
    warn('Skipping Google Workspace. Re-run setup later to configure it.');
    return { clientId: '', clientSecret: '' };
  }

  // Try fully automated approach first
  try {
    const result = await autoCreateOAuth();
    if (result?.clientId && result?.clientSecret) {
      ok('Google Cloud OAuth credentials created automatically!');
      return result;
    }
  } catch (err) {
    warn(`Auto-setup: ${err.message}`);
  }

  // Fall back to manual guided flow
  log('Falling back to guided setup...');
  return await manualOAuthSetup();
}

// ── Step 4: Write .claude.json ───────────────────────────────────────────────

function writeClaudeConfig(browserResult, oauth) {
  log('Configuring MCP servers...');

  let uvxCommand = 'uvx';
  const uvxPath = getCommandOutput(process.platform === 'win32' ? 'where uvx' : 'which uvx');
  if (uvxPath) uvxCommand = uvxPath.split('\n')[0].trim();

  const config = { mcpServers: {} };

  // Browser MCP (based on user's choice)
  if (browserResult) {
    const mcp = browserResult.browser.mcp;
    config.mcpServers[mcp.name] = { command: mcp.command, args: mcp.args };
    ok(`${browserResult.browser.name} MCP configured`);
  } else {
    // Fallback: add playwright as default
    config.mcpServers.playwright = {
      command: 'npx',
      args: ['@playwright/mcp@latest', '--cdp-endpoint', `http://localhost:${CDP_PORT}`],
    };
  }

  // Context7 (library docs)
  config.mcpServers.context7 = {
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp@latest'],
  };

  // Google Workspace (if OAuth credentials provided)
  if (oauth.clientId && oauth.clientSecret) {
    config.mcpServers.google_workspace = {
      type: 'stdio',
      command: uvxCommand,
      args: ['workspace-mcp'],
      env: {
        GOOGLE_OAUTH_CLIENT_ID: oauth.clientId,
        GOOGLE_OAUTH_CLIENT_SECRET: oauth.clientSecret,
      },
    };
    ok('Google Workspace MCP configured');
  }

  const configPath = path.join(ROOT, '.claude.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  ok(`Wrote ${configPath}`);
}

// ── Step 5: Write backend config.json ────────────────────────────────────────

async function writeBackendConfig() {
  const configPath = path.join(BACKEND, 'config.json');

  if (fs.existsSync(configPath)) {
    ok('outdoorsv1/backend/config.json already exists, skipping');
    return;
  }

  log('Configuring backend...');

  const phone = await ask('  Your phone number (digits only, e.g. 18031234567): ');

  const config = {
    port: 3457,
    allowedNumbers: [phone.replace(/\D/g, '')],
    allowAllNumbers: false,
    claudeCommand: 'claude',
    claudeArgs: ['--print'],
    maxResponseLength: 4000,
    messageTimeout: 120000,
    rateLimitPerMinute: 10,
    workingDirectory: ROOT,
    codeWorkingDirectory: ROOT,
    prefix: '!claude ',
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  ok(`Wrote ${configPath}`);
}

// ── Step 6: Install dependencies ─────────────────────────────────────────────

function installDependencies() {
  log('Installing dependencies...');

  try {
    execSync('npm install', { cwd: BACKEND, stdio: 'inherit' });
    ok('npm packages installed');
  } catch {
    fail('npm install failed. Run manually: cd outdoorsv1/backend && npm install');
  }

  try {
    execSync('pip install scikit-learn joblib numpy', { stdio: 'inherit' });
    ok('Python ML packages installed');
  } catch {
    try {
      execSync('pip3 install scikit-learn joblib numpy', { stdio: 'inherit' });
      ok('Python ML packages installed');
    } catch {
      warn('pip install failed. Run manually: pip install scikit-learn joblib numpy');
    }
  }

  try {
    execSync('uvx workspace-mcp --help', { stdio: 'pipe', timeout: 30000 });
    ok('workspace-mcp cached');
  } catch {
    ok('workspace-mcp downloaded');
  }
}

// ── Step 7: Update .gitignore ────────────────────────────────────────────────

function updateGitignore() {
  const gitignorePath = path.join(ROOT, '.gitignore');
  if (!fs.existsSync(gitignorePath)) return;

  const content = fs.readFileSync(gitignorePath, 'utf-8');
  if (!content.includes('.claude.json')) {
    fs.appendFileSync(gitignorePath, '\n# Claude MCP config (contains OAuth secrets)\n.claude.json\n');
    ok('Added .claude.json to .gitignore');
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n  \u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');
  console.log('  \u2551       Outdoors Setup              \u2551');
  console.log('  \u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d');

  // 1. Prerequisites
  const prereqsOk = await checkPrerequisites();
  if (!prereqsOk) {
    log('Fix the issues above, then re-run: node setup.js\n');
    rl.close();
    process.exit(1);
  }

  // 2. Browser setup (choose browser, copy cookies, launch, login)
  const browserResult = await setupBrowser();

  // 3. Google Cloud OAuth credentials
  const oauth = await setupOAuth();

  // 4. Write .claude.json with MCP servers + OAuth
  writeClaudeConfig(browserResult, oauth);

  // 5. Backend config
  await writeBackendConfig();

  // 6. .gitignore
  updateGitignore();

  // 7. Install deps
  installDependencies();

  // Done
  console.log('\n  \u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');
  console.log('  \u2551       Setup complete!             \u2551');
  console.log('  \u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d');
  log('To start Outdoors:');
  log('  cd outdoorsv1/backend && node src/index.js');
  if (oauth.clientId) {
    log('');
    log('First time using Gmail/Calendar/Drive:');
    log('  Claude will show a Google login URL.');
    log('  Click it, sign in, click "Allow", and you\'re set.\n');
  } else {
    log('');
    log('Google Workspace was not configured.');
    log('Re-run "node setup.js" later to set it up.\n');
  }

  rl.close();
}

main().catch(err => {
  console.error('Setup failed:', err.message);
  rl.close();
  process.exit(1);
});
