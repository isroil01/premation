/**
 * Motion Sketch — capture speed and the fan-out to x/y tracks.
 *
 * ## What the medium can and cannot see (rule 5·0)
 *
 * The observable is "what keyframes does a recorded path become", produced by
 * `motionSketchTracks`. A unit test samples exactly that layer.
 *
 * What it CANNOT see is that the samples are in the right SPACE — that the
 * recorder is fed the layer's own x/y through `moveNodes`' parent-inverse
 * rather than raw screen coordinates. Nothing here would change if the wiring
 * fed it screen pixels. That is a wiring fact, checked in the running app.
 *
 * ## What the fixtures were chosen to make REACHABLE (rule 3a)
 *
 * A path drawn casually excludes three things at once, and each gets a
 * fixture:
 *
 *  * **A straight line excludes curvature.** Douglas–Peucker reduces any
 *    straight run to its endpoints, so a straight fixture passes whether the
 *    reduction is right, wrong, or absent. The smoothing fixtures bend.
 *  * **Constant speed excludes timing capture.** With a uniform sample
 *    interval, rescaling times preserves the shape of everything, so a
 *    capture-speed bug shows only as a total-duration change — which an
 *    assertion on ordering or on count cannot see. The capture-speed fixtures
 *    assert absolute times.
 *  * **A path that never pauses excludes the zero-velocity case**, which is
 *    the one that actually bites: a stationary hold is spatially collinear, so
 *    the spatial reduction discards it entirely and a one-second wait becomes
 *    a slow drift.
 *
 * And one the brief did not name, found while deriving: **a recording that
 * starts at t=0 excludes the capture-speed ANCHOR.** Scaling times about zero
 * and scaling them about the first sample are identical when the first sample
 * is zero, and wildly different otherwise. Every capture-speed fixture here
 * starts at t=2.
 */

import {
  applyCaptureSpeed,
  motionSketchTracks,
  spliceRecordedRange,
  DEFAULT_MOTION_SKETCH_OPTIONS,
  type MotionSketchOptions,
} from './motionSketch';
import type { Keyframe } from '@motion/animation';
import type { SketchSample } from '@core/rig/puppetSketch';

/** Three samples 0.1 s apart, starting at t = 2 — NOT at zero, on purpose. */
const TIMED: SketchSample[] = [
  { x: 0, y: 0, t: 2.0 },
  { x: 10, y: 0, t: 2.1 },
  { x: 20, y: 0, t: 2.2 },
];

const opts = (o: Partial<MotionSketchOptions> = {}): MotionSketchOptions => ({
  ...DEFAULT_MOTION_SKETCH_OPTIONS,
  ...o,
});

describe('applyCaptureSpeed', () => {
  it('100% is a pass-through', () => {
    expect(applyCaptureSpeed(TIMED, 100).map((s) => s.t)).toEqual([2.0, 2.1, 2.2]);
  });

  /**
   * 50% takes TWICE as long: intervals double. Anchored at the first sample,
   * so the take stays where it was recorded — scaling about zero would give
   * [4.0, 4.2, 4.4] and move the whole performance two seconds later.
   */
  it('50% doubles the intervals, anchored at the FIRST sample', () => {
    const t = applyCaptureSpeed(TIMED, 50).map((s) => s.t);
    expect(t[0]).toBeCloseTo(2.0, 9);
    expect(t[1]).toBeCloseTo(2.2, 9);
    expect(t[2]).toBeCloseTo(2.4, 9);
  });

  it('200% halves the intervals, same anchor', () => {
    const t = applyCaptureSpeed(TIMED, 200).map((s) => s.t);
    expect(t[0]).toBeCloseTo(2.0, 9);
    expect(t[1]).toBeCloseTo(2.05, 9);
    expect(t[2]).toBeCloseTo(2.1, 9);
  });

  it('leaves positions untouched — it is a TIME control', () => {
    const s = applyCaptureSpeed(TIMED, 50);
    expect(s.map((p) => [p.x, p.y])).toEqual([[0, 0], [10, 0], [20, 0]]);
  });

  /** Zero or negative would divide by zero or run time backwards. */
  it('treats a nonsense speed as 100%', () => {
    expect(applyCaptureSpeed(TIMED, 0).map((s) => s.t)).toEqual([2.0, 2.1, 2.2]);
    expect(applyCaptureSpeed(TIMED, -50).map((s) => s.t)).toEqual([2.0, 2.1, 2.2]);
  });

  it('handles an empty recording', () => {
    expect(applyCaptureSpeed([], 50)).toEqual([]);
  });
});

