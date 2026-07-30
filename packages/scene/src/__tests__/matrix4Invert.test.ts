/**
 * `Matrix4Math.invert` / `toLocalPoint` — the world→parent-space conversion that
 * direct manipulation of a PARENTED object depends on.
 *
 * A drag computes a world position; a node stores local values. Without the
 * inversion the world position is written straight to the node and then composed
 * with the parent a second time, so the object jumps by exactly the parent
 * transform the moment the pointer is released. These pin the round trip.
 */

import { Matrix4Math } from '../index';
import type { Matrix4, Vec3 } from '../types';

const close = (a: Vec3, b: Vec3, p = 6) => {
  expect(a.x).toBeCloseTo(b.x, p);
  expect(a.y).toBeCloseTo(b.y, p);
  expect(a.z).toBeCloseTo(b.z, p);
};

/** A representative parent transform: translated, rotated on all three axes, scaled. */
const rig = (): Matrix4 =>
  Matrix4Math.compose({
    position: { x: 300, y: -120, z: 480 },
    rotation: { x: 0.4, y: -0.9, z: 0.25 },
    scale: { x: 2, y: 0.5, z: 1.5 },
    anchor: { x: 0, y: 0, z: 0 },
  });

describe('Matrix4Math.invert', () => {
  it('round-trips a point through an affine transform', () => {
    const m = rig();
    const p = { x: 42, y: -17, z: 91 };
    close(Matrix4Math.toLocalPoint(m, Matrix4Math.transformPoint(m, p)), p);
  });

  it('m · m⁻¹ = identity', () => {
    const m = rig();
    const inv = Matrix4Math.invert(m)!;
    expect(inv).not.toBeNull();
    const prod = Matrix4Math.multiply(m, inv);
    Matrix4Math.identity().forEach((want, i) => expect(prod[i]).toBeCloseTo(want, 6));
  });

  it('inverts the identity to itself', () => {
    expect(Matrix4Math.invert(Matrix4Math.identity())).toEqual(Matrix4Math.identity());
  });

  it('returns null for a singular matrix rather than NaN', () => {
    // Scale 0 on one axis collapses the basis — not invertible.
    const flat = Matrix4Math.compose({
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 0, z: 1 },
      anchor: { x: 0, y: 0, z: 0 },
    });
    expect(Matrix4Math.invert(flat)).toBeNull();
  });

  it('toLocalPoint leaves the point alone when the matrix is singular', () => {
    // A degenerate parent must not send a drag to NaN.
    const flat = Matrix4Math.compose({
      position: { x: 10, y: 10, z: 10 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 0, y: 0, z: 0 },
      anchor: { x: 0, y: 0, z: 0 },
    });
    const p = { x: 5, y: 6, z: 7 };
    expect(Matrix4Math.toLocalPoint(flat, p)).toEqual(p);
  });

  it('handles a non-affine matrix through the general path', () => {
    // A perspective-style matrix: bottom row is not (0,0,0,1), so the affine
    // shortcut must not be taken.
    const persp: Matrix4 = [
      2, 0, 0, 0,
      0, 2, 0, 0,
      0, 0, 1.0001, 1,
      0, 0, -1.0001, 0,
    ];
    const inv = Matrix4Math.invert(persp);
    expect(inv).not.toBeNull();
    const prod = Matrix4Math.multiply(persp, inv!);
    Matrix4Math.identity().forEach((want, i) => expect(prod[i]).toBeCloseTo(want, 4));
  });

  it('the drag round trip: a world drop lands back on itself through the parent', () => {
    // The exact operation a parented-camera drag performs.
    const parentWorld = rig();
    const droppedInWorld = { x: 1234, y: 567, z: -89 };
    const local = Matrix4Math.toLocalPoint(parentWorld, droppedInWorld);
    // Composing the stored local value back through the parent must reproduce
    // where the pointer actually was — no snap, no drift.
    close(Matrix4Math.transformPoint(parentWorld, local), droppedInWorld);
  });
});
