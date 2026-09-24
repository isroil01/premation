/**
 * B3: expression controls as API property groups (controlProps.ts,
 * controlSpecs.ts): `effects/ctrl_<name>` with one value property, bound to
 * the stored `ctrl_<name><suffix>` numbers so keys, `ctrl('…')` and saved
 * documents are unchanged. The C++ engine's twin is
 * native/engine/tests/test_expression_controls.cpp (same contracts).
 */

import { defaultAnimation } from '@motion/animation';
import type { PropertyInfo, Value } from '@motion/engine-api';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { controlValue } from '@core/animation/expressionControls';
import { setupEngine, sec, docDiff, fakePorts, type Harness } from '../__testHelpers__/harness';
import { FAMILY_CORPUS } from '../__testHelpers__/corpus';
import { LocalEngine } from '../LocalEngine';
import { replayLog, logToJsonl, logFromJsonl } from '../replay';

jest.useFakeTimers();

let h: Harness;
beforeEach(async () => {
  h = await setupEngine();
  defaultAnimation.setControlProvider((name, t) => controlValue(name, t));
});
afterEach(async () => { await h.dispose(); });

const comp = 'comp_root';
const P = (layer: string, path: string) => ({ layer, path });
const sc = (value: number): Value => ({ kind: 'scalar', value });
const transform = (id: string): Record<string, unknown> =>
  defaultSceneGraph.getNode(id)!.components.find((c) => c.type === 'Transform')!.props as Record<string, unknown>;
const value = async (layer: string, path: string, time = 0, evaluated = false): Promise<Value> =>
  (await h.query({ type: 'getPropertyValues', props: [P(layer, path)], time, evaluated })).values[0]!.value;
const add = async (layer: string, matchName: string, name?: string): Promise<string> =>
  (await h.run({ type: 'addPropertyGroup', layer, parent: 'effects', matchName, init: [], ...(name !== undefined ? { name } : {}) })).groups[0]!;

async function solid(name = 'S'): Promise<string> {
  const { layer } = await h.run({ type: 'createLayer', comp, kind: 'solid', name, init: [] });
  return layer;
}

async function tree(layer: string): Promise<PropertyInfo[]> {
  return (await h.query({ type: 'getPropertyTree', layer, path: '', depth: 0 })).nodes;
}

test('listGroupTypes lists the seven controls under effects', async () => {
  const l = await solid();
  const { types } = await h.query({ type: 'listGroupTypes', layer: l, parent: 'effects' });
  expect(types.filter((t) => t.category === 'controls')).toEqual([
    { matchName: 'ADBE Slider Control', displayName: 'Slider Control', category: 'controls' },
    { matchName: 'ADBE Angle Control', displayName: 'Angle Control', category: 'controls' },
    { matchName: 'ADBE Point Control', displayName: 'Point Control', category: 'controls' },
    { matchName: 'ADBE Color Control', displayName: 'Color Control', category: 'controls' },
    { matchName: 'ADBE Checkbox Control', displayName: 'Checkbox Control', category: 'controls' },
    { matchName: 'ADBE Dropdown Control', displayName: 'Dropdown Menu Control', category: 'controls' },
    { matchName: 'ADBE Layer Control', displayName: 'Layer Control', category: 'controls' },
  ]);
  expect((await h.query({ type: 'listGroupTypes', layer: l, parent: 'contents' })).types.some((t) => t.category === 'controls')).toBe(false);
});

