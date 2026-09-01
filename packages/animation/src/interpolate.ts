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
      return cubicBezierEase([0.25, 0.1, 0.25, 1], t);
    case 'autoBezier':
    case 'continuousBezier':
      return cubicBezierEase([0.333, 0, 0.667, 1], t);
    case 'easeInOut':
      return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    case 'linear':
    default:
      return t;
  }
}

/**
 * Evaluate a 1D cubic bezier B(u) with endpoints `v0`,`v3` and control VALUES
 * `v1`,`v2` at parameter u∈[0,1]. With v1/v2 at the linear third-points the
 * curve is exactly linear — the identity spatial tangents.
 */
export function cubicValueAt(v0: number, v1: number, v2: number, v3: number, u: number): number {
  const s = u < 0 ? 0 : u > 1 ? 1 : u;
  const m = 1 - s;
  return m * m * m * v0 + 3 * m * m * s * v1 + 3 * m * s * s * v2 + s * s * s * v3;
}

/**
 * Last-served segment index per keyframe ARRAY (not per track object — every
 * mutation path builds a fresh array, so a stale cursor can never outlive the
 * data it indexed). Playback and export sample monotonically, so the next query
 * almost always lands in the same or the following segment; the cursor turns
 * those into O(1) and the binary search below only runs on real jumps.
 */
const segmentCursor = new WeakMap<readonly Keyframe[], number>();

/**
 * Smallest segment index i (0..n-2) with kfs[i].t <= t <= kfs[i+1].t. The
 * caller guarantees first.t < t < last.t. "Smallest" matches what the old
 * linear scan returned, so degenerate duplicate-time keyframes keep resolving
 * to the same segment they always did.
 */
function segmentIndexFor(kfs: readonly Keyframe[], t: number): number {
  const hi0 = kfs.length - 2;
  const cached = segmentCursor.get(kfs);
  if (cached !== undefined && cached >= 0 && cached <= hi0) {
    if (kfs[cached]!.t <= t && t <= kfs[cached + 1]!.t && (cached === 0 || t > kfs[cached]!.t)) {
      return cached;
    }
    const next = cached + 1;
    if (next <= hi0 && kfs[next]!.t < t && t <= kfs[next + 1]!.t) {
      segmentCursor.set(kfs, next);
      return next;
    }
  }
  // Binary search: smallest i with t <= kfs[i+1].t.
  let lo = 0;
  let hi = hi0;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (kfs[mid + 1]!.t >= t) hi = mid;
    else lo = mid + 1;
  }
  segmentCursor.set(kfs, lo);
  return lo;
}

/**
 * Sample a property track at time `t`.
 * - Before the first / after the last keyframe: clamps to the endpoint value.
 * - Between keyframes: interpolates with the segment's easing. When the segment
 *   carries spatial tangents (`a.so` / `b.si`) the value follows a 1D cubic
 *   bezier through them (the shared eased parameter makes x+y trace a true 2D
 *   bezier — curved motion paths).
 * Returns `undefined` when the track has no keyframes.
 */
