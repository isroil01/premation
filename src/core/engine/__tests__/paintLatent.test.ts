/**
 * B3z worker C: the shape stroke stack (`layer/strokes`, `removeStroke`, the
 * stroke rows' static seam), Gradient Fill ▸ Colors (`layer/fillStops`), the
 * LATENT numeric bindings (latentPropSpecs.ts) and Orient Towards Point of
 * Interest — semantics on the TypeScript engine. The cross-engine corpus
 * ("B3z: paint …") proves the C++ engine agrees.
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
const json = (v: unknown): Value => ({ kind: 'json', value: JSON.stringify(v) });
const scalar = (value: number): Value => ({ kind: 'scalar', value });
const fx = (id: string): Record<string, unknown> =>
  (defaultSceneGraph.getNode(id)!.components.find((c) => c.type === 'fx')?.props ?? {}) as Record<string, unknown>;
const comp0 = (id: string, type: string): Record<string, unknown> =>
  (defaultSceneGraph.getNode(id)!.components.find((c) => c.type === type)?.props ?? {}) as Record<string, unknown>;
const value = async (layer: string, path: string): Promise<Value> =>
  (await h.query({ type: 'getPropertyValues', props: [P(layer, path)], time: 0, evaluated: false })).values[0]!.value;
const paths = async (layer: string): Promise<string[]> =>
  (await h.query({ type: 'getPropertyTree', layer, path: '', depth: 0 })).nodes.map((n) => n.path);

const stroke = (width: number, extra: Record<string, unknown> = {}) =>
  ({ enabled: true, color: '#ff0000', width, opacity: 1, align: 'center', dash: [], cap: 'butt', join: 'miter', ...extra });

async function shape(): Promise<string> {
  const { layer } = await h.run({ type: 'createLayer', comp, kind: 'rectangle', name: 'R', init: [] });
  return layer;
}

test('layer/strokes: the stack is one json property; the stroke rows read and write their stack entry', async () => {
  const s = await shape();
  const before = h.doc();
  await h.run({ type: 'setProperty', prop: P(s, 'layer/strokes'), value: json([stroke(4), stroke(2, { dash: [10, 5] })]) });
  expect((fx(s).strokes as unknown[]).length).toBe(2);
  expect((fx(s).stroke as { width: number }).width).toBe(4);
  // The static seam: Stroke 2 Width reads 2 and writes into the stack (not the Transform).
  expect(await value(s, 'layer/stroke.1.width')).toEqual(scalar(2));
  await h.run({ type: 'setProperty', prop: P(s, 'layer/stroke.1.width'), value: scalar(7) });
  expect((fx(s).strokes as Array<{ width: number }>)[1]!.width).toBe(7);
  expect(comp0(s, 'Transform')['stroke.1.width']).toBeUndefined();
  await h.run({ type: 'setProperty', prop: P(s, 'layer/strokeWidth'), value: scalar(9) });
  expect((fx(s).stroke as { width: number }).width).toBe(9);
  // Colour: one colour property backed by the stack entry.
  await h.run({ type: 'setProperty', prop: P(s, 'layer/stroke.1.color'), value: { kind: 'color', value: { r: 0, g: 0, b: 1, a: 1 } } });
  expect((fx(s).strokes as Array<{ color: string }>)[1]!.color).toBe('#0000ff');
  // A dash slot and the offset.
  await h.run({ type: 'setProperty', prop: P(s, 'layer/stroke.1.gap1'), value: scalar(3) });
  expect((fx(s).strokes as Array<{ dash: number[] }>)[1]!.dash).toEqual([10, 3]);
  for (let i = 0; i < 5; i++) await h.run({ type: 'undo' });
  expect(docDiff(before, h.doc())).toEqual([]);
});

test('layer/strokes drops the tracks of removed tail strokes and lost dash slots; removeStroke re-keys the strokes above', async () => {
  const s = await shape();
  await h.run({ type: 'setProperty', prop: P(s, 'layer/strokes'), value: json([stroke(4), stroke(2, { dash: [10, 5] }), stroke(3)]) });
  await h.run({ type: 'setAnimated', prop: P(s, 'layer/stroke.1.gap1'), animated: true, time: 0 });
  await h.run({ type: 'setAnimated', prop: P(s, 'layer/stroke.2.width'), animated: true, time: 0 });
  await h.run({ type: 'setProperty', prop: P(s, 'layer/stroke.2.width'), value: scalar(11), time: sec(1) });
  const keyed = h.doc();
  // Shorten stroke 2's dash: its gap1 keys go.
  await h.run({ type: 'setProperty', prop: P(s, 'layer/strokes'), value: json([stroke(4), stroke(2, { dash: [10] }), stroke(3)]) });
  expect(defaultAnimation.isAnimated(s, 'stroke.1.gap1')).toBe(false);
  expect(defaultAnimation.isAnimated(s, 'stroke.2.width')).toBe(true);
  await h.run({ type: 'undo' });
  expect(docDiff(keyed, h.doc())).toEqual([]);
  // Remove stroke 2: stroke 3's keys move down to index 1.
  await h.run({ type: 'removeStroke', layer: s, index: 1 });
  expect((fx(s).strokes as unknown[]).length).toBe(2);
  expect(defaultAnimation.isAnimated(s, 'stroke.2.width')).toBe(false);
  expect(defaultAnimation.getTrackKeyframes(s, 'stroke.1.width')!.map((k) => k.value)).toEqual([3, 11]);
  expect(defaultAnimation.isAnimated(s, 'stroke.1.gap1')).toBe(false);
  const bad = await h.engine.execute({ type: 'removeStroke', layer: s, index: 5 });
  expect(!bad.ok && bad.error.code).toBe('outOfRange');
  await h.run({ type: 'undo' });
  expect(docDiff(keyed, h.doc())).toEqual([]);
  // Removing the tail through the field drops its tracks.
  await h.run({ type: 'setProperty', prop: P(s, 'layer/strokes'), value: json([stroke(4)]) });
  expect(fx(s).strokes).toBeUndefined();
  expect(defaultAnimation.isAnimated(s, 'stroke.2.width')).toBe(false);
  const wrong = await h.engine.execute({ type: 'setProperty', prop: P(s, 'layer/strokes'), value: json([{ color: 'red' }]) });
  expect(!wrong.ok && wrong.error.code).toBe('invalidArgument');
});

test('latent taper width binding is present at identity, keys, and its static write seeds nothing on its own', async () => {
  const s = await shape();
  await h.run({ type: 'setProperty', prop: P(s, 'layer/strokes'), value: json([stroke(4)]) });
  expect(await paths(s)).toContain('layer/strokeTaperStartWidth');
  expect(await value(s, 'layer/strokeTaperStartWidth')).toEqual(scalar(1));
  await h.run({ type: 'setAnimated', prop: P(s, 'layer/strokeTaperStartWidth'), animated: true, time: 0 });
  expect(defaultAnimation.getTrackKeyframes(s, 'strokeTaperStartWidth')!.map((k) => k.value)).toEqual([1]);
});

test('layer/fillStops: static on the paint, keys on fill.stops, stopwatch, last key leaves the stops static', async () => {
  const s = await shape();
  const paint = { type: 'linear', angle: 0, stops: [{ id: 'a', offset: 0, color: '#ff0000' }, { id: 'b', offset: 1, color: '#0000ff' }] };
  await h.run({ type: 'setProperty', prop: P(s, 'layer/fillPaint'), value: json(paint) });
  const before = h.doc();
  const g = await value(s, 'layer/fillStops');
  expect(g.kind).toBe('gradient');
  const grad = (stops: Array<[number, number, number, number]>): Value => ({
    kind: 'gradient', value: { kind: 'linear', stops: stops.map(([o, r, gg, b]) => ({ offset: o, color: { r, g: gg, b, a: 1 } })), alphaStops: [] },
  });
  await h.run({ type: 'setProperty', prop: P(s, 'layer/fillStops'), value: grad([[0, 0, 1, 0], [0.5, 1, 1, 1], [1, 0, 0, 0]]) });
  const stored = (fx(s).fill as { stops: Array<{ id: string; color: string }> }).stops;
  expect(stored.map((x) => x.id)).toEqual(['a', 'b', 'gs2']);
  expect(stored.map((x) => x.color)).toEqual(['#00ff00', '#ffffff', '#000000']);
  await h.run({ type: 'undo' });
  await h.run({ type: 'setAnimated', prop: P(s, 'layer/fillStops'), animated: true, time: 0 });
  expect(defaultAnimation.getDataTrack(s, 'fill.stops')!.keyframes[0]!.value).toEqual([{ pos: 0, color: '#ff0000' }, { pos: 1, color: '#0000ff' }]);
  await h.run({ type: 'setProperty', prop: P(s, 'layer/fillStops'), value: grad([[0, 1, 1, 1], [1, 0, 0, 0]]), time: sec(1) });
  expect(defaultAnimation.getDataTrack(s, 'fill.stops')!.keyframes.length).toBe(2);
  const wrong = await h.engine.execute({ type: 'setProperty', prop: P(s, 'layer/fillStops'), value: json([]), time: sec(1) });
  expect(!wrong.ok && wrong.error.code).toBe('typeMismatch');
  await h.run({ type: 'setAnimated', prop: P(s, 'layer/fillStops'), animated: false, time: sec(1) });
  expect(defaultAnimation.getDataTrack(s, 'fill.stops')).toBeNull();
  expect((fx(s).fill as { stops: Array<{ color: string }> }).stops.map((x) => x.color)).toEqual(['#ffffff', '#000000']);
  for (let i = 0; i < 3; i++) await h.run({ type: 'undo' });
  expect(docDiff(before, h.doc())).toEqual([]);
});

test('latent numbers: first write lands on the HOME component; the path does not change once stored', async () => {
  const s = await shape();
  const { layer: t } = await h.run({ type: 'createLayer', comp, kind: 'text', name: 'T', init: [] });
  const { layer: l } = await h.run({ type: 'createLayer', comp, kind: 'light', name: 'L', init: [] });
  expect(await paths(s)).toEqual(expect.arrayContaining(['layer/cornerRadiusTL', 'layer/skew']));
  await h.run({ type: 'setProperty', prop: P(s, 'layer/cornerRadiusTL'), value: scalar(12) });
  expect(comp0(s, 'Style').cornerRadiusTL).toBe(12);
  expect(comp0(s, 'Transform').cornerRadiusTL).toBeUndefined();
  expect(await paths(s)).toContain('layer/cornerRadiusTL');
  await h.run({ type: 'setProperty', prop: P(t, 'layer/strokeWidth'), value: scalar(3) });
  expect(comp0(t, 'Text').strokeWidth).toBe(3);
  expect(comp0(t, 'Transform').strokeWidth).toBeUndefined();
  await h.run({ type: 'setAnimated', prop: P(l, 'light/falloffDistance'), animated: true, time: 0 });
  expect(defaultAnimation.isAnimated(l, 'falloffDistance')).toBe(true);
  expect(await paths(l)).toContain('light/falloffDistance');
});

test('Orient Towards Point of Interest adds / removes poiX/Y/Z with their keys', async () => {
  const { layer: c } = await h.run({ type: 'createLayer', comp, kind: 'camera', name: 'C', init: [] });
  const path = 'transform/orientTowardsPointOfInterest';
  await h.run({ type: 'setProperty', prop: P(c, path), value: { kind: 'bool', value: false } });
  const before = h.doc();
  await h.run({ type: 'setProperty', prop: P(c, path), value: { kind: 'bool', value: true } });
  expect(await value(c, path)).toEqual({ kind: 'bool', value: true });
  expect(typeof comp0(c, 'Transform').poiX).toBe('number');
  await h.run({ type: 'setAnimated', prop: P(c, 'camera/poiX'), animated: true, time: 0 });
  await h.run({ type: 'setProperty', prop: P(c, path), value: { kind: 'bool', value: false } });
  expect(comp0(c, 'Transform').poiX).toBeUndefined();
  expect(defaultAnimation.isAnimated(c, 'poiX')).toBe(false);
  expect(await value(c, path)).toEqual({ kind: 'bool', value: false });
  for (let i = 0; i < 3; i++) await h.run({ type: 'undo' });
  expect(docDiff(before, h.doc())).toEqual([]);
});
