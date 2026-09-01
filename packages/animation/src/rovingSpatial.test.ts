/**
 * Rove Across Time, spatially. Per-track roving retimes each axis by its own
 * |value| distance, which falls apart on any non-axis-aligned path: on an
 * L-shaped move, x's own roving wants the corner keyframe at the END (all of
 * x's travel is in segment 1) while y's wants it at the START — the corner
 * point tears in time. Arc-length roving puts it where the PATH is halfway.
 */

import { applyRoving, applyRovingSpatial } from './interpolate';
import { AnimationEngine } from './AnimationEngine';
import type { Keyframe } from './types';

const kf = (t: number, value: number, roving = false): Keyframe =>
  roving ? { t, value, roving } : { t, value };

describe('applyRovingSpatial — arc-length Rove Across Time', () => {
  it('places the corner of an L-shaped path at the arc midpoint', () => {
    // (0,0) → (100,0) → (100,100): both legs are 100px, so the corner roves
    // to t=5 — while per-track roving tears it to t≈10 (x) and t≈0 (y).
    const out = applyRovingSpatial(
      [kf(0, 0), kf(1, 100, true), kf(10, 100)],
      [kf(0, 0), kf(1, 0, true), kf(10, 100)],
    );
    expect(out).not.toBeNull();
    expect(out!.x[1]!.t).toBeCloseTo(5, 5);
    expect(out!.y[1]!.t).toBeCloseTo(5, 5);

    // The per-track answer really is the torn one — this is the bug pinned.
    const xAlone = applyRoving([kf(0, 0), kf(1, 100, true), kf(10, 100)]);
    expect(xAlone[1]!.t).toBeCloseTo(10, 5);
  });

  it('keeps both axes on the SAME retimed grid', () => {
    const out = applyRovingSpatial(
      [kf(0, 0), kf(2, 30, true), kf(3, 90, true), kf(6, 100)],
      [kf(0, 0), kf(2, 40, true), kf(3, 10, true), kf(6, 0)],
    )!;
    for (let i = 0; i < out.x.length; i++) {
      expect(out.x[i]!.t).toBe(out.y[i]!.t);
    }
    // Times stay ordered inside the run.
    const ts = out.x.map((k) => k.t);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  });

  it('respects spatial tangents — a bowed segment is longer than its chord', () => {
    // Straight x-run 0→100→200 with the middle roving would sit at t=5. Bow
    // the FIRST segment's y hard with spatial tangents: that segment's arc now
    // exceeds the second's chord, so the roving keyframe lands after t=5.
    const out = applyRovingSpatial(
      [kf(0, 0), kf(1, 100, true), kf(10, 200)],
      [{ t: 0, value: 0, so: 150 }, { t: 1, value: 0, si: 150, roving: true }, kf(10, 0)],
    )!;
    expect(out.x[1]!.t).toBeGreaterThan(5.5);
  });

  it('returns null on misaligned grids (caller falls back per-track)', () => {
    expect(
      applyRovingSpatial(
        [kf(0, 0), kf(1, 50, true), kf(10, 100)],
        [kf(0, 0), kf(2, 50, true), kf(10, 100)],
      ),
    ).toBeNull();
    expect(
      applyRovingSpatial(
        [kf(0, 0), kf(1, 50, true), kf(10, 100)],
        [kf(0, 0), kf(1, 50), kf(10, 100)],
      ),
    ).toBeNull();
  });

  it('never moves anchors or changes values', () => {
    const out = applyRovingSpatial(
      [kf(0, 0), kf(1, 100, true), kf(10, 100)],
      [kf(0, 0), kf(1, 0, true), kf(10, 100)],
    )!;
    expect(out.x[0]!.t).toBe(0);
    expect(out.x[2]!.t).toBe(10);
    expect(out.x.map((k) => k.value)).toEqual([0, 100, 100]);
    expect(out.y.map((k) => k.value)).toEqual([0, 0, 100]);
  });
});

describe('AnimationEngine.setRoving — paired position tracks', () => {
  it('roves x and y together along the arc', () => {
    const a = new AnimationEngine();
    for (const [t, x, y] of [[0, 0, 0], [1, 100, 0], [10, 100, 100]] as const) {
      a.setKeyframe('n1', 'x', t, x);
      a.setKeyframe('n1', 'y', t, y);
    }
    a.setRoving('n1', 'x', 1, true);
    const xs = a.getTrackKeyframes('n1', 'x')!;
    const ys = a.getTrackKeyframes('n1', 'y')!;
    expect(xs[1]!.t).toBeCloseTo(5, 5);
    expect(ys[1]!.t).toBeCloseTo(5, 5);
    expect(ys[1]!.roving).toBe(true);

    // The UI toggles the sibling too; the second call must be a no-op, not a
    // second move.
    a.setRoving('n1', 'y', xs[1]!.t, true);
    expect(a.getTrackKeyframes('n1', 'x')![1]!.t).toBeCloseTo(5, 5);
    expect(a.getTrackKeyframes('n1', 'y')![1]!.t).toBeCloseTo(5, 5);
  });

  it('falls back to per-track roving when the sibling grid differs', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n1', 'x', 0, 0);
    a.setKeyframe('n1', 'x', 1, 25);
    a.setKeyframe('n1', 'x', 10, 100);
    a.setKeyframe('n1', 'y', 0, 0); // one keyframe only — no aligned grid
    a.setRoving('n1', 'x', 1, true);
    // Per-track: cumulative |value| 25/100 ⇒ t = 2.5.
    expect(a.getTrackKeyframes('n1', 'x')![1]!.t).toBeCloseTo(2.5, 5);
  });
});
