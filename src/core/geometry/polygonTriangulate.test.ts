import { triangulateRings, signedArea, groupRings, pointInRing } from './polygonTriangulate';

function triArea(v: ReadonlyArray<{ x: number; y: number }>, t: ReadonlyArray<number>): number {
  let a = 0;
  for (let i = 0; i < t.length; i += 3) {
    const p = v[t[i]!]!, q = v[t[i + 1]!]!, r = v[t[i + 2]!]!;
    a += Math.abs((q.x - p.x) * (r.y - p.y) - (r.x - p.x) * (q.y - p.y)) / 2;
  }
  return a;
}

const square = (cx: number, cy: number, s: number) => [
  { x: cx - s, y: cy - s }, { x: cx + s, y: cy - s }, { x: cx + s, y: cy + s }, { x: cx - s, y: cy + s },
];

describe('triangulateRings', () => {
  it('a square becomes two triangles covering its area', () => {
    const { vertices, triangles } = triangulateRings(square(0, 0, 10));
    expect(triangles.length).toBe(6);
    expect(triArea(vertices, triangles)).toBeCloseTo(400, 6);
  });

  it('accepts either winding', () => {
    const cw = square(0, 0, 10).reverse();
    const { vertices, triangles } = triangulateRings(cw);
    expect(triArea(vertices, triangles)).toBeCloseTo(400, 6);
  });

  it('a square with a square hole — area is outer minus hole, no triangle covers the hole', () => {
    const { vertices, triangles } = triangulateRings(square(0, 0, 10), [square(0, 0, 4)]);
    expect(triangles.length).toBeGreaterThan(0);
    expect(triArea(vertices, triangles)).toBeCloseTo(400 - 64, 4);
    // Every triangle centroid lies outside the hole.
    for (let i = 0; i < triangles.length; i += 3) {
      const p = vertices[triangles[i]!]!, q = vertices[triangles[i + 1]!]!, r = vertices[triangles[i + 2]!]!;
      const c = { x: (p.x + q.x + r.x) / 3, y: (p.y + q.y + r.y) / 3 };
      expect(pointInRing(c, square(0, 0, 4))).toBe(false);
    }
  });

  it('two holes (a "B"): area conserved, every centroid inside outer and outside both holes', () => {
    const outer = square(0, 0, 20);
    const h1 = square(0, -9, 5);
    const h2 = square(0, 9, 5);
    const { vertices, triangles } = triangulateRings(outer, [h1, h2]);
    expect(triArea(vertices, triangles)).toBeCloseTo(1600 - 200, 4);
    for (let i = 0; i < triangles.length; i += 3) {
      const p = vertices[triangles[i]!]!, q = vertices[triangles[i + 1]!]!, r = vertices[triangles[i + 2]!]!;
      const c = { x: (p.x + q.x + r.x) / 3, y: (p.y + q.y + r.y) / 3 };
      expect(pointInRing(c, outer)).toBe(true);
      expect(pointInRing(c, h1)).toBe(false);
      expect(pointInRing(c, h2)).toBe(false);
    }
  });

  it('a concave L shape triangulates without covering the notch', () => {
    const L = [
      { x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 30 }, { x: 0, y: 30 },
    ];
    const { vertices, triangles } = triangulateRings(L);
    expect(triArea(vertices, triangles)).toBeCloseTo(500, 6);
    expect(triangles.length).toBe(4 * 3);
  });

  it('a polygon ring approximating a circle with a circular hole (an O)', () => {
    const ring = (r: number, n: number) => Array.from({ length: n }, (_, i) => ({ x: r * Math.cos((i / n) * Math.PI * 2), y: r * Math.sin((i / n) * Math.PI * 2) }));
    const outer = ring(50, 64);
    const hole = ring(25, 48);
    const { vertices, triangles } = triangulateRings(outer, [hole]);
    const expected = Math.abs(signedArea(outer)) - Math.abs(signedArea(hole));
    expect(triArea(vertices, triangles)).toBeCloseTo(expected, 3);
  });

  it('degenerate input yields nothing rather than throwing', () => {
    expect(triangulateRings([{ x: 0, y: 0 }, { x: 1, y: 1 }]).triangles).toEqual([]);
    expect(triangulateRings([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]).triangles).toEqual([]);
  });
});

describe('groupRings', () => {
  it('assigns each hole to the smallest outer ring containing it', () => {
    const big = square(0, 0, 100);
    const small = square(50, 50, 20);
    const holeInSmall = square(50, 50, 5);
    const holeInBig = square(-50, -50, 5);
    const groups = groupRings([
      { points: big, hole: false },
      { points: small, hole: false },
      { points: holeInSmall, hole: true },
      { points: holeInBig, hole: true },
    ]);
    expect(groups.length).toBe(2);
    const gBig = groups.find((g) => g.outer === big)!;
    const gSmall = groups.find((g) => g.outer === small)!;
    expect(gBig.holes).toEqual([holeInBig]);
    expect(gSmall.holes).toEqual([holeInSmall]);
  });
});
