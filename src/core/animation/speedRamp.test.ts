/**
 * Speed ramps, checked against numerically-integrated ground truth.
 *
 * The claim this file exists to defend is that two keyframes and a derived
 * Bézier reproduce the integral of a linear speed ramp EXACTLY — not closely,
 * exactly. So the curve is not compared against itself or against a golden
 * array; it is compared against a fine-grained numerical integration of the
 * same speed profile, which is what "the footage plays at this rate" actually
 * means. If the algebra in `rampBezier` were wrong, that comparison is the
 * only thing here that would notice.
 */

import { buildTimeRemap, rampBezier, sampleRemap, sourceAdvance, type SpeedPoint } from './speedRamp';

/**
 * Source time at `t`, by brute-force integration of a piecewise-linear speed
 * profile. Slow, obviously correct, and completely independent of the Bézier
 * algebra under test.
 */
function integrate(points: readonly SpeedPoint[], startSource: number, t: number, steps = 200_000): number {
  const t0 = points[0]!.t;
  const tEnd = points[points.length - 1]!.t;
  const target = Math.max(t0, Math.min(tEnd, t));
  const dt = (target - t0) / steps;
  const speedAt = (time: number): number => {
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i]!;
      const b = points[i + 1]!;
      if (time >= a.t && time <= b.t) {
        const u = b.t === a.t ? 0 : (time - a.t) / (b.t - a.t);
        return a.speed + (b.speed - a.speed) * u;
      }
    }
    return points[points.length - 1]!.speed;
  };
  let source = startSource;
  // Midpoint rule — exact for the linear speed segments being integrated.
  for (let i = 0; i < steps; i++) source += speedAt(t0 + (i + 0.5) * dt) * dt;
  return source;
}

describe('rampBezier', () => {
  it('is the straight line for constant speed', () => {
    expect(rampBezier(1, 1)).toEqual([1 / 3, 1 / 3, 2 / 3, 2 / 3]);
    expect(rampBezier(0.25, 0.25)).toEqual([1 / 3, 1 / 3, 2 / 3, 2 / 3]);
  });

  it('decelerates into a freeze', () => {
    // 100% → 0%: fast at first, stopped at the end.
    const [, y1, , y2] = rampBezier(1, 0);
    expect(y1).toBeCloseTo(2 / 3, 10);
    expect(y2).toBeCloseTo(1, 10);
  });

  it('accelerates out of a standstill', () => {
    const [, y1, , y2] = rampBezier(0, 1);
    expect(y1).toBeCloseTo(0, 10);
    expect(y2).toBeCloseTo(1 / 3, 10);
  });

  it('stays finite when a segment covers no source time', () => {
    // v₀ + v₁ = 0 is a division by zero in the coefficient form.
    for (const b of [...rampBezier(0, 0), ...rampBezier(1, -1)]) {
      expect(Number.isFinite(b)).toBe(true);
    }
  });
});

describe('sourceAdvance', () => {
  it('is the mean speed times the duration', () => {
    expect(sourceAdvance(1, 1, 2)).toBeCloseTo(2, 10);
    expect(sourceAdvance(1, 0, 2)).toBeCloseTo(1, 10);
    expect(sourceAdvance(0.5, 1.5, 4)).toBeCloseTo(4, 10);
  });

  it('goes backwards at negative speed', () => {
    expect(sourceAdvance(-1, -1, 3)).toBeCloseTo(-3, 10);
  });
});

