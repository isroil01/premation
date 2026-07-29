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

  it('a negative value change gives a negative speed', () => {
    expect(outgoingSpeed(LINEAR, -DV, DT)).toBeCloseTo(-50, 6);
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
  it.each([0, 10, 50, 120, -30])('setting outgoing speed to %p reads back the same', (target) => {
    const bz = withOutgoingSpeed(LINEAR, DV, DT, target);
    expect(outgoingSpeed(bz, DV, DT)).toBeCloseTo(target, 6);
  });

  it.each([0, 10, 50, 120, -30])('setting incoming speed to %p reads back the same', (target) => {
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
