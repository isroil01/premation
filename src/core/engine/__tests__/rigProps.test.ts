/**
 * B3z WS-R: puppet pins and skeletons as API property groups / properties
 * (rigProps.ts, ENGINE_API.md §15.9 "Rigging"). Semantics on the TypeScript
 * engine; the cross-engine corpus ("WS-R: …" sessions + the generator) proves
 * the C++ engine agrees.
 */

import { defaultAnimation } from '@motion/animation';
import type { Value } from '@motion/engine-api';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { setupEngine, sec, docDiff, type Harness } from '../__testHelpers__/harness';

jest.useFakeTimers();

let h: Harness;
beforeEach(async () => { h = await setupEngine(); });
afterEach(async () => { await h.dispose(); });

const comp = 'comp_root';
const P = (layer: string, path: string) => ({ layer, path });
const v2 = (x: number, y: number): Value => ({ kind: 'vec2', value: { x, y } });
const sc = (value: number): Value => ({ kind: 'scalar', value });
const fx = (id: string): Record<string, unknown> =>
  defaultSceneGraph.getNode(id)!.components.find((c) => c.type === 'fx')!.props as Record<string, unknown>;
const value = async (layer: string, path: string, time = 0, evaluated = false): Promise<Value> =>
  (await h.query({ type: 'getPropertyValues', props: [P(layer, path)], time, evaluated })).values[0]!.value;

async function solid(): Promise<string> {
  const { layer } = await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'S', init: [] });
  return layer;
}

test('a pin: add with init, drag = keys, rest position, undo is exact', async () => {
  const l = await solid();
  const before = h.doc();
  const { groups: [pin] } = await h.run({
    type: 'addPropertyGroup', layer: l, parent: 'puppet/pins', matchName: 'ADBE FreePin3 PosPin Atom',
    init: [{ path: 'kind', value: { kind: 'choice', value: 'starch' } }, { path: 'restPosition', value: v2(10, 20) }],
  });
  expect(pin).toBe('puppet/pins/pin_1');
  const rig = fx(l).puppet as { pins: Array<Record<string, unknown>>; meshDensity: number };
  expect(rig.pins[0]).toEqual({ id: 'pin_1', name: 'Pin 1', x: 10, y: 20, kind: 'starch', stiffness: 8 });
  expect(rig.meshDensity).toBe(22);
  expect(await value(l, `${pin}/position`)).toEqual(v2(10, 20));
  expect(await value(l, `${pin}/stiffness`)).toEqual(sc(8));

  await h.run({ type: 'addKeyframes', keys: [{ prop: P(l, `${pin}/position`), time: sec(0), value: v2(30, 40), spatialIn: [], spatialOut: [] }] });
  expect(defaultAnimation.getDataTrack(l, 'puppet.pin_1.position')!.keyframes[0]!.value).toEqual([{ x: 30, y: 40 }]);
  await h.run({ type: 'setProperty', prop: P(l, `${pin}/position`), value: v2(50, 60), time: sec(1) });
  expect(await value(l, `${pin}/position`, sec(0.5), true)).toEqual(v2(40, 50));

  // Scale speaks percent, stores a multiplier.
  await h.run({ type: 'setProperty', prop: P(l, `${pin}/scale`), value: sc(150) });
  expect((fx(l).puppet as { pins: Array<{ scale: number }> }).pins[0]!.scale).toBe(1.5);

  // Removing the pin takes its keys.
  await h.run({ type: 'removePropertyGroups', groups: [P(l, pin!)] });
  expect(defaultAnimation.getDataTrack(l, 'puppet.pin_1.position')).toBeNull();
  for (let i = 0; i < 5; i++) await h.run({ type: 'undo' });
  expect(docDiff(before, h.doc())).toEqual([]);
});

