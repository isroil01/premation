/**
 * Animation Engine Sweep — value-over-time probes.
 *
 * The render harness gates PIXELS and structurally cannot catch a wrong
 * interpolation curve. These probes sample properties ACROSS a frame range and
 * assert the curve's SHAPE — endpoint exactness, monotonicity, C1 continuity at
 * keyframes, symmetry — the failure mode that reads as the wrong shape and names
 * its own mechanism.
 *
 * Every probe here is a committed regression test. A probe that documents a
 * KNOWN-GOOD invariant guards it; a probe that would fail names a real defect and
 * is fixed at the source, never blessed.
 */

import {
  cubicBezierEase,
  ease,
  sampleTrack,
  sampleSpeed,
  smoothTrackTangents,
  EASY_EASE_BEZIER,
  EASY_EASE_IN_BEZIER,
  EASY_EASE_OUT_BEZIER,
} from '../interpolate';
import { AnimationEngine } from '../AnimationEngine';
import { sampleDataTrack } from '../dataTracks';
import type { PropertyTrack, Keyframe, EasingKind } from '../types';
import type { DataTrack } from '../dataTracks';

const track = (keyframes: Keyframe[]): PropertyTrack => ({ nodeId: 'n', prop: 'x', keyframes });

const ALL_EASINGS: EasingKind[] = [
  'linear', 'step', 'ease', 'easeIn', 'easeOut', 'easeInOut',
  'bezier', 'hold', 'autoBezier', 'continuousBezier',
];

/** Sample a track densely over [t0,t1] and return {t,v} pairs. */
function curve(tr: PropertyTrack, t0: number, t1: number, n = 200): Array<{ t: number; v: number }> {
  const out: Array<{ t: number; v: number }> = [];
  for (let i = 0; i <= n; i++) {
    const t = t0 + ((t1 - t0) * i) / n;
    out.push({ t, v: sampleTrack(tr, t)! });
  }
  return out;
}

describe('SWEEP — keyframe value is EXACT at its own frame, every easing', () => {
  // The classic defect: a half-frame or off-by-one offset makes the sampled
  // value at a keyframe's time differ from the authored value.
  it.each(ALL_EASINGS)('endpoints exact with %s on the segment', (easing) => {
    const tr = track([
      { t: 0.5, value: 17, easing, bezier: [0.2, 0.9, 0.1, 1] },
      { t: 2.25, value: -43 },
    ]);
    expect(sampleTrack(tr, 0.5)).toBe(17);
    expect(sampleTrack(tr, 2.25)).toBe(-43);
  });

  it.each(ALL_EASINGS)('interior keyframe exact with %s (3-key track)', (easing) => {
    const tr = track([
      { t: 0, value: 0, easing },
      { t: 1, value: 100, easing, bezier: [0.3, 0, 0.7, 1] },
      { t: 2, value: 40 },
    ]);
    // The middle keyframe's authored value must be reproduced exactly at t=1,
    // regardless of the easing on either adjoining segment.
    expect(sampleTrack(tr, 1)).toBe(100);
  });

  it('endpoint exactness holds with spatial tangents present', () => {
    const tr = track([
      { t: 0, value: 0, so: 40 },
      { t: 1, value: 100, si: -30 },
      { t: 2, value: 100, si: 55 },
    ]);
    expect(sampleTrack(tr, 0)).toBeCloseTo(0, 10);
    expect(sampleTrack(tr, 1)).toBeCloseTo(100, 10);
    expect(sampleTrack(tr, 2)).toBeCloseTo(100, 10);
  });
});

describe('SWEEP — hold/step reaches the arriving keyframe ON its frame (off-by-one regression)', () => {
  it.each(['hold', 'step'] as EasingKind[])(
    '%s holds until — but jumps AT — the next interior keyframe time',
    (easing) => {
      const tr = track([
        { t: 0, value: 0, easing },
        { t: 1, value: 100 },
        { t: 2, value: 40 },
      ]);
      // Held right up to the boundary...
      expect(sampleTrack(tr, 0.999)).toBe(0);
      // ...and exactly AT the interior keyframe frame, its authored value wins.
      // Before the fix this returned 0 — the target arrived one frame late.
      expect(sampleTrack(tr, 1)).toBe(100);
    },
  );
});

