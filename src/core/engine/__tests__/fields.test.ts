/**
 * G1: the static FIELD properties (fields.ts), optional animator properties
 * (addProperties / removeProperties), Path Options ▸ Path, the unified font
 * axes, Blur Y, the layer fill colour, style runs and the comp motion-blur
 * switch — semantics on the TypeScript engine. The cross-engine corpus
 * (corpus.ts, "G1: …" + the generator) proves the C++ engine agrees.
 */

import { defaultAnimation } from '@motion/animation';
import type { Value } from '@motion/engine-api';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readAnimatorData } from '@core/text/textAnimators';
import { readTextPathConfig } from '@core/text/textPath';
import { useMotionBlurStore } from '@stores/motionBlurStore';
import { setupEngine, sec, docDiff, type Harness } from '../__testHelpers__/harness';

jest.useFakeTimers();

let h: Harness;
beforeEach(async () => { h = await setupEngine(); });
afterEach(async () => { await h.dispose(); });

const comp = 'comp_root';
const P = (layer: string, path: string) => ({ layer, path });
const choice = (value: string): Value => ({ kind: 'choice', value });
const textProps = (id: string): Record<string, unknown> =>
  defaultSceneGraph.getNode(id)!.components.find((c) => c.type === 'Text')!.props as Record<string, unknown>;
const value = async (layer: string, path: string): Promise<Value> =>
  (await h.query({ type: 'getPropertyValues', props: [P(layer, path)], time: 0, evaluated: false })).values[0]!.value;

async function textLayer(): Promise<{ t: string; a: string; sel: string }> {
  const { layer: t } = await h.run({ type: 'createLayer', comp, kind: 'text', name: 'T', init: [] });
  const { groups: [a] } = await h.run({ type: 'addPropertyGroup', layer: t, parent: 'text/animators', matchName: 'ADBE Text Animator', init: [] });
  const tree = await h.query({ type: 'getPropertyTree', layer: t, path: '', depth: 0 });
  const sel = tree.nodes.find((n) => n.path.startsWith(`${a}/selectors/`) && n.path.split('/').length === 5)!.path;
  return { t, a: a!, sel };
}

test('gap 1: Grouping Alignment is stored on the Text component, not the Transform', async () => {
  const { t } = await textLayer();
  await h.run({ type: 'setProperty', prop: P(t, 'text/groupingAlignX'), value: { kind: 'scalar', value: 25 } });
  expect(textProps(t).groupingAlignX).toBe(25);
  const transform = defaultSceneGraph.getNode(t)!.components.find((c) => c.type === 'Transform')!.props as Record<string, unknown>;
  expect(transform.groupingAlignX).toBeUndefined();
});

test('text fields: choices are checked, clear-at-default fields leave no key, strokeOrder keeps its mirror', async () => {
  const { t } = await textLayer();
  const before = h.doc();
  await h.run({ type: 'setProperty', prop: P(t, 'text/align'), value: choice('center') });
  expect(textProps(t).align).toBe('center');
  const bad = await h.engine.execute({ type: 'setProperty', prop: P(t, 'text/align'), value: choice('middle') });
  expect(!bad.ok && bad.error.code).toBe('outOfRange');
  const wrong = await h.engine.execute({ type: 'setProperty', prop: P(t, 'text/align'), value: { kind: 'string', value: 'left' } });
  expect(!wrong.ok && wrong.error.code).toBe('typeMismatch');
  const anim = await h.engine.execute({ type: 'setAnimated', prop: P(t, 'text/align'), animated: true, time: 0 });
  expect(!anim.ok && anim.error.code).toBe('notAnimatable');
  await h.run({ type: 'setProperty', prop: P(t, 'text/ligatures'), value: { kind: 'bool', value: false } });
  expect(textProps(t).ligatures).toBe(false);
  await h.run({ type: 'setProperty', prop: P(t, 'text/ligatures'), value: { kind: 'bool', value: true } });
  expect(textProps(t).ligatures).toBeUndefined();
  await h.run({ type: 'setProperty', prop: P(t, 'text/strokeOrder'), value: choice('stroke-over-fill') });
  expect(textProps(t).strokeOverFill).toBe(true);
  await h.run({ type: 'setProperty', prop: P(t, 'text/stylisticSets'), value: { kind: 'scalars', value: { values: [2, 5] } } });
  expect(textProps(t).stylisticSets).toEqual([2, 5]);
  expect(await value(t, 'text/stylisticSets')).toEqual({ kind: 'scalars', value: { values: [2, 5] } });
  for (let i = 0; i < 5; i++) await h.run({ type: 'undo' });
  // Back to the layer + animator only.
  expect(docDiff(before, h.doc())).toEqual([]);
});

