/**
 * Mesh + auto-weight, plus the Phase 1→2 pipeline: an outline becomes a mesh,
 * auto-binds to a bone, and deforms when the bone moves.
 */

import { flattenOutline, earClip, buildMesh, subdivide, polygonArea, type OutlinePoint } from '../mesh';
import { distanceToSegment, boneSegments, autoWeightVertex, autoWeightMesh } from '../autoWeight';
import { computeWorldTransforms, computeBindInverses, type Skeleton } from '../skeleton';
import { skinVertex, type SkinVertex } from '../skinning';
import type { Vec2 } from '../ik';

const near = (a: number, b: number, digits = 4) => expect(a).toBeCloseTo(b, digits);

const SQUARE: OutlinePoint[] = [
  { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
];
const triArea = (a: Vec2, b: Vec2, c: Vec2) =>
  Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
const meshArea = (verts: Vec2[], tris: Array<[number, number, number]>) =>
  tris.reduce((s, [i, j, k]) => s + triArea(verts[i]!, verts[j]!, verts[k]!), 0);

describe('mesh', () => {
  it('flattenOutline returns corners for a straight closed square', () => {
    const poly = flattenOutline(SQUARE, 1, true);
    expect(poly).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]);
    expect(flattenOutline(SQUARE, 2, true)).toHaveLength(8); // 2 samples × 4 segments
  });

  it('polygonArea is positive CCW', () => {
    near(polygonArea(flattenOutline(SQUARE, 1)), 100);
  });

  it('earClip triangulates the square into 2 triangles covering its area', () => {
    const poly = flattenOutline(SQUARE, 1);
    const tris = earClip(poly);
    expect(tris).toHaveLength(2);
    near(meshArea(poly, tris), 100); // triangulation exactly covers the polygon
  });

  it('earClip handles a concave (L-shaped) polygon', () => {
    const L: Vec2[] = [
      { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 },
      { x: 10, y: 10 }, { x: 10, y: 20 }, { x: 0, y: 20 },
    ];
    const tris = earClip(L);
    expect(tris).toHaveLength(4); // n-2 triangles
    near(meshArea(L, tris), polygonArea(L)); // 300, area preserved
  });

  it('subdivide splits every triangle into four, sharing edge midpoints', () => {
    const base = buildMesh(flattenOutline(SQUARE, 1)); // 4 verts, 2 tris
    const sub = subdivide(base, 1);
    expect(sub.triangles).toHaveLength(8); // 2 × 4
    // 4 corners + 5 unique midpoints (4 outer edges + 1 shared diagonal) = 9
    expect(sub.vertices).toHaveLength(9);
    near(meshArea(sub.vertices, sub.triangles), 100); // area unchanged
  });
});

describe('auto-weight', () => {
  it('distanceToSegment: perpendicular + endpoint clamp', () => {
    near(distanceToSegment({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 5);
    near(distanceToSegment({ x: -5, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 5); // clamps to root
  });

  it('a vertex weights toward the nearer bone and sums to 1', () => {
    const segs = [
      { id: 'near', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } },
      { id: 'far', a: { x: 0, y: 100 }, b: { x: 10, y: 100 } },
    ];
    const w = autoWeightVertex({ x: 5, y: 2 }, segs, 2);
    near(w.reduce((s, x) => s + x.weight, 0), 1);
    const nearW = w.find((x) => x.boneId === 'near')!.weight;
    const farW = w.find((x) => x.boneId === 'far')?.weight ?? 0;
    expect(nearW).toBeGreaterThan(farW);
  });
});

describe('Phase 1→2 pipeline: outline → mesh → auto-weight → skin', () => {
  it('a mesh auto-bound to one bone rotates rigidly with it', () => {
    const bone: Skeleton = { bones: [{ id: 'b', parentId: null, length: 10, x: 0, y: 0, rotation: 0 }] };
    const bindWorld = computeWorldTransforms(bone);
    const bindInv = computeBindInverses(bindWorld);
    const segs = boneSegments(bone.bones, bindWorld);

    const poly = flattenOutline(SQUARE, 1);
    const weights = autoWeightMesh(poly, segs); // one bone → weight 1 everywhere
    const skinVerts: SkinVertex[] = poly.map((p, i) => ({ x: p.x, y: p.y, weights: weights[i]! }));

    // Pose the bone 90°; the whole mesh should rotate about the origin.
    const pose = computeWorldTransforms({ bones: [{ id: 'b', parentId: null, length: 10, x: 0, y: 0, rotation: Math.PI / 2 }] });
    const deformed = skinVerts.map((v) => skinVertex(v, pose, bindInv));
    // Corner (10,0) → (0,10); (0,10) → (-10,0).
    near(deformed[1]!.x, 0); near(deformed[1]!.y, 10);
    near(deformed[3]!.x, -10); near(deformed[3]!.y, 0);
  });
});
