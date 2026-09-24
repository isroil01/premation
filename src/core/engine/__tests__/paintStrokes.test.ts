/**
 * B3 — paint strokes through the engine API (handlers/strokes.ts, paintStrokes.ts):
 * the commands' semantics, their typed refusals (nothing changes), and exact undo.
 * commands.test.ts covers execute → undo → redo for each; this pins WHAT they do.
 */

import type { Command } from '@motion/engine-api';
import { defaultAnimation } from '@motion/animation';
import { getNodePaint } from '@core/paint/paintStrokes';
import { setupEngine, sec, type Harness } from '../__testHelpers__/harness';

jest.useFakeTimers();

let h: Harness;
let L: string;

beforeEach(async () => {
  h = await setupEngine();
  L = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'S', init: [] } as Command) as { layer: string }).layer;
});
afterEach(async () => {
  await h.dispose();
});

const add = async (stroke: object, keys: Array<{ param: string; time: number; value: number }> = []): Promise<string> =>
  (await h.run({ type: 'addPaintStroke', layer: L, stroke: JSON.stringify(stroke), keys }) as { stroke: string }).stroke;

async function refused(cmd: Command): Promise<string> {
  const before = h.doc();
  const r = await h.engine.execute(cmd);
  expect(h.doc()).toBe(before);
  return r.ok ? 'ok' : r.error.code;
}

const strokes = () => getNodePaint(L)?.strokes ?? [];
const PTS = [{ x: 0, y: 0 }, { x: 10, y: 0 }];

describe('addPaintStroke', () => {
  it('appends a normalised stroke with an engine-minted id and its keys; undo removes both', async () => {
    const before = h.doc();
    const a = await add({ points: PTS, size: 8, opacity: 2, mode: 'erase', eraseMode: 'paintOnly' });
    const b = await add({ points: PTS }, [{ param: 'end', time: 0.5, value: 0 }, { param: 'end', time: 1, value: 100 }]);
    expect(a).toBe('pstroke_1');
    expect(b).toBe('pstroke_2');
    expect(strokes()[0]).toEqual({ id: a, points: PTS, color: '#ffffff', size: 8, opacity: 1, hardness: 1, mode: 'erase', eraseMode: 'paintOnly' });
    expect(defaultAnimation.getTrackKeyframes(L, `paint.${b}.end`)?.map((k) => [k.t, k.value])).toEqual([[0.5, 0], [1, 100]]);
    await h.run({ type: 'undo' });
    await h.run({ type: 'undo' });
    expect(h.doc()).toBe(before);
  });

  it('refuses an id, empty / non-finite points, bad json and unknown params — changing nothing', async () => {
    const cmd = (stroke: string, keys: Array<{ param: string; time: number; value: number }> = []): Command =>
      ({ type: 'addPaintStroke', layer: L, stroke, keys });
    expect(await refused(cmd(JSON.stringify({ id: 'x', points: PTS })))).toBe('invalidArgument');
    expect(await refused(cmd(JSON.stringify({ points: [] })))).toBe('invalidArgument');
    expect(await refused(cmd(JSON.stringify({ points: [{ x: 0 }] })))).toBe('invalidArgument');
    expect(await refused(cmd('{points'))).toBe('invalidArgument');
    expect(await refused(cmd('[1]'))).toBe('invalidArgument');
    expect(await refused(cmd(JSON.stringify({ points: PTS }), [{ param: 'path', time: 0, value: 1 }]))).toBe('invalidArgument');
    expect(await refused(cmd(JSON.stringify({ points: PTS }), [{ param: 'end', time: Infinity, value: 1 }]))).toBe('invalidArgument');
    expect(await refused({ type: 'addPaintStroke', layer: 'nope', stroke: JSON.stringify({ points: PTS }), keys: [] })).toBe('notFound');
  });
});

describe('updatePaintStroke', () => {
  it('merges, a null clears a key, the result is renormalised', async () => {
    const id = await add({ points: PTS, pressure: [0.5, 1] });
    await h.run({ type: 'updatePaintStroke', layer: L, stroke: id, patch: JSON.stringify({ visible: false, hardness: -3 }) });
    expect(strokes()[0]).toMatchObject({ visible: false, hardness: 0, pressure: [0.5, 1] });
    await h.run({ type: 'updatePaintStroke', layer: L, stroke: id, patch: JSON.stringify({ visible: null, points: [...PTS, { x: 20, y: 0 }], pressure: [0.5, 1, 1] }) });
    expect(strokes()[0]!.visible).toBeUndefined();
    expect(strokes()[0]!.points).toHaveLength(3);
    expect(strokes()[0]!.pressure).toEqual([0.5, 1, 1]);
  });

  it('refuses an unknown stroke, an id or bad points', async () => {
    const id = await add({ points: PTS });
    expect(await refused({ type: 'updatePaintStroke', layer: L, stroke: 'nope', patch: '{}' })).toBe('notFound');
    expect(await refused({ type: 'updatePaintStroke', layer: L, stroke: id, patch: JSON.stringify({ id: 'y' }) })).toBe('invalidArgument');
    expect(await refused({ type: 'updatePaintStroke', layer: L, stroke: id, patch: JSON.stringify({ points: null }) })).toBe('invalidArgument');
  });
});