describe('buildTimeRemap', () => {
  it('leaves constant 100% as an identity mapping', () => {
    const keys = buildTimeRemap([{ t: 0, speed: 1 }, { t: 4, speed: 1 }], 0);
    expect(keys.map((k) => k.value)).toEqual([0, 4]);
  });

  it('advances half as fast at 50%', () => {
    const keys = buildTimeRemap([{ t: 0, speed: 0.5 }, { t: 4, speed: 0.5 }], 0);
    expect(keys[keys.length - 1]!.value).toBeCloseTo(2, 10);
  });

  it('starts from the source time already on screen', () => {
    // A ramp inserted mid-clip must continue from the visible frame, not jump
    // back to the head of the source.
    const keys = buildTimeRemap([{ t: 2, speed: 1 }, { t: 3, speed: 1 }], 7.5);
    expect(keys[0]!.value).toBeCloseTo(7.5, 10);
    expect(keys[1]!.value).toBeCloseTo(8.5, 10);
  });

  it('matches brute-force integration across a ramp, at every point', () => {
    // THE test. If the Bézier algebra is wrong this fails everywhere in the
    // middle while still ending in the right place.
    const profile: SpeedPoint[] = [
      { t: 0, speed: 1 },
      { t: 1, speed: 0.25 },
      { t: 2.5, speed: 0.25 },
      { t: 3.5, speed: 1 },
    ];
    const keys = buildTimeRemap(profile, 0);
    for (let t = 0; t <= 3.5; t += 0.05) {
      expect(sampleRemap(keys, t)).toBeCloseTo(integrate(profile, 0, t), 4);
    }
  });

  it('matches integration for an accelerating ramp too', () => {
    const profile: SpeedPoint[] = [{ t: 0, speed: 0 }, { t: 2, speed: 2 }];
    const keys = buildTimeRemap(profile, 1);
    for (let t = 0; t <= 2; t += 0.05) {
      expect(sampleRemap(keys, t)).toBeCloseTo(integrate(profile, 1, t), 4);
    }
  });

  it('holds the frame at zero speed', () => {
    const keys = buildTimeRemap([{ t: 0, speed: 0 }, { t: 2, speed: 0 }], 3);
    expect(keys.map((k) => k.value)).toEqual([3, 3]);
  });

  it('splits a segment that changes direction at its zero crossing', () => {
    // +1 → −1 covers no NET source time. One curve through it would be a flat
    // line, hiding that the footage runs forward, stops, then rewinds.
    const keys = buildTimeRemap([{ t: 0, speed: 1 }, { t: 2, speed: -1 }], 0);
    expect(keys).toHaveLength(3);
    expect(keys[1]!.t).toBeCloseTo(1, 10);
    // Out to the turning point and back to where it started.
    expect(keys[1]!.value).toBeGreaterThan(keys[0]!.value);
    expect(keys[2]!.value).toBeCloseTo(keys[0]!.value, 10);
  });

  it('plays backwards at negative speed', () => {
    const keys = buildTimeRemap([{ t: 0, speed: -1 }, { t: 2, speed: -1 }], 5);
    expect(keys[keys.length - 1]!.value).toBeCloseTo(3, 10);
  });

  it('sorts a profile given out of order rather than trusting it', () => {
    const keys = buildTimeRemap([{ t: 2, speed: 1 }, { t: 0, speed: 1 }], 0);
    expect(keys.map((k) => k.t)).toEqual([0, 2]);
  });

  it('handles degenerate profiles', () => {
    expect(buildTimeRemap([], 0)).toEqual([]);
    expect(buildTimeRemap([{ t: 1, speed: 1 }], 4)).toEqual([{ t: 1, value: 4 }]);
  });

  it('gives the last key no outgoing easing', () => {
    const keys = buildTimeRemap([{ t: 0, speed: 1 }, { t: 1, speed: 0.5 }], 0);
    expect(keys[keys.length - 1]!.bezier).toBeUndefined();
    expect(keys[0]!.bezier).toBeDefined();
  });
});

describe('sampleRemap', () => {
  const keys = buildTimeRemap([{ t: 1, speed: 1 }, { t: 3, speed: 1 }], 10);

  it('holds the ends outside the curve', () => {
    expect(sampleRemap(keys, 0)).toBe(10);
    expect(sampleRemap(keys, 99)).toBe(12);
  });

  it('is monotonic through a deceleration, never running backwards', () => {
    // A curve that dips is a frame going backwards mid-ramp — the visible
    // symptom of bad handles, and invisible in an endpoints-only check.
    const ramp = buildTimeRemap([{ t: 0, speed: 1 }, { t: 1, speed: 0.05 }], 0);
    let prev = -Infinity;
    for (let t = 0; t <= 1; t += 0.01) {
      const v = sampleRemap(ramp, t);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
  });

  it('returns something sensible for an empty curve', () => {
    expect(sampleRemap([], 5)).toBe(0);
  });
});
