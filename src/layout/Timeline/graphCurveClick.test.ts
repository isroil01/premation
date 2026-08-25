import { nearestKeyframeOnCurve } from './graphCurveClick';

describe('nearestKeyframeOnCurve', () => {
  const kfs = [
    { t: 0, tAbs: 0 },
    { t: 1, tAbs: 1 },
    { t: 2, tAbs: 2 },
  ];

  it('returns null for an empty track', () => {
    expect(nearestKeyframeOnCurve([], 0.5)).toBeNull();
  });

  it('picks the nearest by abs time', () => {
    expect(nearestKeyframeOnCurve(kfs, 0.4)?.t).toBe(0);
    expect(nearestKeyframeOnCurve(kfs, 0.6)?.t).toBe(1);
    expect(nearestKeyframeOnCurve(kfs, 1.9)?.t).toBe(2);
  });

  it('ties break toward the earlier key in the list (stable left)', () => {
    // Midpoint between 0 and 1 → equal distance; first min wins.
    expect(nearestKeyframeOnCurve(kfs, 0.5)?.t).toBe(0);
  });
});
