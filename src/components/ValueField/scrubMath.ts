/**
 * Scrub math — the pure core of ValueField's signature drag interaction,
 * extracted so it is unit-testable (and reusable by any other scrubbable
 * control). Behaviour contract:
 *
 *   • 1 × `step` per pixel of horizontal drag (step defaults to 1)
 *   • Shift = 10× coarser, Alt = 0.1× finer
 *   • a 3px dead-zone distinguishes a click (→ edit mode) from a drag
 */

/** Step multiplier from modifier keys: Shift = 10×, Alt = 0.1×. */
export function stepScale(e: { shiftKey: boolean; altKey: boolean }): number {
  if (e.shiftKey) return 10;
  if (e.altKey) return 0.1;
  return 1;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Display formatting: fixed max precision with trailing zeros trimmed. */
export function format(v: number, precision: number): string {
  if (!Number.isFinite(v)) return '0';
  return String(Number(v.toFixed(precision)));
}

/** Pixels of drag a pointer must travel before it counts as a scrub. */
export const SCRUB_DEAD_ZONE_PX = 3;

/** The scrubbed value for a horizontal drag of `dx` pixels from `startVal`. */
export function scrubValue(
  startVal: number,
  dx: number,
  step: number,
  mods: { shiftKey: boolean; altKey: boolean },
  min = -Infinity,
  max = Infinity,
): number {
  return clamp(startVal + dx * step * stepScale(mods), min, max);
}
