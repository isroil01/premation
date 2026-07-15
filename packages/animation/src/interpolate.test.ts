import {
  cubicBezierEase,
  sampleTrack,
  sampleSpeed,
  applyRoving,
  cubicValueAt,
  smoothTrackTangents,
  clearTrackTangents,
  EASY_EASE_BEZIER,
} from './interpolate';
import type { PropertyTrack, Keyframe } from './types';

const track = (keyframes: Keyframe[]): PropertyTrack => ({ nodeId: 'n', prop: 'x', keyframes });

describe('cubicBezierEase', () => {
  it('passes through the endpoints', () => {
    expect(cubicBezierEase([0.25, 0.1, 0.25, 1], 0)).toBeCloseTo(0, 5);
    expect(cubicBezierEase([0.25, 0.1, 0.25, 1], 1)).toBeCloseTo(1, 5);
  });
  it('a linear bezier is the identity', () => {
    expect(cubicBezierEase([0, 0, 1, 1], 0.5)).toBeCloseTo(0.5, 2);
  });
  it('ease-out lands above the diagonal midway', () => {
    expect(cubicBezierEase([0, 0.6, 0.4, 1], 0.5)).toBeGreaterThan(0.5);
  });
});

describe('sampleTrack interpolation types', () => {
  it('uses the keyframe bezier handles', () => {
    const t = track([
      { t: 0, value: 0, easing: 'bezier', bezier: [0, 0.8, 0.2, 1] },
      { t: 1, value: 100 },
    ]);
    // With a strong ease-out, the midpoint value should exceed the linear 50.
    expect(sampleTrack(t, 0.5)!).toBeGreaterThan(50);
  });

  it('linear hits the exact midpoint', () => {
    expect(sampleTrack(track([{ t: 0, value: 0 }, { t: 2, value: 100 }]), 1)!).toBeCloseTo(50);
  });

  it('hold (step) keeps the start value across the whole segment', () => {
    const t = track([{ t: 0, value: 10, easing: 'step' }, { t: 2, value: 90 }]);
    expect(sampleTrack(t, 0.1)!).toBe(10);
    expect(sampleTrack(t, 1.99)!).toBe(10);
    expect(sampleTrack(t, 2)!).toBe(90);
  });
});

describe('sampleSpeed — the speed graph derivative', () => {
  it('is constant for a linear segment (= slope)', () => {
    const t = track([{ t: 0, value: 0 }, { t: 2, value: 100 }]);
    expect(sampleSpeed(t, 0.5)).toBeCloseTo(50, 3); // 100 units / 2 s
    expect(sampleSpeed(t, 1.5)).toBeCloseTo(50, 3);
  });

  it('is ~0 at an ease-in start and larger later', () => {
    const t = track([{ t: 0, value: 0, easing: 'easeIn' }, { t: 1, value: 100 }]);
    expect(sampleSpeed(t, 0.05)).toBeLessThan(sampleSpeed(t, 0.9));
  });

  it('is negative when the value decreases', () => {
    const t = track([{ t: 0, value: 100 }, { t: 1, value: 0 }]);
    expect(sampleSpeed(t, 0.5)).toBeLessThan(0);
  });
});

describe('applyRoving — constant-speed retiming', () => {
  it('centres a single roving keyframe between equal value steps', () => {
    // Values 0 → 50 → 100 with the middle roving: equal distance ⇒ t = 5 (mid).
    const out = applyRoving([
      { t: 0, value: 0 },
      { t: 2, value: 50, roving: true },
      { t: 10, value: 100 },
    ]);
    expect(out[1]!.t).toBeCloseTo(5, 4);
  });

  it('positions the roving keyframe by cumulative value distance', () => {
    // 0 → 25 → 100: the middle is 25% of the total distance ⇒ 25% of the span.
    const out = applyRoving([
      { t: 0, value: 0 },
      { t: 3, value: 25, roving: true },
      { t: 4, value: 100 },
    ]);
    expect(out[1]!.t).toBeCloseTo(1, 4); // 0 + 0.25 * (4 - 0)
  });

  it('leaves non-roving keyframes and endpoints untouched', () => {
    const kfs: Keyframe[] = [{ t: 0, value: 0 }, { t: 1, value: 40 }, { t: 5, value: 100 }];
    const out = applyRoving(kfs);
    expect(out.map((k) => k.t)).toEqual([0, 1, 5]);
  });
});

describe('EASY_EASE_BEZIER', () => {
  it('is a symmetric 1/3-influence curve passing through 0.5 at the midpoint', () => {
    expect(EASY_EASE_BEZIER).toEqual([1 / 3, 0, 2 / 3, 1]);
    expect(cubicBezierEase(EASY_EASE_BEZIER, 0.5)).toBeCloseTo(0.5, 5);
  });
});

