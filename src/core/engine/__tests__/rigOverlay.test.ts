/**
 * The rig in the overlay geometry push and `getRigPose` (B4 round 5,
 * ENGINE_API.md §15.14) — the TypeScript engine's side (rigOverlay.ts). The
 * C++ twin (scene/rig_overlay.cpp) pins the SAME case with the same numbers in
 * native/engine/tests/test_b4_round5_rig.cpp.
 */

import type { OverlayRig } from '@motion/engine-api';
import { setupEngine, sec, type Harness } from '../__testHelpers__/harness';
import { overlayGeometryAt } from '../overlayGeometry';

jest.useFakeTimers();

const PUPPET = {
  pins: [
    { id: 'pin_1', x: -30, y: 0 },
    { id: 'pin_2', x: 30, y: 0 },
  ],
  meshDensity: 6,
};
const SKELETON = {
  bones: [
    { id: 'b1', parentId: null, length: 40, x: -40, y: 0, rotation: 0 },
    { id: 'b2', parentId: 'b1', length: 40, x: 40, y: 0, rotation: 0 },
  ],
  ikTargets: [{ boneId: 'b2', x: 20, y: 30, chainLength: 2 }],
};

let h: Harness;
let layer: string;
beforeEach(async () => {
  h = await setupEngine();
  ({ layer } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name: 'R', init: [] }));
  await h.run({ type: 'setProperty', prop: { layer, path: 'layer/puppet' }, value: { kind: 'json', value: JSON.stringify(PUPPET) } });
  await h.run({ type: 'setProperty', prop: { layer, path: 'layer/skeleton' }, value: { kind: 'json', value: JSON.stringify(SKELETON) } });
  await h.run({
    type: 'addKeyframes',
    keys: [
      { prop: { layer, path: 'puppet/pins/pin_2/position' }, time: 0, value: { kind: 'vec2', value: { x: 30, y: 0 } }, spatialIn: [], spatialOut: [] },
      { prop: { layer, path: 'puppet/pins/pin_2/position' }, time: sec(1), value: { kind: 'vec2', value: { x: 50, y: 20 } }, spatialIn: [], spatialOut: [] },
    ],
  });
});
afterEach(async () => {
  await h.run({ type: 'setOverlayGeometry', viewport: 7, layers: [], kinds: [], groups: [], views: [] });
  await h.dispose();
});

async function rigAt(seconds: number, rig = { pin: 'pin_2', bone: 'b2', authoring: false }): Promise<OverlayRig | undefined> {
  await h.run({ type: 'setOverlayGeometry', viewport: 7, layers: [layer], kinds: ['rig'], groups: [], views: [], rig });
  return overlayGeometryAt(7, seconds).find((g) => g.layer === layer)?.rig;
}

test('the rig record: live pins, solved bones, IK goals, the mesh, focus weights and pin path', async () => {
  const r = (await rigAt(0.5))!;
  expect(r).toBeDefined();
  expect(r.pins.map((p) => [p.id, p.kind])).toEqual([['pin_1', 'advanced'], ['pin_2', 'advanced']]);
  // pin_2 halfway along its keys, before the skeleton: (40, 10).
  expect(r.pins[1]!.cx).toBeCloseTo(40, 6);
  expect(r.pins[1]!.cy).toBeCloseTo(10, 6);
  expect(r.bones.map((b) => b.id)).toEqual(['b1', 'b2']);
  // IK moved the chain: the solved rotation differs from the live (stored) one.
  expect(r.bones[0]!.rotation).toBe(0);
  expect(Math.abs(r.bones[0]!.posedRotation)).toBeGreaterThan(1e-3);
  expect(r.bones[0]!.world).toHaveLength(6);
  expect(r.ik).toEqual([{ bone: 'b2', enabled: true, x: 20, y: 30, pole: [], chainLength: 2, mode: 'ik' }]);
  expect(r.vertices.length).toBe(r.rest.length);
  expect(r.rest.length % 2).toBe(0);
  expect(r.triangles.length % 3).toBe(0);
  expect(r.edges.length % 2).toBe(0);
  expect(r.edges.length).toBeGreaterThan(0);
  expect(r.weights).toHaveLength(r.rest.length / 2);
  expect(r.pinPath).toHaveLength(2 * 25);
  expect(r.pinKeys).toHaveLength(2 * 9);
  expect(r.pinKeys[1]).toBeCloseTo(30, 6);
  expect(r.pinKeys[10]).toBeCloseTo(50, 6);
  // Cross-engine numbers (tests/test_b4_round5_rig.cpp).
  expect(r.rest.length / 2).toBe(RIG_VERTICES);
  expect(r.triangles.length).toBe(RIG_TRIANGLE_INDICES);
  expect(r.edges.length).toBe(RIG_EDGE_INDICES);
  expect(r.bones[1]!.posedRotation).toBeCloseTo(B2_POSED, 6);
  expect(r.pinKeys[3]).toBeCloseTo(KEY0_X, 4);
  expect(r.pinKeys[7]).toBeCloseTo(KEY0_OUT_X, 4);
  expect(r.bones[0]!.posedRotation).toBeCloseTo(B1_POSED, 6);
  expect(r.pins[1]!.x).toBeCloseTo(PIN2_X, 4);
  expect(r.pins[1]!.y).toBeCloseTo(PIN2_Y, 4);
});

