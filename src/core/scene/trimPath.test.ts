import { trimSegments, trimPolyline, pointAtLength, type Pt } from './trimPath';

describe('trimSegments', () => {
  it('full range is one arc covering everything', () => {
    expect(trimSegments(0, 100, 0)).toEqual([[0, 1]]);
  });
  it('a partial end reveals the front of the path', () => {
    expect(trimSegments(0, 50, 0)).toEqual([[0, 0.5]]);
  });
  it('offset shifts the window', () => {
    expect(trimSegments(0, 50, 50)).toEqual([[0.5, 1]]);
  });
  it('offset past the end wraps into two arcs', () => {
    const segs = trimSegments(0, 50, 75);
    expect(segs).toHaveLength(2);
    expect(segs[0]![0]).toBeCloseTo(0.75);
    expect(segs[0]![1]).toBeCloseTo(1);
    expect(segs[1]![0]).toBeCloseTo(0);
    expect(segs[1]![1]).toBeCloseTo(0.25);
  });
  it('empty when start >= end', () => {
    expect(trimSegments(50, 50, 0)).toEqual([]);
    expect(trimSegments(80, 20, 0)).toEqual([]);
  });
});

describe('pointAtLength / trimPolyline', () => {
  // A unit square, perimeter 40 (closed): (0,0)-(10,0)-(10,10)-(0,10)
  const square: Pt[] = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];

  it('samples a point at a given arc length', () => {
    expect(pointAtLength(square, true, 0)).toEqual({ x: 0, y: 0 });
    expect(pointAtLength(square, true, 5)).toEqual({ x: 5, y: 0 });
    expect(pointAtLength(square, true, 15)).toEqual({ x: 10, y: 5 });
  });

  it('slices the front half of the outline', () => {
    // [0,0.5] of perimeter 40 → 0..20 → corners (0,0),(10,0),(10,10)
    const subs = trimPolyline(square, true, [[0, 0.5]]);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
  });

  it('produces two sub-polylines for a wrapped trim', () => {
    const segs = trimSegments(0, 50, 75); // [[0.75,1],[0,0.25]]
    const subs = trimPolyline(square, true, segs);
    expect(subs).toHaveLength(2);
    // second arc [0,0.25] → 0..10 → (0,0)-(10,0)
    expect(subs[1]![0]).toEqual({ x: 0, y: 0 });
    expect(subs[1]![subs[1]!.length - 1]).toEqual({ x: 10, y: 0 });
  });

  it('returns nothing for degenerate input', () => {
    expect(trimPolyline([{ x: 0, y: 0 }], true, [[0, 1]])).toEqual([]);
    expect(trimPolyline(square, true, [])).toEqual([]);
  });
});
