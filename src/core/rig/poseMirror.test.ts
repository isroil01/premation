/**
 * Which bones are opposites, and the reflection, without an engine. The native
 * suite (`rigPoseActions.native.test.tsx`) covers where the writes land.
 */

import { mirrorPairs, mirrorPose, poseScope, type BonePoseValue, type GoalPoseValue } from './poseMirror';
import { bipedPreset, quadrupedPreset } from './rigPresets';
import { captureBindPose, type SkeletonRig } from './skeletonCommands';

const BOUNDS = { width: 260, height: 420 };

const liveOf = (rig: SkeletonRig, over: Record<string, Partial<BonePoseValue>> = {}, goals: Record<string, GoalPoseValue> = {}) => ({
  bones: new Map(rig.bones.map((b) => [b.id, { x: b.x, y: b.y, rotation: b.rotation, scaleX: 1, scaleY: 1, ...over[b.id] }])),
  goals: new Map(Object.entries(goals)),
});

describe('mirrorPairs', () => {
  it('pairs the biped limb by limb and leaves the spine out', () => {
    const pairs = mirrorPairs(bipedPreset(BOUNDS));
    expect(pairs.get('arm_l_upper')).toBe('arm_r_upper');
    expect(pairs.get('arm_r_lower')).toBe('arm_l_lower');
    expect(pairs.get('leg_l_upper')).toBe('leg_r_upper');
    expect(pairs.get('leg_l_lower')).toBe('leg_r_lower');
    for (const id of ['hips', 'chest', 'head']) expect(pairs.has(id)).toBe(false);
  });

  it('pairs the quadruped by its sides: fore with hind, near with near; head and tail stay', () => {
    const pairs = mirrorPairs(quadrupedPreset(BOUNDS));
    expect(pairs.get('leg_fore_near_upper')).toBe('leg_hind_near_upper');
    expect(pairs.get('leg_fore_far_upper')).toBe('leg_hind_far_upper');
    expect(pairs.get('leg_fore_near_lower')).toBe('leg_hind_near_lower');
    expect(pairs.has('head')).toBe(false);
    expect(pairs.has('tail')).toBe(false);
  });

  it('a rig with no controllers has no sides, so no pairs', () => {
    const rig = bipedPreset(BOUNDS);
    expect(mirrorPairs({ ...rig, controllers: [] }).size).toBe(0);
  });

  it('a chain long enough to reach the spine does not make the spine a side', () => {
    const rig = bipedPreset(BOUNDS);
    const long = { ...rig, ikTargets: rig.ikTargets!.map((g) => ({ ...g, chainLength: 3 })) };
    const pairs = mirrorPairs(long);
    expect(pairs.has('chest')).toBe(false);
    expect(pairs.has('hips')).toBe(false);
    expect(pairs.get('arm_l_upper')).toBe('arm_r_upper');
  });

  it('an added hand inherits its arm: children of a pair pair too', () => {
    const rig = bipedPreset(BOUNDS);
    const bones = [
      ...rig.bones,
      { id: 'hand_a', parentId: 'arm_l_lower', length: 10, x: 40, y: 0, rotation: 0 },
      { id: 'hand_b', parentId: 'arm_r_lower', length: 10, x: 40, y: 0, rotation: 0 },
    ];
    expect(mirrorPairs({ ...rig, bones }).get('hand_a')).toBe('hand_b');
  });

  it('an unmatched extra bone cannot take another bone its opposite', () => {
    const rig: SkeletonRig = {
      bones: [
        { id: 'root', parentId: null, length: 10, x: 0, y: 0, rotation: 0 },
        { id: 'stray', parentId: 'root', length: 10, x: -10, y: 0, rotation: 0 },
        { id: 'arm_a', parentId: 'root', length: 10, x: -50, y: 0, rotation: 0 },
        { id: 'arm_b', parentId: 'root', length: 10, x: 50, y: 0, rotation: 0 },
      ],
      controllers: [
        { id: 'c1', shape: 'circle', side: 'left', size: 10, link: { kind: 'bone', boneId: 'stray' } },
        { id: 'c2', shape: 'circle', side: 'left', size: 10, link: { kind: 'bone', boneId: 'arm_a' } },
        { id: 'c3', shape: 'circle', side: 'right', size: 10, link: { kind: 'bone', boneId: 'arm_b' } },
      ],
    };
    const pairs = mirrorPairs(rig);
    expect(pairs.get('arm_a')).toBe('arm_b');
    expect(pairs.has('stray')).toBe(false);
  });
});

