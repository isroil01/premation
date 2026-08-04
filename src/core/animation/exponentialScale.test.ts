/**
 * Exponential Scale — the maths, derived on paper.
 *
 * ## The fixture and what it was chosen to make REACHABLE (rule 3a)
 *
 * 100 → 400 over 1 s. Ratio 4, so the values are exact powers of 2 and the
 * whole curve is checkable by hand:
 *
 *     t=0.00  100 · 4^0.00 = 100
 *     t=0.25  100 · 4^0.25 = 141.421…   (= 100·√2)
 *     t=0.50  100 · 4^0.50 = 200        ← linear would say 250
 *     t=0.75  100 · 4^0.75 = 282.842…
 *     t=1.00  400
 *
 * Two things this choice makes reachable that a tidier one hides:
 *
 *  * the midpoint is 200 against linear's 250, so a bake that never left
 *    linear interpolation fails loudly. A fixture with s1/s0 close to 1 would
 *    put the two within a rounding error of each other.
 *  * the quarter points are asymmetric. **The midpoint alone cannot detect a
 *    REVERSED implementation**: 100→400 and 400→100 both pass through
 *    141.42·√2 = 200 at t=0.5, because the geometric mean is symmetric under
 *    swapping the endpoints. At t=0.25 they are 141.42 and 282.84 — the same
 *    two numbers, exchanged. So the direction is only pinned by an
 *    OFF-CENTRE sample, and this file asserts one on each side.
 *
 * And what the clean ratio excludes, covered by the boundary block: s0 == s1
 * (ratio 1, where exponential and linear and "do nothing" all agree, so the
 * case is quiet rather than loud), and a non-positive endpoint, which has no
 * exponential path at all.
 */

import {
  exponentialScaleAt,
  planExponentialScale,
  refuseExponentialScale,
  rangeOfTrack,
  type ExpScaleRange,
} from './exponentialScale';

/** 100 → 400 over one second. */
const R: ExpScaleRange = { t0: 0, t1: 1, s0: 100, s1: 400 };
/** The same zoom, reversed. */
const REV: ExpScaleRange = { t0: 0, t1: 1, s0: 400, s1: 100 };

describe('exponentialScaleAt', () => {
  it('matches the hand-derived curve', () => {
    expect(exponentialScaleAt(R, 0)).toBeCloseTo(100, 9);
    expect(exponentialScaleAt(R, 0.25)).toBeCloseTo(141.4213562, 6);
    expect(exponentialScaleAt(R, 0.5)).toBeCloseTo(200, 9);
    expect(exponentialScaleAt(R, 0.75)).toBeCloseTo(282.8427125, 6);
    expect(exponentialScaleAt(R, 1)).toBeCloseTo(400, 9);
  });

  /** The claim of the whole module: not linear. */
  it('is NOT linear interpolation', () => {
    expect(exponentialScaleAt(R, 0.5)).not.toBeCloseTo(250, 1);
    expect(exponentialScaleAt(R, 0.25)).not.toBeCloseTo(175, 1);
  });

  /**
   * The directional assertion. Reversing the endpoints must reverse the curve,
   * and the midpoint is blind to it — 200 either way.
   */
  it('is DIRECTIONAL, which the midpoint cannot show', () => {
    expect(exponentialScaleAt(REV, 0.5)).toBeCloseTo(200, 9);      // same as R
    expect(exponentialScaleAt(R, 0.25)).toBeCloseTo(141.4213562, 6);
    expect(exponentialScaleAt(REV, 0.25)).toBeCloseTo(282.8427125, 6);
  });

  /** Equal ratios over equal times — the defining property. */
  it('covers equal RATIOS in equal times, not equal amounts', () => {
    const a = exponentialScaleAt(R, 0.25) / exponentialScaleAt(R, 0);
    const b = exponentialScaleAt(R, 0.5) / exponentialScaleAt(R, 0.25);
    const c = exponentialScaleAt(R, 0.75) / exponentialScaleAt(R, 0.5);
    expect(b).toBeCloseTo(a, 9);
    expect(c).toBeCloseTo(a, 9);
    expect(a).toBeCloseTo(Math.SQRT2, 9);
  });

  it('honours a non-zero start time', () => {
    const shifted: ExpScaleRange = { t0: 2, t1: 3, s0: 100, s1: 400 };
    expect(exponentialScaleAt(shifted, 2.5)).toBeCloseTo(200, 9);
    // Not keyed off absolute time: at t=0.5 it extrapolates BELOW the start.
    expect(exponentialScaleAt(shifted, 2)).toBeCloseTo(100, 9);
  });
});

