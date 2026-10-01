// Metadata is attacker-controlled data. These helpers only normalise it for storage/logging.
// Strips C0/C1 controls, zero-width, and bidi override/isolate characters.
const STRIP = new RegExp(
  '[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2069\\ufeff]',
  'g',
);

export const LIMITS = { name: 64, symbol: 16, uri: 200 } as const;

/** Strip unsafe chars, then clamp to `max` code points. Non-strings -> null. */
export function cleanText(v: unknown, max: number, nfkc = false): string | null {
  if (typeof v !== 'string') return null;
  let s = v.replace(STRIP, '');
  if (nfkc) s = s.normalize('NFKC');
  return Array.from(s).slice(0, max).join('');
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

export function isAddress(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 32 && v.length <= 44 && BASE58.test(v);
}

export function isSig(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 86 && v.length <= 90 && BASE58.test(v);
}
