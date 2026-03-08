/**
 * Shared utilities for transport layers.
 * Extracts action markers (like [IMAGE: path]) from AI response text
 * so each transport can handle file sending natively.
 */

const IMAGE_PATTERN = /\[IMAGE:\s*([^\]]+)\]/g;

/**
 * Extract [IMAGE: path] markers from response text.
 * Returns { images: string[], cleanText: string }
 */
export function extractImages(text) {
  const images = [];
  let match;
  // Reset lastIndex in case of reuse
  IMAGE_PATTERN.lastIndex = 0;
  while ((match = IMAGE_PATTERN.exec(text)) !== null) {
    images.push(match[1].trim());
  }
  const cleanText = text.replace(IMAGE_PATTERN, '').trim();
  return { images, cleanText };
}
