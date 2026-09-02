// Input sanitisation for anything a user or an uploaded file supplies.
// Kept in its own module so the control-character class is written once, safely.

const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F]', 'g');

export const clip = (v, max = 4000) =>
  (typeof v === 'string' ? v.slice(0, max).trim() : '');

/** Strip control characters and neutralise script-shaped markup in metadata. */
export function sanitize(v, max = 4000) {
  return clip(v, max)
    .replace(CONTROL_CHARS, ' ')
    .replace(/<\/?\s*script/gi, '&lt;script')
    .replace(/\s{3,}/g, '  ')
    .trim();
}

/** Filenames coming from an upload: no paths, no traversal, no control chars. */
export function safeFilename(v, max = 160) {
  return clip(v, max)
    .replace(CONTROL_CHARS, '')
    .replace(/[/\\]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/[^\w.\- ]/g, '')
    .trim() || 'upload';
}
