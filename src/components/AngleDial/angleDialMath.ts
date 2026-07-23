/**
 * AngleDial math — pure, unit-tested helpers for the rotation dial.
 *
 * Convention (matches AE / the renderer): 0° points UP (12 o'clock) and
 * positive angles turn CLOCKWISE. Values are unbounded — multiple revolutions
 * accumulate (450° = one full turn plus 45°), displayed AE-style as "1x+45°".
 */

/** Angle (deg) of the pointer relative to the dial centre: 0° up, CW positive,
 *  in (-180, 180]. Centre itself maps to 0. */
export function pointerAngleDeg(cx: number, cy: number, px: number, py: number): number {
  const dx = px - cx;
  const dy = py - cy;
  if (dx === 0 && dy === 0) return 0;
  return (Math.atan2(dx, -dy) * 180) / Math.PI;
}

/** Shortest signed angular difference, wrapped into (-180, 180]. Summing these
 *  per pointer-move is what lets a drag accumulate whole revolutions. */
export function wrapDeltaDeg(deg: number): number {
  let d = ((((deg + 180) % 360) + 360) % 360) - 180;
  if (d === -180) d = 180;
  return d;
}

/** Snap to the nearest multiple of `step` (Shift-drag: 15°). */
export function snapAngle(deg: number, step = 15): number {
  if (step <= 0) return deg;
  return Math.round(deg / step) * step;
}

/** Whole revolutions (toward zero) and the remainder within the current turn.
 *  450 → {turns: 1, rem: 90}; -450 → {turns: -1, rem: -90}. */
export function revolutionsOf(deg: number): { turns: number; rem: number } {
  const turns = Math.trunc(deg / 360) || 0; // `|| 0` normalizes -0 → 0
  return { turns, rem: deg - turns * 360 };
}

/** AE-style display: "45°" within the first turn, "1x+45°" / "-2x-30°" beyond. */
export function formatAngle(deg: number): string {
  const fmt = (n: number): string => String(Number(n.toFixed(1)));
  const { turns, rem } = revolutionsOf(deg);
  if (turns === 0) return `${fmt(deg)}°`;
  return `${turns}x${rem >= 0 ? '+' : '-'}${fmt(Math.abs(rem))}°`;
}
