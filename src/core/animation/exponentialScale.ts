/**
 * Exponential Scale — AE's keyframe assistant, and the reason it exists.
 *
 * A linear scale animation does not LOOK linear. Going 100% → 800% over two
 * seconds, the first half covers 100→450 and the second 450→800: the same
 * number of percentage points, but the first is a 4.5× zoom and the second is
 * 1.8×. The eye reads zoom as a RATIO, so a linear ramp appears to start fast
 * and grind to a halt. Every "fly into the map" shot hits this.
 *
 * The fix is to interpolate geometrically instead — constant ratio per unit
 * time, which is what "exponential" names:
 *
 *     s(t) = s0 · (s1 / s0) ^ ((t − t0) / (t1 − t0))
 *
 * At the midpoint of 100 → 400 that is 200, not 250. Equivalently: the
 * LOGARITHM of the scale moves linearly.
 *
 * ## Why it bakes keyframes instead of being an easing
 *
 * It could have been an interpolation mode on the segment. It is a bake, for
 * the same reason AE bakes it: the result stays editable as ordinary
 * keyframes, so a user can drag one of them afterwards. An easing mode would
 * be all-or-nothing and would need a UI of its own on every property that
 * might want it.
 *
 * ## The boundary this cannot cross
 *
 * A ratio needs both endpoints strictly positive, and both ways of breaking
 * that produce NaN — measured, because the intuition here is wrong:
 *
 *   s0 = 0  →  s1/s0 is Infinity, Infinity^k is Infinity, and 0 · Infinity is
 *              NaN. ("0 times anything is 0" is the reasoning that talks you
 *              out of needing this guard, and it does not hold here.)
 *   s0 < 0  →  a negative base to a fractional power is NaN outright.
 *
 * So the assistant REFUSES rather than writing those values, and says why — a
 * track silently filled with NaN renders as a layer that has vanished, with
 * nothing in the UI to search for.
 */

import { defaultAnimation, type Keyframe } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { getTimelineController } from '@core/timeline/TimelineController';

/** Scale props this assistant will act on. */
export const SCALE_PROPS = ['scaleX', 'scaleY'] as const;

export interface ExpScaleRange {
  /** Seconds. */
  t0: number;
  t1: number;
  /** Values at those times; both must be > 0. */
  s0: number;
  s1: number;
}

export type ExpScaleRefusal =
  | 'needs-two-keyframes'
  | 'non-positive-scale'
  | 'zero-duration';

/**
 * The geometric value at time `t`.
 *
 * Exported because it is the whole claim of this module, and a caller that
 * wants to preview the curve should read the same function the bake writes —
 * not a second copy of the formula.
 */
export function exponentialScaleAt(range: ExpScaleRange, t: number): number {
  const { t0, t1, s0, s1 } = range;
  if (t1 === t0) return s0;
  const k = (t - t0) / (t1 - t0);
  return s0 * Math.pow(s1 / s0, k);
}

/**
 * Why a range cannot be baked, or null when it can.
 *
 * Separate from the bake so the UI can grey the command out with a reason
 * rather than letting the user run it and get nothing.
 */
export function refuseExponentialScale(range: ExpScaleRange): ExpScaleRefusal | null {
  if (range.t1 <= range.t0) return 'zero-duration';
  if (!(range.s0 > 0) || !(range.s1 > 0)) return 'non-positive-scale';
  return null;
}

export const REFUSAL_TEXT: Record<ExpScaleRefusal, string> = {
  'needs-two-keyframes': 'Exponential Scale needs at least two scale keyframes.',
  'non-positive-scale': 'Exponential Scale needs both scale values above zero — a ratio through 0 has no exponential path.',
  'zero-duration': 'Exponential Scale needs the two keyframes at different times.',
};

/**
 * Bake `range` into one keyframe per frame at `fps`, endpoints included.
 *
 * Endpoints are written from the ORIGINAL s0/s1 rather than from the formula.
 * The formula reproduces them exactly in theory, and in floating point
 * `s0 · (s1/s0)^1` is not always bit-identical to `s1` — which would move the
 * end of the animation by a hair for no reason a user could explain.
 */