test('no focus: no weights or pin path; no rig kind: no record', async () => {
  const r = (await rigAt(0.5, { pin: '', bone: '', authoring: false }))!;
  expect(r.weights).toEqual([]);
  expect(r.pinPath).toEqual([]);
  expect(r.pinKeys).toEqual([]);
  await h.run({ type: 'setOverlayGeometry', viewport: 7, layers: [layer], kinds: ['transform'], groups: [], views: [] });
  expect(overlayGeometryAt(7, 0.5)[0]!.rig).toBeUndefined();
});

test('getRigPose: a drawn point maps back through the pose; a vertex names its bind weights', async () => {
  const r = (await rigAt(0.5))!;
  const pin = r.pins[1]!;
  const pose = await h.query({ type: 'getRigPose', layer, time: sec(0.5), points: [{ x: pin.x, y: pin.y }], vertex: 0 });
  expect(pose.bones).toEqual(r.bones);
  expect(pose.ik).toEqual(r.ik);
  // Unskinning the drawn pin gives its pre-skeleton point back.
  expect(pose.rest[0]!.x).toBeCloseTo(pin.cx, 1);
  expect(pose.rest[0]!.y).toBeCloseTo(pin.cy, 1);
  expect(pose.anchors).toHaveLength(1);
  expect(pose.vertexCount).toBe(r.rest.length / 2);
  const total = pose.weights.reduce((s, w) => s + w.weight, 0);
  expect(total).toBeGreaterThan(0);
  expect(total).toBeLessThanOrEqual(1 + 1e-9);
  for (let i = 1; i < pose.weights.length; i++) expect(pose.weights[i - 1]!.weight).toBeGreaterThanOrEqual(pose.weights[i]!.weight);
  await expect(h.query({ type: 'getRigPose', layer: 'nope', time: 0, points: [] })).rejects.toMatchObject({ code: 'notFound' });
});

test('authoring: a layer with no rig still gets the Puppet tool\'s mesh', async () => {
  const { layer: bare } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name: 'bare', init: [] });
  await h.run({ type: 'setOverlayGeometry', viewport: 7, layers: [bare], kinds: ['rig'], groups: [], views: [], rig: { pin: '', bone: '', authoring: false } });
  expect(overlayGeometryAt(7, 0)[0]!.rig).toBeUndefined();
  await h.run({ type: 'setOverlayGeometry', viewport: 7, layers: [bare], kinds: ['rig'], groups: [], views: [], rig: { pin: '', bone: '', authoring: true } });
  const r = overlayGeometryAt(7, 0)[0]!.rig!;
  expect(r.pins).toEqual([]);
  expect(r.bones).toEqual([]);
  expect(r.rest.length).toBeGreaterThan(0);
  expect(r.vertices).toEqual(r.rest);
  expect(r.edges.length).toBeGreaterThan(0);
});

// Cross-engine numbers: the C++ engine answers the same document with these.
const RIG_VERTICES = 49;
const RIG_TRIANGLE_INDICES = 216;
const RIG_EDGE_INDICES = 168;
const B1_POSED = -0.11257736117490785;
const B2_POSED = 1.1524499403514277;
const PIN2_X = 16.54445209026038;
const PIN2_Y = 29.034143940688796;
const KEY0_X = 18.54620209937986;
const KEY0_OUT_X = 17.208550881897814;