test('a slider: add, key the value, ctrl() reads it, remove, undo is exact', async () => {
  const l = await solid();
  const target = await solid('T');
  const before = h.doc();
  const g = await add(l, 'ADBE Slider Control');
  expect(g).toBe('effects/ctrl_Slider 1');
  // Stored exactly as the legacy helper stored it.
  expect(transform(l)['ctrl_Slider 1']).toBe(50);
  expect(transform(l)['ctrlkind_Slider 1']).toBe('slider');
  expect(await value(l, `${g}/slider`)).toEqual(sc(50));

  // The tree: a group under effects with the value property.
  const nodes = await tree(l);
  const grp = nodes.find((n) => n.path === g)!;
  expect(grp).toMatchObject({ name: 'Slider 1', matchName: 'ADBE Slider Control', kind: 'group', enabled: true });
  expect(grp.children).toEqual([`${g}/slider`]);
  expect(nodes.find((n) => n.path === `${g}/slider`)).toMatchObject({
    name: 'Slider', matchName: 'ADBE Slider Control-0001', valueType: 'scalar', animatable: true,
  });
  expect(nodes.find((n) => n.path === 'effects')!.children).toContain(g);

  // Keys land on the stored number's track; an expression reads it through ctrl().
  await h.run({ type: 'addKeyframes', keys: [
    { prop: P(l, `${g}/slider`), time: sec(0), value: sc(10), spatialIn: [], spatialOut: [] },
    { prop: P(l, `${g}/slider`), time: sec(1), value: sc(30), spatialIn: [], spatialOut: [] },
  ] });
  expect(defaultAnimation.getTrackKeyframes(l, 'ctrl_Slider 1')!.map((k) => k.value)).toEqual([10, 30]);
  await h.run({ type: 'setExpression', prop: P(target, 'transform/rotation'), source: "ctrl('Slider 1') * 2", enabled: true });
  expect(await value(target, 'transform/rotation', sec(0.5), true)).toEqual(sc(40));

  // Remove: the numbers, the marker and the keys go; the expression now reads 0.
  await h.run({ type: 'removePropertyGroups', groups: [P(l, g)] });
  expect(transform(l)['ctrl_Slider 1']).toBeUndefined();
  expect(transform(l)['ctrlkind_Slider 1']).toBeUndefined();
  expect(defaultAnimation.getTrackKeyframes(l, 'ctrl_Slider 1') ?? []).toEqual([]);
  expect((await tree(l)).some((n) => n.path === g)).toBe(false);
  expect(await value(target, 'transform/rotation', sec(0.5), true)).toEqual(sc(0));

  for (let i = 0; i < 4; i++) await h.run({ type: 'undo' });
  expect(docDiff(before, h.doc())).toEqual([]);
});

test('every kind: value types, members, auto names, init', async () => {
  const l = await solid();
  const point = await add(l, 'ADBE Point Control');
  const color = await add(l, 'ADBE Color Control');
  const box = await add(l, 'ADBE Checkbox Control');
  const menu = await add(l, 'ADBE Dropdown Control');
  const layerCtl = await add(l, 'ADBE Layer Control');
  const angle = await add(l, 'ADBE Angle Control');
  expect([point, color, box, menu, layerCtl, angle]).toEqual([
    'effects/ctrl_Point 1', 'effects/ctrl_Color 1', 'effects/ctrl_Checkbox 1', 'effects/ctrl_Dropdown 1', 'effects/ctrl_Layer 1', 'effects/ctrl_Angle 1',
  ]);
  expect(await value(l, `${point}/point`)).toEqual({ kind: 'vec2', value: { x: 0, y: 0 } });
  // A colour control's channels are its stored numbers (0–255, what ctrl('Color 1.r') returns).
  expect(await value(l, `${color}/color`)).toEqual({ kind: 'color', value: { r: 255, g: 255, b: 255, a: 1 } });
  expect(await value(l, `${menu}/menu`)).toEqual(sc(0));

  await h.run({ type: 'setProperty', prop: P(l, `${point}/point`), value: { kind: 'vec2', value: { x: 3, y: 4 } } });
  await h.run({ type: 'setProperty', prop: P(l, `${color}/color`), value: { kind: 'color', value: { r: 10, g: 20, b: 30, a: 1 } } });
  expect(transform(l)).toMatchObject({ 'ctrl_Point 1.x': 3, 'ctrl_Point 1.y': 4, 'ctrl_Color 1.r': 10, 'ctrl_Color 1.g': 20, 'ctrl_Color 1.b': 30 });
  expect(controlValue('Point 1.y', 0)).toBe(4);

  // Auto names are global (nextControlName); an explicit name + init.
  const other = await solid('O');
  expect(await add(other, 'ADBE Point Control')).toBe('effects/ctrl_Point 2');
  const { groups: [speed] } = await h.run({
    type: 'addPropertyGroup', layer: other, parent: 'effects', matchName: 'ADBE Slider Control', name: ' Speed ', init: [{ path: 'slider', value: sc(7) }],
  });
  expect(speed).toBe('effects/ctrl_Speed');
  expect(transform(other)['ctrl_Speed']).toBe(7);

  // Refusals change nothing.
  const snap = h.doc();
  await expect(add(other, 'ADBE Slider Control', 'Speed')).rejects.toMatchObject({ code: 'conflict' });
  await expect(add(other, 'ADBE Slider Control', 'a/b')).rejects.toMatchObject({ code: 'invalidArgument' });
  await expect(h.run({ type: 'addPropertyGroup', layer: other, parent: 'effects', matchName: 'ADBE Slider Control', index: 0, init: [] })).rejects.toMatchObject({ code: 'unsupported' });
  await expect(h.run({ type: 'setGroupEnabled', groups: [P(other, speed!)], enabled: false })).rejects.toMatchObject({ code: 'unsupported' });
  await expect(h.run({ type: 'duplicatePropertyGroups', groups: [P(other, speed!)] })).rejects.toMatchObject({ code: 'unsupported' });
  await expect(h.run({ type: 'removePropertyGroups', groups: [P(other, 'effects/ctrl_Nope')] })).rejects.toMatchObject({ code: 'notFound' });
  expect(docDiff(snap, h.doc())).toEqual([]);
});