describe('spatial bezier tangents (curved motion paths)', () => {
  it('cubicValueAt hits the endpoints and is linear at third-points', () => {
    expect(cubicValueAt(0, 10, 20, 30, 0)).toBeCloseTo(0);
    expect(cubicValueAt(0, 10, 20, 30, 1)).toBeCloseTo(30);
    // Control values at the linear third-points ⇒ exact identity line.
    expect(cubicValueAt(0, 10, 20, 30, 0.25)).toBeCloseTo(7.5, 6);
    expect(cubicValueAt(0, 10, 20, 30, 0.75)).toBeCloseTo(22.5, 6);
  });

  it('a segment with spatial tangents bows away from the straight line', () => {
    // Both tangents pull upward (+40): the midpoint overshoots the linear 50.
    const t = track([
      { t: 0, value: 0, so: 40 },
      { t: 1, value: 100, si: 40 },
    ]);
    expect(sampleTrack(t, 0)!).toBeCloseTo(0);
    expect(sampleTrack(t, 1)!).toBeCloseTo(100);
    expect(sampleTrack(t, 0.5)!).toBeGreaterThan(50);
  });

  it('a one-sided tangent defaults the other side to the linear third-point', () => {
    const curved = track([{ t: 0, value: 0, so: 90 }, { t: 1, value: 100 }]);
    const straight = track([{ t: 0, value: 0 }, { t: 1, value: 100 }]);
    // Early in the segment the out-tangent dominates and lifts the value.
    expect(sampleTrack(curved, 0.25)!).toBeGreaterThan(sampleTrack(straight, 0.25)!);
    // Endpoints are always exact.
    expect(sampleTrack(curved, 1)!).toBeCloseTo(100);
  });

  it('linear third-point tangents reproduce the straight line exactly', () => {
    const t = track([
      { t: 0, value: 0, so: 100 / 3 },
      { t: 1, value: 100, si: -100 / 3 },
    ]);
    expect(sampleTrack(t, 0.25)!).toBeCloseTo(25, 6);
    expect(sampleTrack(t, 0.5)!).toBeCloseTo(50, 6);
  });

  it('temporal easing remaps the parameter without changing the spatial shape', () => {
    // Same spatial curve, eased vs linear: values differ mid-segment (timing),
    // but the eased track still passes through the same endpoints.
    const shape: Keyframe[] = [
      { t: 0, value: 0, so: 40 },
      { t: 1, value: 100, si: 40 },
    ];
    const eased = track([{ ...shape[0]!, easing: 'easeIn' }, shape[1]!]);
    const linear = track(shape.map((k) => ({ ...k })));
    // easeIn(0.25) < 0.25 ⇒ the eased sample sits earlier on the same curve.
    expect(sampleTrack(eased, 0.25)!).toBeLessThan(sampleTrack(linear, 0.25)!);
    expect(sampleTrack(eased, 1)!).toBeCloseTo(100);
  });

  it('smoothTrackTangents produces C1-continuous Catmull-Rom tangents', () => {
    const out = smoothTrackTangents([
      { t: 0, value: 0 },
      { t: 1, value: 100 },
      { t: 2, value: 0 },
    ]);
    // Interior keyframe: neighbours have equal values ⇒ zero slope ⇒ flat tangents.
    expect(out[1]!.so).toBeCloseTo(0);
    expect(out[1]!.si).toBeCloseTo(0);
    // Endpoints use the one-sided slope toward the neighbour.
    expect(out[0]!.so).toBeCloseTo(100 / 3);
    expect(out[0]!.si).toBeUndefined();
    expect(out[2]!.si).toBeCloseTo(100 / 3); // arriving slope -100/t, si = -m*dt/3
    expect(out[2]!.so).toBeUndefined();
  });

  it('smoothTrackTangents scales tangents by segment duration (non-uniform spacing)', () => {
    const out = smoothTrackTangents([
      { t: 0, value: 0 },
      { t: 1, value: 30 },
      { t: 5, value: 100 },
    ]);
    // Interior slope m = (100-0)/(5-0) = 20; out spans 4s, in spans 1s.
    expect(out[1]!.so).toBeCloseTo((20 * 4) / 3);
    expect(out[1]!.si).toBeCloseTo((-20 * 1) / 3);
  });

  it('clearTrackTangents strips every spatial tangent and nothing else', () => {
    const out = clearTrackTangents([
      { t: 0, value: 0, so: 40, easing: 'easeIn' },
      { t: 1, value: 100, si: 40, roving: true },
    ]);
    expect(out[0]!.so).toBeUndefined();
    expect(out[1]!.si).toBeUndefined();
    expect(out[0]!.easing).toBe('easeIn');
    expect(out[1]!.roving).toBe(true);
  });

  it('evaluates autoBezier and continuousBezier smoothly', () => {
    const tAuto = track([{ t: 0, value: 0, easing: 'autoBezier' }, { t: 1, value: 100 }]);
    const tCont = track([{ t: 0, value: 0, easing: 'continuousBezier' }, { t: 1, value: 100 }]);
    expect(sampleTrack(tAuto, 0.5)).toBeCloseTo(50);
    expect(sampleTrack(tCont, 0.5)).toBeCloseTo(50);
    expect(sampleTrack(tAuto, 0.25)).toBeGreaterThan(0);
    expect(sampleTrack(tAuto, 0.25)).toBeLessThan(25);
  });
});
