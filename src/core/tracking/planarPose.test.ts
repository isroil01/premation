/**
 * Planar pose solve, closed against the ENGINE's own projection: cameras with
 * known pose project a plane grid through `Project3D.projectPoint`, and the
 * solver must hand back that exact pose in the engine's own conventions
 * (orientationX/Y/Z semantics). Any convention drift between solver and
 * renderer fails here, not in a user's shot.
 */

import { Project3D } from '@motion/scene';
import { solvePlanarPose, unwrapDegrees } from './planarPose';

const W = 1920;
const H = 1080;
const F = 1200;
const CX = W / 2;
const CY = H / 2;

function planeGrid(): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      out.push({ x: 500 + c * 300, y: 250 + r * 180 });
    }
  }
  return out;
}

function projectThrough(cam: Project3D.Camera3D): { plane: Array<{ x: number; y: number }>; image: Array<{ x: number; y: number }> } {
  const plane = planeGrid();
  const image = plane.map((p) => {
    const pr = Project3D.projectPoint({ x: p.x, y: p.y, z: 0 }, cam);
    return { x: pr.x, y: pr.y };
  });
  return { plane, image };
}

describe('solvePlanarPose', () => {
  it('recovers the default straight-on camera', () => {
    const cam: Project3D.Camera3D = {
      position: { x: CX, y: CY, z: -F },
      principal: { x: CX, y: CY },
      focalLength: F,
    };
    const { plane, image } = projectThrough(cam);
    const pose = solvePlanarPose(plane, image, F, CX, CY)!;
    expect(pose).not.toBeNull();
    expect(pose.position.x).toBeCloseTo(CX, 2);
    expect(pose.position.y).toBeCloseTo(CY, 2);
    expect(pose.position.z).toBeCloseTo(-F, 2);
    expect(pose.yawDeg).toBeCloseTo(0, 3);
    expect(pose.pitchDeg).toBeCloseTo(0, 3);
    expect(pose.rollDeg).toBeCloseTo(0, 3);
    expect(pose.rmsPx).toBeLessThan(0.01);
  });

  it('recovers a translated, fully rotated camera', () => {
    const cam: Project3D.Camera3D = {
      position: { x: 700, y: 350, z: -1500 },
      principal: { x: CX, y: CY },
      focalLength: F,
      orientation: { yaw: 9, pitch: -6, roll: 4 },
    };
    const { plane, image } = projectThrough(cam);
    const pose = solvePlanarPose(plane, image, F, CX, CY)!;
    expect(pose).not.toBeNull();
    expect(pose.position.x).toBeCloseTo(700, 1);
    expect(pose.position.y).toBeCloseTo(350, 1);
    expect(pose.position.z).toBeCloseTo(-1500, 1);
    expect(pose.yawDeg).toBeCloseTo(9, 2);
    expect(pose.pitchDeg).toBeCloseTo(-6, 2);
    expect(pose.rollDeg).toBeCloseTo(4, 2);
    expect(pose.rmsPx).toBeLessThan(0.05);
  });

  it('tracks a camera path frame by frame (a dolly-and-pan move)', () => {
    for (let i = 0; i <= 10; i++) {
      const cam: Project3D.Camera3D = {
        position: { x: CX + i * 30, y: CY - i * 10, z: -F - i * 40 },
        principal: { x: CX, y: CY },
        focalLength: F,
        orientation: { yaw: i * 1.5, pitch: i * -0.8, roll: 0 },
      };
      const { plane, image } = projectThrough(cam);
      const pose = solvePlanarPose(plane, image, F, CX, CY)!;
      expect(pose.position.x).toBeCloseTo(cam.position.x, 1);
      expect(pose.position.z).toBeCloseTo(cam.position.z, 1);
      expect(pose.yawDeg).toBeCloseTo(i * 1.5, 2);
      expect(pose.pitchDeg).toBeCloseTo(i * -0.8, 2);
    }
  });

  it('rejects degenerate input (collinear plane points)', () => {
    const plane = [0, 1, 2, 3].map((i) => ({ x: i * 100, y: 500 }));
    const image = plane.map((p) => ({ x: p.x, y: p.y }));
    expect(solvePlanarPose(plane, image, F, CX, CY)).toBeNull();
  });

  it('requires a positive focal and 4+ points', () => {
    const plane = planeGrid();
    const image = plane.map((p) => ({ ...p }));
    expect(solvePlanarPose(plane.slice(0, 3), image.slice(0, 3), F, CX, CY)).toBeNull();
    expect(solvePlanarPose(plane, image, 0, CX, CY)).toBeNull();
  });
});

describe('unwrapDegrees', () => {
  it('removes atan2 seams', () => {
    expect(unwrapDegrees([170, 179, -179, -170])).toEqual([170, 179, 181, 190]);
    expect(unwrapDegrees([-170, -179, 179])).toEqual([-170, -179, -181]);
  });
});
