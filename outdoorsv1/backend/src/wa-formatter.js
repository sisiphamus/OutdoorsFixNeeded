import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_PATH = join(__dirname, '..', 'bot', 'memory', 'preferences', 'user-profile.md');

const COLOR_EMOJI_MAP = {
  red: '\uD83D\uDFE5',       // RED SQUARE
  blue: '\uD83D\uDFE6',      // BLUE SQUARE
  green: '\uD83D\uDFE9',     // GREEN SQUARE
  purple: '\uD83D\uDFEA',    // PURPLE SQUARE
  yellow: '\uD83D\uDFE8',    // YELLOW SQUARE
  orange: '\uD83D\uDFE7',    // ORANGE SQUARE
  black: '\u2B1B',            // BLACK SQUARE
  white: '\u2B1C',            // WHITE SQUARE
  pink: '\uD83E\uDE77',      // PINK HEART (closest pink emoji square)
  brown: '\uD83D\uDFEB',     // BROWN SQUARE
};

// Outdoor vibe → [left emoji, right emoji] for the header
const VIBE_EMOJI_MAP = {
  beach:    ['\uD83C\uDFD6\uFE0F', '\uD83C\uDF0A'],  // 🏖️ 🌊
  ocean:    ['\uD83C\uDFD6\uFE0F', '\uD83C\uDF0A'],  // 🏖️ 🌊
  mountain: ['\uD83C\uDFD4\uFE0F', '\u26F0\uFE0F'],  // 🏔️ ⛰️
  forest:   ['\uD83C\uDF32', '\uD83C\uDF3F'],          // 🌲 🌿
  desert:   ['\uD83C\uDFDC\uFE0F', '\uD83C\uDF35'],  // 🏜️ 🌵
  city:     ['\uD83C\uDFD9\uFE0F', '\uD83C\uDF03'],  // 🏙️ 🌃
};

const DEFAULT_VIBE = ['\uD83C\uDF32', '\uD83C\uDFD4\uFE0F']; // 🌲 🏔️

const DEFAULT_HEADER = `\u2591\u2592\u2593\u2588 \uD83C\uDF32 OUTDOORS \uD83C\uDFD4\uFE0F \u2588\u2593\u2592\u2591`;
const DEFAULT_FOOTER = `\u2591\u2592\u2593\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2593\u2592\u2591`;

let cachedColor = undefined; // undefined = not yet read, null = no color found
let cachedVibe = undefined;

function getUserColor() {
  if (cachedColor !== undefined) return cachedColor;

  try {
    if (existsSync(PROFILE_PATH)) {
      const content = readFileSync(PROFILE_PATH, 'utf-8');
      const match = content.match(/\*\*Favorite color:\*\*\s*(.+)/i);
      if (match) {
        const raw = match[1].trim().toLowerCase();
        for (const color of Object.keys(COLOR_EMOJI_MAP)) {
          if (raw.includes(color)) {
            cachedColor = color;
            return cachedColor;
          }
        }
      }
    }
  } catch {}

  cachedColor = null;
  return null;
}

function getUserVibe() {
  if (cachedVibe !== undefined) return cachedVibe;

  try {
    if (existsSync(PROFILE_PATH)) {
      const content = readFileSync(PROFILE_PATH, 'utf-8');
      const match = content.match(/\*\*Outdoor vibe:\*\*\s*(.+)/i);
      if (match) {
        const raw = match[1].trim().toLowerCase();
        for (const vibe of Object.keys(VIBE_EMOJI_MAP)) {
          if (raw.includes(vibe)) {
            cachedVibe = vibe;
            return cachedVibe;
          }
        }
      }
    }
  } catch {}

  cachedVibe = null;
  return null;
}

/**
 * Call this after the profile is written to pick up new color/vibe.
 */
export function clearColorCache() {
  cachedColor = undefined;
  cachedVibe = undefined;
}

export function formatOutdoorsResponse(text) {
  const color = getUserColor();
  const vibe = getUserVibe();
  const [vibeL, vibeR] = (vibe && VIBE_EMOJI_MAP[vibe]) || DEFAULT_VIBE;

  let header, footer;
  if (color && COLOR_EMOJI_MAP[color]) {
    const sq = COLOR_EMOJI_MAP[color];
    header = `${sq}\u2592\u2593\u2588 ${vibeL} OUTDOORS ${vibeR} \u2588\u2593\u2592${sq}`;
    footer = `${sq}${sq}${sq}\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588${sq}${sq}${sq}`;
  } else {
    header = `\u2591\u2592\u2593\u2588 ${vibeL} OUTDOORS ${vibeR} \u2588\u2593\u2592\u2591`;
    footer = DEFAULT_FOOTER;
  }

  const separator = '\u2501'.repeat(24);
  return `${header}\n${separator}\n\n${text.trim()}\n\n${separator}\n${footer}`;
}
