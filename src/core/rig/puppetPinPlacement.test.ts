/**
 * Puppet pin PLACEMENT space (regression for doc §12.4).
 *
 * Pin positions are stored in REST space — the puppet solve runs in rest space
 * and the skeleton skinning poses the result on top (see rigDeform.ts). The
 * overlay's drag path mapped pointer input back through `unskinPoint` before
 * writing, but the click-to-ADD path did not: it stored the raw posed-space
 * coordinate as if it were a rest coordinate. On a layer carrying both a posed
 * skeleton and puppet pins, a new pin therefore landed somewhere other than
 * where you clicked.
 *
 * These tests model the click-add gesture at the transform level: a click lands
 * on a POSED point; whatever we store must be the rest point that skins back
 * onto it.
 */

import { buildRestMesh, type PuppetRig } from './puppet';
import type { Bone } from './skeleton';
import { computeWorldTransforms } from './skeleton';
import { getSkeletonBinding, skinPointAt, unskinPoint } from './rigDeform';

const W = 200;
const H = 60;

const RIG: PuppetRig = { pins: [], meshDensity: 14, meshExpansion: 0 };

/** A two-bone arm laid along the layer's long axis. */
function restBones(): Bone[] {
  return [
    { id: 'upper', parentId: null, length: 60, x: -80, y: 0, rotation: 0 },
    { id: 'fore', parentId: 'upper', length: 60, x: 60, y: 0, rotation: 0 },
  ];
}

/** The same skeleton, visibly posed (the forearm swung down). */
function posedBones(): Bone[] {
  const bones = restBones();
  bones[1]!.rotation = Math.PI / 3; // 60°
  return bones;
}

function harness() {
  const restMesh = buildRestMesh(W, H, 0, RIG);
  const binding = getSkeletonBinding(restMesh, restBones());
  const poseWorld = computeWorldTransforms({ bones: posedBones() });
  return { restMesh, binding, poseWorld };
}

describe('§12.4 — click-add stores rest space, not posed space', () => {
  it('a posed skeleton genuinely moves points (the bug had teeth)', () => {
    const { binding, poseWorld } = harness();
    // A point out on the forearm, where the 60° swing bites hardest.
    const rest = { x: 90, y: 0 };
    const posed = skinPointAt(rest, rest, binding, poseWorld);
    const drift = Math.hypot(posed.x - rest.x, posed.y - rest.y);
    // If this were ~0 the placement bug would be invisible and untestable.
    expect(drift).toBeGreaterThan(5);
  });

  /**
   * `unskinPoint` is a fixed-iteration fixed point, not a closed-form inverse —
   * the blended skinning matrix depends on the rest position being solved for.
   * The fixed count keeps it deterministic.
   *
   * Writing this test is what exposed UNSKIN_ITERATIONS = 3 as too low: the
   * worst case below came back 6.4px off (~11% of its displacement), which is
   * precisely the rest coordinate click-add now stores. Raised to 12; see the
   * measured convergence table on the constant in rigDeform.ts.
   *
   * The hard cases are points where BOTH weight columns still contribute and
   * the displacement is large. Where one bone saturates the blend, the map is a
   * single rigid transform and the inverse is exact in one step.
   */
  it('unskinPoint recovers the rest point to sub-pixel accuracy', () => {
    const { binding, poseWorld } = harness();
    const residualAt = (rest: { x: number; y: number }): number => {
      const posed = skinPointAt(rest, rest, binding, poseWorld);
      const recovered = unskinPoint(posed, binding, poseWorld);
      return Math.hypot(recovered.x - rest.x, recovered.y - rest.y);
    };

    for (const rest of [
      { x: 90, y: 0 },   // saturated on `fore` — exact
      { x: 40, y: 10 },  // blended + large displacement — the 6.4px case at 3 iters
      { x: -50, y: -8 },
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: -70, y: 20 },
      { x: 60, y: -20 },
    ]) {
      expect(residualAt(rest)).toBeLessThan(0.05);
    }
  });

  it("a pin added at the fixed coordinate draws back under the pointer", () => {
    const { binding, poseWorld } = harness();
    // The user clicks here, in posed space (what they see on canvas).
    const clicked = { x: 96, y: 22 };

    // FIXED behaviour: store toRestSpace(clicked); the overlay then draws the
    // dot through skinPointAt, which must land back on the click.
    const stored = unskinPoint(clicked, binding, poseWorld);
    const drawn = skinPointAt(stored, stored, binding, poseWorld);
    expect(Math.hypot(drawn.x - clicked.x, drawn.y - clicked.y)).toBeLessThan(1);

    // PRE-FIX behaviour: store the posed coordinate raw. The dot lands
    // elsewhere — exactly the reported symptom.
    const drawnStale = skinPointAt(clicked, clicked, binding, poseWorld);
    expect(Math.hypot(drawnStale.x - clicked.x, drawnStale.y - clicked.y)).toBeGreaterThan(1);
  });

  it('is an identity on a layer with no skeleton (unchanged behaviour)', () => {
    // No skeleton ⇒ the overlay's toRestSpace is the identity function, so
    // click-add keeps writing the plain local coordinate it always did.
    const restMesh = buildRestMesh(W, H, 0, RIG);
    const binding = getSkeletonBinding(restMesh, []);
    const poseWorld = computeWorldTransforms({ bones: [] });
    const p = { x: 33, y: -12 };
    // With no bones there is no blended matrix, so both helpers pass through.
    expect(unskinPoint(p, binding, poseWorld)).toEqual(p);
    expect(skinPointAt(p, p, binding, poseWorld)).toEqual(p);
  });
});
