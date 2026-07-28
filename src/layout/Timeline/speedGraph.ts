/**
 * Speed-graph maths — turning a vertical drag into a bezier.
 *
 * The speed graph plots dv/dt. It was read-only vertically, which removes the
 * point of having one: the reason AE ships a speed graph is that "this keyframe
 * leaves at 240 px/s" is the thing you actually want to control, and shaping it
 * through the value curve's handles is indirect guesswork.
 *
 * ── The model ────────────────────────────────────────────────────────
 * A segment from A(t0,v0) to B(t1,v1) with timing bezier [x1,y1,x2,y2] has
 * value(t) = v0 + (v1−v0)·y(x), x = (t−t0)/(t1−t0). So
 *
 *     dv/dt = averageSpeed · dy/dx,      averageSpeed = (v1−v0)/(t1−t0)
 *
 * and for a cubic with control points (0,0),(x1,y1),(x2,y2),(1,1):
 *
 *     dy/dx at x=0  =  y1 / x1          (leaving A)
 *     dy/dx at x=1  =  (1−y2) / (1−x2)  (arriving at B)
 *
 * So SPEED is the handle's y and INFLUENCE is its x — the two are independent,
 * which is exactly AE's split. Dragging vertically in the speed graph therefore
 * solves for y with x held: `y1 = speed · x1 / averageSpeed`.
 *
 * Everything here is pure so the algebra is testable without a canvas.
 */

export type Bezier = [number, number, number, number];

/** Below this an influence is treated as zero-width and the solve is skipped. */
const MIN_INFLUENCE = 1e-4;
/** AE clamps handle y to a band around the segment; overshoot is legal, runaway is not. */
const MIN_Y = -2;
const MAX_Y = 3;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Average speed across a segment — the scale everything else is relative to. */
export function averageSpeed(dv: number, dt: number): number {
  return dt === 0 ? 0 : dv / dt;
}

/** Speed leaving the segment's FIRST keyframe. */
export function outgoingSpeed(bezier: Bezier, dv: number, dt: number): number {
  const [x1, y1] = bezier;
  if (x1 < MIN_INFLUENCE) return 0;
  return averageSpeed(dv, dt) * (y1 / x1);
}

/** Speed arriving at the segment's SECOND keyframe. */
export function incomingSpeed(bezier: Bezier, dv: number, dt: number): number {
  const [, , x2, y2] = bezier;
  const run = 1 - x2;
  if (run < MIN_INFLUENCE) return 0;
  return averageSpeed(dv, dt) * ((1 - y2) / run);
}

/**
 * Solve for the bezier that gives `speed` leaving the first keyframe, holding
 * influence (x1) fixed.
 *
 * Returns the input unchanged when the segment has no value change or no
 * duration — with dv = 0 every speed is 0 and there is nothing to solve, so
 * pretending otherwise would write a meaningless handle.
 */
export function withOutgoingSpeed(bezier: Bezier, dv: number, dt: number, speed: number): Bezier {
  const avg = averageSpeed(dv, dt);
  if (avg === 0) return bezier;
  const [x1, , x2, y2] = bezier;
  const influence = Math.max(x1, MIN_INFLUENCE);
  return [influence, clamp((speed / avg) * influence, MIN_Y, MAX_Y), x2, y2];
}

/** Solve for the bezier that gives `speed` arriving at the second keyframe. */
export function withIncomingSpeed(bezier: Bezier, dv: number, dt: number, speed: number): Bezier {
  const avg = averageSpeed(dv, dt);
  if (avg === 0) return bezier;
  const [x1, y1, x2] = bezier;
  const run = Math.max(1 - x2, MIN_INFLUENCE);
  return [x1, y1, x2, clamp(1 - (speed / avg) * run, MIN_Y, MAX_Y)];
}

/**
 * The influence (0..1) of each side — the handle's horizontal reach, which is
 * what a HORIZONTAL drag in the speed graph edits.
 */
export function influences(bezier: Bezier): { out: number; in: number } {
  return { out: bezier[0], in: 1 - bezier[2] };
}

/** Set the outgoing influence, preserving the SPEED it currently expresses. */
export function withOutgoingInfluence(bezier: Bezier, dv: number, dt: number, influence: number): Bezier {
  const speed = outgoingSpeed(bezier, dv, dt);
  const next: Bezier = [clamp(influence, MIN_INFLUENCE, 1), bezier[1], bezier[2], bezier[3]];
  return withOutgoingSpeed(next, dv, dt, speed);
}

/** Set the incoming influence, preserving the SPEED it currently expresses. */
export function withIncomingInfluence(bezier: Bezier, dv: number, dt: number, influence: number): Bezier {
  const speed = incomingSpeed(bezier, dv, dt);
  const next: Bezier = [bezier[0], bezier[1], 1 - clamp(influence, MIN_INFLUENCE, 1), bezier[3]];
  return withIncomingSpeed(next, dv, dt, speed);
}
