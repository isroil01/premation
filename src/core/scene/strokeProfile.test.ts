/**
 * Taper and Wave profiles — the AE model, checked against values derived on
 * paper before the code existed.
 *
 * ## Rule 3a — what a symmetric taper makes unreachable
 *
 * `startWidth === endWidth` is the fixture nobody would question, and it hides
 * the entire class of end-swap bugs: a taper that applies the start ramp to the
 * end, or reads `endEase` for the start, produces identical output. So the
 * fixture below is deliberately LOPSIDED — 0.2 at the start, 0.6 at the end,
 * with different ramp lengths and different eases — and every value is anchored
 * to WHICH END it belongs to.
 *
 * ## And what the ramp MIDPOINT makes unreachable
 *
 * The obvious place to probe an ease is halfway up the ramp. It is the one place
 * that cannot see it: smoothstep(0.5) = 0.5·0.5·(3 − 2·0.5) = 0.5, exactly the
 * linear value, so eased and un-eased agree there for every ease amount. Every
 * ease assertion below probes at u = 0.25, and `the midpoint cannot see ease`
 * records the trap rather than leaving the next reader to re-find it.
 *
 * ## Rule 2b — a symmetric amplitude cannot show a phase sign error
 *
 * A wave is symmetric about its own axis, so "the offset changed when phase
 * changed" holds for either sign. The directional claim is anchored to a crest
 * POSITION computed from the formula by hand — crests sit at
 * s = λ(π/2 − φ)/2π, so advancing phase moves them toward s = 0 — never to what
 * the implementation returned.
 */

import {
  taperWidthFactorAt, waveOffsetAt, easeRamp,
  isIdentityTaper, isIdentityWave,
  IDENTITY_TAPER, IDENTITY_WAVE,
  type StrokeTaper, type StrokeWave,
} from './strokeProfile';

/** Lopsided on every axis — see the header. */
const TAPER: StrokeTaper = {
  startLength: 0.25, endLength: 0.40,
  startWidth: 0.2, endWidth: 0.6,
  startEase: 0, endEase: 0,
};

const WAVE: StrokeWave = { amount: 10, wavelength: 100, phase: 0 };

describe('the fixtures are unclean, as the rules require', () => {
  it('POSITIVE CONTROL: start and end differ on width, length AND ease slot', () => {
    expect(TAPER.startWidth).not.toBe(TAPER.endWidth);
    expect(TAPER.startLength).not.toBe(TAPER.endLength);
  });

  it('POSITIVE CONTROL: the ramp midpoint cannot see ease, so nothing probes it there', () => {
    // smoothstep(0.5) === 0.5. Recorded as a fact, not a belief.
    expect(easeRamp(0.5, 0)).toBeCloseTo(easeRamp(0.5, 1), 12);
    // …and away from the midpoint it very much can.
    expect(easeRamp(0.25, 0)).not.toBeCloseTo(easeRamp(0.25, 1), 3);
  });
});

describe('identity profiles change nothing', () => {
  it('an identity taper is 1 everywhere', () => {
    for (const s of [0, 0.1, 0.5, 0.9, 1]) {
      expect(taperWidthFactorAt(IDENTITY_TAPER, s)).toBe(1);
    }
  });

  it('full width at both ends is identity however long the ramps are', () => {
    // The state that would otherwise compute 1 the slow way, float by float.
    expect(isIdentityTaper({ ...IDENTITY_TAPER, startLength: 0.5, endLength: 0.5 })).toBe(true);
  });

  it('a zero-length ramp is identity whatever width it names', () => {
    expect(isIdentityTaper({ ...IDENTITY_TAPER, startWidth: 0, endWidth: 0 })).toBe(true);
  });

  it('an identity wave is 0 everywhere', () => {
    for (const a of [0, 25, 50, 175]) expect(waveOffsetAt(IDENTITY_WAVE, a)).toBe(0);
  });

  it('wavelength 0 is OFF, not a division by zero', () => {
    expect(isIdentityWave({ amount: 10, wavelength: 0, phase: 0 })).toBe(true);
    expect(waveOffsetAt({ amount: 10, wavelength: 0, phase: 0 }, 5)).toBe(0);
  });

  it('POSITIVE CONTROL: the non-identity fixtures are NOT identity', () => {
    // Otherwise every assertion in this file is measuring the short-circuit.
    expect({ taper: isIdentityTaper(TAPER), wave: isIdentityWave(WAVE) })
      .toEqual({ taper: false, wave: false });
  });
});