export function planExponentialScale(
  range: ExpScaleRange,
  fps: number,
  easing: Keyframe['easing'] = 'linear',
): Keyframe[] {
  if (refuseExponentialScale(range)) return [];
  const step = 1 / Math.max(1, fps);
  const out: Keyframe[] = [{ t: range.t0, value: range.s0, easing }];
  /**
   * COUNTED, not accumulated. `for (let t = t0 + step; t < t1; t += step)`
   * reads more naturally and can loop forever: a negative or zero `fps`
   * produces a step that never advances toward the end, and the app hangs
   * instead of failing. The `Math.max(1, fps)` floor above already prevents
   * that — but a floor is a promise one edit can break, and a counted loop
   * cannot run away whatever `step` turns out to be. Same reasoning as rule 8:
   * a guard that hangs is worse than no guard.
   *
   * Counting also avoids float accumulation, so frame 300 lands on 300·step
   * rather than 300 additions of it.
   */
  const frames = Math.floor((range.t1 - range.t0) / step);
  // `i < frames` is STRICT, so the largest t emitted here is
  // `(frames - 1) · step`, which is always short of `t1`. The endpoint below
  // is therefore never duplicated, and an extra `t >= t1 - step/2` break was
  // tried and removed: deleting it failed no test because it could not fire.
  // A dead guard implying coverage is worse than no guard (rule 4a).
  for (let i = 1; i < frames; i++) {
    const t = range.t0 + i * step;
    out.push({ t, value: exponentialScaleAt(range, t), easing });
  }
  out.push({ t: range.t1, value: range.s1, easing });
  return out;
}

/**
 * The range a track's keyframes describe: first to last.
 *
 * Returns null for a track with fewer than two keyframes, which is the
 * `needs-two-keyframes` refusal rather than an error.
 */
export function rangeOfTrack(keyframes: readonly Keyframe[]): ExpScaleRange | null {
  if (keyframes.length < 2) return null;
  const first = keyframes[0]!;
  const last = keyframes[keyframes.length - 1]!;
  return { t0: first.t, t1: last.t, s0: first.value, s1: last.value };
}

export interface ExpScaleResult {
  /** Keyframes written, per prop. Empty when nothing was eligible. */
  written: Map<string, number>;
  /** Why nothing happened, when nothing did. */
  refusal: ExpScaleRefusal | null;
}

/**
 * Which scale tracks on `nodeId` this assistant could act on.
 *
 * Exported so the command's `enabled()` and its `execute()` ask the SAME
 * question. Two predicates — one deciding whether the menu item is live and
 * one deciding whether the work happens — is the §2·0 shape, and it shows up
 * as a command that greys itself out for a layer it would happily have
 * handled, or worse the reverse.
 */
export function eligibleScaleTracks(nodeId: string): Array<{ prop: string; range: ExpScaleRange }> {
  const out: Array<{ prop: string; range: ExpScaleRange }> = [];
  for (const track of defaultAnimation.tracksFor(nodeId)) {
    if (!(SCALE_PROPS as readonly string[]).includes(track.prop)) continue;
    const range = rangeOfTrack(track.keyframes);
    if (!range || refuseExponentialScale(range)) continue;
    out.push({ prop: track.prop, range });
  }
  return out;
}

/**
 * Rewrite a layer's scale tracks as an exponential ramp.
 *
 * Each scale prop is baked INDEPENDENTLY, from its own keyframes. Deriving
 * both axes from one range would be wrong for any non-uniform scale animation
 * — and would look right on the overwhelmingly common uniform one, which is
 * the sort of bug that ships.
 */
export function applyExponentialScale(nodeId: string): ExpScaleResult {
  const eligible = eligibleScaleTracks(nodeId);
  if (eligible.length === 0) {
    // Say WHICH refusal, so the caller can explain rather than just decline.
    const scaleTracks = defaultAnimation.tracksFor(nodeId)
      .filter((t) => (SCALE_PROPS as readonly string[]).includes(t.prop));
    const ranges = scaleTracks.map((t) => rangeOfTrack(t.keyframes));
    const firstRange = ranges.find((r) => r !== null) ?? null;
    return {
      written: new Map(),
      refusal: firstRange ? refuseExponentialScale(firstRange) : 'needs-two-keyframes',
    };
  }

  const fps = getTimelineController().fps || 30;
  const written = new Map<string, number>();
  runAnimEdit('Exponential scale', () => {
    defaultAnimation.batch(() => {
      for (const { prop, range } of eligible) {
        const kfs = planExponentialScale(range, fps);
        if (kfs.length === 0) continue;
        defaultAnimation.setKeyframes(nodeId, prop, kfs);
        written.set(prop, kfs.length);
      }
    });
  });
  return { written, refusal: null };
}
