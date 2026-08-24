import {
  averageSpeed,
  outgoingSpeed,
  incomingSpeed,
  withOutgoingSpeed,
  withIncomingSpeed,
  influences,
  withOutgoingInfluence,
  withIncomingInfluence,
  type Bezier,
} from './speedGraph';

/** The cubic-bezier equivalent of linear — handles at the third-points. */
const LINEAR: Bezier = [1 / 3, 1 / 3, 2 / 3, 2 / 3];
/** AE's Easy Ease: slow out of A, slow into B. */
const EASY_EASE: Bezier = [0.25, 0.1, 0.75, 0.9];

// A segment covering 100 units in 2s → average 50/s.
const DV = 100;
const DT = 2;

describe('reading speed off a bezier', () => {
  it('a linear segment travels at its average speed throughout', () => {
    expect(averageSpeed(DV, DT)).toBe(50);
    expect(outgoingSpeed(LINEAR, DV, DT)).toBeCloseTo(50, 6);
    expect(incomingSpeed(LINEAR, DV, DT)).toBeCloseTo(50, 6);
  });

  it('an easy-ease leaves and arrives SLOWER than average', () => {
    expect(outgoingSpeed(EASY_EASE, DV, DT)).toBeLessThan(50);
    expect(incomingSpeed(EASY_EASE, DV, DT)).toBeLessThan(50);
    // y1/x1 = 0.1/0.25 = 0.4 → 20/s
    expect(outgoingSpeed(EASY_EASE, DV, DT)).toBeCloseTo(20, 6);
    // (1−0.9)/(1−0.75) = 0.4 → 20/s
    expect(incomingSpeed(EASY_EASE, DV, DT)).toBeCloseTo(20, 6);
  });

  it('a negative value change gives a positive speed magnitude', () => {
    expect(outgoingSpeed(LINEAR, -DV, DT)).toBeCloseTo(50, 6);
  });

  it('a zero-width influence reports zero rather than dividing by it', () => {
    expect(outgoingSpeed([0, 0.5, 0.5, 0.5], DV, DT)).toBe(0);
    expect(incomingSpeed([0.5, 0.5, 1, 0.5], DV, DT)).toBe(0);
  });

  it('a zero-length segment has no speed', () => {
    expect(averageSpeed(DV, 0)).toBe(0);
    expect(outgoingSpeed(LINEAR, DV, 0)).toBe(0);
  });
});

describe('writing speed back — the round trip', () => {
  it.each([0, 10, 50, 120])('setting outgoing speed to %p reads back the same', (target) => {
    const bz = withOutgoingSpeed(LINEAR, DV, DT, target);
    expect(outgoingSpeed(bz, DV, DT)).toBeCloseTo(target, 6);
  });

  it.each([0, 10, 50, 120])('setting outgoing speed on negative dv segment reads back the same', (target) => {
    const bz = withOutgoingSpeed(LINEAR, -DV, DT, target);
    expect(outgoingSpeed(bz, -DV, DT)).toBeCloseTo(target, 6);
    // Ensure y1 is non-negative and within bounds so easing curve never inverts value
    expect(bz[1]).toBeGreaterThanOrEqual(0);
  });

  it.each([0, 10, 50, 120])('setting incoming speed to %p reads back the same', (target) => {
    const bz = withIncomingSpeed(LINEAR, DV, DT, target);
    expect(incomingSpeed(bz, DV, DT)).toBeCloseTo(target, 6);
  });

  it('holds INFLUENCE fixed — speed and influence are independent axes', () => {
    const bz = withOutgoingSpeed(EASY_EASE, DV, DT, 90);
    expect(bz[0]).toBeCloseTo(EASY_EASE[0], 6);
    expect(bz[2]).toBeCloseTo(EASY_EASE[2], 6);
    expect(bz[3]).toBeCloseTo(EASY_EASE[3], 6);
  });

  it('does not disturb the OTHER side of the segment', () => {
    const bz = withOutgoingSpeed(EASY_EASE, DV, DT, 90);
    expect(incomingSpeed(bz, DV, DT)).toBeCloseTo(incomingSpeed(EASY_EASE, DV, DT), 6);
  });

  it('speed 0 is a full stop at the keyframe', () => {
    const bz = withOutgoingSpeed(LINEAR, DV, DT, 0);
    expect(bz[1]).toBeCloseTo(0, 6);
    expect(outgoingSpeed(bz, DV, DT)).toBe(0);
  });

  it('leaves the curve alone when there is no value change to speed through', () => {
    // dv = 0 → every speed is 0; solving would write a meaningless handle.
    expect(withOutgoingSpeed(EASY_EASE, 0, DT, 100)).toEqual(EASY_EASE);
    expect(withIncomingSpeed(EASY_EASE, 0, DT, 100)).toEqual(EASY_EASE);
  });

  it('leaves the curve alone for a zero-length segment', () => {
    expect(withOutgoingSpeed(EASY_EASE, DV, 0, 100)).toEqual(EASY_EASE);
  });

  it('clamps a runaway drag instead of producing an unusable curve', () => {
    const bz = withOutgoingSpeed(LINEAR, DV, DT, 1e9);
    expect(Number.isFinite(bz[1])).toBe(true);
    expect(bz[1]).toBeLessThanOrEqual(3);
  });
});

