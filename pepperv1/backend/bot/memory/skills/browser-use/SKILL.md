---
name: browser_use
description: Navigate and interact with websites using Playwright MCP. Prefer JS evaluation over snapshots. Use browser_evaluate to find and click elements by text, browser_snapshot only when exploring unknown pages. Websites change constantly so verify before acting.
---

# Browser Use

## Core Principle
**Evaluate first, snapshot second, screenshot last.** Most browser tasks can be done with `browser_evaluate` running JS directly on the page. Snapshots (accessibility trees) are for exploration. Screenshots are for when the DOM lies.

## Method Priority

### 1. `browser_evaluate` (Preferred for known actions)
Run JS directly on the page. No snapshot needed. Near-zero tokens.

```javascript
// Click a button by visible text
const btn = [...document.querySelectorAll('button, a, [role="button"]')]
  .find(el => el.textContent.trim().includes('Connect'));
if (btn) { btn.click(); 'clicked'; } else { 'not found'; }
```

```javascript
// Fill an input by placeholder or label
const input = document.querySelector('input[placeholder*="Search"]');
if (input) { input.focus(); input.value = 'query'; input.dispatchEvent(new Event('input', {bubbles: true})); 'filled'; }
```

```javascript
// Read text content from the page
document.querySelector('h1')?.textContent?.trim() || 'no h1 found';
```

```javascript
// Check if element exists before acting
!!document.querySelector('[data-testid="send-button"]');
```

**When to use**: You know what element you want (button text, input placeholder, selector, data attribute). This covers ~70% of browser tasks.

**Limitations**: React/SPA state changes may not trigger from raw `.value =` assignment. If a form doesn't respond, use `browser_type` or `browser_fill_form` instead. Some sites use Shadow DOM, which requires `el.shadowRoot.querySelector(...)`.

### 2. `browser_snapshot` (For exploration or ref-based clicking)
Returns an accessibility tree with numbered `ref` elements. Needed when:
- You don't know what's on the page
- `browser_evaluate` can't find the element (Shadow DOM, iframes, complex widgets)
- You need Playwright's built-in `browser_click` with a ref number

**Always save to file, never inline:**
```
browser_snapshot(filename="/tmp/snap.txt")
Grep snap.txt for the element you need
browser_click(ref=NUMBER)
```

**Rules:**
- Every click needs a FRESH snapshot. Refs change on every page load.
- Never reuse ref numbers across navigations.
- Grep for keywords, don't read the whole tree.

### 3. `browser_take_screenshot` (When DOM lies)
Actual pixel screenshot. Use when:
- Page uses canvas rendering (maps, charts, games)
- Visual layout matters (checking if something is actually visible vs hidden off-screen)
- CAPTCHA or image-based content
- Debugging: page looks blank but DOM claims content exists

Save to file, read with the Read tool.

## Websites Change
DOM selectors, class names, and page structure change without warning. **Never hardcode selectors across sessions.** Instead:
- Search by **visible text** (`textContent.includes(...)`) rather than CSS classes
- Search by **role/aria attributes** (`[role="button"]`, `[aria-label="Send"]`) which are more stable
- Search by **data-testid** attributes when available (most stable, some sites strip them in prod)
- If a selector that worked last session fails, re-explore with a snapshot before assuming the site is broken

## Common Websites

### LinkedIn
- **Connect**: `browser_evaluate` to find button with text "Connect". If not found, look for "More" button first (Connect hides behind it on ~50% of profiles).
- **Search**: Navigate to `/search/results/people/?keywords=QUERY`
- **Message**: Navigate to `/messaging/`, use snapshot to find compose elements
- **Rate limits**: Add 2-5s delays between profile visits. LinkedIn detects automation patterns.

### Gmail (mail.google.com)
- **Prefer MCP** (`mcp__google_workspace__*`) when available
- **Compose**: Navigate to `/mail/u/N/#inbox?compose=new` — find correct N by checking `document.title` on the Gmail page, then snapshot to file, grep for "To recipients", "Subject", "Message Body", "Send"
- **Accounts**: `/u/N/` index varies by sign-in order. Check `document.title` or page avatar to confirm. See `bot/memory/sites/gmail.md` for full account list.
- **Accessibility tree is massive.** Always snapshot to file + grep.

### Google Calendar
- **Prefer MCP** for creating/reading events
- **Browser**: Navigate to `calendar.google.com`, snapshot to find event slots
- **Create event**: Easier via `browser_evaluate` to click the "+" or a time slot, then fill the form

