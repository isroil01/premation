/**
 * Speed ramps — varying playback speed over time, as an exact time-remap curve.
 *
 * ── Why you cannot just keyframe "speed" ───────────────────────────
 * Speed is a RATE. The renderer needs to know which source frame to show at a
 * given composition time, which is the INTEGRAL of speed, not speed itself.
 * Keyframing a speed value and sampling it per frame produces a curve whose
 * slope is wrong everywhere: ramp 100% → 50% and the footage does not
 * decelerate, it jumps to a different frame and then plays at some third rate.
 * This is exactly why After Effects makes you shape a Time Remap graph rather
 * than offering a speed track, and why the graph is famously awkward.
 *
 * So the ramp is specified in the units a person thinks in — "100% here, 25%
 * there" — and integrated here into the units the renderer needs.
 *
 * ── Two keyframes, not ninety ──────────────────────────────────────
 * Integrating numerically and writing a keyframe per frame would work and
 * would be terrible: a three-second ramp becomes ninety keyframes, the graph
 * editor becomes unusable, and the document carries the sample rate forever.
 *
 * It is unnecessary. Over a segment where speed moves linearly from v₀ to v₁,
 * source time is a QUADRATIC in composition time — and a cubic Bézier
 * represents any quadratic exactly. Fixing the handles' x at 1/3 and 2/3 makes
 * the Bézier's x-parameter equal to normalized time, and the y handles then
 * fall out of matching coefficients (see `rampBezier`). Two keyframes and one
 * derived curve reproduce the integral with zero error, and the result is a
 * graph a person can grab and edit.
 */

import type { Bezier } from './motionCurves';

/** A speed at a moment. `speed` is a multiplier: 1 = 100%, 0.25 = quarter. */
export interface SpeedPoint {
  /** Composition seconds. */
  t: number;
  /** Playback rate. Negative plays backwards; 0 holds the frame. */
  speed: number;
}

/** One time-remap keyframe: source time at a composition time. */
export interface RemapKey {
  /** Composition seconds. */
  t: number;
  /** Source seconds to show at `t`. */
  value: number;
  /** Easing to the NEXT key. Absent on the last. */
  bezier?: Bezier;
}

/**
 * The exact easing for a segment whose speed moves linearly from `v0` to `v1`.
 *
 * Normalize the segment to u ∈ [0,1] and y ∈ [0,1]. Source time is
 *
 *     y(u) = a·u + b·u²      where a = 2v₀/(v₀+v₁), b = (v₁−v₀)/(v₀+v₁)
 *
 * and a + b = 1, so y(1) = 1 as it must. A cubic Bézier with x handles at 1/3
 * and 2/3 has x(s) = s, so its y is the plain cubic
 *
 *     y(s) = 3y₁·s(1−s)² + 3y₂·s²(1−s) + s³
 *          = 3y₁·s + (3y₂−6y₁)·s² + (3y₁−3y₂+1)·s³
 *
 * Matching coefficients against a·s + b·s² + 0·s³ gives y₁ = a/3 and
 * y₂ = (b+2a)/3, and the cubic term vanishes identically because a + b = 1.
 * The representation is exact, not a fit.
 *
 * Sanity: constant speed gives [1/3, 1/3, 2/3, 2/3] — a straight line, which
 * is what constant speed must be.
 */
export function rampBezier(v0: number, v1: number): Bezier {
  const sum = v0 + v1;
  // A segment that covers no source time (a hold, or a reversal that returns
  // exactly where it started) has no slope to describe. The caller writes a
  // flat segment; the handles here are the linear ones so nothing overshoots.
  if (Math.abs(sum) < 1e-12) return [1 / 3, 1 / 3, 2 / 3, 2 / 3];
  const a = (2 * v0) / sum;
  const b = (v1 - v0) / sum;
  return [1 / 3, a / 3, 2 / 3, (b + 2 * a) / 3];
}

/** Source seconds covered by a segment ramping v0 → v1 over `duration`. */
export function sourceAdvance(v0: number, v1: number, duration: number): number {
  return ((v0 + v1) / 2) * duration;
}