describe('mirrorPose', () => {
  const rig = bipedPreset(BOUNDS);
  const armL = rig.bones.find((b) => b.id === 'arm_l_upper')!;
  const armR = rig.bones.find((b) => b.id === 'arm_r_upper')!;
  const everything = new Set(rig.bones.map((b) => b.id));

  it('at rest it changes nothing: the mirror of a symmetric pose is itself', () => {
    const out = mirrorPose(rig, liveOf(rig), everything);
    expect(out.bones.get('arm_l_upper')!.rotation).toBeCloseTo(armL.rotation, 9);
    expect(out.bones.get('arm_r_upper')!.rotation).toBeCloseTo(armR.rotation, 9);
  });

  it('reflects rotation about the rest pose, not by copying the value across', () => {
    const live = liveOf(rig, { arm_l_upper: { rotation: 2.9 }, arm_r_upper: { rotation: 0.1 } });
    const out = mirrorPose(rig, live, everything);
    expect(out.bones.get('arm_l_upper')!.rotation).toBeCloseTo(armL.rotation - (0.1 - armR.rotation), 9);
    expect(out.bones.get('arm_r_upper')!.rotation).toBeCloseTo(armR.rotation - (2.9 - armL.rotation), 9);
  });

  it('POSITIVE CONTROL: a plain value swap is not the mirror, so the check above is not free', () => {
    const live = liveOf(rig, { arm_l_upper: { rotation: 2.9 }, arm_r_upper: { rotation: 0.1 } });
    const out = mirrorPose(rig, live, everything);
    expect(out.bones.get('arm_l_upper')!.rotation).not.toBeCloseTo(0.1, 3);
    expect(out.bones.get('arm_l_upper')!.rotation).not.toBeCloseTo(2.9, 3);
  });

  it('measures from the bind pose, not from bones a static pose has already moved', () => {
    const posed: SkeletonRig = { ...captureBindPose(rig), bones: rig.bones.map((b) => (b.id === 'arm_l_upper' ? { ...b, rotation: 3 } : b)) };
    const live = liveOf(posed, { arm_l_upper: { rotation: 3 } });
    const out = mirrorPose(posed, live, everything);
    expect(out.bones.get('arm_r_upper')!.rotation).toBeCloseTo(armR.rotation - (3 - armL.rotation), 9);
  });

  it('flips x under a shared parent and y under mirrored parents', () => {
    const root = mirrorPose(rig, liveOf(rig, { arm_r_upper: { x: armR.x + 7, y: armR.y + 3 } }), everything);
    expect(root.bones.get('arm_l_upper')).toMatchObject({ x: armL.x - 7, y: armL.y + 3 });

    const lowerR = rig.bones.find((b) => b.id === 'arm_r_lower')!;
    const lowerL = rig.bones.find((b) => b.id === 'arm_l_lower')!;
    const child = mirrorPose(rig, liveOf(rig, { arm_r_lower: { x: lowerR.x + 7, y: lowerR.y + 3 } }), everything);
    expect(child.bones.get('arm_l_lower')).toMatchObject({ x: lowerL.x + 7, y: lowerL.y - 3 });
  });

  it('reflects goals and poles into the other limb, and swaps the chain mode', () => {
    const out = mirrorPose(rig, liveOf(rig, {}, {
      arm_l_lower: { x: -130, y: 40, pole: { x: -10, y: 5 }, mode: 'ik' },
      arm_r_lower: { x: 90, y: -10, pole: { x: 20, y: 8 }, mode: 'fk' },
    }), everything);
    expect(out.goals.get('arm_l_lower')).toEqual({ x: -90, y: -10, pole: { x: -20, y: 8 }, mode: 'fk' });
    expect(out.goals.get('arm_r_lower')).toEqual({ x: 130, y: 40, pole: { x: 10, y: 5 }, mode: 'ik' });
  });

  it('reflects goals about an off-centre rig, not about the layer origin', () => {
    const shifted: SkeletonRig = { ...rig, bones: rig.bones.map((b) => (b.parentId ? b : { ...b, x: 30 })) };
    const out = mirrorPose(shifted, liveOf(shifted, {}, {
      arm_l_lower: { x: 0, y: 0, mode: 'ik' },
      arm_r_lower: { x: 100, y: 0, mode: 'ik' },
    }), everything);
    expect(out.goals.get('arm_l_lower')).toMatchObject({ x: -40 });
    expect(out.goals.get('arm_r_lower')).toMatchObject({ x: 60 });
  });

  it('one bone in scope swaps its whole pair, and nothing else', () => {
    const out = mirrorPose(rig, liveOf(rig), new Set(['arm_l_upper']));
    expect([...out.bones.keys()].sort()).toEqual(['arm_l_upper', 'arm_r_upper']);
  });

  it('a goal on one side only is left alone', () => {
    const out = mirrorPose(rig, liveOf(rig, {}, { arm_l_lower: { x: 1, y: 2, mode: 'ik' } }), everything);
    expect(out.goals.size).toBe(0);
  });
});

describe('poseScope', () => {
  const rig = bipedPreset(BOUNDS);

  it('nothing selected means the whole skeleton', () => {
    expect(poseScope(rig, []).size).toBe(rig.bones.length);
  });

  it('a bone in an IK chain brings the chain, because the goal poses it', () => {
    expect([...poseScope(rig, ['arm_l_upper'])].sort()).toEqual(['arm_l_lower', 'arm_l_upper']);
  });

  it('a stale selection falls back to everything rather than to nothing', () => {
    expect(poseScope(rig, ['deleted']).size).toBe(rig.bones.length);
  });
});
