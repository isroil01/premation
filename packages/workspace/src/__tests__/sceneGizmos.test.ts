/**
 * Scene reference geometry — the wireframes that make a 3D scene legible from
 * outside it.
 *
 * The properties worth pinning are the ones that make the geometry USEFUL, not
 * its exact vertex count: the frustum has to match the pinhole relation the
 * renderer actually projects with, the cone has to open at the light's cone
 * angle, and a flat layer's box has to stay findable when it is edge-on.
 */

import {
  buildCameraGizmo,
  buildLayerBoxGizmo,
  buildLightGizmo,
  cameraBasis,
  type GizmoSegment,
} from '../selection/sceneGizmos';
import { Project3D, Matrix4Math, type Vec3 } from '@motion/scene';

const W = 1920;
const H = 1080;

const kinds = (segs: readonly GizmoSegment[], kind: string) => segs.filter((s) => s.kind === kind);
const len = (a: Vec3, b: Vec3) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);

describe('cameraBasis', () => {
  it('is the identity basis for an unrotated camera', () => {
    const b = cameraBasis(0, 0);
    expect(b.forward).toEqual({ x: 0, y: -0, z: 1 });
    expect(b.right).toEqual({ x: 1, y: 0, z: -0 });
    expect(b.down).toEqual({ x: 0, y: 1, z: 0 });
  });

  it('matches the FORWARD rotation the unprojector uses, not its inverse', () => {
    // A gizmo built from projectPoint's (inverse) rotation points the frustum
    // backwards — plausible until you orbit, then it swings the wrong way. The
    // check: a ray cast through the screen centre must run along `forward`.
    for (const [yaw, pitch] of [[30, 0], [0, 25], [-40, 15]] as const) {
      const cam = { ...Project3D.defaultCamera(W, H), orientation: { yaw, pitch } };
      const ray = Project3D.unprojectScreenRay(cam.principal.x, cam.principal.y, cam, null, W, H);
      const b = cameraBasis(yaw, pitch);
      expect(b.forward.x).toBeCloseTo(ray.direction.x, 6);
      expect(b.forward.y).toBeCloseTo(ray.direction.y, 6);
      expect(b.forward.z).toBeCloseTo(ray.direction.z, 6);
    }
  });
});

describe('buildCameraGizmo', () => {
  const base = {
    nodeId: 'cam',
    position: { x: W / 2, y: H / 2, z: -1000 },
    focalLength: 1000,
    compWidth: W,
    compHeight: H,
    selected: false,
  };

  it('draws a closed frustum: 4 rays from the eye + the 4-edge far rectangle', () => {
    const g = buildCameraGizmo(base);
    const f = kinds(g.segments, 'frustum');
    expect(f).toHaveLength(8);
    // Exactly four segments start at the eye.
    expect(f.filter((s) => len(s.start, base.position) < 1e-6)).toHaveLength(4);
  });

  it("the far rectangle is the comp frame as the CAMERA sees it", () => {
    // At the focus distance the cone's cross-section must be the comp box
    // scaled by d/focalLength — the same pinhole relation projectPoint uses.
    // This is the whole value of the cone: from a Top view you read exactly
    // what the camera can see.
    const g = buildCameraGizmo({ ...base, focusDistance: 2000 });
    const f = kinds(g.segments, 'frustum');
    const corners = f.filter((s) => len(s.start, base.position) > 1e-6);
    const xs = corners.flatMap((s) => [s.start.x, s.end.x]);
    const ys = corners.flatMap((s) => [s.start.y, s.end.y]);
    const k = 2000 / 1000;
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(W * k, 3);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(H * k, 3);
  });

  it('the cone follows the camera when it is rotated', () => {
    const straight = buildCameraGizmo(base);
    const turned = buildCameraGizmo({ ...base, orientation: { yaw: 90, pitch: 0 } });
    const far = (g: ReturnType<typeof buildCameraGizmo>) =>
      kinds(g.segments, 'frustum').find((s) => len(s.start, base.position) < 1e-6)!.end;
    // Looking down +z vs down +x: the far corner's dominant axis must swap.
    expect(Math.abs(far(straight).z - base.position.z)).toBeGreaterThan(500);
    expect(Math.abs(far(turned).x - base.position.x)).toBeGreaterThan(500);
  });

  it('a two-node camera gets a POI crosshair and a connecting line', () => {
    const poi = { x: 100, y: 200, z: 300 };
    const g = buildCameraGizmo({ ...base, poi });
    const p = kinds(g.segments, 'poi');
    expect(p.length).toBeGreaterThan(1);
    // One of them runs eye → POI.
    expect(p.some((s) => len(s.start, base.position) < 1e-6 && len(s.end, poi) < 1e-6)).toBe(true);
  });

  it('a one-node camera has no POI geometry', () => {
    expect(kinds(buildCameraGizmo(base).segments, 'poi')).toHaveLength(0);
  });
});