### Google Drive / Docs
- **Prefer MCP** for reading/writing doc content
- **Browser**: Google Docs uses canvas rendering for the editor. `browser_evaluate` can't read doc text directly. Use MCP or export.

### Notion
- **Prefer MCP** (`mcp__notion__*`) for all CRUD
- **Browser**: Notion is a React SPA with heavy use of contenteditable blocks. Snapshot works but is very large. `browser_evaluate` can interact with the API client on `window.__NEXT_DATA__` in some cases.

### GitHub
- **Prefer `gh` CLI** for repos, PRs, issues
- **Browser**: Standard HTML, `browser_evaluate` works well. Search by `[data-testid]` or visible text.

### Todoist
- **Prefer MCP** (configured, REST v1)
- **Browser**: React SPA at todoist.com. Snapshot works for task lists.

### Twitter/X
- **Browser only** (API requires paid access)
- **Compose**: Navigate to `x.com/compose/post` or click tweet button on feed
- **Read**: `browser_evaluate` to grab tweet text from `[data-testid="tweetText"]`
- **Heavy SPA**: Refs change constantly, prefer `browser_evaluate` with data-testid selectors

### YouTube
- **Search**: Navigate to `youtube.com/results?search_query=QUERY`
- **Player controls**: `browser_evaluate` with `document.querySelector('video')` to play/pause/seek
- **Comments/descriptions**: Standard DOM, `browser_evaluate` works

### Amazon
- **Search**: Navigate to `amazon.com/s?k=QUERY`
- **Standard HTML** with some React. `browser_evaluate` works for most tasks.
- **Prices**: `document.querySelector('.a-price .a-offscreen')?.textContent`

### Reddit
- **Old reddit** (`old.reddit.com`) has simpler DOM, easier to parse
- **New reddit**: React SPA, use `browser_evaluate` with `[data-testid]` selectors or `shreddit-post` custom elements

### Vercel
- **Use `vercel` CLI** when possible
- **Browser**: React SPA at vercel.com. Snapshot works for dashboard navigation.

### Canvas (LMS)
- **Requires Rice SSO** (NetID + Duo MFA). Cannot fully automate without user present for MFA.
- Once authenticated, standard DOM. `browser_evaluate` works for reading assignments, grades.

### Cloudflare
- **Use `wrangler` CLI** for Workers/Pages
- **Browser**: Dashboard at dash.cloudflare.com. React SPA, snapshot works.

## Patterns

### Find and click by text (universal)
```javascript
const target = [...document.querySelectorAll('button, a, [role="button"], [role="link"], [role="menuitem"]')]
  .find(el => el.textContent.trim().includes('TARGET_TEXT'));
if (target) { target.click(); 'clicked'; } else { 'not found'; }
```

### Wait for element to appear
```javascript
await new Promise(resolve => {
  const obs = new MutationObserver(() => {
    if (document.querySelector('SELECTOR')) { obs.disconnect(); resolve(); }
  });
  obs.observe(document.body, {childList: true, subtree: true});
  setTimeout(() => { obs.disconnect(); resolve(); }, 5000);
});
!!document.querySelector('SELECTOR');
```

### Extract structured data
```javascript
[...document.querySelectorAll('.result-item')].map(el => ({
  title: el.querySelector('h3')?.textContent?.trim(),
  link: el.querySelector('a')?.href
}));
```

### Handle dropdowns/menus
```javascript
// Click trigger, wait, then click option
document.querySelector('[aria-label="More options"]')?.click();
setTimeout(() => {
  const opt = [...document.querySelectorAll('[role="menuitem"]')]
    .find(el => el.textContent.includes('Delete'));
  if (opt) opt.click();
}, 500);
```

## Debugging Checklist
When something doesn't work:
1. **Is the element actually on screen?** Take a screenshot, not just a snapshot. Elements can exist in DOM but be hidden, off-screen, or covered.
2. **Is it in an iframe?** `browser_evaluate` runs in the main frame by default. May need to target iframe.
3. **Is it Shadow DOM?** Use `el.shadowRoot.querySelector(...)` to pierce shadow boundaries.
4. **Did a SPA navigation happen?** After clicking a link in an SPA, the URL changes but the DOM update is async. Wait for content.
5. **Is the site blocking automation?** Some sites detect `navigator.webdriver`. The CDP connection to Edge usually avoids this since it's a real browser.
