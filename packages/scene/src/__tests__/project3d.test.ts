/**
 * Pinhole projection — with the camera-pan cases the original suite never had.
 *
 * The existing 3D tests only varied focal length and layer z, so a projection
 * that ignored camera X/Y entirely stayed green. `projectPoint` used
 * `position.x` as BOTH the eye and the principal point:
 *
 *   x = cam.x + (p.x - cam.x) * scale
 *
 * At z = 0, scale = 1, so that reduces to `x = p.x` — the camera term cancels
 * and panning does nothing. It looked right only because the default camera
 * sits at the comp centre, where eye and principal point coincide.
 */

import { defaultCamera, projectPoint, focalLengthForFov } from '../utils/project3d';

const W = 1920;
const H = 1080;

describe('projectPoint', () => {
  it('projects the comp plane 1:1 through the default camera', () => {
    const cam = defaultCamera(W, H);
    const p = projectPoint({ x: 300, y: 200, z: 0 }, cam);

    expect(p.x).toBeCloseTo(300);
    expect(p.y).toBeCloseTo(200);
    expect(p.scale).toBeCloseTo(1);
  });

  it('shifts the frame when the camera pans in X', () => {
    const cam = defaultCamera(W, H);
    const before = projectPoint({ x: 960, y: 540, z: 0 }, cam);

    cam.position.x += 100;
    const after = projectPoint({ x: 960, y: 540, z: 0 }, cam);

    // Camera right ⇒ subject left, 1:1 on the comp plane.
    expect(after.x).toBeCloseTo(before.x - 100);
  });

  it('shifts the frame when the camera pans in Y', () => {
    const cam = defaultCamera(W, H);
    const before = projectPoint({ x: 960, y: 540, z: 0 }, cam);

    cam.position.y -= 75;
    const after = projectPoint({ x: 960, y: 540, z: 0 }, cam);

    expect(after.y).toBeCloseTo(before.y + 75);
  });

  it('gives nearer layers more parallax than farther ones', () => {
    const cam = defaultCamera(W, H);
    const f = focalLengthForFov(W, 39.6);

    const near = { x: 960, y: 540, z: -f / 2 }; // closer to the camera
    const far = { x: 960, y: 540, z: f }; // further away

    const nearBefore = projectPoint(near, cam).x;
    const farBefore = projectPoint(far, cam).x;
    cam.position.x += 100;
    const nearShift = Math.abs(projectPoint(near, cam).x - nearBefore);
    const farShift = Math.abs(projectPoint(far, cam).x - farBefore);

    expect(nearShift).toBeGreaterThan(farShift);
  });

  it('moves layers at depth in the direction opposite the camera', () => {
    // The old code moved off-plane layers the WRONG way (∂x/∂cam.x = 1 − scale
    // instead of −scale), so this pins the sign as well as the magnitude.
    const cam = defaultCamera(W, H);
    const p = { x: 960, y: 540, z: 500 };
    const before = projectPoint(p, cam).x;

    cam.position.x += 100;
    const after = projectPoint(p, cam);

    expect(after.x).toBeLessThan(before);
    expect(after.x).toBeCloseTo(before - 100 * after.scale);
  });

  it('keeps a layer centred under the camera as the camera moves', () => {
    const cam = defaultCamera(W, H);
    cam.position.x = 400;
    cam.position.y = 300;

    // A point on the optical axis projects to the principal point at any depth.
    expect(projectPoint({ x: 400, y: 300, z: 0 }, cam)).toMatchObject({ x: W / 2, y: H / 2 });
    expect(projectPoint({ x: 400, y: 300, z: 800 }, cam)).toMatchObject({ x: W / 2, y: H / 2 });
  });

  it('still scales by depth', () => {
    const cam = defaultCamera(W, H);
    const near = projectPoint({ x: 960, y: 540, z: -200 }, cam);
    const far = projectPoint({ x: 960, y: 540, z: 200 }, cam);

    expect(near.scale).toBeGreaterThan(1);
    expect(far.scale).toBeLessThan(1);
    expect(far.depth).toBeGreaterThan(near.depth);
  });
});

