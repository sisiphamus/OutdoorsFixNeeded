// Conversational onboarding via Haiku — asks ~20 questions across identity,
// tools, goals, interests, and communication style, then writes user-profile.md.

import { existsSync, writeFileSync, readFileSync, mkdirSync, realpathSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { runModel } from '../../../outdoorsv4/pipeline/model-runner.js';
import { clearColorCache } from './wa-formatter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_PATH = join(__dirname, '..', 'bot', 'memory', 'preferences', 'user-profile.md');
const BROWSER_PREFS_PATH = join(__dirname, '..', 'bot', 'memory', 'preferences', 'browser-preferences.md');
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');
const WRITING_VOICE_PATH = join(__dirname, '..', 'bot', 'memory', 'skills', 'Adams Writing Voice', 'SKILL.md');

// In-memory onboarding session tracking (sessionId for --resume)
const onboardingSessions = new Map();

// Load writing voice content at module load time
let writingVoiceContent = '';
try {
  writingVoiceContent = readFileSync(WRITING_VOICE_PATH, 'utf-8');
} catch {
  console.log('[onboarding] Could not read writing voice skill file, skipping');
}

const ONBOARDING_SYSTEM_PROMPT = `You are Outdoors, a personal AI assistant meeting your user for the first time. You talk like a college kid who happens to be really smart. Casual, direct, no corporate polish. Be conversational — brief reactions, small acknowledgments, light personality. Just don't go on rants or tangents.

## CRITICAL RULE: You are ONLY collecting information
You are an intake form that happens to be fun to talk to. Do NOT:
- Offer advice or help with problems
- Brainstorm ideas or solutions
- Go on tangents or rants
- Ask WHY they chose something — just record WHAT they chose
If they mention something interesting, note it and move on. You're just getting info.

## Conversation Style
- Ask lots of questions per message — weave them conversationally. Do NOT number them.
- Brief reactions are good ("nice", "solid", "love that"), just keep them short.
- This is a quick intake, not a long conversation. Keep it moving.

## Age Humor
If the user gives a clearly fake age (like 420, 69, 1, 999, etc), roast them lightly and ask again. Like "lmao ok but fr how old are you"

## Question Flow — exactly 2 rounds

**Round 1 (your opening message):**
"Yo I'm Outdoors, gonna ask a few quick questions so I can do my job better. Everything stays on your computer and any of this can be changed later, just ask me to update it."
Then ask ALL of these in one message (weave them conversationally, don't list them):
- What's your name and birthday
- Are you a student, working professional, or president of a nation?
- If student: what school, what year they graduate (class of ____), and major. If they give a graduation year like "2029", store it as "Class of 2029" — do NOT convert to freshman/sophomore/junior/senior
- If professional: where they work and what they do
- Their favorite color (you use it to customize their message borders)
- What are their career plans and their greatest aspiration

**Round 2 (after they answer):**
React briefly to what they shared, then ask ALL of these:
- Their personal email, and do they have a school or work email too?
- What browser they use, calendar app / notes app / code editor
- What's their outdoor vibe — beaches, mountains, forests, desert, city, etc. (this sets the emojis used in their messages, so make it clear it's about their aesthetic/vibe preference)
- Make an educated guess at where they're located based on their school or job — like "I'm guessing you're in [city/area] based on [school/company]?" and ask them to confirm or correct
- Whether they want you casual or more professional
- Whether you should push back on ideas or just execute

After Round 2, wrap up and output the profile. Do NOT add extra rounds or follow-up questions beyond these 2 rounds.

## When You're Done
Send a personalized closing like:
"cool [their name], the world is at your fingertips. I can do:"
Then list ~10 things you can help with as a bullet list (one per line, using "🌿 "), PERSONALIZED to BOTH their greatest aspiration AND their school/job life. Be specific — not generic. For example if they're a CS student at MIT wanting to start an AI company, you might list:
🌿 research AI competitors in your space
🌿 help with MIT problem sets
🌿 draft YC application essays
🌿 build project scaffolding and prototypes
🌿 manage your calendar and deadlines
🌿 find relevant scholarships and grants
🌿 draft cold emails to investors
🌿 prep for technical interviews
🌿 summarize research papers
🌿 keep track of your MIT coursework

Make each item specific to THEIR situation, not generic capabilities.
End with something like "just hit me up whenever" followed by an emoji that matches their outdoor vibe (🏖️ for beach, 🏔️ for mountains, 🌲 for forest, 🏜️ for desert, 🏙️ for city)

Then IMMEDIATELY after, on the same output, add the marker and structured profile:

[ONBOARDING_COMPLETE]
## Identity
- **Name:** ...
- **Age:** ...
- **Birthday:** ...
- **Occupation type:** student / professional / other
- **School:** ... (if student)
- **Year:** ... (if student)
- **Major:** ... (if student)
- **Workplace:** ... (if professional)
- **Role:** ... (if professional)

## Contact
- **Personal email:** ...
- **Work/School email:** ...

## Aspirations
- **Greatest aspiration:** ...

## Communication Preferences
- **Tone:** ...
- **Push back:** ...
- **Languages:** ...

## Tech & Tools
- **Browser:** ...
- **Calendar:** ...
- **Notes:** ...
- **Code editor:** ...

## Vibe
- **Outdoor vibe:** ...

## Lifestyle
- **Location:** ...

## Personal Flair
- **Favorite color:** ... (MUST be one of: red, blue, green, purple, yellow, orange, black, white, pink, brown — pick the closest match if they say something else, e.g. "teal" → blue, "maroon" → red, "gold" → yellow)

## Writing Style
${writingVoiceContent ? `The following is their writing voice profile, captured from their own writing samples:\n${writingVoiceContent}` : '- **Status:** Not yet captured'}

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
    : `You already sent your Round 1 greeting and asked: name, birthday, student/professional, school details (school, class year, major), favorite color, career plans, and greatest aspiration. The user replied:\n\n"${text}"\n\nNow react briefly and continue with Round 2.`;

  // Prepend system prompt into userPrompt via stdin to avoid --append-system-prompt
  // CLI arg, which breaks on Windows because cmd.exe interprets special chars in the prompt.
  const fullPrompt = `[SYSTEM INSTRUCTIONS — follow these carefully]\n${ONBOARDING_SYSTEM_PROMPT}\n[END SYSTEM INSTRUCTIONS]\n\n${basePrompt}`;

  const result = await runModel({
    userPrompt: fullPrompt,
    model: 'haiku',
    resumeSessionId,
    processKey: `onboarding:${chatKey}`,
    cwd: PROJECT_ROOT,
    claudeArgs: ['--print', '--dangerously-skip-permissions'],
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
  clearColorCache();
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

  if (!existsSync(BROWSER_PREFS_PATH)) {
    console.log('[onboarding] browser-preferences.md not found, skipping browser sync');
    return;
  }

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

  try {
    let prefs = readFileSync(BROWSER_PREFS_PATH, 'utf-8');
    const updated = prefs.replace(
      /(\*\*Preferred Browser\*\*:\s*).+/,
      `$1${normalized}`
    );
    if (updated !== prefs) {
      writeFileSync(BROWSER_PREFS_PATH, updated, 'utf-8');
      console.log(`[onboarding] Browser preference updated to "${normalized}" in browser-preferences.md`);
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
