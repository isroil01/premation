import { flattenPath, interpolationTimes, matchVertices, resample, smartInterpolate } from './smartMaskInterpolation';
import type { BezierPath } from '@motion/engine-api';

const poly = (pts: Array<[number, number]>, closed = true): BezierPath => ({
  vertices: pts.flat(),
  inTangents: pts.flatMap(() => [0, 0]),
  outTangents: pts.flatMap(() => [0, 0]),
  closed,
  featherPoints: [],
  vertexStates: [],
});

const square = (cx: number, cy: number, r: number): BezierPath => poly([[cx - r, cy - r], [cx + r, cy - r], [cx + r, cy + r], [cx - r, cy + r]]);

describe('smart mask interpolation (AE parity 5.4)', () => {
  it('resamples an outline evenly by arc length', () => {
    const pts = resample(flattenPath(square(0, 0, 10)), 8, true);
    expect(pts).toHaveLength(8);
    for (let i = 0; i < 8; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % 8]!;
      expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y)).toBeCloseTo(10, 6);
    }
  });

  it('halfway between a square and the same square moved is the square halfway', () => {
    const [mid] = smartInterpolate(square(0, 0, 10), square(100, 0, 10), [0.5], { vertexSpacing: 0 });
    const xs = mid!.vertices.filter((_, i) => i % 2 === 0);
    expect(Math.min(...xs)).toBeCloseTo(40, 5);
    expect(Math.max(...xs)).toBeCloseTo(60, 5);
  });

  it('a turned shape turns instead of collapsing (polar about the centroid)', () => {
    const a = poly([[-10, 0], [0, -2], [10, 0], [0, 2]]);
    const b = poly([[0, -10], [2, 0], [0, 10], [-2, 0]]);  // a quarter turn
    const [mid] = smartInterpolate(a, b, [0.5], { vertexSpacing: 0, oneToOne: true });
    // The tips stay ~10 from the centre at the midpoint; a straight lerp would pass ~7.07.
    const tip = Math.hypot(mid!.vertices[0]!, mid!.vertices[1]!);
    expect(tip).toBeGreaterThan(9.5);
  });

  it('finds the rotation that matches the shapes when the first vertices differ', () => {
    const a = resample(flattenPath(square(0, 0, 10)), 8, true);
    const shifted = [...a.slice(3), ...a.slice(0, 3)];
    const matched = matchVertices(a, shifted, true, { firstVerticesMatch: false, quality: 1 });
    expect(matched[0]).toEqual(a[0]);
    const kept = matchVertices(a, shifted, true, { firstVerticesMatch: true, quality: 1 });
    expect(kept[0]).toEqual(shifted[0]);
  });

  it('adds vertices at the requested spacing and keeps every in-between the same size', () => {
    const shapes = smartInterpolate(square(0, 0, 10), poly([[0, -12], [12, 12], [-12, 12]]), [0.25, 0.5, 0.75], { vertexSpacing: 5 });
    const counts = new Set(shapes.map((s) => s.vertices.length));
    expect(counts.size).toBe(1);
    expect(shapes[0]!.vertices.length / 2).toBeGreaterThanOrEqual(16);
  });

  it('key times between two keys at a rate, exclusive', () => {
    expect(interpolationTimes(1, 2, 4)).toEqual([1.25, 1.5, 1.75]);
    expect(interpolationTimes(2, 1, 4)).toEqual([]);
  });
});