describe('removePaintStrokes', () => {
  it('removes the strokes with every paint.<id>. track; the others keep theirs; undo is exact', async () => {
    const a = await add({ points: PTS }, [{ param: 'end', time: 0, value: 0 }, { param: 'end', time: 1, value: 100 }]);
    const b = await add({ points: PTS }, [{ param: 'opacity', time: 0, value: 50 }, { param: 'opacity', time: 1, value: 60 }]);
    await h.run({ type: 'setPaintPathAnimated', layer: L, stroke: a, animated: true, time: 0 });
    const before = h.doc();
    await h.run({ type: 'removePaintStrokes', layer: L, strokes: [a] });
    expect(strokes().map((s) => s.id)).toEqual([b]);
    expect(defaultAnimation.getTrackKeyframes(L, `paint.${a}.end`) ?? []).toEqual([]);
    expect(defaultAnimation.isDataAnimated(L, `paint.${a}.path`)).toBe(false);
    expect(defaultAnimation.getTrackKeyframes(L, `paint.${b}.opacity`)).toHaveLength(2);
    await h.run({ type: 'undo' });
    expect(h.doc()).toBe(before);
    expect(await refused({ type: 'removePaintStrokes', layer: L, strokes: [a, 'nope'] })).toBe('notFound');
    expect(await refused({ type: 'removePaintStrokes', layer: L, strokes: [] })).toBe('invalidArgument');
  });
});

describe('setPaintOnTransparent', () => {
  it('sets and clears the flag; a layer without paint is notFound', async () => {
    expect(await refused({ type: 'setPaintOnTransparent', layers: [L], on: true })).toBe('notFound');
    await add({ points: PTS });
    await h.run({ type: 'setPaintOnTransparent', layers: [L], on: true });
    expect(getNodePaint(L)?.onTransparent).toBe(true);
    await h.run({ type: 'setPaintOnTransparent', layers: [L], on: false });
    expect(getNodePaint(L)?.onTransparent).toBeUndefined();
  });
});

describe('the Path', () => {
  it('static: replaced, pen input dropped', async () => {
    const id = await add({ points: PTS, pressure: [0.5, 1], tiltX: [1, 2] });
    await h.run({ type: 'setPaintStrokePath', layer: L, stroke: id, points: JSON.stringify([{ x: 5, y: 5 }]), time: 0 });
    expect(strokes()[0]!.points).toEqual([{ x: 5, y: 5 }]);
    expect(strokes()[0]!.pressure).toBeUndefined();
    expect(strokes()[0]!.tiltX).toBeUndefined();
  });

  it('the stopwatch keys the current points; drawing then adds keys; OFF removes the track, points kept', async () => {
    const id = await add({ points: PTS });
    await h.run({ type: 'setPaintPathAnimated', layer: L, stroke: id, animated: true, time: sec(0) });
    await h.run({ type: 'setPaintPathAnimated', layer: L, stroke: id, animated: true, time: sec(1) });
    expect(defaultAnimation.getDataTrack(L, `paint.${id}.path`)!.keyframes).toHaveLength(1);
    await h.run({ type: 'setPaintStrokePath', layer: L, stroke: id, points: JSON.stringify([{ x: 7, y: 7 }]), time: sec(1) });
    const track = defaultAnimation.getDataTrack(L, `paint.${id}.path`)!;
    expect(track.keyframes.map((k) => k.value)).toEqual([PTS, [{ x: 7, y: 7 }]]);
    expect(strokes()[0]!.points).toEqual(PTS);
    const before = h.doc();
    await h.run({ type: 'setPaintPathAnimated', layer: L, stroke: id, animated: false, time: 0 });
    expect(defaultAnimation.isDataAnimated(L, `paint.${id}.path`)).toBe(false);
    expect(strokes()[0]!.points).toEqual(PTS);
    await h.run({ type: 'undo' });
    expect(h.doc()).toBe(before);
  });

  it('refuses bad points and an unknown stroke', async () => {
    const id = await add({ points: PTS });
    expect(await refused({ type: 'setPaintStrokePath', layer: L, stroke: id, points: '[]', time: 0 })).toBe('invalidArgument');
    expect(await refused({ type: 'setPaintStrokePath', layer: L, stroke: 'nope', points: JSON.stringify(PTS), time: 0 })).toBe('notFound');
    expect(await refused({ type: 'setPaintPathAnimated', layer: L, stroke: 'nope', animated: true, time: 0 })).toBe('notFound');
  });
});
