# Browser Preferences

## Browser Selection
The user's preferred browser is stored here. Pepper does not hardcode any browser. Always use whichever browser the user has configured.

- **Preferred Browser**: Google Chrome
- **Executable Path**: `C:\Program Files\Google\Chrome\Application\chrome.exe`
- **CDP Port**: 9222
- **User Data Directory**: `C:\Users\anton\AppData\Local\Google\Chrome\AutomationProfile`
- **Active Profile Directory**: `Default`

When setting up on a new machine, ask the user which browser they prefer and update this file. Supported browsers: Microsoft Edge, Google Chrome (see CDP note below), Brave, Arc.

## Chrome 136+ CDP Limitation (IMPORTANT)
Chrome 136+ silently ignores `--remote-debugging-port` when using the **default user data directory**
(`AppData\Local\Google\Chrome\User Data`). This is a deliberate Google security change, not a bug.

**The fix**: Use a separate user data directory (`AutomationProfile`) dedicated to automation.
Copy the session-critical files from the Default profile once, sign into accounts in this profile,
and CDP works permanently from then on.

**Files to copy from Default profile to AutomationProfile/Default on setup:**
- `Network/Cookies` — login sessions
- `Login Data`, `Login Data For Account` — saved passwords
- `Web Data` — autofill, etc.
- `Preferences`, `Secure Preferences` — settings
- `Bookmarks`, `History`
- `../Local State` (one level up, in User Data root) — account list

**This machine's automation profile**: `C:\Users\anton\AppData\Local\Google\Chrome\AutomationProfile`
Seeded from **Profile 1** (user@example.com) on 2026-03-06. Single profile only — no other profiles in Local State.
If sessions expire, re-copy the files above or manually sign in by launching Chrome with:
```
chrome.exe --remote-debugging-port=9222 --user-data-dir="C:\Users\anton\AppData\Local\Google\Chrome\AutomationProfile"
```

## .exe Packaging Note (for future installer/bundled app)
When packaging Pepper as a `.exe` (e.g. via pkg, electron, or a Windows installer):

1. **Do NOT bundle the AutomationProfile** — it contains the user's cookies and credentials. It must
   be created per-machine on first run, never shipped.
2. **On first run, the installer/app should**:
   - Detect the user's Chrome installation path
   - List available Chrome profiles (read `Local State` → `profile.info_cache`) and ask the user to pick one
   - Create the AutomationProfile directory with only that one profile's files copied as `Default`
   - Write a minimal `Local State` with only `Default` in `info_cache` — this prevents other profiles
     from appearing in Chrome's profile picker inside the automation window
   - Launch Chrome once with `--remote-debugging-port` and `--user-data-dir=AutomationProfile`
     so the user can sign in fresh (cookies can't always be copied due to OS file locks)
   - Save the AutomationProfile path and chosen profile to the local config
3. **Shortcut patching does NOT work** — Chrome 136+ ignores `--remote-debugging-port` on the
   default profile regardless of shortcut flags. Always use a separate `--user-data-dir`.
4. **autoConnect (chrome-devtools-mcp)** is an alternative that avoids this entirely but requires
   a one-time DevTools permission dialog in the user's existing Chrome. It currently fails if Chrome
   was not started with any DevTools flags. Evaluate per Chrome version at packaging time.
5. Store the chosen `User Data Directory` in `config.json` (already gitignored) so it's machine-local.

## MCP Selection (Automatic)

Pepper uses `@playwright/mcp` with `--cdp-endpoint` pointing to the AutomationProfile Chrome instance.

| Browser | MCP Used | How it connects |
|---------|----------|-----------------|
| **Google Chrome** | `@playwright/mcp` via CDP on AutomationProfile | Requires Chrome running with `--remote-debugging-port=9222 --user-data-dir=AutomationProfile` |
| **Edge / Brave / Other** | `@playwright/mcp` with `--cdp-endpoint` | Same approach — use a non-default user data dir if CDP is ignored |

## Chrome Profiles (this machine)
| Directory | Email | Use for |
|-----------|-------|---------|
| Default | antony.saleh2017@gmail.com | Personal Gmail, general use |
| Profile 1 | user@example.com | School (Rice University) |
| Profile 2 | a.saleh@baretscholars.org | Baret Scholars |
| Profile 3 | rodney.saleh.us@gmail.com | Phone/Rodney |
| Profile 4 | antony@calybr.app | Calybr |
| Profile 5 | mcmurtryifp@gmail.com | McMurtry IVP |

**AutomationProfile** was seeded from the Default profile (antony.saleh2017@gmail.com).
To use a different account, sign into it inside the AutomationProfile Chrome instance.

## Auto-Launch (browser-health.js)
On startup, Pepper checks if CDP is reachable on port 9222. If not, it auto-launches Chrome with:
- `--remote-debugging-port=9222`
- `--user-data-dir=AutomationProfile` (the separate dir — NOT the default)
- `--profile-directory=Default`

This is self-healing on any machine: update the three fields at the top of this file and it works.

## How to Use
- Call `mcp__playwright__browser_navigate` etc. — they connect to the AutomationProfile Chrome via CDP
- The user is signed into their accounts in AutomationProfile
- **Do NOT use `chromium.launch()`** — always connect via CDP to preserve sessions
- **NEVER kill and relaunch Chrome** unless you relaunch with the correct `--user-data-dir`

## Setup on a New Machine
1. Install Chrome
2. Create `AutomationProfile` directory (see .exe Packaging Note above for the full flow)
3. Update `Executable Path`, `User Data Directory`, `Active Profile Directory` at the top of this file
4. Launch Chrome once manually with the CDP flags, sign into required accounts
5. Pepper will auto-launch from then on via browser-health.js

## MCP Server Configuration (.mcp.json)
```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--cdp-endpoint", "http://localhost:9222"]
    }
  }
}
```
