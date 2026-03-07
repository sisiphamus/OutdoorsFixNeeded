---
name: chrome_use
description: Chrome-specific browser automation. For Google Chrome, use mcp__chrome__* tools (chrome-devtools-mcp with autoConnect) — NOT Playwright. Playwright is for Edge/Brave/Other browsers only.
---

# Chrome Use

## MCP Tool to Use for Chrome
**Use `mcp__chrome__*` tools** (chrome-devtools-mcp with `--autoConnect`). These connect to the already-running Chrome instance with all sessions, cookies, and logins intact. No CDP port setup needed.

Do NOT use `mcp__playwright__*` for Chrome — Playwright uses CDP isolation which breaks active sessions.

## Remote Debugging (Edge/Brave/Other only)

For non-Chrome browsers, CDP via `--remote-debugging-port=9222` is needed. This does NOT close existing tabs or windows.

### Windows Setup (Automatic)
Pepper auto-patches Chrome shortcuts on startup via `browser-health.js`. No manual steps needed.

If Chrome is not running with CDP when Pepper starts, it will:
1. Patch the Chrome desktop and Start Menu shortcuts to permanently include `--remote-debugging-port=9222`
2. Launch Chrome with that flag

To verify it worked: navigate to `http://localhost:9222/json/version` — you should see a JSON response.

**Manual fallback** (if auto-patch fails):
1. Right-click Chrome shortcut > Properties
2. In "Target", append: `--remote-debugging-port=9222`
3. Restart Chrome

### macOS Setup
```bash
# Modify the app launch command
open -a "Google Chrome" --args --remote-debugging-port=9222
```

Or create an alias in `.zshrc`:
```bash
alias chrome='open -a "Google Chrome" --args --remote-debugging-port=9222'
```

### Linux Setup
```bash
google-chrome --remote-debugging-port=9222
```

Add to `.desktop` file Exec line for permanent setup.

### Important Notes
- The port flag only works on the FIRST Chrome instance launched. If Chrome is already running without the flag, the flag is ignored on subsequent launches.
- To fix: close ALL Chrome processes, then relaunch with the flag.
- The flag does NOT create a new profile or close existing tabs. Your session, cookies, and tabs are preserved.
- Verify it works: navigate to `http://localhost:9222/json/version` in any browser. You should see a JSON response with Chrome version info.

## Chrome Profiles

Chrome supports multiple user profiles, each with its own cookies, history, bookmarks, and extensions. This matters for automation because the CDP connection attaches to whichever profile is active.

### How Profiles Work
- Default profile directory (Windows): `C:\Users\<username>\AppData\Local\Google\Chrome\User Data\Default`
- Additional profiles: `C:\Users\<username>\AppData\Local\Google\Chrome\User Data\Profile 1`, `Profile 2`, etc.
- macOS: `~/Library/Application Support/Google/Chrome/Default`
- Linux: `~/.config/google-chrome/Default`

### Launching a Specific Profile
```bash
# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --profile-directory="Profile 1" --remote-debugging-port=9222

# macOS
open -a "Google Chrome" --args --profile-directory="Profile 1" --remote-debugging-port=9222
```

### Identifying the Active Profile
```javascript
// Run via browser_evaluate to check which profile is active
navigator.userAgent  // won't tell you, but...
```

Check `http://localhost:9222/json/version` -- the `User-Data-Dir` field shows which profile directory is in use.

### Profile Gotchas
- If the user has multiple Chrome profiles (personal, work, school), each has different logins. Make sure the correct profile is active before automating.
- Some users have Chrome profiles tied to different Google accounts. The profile determines which Gmail, Drive, Calendar, etc. you access.
- Extensions are per-profile. Ad blockers or privacy extensions in one profile may interfere with automation.

## Connecting to Chrome (MCP tools — preferred)

Use `mcp__chrome__*` tools directly. No code setup needed — chrome-devtools-mcp autoConnects to the running Chrome and exposes all tabs and sessions.

## Connecting to Chrome (code/script — fallback only)

If writing a script (not using MCP tools), connect via CDP:
```javascript
// Connect to running Chrome with CDP
const browser = await chromium.connectOverCDP('http://localhost:9222');
const context = browser.contexts()[0]; // Get the existing browser context
const pages = context.pages(); // All open tabs
```

Key rules:
- **NEVER** use `chromium.launch()` -- this creates a fresh browser without the user's session
- **ALWAYS** use `chromium.connectOverCDP()` to attach to the running instance

## Chrome vs Edge vs Other Chromium Browsers

All Chromium-based browsers (Chrome, Edge, Brave, Arc, Opera) support the same CDP protocol and `--remote-debugging-port` flag. The Playwright `chromium.connectOverCDP()` method works with all of them.

Differences:
- **Edge**: Executable at `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` (Windows)
- **Brave**: Executable at `C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe` (Windows)
- **Arc**: macOS only, `~/Applications/Arc.app`
- **Chrome**: `C:\Program Files\Google\Chrome\Application\chrome.exe` (Windows)

The automation code is identical regardless of which Chromium browser is used. Only the executable path and shortcut configuration differ.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `localhost:9222` not responding | Chrome was launched without the flag. Close all Chrome processes and relaunch with `--remote-debugging-port=9222` |
| Wrong profile's cookies | Check which `--profile-directory` was used at launch. Relaunch with the correct one |
| "DevTools is already open" errors | Only one CDP client can connect at a time. Close DevTools if open, or use `--remote-allow-origins=*` flag |
| Port already in use | Another process (or another browser) is using 9222. Use `netstat -ano | findstr 9222` to find it, or pick a different port |