/**
 * Split a segment that changes direction at its zero crossing.
 *
 * A segment from +1 to −1 covers no net source time, so a single curve through
 * it would be a flat line — hiding the fact that the footage plays forward,
 * stops, and rewinds. Splitting at the moment speed passes through zero gives
 * two segments that each move one way, which is what actually happens.
 */
function zeroCrossing(a: SpeedPoint, b: SpeedPoint): number | null {
  if ((a.speed > 0 && b.speed < 0) || (a.speed < 0 && b.speed > 0)) {
    const fraction = a.speed / (a.speed - b.speed);
    return a.t + fraction * (b.t - a.t);
  }
  return null;
}

/**
 * Turn a speed profile into time-remap keyframes.
 *
 * `startSource` is the source time showing at the first point — usually the
 * source time already under the playhead, so a ramp inserted mid-clip
 * continues from the frame that was on screen rather than jumping.
 *
 * Points must be in ascending time; anything else is a caller bug and is
 * sorted rather than trusted, because an out-of-order profile produces a
 * remap curve that runs backwards for one segment and is very hard to read as
 * a cause when you are looking at the footage.
 */
export function buildTimeRemap(points: readonly SpeedPoint[], startSource: number): RemapKey[] {
  const sorted = [...points].sort((p, q) => p.t - q.t);
  if (sorted.length === 0) return [];
  if (sorted.length === 1) return [{ t: sorted[0]!.t, value: startSource }];

  // Insert direction changes so no segment spans a sign flip.
  const expanded: SpeedPoint[] = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const next = sorted[i]!;
    const crossing = zeroCrossing(prev, next);
    if (crossing !== null && crossing > prev.t && crossing < next.t) {
      expanded.push({ t: crossing, speed: 0 });
    }
    expanded.push(next);
  }

  const keys: RemapKey[] = [];
  let source = startSource;
  for (let i = 0; i < expanded.length; i++) {
    const point = expanded[i]!;
    const next = expanded[i + 1];
    if (!next) {
      keys.push({ t: point.t, value: source });
      break;
    }
    keys.push({ t: point.t, value: source, bezier: rampBezier(point.speed, next.speed) });
    source += sourceAdvance(point.speed, next.speed, next.t - point.t);
  }
  return keys;
}

/**
 * The source time a remap curve is showing at `t` — the same evaluation the
 * renderer performs, exposed so a ramp appended to an existing curve can start
 * from the frame already on screen instead of from the clip's head.
 *
 * Cubic Bézier easing between two keys, with x solved by bisection. Bisection
 * rather than Newton because the ramp curves are monotonic but can be very
 * flat near a freeze, where Newton's derivative approaches zero and the step
 * explodes; twenty bisections is exact to well under a frame and cannot
 * diverge.
 */
export function sampleRemap(keys: readonly RemapKey[], t: number): number {
  if (keys.length === 0) return 0;
  const first = keys[0]!;
  if (t <= first.t) return first.value;
  const last = keys[keys.length - 1]!;
  if (t >= last.t) return last.value;

  let i = 0;
  while (i < keys.length - 2 && keys[i + 1]!.t <= t) i++;
  const a = keys[i]!;
  const b = keys[i + 1]!;
  const span = b.t - a.t;
  if (span <= 0) return b.value;
  const u = (t - a.t) / span;

  const handles = a.bezier;
  if (!handles) return a.value + (b.value - a.value) * u;

  const [x1, y1, x2, y2] = handles;
  const bez = (p1: number, p2: number, s: number): number =>
    3 * p1 * s * (1 - s) * (1 - s) + 3 * p2 * s * s * (1 - s) + s * s * s;

  let lo = 0;
  let hi = 1;
  for (let iter = 0; iter < 20; iter++) {
    const mid = (lo + hi) / 2;
    if (bez(x1, x2, mid) < u) lo = mid;
    else hi = mid;
  }
  return a.value + (b.value - a.value) * bez(y1, y2, (lo + hi) / 2);
}
