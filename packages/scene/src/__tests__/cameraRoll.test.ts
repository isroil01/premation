/**
 * Camera roll — the third orientation axis (a dutch angle).
 *
 * Roll spins the frame about the VIEW axis without re-aiming the camera. World
 * → camera is Rz(−roll)·Rx(−pitch)·Ry(−yaw)·T(−eye), so roll is applied last.
 *
 * The properties that matter are the invariants, not the individual matrix
 * entries: the aim must not change, the projection and the unprojection must
 * remain exact inverses, and the 4×4 GPU form must agree with the scalar path.
 * Those are what catch a sign error; a hand-checked matrix entry is not.
 */

import { Project3D, Matrix4Math } from '../index';
import type { Vec3 } from '../types';

const W = 1920;
const H = 1080;
const base = () => Project3D.defaultCamera(W, H);
const cam = (o: { yaw?: number; pitch?: number; roll?: number }) => ({
  ...base(),
  orientation: { yaw: o.yaw ?? 0, pitch: o.pitch ?? 0, ...(o.roll === undefined ? {} : { roll: o.roll }) },
});

describe('camera roll', () => {
  it('zero roll is byte-identical to the pre-roll path', () => {
    const p: Vec3 = { x: 700, y: 400, z: 300 };
    for (const o of [{ yaw: 0, pitch: 0 }, { yaw: 30, pitch: -15 }]) {
      expect(Project3D.projectPoint(p, cam({ ...o, roll: 0 }))).toEqual(
        Project3D.projectPoint(p, { ...base(), orientation: o }),
      );
    }
  });

  it('an all-zero orientation is byte-identical to no orientation at all', () => {
    // The §4.3 guarantee, now that THREE sources feed this one object: camera
    // in-place rotation (`orientationX`/`orientationY`) composes into the same
    // yaw/pitch fields as orbit and look-at, so an unrotated camera must still
    // fall through to `projectPoint`'s simple path. `cameraFromNode` enforces
    // that by omitting the key entirely (its `nonZero` gate, pinned in
    // src/core/scene/cameraOrientation.test.ts); this pins the other half —
    // that a zero orientation, should one reach here, projects identically.
    const points: Vec3[] = [
      { x: 700, y: 400, z: 300 },
      { x: 0, y: 0, z: -50 },
      { x: 1920, y: 1080, z: 4000 },
    ];
    for (const p of points) {
      expect(Project3D.projectPoint(p, cam({ yaw: 0, pitch: 0, roll: 0 }))).toEqual(
        Project3D.projectPoint(p, base()),
      );
    }
  });

  it('does NOT change what the camera is aimed at', () => {
    // A point on the optical axis stays on the principal point however the
    // frame is rolled — that is the difference between roll and re-aiming.
    const c = base();
    const onAxis: Vec3 = { x: c.position.x, y: c.position.y, z: c.position.z + 500 };
    for (const roll of [0, 30, 90, -145]) {
      const q = Project3D.projectPoint(onAxis, cam({ roll }));
      expect(q.x).toBeCloseTo(c.principal.x, 6);
      expect(q.y).toBeCloseTo(c.principal.y, 6);
    }
  });

  it('rotates the frame: a point off-axis swings about the principal point', () => {
    const c = base();
    const p: Vec3 = { x: c.position.x + 200, y: c.position.y, z: c.position.z + 500 };
    const flat = Project3D.projectPoint(p, cam({}));
    const rolled = Project3D.projectPoint(p, cam({ roll: 90 }));
    // Distance from the principal point is preserved; the direction turns 90°.
    const r0 = Math.hypot(flat.x - c.principal.x, flat.y - c.principal.y);
    const r1 = Math.hypot(rolled.x - c.principal.x, rolled.y - c.principal.y);
    expect(r1).toBeCloseTo(r0, 6);
    expect(rolled.x - c.principal.x).toBeCloseTo(0, 6);
    expect(Math.abs(rolled.y - c.principal.y)).toBeCloseTo(r0, 6);
  });

  it('preserves scale — roll is not a zoom', () => {
    const p: Vec3 = { x: 900, y: 700, z: 400 };
    expect(Project3D.projectPoint(p, cam({ roll: 37 })).scale).toBeCloseTo(
      Project3D.projectPoint(p, cam({})).scale,
      9,
    );
    expect(Project3D.projectPoint(p, cam({ roll: 37 })).depth).toBeCloseTo(
      Project3D.projectPoint(p, cam({})).depth,
      9,
    );
  });

  it('projectPoint and unprojectScreenRay stay exact inverses', () => {
    // The strongest check available: unproject the projected point and confirm
    // the ray passes back through it. A roll sign error breaks this immediately.
    for (const o of [{ roll: 25 }, { yaw: 40, roll: -70 }, { yaw: -20, pitch: 30, roll: 115 }]) {
      const c = cam(o);
      const p: Vec3 = { x: 1200, y: 300, z: 600 };
      const q = Project3D.projectPoint(p, c);
      const ray = Project3D.unprojectScreenRay(q.x, q.y, c, null, W, H);
      // The point lies along the ray at distance |p − eye|.
      const dist = Math.hypot(p.x - c.position.x, p.y - c.position.y, p.z - c.position.z);
      expect(ray.origin.x + ray.direction.x * dist).toBeCloseTo(p.x, 4);
      expect(ray.origin.y + ray.direction.y * dist).toBeCloseTo(p.y, 4);
      expect(ray.origin.z + ray.direction.z * dist).toBeCloseTo(p.z, 4);
    }
  });

  it('the GPU 4×4 view+projection agrees with the scalar path', () => {
    // The two forms must never disagree about where a layer sits — that is the
    // whole reason both live in one file.
    for (const o of [{ roll: 45 }, { yaw: 25, pitch: -10, roll: -60 }]) {
      const c = cam(o);
      const vp = Matrix4Math.multiply(Project3D.cameraProjectionMatrix(c), Project3D.cameraViewMatrix(c));
      for (const p of [{ x: 400, y: 200, z: 100 }, { x: 1500, y: 900, z: 800 }] as Vec3[]) {
        const scalar = Project3D.projectPoint(p, c);
        // transformPoint divides by w, which is camera-space z — the same
        // divide the hardware does.
        const gpu = Matrix4Math.transformPoint(vp, p);
        expect(gpu.x).toBeCloseTo(scalar.x, 4);
        expect(gpu.y).toBeCloseTo(scalar.y, 4);
      }
    }
  });

  it('composes with yaw and pitch rather than replacing them', () => {
    const p: Vec3 = { x: 1400, y: 800, z: 500 };
    const noRoll = Project3D.projectPoint(p, cam({ yaw: 35, pitch: -20 }));
    const rolled = Project3D.projectPoint(p, cam({ yaw: 35, pitch: -20, roll: 50 }));
    expect(rolled).not.toEqual(noRoll);
    // Still the same depth: roll cannot move a point along the view axis.
    expect(rolled.depth).toBeCloseTo(noRoll.depth, 9);
  });
});