describe('motionSketchTracks', () => {
  /**
   * The contract that makes the two tracks describe ONE path. Reducing x and y
   * independently keeps different survivors on each axis, and the drawn path
   * bulges wherever one axis kept a point the other dropped. Asserted as a
   * universal rather than at a hand-picked point, because that is the shape of
   * the claim.
   */
  it('gives x and y IDENTICAL times and easing', () => {
    const arc: SketchSample[] = Array.from({ length: 40 }, (_, i) => ({
      x: i * 2,
      y: Math.sin((i / 39) * Math.PI) * 50,
      t: 2 + i * 0.02,
    }));
    const { x, y } = motionSketchTracks(arc, opts({ tolerance: 2 }));
    expect(x).toHaveLength(y.length);
    expect(x.map((k) => k.t)).toEqual(y.map((k) => k.t));
    expect(x.map((k) => k.easing)).toEqual(y.map((k) => k.easing));
    // And it really did reduce, so the equality above is not trivially true of
    // two empty or two untouched lists.
    expect(x.length).toBeGreaterThan(2);
    expect(x.length).toBeLessThan(40);
  });

  it('splits the path into the two scalar tracks', () => {
    const { x, y } = motionSketchTracks(TIMED);
    expect(x.map((k) => k.value)).toEqual([0, 10, 20]);
    expect(y.map((k) => k.value)).toEqual([0, 0, 0]);
    expect(x.map((k) => k.t)).toEqual([2.0, 2.1, 2.2]);
  });

  it('carries capture speed through to the written times', () => {
    const { x } = motionSketchTracks(TIMED, opts({ captureSpeedPct: 50 }));
    expect(x.map((k) => k.t)[2]).toBeCloseTo(2.4, 9);
  });

  it('is empty for an empty recording', () => {
    expect(motionSketchTracks([])).toEqual({ x: [], y: [] });
  });
});

describe('the zero-velocity case — the one a casual path excludes', () => {
  /**
   * Held still for 1 s at (0,0), then moved to (100,0) over the next second.
   * Spatially this is ONE straight line, and every hold sample sits exactly on
   * the chord from start to end — so Douglas–Peucker discards the entire pause
   * and the layer drifts for two seconds instead of waiting for one.
   *
   * Derived on paper, then measured: at tolerance 2 the reduction keeps 2
   * keyframes and the midpoint of the result is 50 where the recording was
   * still at 0.
   */
  const held: SketchSample[] = [
    ...Array.from({ length: 11 }, (_, i) => ({ x: 0, y: 0, t: 2 + i * 0.1 })),
    ...Array.from({ length: 10 }, (_, i) => ({ x: (i + 1) * 10, y: 0, t: 3.1 + i * 0.1 })),
  ];

  /** The DEFAULT keeps the hold, because it does not reduce at all. */
  it('preserves a stationary hold by default', () => {
    const { x } = motionSketchTracks(held);
    expect(x).toHaveLength(21);
    // Still at 0 through the whole first second.
    const atThree = x.find((k) => Math.abs(k.t - 3.0) < 1e-9);
    expect(atThree?.value).toBe(0);
  });

  /**
   * And smoothing DESTROYS it — asserted rather than left as a warning in a
   * comment, so the trade-off is a fact the suite holds rather than a claim
   * that can rot (rule 3b).
   */
  it('smoothing discards the hold — the documented cost', () => {
    const { x } = motionSketchTracks(held, opts({ tolerance: 2 }));
    expect(x).toHaveLength(2);
    expect(x[0]!.value).toBe(0);
    expect(x[1]!.value).toBe(100);
    // Which is the drift: at t=3.0 the reduced track is already a third of the
    // way across, where the recording had not moved at all.
    expect(x[0]!.t).toBeCloseTo(2, 9);
    expect(x[1]!.t).toBeCloseTo(4, 9);
  });

  /** Samples sharing an instant — recording while paused — collapse. */
  it('collapses samples that share a time, keeping the last', () => {
    const paused: SketchSample[] = [
      { x: 0, y: 0, t: 2 }, { x: 5, y: 1, t: 2 }, { x: 9, y: 3, t: 2 },
      { x: 20, y: 0, t: 2.1 },
    ];
    const { x, y } = motionSketchTracks(paused);
    expect(x).toHaveLength(2);
    expect(x[0]!.value).toBe(9);
    expect(y[0]!.value).toBe(3);
  });
});

