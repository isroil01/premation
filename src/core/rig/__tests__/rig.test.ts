/**
 * Rig math — FK composition, linear blend skinning, and IK reach. These pin the
 * geometric contracts the renderer + rigging UI will depend on.
 */

import { fromTRS, apply, IDENTITY } from '../mat2d';
import {
  computeWorldTransforms,
  computeBindInverses,
  boneTip,
  boneRoot,
  type Skeleton,
} from '../skeleton';
import { skinVertex, normalizeWeights, type SkinVertex } from '../skinning';
import { solveTwoBone, solveFabrik, anglesFromJoints, type Vec2 } from '../ik';

const near = (a: number, b: number, digits = 4) => expect(a).toBeCloseTo(b, digits);

describe('forward kinematics', () => {
  it('composes parent rotation into child world position', () => {
    // Parent at origin rotated 90°; child pinned at the parent tip, length 10.
    const skel: Skeleton = {
      bones: [
        { id: 'root', parentId: null, length: 10, x: 0, y: 0, rotation: Math.PI / 2 },
        { id: 'child', parentId: 'root', length: 10, x: 10, y: 0, rotation: 0 },
      ],
    };
    const world = computeWorldTransforms(skel);
    const childRoot = boneRoot(world.get('child')!);
    const childTip = boneTip(world.get('child')!, 10);
    near(childRoot.x, 0); near(childRoot.y, 10); // parent tip is straight up
    near(childTip.x, 0); near(childTip.y, 20);   // child extends further up
  });

  it('resolves bones given out of parent-first order and guards cycles', () => {
    const skel: Skeleton = {
      bones: [
        { id: 'b', parentId: 'a', length: 5, x: 5, y: 0, rotation: 0 },
        { id: 'a', parentId: null, length: 5, x: 1, y: 2, rotation: 0 },
        { id: 'loop', parentId: 'loop', length: 1, x: 0, y: 0, rotation: 0 },
      ],
    };
    const world = computeWorldTransforms(skel);
    expect(boneRoot(world.get('b')!)).toEqual({ x: 6, y: 2 });
    expect(world.get('loop')).toEqual(IDENTITY); // cycle → identity, no hang
  });
});

describe('linear blend skinning', () => {
  it('a rigidly-bound vertex follows its bone exactly (rotation)', () => {
    const bind = computeWorldTransforms({ bones: [{ id: 'b', parentId: null, length: 10, x: 0, y: 0, rotation: 0 }] });
    const bindInv = computeBindInverses(bind);
    const pose = computeWorldTransforms({ bones: [{ id: 'b', parentId: null, length: 10, x: 0, y: 0, rotation: Math.PI / 2 }] });
    const v: SkinVertex = { x: 10, y: 0, weights: [{ boneId: 'b', weight: 1 }] };
    const out = skinVertex(v, pose, bindInv);
    near(out.x, 0); near(out.y, 10); // (10,0) rotated 90° about the bone root
  });

  it('a 50/50 vertex blends the two bones’ transforms', () => {
    const bind = computeWorldTransforms({
      bones: [
        { id: 'a', parentId: null, length: 1, x: 0, y: 0, rotation: 0 },
        { id: 'b', parentId: null, length: 1, x: 0, y: 0, rotation: 0 },
      ],
    });
    const bindInv = computeBindInverses(bind);
    // Bone a stays; bone b translates +10 in x. A vertex weighted equally moves half.
    const pose = computeWorldTransforms({
      bones: [
        { id: 'a', parentId: null, length: 1, x: 0, y: 0, rotation: 0 },
        { id: 'b', parentId: null, length: 1, x: 10, y: 0, rotation: 0 },
      ],
    });
    const v: SkinVertex = { x: 4, y: 3, weights: [{ boneId: 'a', weight: 0.5 }, { boneId: 'b', weight: 0.5 }] };
    const out = skinVertex(v, pose, bindInv);
    near(out.x, 9); near(out.y, 3); // 4 + 0.5*10
  });

  it('unnormalized weights are averaged; empty falls back to bind', () => {
    const bind = computeWorldTransforms({ bones: [{ id: 'a', parentId: null, length: 1, x: 0, y: 0, rotation: 0 }] });
    const inv = computeBindInverses(bind);
    const pose = computeWorldTransforms({ bones: [{ id: 'a', parentId: null, length: 1, x: 5, y: 0, rotation: 0 }] });
    const v: SkinVertex = { x: 0, y: 0, weights: [{ boneId: 'a', weight: 2 }] }; // weight 2 → still normalized to 1
    near(skinVertex(v, pose, inv).x, 5);
    expect(skinVertex({ x: 7, y: 8, weights: [] }, pose, inv)).toEqual({ x: 7, y: 8 });
  });

  it('normalizeWeights caps influences and sums to 1', () => {
    const w = normalizeWeights([
      { boneId: 'a', weight: 0.6 }, { boneId: 'b', weight: 0.3 },
      { boneId: 'c', weight: 0.1 }, { boneId: 'd', weight: 0.00001 },
    ], 2);
    expect(w).toHaveLength(2); // dropped tiny + capped at 2
    near(w.reduce((s, x) => s + x.weight, 0), 1);
    expect(w[0]!.boneId).toBe('a');
  });
});

describe('inverse kinematics', () => {
  const reconstructTwoBone = (root: Vec2, l1: number, l2: number, s: { angle1: number; angle2: number }) => {
    const j1 = { x: root.x + l1 * Math.cos(s.angle1), y: root.y + l1 * Math.sin(s.angle1) };
    return { x: j1.x + l2 * Math.cos(s.angle2), y: j1.y + l2 * Math.sin(s.angle2) };
  };

  it('two-bone solver reaches a reachable target', () => {
    const root = { x: 0, y: 0 };
    const target = { x: 10, y: 8 };
    const sol = solveTwoBone(root, 10, 10, target, true);
    const end = reconstructTwoBone(root, 10, 10, sol);
    near(end.x, target.x, 3); near(end.y, target.y, 3);
    expect(sol.clamped).toBe(false);
  });

  it('two-bone solver flags and extends toward an unreachable target', () => {
    const sol = solveTwoBone({ x: 0, y: 0 }, 10, 10, { x: 100, y: 0 }, true);
    expect(sol.clamped).toBe(true);
    near(sol.angle1, 0, 3); near(sol.angle2, 0, 3); // straight line toward target
  });

  it('FABRIK reaches the target and keeps the root pinned + link lengths', () => {
    const joints: Vec2[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }];
    const lengths = [10, 10, 10];
    const target = { x: 12, y: 14 };
    const solved = solveFabrik(joints, lengths, target, 20, 0.01);
    expect(solved[0]).toEqual({ x: 0, y: 0 }); // root pinned
    const end = solved[3]!;
    near(end.x, target.x, 1); near(end.y, target.y, 1);
    for (let i = 0; i < lengths.length; i++) {
      const a = solved[i]!, b = solved[i + 1]!;
      near(Math.hypot(b.x - a.x, b.y - a.y), lengths[i]!, 2);
    }
  });

  it('anglesFromJoints derives link angles', () => {
    const angles = anglesFromJoints([{ x: 0, y: 0 }, { x: 0, y: 5 }]);
    near(angles[0]!, Math.PI / 2);
  });
});

describe('mat2d sanity', () => {
  it('fromTRS then apply rotates a unit x vector', () => {
    const p = apply(fromTRS(0, 0, Math.PI / 2), 1, 0);
    near(p.x, 0); near(p.y, 1);
  });
});
