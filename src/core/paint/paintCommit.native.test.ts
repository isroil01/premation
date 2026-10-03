/**
 * The Paint tool's commit rules — one engine edit (one undo step) per stroke,
 * and AE's stroke semantics (Duration, Write On, Shift-continue, replace
 * selected Path, erase modes, clone aiming) decided in one place for both
 * viewers (`planPaintDrag`, sent by `commitPaintDrag`).
 */

import type { Command } from '@motion/engine-api';
import { usePaintStore } from '@stores/paintStore';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { commitPaintDrag } from '@core/engine/paintEdits';
import type { PaintDrag } from './paintCommit';
import { readNodePaint } from './paintStrokes';
import { paintPathProp, paintPropPath } from './paintProps';

let h: Harness;
let ID: string;
let OTHER: string;
const initial = usePaintStore.getState();

const solid = async (name: string): Promise<string> =>
  (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name, init: [] } as Command) as { layer: string }).layer;

const drag = (over: Partial<PaintDrag> = {}): PaintDrag => ({
  nodeId: ID,
  mode: 'paint',
  points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }],
  times: [0, 50, 100],
  pen: [null, null, null],
  size: 12,
  compTime: 1,
  ...over,
});

beforeEach(async () => {
  h = await setupAppEngine();
  ID = await solid('Plate');
  OTHER = await solid('Other');
  usePaintStore.setState(initial, true);
});
afterEach(async () => {
  await h.dispose();
});

/** The layer's paint strokes as the engine stores them. */
const strokes = async () => readNodePaint((await docView()).getNode(ID)!)?.strokes ?? [];
const idOf = (r: Awaited<ReturnType<typeof commitPaintDrag>>): string => (r as { strokeId: string }).strokeId;

test('a stroke is one undo step, a v2 dab brush living from the current time; undo is exact', async () => {
  const before = (await h.doc());
  const depth = (await historyLabels()).length;
  const r = await commitPaintDrag(drag());
  expect(r.ok).toBe(true);
  expect((await historyLabels())).toHaveLength(depth + 1);
  expect((await historyLabels()).at(-1)).toBe('Paint Stroke');
  const s = (await strokes())[0]!;
  expect(s.id).toBe(idOf(r));
  expect(s.spacing).toBe(0.25);
  expect(s.size).toBe(12);
  // Constant: from the layer time it was drawn at, to the layer's end.
  // An unretimed layer starting at 0: comp 1 s is layer 1 s.
  expect(s.inPoint).toBeCloseTo(1);
  expect(s.outPoint).toBeUndefined();
  await h.run({ type: 'undo' } as Command);
  expect((await h.doc())).toBe(before);
});

test('Single Frame and Write On', async () => {
  usePaintStore.getState().set({ duration: 'single' });
  await commitPaintDrag(drag());
  const s = (await strokes())[0]!;
  expect(s.outPoint! - s.inPoint!).toBeGreaterThan(0);
  usePaintStore.getState().set({ duration: 'writeOn' });
  const depth = (await historyLabels()).length;
  const id = idOf(await commitPaintDrag(drag()));
  // The stroke and its End keys are ONE entry.
  expect((await historyLabels())).toHaveLength(depth + 1);
  const keys = (await docView()).getTrackKeyframes(ID, paintPropPath(id, 'end')) ?? [];
  expect(keys.length).toBeGreaterThanOrEqual(2);
  expect(keys[0]!.value).toBe(0);
  expect(keys[keys.length - 1]!.value).toBe(100);
});

test('pen pressure is recorded only when every sample came from a pen', async () => {
  await commitPaintDrag(drag({ pen: [{ pressure: 0.2, tiltX: 0, tiltY: 0 }, null, null] }));
  expect((await strokes())[0]!.pressure).toBeUndefined();
  const p = { pressure: 0.7, tiltX: 5, tiltY: 0 };
  await commitPaintDrag(drag({ pen: [p, p, p] }));
  expect((await strokes())[1]!.pressure).toEqual([0.7, 0.7, 0.7]);
});

test('Shift continues the previous stroke of the same kind, padding pen input to stay parallel', async () => {
  await commitPaintDrag(drag());
  await commitPaintDrag(drag({ points: [{ x: 30, y: 0 }], times: [0], pen: [{ pressure: 0.5, tiltX: 0, tiltY: 0 }], continueStroke: true }));
  expect((await strokes())).toHaveLength(1);
  expect((await strokes())[0]!.points).toHaveLength(4);
  expect((await strokes())[0]!.pressure).toEqual([1, 1, 1, 0.5]);
});

test('a selected stroke has its Path replaced (keyed when animated)', async () => {
  const id = idOf(await commitPaintDrag(drag()));
  usePaintStore.getState().set({ selectedStroke: { nodeId: ID, strokeId: id } });
  await commitPaintDrag(drag({ points: [{ x: 5, y: 5 }], times: [0], pen: [null] }));
  expect((await strokes())).toHaveLength(1);
  expect((await strokes())[0]!.points).toEqual([{ x: 5, y: 5 }]);
  expect((await historyLabels()).at(-1)).toBe('Replace Paint Path');
  await h.run({ type: 'setPaintPathAnimated', layer: ID, stroke: id, animated: true, time: 0 });
  await commitPaintDrag(drag({ points: [{ x: 7, y: 7 }], times: [0], pen: [null], compTime: 2 }));
  expect((await docView()).getDataTrack(ID, paintPathProp(id))!.keyframes.length).toBe(2);
});

test('Eraser modes: Paint Only is stored; Last Stroke Only targets the previous paint stroke', async () => {
  const b = idOf(await commitPaintDrag(drag()));
  usePaintStore.getState().set({ eraseMode: 'paintOnly' });
  await commitPaintDrag(drag({ mode: 'erase' }));
  expect((await strokes())[1]!.eraseMode).toBe('paintOnly');
  expect((await historyLabels()).at(-1)).toBe('Erase');
  await commitPaintDrag(drag({ mode: 'erase', lastStrokeOnly: true }));
  expect((await strokes())[2]).toMatchObject({ eraseMode: 'lastStroke', eraseTargetId: b });
});

describe('clone', () => {
  test('refuses without a source on this layer (or a named Source layer)', async () => {
    const before = (await h.doc());
    expect((await commitPaintDrag(drag({ mode: 'clone' }))).ok).toBe(false);
    usePaintStore.getState().set({ cloneSource: { nodeId: OTHER, x: 0, y: 0 } });
    expect((await commitPaintDrag(drag({ mode: 'clone' }))).ok).toBe(false);
    expect((await h.doc())).toBe(before);
  });

  test('Aligned keeps the first offset; a named Source layer clones across layers', async () => {
    usePaintStore.getState().set({ cloneSource: { nodeId: ID, x: 100, y: 0 }, cloneAligned: true });
    await commitPaintDrag(drag({ mode: 'clone' }));
    await commitPaintDrag(drag({ mode: 'clone', points: [{ x: 50, y: 0 }], times: [0], pen: [null] }));
    expect((await strokes()).map((s) => s.cloneOffsetX)).toEqual([100, 100]);

    usePaintStore.getState().set({ cloneSource: { nodeId: OTHER, x: 10, y: 0 }, cloneSourceLayerId: OTHER, cloneTimeShift: -0.5, alignedOffset: null });
    await commitPaintDrag(drag({ mode: 'clone' }));
    expect((await strokes())[2]).toMatchObject({ cloneSourceId: OTHER, cloneOffsetX: 10, cloneTimeShift: -0.5 });
  });
});