test('animator and selector fields; a selector kind switches in place and drops the old kind\'s keys', async () => {
  const { t, a, sel } = await textLayer();
  await h.run({ type: 'setProperty', prop: P(t, `${a}/props/trackingType`), value: choice('before') });
  expect(readAnimatorData(defaultSceneGraph.getNode(t)!)[0]!.trackingType).toBe('before');
  await h.run({ type: 'setProperty', prop: P(t, `${a}/props/trackingType`), value: choice('after') });
  expect(readAnimatorData(defaultSceneGraph.getNode(t)!)[0]!.trackingType).toBeUndefined();
  const selId = sel.split('/')[4]!;
  await h.run({ type: 'setAnimated', prop: P(t, `${sel}/offset`), animated: true, time: 0 });
  await h.run({ type: 'setAnimated', prop: P(t, `${sel}/amount`), animated: true, time: 0 });
  expect(defaultAnimation.isAnimated(t, 'ta.0.offset')).toBe(true);
  await h.run({ type: 'setProperty', prop: P(t, `${sel}/kind`), value: choice('expression') });
  const s = readAnimatorData(defaultSceneGraph.getNode(t)!)[0]!.selectors![0]!;
  expect(s.id).toBe(selId);
  expect(s.kind).toBe('expression');
  expect(defaultAnimation.isAnimated(t, 'ta.0.offset')).toBe(false);
  expect(defaultAnimation.isAnimated(t, 'ta.0.s0.amount')).toBe(true);
  await h.run({ type: 'setProperty', prop: P(t, `${sel}/expression`), value: { kind: 'string', value: 'textIndex * 5' } });
  const units = await h.engine.execute({ type: 'setProperty', prop: P(t, `${sel}/units`), value: choice('index') });
  expect(!units.ok && units.error.code).toBe('notFound');
  await h.run({ type: 'undo' });
  await h.run({ type: 'undo' });
  expect(defaultAnimation.isAnimated(t, 'ta.0.offset')).toBe(true);
});

test('addProperties / removeProperties: AE Add ▸ Property, font axes, keys go with the property', async () => {
  const { t, a } = await textLayer();
  const before = h.doc();
  const { paths } = await h.run({ type: 'addProperties', parent: P(t, `${a}/props`), names: ['skewAxis', 'axisGRAD', 'color'] });
  expect(paths).toEqual([`${a}/props/skewAxis`, `${a}/props/axisGRAD`, `${a}/props/color`]);
  const d = readAnimatorData(defaultSceneGraph.getNode(t)!)[0]!;
  expect(d.skewAxis).toBe(0);
  expect(d.axes).toEqual({ GRAD: 0 });
  expect(typeof d.color).toBe('string');
  await h.run({ type: 'setAnimated', prop: P(t, `${a}/props/skewAxis`), animated: true, time: sec(1) });
  await h.run({ type: 'removeProperties', props: [P(t, `${a}/props/skewAxis`), P(t, `${a}/props/axisGRAD`)] });
  const after = readAnimatorData(defaultSceneGraph.getNode(t)!)[0]!;
  expect(after.skewAxis).toBeUndefined();
  expect(after.axes).toBeUndefined();
  expect(defaultAnimation.isAnimated(t, 'ta.0.skewAxis')).toBe(false);
  const fixed = await h.engine.execute({ type: 'removeProperties', props: [P(t, `${a}/props/opacity`)] });
  expect(!fixed.ok && fixed.error.code).toBe('invalidArgument');
  const z = await h.engine.execute({ type: 'addProperties', parent: P(t, `${a}/props`), names: ['anchorZ'] });
  expect(!z.ok && z.error.code).toBe('invalidArgument');
  const many = await h.engine.execute({ type: 'addProperties', parent: P(t, `${a}/props`), names: ['axisAAAA', 'axisBBBB', 'axisCCCC', 'axisDDDD', 'axisEEEE', 'axisFFFF', 'axisGGGG', 'axisHHHH', 'axisIIII'] });
  expect(!many.ok && many.error.code).toBe('outOfRange');
  for (let i = 0; i < 3; i++) await h.run({ type: 'undo' });
  expect(docDiff(before, h.doc())).toEqual([]);
});

test('Blur Y is addressable before it is stored: reads as Blur X, a write unlinks it', async () => {
  const { t, a } = await textLayer();
  await h.run({ type: 'setProperty', prop: P(t, `${a}/props/blur`), value: { kind: 'scalar', value: 7 } });
  expect(await value(t, `${a}/props/blurY`)).toEqual({ kind: 'scalar', value: 7 });
  expect(readAnimatorData(defaultSceneGraph.getNode(t)!)[0]!.blurY).toBeUndefined();
  await h.run({ type: 'setProperty', prop: P(t, `${a}/props/blurY`), value: { kind: 'scalar', value: 3 } });
  expect(readAnimatorData(defaultSceneGraph.getNode(t)!)[0]!.blurY).toBe(3);
});

