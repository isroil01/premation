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

/** Insert or replace a keyframe at time `t`, keeping the list sorted. */
export function upsertKeyframe(kfs: Keyframe[], kf: Keyframe): Keyframe[] {
  const next = kfs.filter((k) => k.t !== kf.t);
  next.push(kf);
  next.sort((a, b) => a.t - b.t);
  return next;
}
