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

/**
 * Largest per-event pointer movement a scrub will believe, in px.
 *
 * Chromium reports one enormous `movementX` on the event that acquires pointer
 * lock (the jump from the real cursor position to the locked origin). Believed
 * literally it threw the value thousands of units off the instant the drag got
 * long enough to lock — the exact gesture the lock exists to support.
 */
export const MAX_SCRUB_MOVEMENT_PX = 300;

/** Clamp one pointer-move delta into the believable range. */
export function sanitizeMovement(dx: number): number {
  if (!Number.isFinite(dx)) return 0;
  return clamp(dx, -MAX_SCRUB_MOVEMENT_PX, MAX_SCRUB_MOVEMENT_PX);
}

/**
 * A scrub in progress.
 *
 * `anchorVal` + `dx` rather than "start value + total travel" because the
 * modifier scale can change MID-DRAG. Multiplying the whole accumulated travel
 * by the new scale — which is what the old code did — teleported the value:
 * press Shift 40px into a drag and it jumped from +40 to +400 instead of
 * merely getting coarser from that point on. Re-anchoring at the moment the
 * modifier changes makes Shift/Alt a change of GEAR, not of position.
 */
export interface ScrubState {
  /** Value this modifier segment started from. */
  anchorVal: number;
  /** Pixels travelled since the anchor. */
  dx: number;
  /** Modifier multiplier in force for this segment. */
  scale: number;
  /** Latest value the scrub has produced. */
  value: number;
}

/** Open a scrub at `startVal` with whatever modifiers are already held. */
export function beginScrub(
  startVal: number,
  mods: { shiftKey: boolean; altKey: boolean },
): ScrubState {
  return { anchorVal: startVal, dx: 0, scale: stepScale(mods), value: startVal };
}

/**
 * Advance a scrub by one pointer-move delta, re-anchoring if the modifier
 * scale changed since the previous move.
 */
export function advanceScrub(
  state: ScrubState,
  movementX: number,
  step: number,
  mods: { shiftKey: boolean; altKey: boolean },
  min = -Infinity,
  max = Infinity,
): ScrubState {
  const scale = stepScale(mods);
  const rebased = scale !== state.scale
    ? { anchorVal: state.value, dx: 0, scale, value: state.value }
    : state;
  const dx = rebased.dx + sanitizeMovement(movementX);
  const raw = rebased.anchorVal + dx * step * scale;
  const value = clamp(raw, min, max);
  /*
   * AT A LIMIT, RE-ANCHOR — do not keep winding `dx` past it.
   *
   * `dx` accumulated forever, so travel spent beyond a limit had to be PAID
   * BACK before the value moved again: drag a 0-floored field 200px left and
   * the next 200px to the right did nothing at all. That is the whole of "you
   * can't change the value by dragging it" — the field is not dead, it is
   * unwinding, and the commonest fields to meet it on are the ones that START
   * at a limit (a corner radius at 0, an opacity at 100).
   *
   * Re-anchoring at the clamped value makes a limit a WALL rather than a
   * spring: the value leaves it on the first pixel of travel back.
   */
  if (value !== raw) return { anchorVal: value, dx: 0, scale, value };
  return { anchorVal: rebased.anchorVal, dx, scale, value };
}