describe('buildLightGizmo', () => {
  const base = {
    nodeId: 'L',
    position: { x: 500, y: 500, z: 0 },
    radius: 400,
    cone: 60,
    coneFeatherPct: 50,
    angleDeg: 0,
    compWidth: W,
    selected: false,
  };

  it('a point light shows a wireframe sphere at its falloff radius', () => {
    const g = buildLightGizmo({ ...base, type: 'point' });
    const r = kinds(g.segments, 'radius');
    expect(r.length).toBeGreaterThan(0);
    // Every ring vertex sits on the radius sphere.
    for (const s of r) expect(len(s.start, base.position)).toBeCloseTo(400, 3);
  });

  it('a spot light shows a cone that opens at its cone ANGLE', () => {
    const g = buildLightGizmo({ ...base, type: 'spot', cone: 60, coneFeatherPct: 0 });
    const cone = kinds(g.segments, 'cone');
    expect(cone.length).toBeGreaterThan(0);
    // An edge ray leaves the apex at half the cone angle off the axis.
    const edge = cone.find((s) => len(s.start, base.position) < 1e-6)!;
    const d = { x: edge.end.x - base.position.x, y: edge.end.y - base.position.y, z: edge.end.z - base.position.z };
    const axis = { x: 1, y: 0, z: 0 }; // angleDeg 0 ⇒ aims along +x
    const cos = (d.x * axis.x + d.y * axis.y + d.z * axis.z) / Math.hypot(d.x, d.y, d.z);
    expect((Math.acos(cos) * 180) / Math.PI).toBeCloseTo(30, 1);
  });

  it('the feather cone opens WIDER than the hard cone, by a percent of it', () => {
    const g = buildLightGizmo({ ...base, type: 'spot', cone: 60, coneFeatherPct: 50 });
    const outer = (kind: string) =>
      Math.max(...kinds(g.segments, kind).map((s) => len(s.end, base.position)));
    expect(outer('feather')).toBeGreaterThan(outer('cone'));
    // Zero feather draws no feather ring at all.
    expect(kinds(buildLightGizmo({ ...base, type: 'spot', coneFeatherPct: 0 }).segments, 'feather')).toHaveLength(0);
  });

  it('a POI aims the spot in 3D — something `angle` alone can never do', () => {
    // Measure the cone's AXIS, not an edge ray: the cone spreads in both
    // directions perpendicular to the axis, so individual edge rays leave the
    // comp plane even when the axis lies in it. The ring is symmetric about the
    // axis, so the centroid of its points IS the axis endpoint.
    const axisEnd = (g: ReturnType<typeof buildLightGizmo>): Vec3 => {
      const ring = kinds(g.segments, 'cone').filter((s) => len(s.start, base.position) > 1e-6);
      const n = ring.length;
      return {
        x: ring.reduce((a, s) => a + s.start.x, 0) / n,
        y: ring.reduce((a, s) => a + s.start.y, 0) / n,
        z: ring.reduce((a, s) => a + s.start.z, 0) / n,
      };
    };
    const flat = axisEnd(buildLightGizmo({ ...base, type: 'spot' }));
    const aimed = axisEnd(buildLightGizmo({ ...base, type: 'spot', poi: { x: 500, y: 500, z: 900 } }));
    // The 2D-angle cone can only ever point within the comp plane…
    expect(Math.abs(flat.z - base.position.z)).toBeLessThan(1e-6);
    expect(flat.x - base.position.x).toBeCloseTo(400, 0); // …straight along +x
    // …while a target aims it into depth, which is the entire point.
    expect(aimed.z - base.position.z).toBeCloseTo(400, 0);
  });

  it('an ambient light is an icon only — no cone, radius or direction', () => {
    const g = buildLightGizmo({ ...base, type: 'ambient' });
    for (const k of ['cone', 'radius', 'direction', 'feather']) expect(kinds(g.segments, k)).toHaveLength(0);
    expect(g.segments.length).toBeGreaterThan(0); // …but still findable
  });

  it('a parallel light shows direction rays', () => {
    const g = buildLightGizmo({ ...base, type: 'parallel' });
    expect(kinds(g.segments, 'direction').length).toBeGreaterThan(0);
    expect(kinds(g.segments, 'radius')).toHaveLength(0);
  });

  it('every light type produces finite geometry at degenerate settings', () => {
    for (const type of ['point', 'ambient', 'spot', 'parallel'] as const) {
      const g = buildLightGizmo({ ...base, type, radius: 0, cone: 0, coneFeatherPct: 0 });
      for (const s of g.segments) {
        for (const v of [s.start, s.end]) {
          expect(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)).toBe(true);
        }
      }
    }
  });
});

