/**
 * The viewport's value writes, masks, motion-path keys and text commit through
 * the engine API (B3). Pinned for each: ONE undo entry with its label, the
 * document the legacy write produced, and an exact undo / redo round trip.
 */

import { AnimationEngine, defaultAnimation, type Keyframe } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeMask } from '@core/effects/mask';
import { setSpatialInterpolation, setPathTangent, smoothMotionPath, straightenMotionPath } from '@core/motion/motionPath';
import { engineIdle } from '@core/engine/engineInstance';
import { edit, GestureSession } from '@core/engine/uiEdits';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import {
  addMaskEdit,
  capturePositionTracks,
  commitSourceTextEdit,
  deleteMaskEdit,
  editPositionKeys,
  maskPathCommand,
  positionKeyPatchCommands,
  resolvePositionKeyIds,
  setMaskFlagsEdit,
  trackValueCommands,
} from './viewportEdits';

let h: Harness & { engine: LocalEngine };
let s: Scene;

beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
});

afterEach(async () => {
  await h.dispose();
});

async function roundTrip(run: () => Promise<unknown>, label: string): Promise<void> {
  const before = h.doc();
  const entries = historyLabels().length;
  await run();
  await engineIdle();
  const after = h.doc();
  expect(after).not.toBe(before);
  expect(historyLabels().length).toBe(entries + 1);
  expect(historyLabels().at(-1)).toBe(label);
  await h.run({ type: 'undo' });
  expect(h.doc()).toBe(before);
  await h.run({ type: 'redo' });
  expect(h.doc()).toBe(after);
}

const transform = (id: string): Record<string, unknown> =>
  defaultSceneGraph.getNode(id)!.components.find((c) => c.type === 'Transform')!.props as Record<string, unknown>;

describe('trackValueCommands (the viewport dual path)', () => {
  it('a static layer takes the value — members merged into one Position write', async () => {
    await roundTrip(async () => {
      const cmds = trackValueCommands([{ nodeId: s.A, values: { x: 111, y: 222 } }], { seconds: 0 })!;
      expect(cmds).toHaveLength(1);
      await edit('Move', cmds);
    }, 'Move');
    expect(transform(s.A).x).toBe(111);
    expect(transform(s.A).y).toBe(222);
    expect(defaultAnimation.isAnimated(s.A, 'x')).toBe(false);
  });

  it('scale is sent in API percent from the stored multiplier', async () => {
    await edit('Scale', trackValueCommands([{ nodeId: s.A, values: { scaleX: 2 } }], { seconds: 0 })!);
    expect(transform(s.A).scaleX).toBeCloseTo(2);
  });

  it('an animated property keys at the playhead instead', async () => {
    await edit('Move', trackValueCommands([{ nodeId: s.B, values: { x: 150, y: 175 } }], { seconds: 0.5 })!);
    const t = defaultAnimation.getTrackKeyframes(s.B, 'x')!.map((k) => k.t);
    expect(t).toHaveLength(3);
    expect(defaultAnimation.sample(s.B, 'x', t[1]!)).toBeCloseTo(150);
  });

  it('Auto-Keyframe keys an unanimated property', async () => {
    await edit('Rotate', trackValueCommands([{ nodeId: s.A, values: { rotation: 45 } }], { seconds: 1, autoKeyframe: true })!);
    expect(defaultAnimation.isAnimated(s.A, 'rotation')).toBe(true);
  });

  it('skips locked layers (the engine would refuse the whole batch)', () => {
    defaultSceneGraph.getNode(s.A)!.locked = true;
    expect(trackValueCommands([{ nodeId: s.A, values: { x: 1 } }], { seconds: 0 })).toEqual([]);
  });

  it('null when a track has no API property on the layer', () => {
    expect(trackValueCommands([{ nodeId: s.A, values: { noSuchTrack: 1 } }], { seconds: 0 })).toBeNull();
  });

  it('a whole drag is ONE entry (gesture, absolute values, latest wins)', async () => {
    const before = h.doc();
    const entries = historyLabels().length;
    const g = new GestureSession('Move');
    for (let i = 1; i <= 5; i++) g.send(trackValueCommands([{ nodeId: s.A, values: { x: 100 + i * 10 } }], { seconds: 0 })!);
    await g.end();
    await engineIdle();
    expect(transform(s.A).x).toBe(150);
    expect(historyLabels().length).toBe(entries + 1);
    await h.run({ type: 'undo' });
    expect(h.doc()).toBe(before);
  });
});

