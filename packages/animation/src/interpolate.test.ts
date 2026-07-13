import { cubicBezierEase, sampleTrack, sampleSpeed, applyRoving, EASY_EASE_BEZIER } from './interpolate';
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