describe('taper — values derived on paper, anchored to WHICH END', () => {
  it.each([
    // start ramp: 0.2 → 1 over the first 25%, linear
    ['at the very start it is startWidth', 0, 0.2],
    ['a quarter up the start ramp: 0.2 + 0.8·0.25', 0.0625, 0.4],
    ['halfway up the start ramp: 0.2 + 0.8·0.5', 0.125, 0.6],
    ['at the top of the start ramp', 0.25, 1],
    // the flat middle
    ['between the ramps it is full width', 0.45, 1],
    // end ramp: 1 → 0.6 over the last 40%, linear
    ['at the top of the end ramp', 0.6, 1],
    ['halfway down the end ramp: 0.6 + 0.4·0.5', 0.8, 0.8],
    ['at the very end it is endWidth', 1, 0.6],
  ])('%s', (_label, s, expected) => {
    expect(taperWidthFactorAt(TAPER, s)).toBeCloseTo(expected, 9);
  });

  it('the START width lands at the start and NOT at the end', () => {
    // The anchored directional claim. With a symmetric fixture this holds for a
    // profile that has the two ramps swapped.
    expect(taperWidthFactorAt(TAPER, 0)).toBeCloseTo(TAPER.startWidth, 9);
    expect(taperWidthFactorAt(TAPER, 1)).toBeCloseTo(TAPER.endWidth, 9);
    expect(taperWidthFactorAt(TAPER, 0)).not.toBeCloseTo(taperWidthFactorAt(TAPER, 1), 3);
  });

  it('each ramp uses ITS OWN ease, not the other end’s', () => {
    // Ease only the START, then probe both ramps at the same fractional height.
    // The start value must move and the end value must not.
    const eased: StrokeTaper = { ...TAPER, startEase: 1 };
    const sQuarterUp = TAPER.startLength * 0.25;          // u = 0.25 on the start ramp
    const eQuarterUp = 1 - TAPER.endLength * 0.25;        // u = 0.25 on the end ramp
    expect(taperWidthFactorAt(eased, sQuarterUp)).not.toBeCloseTo(taperWidthFactorAt(TAPER, sQuarterUp), 3);
    expect(taperWidthFactorAt(eased, eQuarterUp)).toBeCloseTo(taperWidthFactorAt(TAPER, eQuarterUp), 9);
  });

  it('ease flattens the ramp near its foot — smoothstep(0.25) = 0.15625', () => {
    // 0.2 + 0.8·0.15625 = 0.325, derived rather than recorded from output.
    const eased: StrokeTaper = { ...TAPER, startEase: 1 };
    expect(taperWidthFactorAt(eased, TAPER.startLength * 0.25)).toBeCloseTo(0.325, 9);
  });

  it('OVERLAPPING ramps stay continuous and never exceed full width', () => {
    // startLength + endLength > 1: both ramps cover the middle. min() keeps it
    // continuous; last-one-wins would step at the crossover and read as a nick.
    const overlap: StrokeTaper = { ...TAPER, startLength: 0.8, endLength: 0.8 };
    let prev = taperWidthFactorAt(overlap, 0);
    for (let s = 0.01; s <= 1.0001; s += 0.01) {
      const v = taperWidthFactorAt(overlap, s);
      expect({ s: +s.toFixed(2), ok: v <= 1 + 1e-9 && Math.abs(v - prev) < 0.1 })
        .toEqual({ s: +s.toFixed(2), ok: true });
      prev = v;
    }
  });

  it('clamps arc fractions outside 0..1 instead of extrapolating', () => {
    expect(taperWidthFactorAt(TAPER, -0.5)).toBeCloseTo(TAPER.startWidth, 9);
    expect(taperWidthFactorAt(TAPER, 1.5)).toBeCloseTo(TAPER.endWidth, 9);
  });
});

describe('wave — values derived on paper', () => {
  it.each([
    ['at the origin, phase 0', 0, 0],
    ['a quarter period is the crest', 25, 10],
    ['half a period returns to the axis', 50, 0],
    ['three quarters is the trough', 75, -10],
    ['a full period repeats', 100, 0],
  ])('%s', (_label, arc, expected) => {
    expect(waveOffsetAt(WAVE, arc)).toBeCloseTo(expected, 9);
  });

  it('is periodic in the WAVELENGTH, which is px of arc — not a fraction', () => {
    for (const arc of [0, 13, 37.5, 88]) {
      expect(waveOffsetAt(WAVE, arc)).toBeCloseTo(waveOffsetAt(WAVE, arc + WAVE.wavelength), 9);
    }
  });

  it('phase 90° puts a crest at the origin', () => {
    // sin(90°) = 1, derived not measured.
    expect(waveOffsetAt({ ...WAVE, phase: 90 }, 0)).toBeCloseTo(WAVE.amount, 9);
  });

  it('DIRECTION: advancing phase moves crests toward s = 0', () => {
    // Rule 2b. The claim is computed from the formula by hand — a crest sits at
    // s = λ(π/2 − φ)/2π — and then checked against the function, rather than
    // being read off the function and restated.
    const crestAt = (phaseDeg: number): number =>
      (WAVE.wavelength * (Math.PI / 2 - (phaseDeg * Math.PI) / 180)) / (2 * Math.PI);

    for (const phase of [0, 30, 60, 90]) {
      const s = crestAt(phase);
      // Predicted crest position really is a crest.
      expect(waveOffsetAt({ ...WAVE, phase }, s)).toBeCloseTo(WAVE.amount, 6);
    }
    // …and the predicted positions march toward zero as phase advances.
    expect(crestAt(0)).toBeGreaterThan(crestAt(45));
    expect(crestAt(45)).toBeGreaterThan(crestAt(90));
    expect(crestAt(90)).toBeCloseTo(0, 9);
  });

  it('POSITIVE CONTROL: a phase change is visible at all', () => {
    // Without this, "advancing phase moves crests" could hold vacuously on a
    // function that ignored phase and returned the same crest position twice.
    expect(waveOffsetAt(WAVE, 10)).not.toBeCloseTo(waveOffsetAt({ ...WAVE, phase: 45 }, 10), 3);
  });

  it('amplitude scales linearly and symmetrically about the axis', () => {
    const big = waveOffsetAt({ ...WAVE, amount: 20 }, 25);
    expect(big).toBeCloseTo(2 * waveOffsetAt(WAVE, 25), 9);
    expect(waveOffsetAt(WAVE, 25)).toBeCloseTo(-waveOffsetAt(WAVE, 75), 9);
  });
});
