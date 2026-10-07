/**
 * The 3D gizmo's drag math (AE parity 4.6): Euler round trips in the
 * renderer's R = Rz·Ry·Rx convention, world-axis turns written back as X/Y/Z
 * Rotation (parented and oriented layers too), the trackball's direction,
 * axis-projected scale, increments, typed values and the pivot edit.
 */

import { Matrix4Math, type Vec3 } from '@motion/scene';
import {
  axisAngleMat3,
  axisScaleFactor,
  eulerToMat3,
  mat3ToEuler,
  mulMat3,
  parentRotationMat3,
  pivotEdit,
  rotateEulerAboutWorldAxis,
  snapIncrement,
  trackballRotation,
  typedValue,
  typedValueKey,
  type Mat3,
} from '../selection/gizmo3dMath';

const close = (a: Mat3, b: Mat3): void => {
  for (let i = 0; i < 9; i++) expect(a[i]).toBeCloseTo(b[i]!, 9);
};
const apply = (m: Mat3, v: Vec3): Vec3 => ({
  x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
  y: m[3] * v.x + m[4] * v.y + m[5] * v.z,
  z: m[6] * v.x + m[7] * v.y + m[8] * v.z,
});

describe('Euler ⇄ matrix (R = Rz · Ry · Rx, matrix4 compose)', () => {
  it('matches Matrix4Math.compose', () => {
    const e = { rotX: 30, rotY: -50, rotZ: 110 };
    const m4 = Matrix4Math.compose({
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: (30 * Math.PI) / 180, y: (-50 * Math.PI) / 180, z: (110 * Math.PI) / 180 },
      scale: { x: 1, y: 1, z: 1 },
      anchor: { x: 0, y: 0, z: 0 },
    });
    close(eulerToMat3(e), [m4[0]!, m4[4]!, m4[8]!, m4[1]!, m4[5]!, m4[9]!, m4[2]!, m4[6]!, m4[10]!]);
  });

  it('round-trips, keeping whole turns and the solution nearest the reference', () => {
    for (const e of [{ rotX: 10, rotY: 20, rotZ: 30 }, { rotX: -170, rotY: 80, rotZ: 45 }, { rotX: 400, rotY: -30, rotZ: 725 }]) {
      const back = mat3ToEuler(eulerToMat3(e), e);
      expect(back.rotX).toBeCloseTo(e.rotX, 6);
      expect(back.rotY).toBeCloseTo(e.rotY, 6);
      expect(back.rotZ).toBeCloseTo(e.rotZ, 6);
    }
  });

  it('gimbal lock (Y = ±90°) keeps Z and still rebuilds the same matrix', () => {
    for (const y of [90, -90]) {
      const e = { rotX: 25, rotY: y, rotZ: 40 };
      const back = mat3ToEuler(eulerToMat3(e), e);
      expect(back.rotZ).toBeCloseTo(40, 6);
      close(eulerToMat3(back), eulerToMat3(e));
    }
  });
});

describe('rotateEulerAboutWorldAxis', () => {
  it('a world-Z turn of an unrotated layer is its Z Rotation', () => {
    const r = rotateEulerAboutWorldAxis({ rotX: 0, rotY: 0, rotZ: 0 }, undefined, { x: 0, y: 0, z: 1 }, (30 * Math.PI) / 180);
    expect(r.rotX).toBeCloseTo(0, 9);
    expect(r.rotY).toBeCloseTo(0, 9);
    expect(r.rotZ).toBeCloseTo(30, 9);
  });

  it('turns the layer in the WORLD, through its parent and Orientation', () => {
    const parent = Matrix4Math.compose({
      position: { x: 100, y: 0, z: 0 },
      rotation: { x: 0.3, y: -0.7, z: 1.1 },
      scale: { x: 2, y: 2, z: 2 },
      anchor: { x: 0, y: 0, z: 0 },
    });
    const frame = { parent: Array.from(parent), orientation: { x: 15, y: 25, z: -35 } };
    const start = { rotX: 10, rotY: 20, rotZ: 30 };
    const axis = { x: 0.3, y: 0.9, z: -0.2 };
    const angle = 0.8;
    const r = rotateEulerAboutWorldAxis(start, frame, axis, angle);
    const B = mulMat3(parentRotationMat3(frame.parent), eulerToMat3({ rotX: 15, rotY: 25, rotZ: -35 }));
    const worldBefore = mulMat3(B, eulerToMat3(start));
    const worldAfter = mulMat3(B, eulerToMat3(r));
    close(worldAfter, mulMat3(axisAngleMat3(axis, angle), worldBefore));
  });
});

