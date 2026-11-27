/** Rules for the name a person chooses to show on their account. */
export const DISPLAY_NAME_MAX = 40;

export type DisplayNameResult =
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly message: string };

// Control characters, zero-width spaces and bidi overrides have no business in a name. The joiners
// U+200C and U+200D stay allowed: they are part of real names (Persian, Indic scripts) and emoji.
// Written as escapes in a string so no invisible character ever sits in this source file.
const FORBIDDEN = new RegExp(
  // eslint-disable-next-line no-control-regex -- refusing control characters is the whole point
  '[\\u0000-\\u001f\\u007f-\\u009f\\u200b\\u200e\\u200f\\u2028-\\u202e\\u2066-\\u2069\\ufeff]',
  'u',
);

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/**
 * Normalizes what was typed: surrounding and repeated spaces are collapsed, an empty name means
 * "no name" (null), and anything that could be used to disguise text is refused rather than
 * silently altered.
 */
export function parseDisplayName(raw: string): DisplayNameResult {
  // Whitespace around the name (a pasted trailing newline, say) is just trimmed away.
  const trimmed = raw.trim();
  if (FORBIDDEN.test(trimmed)) {
    return { ok: false, message: 'Use letters, numbers and ordinary punctuation only.' };
  }
  const value = trimmed.replace(/ {2,}/gu, ' ');
  if (value === '') return { ok: true, value: null };
  if (Array.from(graphemes.segment(value)).length > DISPLAY_NAME_MAX) {
    return { ok: false, message: `Keep it to ${String(DISPLAY_NAME_MAX)} characters or fewer.` };
  }
  return { ok: true, value };
}