describe('planExponentialScale', () => {
  it('emits one keyframe per frame, endpoints included', () => {
    const kfs = planExponentialScale(R, 4); // 4 fps over 1 s
    expect(kfs.map((k) => k.t)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(kfs.map((k) => Math.round(k.value * 1e4) / 1e4)).toEqual([
      100, 141.4214, 200, 282.8427, 400,
    ]);
  });

  /**
   * Endpoints come from the ORIGINAL values, not the formula. `s0·(s1/s0)^1`
   * is not reliably bit-identical to `s1`, and an end-of-animation that drifts
   * by a hair is the kind of thing nobody can explain later.
   */
  /**
   * The END is the endpoint at risk; the START never is, because
   * `s0·(s1/s0)^0` is `s0·1` — exact for every input. So an assertion on the
   * start proves nothing, and breaking the start to read from the formula
   * fails no test. Measured, not assumed.
   *
   * The values matter and the first choice was wrong. 37 → 991 looked awkward
   * and is one of the pairs where `s0·(s1/s0)^1` happens to land exactly on
   * `s1` — so the fixture could not reach the case the guard exists for, and
   * breaking the END failed nothing either. Rule 3a, in the fixture meant to
   * demonstrate rule 3a.
   *
   * **7 → 29 does differ**: the formula gives 29.000000000000004. Found by
   * sweeping integer pairs, and a sweep of random pairs puts the rate at
   * roughly 1 in 14 — so this is ordinary, not exotic.
   */
  it('reproduces the END exactly, not merely closely', () => {
    const inexact: ExpScaleRange = { t0: 0, t1: 1, s0: 7, s1: 29 };
    // The premise, stated as an assertion so it cannot rot: the formula does
    // NOT reproduce this endpoint.
    expect(exponentialScaleAt(inexact, 1)).not.toBe(29);
    expect(exponentialScaleAt(inexact, 1)).toBeCloseTo(29, 9);

    const kfs = planExponentialScale(inexact, 30);
    const end = kfs[kfs.length - 1]!;
    expect(end.t).toBe(1);
    expect(end.value).toBe(29);
  });

  /**
   * A counted loop cannot run away. Asserted rather than trusted to the
   * `Math.max(1, fps)` floor, because an accumulator loop with a
   * non-advancing step hangs the app instead of failing a test — and a hang
   * is the one failure mode a suite cannot report (rule 8).
   */
  it('terminates for a huge frame count without accumulating drift', () => {
    const kfs = planExponentialScale({ t0: 0, t1: 10, s0: 1, s1: 1024 }, 120);
    // 10 s at 120 fps is 1200 INTERVALS, so 1201 points with both ends kept.
    expect(kfs).toHaveLength(1201);
    expect(kfs[kfs.length - 1]!.t).toBe(10);
    // Counted, so frame 600 is exactly 600/120 s rather than 600 additions.
    expect(kfs[600]!.t).toBeCloseTo(5, 12);
  });

  /** No duplicate final frame when the step divides the span exactly. */
  it('does not emit the end twice', () => {
    const kfs = planExponentialScale(R, 4);
    const times = kfs.map((k) => k.t);
    expect(new Set(times).size).toBe(times.length);
    expect(times.filter((t) => Math.abs(t - 1) < 1e-9)).toHaveLength(1);
  });

  it('carries the requested easing onto every keyframe', () => {
    for (const k of planExponentialScale(R, 4, 'hold')) expect(k.easing).toBe('hold');
  });
});

describe('boundaries — what the clean ratio cannot reach', () => {
  /**
   * Ratio 1. Exponential, linear and "did nothing at all" all agree here, so
   * this case is QUIET: it cannot prove the bake ran. It is asserted anyway
   * because the formula must not produce NaN when the log is zero.
   */
  it('a constant range stays constant', () => {
    const flat: ExpScaleRange = { t0: 0, t1: 1, s0: 250, s1: 250 };
    expect(refuseExponentialScale(flat)).toBeNull();
    for (const k of planExponentialScale(flat, 4)) expect(k.value).toBeCloseTo(250, 9);
  });

  /** A ratio through zero has no exponential path — refuse, do not emit NaN. */
  it('refuses a zero or negative endpoint rather than baking NaN', () => {
    expect(refuseExponentialScale({ t0: 0, t1: 1, s0: 0, s1: 400 })).toBe('non-positive-scale');
    expect(refuseExponentialScale({ t0: 0, t1: 1, s0: 100, s1: 0 })).toBe('non-positive-scale');
    expect(refuseExponentialScale({ t0: 0, t1: 1, s0: -100, s1: 400 })).toBe('non-positive-scale');
    expect(planExponentialScale({ t0: 0, t1: 1, s0: 0, s1: 400 }, 30)).toEqual([]);
  });

  /**
   * NaN is the failure this refusal exists to prevent, so assert the shape it
   * would have taken. Both non-positive cases produce NaN, by different routes:
   *
   *   s0 = 0    → 400/0 is Infinity, Infinity^0.5 is Infinity, 0 · Infinity = NaN
   *   s0 < 0    → a negative base to a fractional power is NaN outright
   *
   * Measured, not assumed: the first was predicted here as 0 (reasoning that
   * `0 · anything` is 0) and it is not, because `anything` is Infinity. Left
   * recorded because the wrong prediction is the more useful half — it is
   * exactly the reasoning that would talk someone out of needing the guard.
   */
  it('the unguarded formula really would produce NaN', () => {
    expect(Number.isNaN(exponentialScaleAt({ t0: 0, t1: 1, s0: 0, s1: 400 }, 0.5))).toBe(true);
    expect(Number.isNaN(exponentialScaleAt({ t0: 0, t1: 1, s0: -100, s1: 400 }, 0.5))).toBe(true);
  });

  it('refuses a zero-length span', () => {
    expect(refuseExponentialScale({ t0: 1, t1: 1, s0: 100, s1: 400 })).toBe('zero-duration');
    expect(refuseExponentialScale({ t0: 2, t1: 1, s0: 100, s1: 400 })).toBe('zero-duration');
  });

  /** An fps below 1 must still yield the endpoints, not an empty or huge track. */
  it('survives a nonsense fps', () => {
    expect(planExponentialScale(R, 0).map((k) => k.t)).toEqual([0, 1]);
    expect(planExponentialScale(R, -5).map((k) => k.t)).toEqual([0, 1]);
  });
});

describe('rangeOfTrack', () => {
  it('spans first to last keyframe', () => {
    expect(rangeOfTrack([
      { t: 0.5, value: 100 }, { t: 1, value: 200 }, { t: 2.5, value: 400 },
    ])).toEqual({ t0: 0.5, t1: 2.5, s0: 100, s1: 400 });
  });

  it('needs two keyframes', () => {
    expect(rangeOfTrack([])).toBeNull();
    expect(rangeOfTrack([{ t: 0, value: 100 }])).toBeNull();
  });
});
