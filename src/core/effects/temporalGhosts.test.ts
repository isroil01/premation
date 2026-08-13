/**
 * Echo and Wide Time, and the emission they now share.
 *
 * WHY THIS EXISTS. Wide Time is Echo's ghost mechanism with a different step
 * pattern. Implementing it as a second copy of `buildSnapshot`'s forty-line
 * emission is the shape `CompositionPass` already got burned by — two chains,
 * one of which silently dropped whatever the other had learned. So the emission
 * is written once and THIS is the seam: the part that genuinely differs.
 *
 * The ordering rule is load-bearing rather than cosmetic. Emission order is
 * z-order, so a spec that returned nearest-first would draw distant ghosts on
 * top of near ones and invert the sense of a trail.
 */

import { readGhostSpec } from './temporalGhosts';
import type { Effect } from './effects';

const FPS = 25;

const fx = (type: string, params: Record<string, number>, enabled = true): Effect =>
  ({ id: `fx_${type}`, type, enabled, params }) as Effect;

describe('no ghosts', () => {
  it('is null for a stack with neither effect', () => {
    expect(readGhostSpec([], FPS)).toBeNull();
    expect(readGhostSpec([fx('blur', { amount: 4 })], FPS)).toBeNull();
  });

  it('is null when the effect is disabled', () => {
    expect(readGhostSpec([fx('echo', { numEchoes: 4, echoTime: -0.1 }, false)], FPS)).toBeNull();
    expect(readGhostSpec([fx('wide-time', { forwardSteps: 2, backwardSteps: 2 }, false)], FPS)).toBeNull();
  });

  it('is null for Wide Time with no steps in either direction', () => {
    // Otherwise the layer pays the ghost path's cost to draw nothing.
    expect(readGhostSpec([fx('wide-time', { forwardSteps: 0, backwardSteps: 0 })], FPS)).toBeNull();
  });
});

describe('Echo', () => {
  const spec = () => readGhostSpec([fx('echo', {
    echoTime: -0.1, numEchoes: 3, startIntensity: 100, decay: 50,
  })], FPS)!;

  it('steps in ONE direction, the sign of Echo Time', () => {
    expect(spec().steps.every((s) => s.dt < 0)).toBe(true);
  });

  it('decays geometrically from Starting Intensity', () => {
    // Ordered farthest-first, so the faintest comes first.
    const ops = spec().steps.map((s) => s.opacity);
    expect(ops).toEqual([...ops].sort((a, b) => a - b));
    expect(Math.max(...ops)).toBeCloseTo(1, 5);      // k=1 at 100%
    expect(Math.min(...ops)).toBeCloseTo(0.25, 5);   // k=3 at 100% × 0.5²
  });

  it('drops ghosts too faint to see rather than drawing them', () => {
    // Each ghost is a full layer draw; a 0.1%-opacity copy costs the same as
    // an opaque one and shows nothing.
    const faint = readGhostSpec([fx('echo', {
      echoTime: -0.1, numEchoes: 40, startIntensity: 100, decay: 20,
    })], FPS)!;
    expect(faint.steps.length).toBeLessThan(40);
    expect(faint.steps.every((s) => s.opacity > 0.002)).toBe(true);
  });
});

describe('Wide Time', () => {
  const spec = () => readGhostSpec([fx('wide-time', { forwardSteps: 2, backwardSteps: 3 })], FPS)!;

  it('steps in BOTH directions — that is the whole difference from Echo', () => {
    const dts = spec().steps.map((s) => s.dt);
    expect(dts.some((d) => d > 0)).toBe(true);
    expect(dts.some((d) => d < 0)).toBe(true);
    expect(dts).toHaveLength(5);
  });

  it('steps by WHOLE FRAMES, which is the unit its controls are in', () => {
    const dts = spec().steps.map((s) => Math.round(s.dt * FPS));
    expect(new Set(dts)).toEqual(new Set([-3, -2, -1, 1, 2]));
  });

  it('weights every copy equally, counting the current frame', () => {
    // 1/(2+3+1): an average of six moments. Weighting them to sum above 1 would
    // make a STATIC layer brighter with the effect than without it.
    for (const s of spec().steps) expect(s.opacity).toBeCloseTo(1 / 6, 6);
  });

  it('composites normally and behind, because it is an average not an accumulation', () => {
    expect(spec().blend).toBe('normal');
    expect(spec().inFront).toBe(false);
  });
});

describe('ordering and precedence', () => {
  it('orders farthest-first, so nearer copies paint over more distant ones', () => {
    // Emission order IS z-order. Reversed, a trail would read as pointing the
    // wrong way.
    const s = readGhostSpec([fx('wide-time', { forwardSteps: 3, backwardSteps: 3 })], FPS)!;
    const dist = s.steps.map((x) => Math.abs(x.dt));
    expect(dist).toEqual([...dist].sort((a, b) => b - a));
  });

  it('Echo wins when a layer carries both', () => {
    // Compounding them would emit count × steps layers — a combinatorial cost
    // from a stack the user reads as "two effects", showing a picture neither
    // effect describes.
    const both = readGhostSpec([
      fx('wide-time', { forwardSteps: 4, backwardSteps: 4 }),
      fx('echo', { echoTime: -0.1, numEchoes: 2, startIntensity: 100, decay: 100 }),
    ], FPS)!;
    expect(both.steps).toHaveLength(2);
    expect(both.steps.every((s) => s.dt < 0)).toBe(true);
  });
});
