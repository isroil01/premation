/**
 * B3z-a (effects): the model additions the Effects panel needed, on the
 * TypeScript engine — Compositing Options (Effect Opacity on every effect,
 * Effect Mask, the label colour), `pasteEffects` (a captured snapshot),
 * Feather / Opacity / Expansion holding across keyed mask shapes, per-vertex
 * mask feather (`BezierPath.featherPoints`), Glass as a first-class style and
 * the layer-style switches. The cross-engine corpus ("B3z-a: effects …" + the
 * generator) proves the C++ engine agrees.
 */

import { defaultAnimation } from '@motion/animation';
import type { Value } from '@motion/engine-api';
import { getNodeEffects } from '@core/effects/effects';
import { getNodeLayerStyles } from '@core/effects/layerStyles';
import { readNodeMask, readNodeMaskAnim } from '@core/effects/mask';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { setupEngine, sec, type Harness } from '../__testHelpers__/harness';

jest.useFakeTimers();

let h: Harness;
beforeEach(async () => { h = await setupEngine(); });
afterEach(async () => { await h.dispose(); });

const comp = 'comp_root';
const P = (layer: string, path: string) => ({ layer, path });
const scalar = (value: number): Value => ({ kind: 'scalar', value });
const str = (value: string): Value => ({ kind: 'string', value });
const square = [0, 0, 100, 0, 100, 100, 0, 100];
const pathV = (vertices: number[], featherPoints: Array<{ segment: number; t: number; radius: number; tension: number }> = []): Value =>
  ({ kind: 'path', value: { vertices, inTangents: [], outTangents: [], closed: true, featherPoints } });
const value = async (layer: string, path: string, time = 0): Promise<Value> =>
  (await h.query({ type: 'getPropertyValues', props: [P(layer, path)], time, evaluated: false })).values[0]!.value;
const code = async (cmd: Parameters<Harness['engine']['execute']>[0]): Promise<string | undefined> => {
  const r = await h.engine.execute(cmd);
  return r.ok ? undefined : r.error.code;
};

async function layerWithEffect(): Promise<{ A: string; fx: string; id: string }> {
  const { layer: A } = await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'A', init: [] });
  const { groups: [fx] } = await h.run({ type: 'addEffect', layers: [A], effect: 'gaussian-blur', params: [] });
  return { A, fx: fx!, id: fx!.split('/')[1]! };
}

test('Effect Opacity is listed on every effect and its static value is Effect.opacity (cleared at >= 100)', async () => {
  const { A, fx, id } = await layerWithEffect();
  const tree = await h.query({ type: 'getPropertyTree', layer: A, path: fx, depth: 0 });
  const paths = tree.nodes.map((n) => n.path);
  expect(paths).toEqual(expect.arrayContaining([`${fx}/compositing`, `${fx}/compositing/opacity`, `${fx}/compositing/mask`, `${fx}/compositing/label`]));
  expect(await value(A, `${fx}/compositing/opacity`)).toEqual(scalar(100));
  const before = h.doc();
  await h.run({ type: 'setProperty', prop: P(A, `${fx}/compositing/opacity`), value: scalar(40) });
  const e = getNodeEffects(A).find((x) => x.id === id)!;
  expect(e.opacity).toBe(40);
  expect((e.params as Record<string, unknown>)['fx.opacity']).toBeUndefined();
  await h.run({ type: 'setProperty', prop: P(A, `${fx}/compositing/opacity`), value: scalar(100) });
  expect('opacity' in getNodeEffects(A).find((x) => x.id === id)!).toBe(false);
  await h.run({ type: 'undo' });
  await h.run({ type: 'undo' });
  expect(h.doc()).toBe(before);
});

test('Effect Opacity stopwatch keys effect.<id>.fx.opacity; off leaves the value at the time as the static one', async () => {
  const { A, fx, id } = await layerWithEffect();
  const track = `effect.${id}.fx.opacity`;
  await h.run({ type: 'setProperty', prop: P(A, `${fx}/compositing/opacity`), value: scalar(30) });
  await h.run({ type: 'setAnimated', prop: P(A, `${fx}/compositing/opacity`), animated: true, time: 0 });
  expect(defaultAnimation.getTrackKeyframes(A, track)?.map((k) => k.value)).toEqual([30]);
  await h.run({ type: 'setProperty', prop: P(A, `${fx}/compositing/opacity`), value: scalar(70), time: sec(1) });
  await h.run({ type: 'setAnimated', prop: P(A, `${fx}/compositing/opacity`), animated: false, time: sec(1) });
  expect(defaultAnimation.isAnimated(A, track)).toBe(false);
  expect(getNodeEffects(A).find((x) => x.id === id)!.opacity).toBe(70);
});

