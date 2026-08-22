/**
 * Geodesic bone auto-weights — influence travels THROUGH the artwork, never
 * across a transparent gap, and an island no bone touches stays at rest.
 */

import { buildRestMesh, coverageMaskFromImageData, type PuppetRig } from './puppet';
import { getSkeletonBinding, skinRigVertices } from './rigDeform';
import { computeWorldTransforms, type Bone } from './skeleton';

/** Synthetic RGBA bitmap; `alphaAt(x, y)` returns 0-255 per pixel. */
function makeBitmap(
  width: number,
  height: number,
  alphaAt: (x: number, y: number) => number,
): { data: Uint8ClampedArray; width: number; height: number } {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = alphaAt(x, y);
    }
  }
  return { data, width, height };
}

const noPinRig: PuppetRig = { pins: [], meshDensity: 20, meshExpansion: 0 };

describe('Geodesic bone auto-weights', () => {
  it('influence walks around a silhouette gap instead of jumping it', () => {
    // U-shape: two vertical prongs joined only at the bottom. In image space
    // (100×100): left prong x∈[10,30], right prong x∈[70,90], both y∈[10,90];
    // bridge y∈[70,90] across x∈[10,90].
    const bmp = makeBitmap(100, 100, (x, y) => {
      const leftProng = x >= 10 && x < 30 && y >= 10 && y < 90;
      const rightProng = x >= 70 && x < 90 && y >= 10 && y < 90;
      const bridge = y >= 70 && y < 90 && x >= 10 && x < 90;
      return leftProng || rightProng || bridge ? 255 : 0;
    });
    const cov = coverageMaskFromImageData(bmp);
    const mesh = buildRestMesh(100, 100, 0, noPinRig, undefined, cov);

    // Bone L: vertical, in the LEFT prong's top (local coords = image − 50).
    // Bone B: horizontal, in the bridge. Both roots, no hierarchy.
    const bones: Bone[] = [
      { id: 'L', parentId: null, x: -30, y: -35, rotation: Math.PI / 2, length: 20 },
      { id: 'B', parentId: null, x: -10, y: 30, rotation: 0, length: 20 },
    ];
    const binding = getSkeletonBinding(mesh, bones);

    const weightOf = (vi: number, boneId: string): number =>
      binding.weights[vi]!.find((w) => w.boneId === boneId)?.weight ?? 0;

    const n = mesh.vertices.length / 4;
    let leftTop = -1;
    let rightTop = -1;
    let dL = Infinity;
    let dR = Infinity;
    for (let i = 0; i < n; i++) {
      const x = mesh.vertices[i * 4 + 0]!;
      const y = mesh.vertices[i * 4 + 1]!;
      const l = Math.hypot(x - -30, y - -35);
      const r = Math.hypot(x - 30, y - -35);
      if (l < dL) { dL = l; leftTop = i; }
      if (r < dR) { dR = r; rightTop = i; }
    }

    // On the bone: essentially fully owned by it.
    expect(weightOf(leftTop, 'L')).toBeGreaterThan(0.8);
    // Across the gap: Euclidean-close (~60px) but geodesically far (~190px
    // around the U) — the bridge bone must dominate, not the left-prong bone.
    // Euclidean inverse-square weighting gave L ≈ 0.58 here.
    expect(weightOf(rightTop, 'L')).toBeLessThan(0.2);
    expect(weightOf(rightTop, 'B')).toBeGreaterThan(0.8);
  });

  it('an island no bone touches keeps its bind pose when the skeleton moves', () => {
    const bmp = makeBitmap(100, 100, (x, y) => {
      if (Math.hypot(x - 25, y - 50) <= 15) return 255; // left blob (boned)
      if (Math.hypot(x - 78, y - 50) <= 10) return 255; // right blob (no bone)
      return 0;
    });
    const cov = coverageMaskFromImageData(bmp);
    const mesh = buildRestMesh(100, 100, 0, noPinRig, undefined, cov);

    const restBones: Bone[] = [
      { id: 'arm', parentId: null, x: -35, y: 0, rotation: 0, length: 20 },
    ];
    const binding = getSkeletonBinding(mesh, restBones);

    // Pose: rotate the bone 60°.
    const posed = computeWorldTransforms({
      bones: [{ ...restBones[0]!, rotation: Math.PI / 3 }],
    });
    const skinned = skinRigVertices(binding, posed, mesh.vertices);

    const n = mesh.vertices.length / 4;
    let leftMoved = 0;
    let islandVerts = 0;
    for (let i = 0; i < n; i++) {
      const rx = mesh.vertices[i * 4 + 0]!;
      const ry = mesh.vertices[i * 4 + 1]!;
      const dx = skinned[i * 4 + 0]! - rx;
      const dy = skinned[i * 4 + 1]! - ry;
      if (rx >= 15) {
        islandVerts++;
        expect(Math.abs(dx)).toBeLessThan(1e-4);
        expect(Math.abs(dy)).toBeLessThan(1e-4);
      } else if (Math.hypot(dx, dy) > 1) {
        leftMoved++;
      }
    }
    expect(islandVerts).toBeGreaterThan(0);
    expect(leftMoved).toBeGreaterThan(0);
  });
});
