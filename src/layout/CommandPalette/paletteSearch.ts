/**
 * Pure search helpers for the Command Palette. No React, no singletons — so
 * the mode parsing / fuzzy ranking / timecode parsing can be unit-tested.
 */

export type PaletteMode = 'all' | 'commands' | 'layers' | 'compositions' | 'timecode';

export interface ParsedQuery {
  mode: PaletteMode;
  /** The search term with any mode prefix stripped. */
  term: string;
}

/**
 * Mode is chosen by the first character (VS Code / Linear convention):
 *   `>` commands · `@` layers · `#` compositions · `:` timecode · else search all.
 */
export function parseQuery(raw: string): ParsedQuery {
  const first = raw[0];
  if (first === '>') return { mode: 'commands', term: raw.slice(1).trim() };
  if (first === '@') return { mode: 'layers', term: raw.slice(1).trim() };
  if (first === '#') return { mode: 'compositions', term: raw.slice(1).trim() };
  if (first === ':') return { mode: 'timecode', term: raw.slice(1).trim() };
  return { mode: 'all', term: raw.trim() };
}

/**
 * Subsequence fuzzy score. Returns a score >= 0 when every char of `query`
 * appears in `text` in order, or -1 when it does not match. Higher is better:
 * contiguous runs, word-boundary hits, and a prefix match all boost the score.
 * An empty query matches everything with score 0.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q === '') return 0;
  if (q.length > t.length) return -1;

  let score = 0;
  let qi = 0;
  let prevMatch = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    // Contiguous match bonus.
    if (ti === prevMatch + 1) score += 5;
    else score += 1;
    // Word-boundary bonus (start, or preceded by space / separator).
    const prev = ti > 0 ? t[ti - 1] : ' ';
    if (ti === 0 || prev === ' ' || prev === '-' || prev === '_' || prev === '.') score += 3;
    prevMatch = ti;
    qi++;
  }
  if (qi < q.length) return -1; // not all chars consumed → no match
  if (t.startsWith(q)) score += 4;
  // Prefer shorter targets on ties.
  score -= t.length * 0.01;
  return score;
}

/**
 * Parse a timecode entry into seconds, or null if unparseable.
 * Accepts: `2.5` (seconds), `mm:ss`, `mm:ss.ms`, `hh:mm:ss`.
 */
export function parseTimecode(raw: string): number | null {
  const s = raw.trim();
  if (s === '') return null;
  if (!/^[0-9:.]+$/.test(s)) return null;

  if (!s.includes(':')) {
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  const parts = s.split(':');
  if (parts.length > 3) return null;
  let seconds = 0;
  for (const p of parts) {
    if (p === '') return null;
    const n = Number(p);
    if (!Number.isFinite(n) || n < 0) return null;
    seconds = seconds * 60 + n;
  }
  return seconds;
}

