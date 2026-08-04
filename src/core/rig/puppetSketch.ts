/**
 * Puppet Sketch — record a pin's motion in real time while the composition
 * plays, then reduce the raw sample stream to a handful of eased keyframes.
 *
 * AE's version: hold a modifier and drag a pin during playback; the motion is
 * captured live. The part that makes it USABLE rather than a keyframe swamp is
 * the reduction afterwards — one keyframe per sampled frame is unusable, so the
 * path is simplified with Douglas–Peucker to the fewest points that still stay
 * within `tolerance` px of the recorded curve, and the survivors are eased.
 *
 * Pure and framework-free: the overlay feeds it samples and writes the result.
 * Deterministic — no clock is read here (the caller stamps each sample with the
 * playhead time it belongs to), no randomness, fixed algorithms.
 */

export interface SketchSample {
  /** Layer-local REST-space position of the pin at this instant. */
  x: number;
  y: number;
  /** Keyframe-axis time this sample belongs to. */
  t: number;
}

export interface SketchKeyframe {
  t: number;
  value: Array<{ x: number; y: number }>;
  easing?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';
}

/** Default simplification tolerance in layer-local px. */
export const DEFAULT_SKETCH_TOLERANCE = 2;

/** Perpendicular distance from p to the segment a→b (0 when a==b). */
function perpDistance(
  p: SketchSample,
  a: SketchSample,
  b: SketchSample,
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/**
 * Douglas–Peucker on the SPATIAL path. Iterative (explicit stack) so a long
 * recording cannot blow the call stack, and deterministic: ties resolve to the
 * lowest index, and the survivor set is returned in time order.
 */
export function simplifySketch(
  samples: readonly SketchSample[],
  tolerance = DEFAULT_SKETCH_TOLERANCE,
): SketchSample[] {
  const n = samples.length;
  if (n <= 2) return samples.slice();
  const tol = Math.max(0, tolerance);

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!;
    if (hi - lo < 2) continue;
    let worst = -1;
    let worstD = tol;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDistance(samples[i]!, samples[lo]!, samples[hi]!);
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst < 0) continue; // whole span is within tolerance — drop the middle
    keep[worst] = 1;
    stack.push([lo, worst], [worst, hi]);
  }

  const out: SketchSample[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(samples[i]!);
  return out;
}

/**
 * Drop samples that sit within `minTimeGap` of the previously kept one. Real
 * pointer streams bunch up when the pointer pauses, and a cluster of keyframes
 * at nearly the same time makes the curve editor unusable. The first and last
 * samples are always kept so the recording's span is exact.
 */
export function thinByTime(
  samples: readonly SketchSample[],
  minTimeGap: number,
): SketchSample[] {
  if (samples.length <= 2 || minTimeGap <= 0) return samples.slice();
  const out: SketchSample[] = [samples[0]!];
  for (let i = 1; i < samples.length - 1; i++) {
    if (samples[i]!.t - out[out.length - 1]!.t >= minTimeGap) out.push(samples[i]!);
  }
  out.push(samples[samples.length - 1]!);
  return out;
}

/**
 * Collapse runs of samples sharing a time to their LAST entry. Input must be
 * sorted by `t`. Two samples at the same instant are not a curve — the later one
 * is simply the more current reading.
 */
export function dedupeByTime(samples: readonly SketchSample[]): SketchSample[] {
  if (samples.length <= 1) return samples.slice();
  const out: SketchSample[] = [];
  for (const s of samples) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.t - s.t) < 1e-9) out[out.length - 1] = s;
    else out.push(s);
  }
  return out;
}

/**
 * Turn a raw sample stream into keyframes: thin by time, simplify spatially,
 * then ease. Interior keyframes get `easeInOut` so the reduced path reads as
 * smooth motion rather than a polyline — this is why simplification depends on
 * easing existing at all. The endpoints ease out of / into rest.
 *
 * `simplify: false` keeps every surviving sample. It exists because the
 * spatial reduction is SPATIAL: Douglas–Peucker drops any point lying on the
 * chord between its neighbours regardless of how much time it accounts for, so
 * a stationary hold collapses to a straight drift. `tolerance: 0` does not
 * express "keep everything" — the test is `distance > tol`, and a collinear
 * point is at distance 0 — so a caller that needs the timing preserved needs
 * this flag rather than a smaller number. Motion Sketch is that caller.
 */
export function sketchToKeyframes(
  samples: readonly SketchSample[],
  opts?: { tolerance?: number; minTimeGap?: number; ease?: boolean; simplify?: boolean },
): SketchKeyframe[] {
  if (samples.length === 0) return [];
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  // Collapse samples that share a time, keeping the LAST (most current)
  // position. Without this, recording while the comp is PAUSED — a perfectly
  // ordinary thing to do — writes one keyframe per pointer sample all stacked
  // on the same instant: degenerate data the curve editor cannot show and the
  // sampler resolves arbitrarily. Verified live: a paused Ctrl-drag produced 13
  // keyframes at t=0.
  const deduped = dedupeByTime(sorted);
  const thinned = thinByTime(deduped, opts?.minTimeGap ?? 0);
  const simplified = opts?.simplify === false
    ? thinned
    : simplifySketch(thinned, opts?.tolerance ?? DEFAULT_SKETCH_TOLERANCE);
  const ease = opts?.ease !== false;
  const last = simplified.length - 1;
  return simplified.map((s, i) => {
    const kf: SketchKeyframe = { t: s.t, value: [{ x: s.x, y: s.y }] };
    if (ease && simplified.length > 1) {
      kf.easing = i === 0 ? 'easeOut' : i === last ? 'easeIn' : 'easeInOut';
    }
    return kf;
  });
}

/**
 * Accumulates samples during a live recording. Kept as a tiny class so the
 * overlay does not grow yet another ref-juggling block, and so the reduction
 * above can be unit-tested independently of any pointer plumbing.
 */
export class SketchRecorder {
  private samples: SketchSample[] = [];

  /** Record one sample. Out-of-order times are tolerated (sorted on finish). */
  add(x: number, y: number, t: number): void {
    this.samples.push({ x, y, t });
  }

  get count(): number {
    return this.samples.length;
  }

  /** Raw stream, for diagnostics/tests. */
  raw(): readonly SketchSample[] {
    return this.samples;
  }

  /** Reduce to keyframes and reset. Returns [] for an empty recording. */
  finish(opts?: { tolerance?: number; minTimeGap?: number; ease?: boolean }): SketchKeyframe[] {
    const out = sketchToKeyframes(this.samples, opts);
    this.samples = [];
    return out;
  }

  reset(): void {
    this.samples = [];
  }
}