test('Effect Mask names one of the layer masks or none; the label colour is a #rrggbb or none', async () => {
  const { A, fx, id } = await layerWithEffect();
  const { groups: [m] } = await h.run({ type: 'addMask', layer: A, path: (pathV(square) as { value: never }).value, mode: 'none', inverted: false });
  const mid = m!.split('/')[1]!;
  await h.run({ type: 'setProperty', prop: P(A, `${fx}/compositing/mask`), value: str(mid) });
  expect(getNodeEffects(A).find((x) => x.id === id)!.maskId).toBe(mid);
  expect(await code({ type: 'setProperty', prop: P(A, `${fx}/compositing/mask`), value: str('mask_ghost') })).toBe('notFound');
  expect(await code({ type: 'setAnimated', prop: P(A, `${fx}/compositing/mask`), animated: true, time: 0 })).toBe('notAnimatable');
  await h.run({ type: 'setProperty', prop: P(A, `${fx}/compositing/mask`), value: str('') });
  expect('maskId' in getNodeEffects(A).find((x) => x.id === id)!).toBe(false);
  await h.run({ type: 'setProperty', prop: P(A, `${fx}/compositing/label`), value: str('#5282b8') });
  expect(getNodeEffects(A).find((x) => x.id === id)!.labelColor).toBe('#5282b8');
  expect(await value(A, `${fx}/compositing/label`)).toEqual(str('#5282b8'));
  expect(await code({ type: 'setProperty', prop: P(A, `${fx}/compositing/label`), value: str('red') })).toBe('invalidArgument');
  await h.run({ type: 'setProperty', prop: P(A, `${fx}/compositing/label`), value: str('') });
  expect('labelColor' in getNodeEffects(A).find((x) => x.id === id)!).toBe(false);
});

test('pasteEffects: a captured snapshot onto several layers at an index — fresh ids, keys at their captured times, one undo', async () => {
  const { A } = await layerWithEffect();
  const { layer: B } = await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'B', init: [] });
  const before = h.doc();
  const effects = JSON.stringify([{
    effect: { id: 'fx_src', type: 'gaussian-blur', params: { blurriness: 12 }, enabled: false, opacity: 50, labelColor: '#4ea885' },
    tracks: { blurriness: [{ t: 1, value: 30, id: 'k99' }, { t: 0, value: 10 }] },
  }]);
  const res = await h.run({ type: 'pasteEffects', layers: [A, B], effects, index: 0 });
  expect(res.groups).toHaveLength(2);
  const [ga, gb] = res.groups.map((g) => g.split('/')[1]!);
  expect(ga).not.toBe('fx_src');
  expect(getNodeEffects(A)[0]).toMatchObject({ id: ga, type: 'gaussian-blur', enabled: false, opacity: 50, labelColor: '#4ea885' });
  expect(getNodeEffects(A)).toHaveLength(2);
  const keys = defaultAnimation.getTrackKeyframes(B, `effect.${gb}.blurriness`)!;
  expect(keys.map((k) => [k.t, k.value])).toEqual([[0, 10], [1, 30]]);
  expect(keys.every((k) => typeof k.id === 'string' && k.id !== 'k99')).toBe(true);
  expect(await code({ type: 'pasteEffects', layers: [A], effects: '[]' })).toBe('invalidArgument');
  expect(await code({ type: 'pasteEffects', layers: [A], effects, index: 9 })).toBe('outOfRange');
  await h.run({ type: 'undo' });
  expect(h.doc()).toBe(before);
});

test('Feather / Opacity / Expansion on a keyed-shape mask hold across every shape keyframe', async () => {
  const { layer: A } = await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'A', init: [] });
  const { groups: [m] } = await h.run({ type: 'addMask', layer: A, path: (pathV(square) as { value: never }).value, mode: 'add', inverted: false });
  const mid = m!.split('/')[1]!;
  await h.run({ type: 'setAnimated', prop: P(A, `${m}/path`), animated: true, time: 0 });
  await h.run({ type: 'setProperty', prop: P(A, `${m}/path`), value: pathV([0, 0, 200, 0, 200, 200, 0, 200]), time: sec(1) });
  await h.run({ type: 'setProperty', prop: P(A, `${m}/feather`), value: scalar(12) });
  await h.run({ type: 'setProperty', prop: P(A, `${m}/opacity`), value: scalar(40) });
  const node = defaultSceneGraph.getNode(A)!;
  for (const k of readNodeMaskAnim(node)) {
    const p = k.mask.paths.find((x) => x.id === mid)!;
    expect([p.feather, p.opacity]).toEqual([12, 0.4]);
  }
  expect(readNodeMask(node)!.paths[0]!.feather).toBe(12);
});