describe('camera orientation + orbit', () => {
  const { orbitCamera } = require('../utils/project3d');
  const P = (x: number, y: number, z: number) => ({ x, y, z });

  it('zero orientation projects identically to the legacy path', () => {
    const base = defaultCamera(1920, 1080);
    const withZero = { ...base, orientation: { yaw: 0, pitch: 0 } };
    for (const p of [P(960, 540, 0), P(0, 0, 0), P(1920, 1080, 300), P(500, 200, -200)]) {
      const a = projectPoint(p, base);
      const b = projectPoint(p, withZero);
      expect(b.x).toBeCloseTo(a.x, 8);
      expect(b.y).toBeCloseTo(a.y, 8);
      expect(b.scale).toBeCloseTo(a.scale, 8);
      expect(b.depth).toBeCloseTo(a.depth, 8);
    }
  });

  it('orbitCamera(90° yaw) moves the eye to the side at the same distance', () => {
    const o = orbitCamera(P(0, 0, -500), P(0, 0, 0), 90, 0);
    expect(o.position.x).toBeCloseTo(-500);
    expect(o.position.y).toBeCloseTo(0);
    expect(o.position.z).toBeCloseTo(0);
    expect(Math.hypot(o.position.x, o.position.y, o.position.z)).toBeCloseTo(500);
  });

  it('an orbited camera keeps the POI centred at the same depth', () => {
    for (const [yaw, pitch] of [[35, 0], [0, -40], [60, 25], [180, 10]] as const) {
      const o = orbitCamera(P(0, 0, -500), P(0, 0, 0), yaw, pitch);
      const proj = projectPoint(P(0, 0, 0), {
        position: o.position,
        focalLength: 500,
        principal: { x: 0, y: 0 },
        orientation: o.orientation,
      });
      expect(proj.x).toBeCloseTo(0, 6);
      expect(proj.y).toBeCloseTo(0, 6);
      expect(proj.depth).toBeCloseTo(500, 6);
    }
  });

  it('yaw parallax: a point beside the POI shifts as the camera swings', () => {
    const straightCam = { position: P(0, 0, -500), focalLength: 500, principal: { x: 0, y: 0 } };
    const straight = projectPoint(P(100, 0, 0), straightCam);
    const o = orbitCamera(P(0, 0, -500), P(0, 0, 0), 30, 0);
    const swung = projectPoint(P(100, 0, 0), { ...straightCam, position: o.position, orientation: o.orientation });
    expect(Math.abs(swung.x - straight.x)).toBeGreaterThan(1);
    // The POI-side point ends up farther from the camera → smaller scale.
    expect(swung.depth).toBeGreaterThan(straight.depth);
  });

  it('zero orbit returns the base configuration unchanged', () => {
    const o = orbitCamera(P(12, 34, -500), P(0, 0, 0), 0, 0);
    expect(o.position).toEqual(P(12, 34, -500));
    expect(o.orientation).toEqual({ yaw: 0, pitch: 0 });
  });
});

describe('lookAtOrientation (two-node camera)', () => {
  const { lookAtOrientation, orbitCamera } = require('../utils/project3d');
  const P = (x: number, y: number, z: number) => ({ x, y, z });

  it('a target straight ahead (along +z) needs no rotation', () => {
    expect(lookAtOrientation(P(0, 0, -500), P(0, 0, 0))).toEqual({ yaw: 0, pitch: 0 });
  });

  it('the target ALWAYS projects to the principal point (screen centre)', () => {
    // Camera off to the side and above, aimed at a target on the comp plane.
    const eye = P(300, -200, -500);
    const target = P(0, 0, 0);
    const orientation = lookAtOrientation(eye, target);
    const proj = projectPoint(target, { position: eye, focalLength: 500, principal: { x: 0, y: 0 }, orientation });
    expect(proj.x).toBeCloseTo(0, 3);
    expect(proj.y).toBeCloseTo(0, 3);
  });

  it('a target to the right yaws the camera positively', () => {
    const o = lookAtOrientation(P(0, 0, -500), P(200, 0, 0));
    expect(o.yaw).toBeGreaterThan(0);
    expect(o.pitch).toBeCloseTo(0, 6);
  });

  it('holds while the camera orbits its POI (still framed)', () => {
    const poi = P(0, 0, 0);
    const orbited = orbitCamera(P(0, 0, -500), poi, 40, 15);
    const orientation = lookAtOrientation(orbited.position, poi);
    const proj = projectPoint(poi, { position: orbited.position, focalLength: 500, principal: { x: 0, y: 0 }, orientation });
    expect(proj.x).toBeCloseTo(0, 3);
    expect(proj.y).toBeCloseTo(0, 3);
  });
});

describe('3D Raycasting & Intersection Math', () => {
  const { unprojectScreenRay, intersectRayPlane, closestPointRayAxis } = require('../utils/project3d');

  it('unprojects screen center through default camera along +Z ray direction', () => {
    const cam = defaultCamera(1920, 1080);
    const ray = unprojectScreenRay(960, 540, cam);

    expect(ray.origin.x).toBe(960);
    expect(ray.origin.y).toBe(540);
    expect(ray.direction.x).toBeCloseTo(0);
    expect(ray.direction.y).toBeCloseTo(0);
    expect(ray.direction.z).toBeCloseTo(1);
  });

  it('intersects ray with comp plane Z=0 correctly', () => {
    const ray = { origin: { x: 960, y: 540, z: -1000 }, direction: { x: 0, y: 0, z: 1 } };
    const hit = intersectRayPlane(ray, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });

    expect(hit).not.toBeNull();
    expect(hit?.x).toBeCloseTo(960);
    expect(hit?.y).toBeCloseTo(540);
    expect(hit?.z).toBeCloseTo(0);
  });

  it('finds closest point between screen ray and X axis line', () => {
    const ray = { origin: { x: 500, y: 540, z: -1000 }, direction: { x: 0, y: 0, z: 1 } };
    const { tAxis, pointOnAxis } = closestPointRayAxis(
      ray,
      { x: 960, y: 540, z: 0 },
      { x: 1, y: 0, z: 0 }
    );

    expect(pointOnAxis.y).toBeCloseTo(540);
    expect(pointOnAxis.z).toBeCloseTo(0);
    expect(tAxis).toBeCloseTo(-460);
  });
});

