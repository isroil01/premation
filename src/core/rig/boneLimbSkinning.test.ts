/**
 * BONE SKINNING ON AN UPLOADED PNG CHARACTER — the AE/Duik contract.
 *
 * Bug report: "rotating a bone breaks/distorts the image instead of bending or
 * rotating that limb as a separate part". This file pins the behaviour a rigged
 * character must have:
 *
 *   (a) the hand rotates RIGIDLY about the elbow joint,
 *   (b) the body — which no bone reaches — does not move,
 *   (c) no triangle flips (signed area keeps its sign),
 *   (d) UVs are untouched,
 *   (e) FK rotation, an IK target that produces the same pose, and a baked
 *       keyframe all skin to the identical result.
 *
 * The character: a solid torso block on the left, one THIN horizontal arm
 * reaching right. Two bones lie along the arm (shoulder → elbow → hand); the
 * torso is deliberately unboned, which is the exact situation the report
 * describes — rig one limb, everything else must stay put.
 */

import { buildRestMesh, coverageMaskFromImageData, type PuppetRig } from './puppet';
import { applyIk, getSkeletonBinding, skinRigVertices, type IkTargetResolved } from './rigDeform';
import { computeWorldTransforms, type Bone } from './skeleton';
import { apply } from './mat2d';

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

const W = 128;
const H = 128;

/**
 * Body: x∈[14,58], y∈[24,104] (local x∈[-50,-6], y∈[-40,40]).
 * Arm:  x∈[58,114], y∈[58,70] (local x∈[-6,50], y∈[-6,6]) — 12px thin.
 * Local space is image space minus the half-size (the mesh is origin-centred).
 */
const character = makeBitmap(W, H, (x, y) => {
  const body = x >= 14 && x < 58 && y >= 24 && y < 104;
  const arm = x >= 58 && x < 114 && y >= 58 && y < 70;
  return body || arm ? 255 : 0;
});

const ELBOW = { x: 22, y: 0 };
const restBones: Bone[] = [
  // Shoulder → elbow: local (-6, 0) to (22, 0).
  { id: 'upper', parentId: null, x: -6, y: 0, rotation: 0, length: 28 },
  // Elbow → hand: sits on its parent's tip, extends to (50, 0).
  { id: 'fore', parentId: 'upper', x: 28, y: 0, rotation: 0, length: 28 },
];

const rig: PuppetRig = { pins: [], meshDensity: 26, meshExpansion: 0 };

function buildCharacterMesh() {
  const cov = coverageMaskFromImageData(character);
  return buildRestMesh(W, H, 0, rig, undefined, cov);
}

const ANGLE = Math.PI / 4; // 45°

/** Rigid 45° rotation of a point about the elbow. */
function rigidAboutElbow(x: number, y: number): { x: number; y: number } {
  const c = Math.cos(ANGLE);
  const s = Math.sin(ANGLE);
  const dx = x - ELBOW.x;
  const dy = y - ELBOW.y;
  return { x: ELBOW.x + dx * c - dy * s, y: ELBOW.y + dx * s + dy * c };
}

function poseElbow(deg: number): Map<string, ReturnType<typeof computeWorldTransforms> extends Map<string, infer M> ? M : never> {
  return computeWorldTransforms({
    bones: restBones.map((b) => (b.id === 'fore' ? { ...b, rotation: deg } : { ...b })),
  });
}

