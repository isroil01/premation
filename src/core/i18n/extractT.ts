/**
 * Finds `t('key', 'English fallback')` calls in source text, for the
 * translator source file (`locales/en.json`).
 *
 * Only LITERAL calls are found — a key or fallback built at runtime cannot be
 * listed ahead of time, which is one more reason the `t()` rules say to pass
 * both as plain strings. Quotes may be ' " or ` (without `${}`); the call may
 * span lines.
 */

export interface ExtractedString {
  key: string;
  english: string;
}

const STR = String.raw`'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|\x60((?:[^\x60\\$]|\\.)*)\x60`;
const CALL = new RegExp(String.raw`(?<![\w$.])t\(\s*(?:${STR})\s*,\s*(?:${STR})`, 'g');

function unescape(s: string): string {
  return s.replace(/\\(.)/g, '$1');
}

export function extractTCalls(sourceText: string): ExtractedString[] {
  const out: ExtractedString[] = [];
  for (const m of sourceText.matchAll(CALL)) {
    const key = m[1] ?? m[2] ?? m[3];
    const english = m[4] ?? m[5] ?? m[6];
    if (key === undefined || english === undefined) continue;
    out.push({ key: unescape(key), english: unescape(english) });
  }
  return out;
}
