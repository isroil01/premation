/**
 * The bounce assistant's geometry.
 *
 * Pure-function tests, because the thing that makes a bounce read as gravity
 * rather than as a wobble is arithmetic — overshoot and duration decaying
 * TOGETHER — and that is invisible in a screenshot and tedious to judge by eye.
 */

import { bounceTracks, DEFAULT_BOUNCE } from './keyframeAssistants';
import type { PresetTrack } from './animationPresets';

/** A fall: y goes 0 → 100 over half a second. */
const fall = (): PresetTrack => ({
  prop: 'y' as PresetTrack['prop'],
  keyframes: [{ t: 0, value: 0 }, { t: 0.5, value: 100 }],
});

describe('bounceTracks', () => {
  it('adds two keyframes per bounce — a peak and a return', () => {
    const [t] = bounceTracks([fall()], { bounces: 3, decay: 0.5, elasticity: 0.35 });
    expect(t!.keyframes).toHaveLength(2 + 3 * 2);
  });

  it('overshoots AGAINST the direction of travel', () => {
    // Land after a fall and you rebound upward. Overshooting the same way the
    // layer was already moving is the sign error this pins.
    const [t] = bounceTracks([fall()], DEFAULT_BOUNCE);
    const firstPeak = t!.keyframes[2]!;
    expect(firstPeak.value).toBeLessThan(100);
  });

  it('returns to the landing value after every bounce', () => {
    const [t] = bounceTracks([fall()], { bounces: 3, decay: 0.5, elasticity: 0.35 });
    for (const i of [3, 5, 7]) expect(t!.keyframes[i]!.value).toBeCloseTo(100, 9);
  });

  it('decays the overshoot', () => {
    const [t] = bounceTracks([fall()], { bounces: 3, decay: 0.5, elasticity: 0.4 });
    const peaks = [2, 4, 6].map((i) => Math.abs(100 - t!.keyframes[i]!.value));
    expect(peaks[1]!).toBeLessThan(peaks[0]!);
    expect(peaks[2]!).toBeLessThan(peaks[1]!);
    expect(peaks[1]! / peaks[0]!).toBeCloseTo(0.5, 6);
  });

  it('decays the DURATION too, not just the height', () => {
    // The one that separates gravity from a wobble: shrinking the overshoot
    // while holding the timing gives an even, mechanical flutter.
    const [t] = bounceTracks([fall()], { bounces: 3, decay: 0.5, elasticity: 0.4 });
    const k = t!.keyframes;
    const first = k[3]!.t - k[1]!.t;
    const second = k[5]!.t - k[3]!.t;
    expect(second).toBeLessThan(first);
    expect(second / first).toBeCloseTo(0.5, 6);
  });

  it('advances monotonically in time', () => {
    const [t] = bounceTracks([fall()], DEFAULT_BOUNCE);
    for (let i = 1; i < t!.keyframes.length; i++) {
      expect(t!.keyframes[i]!.t).toBeGreaterThan(t!.keyframes[i - 1]!.t);
    }
  });

  it('leaves a track with nothing to bounce off alone', () => {
    const single: PresetTrack = { prop: 'y' as PresetTrack['prop'], keyframes: [{ t: 0, value: 0 }] };
    const hold: PresetTrack = {
      prop: 'y' as PresetTrack['prop'],
      keyframes: [{ t: 0, value: 5 }, { t: 1, value: 5 }],
    };
    expect(bounceTracks([single], DEFAULT_BOUNCE)[0]!.keyframes).toHaveLength(1);
    expect(bounceTracks([hold], DEFAULT_BOUNCE)[0]!.keyframes).toHaveLength(2);
  });

  it('zero bounces or zero elasticity is a no-op', () => {
    expect(bounceTracks([fall()], { ...DEFAULT_BOUNCE, bounces: 0 })[0]!.keyframes).toHaveLength(2);
    expect(bounceTracks([fall()], { ...DEFAULT_BOUNCE, elasticity: 0 })[0]!.keyframes).toHaveLength(2);
  });

  it('bounces upward travel downward', () => {
    // Symmetry: a rise should rebound below its landing, not above it.
    const rise: PresetTrack = {
      prop: 'y' as PresetTrack['prop'],
      keyframes: [{ t: 0, value: 100 }, { t: 0.5, value: 0 }],
    };
    const [t] = bounceTracks([rise], DEFAULT_BOUNCE);
    expect(t!.keyframes[2]!.value).toBeGreaterThan(0);
  });

  it('does not mutate the input tracks', () => {
    const input = fall();
    bounceTracks([input], DEFAULT_BOUNCE);
    expect(input.keyframes).toHaveLength(2);
  });
});
