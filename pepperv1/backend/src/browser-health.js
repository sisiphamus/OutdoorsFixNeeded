/**
 * browser-health.js
 *
 * Ensures the user's preferred browser is ready for automation.
 *
 * Two modes depending on browser type (read from browser-preferences.md):
 *
 *   CHROME → Uses chrome-devtools-mcp with --autoConnect.
 *     Chrome M144+ supports autoConnect: no CDP port needed, no shortcut patching,
 *     never kills Chrome. On first use, Chrome shows a one-time permission dialog.
 *     This preserves ALL existing sessions/logins.
 *
 *   EDGE / OTHER CHROMIUM → Uses @playwright/mcp with --cdp-endpoint.
 *     Requires browser running with --remote-debugging-port.
 *     If not running: auto-launches with CDP flag.
 *     If running without CDP: patches shortcuts, warns user to restart.
 *     (Killing the browser would destroy sessions — never force-kill.)
 *
 * Self-healing on any machine: reads all settings from
 * bot/memory/preferences/browser-preferences.md.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PREFS_PATH = join(__dirname, '..', 'bot', 'memory', 'preferences', 'browser-preferences.md');

function readBrowserPrefs() {
  if (!existsSync(PREFS_PATH)) return {};
  const text = readFileSync(PREFS_PATH, 'utf-8');
  const prefs = {};
  const browserMatch = text.match(/\*\*Preferred Browser\*\*:\s*(.+)/);
  if (browserMatch) prefs.preferredBrowser = browserMatch[1].trim();
  const execMatch = text.match(/\*\*Executable Path\*\*:\s*`([^`]+)`/);
  if (execMatch) prefs.executablePath = execMatch[1];
  const portMatch = text.match(/\*\*CDP Port\*\*:\s*(\d+)/);
  if (portMatch) prefs.cdpPort = parseInt(portMatch[1]);
  const userDataMatch = text.match(/\*\*User Data Directory\*\*:\s*`([^`]+)`/);
  if (userDataMatch) prefs.userDataDir = userDataMatch[1];
  const profileMatch = text.match(/\*\*Active Profile Directory\*\*:\s*`([^`]+)`/);
  if (profileMatch) prefs.profileDir = profileMatch[1];
  return prefs;
}

function isChrome(preferredBrowser) {
  return !preferredBrowser || /chrome/i.test(preferredBrowser);
}

function isCdpReachable(port) {
  return new Promise((resolve) => {
    import('http').then(({ default: http }) => {
      const req = http.get(`http://localhost:${port}/json/version`, { timeout: 2000 }, (res) => {
        resolve(res.statusCode === 200);
        res.resume();
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  });
}

/**
 * Patches browser shortcuts to permanently include --remote-debugging-port.
 * Used only for non-Chrome browsers. Safe to call repeatedly.
 */
function patchShortcuts(browserName, cdpPort, userDataDir) {
  return new Promise((resolve) => {
    const args = `--remote-debugging-port=${cdpPort} --user-data-dir="${userDataDir}"`;
    const isEdge = /edge/i.test(browserName);
    const shortcutName = isEdge ? 'Microsoft Edge' : browserName;
    const script = `
$args = '${args}'
$shortcuts = @(
  "$env:USERPROFILE\\Desktop\\${shortcutName}.lnk",
  "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\${shortcutName}.lnk",
  "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\${shortcutName}.lnk"
)
foreach ($path in $shortcuts) {
  if (-not (Test-Path $path)) { continue }
  try {
    $sh = New-Object -ComObject WScript.Shell
    $lnk = $sh.CreateShortcut($path)
    $lnk.Arguments = $args
    $lnk.Save()
    Write-Host "Patched: $path"
  } catch { Write-Host "Skip (no access): $path" }
}`;
    execFile('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 10000 }, (err, stdout) => {
      if (stdout) stdout.trim().split('\n').forEach(l => l.trim() && console.log(`  [BrowserHealth] ${l.trim()}`));
      if (err) console.warn(`  [BrowserHealth] Shortcut patch warning: ${err.message}`);
      resolve();
    });
  });
}