describe('Bone skinning on a PNG character — rotating the elbow bends the arm', () => {
  const mesh = buildCharacterMesh();
  const binding = getSkeletonBinding(mesh, restBones);
  const n = mesh.vertices.length / 4;
  const posed = skinRigVertices(binding, poseElbow(ANGLE), mesh.vertices);

  const restXY = (i: number) => ({ x: mesh.vertices[i * 4 + 0]!, y: mesh.vertices[i * 4 + 1]! });
  const posedXY = (i: number) => ({ x: posed[i * 4 + 0]!, y: posed[i * 4 + 1]! });

  /** Vertices well past the elbow AND inside the arm band — the "hand". */
  const handVerts: number[] = [];
  /** Vertices inside the torso block, a safe margin from the shoulder. */
  const bodyVerts: number[] = [];
  for (let i = 0; i < n; i++) {
    const { x, y } = restXY(i);
    if (x > 32 && Math.abs(y) <= 8) handVerts.push(i);
    if (x < -16 && y > -36 && y < 36) bodyVerts.push(i);
  }

  it('the fixture actually has hand and body vertices', () => {
    expect(handVerts.length).toBeGreaterThan(3);
    expect(bodyVerts.length).toBeGreaterThan(10);
  });

  it('(a) hand vertices rotate rigidly 45° about the elbow', () => {
    let worst = 0;
    for (const i of handVerts) {
      const r = restXY(i);
      const want = rigidAboutElbow(r.x, r.y);
      const got = posedXY(i);
      worst = Math.max(worst, Math.hypot(got.x - want.x, got.y - want.y));
    }
    // Sub-pixel on a 128px layer: the limb moves as one rigid piece.
    expect(worst).toBeLessThan(0.5);
  });

  it('(b) body vertices stay put', () => {
    let worst = 0;
    for (const i of bodyVerts) {
      const r = restXY(i);
      const p = posedXY(i);
      worst = Math.max(worst, Math.hypot(p.x - r.x, p.y - r.y));
    }
    expect(worst).toBeLessThan(0.5);
  });

  it('(c) no triangle flips — every signed area keeps its sign', () => {
    const tris = mesh.triangles;
    let flipped = 0;
    let checked = 0;
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t]!;
      const b = tris[t + 1]!;
      const c = tris[t + 2]!;
      const area = (p: (i: number) => { x: number; y: number }): number => {
        const A = p(a), B = p(b), C = p(c);
        return (B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y);
      };
      const rest = area(restXY);
      if (Math.abs(rest) < 1e-9) continue;
      checked++;
      if (Math.sign(area(posedXY)) !== Math.sign(rest)) flipped++;
    }
    expect(checked).toBeGreaterThan(50);
    expect(flipped).toBe(0);
  });

  it('(d) UVs are unchanged', () => {
    for (let i = 0; i < n; i++) {
      expect(posed[i * 4 + 2]).toBe(mesh.vertices[i * 4 + 2]);
      expect(posed[i * 4 + 3]).toBe(mesh.vertices[i * 4 + 3]);
    }
  });

  it('(e) FK, IK and a baked keyframe agree', () => {
    // Baked keyframe = the animation engine handing back the same rotation.
    const baked = skinRigVertices(
      binding,
      computeWorldTransforms({
        bones: restBones.map((b) => (b.id === 'fore' ? { ...b, rotation: ANGLE } : { ...b })),
      }),
      mesh.vertices,
    );
    for (let i = 0; i < posed.length; i++) expect(baked[i]).toBe(posed[i]);

    // IK: aim a single-bone chain on `fore` at where FK put the hand tip.
    const fkWorld = poseElbow(ANGLE);
    const tip = apply(fkWorld.get('fore')!, 28, 0);
    const targets: IkTargetResolved[] = [
      { boneId: 'fore', x: tip.x, y: tip.y, chainLength: 1 },
    ];
    const ikBones = applyIk(restBones, targets);
    const ikPosed = skinRigVertices(binding, computeWorldTransforms({ bones: ikBones }), mesh.vertices);
    let worst = 0;
    for (let i = 0; i < n; i++) {
      worst = Math.max(
        worst,
        Math.hypot(ikPosed[i * 4 + 0]! - posed[i * 4 + 0]!, ikPosed[i * 4 + 1]! - posed[i * 4 + 1]!),
      );
    }
    expect(worst).toBeLessThan(1e-3);
  });

  it('the seam at the elbow is a real blend, not a hard cut', () => {
    // Somewhere along the arm the two bones must genuinely share a vertex, or
    // the "bend" is a crease between two rigid halves.
    const shared = binding.weights.filter((w) => {
      const fore = w.find((q) => q.boneId === 'fore')?.weight ?? 0;
      const upper = w.find((q) => q.boneId === 'upper')?.weight ?? 0;
      return fore > 0.15 && upper > 0.15;
    });
    expect(shared.length).toBeGreaterThan(2);
  });

  it('neighbouring vertices deform by similar amounts — no tearing', () => {
    // Every mesh edge must survive the pose without exploding: an edge that
    // grows or collapses wildly is the visible "shredded artwork".
    const tris = mesh.triangles;
    let worstRatio = 1;
    for (let t = 0; t < tris.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = tris[t + k]!;
        const b = tris[t + ((k + 1) % 3)]!;
        const r = Math.hypot(
          mesh.vertices[a * 4]! - mesh.vertices[b * 4]!,
          mesh.vertices[a * 4 + 1]! - mesh.vertices[b * 4 + 1]!,
        );
        if (r < 1e-6) continue;
        const p = Math.hypot(posed[a * 4]! - posed[b * 4]!, posed[a * 4 + 1]! - posed[b * 4 + 1]!);
        worstRatio = Math.max(worstRatio, p / r, r / p);
      }
    }
    // A 45° bend legitimately compresses the inside of the joint; 2x is the
    // budget for that, and far below what a torn mesh produces.
    expect(worstRatio).toBeLessThan(2);
  });
});

