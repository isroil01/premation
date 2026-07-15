import { motionBlurSampleTimes, readNodeMotionBlur } from './motionBlur';
import type { SceneNode } from '@core/types';

function nodeWithFx(props?: Record<string, unknown>): SceneNode {
  return { components: props ? [{ type: 'fx', props }] : [] } as unknown as SceneNode;
}

describe('motionBlurSampleTimes', () => {
  test('returns [t] when a single sample is requested', () => {
    expect(motionBlurSampleTimes(1, 60, 180, 1)).toEqual([1]);
  });

  test('returns [t] with a closed shutter', () => {
    expect(motionBlurSampleTimes(1, 60, 0, 8)).toEqual([1]);
  });

  test('spreads N samples symmetrically about t across the shutter interval', () => {
    // fps 60, 180° → shutter = 0.5 frame = 0.5/60 s. Centred on t=1.
    const shutter = 0.5 / 60;
    const times = motionBlurSampleTimes(1, 60, 180, 4);
    expect(times).toHaveLength(4);
    expect(times[0]).toBeCloseTo(1 - shutter / 2, 10);
    expect(times[3]).toBeCloseTo(1 + shutter / 2, 10);
    // Symmetric about the centre.
    expect(times[0]! + times[3]!).toBeCloseTo(2, 10);
    expect(times[1]! + times[2]!).toBeCloseTo(2, 10);
    // Evenly spaced.
    const d = times[1]! - times[0]!;
    expect(times[2]! - times[1]!).toBeCloseTo(d, 10);
    expect(times[3]! - times[2]!).toBeCloseTo(d, 10);
  });

  test('is deterministic (same inputs → identical output)', () => {
    expect(motionBlurSampleTimes(2.5, 30, 90, 6)).toEqual(motionBlurSampleTimes(2.5, 30, 90, 6));
  });

  test('shutter angle scales the interval; 360° = one full frame', () => {
    const times = motionBlurSampleTimes(0, 30, 360, 2);
    expect(times[0]).toBeCloseTo(-0.5 / 30, 10);
    expect(times[1]).toBeCloseTo(0.5 / 30, 10);
  });

  test('clamps shutter angle to [0,360] and floors sample count', () => {
    expect(motionBlurSampleTimes(0, 60, 720, 4)).toEqual(motionBlurSampleTimes(0, 60, 360, 4));
    expect(motionBlurSampleTimes(0, 60, 180, 3.9)).toHaveLength(3);
  });

  test('shutterPhase -90 centers exposure on frame time exactly (AE default)', () => {
    const times = motionBlurSampleTimes(1, 60, 180, 3, -90);
    expect(times).toHaveLength(3);
    const shutter = 0.5 / 60;
    expect(times[0]).toBeCloseTo(1 - shutter / 2, 10);
    expect(times[1]).toBeCloseTo(1, 10);
    expect(times[2]).toBeCloseTo(1 + shutter / 2, 10);
  });

  test('shutterPhase shifts exposure interval relative to frame time', () => {
    // phase 0° starts right at frame time t
    const times = motionBlurSampleTimes(1, 60, 180, 3, 0);
    expect(times[0]).toBeCloseTo(1, 10);
    expect(times[2]).toBeCloseTo(1 + 0.5 / 60, 10);
  });

  test('adaptiveSampleLimit caps effective samples when requested samples exceed limit', () => {
    const times = motionBlurSampleTimes(1, 60, 180, 32, -90, 8);
    expect(times).toHaveLength(8);
  });
});

describe('readNodeMotionBlur', () => {
  test('true only for an explicit flag', () => {
    expect(readNodeMotionBlur(nodeWithFx())).toBe(false);
    expect(readNodeMotionBlur(nodeWithFx({ motionBlur: true }))).toBe(true);
    expect(readNodeMotionBlur(nodeWithFx({ motionBlur: 'yes' as unknown as boolean }))).toBe(false);
  });
});