test('rename moves the numbers, the marker, keys and expressions; undo is exact', async () => {
  const l = await solid();
  const g = await add(l, 'ADBE Point Control');
  await h.run({ type: 'addKeyframes', keys: [
    { prop: P(l, `${g}/point`), time: sec(0), value: { kind: 'vec2', value: { x: 1, y: 2 } }, spatialIn: [], spatialOut: [] },
  ] });
  await h.run({ type: 'setExpression', prop: P(l, `${g}/point`), source: '[time, time]', enabled: true });
  const before = h.doc();
  await h.run({ type: 'renamePropertyGroup', group: P(l, g), name: 'Aim' });
  const t = transform(l);
  expect(t['ctrl_Aim.x']).toBe(0);
  expect(t['ctrlkind_Aim']).toBe('point');
  expect(t['ctrl_Point 1.x']).toBeUndefined();
  expect(defaultAnimation.getTrackKeyframes(l, 'ctrl_Aim.y')!.map((k) => k.value)).toEqual([2]);
  const tree2 = await tree(l);
  expect(tree2.find((n) => n.path === 'effects/ctrl_Aim')).toMatchObject({ name: 'Aim', matchName: 'ADBE Point Control' });
  expect(tree2.find((n) => n.path === 'effects/ctrl_Aim/point')!.expression).toBe('[time, time]');
  await expect(h.run({ type: 'renamePropertyGroup', group: P(l, 'effects/ctrl_Aim'), name: '' })).rejects.toMatchObject({ code: 'invalidArgument' });
  await h.run({ type: 'undo' });
  expect(docDiff(before, h.doc())).toEqual([]);
});

test('pre-kind documents: a bare ctrl_<name> number is a slider; unkinded components are sliders', async () => {
  const l = await solid();
  const tid = defaultSceneGraph.getNode(l)!.components.find((c) => c.type === 'Transform')!.id;
  defaultSceneGraph.writeProp(l, tid, 'ctrl_Legacy', 42);
  defaultSceneGraph.writeProp(l, tid, 'ctrl_P.x', 1);
  const nodes = await tree(l);
  expect(nodes.find((n) => n.path === 'effects/ctrl_Legacy')).toMatchObject({ matchName: 'ADBE Slider Control', name: 'Legacy' });
  expect(nodes.find((n) => n.path === 'effects/ctrl_P.x')).toMatchObject({ matchName: 'ADBE Slider Control' });
  expect(await value(l, 'effects/ctrl_Legacy/slider')).toEqual(sc(42));
  // Nothing addresses the stored numbers under `layer/` any more.
  expect(nodes.some((n) => n.path.startsWith('layer/ctrl_'))).toBe(false);
});

test('the cross-engine corpus session replays byte-exact on a fresh engine', async () => {
  const name = Object.keys(FAMILY_CORPUS).find((k) => k.startsWith('B3: expression controls'))!;
  await h.dispose();
  h = await setupEngine({ hashes: true });
  await FAMILY_CORPUS[name]!(h);
  const finalDoc = h.doc();
  // The session left the renamed slider (with its keys) and removed the checkbox and 'Spin'.
  expect(finalDoc).toContain('"ctrl_Drive":{"keyframes"');
  expect(finalDoc).toContain('"ctrlkind_Point 1":"point"');
  expect(finalDoc).not.toContain('ctrl_Checkbox 1');
  expect(finalDoc).not.toContain('ctrlkind_Spin');
  const log = logFromJsonl(logToJsonl(h.engine.commandLog()));
  await h.engine.close();
  const fresh = new LocalEngine({ verifyScopes: true, wire: true, ports: fakePorts(h.files) });
  const result = await replayLog(log, fresh, { checkHashes: true });
  expect(result.mismatches).toEqual([]);
  expect(docDiff(finalDoc, h.doc())).toEqual([]);
  await fresh.close();
});