/** Returns true if the given process name is currently running. */
function isProcessRunning(processName) {
  return new Promise((resolve) => {
    const tasklist = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\tasklist.exe`;
    execFile(tasklist, ['/FI', `IMAGENAME eq ${processName}`, '/NH'], { shell: false }, (err, stdout) => {
      resolve(!err && stdout.toLowerCase().includes(processName.toLowerCase()));
    });
  });
}

/**
 * Launches a browser with CDP flag via PowerShell Start-Process.
 * Uses PowerShell because execFile detached is unreliable on Windows.
 */
function openBrowser(executablePath, cdpPort, userDataDir, profileDir, firstRun = false) {
  return new Promise((resolve, reject) => {
    const args = [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      `--profile-directory=${profileDir}`,
      `--no-first-run`,
      `--no-default-browser-check`,
      `--disable-extensions-except=`,
      `--disable-background-extensions`,
      // On first run, open Google sign-in directly instead of showing extension popups
      ...(firstRun ? [`https://accounts.google.com/`] : []),
    ].join("','");
    const script = `Start-Process '${executablePath}' -ArgumentList '${args}'`;
    execFile('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 5000 }, () => {});

    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      if (await isCdpReachable(cdpPort)) {
        clearInterval(interval);
        resolve();
      } else if (attempts >= 24) { // 12 seconds
        clearInterval(interval);
        reject(new Error(`CDP did not become reachable on port ${cdpPort} after launch`));
      }
    }, 500);
  });
}

export async function ensureBrowserReady() {
  const prefs = readBrowserPrefs();
  const preferredBrowser = prefs.preferredBrowser || 'Google Chrome';

  // --- CHROME: use chrome-devtools-mcp --autoConnect ---
  // autoConnect connects to the already-running Chrome (M144+) without requiring
  // a CDP port, shortcut patching, or killing Chrome. Sessions are preserved.
  // On first use, Chrome shows a one-time permission dialog — just click Allow.
  if (isChrome(preferredBrowser)) {
    console.log(`  [BrowserHealth] Browser: Chrome — MCP uses autoConnect (no CDP port needed) ✓`);
    console.log(`  [BrowserHealth] Make sure Chrome is open. On first run, accept the DevTools permission dialog.`);
    return;
  }

  // --- EDGE / OTHER CHROMIUM: use @playwright/mcp with --cdp-endpoint ---
  const cdpPort = prefs.cdpPort || 9222;
  const executablePath = prefs.executablePath;
  // Default to AutomationProfile — Chrome 136+ ignores --remote-debugging-port on the default
  // user data dir. A separate dir is required. See browser-preferences.md for full explanation.
  const userDataDir = prefs.userDataDir || `C:\\Users\\${process.env.USERNAME}\\AppData\\Local\\Google\\Chrome\\AutomationProfile`;
  const profileDir = prefs.profileDir || 'Default';

  if (await isCdpReachable(cdpPort)) {
    console.log(`  [BrowserHealth] CDP reachable on port ${cdpPort} ✓`);
    return;
  }

  if (!executablePath || !existsSync(executablePath)) {
    console.warn(`  [BrowserHealth] Browser not found at: ${executablePath}`);
    console.warn(`  [BrowserHealth] Update 'Executable Path' in bot/memory/preferences/browser-preferences.md`);
    return;
  }

  // Permanently patch shortcuts so future launches always have CDP
  await patchShortcuts(preferredBrowser, cdpPort, userDataDir);

  const processName = executablePath.split('\\').pop();
  const running = await isProcessRunning(processName);
  if (running) {
    console.warn(`  [BrowserHealth] ${preferredBrowser} is running WITHOUT CDP on port ${cdpPort}.`);
    console.warn(`  [BrowserHealth] Shortcuts have been patched. Please restart ${preferredBrowser} manually`);
    console.warn(`  [BrowserHealth] to enable CDP. Browser tasks will not work until then.`);
    return;
  }

  // Detect first run: no account signed in yet in the AutomationProfile
  let firstRun = false;
  try {
    const prefsPath = join(userDataDir, profileDir, 'Preferences');
    if (existsSync(prefsPath)) {
      const prefs = JSON.parse(readFileSync(prefsPath, 'utf-8'));
      const accounts = prefs?.account_info || [];
      firstRun = accounts.length === 0;
    } else {
      firstRun = true; // No Preferences file at all — definitely first run
    }
  } catch { firstRun = true; }

  if (firstRun) {
    console.log(`  [BrowserHealth] First run detected — will open Google sign-in page.`);
  }

  console.log(`  [BrowserHealth] ${preferredBrowser} not running — launching with CDP flag...`);
  try {
    await openBrowser(executablePath, cdpPort, userDataDir, profileDir, firstRun);
    console.log(`  [BrowserHealth] ${preferredBrowser} launched with CDP on port ${cdpPort} ✓`);
  } catch (err) {
    console.warn(`  [BrowserHealth] Failed to launch ${preferredBrowser}: ${err.message}`);
    console.warn(`  [BrowserHealth] Start it manually — the CDP flag is now in your shortcut.`);
  }
}
