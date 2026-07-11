import { cubicBezierEase, sampleTrack } from './interpolate';
import type { PropertyTrack } from './types';

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

describe('sampleTrack with bezier easing', () => {
  it('uses the keyframe bezier handles', () => {
    const track: PropertyTrack = {
      nodeId: 'n', prop: 'x',
      keyframes: [
        { t: 0, value: 0, easing: 'bezier', bezier: [0, 0.8, 0.2, 1] },
        { t: 1, value: 100 },
      ],
    };
    // With a strong ease-out, the midpoint value should exceed the linear 50.
    expect(sampleTrack(track, 0.5)!).toBeGreaterThan(50);
  });
});
