/**
 * Lottie bezier-path → engine `points` conversion. Pins the absolute-handle
 * convention (Lottie relative i/o → engine absolute inX/outX) and the
 * static/animated keyframe forms.
 */

import { lottieBezierToPoints, lottiePathKeyframes, type LottieBezier } from '../lottiePath';
import type { DataPoint } from '../dataTracks';

describe('lottieBezierToPoints', () => {
  it('converts relative tangents to absolute handles (handle = vertex + tangent)', () => {
    const bez: LottieBezier = {
      v: [[100, 100], [200, 100]],
      i: [[-10, 0], [-20, 5]],
      o: [[10, 0], [20, -5]],
      c: true,
    };
    const { points, closed } = lottieBezierToPoints(bez);
    expect(closed).toBe(true);
    expect(points[0]).toEqual({ x: 100, y: 100, inX: 90, inY: 100, outX: 110, outY: 100 });
    expect(points[1]).toEqual({ x: 200, y: 100, inX: 180, inY: 105, outX: 220, outY: 95 });
  });

  it('missing tangents default to zero (handle collapses onto the vertex)', () => {
    const bez: LottieBezier = { v: [[0, 0]], i: [], o: [], c: false };
    const [p] = lottieBezierToPoints(bez).points as [DataPoint];
    expect(p).toEqual({ x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 });
  });
});

describe('lottiePathKeyframes', () => {
  it('static path (a:0) yields a single keyframe at t=0', () => {
    const ks = { a: 0 as const, k: { v: [[0, 0], [10, 0]], i: [[0, 0], [0, 0]], o: [[0, 0], [0, 0]], c: false } };
    const { keyframes } = lottiePathKeyframes(ks, 30);
    expect(keyframes).toHaveLength(1);
    expect(keyframes[0]!.t).toBe(0);
    expect((keyframes[0]!.value as DataPoint[])).toHaveLength(2);
  });

  it('animated path (a:1) maps frame times to seconds via frameRate', () => {
    const shapeAt = (x: number): LottieBezier => ({ v: [[x, 0], [x + 10, 0]], i: [[0, 0], [0, 0]], o: [[0, 0], [0, 0]], c: true });
    const ks = {
      a: 1 as const,
      k: [
        { t: 0, s: [shapeAt(0)] as [LottieBezier] },
        { t: 30, s: [shapeAt(50)] as [LottieBezier] }, // 30 frames @ 30fps = 1.0s
      ],
    };
    const { keyframes, closed } = lottiePathKeyframes(ks, 30);
    expect(closed).toBe(true);
    expect(keyframes.map((k) => k.t)).toEqual([0, 1]);
    expect((keyframes[1]!.value as DataPoint[])[0]!.x).toBe(50);
  });

  it('sorts keyframes ascending even if Lottie order is scrambled', () => {
    const s = (): [LottieBezier] => [{ v: [[0, 0], [1, 0]], i: [[0, 0], [0, 0]], o: [[0, 0], [0, 0]] }];
    const ks = { a: 1 as const, k: [{ t: 60, s: s() }, { t: 0, s: s() }, { t: 30, s: s() }] };
    const { keyframes } = lottiePathKeyframes(ks, 60);
    expect(keyframes.map((k) => k.t)).toEqual([0, 0.5, 1]);
  });
});
