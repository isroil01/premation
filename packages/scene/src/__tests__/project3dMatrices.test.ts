/**
 * Parity between the GPU matrix camera (cameraViewMatrix / cameraProjectionMatrix /
 * orthoCameraMatrices) and the scalar CPU projections (projectPoint / projectOrtho).
 * The depth-tested 3D pipeline projects through the matrices in hardware; the
 * affine fallback, hit-testing and painter sort use the scalar path — these
 * tests pin them to agree for arbitrary cameras and points.
 */

import * as Project3D from '../utils/project3d';
import * as Matrix4Math from '../utils/matrix4';
import type { Vec3 } from '../types';

const W = 1920;
const H = 1080;

/** Project a point through projection · view with the homogeneous divide. */
function matrixProject(cam: Project3D.Camera3D, p: Vec3): { x: number; y: number; z: number } {
  const pv = Matrix4Math.multiply(Project3D.cameraProjectionMatrix(cam), Project3D.cameraViewMatrix(cam));
  return Matrix4Math.transformPoint(pv, p);
}

describe('perspective camera matrices match projectPoint', () => {
  const points: Vec3[] = [
    { x: 960, y: 540, z: 0 },
    { x: 100, y: 200, z: 0 },
    { x: 1500, y: 900, z: 400 },
    { x: -250, y: 1300, z: -300 },
    { x: 42, y: -77, z: 1234 },
  ];

  it('default camera: matrix x/y equal the scalar projection', () => {
    const cam = Project3D.defaultCamera(W, H);
    for (const p of points) {
      const scalar = Project3D.projectPoint(p, cam);
      const m = matrixProject(cam, p);
      expect(m.x).toBeCloseTo(scalar.x, 6);
      expect(m.y).toBeCloseTo(scalar.y, 6);
    }
  });

  it('panned + dollied camera agrees', () => {
    const cam: Project3D.Camera3D = {
      ...Project3D.defaultCamera(W, H),
      position: { x: 600, y: 300, z: -1500 },
    };
    for (const p of points) {
      const scalar = Project3D.projectPoint(p, cam);
      const m = matrixProject(cam, p);
      expect(m.x).toBeCloseTo(scalar.x, 6);
      expect(m.y).toBeCloseTo(scalar.y, 6);
    }
  });

  it('rotated camera (yaw + pitch) agrees', () => {
    const base = Project3D.defaultCamera(W, H);
    const cam: Project3D.Camera3D = {
      ...base,
      position: { x: 700, y: 400, z: -1200 },
      orientation: { yaw: 25, pitch: -12 },
    };
    for (const p of points) {
      const scalar = Project3D.projectPoint(p, cam);
      // The scalar path clamps camera-space z to NEAR; skip points it clamped
      // (the GPU clips those in hardware instead).
      if (scalar.depth <= Project3D.PERSPECTIVE_NEAR) continue;
      const m = matrixProject(cam, p);
      expect(m.x).toBeCloseTo(scalar.x, 5);
      expect(m.y).toBeCloseTo(scalar.y, 5);
    }
  });

  it('normalised depth is in [0,1] and monotonic in camera distance', () => {
    const cam = Project3D.defaultCamera(W, H);
    const zs = [-500, 0, 500, 2000, 10000];
    let prev = -Infinity;
    for (const z of zs) {
      const m = matrixProject(cam, { x: 960, y: 540, z });
      expect(m.z).toBeGreaterThanOrEqual(0);
      expect(m.z).toBeLessThanOrEqual(1);
      expect(m.z).toBeGreaterThan(prev);
      prev = m.z;
    }
  });

  it('the depth-sort order of the matrix z matches the scalar depth order', () => {
    const cam: Project3D.Camera3D = {
      ...Project3D.defaultCamera(W, H),
      position: { x: 500, y: 500, z: -900 },
      orientation: { yaw: 10, pitch: 5 },
    };
    const sample = points.filter((p) => Project3D.projectPoint(p, cam).depth > Project3D.PERSPECTIVE_NEAR);
    const byScalar = [...sample].sort((a, b) => Project3D.projectPoint(a, cam).depth - Project3D.projectPoint(b, cam).depth);
    const byMatrix = [...sample].sort((a, b) => matrixProject(cam, a).z - matrixProject(cam, b).z);
    expect(byMatrix).toEqual(byScalar);
  });
});

describe('orthographic camera matrices match projectOrtho', () => {
  const views: Project3D.OrthoView[] = ['front', 'back', 'left', 'right', 'top', 'bottom'];
  const points: Vec3[] = [
    { x: 960, y: 540, z: 0 },
    { x: 10, y: 20, z: 30 },
    { x: 1900, y: 1000, z: -450 },
  ];

  it.each(views)('%s view: x/y match and depth order is preserved', (view) => {
    const { view: V, projection: P } = Project3D.orthoCameraMatrices(view, W, H);
    const pv = Matrix4Math.multiply(P, V);
    for (const p of points) {
      const scalar = Project3D.projectOrtho(p, view, W, H);
      const m = Matrix4Math.transformPoint(pv, p);
      expect(m.x).toBeCloseTo(scalar.x, 6);
      expect(m.y).toBeCloseTo(scalar.y, 6);
      // z is normalised: 0.5 at the comp plane, monotonic in scalar depth.
      expect(m.z).toBeCloseTo(scalar.depth / (2 * Project3D.ORTHO_DEPTH_RANGE) + 0.5, 9);
    }
  });
});