test('Path Options ▸ Path attaches to a mask and detaches', async () => {
  const { t } = await textLayer();
  const { groups: [m] } = await h.run({
    type: 'addMask', layer: t, mode: 'none', inverted: false,
    path: { vertices: [0, 0, 100, 0, 100, 100], inTangents: [], outTangents: [], closed: false, featherPoints: [], vertexStates: [] },
  });
  const maskId = m!.split('/')[1]!;
  await h.run({ type: 'setProperty', prop: P(t, 'text/pathOptions/path'), value: { kind: 'string', value: maskId } });
  expect(readTextPathConfig(defaultSceneGraph.getNode(t)!)?.pathId).toBe(maskId);
  await h.run({ type: 'setProperty', prop: P(t, 'text/pathOptions/firstMargin'), value: { kind: 'scalar', value: 40 } });
  expect(readTextPathConfig(defaultSceneGraph.getNode(t)!)?.firstMargin).toBe(40);
  const nope = await h.engine.execute({ type: 'setProperty', prop: P(t, 'text/pathOptions/path'), value: { kind: 'string', value: 'mask_x' } });
  expect(!nope.ok && nope.error.code).toBe('notFound');
  await h.run({ type: 'setProperty', prop: P(t, 'text/pathOptions/path'), value: { kind: 'string', value: '' } });
  expect(readTextPathConfig(defaultSceneGraph.getNode(t)!)).toBeNull();
});

test('wght / wdth / slnt are ONE path each; a string weight reads as its number', async () => {
  const { t } = await textLayer();
  const node = defaultSceneGraph.getNode(t)!;
  const tc = node.components.find((c) => c.type === 'Text')!;
  defaultSceneGraph.writeProp(t, tc.id, 'fontWeight', '700');
  expect(await value(t, 'text/axes/wght')).toEqual({ kind: 'scalar', value: 700 });
  await h.run({ type: 'setProperty', prop: P(t, 'text/axes/wght'), value: { kind: 'scalar', value: 550 } });
  expect(textProps(t).fontWeight).toBe(550);
  await h.run({ type: 'setAnimated', prop: P(t, 'text/axes/wdth'), animated: true, time: 0 });
  expect(defaultAnimation.isAnimated(t, 'fontWidth')).toBe(true);
  const tree = await h.query({ type: 'getPropertyTree', layer: t, path: 'text', depth: 0 });
  expect(tree.nodes.some((n) => n.path === 'text/fontWeight')).toBe(false);
});

test('layer/fill: a solid\'s colour, static and keyed', async () => {
  const { layer: s } = await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'S', init: [] });
  await h.run({ type: 'setProperty', prop: P(s, 'layer/fill'), value: { kind: 'color', value: { r: 1, g: 0, b: 0, a: 1 } } });
  expect(await value(s, 'layer/fill')).toEqual({ kind: 'color', value: { r: 1, g: 0, b: 0, a: 1 } });
  await h.run({ type: 'setAnimated', prop: P(s, 'layer/fill'), animated: true, time: 0 });
  expect(defaultAnimation.getTrackKeyframes(s, 'fill_r')?.[0]?.value).toBe(1);
  await h.run({ type: 'setProperty', prop: P(s, 'layer/fill'), value: { kind: 'color', value: { r: 0, g: 0, b: 1, a: 1 } }, time: sec(1) });
  expect(defaultAnimation.getTrackKeyframes(s, 'fill_b')?.length).toBe(2);
});

test('style runs are one json property; Source Text drops them when the text changes', async () => {
  const { t } = await textLayer();
  const runs = [{ start: 0, end: 1, style: { fontSize: 20 } }];
  await h.run({ type: 'setProperty', prop: P(t, 'text/styleRuns'), value: { kind: 'json', value: JSON.stringify(runs) } });
  expect(textProps(t).__runs).toEqual(runs);
  expect(textProps(t).__runsIndex).toBe('grapheme');
  await h.run({ type: 'setProperty', prop: P(t, 'text/sourceText'), value: { kind: 'string', value: 'Changed' } });
  expect(textProps(t).__runs).toBeUndefined();
});

test('the composition motion-blur switch is undoable', async () => {
  const on = useMotionBlurStore.getState().enabled;
  await h.run({ type: 'setCompositionSettings', comp, patch: { motionBlur: { shutterAngle: 180, shutterPhase: -90, samplesPerFrame: 8, adaptiveSampleLimit: 128, enabled: !on } } });
  expect(useMotionBlurStore.getState().enabled).toBe(!on);
  const c = await h.query({ type: 'getComposition', comp });
  expect(c.comp.settings.motionBlur.enabled).toBe(!on);
  await h.run({ type: 'undo' });
  expect(useMotionBlurStore.getState().enabled).toBe(on);
});
