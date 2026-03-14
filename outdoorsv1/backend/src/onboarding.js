// Conversational onboarding via Haiku — asks a few quick questions (name,
// school/work, emails, browser, outdoor vibe), then writes user-profile.md.

import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { runModel } from '../../../outdoorsv4/pipeline/model-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_PATH = join(__dirname, '..', 'bot', 'memory', 'preferences', 'user-profile.md');
const BROWSER_PREFS_PATH = join(__dirname, '..', 'bot', 'memory', 'preferences', 'browser-preferences.md');
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');
// In-memory onboarding session tracking (sessionId for --resume)
const onboardingSessions = new Map();

const ONBOARDING_SYSTEM_PROMPT = `You are Outdoors, a personal AI assistant meeting your user for the first time. Casual, direct, no corporate polish. Brief reactions, light personality. No rants or tangents.

## CRITICAL RULE: You are ONLY collecting information
You are an intake form that happens to be fun to talk to. Do NOT offer advice, brainstorm, or go on tangents. Just collect info and move on.

## Conversation Flow — exactly 1 round
The user has already been asked the questions in the welcome message. Their reply is their answers. React briefly, wrap up, and output the profile.

## When You're Done
Send a short closing like "cool [name], you're all set — hit me up whenever" followed by an emoji that matches their outdoor vibe (🏖️ beach, 🏔️ mountains, 🌲 forest, 🏜️ desert, 🏙️ city).

Then IMMEDIATELY after, on the same output, add the marker and structured profile:

[ONBOARDING_COMPLETE]
## Identity
- **Name:** ...
- **Occupation type:** student / professional / other
- **School:** ... (if student)
- **Year:** ... (if student — store as "Class of XXXX", do NOT convert to freshman/sophomore/etc)
- **Major:** ... (if student)
- **Workplace:** ... (if professional)
- **Role:** ... (if professional)

## Contact
- **Personal email:** ...
- **Work/School email:** ...

## Tech & Tools
- **Browser:** ...

## Vibe
- **Outdoor vibe:** ...

## Writing Style
- **Status:** Not yet captured

Fill in what you learned. Use "Not shared" for anything they skipped. Leave out fields that don't apply (e.g. School fields for professionals). Do NOT make up information.`;

/**
 * Returns true if onboarding hasn't been completed yet (no user-profile.md).
 */
export function isOnboardingNeeded() {
  return !existsSync(PROFILE_PATH);
}

/**
 * Handles a single message during the onboarding flow.
 * Returns { response, done } where done=true means onboarding just completed.
 */
export async function handleOnboardingMessage(text, chatKey) {
  const existing = onboardingSessions.get(chatKey);
  const resumeSessionId = existing?.sessionId || null;

  console.log(`[onboarding] Turn for ${chatKey}, resume=${!!resumeSessionId}, text="${text.slice(0, 80)}"`);

  // For the very first message, we use a special prompt that triggers the greeting
  const basePrompt = resumeSessionId
    ? text
    : `You already sent your greeting and asked: name, student/professional (+ school details or work details), emails, browser, and outdoor vibe. The user replied:\n\n"${text}"\n\nReact briefly, wrap up, and output the profile.`;

  // Prepend system prompt into userPrompt via stdin to avoid --append-system-prompt
  // CLI arg, which breaks on Windows because cmd.exe interprets special chars in the prompt.
  const fullPrompt = `[SYSTEM INSTRUCTIONS — follow these carefully]\n${ONBOARDING_SYSTEM_PROMPT}\n[END SYSTEM INSTRUCTIONS]\n\n${basePrompt}`;

  const result = await runModel({
    userPrompt: fullPrompt,
    model: 'haiku',
    resumeSessionId,
    processKey: `onboarding:${chatKey}`,
    cwd: PROJECT_ROOT,
    claudeArgs: ['--print'],
    skipMcp: true,
    onProgress: (type, data) => {
      console.log(`[onboarding:${type}]`, JSON.stringify(data).slice(0, 200));
    },
  });

  // Save session for resume
  if (result.sessionId) {
    onboardingSessions.set(chatKey, { sessionId: result.sessionId });
  }

  const response = result.response || '';
  console.log(`[onboarding] Response for ${chatKey}: ${response.length} chars`);

  // Check if onboarding is complete
  if (response.includes('[ONBOARDING_COMPLETE]')) {
    const parts = response.split('[ONBOARDING_COMPLETE]');
    const conversationalPart = parts[0].trim();
    const profileData = parts[1]?.trim() || '';

    // Write the profile
    parseAndSaveProfile(profileData);

    // Clean up session tracking
    onboardingSessions.delete(chatKey);

    console.log(`[onboarding] Complete for ${chatKey}`);
    return { response: conversationalPart, done: true };
  }

  return { response, done: false };
}

/**
 * Parses the structured profile output from Haiku and writes user-profile.md.
 */
function parseAndSaveProfile(profileData) {
  const dir = dirname(PROFILE_PATH);
  mkdirSync(dir, { recursive: true });

  const content = `# User Profile\n\n${profileData}`;
  writeFileSync(PROFILE_PATH, content, 'utf-8');
  console.log(`[onboarding] Profile written to ${PROFILE_PATH}`);

  // Sync browser choice to browser-preferences.md
  updateBrowserPreference(profileData);
}

/**
 * Extracts the browser from onboarding profile data and updates browser-preferences.md.
 */
function updateBrowserPreference(profileData) {
  const match = profileData.match(/\*\*Browser:\*\*\s*(.+)/i);
  if (!match) return;

  // Normalize common short names to full names used in browser-preferences.md
  const BROWSER_NAMES = {
    'edge': 'Microsoft Edge',
    'microsoft edge': 'Microsoft Edge',
    'chrome': 'Google Chrome',
    'google chrome': 'Google Chrome',
    'brave': 'Brave',
    'arc': 'Arc',
  };
  const raw = match[1].trim();
  const normalized = BROWSER_NAMES[raw.toLowerCase()] || raw;

  if (!existsSync(BROWSER_PREFS_PATH)) {
    // Create minimal browser-preferences.md — browser-health.js auto-detects the executable
    const minimal = [
      '# Browser Preferences\n',
      '## Browser Selection',
      `- **Preferred Browser**: ${normalized}`,
      '- **CDP Port**: 9222',
    ].join('\n');
    mkdirSync(dirname(BROWSER_PREFS_PATH), { recursive: true });
    writeFileSync(BROWSER_PREFS_PATH, minimal, 'utf-8');
    console.log(`[onboarding] Created browser-preferences.md with "${normalized}"`);
    return;
  }

  try {
    let prefs = readFileSync(BROWSER_PREFS_PATH, 'utf-8');
    const updated = prefs.replace(
      /(\*\*Preferred Browser\*\*:\s*).+/,
      `$1${normalized}`
    );
    if (updated !== prefs) {
      writeFileSync(BROWSER_PREFS_PATH, updated, 'utf-8');
      console.log(`[onboarding] Browser preference updated to "${normalized}"`);
    }
  } catch (err) {
    console.log(`[onboarding] Failed to update browser-preferences.md: ${err.message}`);
  }
}

/**
 * Returns the path to the user profile file (for use by other modules).
 */
export function getProfilePath() {
  return PROFILE_PATH;
}