describe('masks', () => {
  const rect = [
    { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
    { x: 50, y: 0, inX: 50, inY: 0, outX: 50, outY: 0 },
    { x: 50, y: 50, inX: 50, inY: 50, outX: 50, outY: 50 },
  ];

  it('New Mask: one entry, the engine id comes back', async () => {
    let id: string | null = null;
    await roundTrip(async () => {
      id = await addMaskEdit(s.B, { id: 'draft', mode: 'add', closed: true, feather: 0, opacity: 1, expansion: 0, inverted: false, points: rect });
    }, 'New Mask');
    expect(id).toMatch(/^mask_/);
  });

  it('reshape / flags / delete: one entry each', async () => {
    await roundTrip(() => edit('Edit Mask', maskPathCommand(s.A, s.mask, rect, true, 0)), 'Edit Mask');
    expect(readNodeMask(defaultSceneGraph.getNode(s.A)!)!.paths[0]!.points.map((p) => p.x)).toEqual([0, 50, 50]);
    await roundTrip(() => setMaskFlagsEdit(s.A, s.mask, 'Invert Mask', { inverted: true }), 'Invert Mask');
    await roundTrip(() => setMaskFlagsEdit(s.A, s.mask, 'Mask Mode', { mode: 'subtract' }), 'Mask Mode');
    expect(readNodeMask(defaultSceneGraph.getNode(s.A)!)!.paths[0]!.mode).toBe('subtract');
    await roundTrip(() => deleteMaskEdit(s.A, s.mask), 'Delete Mask');
    expect(readNodeMask(defaultSceneGraph.getNode(s.A)!)?.paths ?? []).toHaveLength(0);
  });
});

describe('motion-path keys (scratch-engine macros)', () => {
  /** What the legacy helper does to the same tracks, on its own scratch engine. */
  function legacyResult(nodeId: string, fn: (e: AnimationEngine) => void): Record<'x' | 'y', Keyframe[]> {
    const e = new AnimationEngine();
    for (const m of ['x', 'y'] as const) {
      const kfs = defaultAnimation.getTrackKeyframes(nodeId, m);
      if (kfs) e.setTrackKeyframes(nodeId, m, kfs.map((k) => ({ ...k })));
    }
    fn(e);
    return { x: e.getTrackKeyframes(nodeId, 'x')!, y: e.getTrackKeyframes(nodeId, 'y')! };
  }
  const shape = (k: Keyframe): unknown => ({ t: k.t, v: Math.round(k.value * 1e6), si: k.si, so: k.so, c: k.continuous, s: k.spatialInterp });
  const live = (nodeId: string, m: 'x' | 'y'): unknown[] => defaultAnimation.getTrackKeyframes(nodeId, m)!.map(shape);

  it.each([
    ['Spatial Interpolation: Bezier', (id: string, t: number, e: AnimationEngine) => setSpatialInterpolation(id, t, 'bezier', e)],
    ['Spatial Interpolation: Continuous', (id: string, t: number, e: AnimationEngine) => setSpatialInterpolation(id, t, 'continuous', e)],
    ['Spatial Interpolation: Auto', (id: string, t: number, e: AnimationEngine) => setSpatialInterpolation(id, t, 'auto', e)],
    ['Smooth motion path', (id: string, _t: number, e: AnimationEngine) => smoothMotionPath(id, e)],
  ])('%s: the legacy result, one entry, undoable', async (label, fn) => {
    const t0 = defaultAnimation.getTrackKeyframes(s.B, 'x')![0]!.t;
    const expected = legacyResult(s.B, (e) => fn(s.B, t0, e));
    await roundTrip(() => editPositionKeys(s.B, label, (e) => fn(s.B, t0, e)), label);
    expect(live(s.B, 'x')).toEqual(expected.x.map(shape));
    expect(live(s.B, 'y')).toEqual(expected.y.map(shape));
  });

  it('Straighten removes the tangents Smooth made', async () => {
    await editPositionKeys(s.B, 'Smooth motion path', (e) => smoothMotionPath(s.B, e));
    await editPositionKeys(s.B, 'Straighten motion path', (e) => straightenMotionPath(s.B, e));
    for (const k of defaultAnimation.getTrackKeyframes(s.B, 'x')!) {
      expect(k.si).toBeUndefined();
      expect(k.so).toBeUndefined();
    }
  });

  it('a tangent drag: absolute from the press state, one entry', async () => {
    const t0 = defaultAnimation.getTrackKeyframes(s.B, 'x')![0]!.t;
    const start = capturePositionTracks(s.B);
    const ids = await resolvePositionKeyIds(s.B, start);
    expect(ids.size).toBeGreaterThan(0);
    const expected = legacyResult(s.B, (e) => setPathTangent(s.B, t0, 'out', { x: 180, y: 90 }, true, e));
    const entries = historyLabels().length;
    const g = new GestureSession('Adjust path tangent');
    for (const p of [{ x: 120, y: 100 }, { x: 150, y: 95 }, { x: 180, y: 90 }]) {
      g.send(positionKeyPatchCommands(s.B, start, ids, (e) => setPathTangent(s.B, t0, 'out', p, true, e)));
    }
    await g.end();
    await engineIdle();
    expect(historyLabels().length).toBe(entries + 1);
    expect(live(s.B, 'x')).toEqual(expected.x.map(shape));
    expect(live(s.B, 'y')).toEqual(expected.y.map(shape));
  });

  it('a point drag moves the key value', async () => {
    const t0 = defaultAnimation.getTrackKeyframes(s.B, 'x')![1]!.t;
    const start = capturePositionTracks(s.B);
    const ids = await resolvePositionKeyIds(s.B, start);
    await edit('Move keyframe', positionKeyPatchCommands(s.B, start, ids, (e) => {
      e.setKeyframe(s.B, 'x', t0, 333);
      e.setKeyframe(s.B, 'y', t0, 444);
    }));
    expect(defaultAnimation.getTrackKeyframes(s.B, 'x')![1]!.value).toBeCloseTo(333);
    expect(defaultAnimation.getTrackKeyframes(s.B, 'y')![1]!.value).toBeCloseTo(444);
  });
});

describe('text commit', () => {
  const content = (id: string): unknown => defaultSceneGraph.getNode(id)!.components.find((c) => c.type === 'Text')!.props.content;

  it('content + the auto-name as ONE entry', async () => {
    await roundTrip(() => commitSourceTextEdit(s.T, 'Hello there', { seconds: 0, label: 'Edit Text', rename: 'Hello there' }), 'Edit Text');
    expect(content(s.T)).toBe('Hello there');
    expect(defaultSceneGraph.getNode(s.T)!.name).toBe('Hello there');
  });

  it('animated Source Text keys at the playhead', async () => {
    await h.run({ type: 'setAnimated', prop: { layer: s.T, path: 'text/sourceText' }, animated: true, time: 0 });
    await commitSourceTextEdit(s.T, 'Keyed', { seconds: 1, label: 'Edit Source Text keyframe' });
    expect(defaultAnimation.getDataTrack(s.T, 'text.source')!.keyframes).toHaveLength(2);
  });
});