export function sampleTrack(track: PropertyTrack, t: number): number | undefined {
  const kfs = track.keyframes;
  if (kfs.length === 0) return undefined;
  const first = kfs[0]!;
  const last = kfs[kfs.length - 1]!;
  if (t <= first.t) return first.value;
  if (t >= last.t) return last.value;

  const i = segmentIndexFor(kfs, t);
  const a = kfs[i]!;
  const b = kfs[i + 1]!;
  const kind = a.easing ?? 'linear';
  // Hold/step holds the start value UP TO — but not AT — the next keyframe:
  // at exactly b.t the arriving keyframe's authored value wins, the same as
  // every other easing (which reaches b.value at local=1). Without the
  // `t < b.t` guard a held keyframe that lands on a frame showed its target
  // one frame late — the classic off-by-one at an interior keyframe (the
  // last-keyframe clamp above hid it for the final key only).
  if (kind === 'step' || kind === 'hold') return t < b.t ? a.value : b.value;
  const span = b.t - a.t;
  const local = span <= 0 ? 0 : (t - a.t) / span;
  const eased =
    (kind === 'bezier' || kind === 'autoBezier' || kind === 'continuousBezier') && a.bezier
      ? cubicBezierEase(a.bezier, local)
      : ease(kind, local);
  if (a.so !== undefined || b.si !== undefined) {
    const third = (b.value - a.value) / 3; // linear default for the missing side
    const c1 = a.value + (a.so ?? third);
    const c2 = b.value + (b.si ?? -third);
    return cubicValueAt(a.value, c1, c2, b.value, eased);
  }
  return a.value + (b.value - a.value) * eased;
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

/**
 * Reposition roving keyframes on a PAIRED x/y track for constant speed along
 * the 2D SPATIAL path — After Effects' actual "Rove Across Time". Per-track
 * `applyRoving` roves each axis by its own |value| distance, which is only
 * constant-speed while the path is axis-aligned: on a curved path, x and y
 * roved independently disagree about where the keyframe belongs and the dot
 * speeds up through every bend. Here each segment's true arc length is
 * measured by sampling the 2D trajectory (easing + spatial tangents included —
 * the traced point set is retime-invariant, only speed along it changes), and
 * both axes are retimed together from the cumulative arc.
 *
 * Returns null when the two tracks don't share an aligned grid (same count,
 * same times, same roving flags) — the caller falls back to per-track roving,
 * which is the only meaningful reading of a half-roved pair. Pure.
 */
export function applyRovingSpatial(
  xKfs: Keyframe[],
  yKfs: Keyframe[],
): { x: Keyframe[]; y: Keyframe[] } | null {
  if (xKfs.length !== yKfs.length || xKfs.length < 3) return null;
  for (let i = 0; i < xKfs.length; i++) {
    if (xKfs[i]!.t !== yKfs[i]!.t) return null;
    if ((xKfs[i]!.roving === true) !== (yKfs[i]!.roving === true)) return null;
  }
  const xs = xKfs.map((k) => ({ ...k }));
  const ys = yKfs.map((k) => ({ ...k }));

  /** 2D arc length of one keyframe-to-keyframe segment, by dense sampling. */
  const segArc = (i: number): number => {
    const tx: PropertyTrack = { nodeId: '', prop: 'x', keyframes: [xs[i]!, xs[i + 1]!] };
    const ty: PropertyTrack = { nodeId: '', prop: 'y', keyframes: [ys[i]!, ys[i + 1]!] };
    const t0 = xs[i]!.t;
    const t1 = xs[i + 1]!.t;
    // A zero-width segment still has geometric length if values jump; the
    // straight-line distance is exactly its arc.
    if (!(t1 > t0)) {
      return Math.hypot(xs[i + 1]!.value - xs[i]!.value, ys[i + 1]!.value - ys[i]!.value);
    }
    const N = 64;
    let len = 0;
    let px = 0;
    let py = 0;
    for (let s = 0; s <= N; s++) {
      const tt = t0 + ((t1 - t0) * s) / N;
      const vx = sampleTrack(tx, tt)!;
      const vy = sampleTrack(ty, tt)!;
      if (s > 0) len += Math.hypot(vx - px, vy - py);
      px = vx;
      py = vy;
    }
    return len;
  };

  let i = 0;
  while (i < xs.length) {
    if (!xs[i]!.roving) { i++; continue; }
    const startAnchor = i - 1;
    let j = i;
    while (j < xs.length && xs[j]!.roving) j++;
    const endAnchor = j;
    if (startAnchor < 0 || endAnchor >= xs.length) { i = j; continue; } // unbounded run
    // Cumulative arc across the run's segments, measured BEFORE any retiming
    // in this run mutates segment spans (values never change, so segment
    // geometry is stable; only the sampling parameter needs the original
    // spans, and segArc reads times off the copies — so measure first).
    let total = 0;
    const cum: number[] = [0];
    for (let k = startAnchor; k < endAnchor; k++) {
      total += segArc(k);
      cum.push(total);
    }
    const a = xs[startAnchor]!;
    const b = xs[endAnchor]!;
    const tSpan = b.t - a.t;
    const runLen = endAnchor - i;
    for (let k = 0; k < runLen; k++) {
      const frac = total > 0 ? cum[k + 1]! / total : (k + 1) / (runLen + 1);
      const nt = a.t + frac * tSpan;
      xs[i + k]!.t = nt;
      ys[i + k]!.t = nt;
    }
    i = j;
  }
  return { x: xs, y: ys };
}

/**
 * Auto-bezier ("smooth path"): give every keyframe Catmull-Rom-style spatial
 * tangents so the value curve is C1-continuous through the points. The slope at
 * an interior keyframe is the chord through its neighbours; endpoints use the
 * one-sided slope (curve leaves/arrives straight). Offsets are scaled by each
 * segment's own duration ÷ 3, so non-uniform keyframe spacing stays smooth.
 * Pure — returns copies, never mutates.
 */
export function smoothTrackTangents(kfs: Keyframe[]): Keyframe[] {
  if (kfs.length < 2) return kfs.map((k) => ({ ...k }));
  const out = kfs.map((k) => ({ ...k }));
  const slope = (i: number): number => {
    const prev = out[Math.max(0, i - 1)]!;
    const next = out[Math.min(out.length - 1, i + 1)]!;
    const dt = next.t - prev.t;
    return dt > 0 ? (next.value - prev.value) / dt : 0;
  };
  for (let i = 0; i < out.length; i++) {
    const k = out[i]!;
    const m = slope(i);
    if (i < out.length - 1) k.so = (m * (out[i + 1]!.t - k.t)) / 3;
    else delete k.so;
    if (i > 0) k.si = (-m * (k.t - out[i - 1]!.t)) / 3;
    else delete k.si;
  }
  return out;
}

/** Remove all spatial tangents (straight-line path). Pure — returns copies. */
export function clearTrackTangents(kfs: Keyframe[]): Keyframe[] {
  return kfs.map((k) => {
    const next = { ...k };
    delete next.si;
    delete next.so;
    return next;
  });
}

/** Insert or replace a keyframe at time `t`, keeping the list sorted. */
export function upsertKeyframe(kfs: Keyframe[], kf: Keyframe): Keyframe[] {
  const next = kfs.filter((k) => k.t !== kf.t);
  next.push(kf);
  next.sort((a, b) => a.t - b.t);
  return next;
}
