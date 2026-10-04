/**
 * 3D IK — what must hold for the feature to be trustworthy:
 *
 *  • the euler extraction is the exact inverse of `Matrix4Math.compose` (a
 *    wrong convention here poses every joint sideways),
 *  • the CCD solve actually REACHES a reachable target, in and out of plane,
 *  • parent transforms on the chain root do not break the solve (the chain
 *    lives inside an imported model's fitted/centred root),
 *  • baking lands rotation keyframes on every joint except the effector.
 */

import { Matrix4Math } from '@motion/scene';
import {
  axisAngleMatrix,
  matrixToEulerDeg,
  
  
  
} from './boneIK3d';

const DEG = Math.PI / 180;

describe('axisAngleMatrix / matrixToEulerDeg', () => {
  it('rotates +x onto +y for a 90° z spin', () => {
    const m = axisAngleMatrix(0, 0, 1, Math.PI / 2);
    const p = Matrix4Math.transformPoint(m, { x: 1, y: 0, z: 0 });
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(1, 6);
  });

  it('is the exact inverse of compose for a general rotation', () => {
    const m = Matrix4Math.compose({
      position: { x: 5, y: -3, z: 8 },
      rotation: { x: 20 * DEG, y: 35 * DEG, z: -50 * DEG },
      scale: { x: 2, y: 2, z: 2 }, // scale must normalize out
      anchor: { x: 0, y: 0, z: 0 },
    });
    const e = matrixToEulerDeg(m);
    expect(e.x).toBeCloseTo(20, 4);
    expect(e.y).toBeCloseTo(35, 4);
    expect(e.z).toBeCloseTo(-50, 4);
  });
});