describe('SWEEP — hold/step interpolation never ramps', () => {
  it.each(['hold', 'step'] as EasingKind[])('%s holds the start value across the whole segment', (easing) => {
    const tr = track([{ t: 0, value: 10, easing }, { t: 3, value: 90 }]);
    const pts = curve(tr, 0, 2.999, 300);
    // Every sample strictly before the next key is exactly the held value.
    expect(pts.every((p) => p.v === 10)).toBe(true);
    // The next keyframe jumps.
    expect(sampleTrack(tr, 3)).toBe(90);
  });
});

describe('SWEEP — monotone easings stay monotone (no reversal artefacts)', () => {
  it.each(['linear', 'ease', 'easeIn', 'easeOut', 'easeInOut'] as EasingKind[])(
    '%s is non-decreasing on a rising segment',
    (easing) => {
      const tr = track([{ t: 0, value: 0, easing }, { t: 1, value: 100 }]);
      const pts = curve(tr, 0, 1);
      for (let i = 1; i < pts.length; i++) {
        expect(pts[i]!.v).toBeGreaterThanOrEqual(pts[i - 1]!.v - 1e-9);
      }
    },
  );
});

describe('SWEEP — easeInOut is C0-continuous at its 0.5 seam', () => {
  it('has no jump at the piecewise boundary', () => {
    const left = ease('easeInOut', 0.5 - 1e-7);
    const right = ease('easeInOut', 0.5 + 1e-7);
    expect(Math.abs(left - right)).toBeLessThan(1e-4);
    expect(left).toBeCloseTo(0.5, 4);
  });
});

describe('SWEEP — Easy Ease influence matches AE (33%)', () => {
  it('symmetric ease is 0.5 at the midpoint and slow at the ends', () => {
    expect(cubicBezierEase(EASY_EASE_BEZIER, 0.5)).toBeCloseTo(0.5, 6);
    // Slow start: at 10% of time, less than 10% of value.
    expect(cubicBezierEase(EASY_EASE_BEZIER, 0.1)).toBeLessThan(0.1);
    // Slow end: at 90% of time, more than 90% of value.
    expect(cubicBezierEase(EASY_EASE_BEZIER, 0.9)).toBeGreaterThan(0.9);
  });
  // Shape (verified numerically against interpolate.ts): Easy Ease IN is a pure
  // ease-in — its whole curve sits BELOW the symmetric one (slow, accelerating
  // departure; steep, fast arrival by slope). Easy Ease OUT is a pure ease-out —
  // its whole curve sits ABOVE symmetric (fast departure, decelerating arrival).
  // Endpoints stay exact. This pins the direction so a swapped constant is caught.
  it('Easy Ease In is a pure ease-in (curve below the symmetric ease)', () => {
    for (const x of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      expect(cubicBezierEase(EASY_EASE_IN_BEZIER, x)).toBeLessThan(cubicBezierEase(EASY_EASE_BEZIER, x));
    }
    // Fast arrival: the final-tenth slope is steeper than symmetric's.
    const inSlope = 1 - cubicBezierEase(EASY_EASE_IN_BEZIER, 0.9);
    const symSlope = 1 - cubicBezierEase(EASY_EASE_BEZIER, 0.9);
    expect(inSlope).toBeGreaterThan(symSlope);
    expect(cubicBezierEase(EASY_EASE_IN_BEZIER, 1)).toBeCloseTo(1, 6);
  });
  it('Easy Ease Out is a pure ease-out (curve above the symmetric ease)', () => {
    for (const x of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      expect(cubicBezierEase(EASY_EASE_OUT_BEZIER, x)).toBeGreaterThan(cubicBezierEase(EASY_EASE_BEZIER, x));
    }
    expect(cubicBezierEase(EASY_EASE_OUT_BEZIER, 0)).toBeCloseTo(0, 6);
  });
});

