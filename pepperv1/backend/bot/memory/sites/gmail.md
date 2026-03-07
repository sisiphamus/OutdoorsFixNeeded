# Gmail

## Access Methods (in priority order)

### 1. Google Workspace MCP (Preferred)
**Package**: `taylorwilsdon/google_workspace_mcp`
**Auth**: OAuth 2.0 via Google Cloud Console
**Covers**: Gmail + Calendar + Drive + Docs in one server
- If configured, use `mcp__google-workspace__*` tools
- Structured API access, no DOM parsing needed

### 2. Playwright Browser (Use when MCP tools aren't in your environment)
Playwright connects via CDP to the user's **already-running Chrome**. **The user is already logged in — no authentication needed.** Just navigate and interact.

---

## CRITICAL: Session Prerequisite Check

**Before any Gmail task, verify Chrome has an active session:**

```
Step 1: curl -s http://localhost:9222/json/version
  → No response = Chrome not running with CDP.
    Pepper auto-launches Chrome on startup via browser-health.js.
    If still not running, ask user to open Chrome from their desktop shortcut.
  → Got JSON = Chrome is running, proceed to Step 2

Step 2: browser_navigate → https://mail.google.com/mail/u/0/#inbox
  → URL stays at mail.google.com = session active, proceed
  → URL redirects to workspace.google.com = session expired → tell user to log in
```

**If sessions are expired:** Tell the user: "Please open Chrome and log into Gmail, then try again."

**NEVER kill and relaunch Chrome** to fix this — it makes it worse. Just wait for the user to open Chrome normally.

---

## Compose Email — Verified Flow

```
1. browser_navigate → https://mail.google.com/mail/u/N/#inbox
   Confirm URL did NOT redirect to workspace.google.com

2. Verify correct account (snapshot → grep for email in page title or avatar)
   School = user@example.com, Personal = antony.saleh2017@gmail.com

3. browser_navigate → https://mail.google.com/mail/u/N/#inbox?compose=new
   (Opens compose dialog in same tab)

4. browser_snapshot filename="compose-snap.md"
   Then: Grep "compose-snap.md" for "To recipients|Subject|Message Body|Send"

5. browser_type ref=<To ref> text="Adam Towner"
   Wait for autocomplete: browser_snapshot filename="autocomplete-snap.md"
   Grep "autocomplete-snap.md" for "Adam Towner" suggestion ref
   browser_click ref=<suggestion ref>

6. browser_type ref=<Subject ref> text="<subject>"
7. browser_type ref=<Body ref> text="<body>"
8. browser_click ref=<Send ref>
   ⚠️ If click fails (overlay blocking): Use browser_run_code to:
   - Hide #google-feedback iframe: `document.getElementById('google-feedback').style.display='none'`
   - Focus body and press Ctrl+Enter: `await body.click(); await page.keyboard.press('Control+Enter')`

9. Verify: navigate to #sent and grep for subject line

10. Cleanup: Bash rm outputs/compose-snap.md outputs/autocomplete-snap.md
```

## AutomationProfile Account Index (verified 2026-03-07)
- `/u/0/` = user@example.com (school) — AutomationProfile was seeded from this profile
- Other accounts not yet verified in AutomationProfile

---

## Account Mapping

Chrome runs without `--profile-directory`, so all profiles are accessible via `/u/N/` indexes. The index depends on sign-in order and **can shift** — always verify.

**Known accounts (check by navigating and reading the page title/avatar):**
- antony.saleh2017@gmail.com — personal Gmail
- user@example.com — school (Rice University)
- a.saleh@baretscholars.org — Baret Scholars
- antony@calybr.app — Calybr
- mcmurtryivp@gmail.com — McMurtry IVP

**To find the right account:** Try `/u/0/`, `/u/1/`, `/u/2/` etc. and check the inbox page title or use:
```javascript
// Run via browser_evaluate on the Gmail page
document.title  // Shows "Inbox - user@example.com - Gmail" or similar
```

**Adam Towner's email**: at253@rice.edu

---

## Key Patterns

- **Gmail's accessibility tree is enormous.** Always use `filename` param on `browser_snapshot`. Never inline.
- **Compose dialog element names**: `textbox "To recipients"`, `textbox "Subject"`, `textbox "Message Body"`, `button "Send"`
- **Refs go stale** after page changes — re-snapshot after each action that might re-render
- **Contact autocomplete**: Type name → snapshot → grep for suggestion → click it. Don't type the full email directly.
- `browser_type` auto-focuses the field — no need to click first

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Redirected to workspace.google.com | Session expired | User must open Chrome and log in |
| Compose dialog not found in snapshot | Gmail still loading | Wait 1s, re-snapshot |
| Autocomplete didn't appear | Name too short or not a saved contact | Try typing full email address directly |
| Wrong account in inbox | Wrong `/u/N/` index | Check page title, try `/u/0/`, `/u/1/` until correct |
