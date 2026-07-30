import { Mat3 } from './Mat3';
import {
  squareToQuad,
  project,
  invertProjective,
  isConvexQuad,
  isIdentityQuad,
  UNIT_QUAD,
  type Quad,
} from './Homography';

const quad = (a: [number, number], b: [number, number], c: [number, number], d: [number, number]): Quad => [
  { x: a[0], y: a[1] }, { x: b[0], y: b[1] }, { x: c[0], y: c[1] }, { x: d[0], y: d[1] },
];

describe('squareToQuad — maps the unit square corners exactly', () => {
  it('sends each unit corner to its target corner', () => {
    const q = quad([10, 20], [110, 15], [120, 90], [5, 100]);
    const m = squareToQuad(q)!;
    expect(m).not.toBeNull();
    const corners = UNIT_QUAD.map((c) => project(m, c)!);
    for (let i = 0; i < 4; i++) {
      expect(corners[i]!.x).toBeCloseTo(q[i]!.x, 4);
      expect(corners[i]!.y).toBeCloseTo(q[i]!.y, 4);
    }
  });

  it('the identity quad is the identity map', () => {
    const m = squareToQuad(UNIT_QUAD)!;
    for (const p of [{ x: 0.3, y: 0.7 }, { x: 0.9, y: 0.1 }]) {
      const r = project(m, p)!;
      expect(r.x).toBeCloseTo(p.x, 6);
      expect(r.y).toBeCloseTo(p.y, 6);
    }
  });

  it('an affine (parallelogram) quad has a trivial projective row', () => {
    // Sheared parallelogram: dx3=dy3=0, so g=h=0 and project == affine.
    const q = quad([0, 0], [2, 0], [3, 1], [1, 1]);
    const m = squareToQuad(q)!;
    expect(m[2]).toBeCloseTo(0, 9); // g
    expect(m[5]).toBeCloseTo(0, 9); // h
    // Centre of the square maps to the centroid of a parallelogram.
    const mid = project(m, { x: 0.5, y: 0.5 })!;
    expect(mid.x).toBeCloseTo(1.5, 6);
    expect(mid.y).toBeCloseTo(0.5, 6);
  });
});

describe('project — perspective foreshortening, not linear', () => {
  it('the centre of a keystoned quad is pulled toward the near (narrow) edge', () => {
    // A trapezoid narrow at the top (TL,TR close), wide at the bottom. Under a
    // true homography the square's centre does NOT land at the quad's centroid
    // (y=50) — perspective pulls it up toward the narrow top edge (y≈16.7). This
    // is the displacement affine cannot express; affine would give exactly 50.
    const q = quad([40, 0], [60, 0], [100, 100], [0, 100]);
    const m = squareToQuad(q)!;
    const centre = project(m, { x: 0.5, y: 0.5 })!;
    const centroidY = (0 + 0 + 100 + 100) / 4; // 50
    expect(centre.x).toBeCloseTo(50, 4); // symmetric in x
    expect(centre.y).toBeLessThan(centroidY - 10); // pulled well above the linear midpoint
    expect(centre.y).toBeCloseTo(16.6667, 3);
  });

  it('midpoint of the top edge lands on the segment TL→TR, but not at its half', () => {
    const q = quad([40, 0], [60, 0], [100, 100], [0, 100]);
    const m = squareToQuad(q)!;
    const topMid = project(m, { x: 0.5, y: 0 })!;
    // Along the top edge (v=0) the map is affine in u, so exactly the midpoint.
    expect(topMid.x).toBeCloseTo(50, 4);
    expect(topMid.y).toBeCloseTo(0, 4);
  });

  it('returns null on the vanishing line rather than an infinite coordinate', () => {
    const q = quad([40, 0], [60, 0], [100, 100], [0, 100]);
    const m = squareToQuad(q)!;
    // The vanishing line is where w = g·u + h·v + 1 = 0. Construct a point on it
    // from the matrix's own projective row (m[2]=g, m[5]=h) rather than guessing
    // a direction — geometry there projects to infinity and must read as null.
    const g = m[2]!, h = m[5]!;
    const onLine = Math.abs(h) > 1e-9 ? { x: 0, y: -1 / h } : { x: -1 / g, y: 0 };
    expect(project(m, onLine)).toBeNull();
    // Just inside the vanishing line it is still finite.
    expect(project(m, { x: onLine.x, y: onLine.y * 0.9 })).not.toBeNull();
  });
});

describe('invertProjective — round-trips a homography', () => {
  it('inverse ∘ forward is the identity on interior points', () => {
    const q = quad([10, 20], [110, 15], [120, 90], [5, 100]);
    const m = squareToQuad(q)!;
    const inv = invertProjective(m)!;
    for (const p of [{ x: 0.25, y: 0.25 }, { x: 0.8, y: 0.6 }, { x: 0.5, y: 0.5 }]) {
      const back = project(inv, project(m, p)!)!;
      expect(back.x).toBeCloseTo(p.x, 5);
      expect(back.y).toBeCloseTo(p.y, 5);
    }
  });

  it('agrees with Mat3.invert for an affine matrix', () => {
    const affine = Mat3.compose(30, -12, 0.4, 1.7, 0.9);
    const a = invertProjective(affine)!;
    const b = Mat3.invert(affine)!;
    expect(Mat3.equals(a, b, 1e-4)).toBe(true);
  });

  it('returns null for a singular matrix', () => {
    const singular = new Float32Array([1, 2, 3, 2, 4, 6, 3, 6, 9]) as Mat3; // rank 1
    expect(invertProjective(singular)).toBeNull();
  });
});

describe('isConvexQuad — the degenerate-guard the interaction layer needs', () => {
  it('accepts a proper convex quad', () => {
    expect(isConvexQuad(UNIT_QUAD)).toBe(true);
    expect(isConvexQuad(quad([40, 0], [60, 0], [100, 100], [0, 100]))).toBe(true);
  });

  it('rejects a bow-tie (self-intersecting) quad', () => {
    // Swap the bottom two corners → the edges cross.
    expect(isConvexQuad(quad([0, 0], [1, 0], [0, 1], [1, 1]))).toBe(false);
  });

  it('rejects a corner dragged across to make a reflex (non-convex) angle', () => {
    expect(isConvexQuad(quad([0, 0], [1, 0], [0.4, 0.4], [0, 1]))).toBe(false);
  });

  it('rejects three collinear corners', () => {
    expect(isConvexQuad(quad([0, 0], [1, 0], [2, 0], [1, 1]))).toBe(false);
  });

  it('rejects a zero-area (collapsed) quad', () => {
    expect(isConvexQuad(quad([0, 0], [0, 0], [0, 0], [0, 0]))).toBe(false);
  });
});

describe('isIdentityQuad — lets an unpinned layer stay on the affine path', () => {
  it('true for the unit square, false once a corner moves', () => {
    expect(isIdentityQuad(UNIT_QUAD)).toBe(true);
    expect(isIdentityQuad(quad([0.01, 0], [1, 0], [1, 1], [0, 1]))).toBe(false);
  });
});