describe('curvature — what a straight line cannot show', () => {
  /**
   * A right-angle path. Straight fixtures reduce to their endpoints whatever
   * the algorithm does, so they cannot tell a working reduction from one that
   * simply drops everything. The corner must survive.
   */
  it('keeps a corner that a straight run would not have', () => {
    const L: SketchSample[] = [
      ...Array.from({ length: 11 }, (_, i) => ({ x: i * 10, y: 0, t: 2 + i * 0.05 })),
      ...Array.from({ length: 10 }, (_, i) => ({ x: 100, y: (i + 1) * 10, t: 2.55 + i * 0.05 })),
    ];
    const { x, y } = motionSketchTracks(L, opts({ tolerance: 2 }));
    expect(x).toHaveLength(3); // start, corner, end
    expect([x[1]!.value, y[1]!.value]).toEqual([100, 0]);
  });
});

describe('spliceRecordedRange — recording over part of an existing animation', () => {
  const kf = (t: number, value: number): Keyframe => ({ t, value, easing: 'linear' });

  /**
   * `setKeyframes` replaces a whole track, so writing a take naively would
   * delete whatever the layer was already doing on either side of it. The
   * commonest real use — sketch the middle of a move that already has an in
   * and an out — is exactly the case that would lose them.
   */
  it('keeps keyframes outside the recorded span', () => {
    const existing = [kf(0, -999), kf(5, 999)];
    const recorded = [kf(2, 10), kf(2.1, 20), kf(2.2, 30)];
    expect(spliceRecordedRange(existing, recorded).map((k) => [k.t, k.value]))
      .toEqual([[0, -999], [2, 10], [2.1, 20], [2.2, 30], [5, 999]]);
  });

  /** And drops the ones INSIDE it — that is what re-recording means. */
  it('replaces keyframes inside the span', () => {
    const existing = [kf(0, -999), kf(2.05, 777), kf(5, 999)];
    const out = spliceRecordedRange(existing, [kf(2, 10), kf(2.2, 30)]);
    expect(out.some((k) => k.value === 777)).toBe(false);
    expect(out).toHaveLength(4);
  });

  /**
   * The BOUNDARY the clean fixture above cannot reach: an existing keyframe
   * sitting exactly on an endpoint of the take. It is inside, so it goes —
   * otherwise two keyframes share an instant and the sampler picks arbitrarily.
   */
  it('drops an existing keyframe exactly on the span edge', () => {
    const out = spliceRecordedRange([kf(2, 777), kf(2.2, 888)], [kf(2, 10), kf(2.2, 30)]);
    expect(out.map((k) => k.value)).toEqual([10, 30]);
    expect(new Set(out.map((k) => k.t)).size).toBe(out.length);
  });

  it('an empty recording changes nothing', () => {
    const existing = [kf(0, 1), kf(1, 2)];
    expect(spliceRecordedRange(existing, [])).toEqual(existing);
  });

  it('writes into an empty track', () => {
    expect(spliceRecordedRange([], [kf(2, 10)]).map((k) => k.value)).toEqual([10]);
  });
});