describe('influence — the horizontal axis', () => {
  it('reads both sides', () => {
    const inf = influences(EASY_EASE);
    expect(inf.out).toBeCloseTo(0.25, 6);
    expect(inf.in).toBeCloseTo(0.25, 6);
  });

  it('changing outgoing influence PRESERVES the speed it expressed', () => {
    const before = outgoingSpeed(EASY_EASE, DV, DT);
    const bz = withOutgoingInfluence(EASY_EASE, DV, DT, 0.6);
    expect(influences(bz).out).toBeCloseTo(0.6, 6);
    expect(outgoingSpeed(bz, DV, DT)).toBeCloseTo(before, 6);
  });

  it('changing incoming influence preserves its speed', () => {
    const before = incomingSpeed(EASY_EASE, DV, DT);
    const bz = withIncomingInfluence(EASY_EASE, DV, DT, 0.5);
    expect(influences(bz).in).toBeCloseTo(0.5, 6);
    expect(incomingSpeed(bz, DV, DT)).toBeCloseTo(before, 6);
  });

  it('clamps influence into (0, 1] so the handle cannot invert', () => {
    expect(influences(withOutgoingInfluence(LINEAR, DV, DT, 5)).out).toBeLessThanOrEqual(1);
    expect(influences(withOutgoingInfluence(LINEAR, DV, DT, -1)).out).toBeGreaterThan(0);
  });
});

// ── Resolving the bezier a keyframe ACTUALLY samples with ───────────

import {
  effectiveBezier,
  isHoldEasing,
  LINEAR_BEZIER,
  outgoingSlope,
  incomingSlope,
  withOutgoingSlope,
  withIncomingSlope,
} from './speedGraph';

describe('effectiveBezier', () => {
  it('uses the stored handles for bezier easings', () => {
    expect(effectiveBezier({ easing: 'bezier', bezier: EASY_EASE })).toEqual(EASY_EASE);
    expect(effectiveBezier({ easing: 'autoBezier', bezier: EASY_EASE })).toEqual(EASY_EASE);
  });

  it('IGNORES stale handles once the easing is a named curve (the Linear-preset jump)', () => {
    // 'Linear' preset keeps kf.bezier — the sampler does not read it, so neither may the editor.
    expect(effectiveBezier({ easing: 'linear', bezier: EASY_EASE })).toEqual(LINEAR_BEZIER);
    expect(effectiveBezier({ easing: undefined, bezier: EASY_EASE })).toEqual(LINEAR_BEZIER);
  });

  it('seeds named easings with a cubic approximation of their shape', () => {
    const easeIn = effectiveBezier({ easing: 'easeIn' });
    expect(outgoingSpeed(easeIn, DV, DT)).toBe(0); // starts from rest
    const easeOut = effectiveBezier({ easing: 'easeOut' });
    expect(incomingSpeed(easeOut, DV, DT)).toBe(0); // arrives at rest
  });

  it('returns a fresh array — callers mutate handles in place', () => {
    const kf = { easing: 'bezier', bezier: EASY_EASE };
    expect(effectiveBezier(kf)).not.toBe(kf.bezier);
  });

  it('knows both spellings of hold', () => {
    expect(isHoldEasing('hold')).toBe(true);
    expect(isHoldEasing('step')).toBe(true);
    expect(isHoldEasing('bezier')).toBe(false);
    expect(isHoldEasing(undefined)).toBe(false);
  });
});

describe('signed slopes — linked value-graph tangents', () => {
  it('a linear segment has slope = dv/dt on both ends, sign included', () => {
    expect(outgoingSlope(LINEAR, DV, DT)).toBeCloseTo(50, 6);
    expect(incomingSlope(LINEAR, -DV, DT)).toBeCloseTo(-50, 6);
  });

  it.each([-80, 0, 35, 200])('withOutgoingSlope(%p) reads back the same slope', (slope) => {
    const bz = withOutgoingSlope(EASY_EASE, DV, DT, slope);
    expect(outgoingSlope(bz, DV, DT)).toBeCloseTo(slope, 6);
    expect(bz[0]).toBeCloseTo(EASY_EASE[0], 6); // influence held
  });

  it.each([-80, 0, 35, 200])('withIncomingSlope(%p) reads back the same slope', (slope) => {
    const bz = withIncomingSlope(EASY_EASE, DV, DT, slope);
    expect(incomingSlope(bz, DV, DT)).toBeCloseTo(slope, 6);
    expect(bz[2]).toBeCloseTo(EASY_EASE[2], 6);
  });

  it('collinear across a keyframe: matching the neighbour keeps a smooth join', () => {
    // A(0,0) → B(2,100) → C(4,-50). Drag B's out handle to leave at −120/s …
    const out = withOutgoingSlope(LINEAR, -150, 2, -120);
    // … and the in side of A→B is solved to ARRIVE at −120/s (overshoot past B).
    const inn = withIncomingSlope(LINEAR, 100, 2, outgoingSlope(out, -150, 2));
    expect(incomingSlope(inn, 100, 2)).toBeCloseTo(-120, 6);
  });

  it('a flat segment cannot express a slope and is left alone', () => {
    expect(withOutgoingSlope(EASY_EASE, 0, DT, 50)).toBe(EASY_EASE);
    expect(withIncomingSlope(EASY_EASE, 0, DT, 50)).toBe(EASY_EASE);
  });
});
