/**
 * Pure interpolation + easing — the single source of sampling math, shared by
 * the AnimationEngine and unit tests.
 */

import type { BezierHandles, EasingKind, Keyframe, PropertyTrack } from './types';

/**
 * Evaluate a cubic-bezier easing y for input x (both 0..1), control points
 * [x1,y1,x2,y2] with implicit P0=(0,0), P3=(1,1). Solves x(s)=x by Newton's
 * method then returns y(s). Matches CSS cubic-bezier semantics.
 */
export function cubicBezierEase([x1, y1, x2, y2]: BezierHandles, x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sampleX = (s: number): number => ((ax * s + bx) * s + cx) * s;
  const sampleY = (s: number): number => ((ay * s + by) * s + cy) * s;
  const dX = (s: number): number => (3 * ax * s + 2 * bx) * s + cx;
  let s = t;
  for (let i = 0; i < 8; i++) {
    const dx = sampleX(s) - t;
    if (Math.abs(dx) < 1e-5) break;
    const d = dX(s);
    if (Math.abs(d) < 1e-6) break;
    s -= dx / d;
  }
  return sampleY(Math.max(0, Math.min(1, s)));
}

/** Remap a normalized 0..1 segment position through an easing curve. */
export function ease(kind: EasingKind, x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  switch (kind) {
    case 'step':
      return 0; // handled by the sampler (holds the start value); return start
    case 'easeIn':
      return t * t;
    case 'easeOut':
      return t * (2 - t);
    case 'ease':
    case 'easeInOut':
      return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    case 'linear':
    default:
      return t;
  }
}

/**
 * Sample a property track at time `t`.
 * - Before the first / after the last keyframe: clamps to the endpoint value.
 * - Between keyframes: interpolates with the segment's easing.
 * Returns `undefined` when the track has no keyframes.
 */
export function sampleTrack(track: PropertyTrack, t: number): number | undefined {
  const kfs = track.keyframes;
  if (kfs.length === 0) return undefined;
  const first = kfs[0]!;
  const last = kfs[kfs.length - 1]!;
  if (t <= first.t) return first.value;
  if (t >= last.t) return last.value;

  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]!;
    const b = kfs[i + 1]!;
    if (t >= a.t && t <= b.t) {
      const kind = a.easing ?? 'linear';
      if (kind === 'step') return a.value;
      const span = b.t - a.t;
      const local = span <= 0 ? 0 : (t - a.t) / span;
      const eased =
        kind === 'bezier' && a.bezier ? cubicBezierEase(a.bezier, local) : ease(kind, local);
      return a.value + (b.value - a.value) * eased;
    }
  }
  return last.value;
}

/**
 * Sample the track's SPEED (value units per second) at time `t` — the slope of
 * the value curve, via a symmetric finite difference. Feeds the speed-graph
 * view. Returns 0 for an empty/flat track or outside the keyframe range.
 */
export function sampleSpeed(track: PropertyTrack, t: number, dt = 1 / 240): number {
  const a = sampleTrack(track, t - dt);
  const b = sampleTrack(track, t + dt);
  if (a === undefined || b === undefined) return 0;
  return (b - a) / (2 * dt);
}

/** After Effects "Easy Ease" — cubic bezier with ~33% influence each side. */
export const EASY_EASE_BEZIER: BezierHandles = [1 / 3, 0, 2 / 3, 1];
/** Easy Ease Out only (fast-in, ease to a stop). */
export const EASY_EASE_OUT_BEZIER: BezierHandles = [0, 0, 2 / 3, 1];
/** Easy Ease In only (ease from a stop, fast-out). */
export const EASY_EASE_IN_BEZIER: BezierHandles = [1 / 3, 0, 1, 1];

/**
 * Reposition roving keyframes for constant speed. A maximal run of `roving`
 * keyframes bounded by two non-roving anchors is retimed so each keyframe sits
 * at the fraction of the time span equal to its cumulative |value| distance
 * from the start anchor — i.e. the value moves at a constant rate through them.
 * Values are never changed; end keyframes (no bounding anchor) never rove. Pure.
 */
export function applyRoving(kfs: Keyframe[]): Keyframe[] {
  if (kfs.length < 3) return kfs.map((k) => ({ ...k }));
  const out = kfs.map((k) => ({ ...k }));
  let i = 0;
  while (i < out.length) {
    if (!out[i]!.roving) { i++; continue; }
    const startAnchor = i - 1;
    let j = i;
    while (j < out.length && out[j]!.roving) j++;
    const endAnchor = j; // first non-roving after the run
    if (startAnchor < 0 || endAnchor >= out.length) { i = j; continue; } // unbounded run
    const a = out[startAnchor]!;
    const b = out[endAnchor]!;
    const run = out.slice(i, endAnchor);
    const seq = [a, ...run, b];
    let total = 0;
    const cum: number[] = [0];
    for (let k = 1; k < seq.length; k++) {
      total += Math.abs(seq[k]!.value - seq[k - 1]!.value);
      cum.push(total);
    }
    const tSpan = b.t - a.t;
    for (let k = 0; k < run.length; k++) {
      const frac = total > 0 ? cum[k + 1]! / total : (k + 1) / (run.length + 1);
      out[i + k]!.t = a.t + frac * tSpan;
    }
    i = j;
  }
  return out;
}

/** Insert or replace a keyframe at time `t`, keeping the list sorted. */
export function upsertKeyframe(kfs: Keyframe[], kf: Keyframe): Keyframe[] {
  const next = kfs.filter((k) => k.t !== kf.t);
  next.push(kf);
  next.sort((a, b) => a.t - b.t);
  return next;
}