describe('per-bone influence radius', () => {
  const mesh = buildCharacterMesh();
  const n = mesh.vertices.length / 4;

  /** Rotate the SHOULDER bone — which, unbounded, owns the whole torso. */
  const shoulderPose = (bones: Bone[]) =>
    computeWorldTransforms({
      bones: bones.map((b) => (b.id === 'upper' ? { ...b, rotation: ANGLE } : { ...b })),
    });

  const torsoMove = (bones: Bone[]): number => {
    const binding = getSkeletonBinding(mesh, bones);
    const posed = skinRigVertices(binding, shoulderPose(bones), mesh.vertices);
    let worst = 0;
    for (let i = 0; i < n; i++) {
      const x = mesh.vertices[i * 4]!;
      if (x > -20) continue; // deep torso only
      worst = Math.max(
        worst,
        Math.hypot(posed[i * 4]! - x, posed[i * 4 + 1]! - mesh.vertices[i * 4 + 1]!),
      );
    }
    return worst;
  };

  it('unbounded, the shoulder bone carries the torso with it', () => {
    // Not a bug — a partition always hands every vertex to SOME bone, and with
    // only arm bones the shoulder is the nearest thing the torso has.
    expect(torsoMove(restBones)).toBeGreaterThan(10);
  });

  it('a radius stops it, and the artwork beyond fades to rest instead of tearing', () => {
    const bounded = restBones.map((b) => ({ ...b, influenceRadius: 14 }));
    expect(torsoMove(bounded)).toBeLessThan(1);

    // The fade must be gradual: no mesh edge may blow up at the boundary.
    const binding = getSkeletonBinding(mesh, bounded);
    const posed = skinRigVertices(binding, shoulderPose(bounded), mesh.vertices);
    const tris = mesh.triangles;
    let worstRatio = 1;
    for (let t = 0; t < tris.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = tris[t + k]!;
        const b = tris[t + ((k + 1) % 3)]!;
        const r = Math.hypot(
          mesh.vertices[a * 4]! - mesh.vertices[b * 4]!,
          mesh.vertices[a * 4 + 1]! - mesh.vertices[b * 4 + 1]!,
        );
        if (r < 1e-6) continue;
        const p = Math.hypot(posed[a * 4]! - posed[b * 4]!, posed[a * 4 + 1]! - posed[b * 4 + 1]!);
        worstRatio = Math.max(worstRatio, p / r, r / p);
      }
    }
    expect(worstRatio).toBeLessThan(2.5);
  });
});

/**
 * The MESH the bones are skinned to.
 *
 * Weights can only be as good as the triangles they sit on. On the bbox grid a
 * thin arm may be a single cell wide, so its vertices are shared with the empty
 * rectangle around it and no weighting scheme can separate them. `alphaMesh.ts`
 * (the puppet half's outline mesher) traces the alpha instead — and the skeleton
 * had no way to ASK for it: `meshMode` was never forwarded from `SkeletonRig`,
 * so a bone-rigged PNG was pinned to the grid.
 */
describe('a bone rig can reach the alpha-outline mesh', () => {
  // A deliberately THIN arm: 7px on a 160px layer, well under one grid cell.
  const S = 160;
  const bmp = (() => {
    const data = new Uint8ClampedArray(S * S * 4);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        const body = x >= 20 && x < 70 && y >= 30 && y < 130;
        const arm = x >= 70 && x < 140 && y >= 77 && y < 84;
        data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
        data[i + 3] = body || arm ? 255 : 0;
      }
    }
    return { data, width: S, height: S };
  })();
  const cov = coverageMaskFromImageData(bmp);

  const thinBones: Bone[] = [
    { id: 'upper', parentId: null, x: -10, y: 0, rotation: 0, length: 30 },
    { id: 'fore', parentId: 'upper', x: 30, y: 0, rotation: 0, length: 30 },
  ];

  /** Worst movement of the TORSO when the elbow rotates 45°. */
  const torsoSmear = (meshMode: 'grid' | 'silhouette'): number => {
    const mesh = buildRestMesh(S, S, 0, { pins: [], meshDensity: 26, meshExpansion: 0, meshMode }, undefined, cov);
    const binding = getSkeletonBinding(mesh, thinBones);
    const posed = skinRigVertices(
      binding,
      computeWorldTransforms({
        bones: thinBones.map((b) => (b.id === 'fore' ? { ...b, rotation: ANGLE } : { ...b })),
      }),
      mesh.vertices,
    );
    let worst = 0;
    for (let i = 0; i < mesh.vertices.length / 4; i++) {
      const x = mesh.vertices[i * 4]!;
      const y = mesh.vertices[i * 4 + 1]!;
      if (x > -20 || y < -50 || y > 50) continue; // torso interior
      worst = Math.max(worst, Math.hypot(posed[i * 4]! - x, posed[i * 4 + 1]! - y));
    }
    return worst;
  };

  it('the outline mesh keeps the torso still when the elbow bends', () => {
    // Both must hold — this is the property, not a comparison — but the outline
    // mesh is the one that can represent a 7px limb at all.
    expect(torsoSmear('silhouette')).toBeLessThan(1);
  });

  it('the outline mesh is actually a different, finer mesh than the grid', () => {
    const grid = buildRestMesh(S, S, 0, { pins: [], meshDensity: 26, meshExpansion: 0, meshMode: 'grid' }, undefined, cov);
    const outline = buildRestMesh(S, S, 0, { pins: [], meshDensity: 26, meshExpansion: 0, meshMode: 'silhouette' }, undefined, cov);
    expect(outline.vertices.length).not.toBe(grid.vertices.length);
  });
});