test('deleting a pin\'s last position key leaves it static there; spatial tangents round-trip', async () => {
  const l = await solid();
  const { groups: [pin] } = await h.run({ type: 'addPropertyGroup', layer: l, parent: 'puppet/pins', matchName: 'ADBE FreePin3 PosPin Atom', init: [] });
  const { ids } = await h.run({ type: 'addKeyframes', keys: [
    { prop: P(l, `${pin}/position`), time: sec(0), value: v2(1, 2), spatialIn: [], spatialOut: [5, 6] },
    { prop: P(l, `${pin}/position`), time: sec(1), value: v2(9, 9), spatialIn: [-1, -2], spatialOut: [] },
  ] });
  const kf = await h.query({ type: 'getKeyframes', props: [P(l, `${pin}/position`)] });
  expect(kf.sets[0]!.keyframes[0]!.spatialOut).toEqual([5, 6]);
  expect(kf.sets[0]!.keyframes[1]!.spatialIn).toEqual([-1, -2]);
  await h.run({ type: 'deleteKeyframes', ids: ids });
  expect((fx(l).puppet as { pins: Array<{ position: unknown }> }).pins[0]!.position).toEqual({ x: 1, y: 2 });
});

test('bones: subtree delete, rotation in degrees, static pose captures the bind pose, cycles refused', async () => {
  const l = await solid();
  const before = h.doc();
  const { groups: [b1] } = await h.run({ type: 'addPropertyGroup', layer: l, parent: 'skeleton/bones', matchName: 'Premation Bone',
    init: [{ path: 'length', value: sc(50) }, { path: 'rotation', value: sc(90) }] });
  const { groups: [b2] } = await h.run({ type: 'addPropertyGroup', layer: l, parent: 'skeleton/bones', matchName: 'Premation Bone',
    init: [{ path: 'parent', value: { kind: 'string', value: 'bone_1' } }] });
  const skel = () => fx(l).skeleton as { bones: Array<Record<string, unknown>>; bindPose?: unknown[]; ikTargets: unknown[] };
  expect(skel().bindPose).toBeUndefined();
  expect(skel().bones[0]!.rotation).toBeCloseTo(Math.PI / 2);
  // A static pose write pins the bind pose first.
  await h.run({ type: 'setProperty', prop: P(l, `${b1}/rotation`), value: sc(45) });
  expect(skel().bindPose).toHaveLength(2);
  expect((skel().bindPose![0] as { rotation: number }).rotation).toBeCloseTo(Math.PI / 2);
  expect(await value(l, `${b1}/restRotation`)).toEqual(sc(90));
  const cyc = await h.engine.execute({ type: 'setProperty', prop: P(l, `${b1}/parent`), value: { kind: 'string', value: 'bone_2' } });
  expect(!cyc.ok && cyc.error.code).toBe('cycle');

  // IK goal + optional pole, keys, then the root bone's delete takes the subtree.
  await h.run({ type: 'addPropertyGroup', layer: l, parent: b2!, matchName: 'Premation IK Goal', init: [{ path: 'target', value: v2(5, 5) }] });
  await h.run({ type: 'addProperties', parent: P(l, `${b2}/ik`), names: ['pole'] });
  await h.run({ type: 'setAnimated', prop: P(l, `${b2}/ik/target`), animated: true, time: 0 });
  await h.run({ type: 'removeProperties', props: [P(l, `${b2}/ik/pole`)] });
  await h.run({ type: 'removePropertyGroups', groups: [P(l, b1!)] });
  expect(skel().bones).toEqual([]);
  expect(skel().ikTargets).toEqual([]);
  expect(defaultAnimation.getTrackKeyframes(l, 'ikTarget.bone_2.x')).toBeNull();
  for (let i = 0; i < 8; i++) await h.run({ type: 'undo' });
  expect(docDiff(before, h.doc())).toEqual([]);
});

test('the property tree lists the rig groups', async () => {
  const l = await solid();
  await h.run({ type: 'addPropertyGroup', layer: l, parent: '', matchName: 'ADBE FreePin3', init: [] });
  await h.run({ type: 'addPropertyGroup', layer: l, parent: 'puppet/pins', matchName: 'ADBE FreePin3 PosPin Atom', name: 'Hand', init: [] });
  const tree = await h.query({ type: 'getPropertyTree', layer: l, path: '', depth: 0 });
  const paths = tree.nodes.map((n) => n.path);
  expect(paths).toEqual(expect.arrayContaining(['puppet', 'puppet/mesh/density', 'puppet/pins/pin_1', 'puppet/pins/pin_1/position']));
  expect(tree.nodes.find((n) => n.path === 'puppet/pins/pin_1')!.name).toBe('Hand');
  const dup = await h.engine.execute({ type: 'addPropertyGroup', layer: l, parent: '', matchName: 'ADBE FreePin3', init: [] });
  expect(!dup.ok && dup.error.code).toBe('conflict');
});