test('per-vertex feather: feather points read per vertex; empty keeps, non-empty is authoritative, negative clears', async () => {
  const { layer: A } = await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'A', init: [] });
  const { groups: [m] } = await h.run({ type: 'addMask', layer: A, path: (pathV(square, [{ segment: 2, t: 0, radius: 6, tension: 0 }]) as { value: never }).value, mode: 'add', inverted: false });
  const points = () => readNodeMask(defaultSceneGraph.getNode(A)!)!.paths[0]!.points.map((p) => p.feather);
  expect(points()).toEqual([undefined, undefined, 6, undefined]);
  const read = await value(A, `${m}/path`);
  expect(read.kind === 'path' && read.value.featherPoints).toEqual([{ segment: 2, t: 0, radius: 6, tension: 0 }]);
  await h.run({ type: 'setProperty', prop: P(A, `${m}/path`), value: pathV([0, 0, 120, 0, 120, 120, 0, 120]) });
  expect(points()).toEqual([undefined, undefined, 6, undefined]);
  await h.run({ type: 'setProperty', prop: P(A, `${m}/path`), value: pathV(square, [{ segment: 0, t: 0, radius: 3, tension: 0 }]) });
  expect(points()).toEqual([3, undefined, undefined, undefined]);
  await h.run({ type: 'setProperty', prop: P(A, `${m}/path`), value: pathV(square, [{ segment: 0, t: 0, radius: -1, tension: 0 }]) });
  expect(points()).toEqual([undefined, undefined, undefined, undefined]);
  expect(await code({ type: 'setProperty', prop: P(A, `${m}/path`), value: pathV(square, [{ segment: 1, t: 0.5, radius: 2, tension: 0 }]) })).toBe('unsupported');
  expect(await code({ type: 'setProperty', prop: P(A, `${m}/path`), value: pathV(square, [{ segment: 7, t: 0, radius: 2, tension: 0 }]) })).toBe('invalidArgument');
});

test('Glass is a first-class style: styles/glass/<param> on the glass.<param> tracks; switches are fields', async () => {
  const { layer: A } = await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'A', init: [] });
  await h.run({ type: 'addPropertyGroup', layer: A, parent: 'styles', matchName: 'style:glass', init: [] });
  await h.run({ type: 'addPropertyGroup', layer: A, parent: 'styles', matchName: 'style:bevel', init: [] });
  expect(await value(A, 'styles/glass/blur')).toEqual(scalar(28));
  await h.run({ type: 'setProperty', prop: P(A, 'styles/glass/blur'), value: scalar(40) });
  expect(getNodeLayerStyles(A).glass!.blur).toBe(40);
  await h.run({ type: 'setProperty', prop: P(A, 'styles/glass/rimColor'), value: { kind: 'color', value: { r: 1, g: 0, b: 0, a: 1 } } });
  expect(getNodeLayerStyles(A).glass!.rimColor.toLowerCase()).toBe('#ff0000');
  await h.run({ type: 'setAnimated', prop: P(A, 'styles/glass/rimAngle'), animated: true, time: 0 });
  expect(defaultAnimation.isAnimated(A, 'glass.rimAngle')).toBe(true);
  await h.run({ type: 'setProperty', prop: P(A, 'styles/glass/useGlobalLight'), value: { kind: 'bool', value: false } });
  expect(getNodeLayerStyles(A).glass!.useGlobalLight).toBe(false);
  await h.run({ type: 'setProperty', prop: P(A, 'styles/bevel/direction'), value: { kind: 'choice', value: 'down' } });
  expect(getNodeLayerStyles(A).bevel!.direction).toBe('down');
  expect(await code({ type: 'setProperty', prop: P(A, 'styles/bevel/direction'), value: { kind: 'choice', value: 'left' } })).toBe('outOfRange');
  expect(await code({ type: 'setProperty', prop: P(A, 'styles/satin/invert'), value: { kind: 'bool', value: true } })).toBe('notFound');
  // Removing the style takes its glass.* tracks with it.
  await h.run({ type: 'removePropertyGroups', groups: [P(A, 'styles/glass')] });
  expect(defaultAnimation.isAnimated(A, 'glass.rimAngle')).toBe(false);
});
