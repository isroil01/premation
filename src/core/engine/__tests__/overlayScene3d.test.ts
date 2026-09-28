/**
 * B4 round 5, slice B (ENGINE_API.md §15.14): the view half of the overlay
 * geometry push on the TypeScript engine — setOverlayGeometry `views` (the
 * resolved view camera per mode), `groups` (per-overlay kinds) and the
 * `scene3d` kind. native/engine/tests/test_b4_round5_view.cpp pins the same
 * cases on the C++ engine.
 */

import { Project3D } from '@motion/scene';
import { setupEngine, type Harness } from '../__testHelpers__/harness';
import { overlayGeometryAt, overlayViewsAt } from '../overlayGeometry';

jest.useFakeTimers();

const SEC = 705_600_000;
let h: Harness;
beforeEach(async () => {
  h = await setupEngine();
});
afterEach(async () => {
  await h.run({ type: 'setOverlayGeometry', viewport: 7, layers: [], kinds: [], groups: [], views: [] });
  await h.dispose();
});

async function layer(kind: 'camera' | 'light' | 'solid'): Promise<string> {
  return (await h.run({ type: 'createLayer', comp: 'comp_root', kind, name: kind, init: [] })).layer;
}

const focal = Project3D.defaultCamera(1920, 1080).focalLength;

test('each subscribed view mode carries its resolved view camera', async () => {
  const cam1 = await layer('camera');
  const cam2 = await layer('camera');
  await h.run({ type: 'setProperty', prop: { layer: cam1, path: 'transform/position' }, value: { kind: 'vec3', value: { x: 100, y: 200, z: -1500 } } });
  await h.run({ type: 'setOverlayGeometry', viewport: 7, layers: [], kinds: [], groups: [], views: ['active', `camera:${cam1}`, 'top', 'camera:nope'] });
  const views = new Map(overlayViewsAt(7, 0).map((v) => [v.mode, v]));
  expect(views.size).toBe(4);
  const named = views.get(`camera:${cam1}`)!;
  expect(named.camera).toBe(cam1);
  expect(named.liveCamera).toBe(cam1);
  expect(named.lens).toHaveLength(9);
  expect(named.lens[0]).toBeCloseTo(100, 6);
  expect(named.lens[1]).toBeCloseTo(200, 6);
  expect(named.lens[2]).toBeCloseTo(-1500, 6);
  expect(named.lens[3]).toBeCloseTo(focal, 6);
  expect(named.lens[4]).toBeCloseTo(960, 6);
  expect(named.compWidth).toBe(1920);
  // The topmost camera (created last) for Active Camera, the axis views and a stale camera view.
  expect(views.get('active')!.camera).toBe(cam2);
  expect(views.get('active')!.lens[2]).toBeCloseTo(-focal, 6);
  expect(views.get('top')!.camera).toBe(cam2);
  expect(views.get('camera:nope')!.camera).toBe(cam2);
  await h.run({ type: 'deleteLayers', layers: [cam1, cam2] });
  const def = overlayViewsAt(7, 0)[0]!;
  expect(def.camera).toBe('');
  expect(def.liveCamera).toBe('');
  expect(def.lens[2]).toBeCloseTo(-focal, 6);
});

test("the camera tools' camera must be live at the frame", async () => {
  const cam1 = await layer('camera');
  const cam2 = await layer('camera');
  await h.run({ type: 'setLayerTiming', items: [{ layer: cam2, inPoint: 2 * SEC }] });
  await h.run({ type: 'setOverlayGeometry', viewport: 7, layers: [], kinds: [], groups: [], views: ['active'] });
  const early = overlayViewsAt(7, 0)[0]!;
  expect(early.camera).toBe(cam2);
  expect(early.liveCamera).toBe(cam1);
  expect(overlayViewsAt(7, 3)[0]!.liveCamera).toBe(cam2);
});

test('scene3d: cameras, lights and 3D layers; groups keep each overlay’s kinds', async () => {
  const cam = await layer('camera');
  const light = await layer('light');
  const flat = await layer('solid');
  const deep = await layer('solid');
  await h.run({ type: 'setLayerSwitches', layers: [deep], patch: { threeD: true } });
  await h.run({
    type: 'setOverlayGeometry', viewport: 7, layers: [], kinds: [], views: [],
    groups: [{ layers: [cam, light, flat, deep], kinds: ['scene3d'] }, { layers: [deep], kinds: ['transform'] }],
  });
  const recs = new Map(overlayGeometryAt(7, 0).map((g) => [g.layer, g]));
  const c = recs.get(cam)!;
  expect(c.scene?.role).toBe('camera');
  expect(c.scene!.lens).toHaveLength(9);
  expect(c.scene!.lens[2]).toBeCloseTo(-focal, 6);
  expect(c.scene!.poi).toEqual([]);
  expect(c.scene!.focusDistance).toBeCloseTo(focal, 6);
  expect(c.scene!.dof).toEqual([]);
  // A top-level layer's parent is its composition root: the identity.
  expect(c.scene!.parent).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  expect(c.matrix).toEqual([]);

  const l = recs.get(light)!;
  expect(l.scene?.role).toBe('light');
  expect(l.scene!.lightType).toBe('point');
  expect(l.scene!.position[2]).toBeCloseTo(-444, 6);
  expect(l.scene!.light[0]).toBeCloseTo(864, 6);

  expect(recs.get(flat)!.scene).toBeUndefined();
  const d = recs.get(deep)!;
  expect(d.scene?.role).toBe('layer');
  expect(d.scene!.local).toHaveLength(9);
  expect(d.scene!.local[6]).toBeCloseTo(1, 6);
  expect(d.scene!.local[8]).toBeCloseTo(1, 6);
  expect(d.scene!.extrusion).toBe(0);
  expect(d.matrix).toHaveLength(16);
});
