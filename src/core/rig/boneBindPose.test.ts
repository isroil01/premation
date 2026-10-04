/**
 * The rig's BIND pose is stored separately from the pose it is displayed in.
 *
 * `SkeletonRig.bones` carries two jobs: the rig's structure, and the pose a
 * bone holds when no keyframe drives it. A pose drag with auto-keyframe off
 * (the DEFAULT) writes the dragged rotation straight into `bones` — and if the
 * skin is also BOUND to `bones`, every `pose · bindInverse` is the identity and
 * the artwork does not move at all while the bone visibly swings.
 *
 * `bindPoseBones` / `captureBindPose` are the split. These tests pin both the
 * new behaviour and the back-compatibility rule that a rig with no `bindPose`
 * binds exactly as it always did.
 */

import { bindPoseBones, captureBindPose, type SkeletonRig } from './skeletonCommands';
import {  type Bone } from './skeleton';

const restBones: Bone[] = [
  { id: 'upper', parentId: null, x: -6, y: 0, rotation: 0, length: 28 },
  { id: 'fore', parentId: 'upper', x: 28, y: 0, rotation: 0, length: 28 },
];

describe('bindPoseBones', () => {
  it('a rig with no bindPose binds to its bones — old documents are untouched', () => {
    const skel: SkeletonRig = { bones: restBones };
    expect(bindPoseBones(skel)).toBe(skel.bones);
  });

  it('takes the POSE from the bind and the STRUCTURE from the live bone', () => {
    const skel: SkeletonRig = {
      bones: [
        // Posed (rotation moved) and re-shaped (length + radius edited in rig mode).
        { id: 'upper', parentId: null, x: -6, y: 0, rotation: 1.2, length: 40, influenceRadius: 9 },
        // Added after the bind was captured — no bind entry.
        { id: 'hand', parentId: 'fore', x: 28, y: 0, rotation: 0.3, length: 10 },
      ],
      bindPose: [
        { id: 'upper', parentId: null, x: -6, y: 0, rotation: 0, length: 28 },
        // Left behind by a deleted bone — must simply never be looked up.
        { id: 'ghost', parentId: null, x: 99, y: 99, rotation: 9, length: 9 },
      ],
    };
    const bound = bindPoseBones(skel);
    expect(bound).toHaveLength(2);
    expect(bound[0]).toMatchObject({ id: 'upper', rotation: 0, length: 40, influenceRadius: 9 });
    // No bind entry → binds where it was drawn.
    expect(bound[1]).toMatchObject({ id: 'hand', rotation: 0.3, length: 10 });
  });

  it('captureBindPose snapshots once and never again', () => {
    const skel: SkeletonRig = { bones: restBones };
    const first = captureBindPose(skel);
    expect(first.bindPose).toHaveLength(2);
    expect(first.bindPose![0]!.rotation).toBe(0);

    // A pose lands in `bones`; a second capture must NOT overwrite the bind.
    const posed: SkeletonRig = {
      ...first,
      bones: first.bones.map((b) => (b.id === 'fore' ? { ...b, rotation: 0.8 } : b)),
    };
    expect(captureBindPose(posed).bindPose![1]!.rotation).toBe(0);
  });
});
