/**
 * Increment a project name for AE's "Increment & Save": bump the trailing number
 * (preserving zero-padding), or append " 2" when there is none. Pure/testable.
 *
 *   "Comp"       → "Comp 2"
 *   "Comp 1"     → "Comp 2"
 *   "shot_009"   → "shot_010"   (padding preserved)
 *   "promo_v03"  → "promo_v04"
 */
export function incrementName(name: string): string {
  const m = /^(.+?)(\d+)$/.exec(name.trim());
  if (!m) return `${name.trim()} 2`;
  const prefix = m[1]!;
  const digits = m[2]!;
  const next = String(Number(digits) + 1).padStart(digits.length, '0');
  return `${prefix}${next}`;
}