describe('buildLayerBoxGizmo', () => {
  const bounds = { x: -100, y: -50, width: 200, height: 100 };
  const flat = Matrix4Math.compose({
    position: { x: 500, y: 400, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    anchor: { x: 0, y: 0, z: 0 },
  });

  it('a flat layer gets the 4 edges of its plane', () => {
    const g = buildLayerBoxGizmo({ nodeId: 'n', world: flat, bounds, extrusionDepth: 0, selected: false });
    expect(g.segments).toHaveLength(4);
    for (const s of g.segments) expect(s.start.z).toBeCloseTo(0, 9);
  });

  it('an extruded layer gets all 12 edges of the body', () => {
    const g = buildLayerBoxGizmo({ nodeId: 'n', world: flat, bounds, extrusionDepth: 60, selected: false });
    expect(g.segments).toHaveLength(12);
    const zs = g.segments.flatMap((s) => [s.start.z, s.end.z]);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(60, 6);
  });

  it('stays findable EDGE-ON, which is the whole reason it exists', () => {
    // A Classic-3D layer is a plane of zero thickness: seen exactly from the
    // side it projects to zero area and draws no pixels — correct, and what AE
    // does too. The box collapses to a hairline in that view as well, but a
    // hairline is a thing you can see; nothing is not.
    const g = buildLayerBoxGizmo({ nodeId: 'n', world: flat, bounds, extrusionDepth: 0, selected: false });
    const pts = g.segments.flatMap((s) => [s.start, s.end]).map((p) => Project3D.projectOrtho(p, 'left', W, H));
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0, 6); // edge-on ⇒ a line
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(100, 6); // …of real length
  });

  it('tracks the layer through rotation', () => {
    const turned = Matrix4Math.compose({
      position: { x: 500, y: 400, z: 0 },
      rotation: { x: 0, y: Math.PI / 2, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      anchor: { x: 0, y: 0, z: 0 },
    });
    const g = buildLayerBoxGizmo({ nodeId: 'n', world: turned, bounds, extrusionDepth: 0, selected: false });
    const zs = g.segments.flatMap((s) => [s.start.z, s.end.z]);
    // Rotated 90° about Y, the layer's width now runs in Z.
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(200, 6);
  });
});
