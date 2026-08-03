/**
 * M7 — protected time regions.
 *
 * The assertion that matters is not "the maths is linear". It is that keyframe
 * times INSIDE a protected region are unchanged by a stretch, and only the
 * unprotected middle absorbs the difference. That is what makes one lower-third
 * reusable at any length, and it is the property a uniform stretch destroys.
 */

import {
  stretchedToAuthored,
  normalizeRegions,
  protectedTotal,
  effectiveDuration,
  type ProtectedRegion,
} from './responsiveTime';

/** Authored 5s: 0.6s intro, 0.6s outro, 3.8s of flexible hold. */
const AUTHORED = 5;
const INTRO: ProtectedRegion = { startSec: 0, endSec: 0.6 };
const OUTRO: ProtectedRegion = { startSec: 4.4, endSec: 5 };
const REGIONS = [INTRO, OUTRO];

const near = (a: number, b: number, eps = 1e-6): void => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('normalizeRegions', () => {
  it('drops empty and inverted spans', () => {
    expect(normalizeRegions([{ startSec: 1, endSec: 1 }], 5)).toEqual([]);
    // Inverted is a drag that crossed over, not an error — read it as the span.
    expect(normalizeRegions([{ startSec: 2, endSec: 1 }], 5)).toEqual([{ startSec: 1, endSec: 2 }]);
  });

  it('clamps into the composition', () => {
    expect(normalizeRegions([{ startSec: -3, endSec: 99 }], 5)).toEqual([{ startSec: 0, endSec: 5 }]);
  });

  it('MERGES overlaps rather than summing them', () => {
    // Summing would over-count the protected total, shrink the flexible
    // remainder below what is really there, and show up as a template that
    // refuses to stretch for no visible reason.
    const merged = normalizeRegions([{ startSec: 0, endSec: 2 }, { startSec: 1, endSec: 3 }], 5);
    expect(merged).toEqual([{ startSec: 0, endSec: 3 }]);
    expect(protectedTotal(merged)).toBe(3);
  });

  it('sorts out-of-order input', () => {
    expect(normalizeRegions([OUTRO, INTRO], AUTHORED)).toEqual([INTRO, OUTRO]);
  });
});

describe('stretchedToAuthored — the protected-region property', () => {
  it('is the identity when the target equals the authored duration', () => {
    for (const t of [0, 0.3, 0.6, 2.5, 4.4, 5]) {
      near(stretchedToAuthored(t, AUTHORED, AUTHORED, REGIONS), t);
    }
  });

  it('LENGTHENING leaves the intro untouched', () => {
    // 5s -> 8s. Every time inside the 0.6s intro maps to itself, so intro
    // keyframes play at exactly their authored speed.
    for (const t of [0, 0.1, 0.3, 0.59]) {
      near(stretchedToAuthored(t, AUTHORED, 8, REGIONS), t);
    }
  });

  it('SHORTENING leaves the intro untouched too', () => {
    for (const t of [0, 0.2, 0.59]) {
      near(stretchedToAuthored(t, AUTHORED, 3, REGIONS), t);
    }
  });

  it('the outro keeps its duration and lands at the new end', () => {
    // Stretched to 8s, the outro occupies the last 0.6s: 7.4 -> 4.4, 8 -> 5.
    near(stretchedToAuthored(7.4, AUTHORED, 8, REGIONS), 4.4);
    near(stretchedToAuthored(8, AUTHORED, 8, REGIONS), 5);
    near(stretchedToAuthored(7.7, AUTHORED, 8, REGIONS), 4.7);
  });

  it('only the MIDDLE absorbs the difference', () => {
    // Flexible authored 3.8s becomes 6.8s at target 8 — scale 6.8/3.8.
    const scale = 6.8 / 3.8;
    // Midpoint of the stretched middle maps to the midpoint of the authored one.
    near(stretchedToAuthored(0.6 + 3.4, AUTHORED, 8, REGIONS), 0.6 + 3.4 / scale);
  });

  it('is monotonic — time never runs backwards under a stretch', () => {
    // A non-monotonic map would make the playhead jump around mid-scrub.
    let prev = -Infinity;
    for (let t = 0; t <= 8; t += 0.05) {
      const a = stretchedToAuthored(t, AUTHORED, 8, REGIONS);
      expect(a).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = a;
    }
  });

  it('is continuous across every region boundary', () => {
    // A discontinuity would show as a visible jump exactly where the intro ends
    // — the most conspicuous frame in the whole template.
    for (const edge of [0.6, 7.4]) {
      const before = stretchedToAuthored(edge - 1e-4, AUTHORED, 8, REGIONS);
      const after = stretchedToAuthored(edge + 1e-4, AUTHORED, 8, REGIONS);
      expect(Math.abs(after - before)).toBeLessThan(1e-3);
    }
  });

  it('falls back to a uniform stretch with no regions', () => {
    near(stretchedToAuthored(4, AUTHORED, 10, []), 2);
    near(stretchedToAuthored(4, AUTHORED, 10, undefined), 2);
  });

  it('is the identity when EVERY second is protected', () => {
    const all = [{ startSec: 0, endSec: AUTHORED }];
    for (const t of [0, 1, 4.9]) near(stretchedToAuthored(t, AUTHORED, 12, all), t);
  });

  it('refuses to squeeze below the protected total', () => {
    // Target 0.5s against 1.2s of protected animation. The protected spans keep
    // authored speed and the result runs long, deliberately: crushing the very
    // animation the user marked un-squeezable is not recoverable, a slightly
    // long template is.
    near(stretchedToAuthored(0.3, AUTHORED, 0.5, REGIONS), 0.3);
    expect(effectiveDuration(AUTHORED, 0.5, REGIONS)).toBeCloseTo(1.2, 9);
  });

  it('tolerates degenerate durations rather than producing NaN', () => {
    for (const t of [0, 1]) {
      expect(Number.isFinite(stretchedToAuthored(t, 0, 5, REGIONS))).toBe(true);
      expect(Number.isFinite(stretchedToAuthored(t, 5, 0, REGIONS))).toBe(true);
    }
  });
});

describe('effectiveDuration', () => {
  it('is the target when it clears the protected total', () => {
    expect(effectiveDuration(AUTHORED, 8, REGIONS)).toBe(8);
  });

  it('floors at the protected total', () => {
    // 0.6 + 0.6 is 1.1999999999999997 in binary floating point.
    expect(effectiveDuration(AUTHORED, 1, REGIONS)).toBeCloseTo(1.2, 9);
  });
});
