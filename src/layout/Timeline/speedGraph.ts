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

import { isHoldKind } from '@core/animation/easingVocabulary';

export type Bezier = [number, number, number, number];

/** Below this an influence is treated as zero-width and the solve is skipped. */
const MIN_INFLUENCE = 1e-4;
/** AE clamps handle y to a band around the segment; overshoot is legal, runaway is not. */
const MIN_Y = -2;
const MAX_Y = 3;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Average speed (magnitude, >= 0) across a segment — the scale everything else is relative to. */
export function averageSpeed(dv: number, dt: number): number {
  return dt === 0 ? 0 : Math.abs(dv) / dt;
}

/** Speed (units/s, >= 0) leaving the segment's FIRST keyframe. */
export function outgoingSpeed(bezier: Bezier, dv: number, dt: number): number {
  const [x1, y1] = bezier;
  if (x1 < MIN_INFLUENCE) return 0;
  return Math.max(0, averageSpeed(dv, dt) * (y1 / x1));
}

/** Speed (units/s, >= 0) arriving at the segment's SECOND keyframe. */
export function incomingSpeed(bezier: Bezier, dv: number, dt: number): number {
  const [, , x2, y2] = bezier;
  const run = 1 - x2;
  if (run < MIN_INFLUENCE) return 0;
  return Math.max(0, averageSpeed(dv, dt) * ((1 - y2) / run));
}

/**
 * Solve for the bezier that gives `speed` (units/s >= 0) leaving the first keyframe, holding
 * influence (x1) fixed.
 *
 * Returns the input unchanged when the segment has no value change or no
 * duration — with dv = 0 every speed is 0 and there is nothing to solve.
 */
export function withOutgoingSpeed(bezier: Bezier, dv: number, dt: number, speed: number): Bezier {
  const avg = averageSpeed(dv, dt);
  if (avg === 0) return bezier;
  const [x1, , x2, y2] = bezier;
  const safeSpeed = Math.max(0, speed);
  const influence = clamp(x1, MIN_INFLUENCE, 0.999);
  return [influence, clamp((safeSpeed / avg) * influence, 0, MAX_Y), x2, y2];
}

/** Solve for the bezier that gives `speed` (units/s >= 0) arriving at the second keyframe. */
export function withIncomingSpeed(bezier: Bezier, dv: number, dt: number, speed: number): Bezier {
  const avg = averageSpeed(dv, dt);
  if (avg === 0) return bezier;
  const [x1, y1, x2] = bezier;
  const safeSpeed = Math.max(0, speed);
  const run = clamp(1 - x2, MIN_INFLUENCE, 0.999);
  return [x1, y1, 1 - run, clamp(1 - (safeSpeed / avg) * run, 1 - MAX_Y, 1)];
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
  const next: Bezier = [clamp(influence, MIN_INFLUENCE, 0.999), bezier[1], bezier[2], bezier[3]];
  return withOutgoingSpeed(next, dv, dt, speed);
}

/** Set the incoming influence, preserving the SPEED it currently expresses. */
export function withIncomingInfluence(bezier: Bezier, dv: number, dt: number, influence: number): Bezier {
  const speed = incomingSpeed(bezier, dv, dt);
  const next: Bezier = [bezier[0], bezier[1], 1 - clamp(influence, MIN_INFLUENCE, 0.999), bezier[3]];
  return withIncomingSpeed(next, dv, dt, speed);
}

// ── Keyframe → bezier resolution ──────────────────────────────────

/**
 * Hold keyframes — the scalar engine spells them 'step', the data sampler
 * 'hold'. Kept as a named re-export rather than a second copy of the test: the
 * two spellings are ONE fact, reconciled in `easingVocabulary` with everything
 * else the graph editor and the Motion panel used to disagree about.
 */
export const isHoldEasing = isHoldKind;

/** The cubic-bezier equivalent of linear — handles at ⅓ along the segment. */
export const LINEAR_BEZIER: Bezier = [1 / 3, 1 / 3, 2 / 3, 2 / 3];

/**
 * cubic-bezier approximations of the named easings the sampler evaluates
 * analytically. Used ONLY to seed a handle drag, so the first drag starts from
 * the curve the user can see instead of jumping to a stale `kf.bezier`.
 */
const NAMED_EASING_BEZIER: Record<string, Bezier> = {
  linear: LINEAR_BEZIER,
  ease: [0.25, 0.1, 0.25, 1],
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
  autoBezier: [0.333, 0, 0.667, 1],
  continuousBezier: [0.333, 0, 0.667, 1],
};

/**
 * The bezier the sampler ACTUALLY uses for the segment leaving `kf`.
 *
 * A keyframe keeps its `bezier` field after its easing is switched to a named
 * curve ('Linear' preset → easing: 'linear', bezier untouched). Reading
 * `kf.bezier ?? LINEAR` therefore resurrects a stale shape on the first drag
 * — the curve visibly jumps. Resolve through the easing instead.
 */
export function effectiveBezier(kf: { easing?: string; bezier?: readonly number[] }): Bezier {
  const e = kf.easing;
  if ((e === 'bezier' || e === 'autoBezier' || e === 'continuousBezier') && kf.bezier && kf.bezier.length === 4) {
    return [kf.bezier[0]!, kf.bezier[1]!, kf.bezier[2]!, kf.bezier[3]!];
  }
  return NAMED_EASING_BEZIER[e ?? 'linear'] ?? LINEAR_BEZIER;
}

// ── Signed slopes (value graph) ───────────────────────────────────
//
// The value graph's "linked handles" mean COLLINEAR tangents: the same signed
// dv/dt on both sides of the keyframe. Speed (above) is unsigned — so the
// value-graph solvers live here, in value units per second, with the sign.

/** Signed dv/dt leaving the segment's first keyframe. */
export function outgoingSlope(bezier: Bezier, dv: number, dt: number): number {
  const [x1, y1] = bezier;
  if (dt === 0 || x1 < MIN_INFLUENCE) return 0;
  return (dv / dt) * (y1 / x1);
}

/** Signed dv/dt arriving at the segment's second keyframe. */
export function incomingSlope(bezier: Bezier, dv: number, dt: number): number {
  const [, , x2, y2] = bezier;
  const run = 1 - x2;
  if (dt === 0 || run < MIN_INFLUENCE) return 0;
  return (dv / dt) * ((1 - y2) / run);
}

/**
 * Solve y1 so the segment LEAVES at `slope` (signed), holding influence x1.
 * A flat segment (dv = 0) cannot express a slope through y — returned as is.
 */
export function withOutgoingSlope(bezier: Bezier, dv: number, dt: number, slope: number): Bezier {
  if (dv === 0 || dt === 0) return bezier;
  const [x1, , x2, y2] = bezier;
  const influence = clamp(x1, MIN_INFLUENCE, 0.999);
  return [influence, clamp((slope * dt * influence) / dv, MIN_Y, MAX_Y), x2, y2];
}

/** Solve y2 so the segment ARRIVES at `slope` (signed), holding influence 1 − x2. */
export function withIncomingSlope(bezier: Bezier, dv: number, dt: number, slope: number): Bezier {
  if (dv === 0 || dt === 0) return bezier;
  const [x1, y1, x2] = bezier;
  const run = clamp(1 - x2, MIN_INFLUENCE, 0.999);
  return [x1, y1, 1 - run, clamp(1 - (slope * dt * run) / dv, 1 - MAX_Y, 1 - MIN_Y)];
}