describe('SWEEP — auto-bezier (smoothTrackTangents) is C1-continuous at interior keys', () => {
  it('speed matches on both sides of an interior keyframe', () => {
    const kfs = smoothTrackTangents([
      { t: 0, value: 0 },
      { t: 1, value: 80 },
      { t: 2.5, value: 30 },
      { t: 4, value: 120 },
    ]);
    const tr = track(kfs);
    // Symmetric finite differences straddling the interior keyframe at t=1 and
    // t=2.5 must be continuous (C1) — the whole point of auto-bezier.
    for (const k of [1, 2.5]) {
      const before = sampleSpeed(tr, k - 1e-3);
      const after = sampleSpeed(tr, k + 1e-3);
      expect(Math.abs(after - before)).toBeLessThan(2); // value-units/sec
    }
  });
});

describe('SWEEP — expression determinism (preview must equal playback)', () => {
  const eng = new AnimationEngine();
  eng.setKeyframe('n', 'x', 0, 0);
  eng.setKeyframe('n', 'x', 2, 200);

  it('wiggle is deterministic at a fixed frame', () => {
    const a = eng.previewExpression('n', 'x', 'wiggle(3, 40)', 0.7);
    const b = eng.previewExpression('n', 'x', 'wiggle(3, 40)', 0.7);
    expect(a.error).toBeFalsy();
    expect(a.value).toEqual(b.value);
  });

  it('wiggle on x and y use independent phases', () => {
    eng.setKeyframe('n', 'y', 0, 0);
    eng.setKeyframe('n', 'y', 2, 200);
    const x = eng.previewExpression('n', 'x', 'wiggle(3, 40)', 0.7).value;
    const y = eng.previewExpression('n', 'y', 'wiggle(3, 40)', 0.7).value;
    expect(x).not.toEqual(y);
  });

  it('sampling the same value twice via the engine is stable', () => {
    expect(eng.sample('n', 'x', 1)).toEqual(eng.sample('n', 'x', 1));
  });
});

describe('SWEEP — non-scalar interpolation edge cases', () => {
  it('text data holds (never tweens)', () => {
    const dt: DataTrack = {
      nodeId: 'n', prop: 'sourceText', kind: 'text',
      keyframes: [{ t: 0, value: 'A' }, { t: 1, value: 'B' }],
    };
    expect(sampleDataTrack(dt, 0.5)).toBe('A');
    expect(sampleDataTrack(dt, 1)).toBe('B');
  });

  it('gradient-stop count mismatch snaps rather than producing garbage', () => {
    const dt: DataTrack = {
      nodeId: 'n', prop: 'grad', kind: 'gradientStops',
      keyframes: [
        { t: 0, value: [{ pos: 0, color: '#000' }, { pos: 1, color: '#fff' }] },
        { t: 1, value: [{ pos: 0, color: '#f00' }] },
      ],
    };
    const mid = sampleDataTrack(dt, 0.5) as Array<{ pos: number; color: string }>;
    // Snap to the "from" side until the very end — no interpolation across counts.
    expect(mid.length).toBe(2);
  });

  it('point-count mismatch grows the shorter outline and stays bounded', () => {
    const dt: DataTrack = {
      nodeId: 'n', prop: 'path', kind: 'points',
      keyframes: [
        { t: 0, value: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
        { t: 1, value: [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 0 }] },
      ],
    };
    const mid = sampleDataTrack(dt, 0.5) as Array<{ x: number; y: number }>;
    expect(mid.length).toBe(3);
    // Midpoint stays within the convex hull-ish bounds of the endpoints.
    for (const p of mid) {
      expect(p.x).toBeGreaterThanOrEqual(-1);
      expect(p.x).toBeLessThanOrEqual(101);
      expect(p.y).toBeGreaterThanOrEqual(-1);
      expect(p.y).toBeLessThanOrEqual(51);
    }
  });

  it('gradient colour interpolates componentwise at the midpoint', () => {
    const dt: DataTrack = {
      nodeId: 'n', prop: 'grad', kind: 'gradientStops',
      keyframes: [
        { t: 0, value: [{ pos: 0, color: '#000000' }] },
        { t: 1, value: [{ pos: 0, color: '#ffffff' }] },
      ],
    };
    const mid = sampleDataTrack(dt, 0.5) as Array<{ pos: number; color: string }>;
    // sRGB-linear lerp of 0 and 255 → ~128 (0x80). This documents the space:
    // a naive sRGB blend, NOT a linear-light blend. Stated, not blessed silently.
    expect(mid[0]!.color.toLowerCase()).toBe('#808080');
  });
});