describe('trackballRotation', () => {
  // The default camera's screen axes: right = +x, down = +y, forward = +z.
  const right = { x: 1, y: 0, z: 0 };
  const down = { x: 0, y: 1, z: 0 };
  it('dragging right swings the near side right; dragging down swings it down', () => {
    const near = { x: 0, y: 0, z: -1 };
    const r = trackballRotation(40, 0, right, down);
    expect(apply(axisAngleMat3(r.axis, r.angleRad), near).x).toBeGreaterThan(0);
    const d = trackballRotation(0, 40, right, down);
    expect(apply(axisAngleMat3(d.axis, d.angleRad), near).y).toBeGreaterThan(0);
    expect(Math.abs(r.angleRad)).toBeCloseTo((40 * 0.5 * Math.PI) / 180, 9);
  });
  it('no travel, no turn', () => {
    expect(trackballRotation(0, 0, right, down).angleRad).toBe(0);
  });
});

describe('axis-projected scale, increments, typed values', () => {
  it('grows along the arm as drawn, shrinks against it, never below 1%', () => {
    const dir = { x: -Math.SQRT1_2, y: Math.SQRT1_2 };
    expect(axisScaleFactor(-30, 30, dir, 60)).toBeCloseTo(1 + Math.hypot(30, 30) / 60, 9);
    expect(axisScaleFactor(30, -30, dir, 60)).toBeLessThan(1);
    expect(axisScaleFactor(1000, -1000, dir, 60)).toBe(0.01);
    // Travel across the arm does nothing.
    expect(axisScaleFactor(30, 30, dir, 60)).toBeCloseTo(1, 9);
  });
  it('snaps to increments', () => {
    expect(snapIncrement(23, 10)).toBe(20);
    expect(snapIncrement(1.26, 0.1)).toBeCloseTo(1.3, 9);
    expect(snapIncrement(7, 0)).toBe(7);
  });
  it('types a value: digits, one point, a toggled sign, backspace', () => {
    let b = '';
    for (const k of ['1', '2', '.', '5', '.', '-']) b = typedValueKey(b, k) ?? b;
    expect(b).toBe('-12.5');
    expect(typedValue(b)).toBe(-12.5);
    expect(typedValueKey(b, 'Backspace')).toBe('-12.');
    expect(typedValueKey('', '.')).toBe('0.');
    expect(typedValueKey('', 'x')).toBeNull();
    expect(typedValue('-')).toBeNull();
    expect(typedValue('')).toBeNull();
  });
});

describe('pivotEdit (Pan Behind)', () => {
  it('moves the anchor by the delta in layer space so the layer stays put', () => {
    const parent = Matrix4Math.compose({
      position: { x: 50, y: 20, z: 0 },
      rotation: { x: 0, y: 0, z: Math.PI / 2 },
      scale: { x: 2, y: 2, z: 2 },
      anchor: { x: 0, y: 0, z: 0 },
    });
    const frame = { parent: Array.from(parent), orientation: { x: 0, y: 30, z: 0 } };
    const rot = { rotX: 10, rotY: 0, rotZ: 45 };
    const scale = { x: 1.5, y: 0.5, z: 1 };
    const d = { x: 12, y: -7, z: 4 };
    const { anchorDelta, parentDelta } = pivotEdit(d, frame, rot, scale);
    // Layer linear part in the parent: Orientation · R · diag(scale); the
    // anchor term it subtracts must cancel the position change exactly.
    const L = mulMat3(mulMat3(eulerToMat3({ rotX: 0, rotY: 30, rotZ: 0 }), eulerToMat3(rot)), [scale.x, 0, 0, 0, scale.y, 0, 0, 0, scale.z]);
    const moved = apply(L, anchorDelta);
    expect(moved.x).toBeCloseTo(parentDelta.x, 9);
    expect(moved.y).toBeCloseTo(parentDelta.y, 9);
    expect(moved.z).toBeCloseTo(parentDelta.z, 9);
    // And the parent-space delta lifts back to the world delta.
    const w = { x: parent[0]! * parentDelta.x + parent[4]! * parentDelta.y + parent[8]! * parentDelta.z, y: parent[1]! * parentDelta.x + parent[5]! * parentDelta.y + parent[9]! * parentDelta.z, z: parent[2]! * parentDelta.x + parent[6]! * parentDelta.y + parent[10]! * parentDelta.z };
    expect(w.x).toBeCloseTo(d.x, 9);
    expect(w.y).toBeCloseTo(d.y, 9);
    expect(w.z).toBeCloseTo(d.z, 9);
  });
});
