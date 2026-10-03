/** Block 3 API additions (ENGINE_API.md §4.6, §4.7, §7): setMemberKeyframes, updatePaintStroke `append`, mapLayerTime `keyframeAxis`. */

import { setupEngine, type Harness } from '../__testHelpers__/harness';
import { buildScene, type Scene } from '../__testHelpers__/scene';
import { readNodePaint, type PaintStroke } from '@core/paint/paintStrokes';
import { graph } from '../doc';

jest.useFakeTimers();

let h: Harness;
let s: Scene;
beforeEach(async () => {
  h = await setupEngine();
  s = await buildScene(h);
});
afterEach(async () => { await h.dispose(); });

type Rec = { t: number; value: number; id?: string; easing?: string; si?: number };

async function member(layer: string, name: string): Promise<Rec[] | undefined> {
  const t = (await h.query({ type: 'getMemberKeyframes', layer, members: [name] })).tracks[0];
  return t ? (JSON.parse(t.keyframes) as Rec[]) : undefined;
}

test('writes one member apart from its siblings, sorted, later record at a time wins; undo restores', async () => {
  const yBefore = await member(s.B, 'y');
  const xBefore = await member(s.B, 'x');
  await h.run({ type: 'setMemberKeyframes', layer: s.B, tracks: [{
    member: 'x',
    keyframes: JSON.stringify([{ t: 2, value: 5 }, { t: 0, value: 1, easing: 'easeOut', si: 3 }, { t: 2, value: 7 }]),
  }] });
  const x = await member(s.B, 'x');
  expect(x!.map((k) => [k.t, k.value])).toEqual([[0, 1], [2, 7]]);
  expect(x![0]).toMatchObject({ easing: 'easeOut', si: 3 });
  expect(await member(s.B, 'y')).toEqual(yBefore);
  await h.run({ type: 'undo' });
  expect(await member(s.B, 'x')).toEqual(xBefore);
});

test("'[]' removes the member's keys; a repeated id keeps its first use", async () => {
  await h.run({ type: 'setMemberKeyframes', layer: s.B, tracks: [
    { member: 'x', keyframes: '[]' },
    { member: 'opacity', keyframes: JSON.stringify([{ t: 0, value: 0, id: 'k1' }, { t: 1, value: 100, id: 'k1' }]) },
  ] });
  expect(await member(s.B, 'x')).toBeUndefined();
  const o = await member(s.B, 'opacity');
  expect(o!.map((k) => k.value)).toEqual([0, 100]);
  expect(o![0]!.id).toBe('k1');
  expect(o![1]!.id).not.toBe('k1');
});

test('bad input is a typed error and changes nothing', async () => {
  const before = h.doc();
  for (const keyframes of ['nope', '{}', JSON.stringify([{ t: 'a', value: 1 }]), JSON.stringify([{ t: 0 }])]) {
    const r = await h.engine.execute({ type: 'setMemberKeyframes', layer: s.B, tracks: [{ member: 'x', keyframes }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalidArgument');
  }
  const named = await h.engine.execute({ type: 'setMemberKeyframes', layer: s.B, tracks: [{ member: '', keyframes: '[]' }] });
  expect(named.ok).toBe(false);
  const gone = await h.engine.execute({ type: 'setMemberKeyframes', layer: 'nope', tracks: [] });
  expect(gone.ok).toBe(false);
  if (!gone.ok) expect(gone.error.code).toBe('notFound');
  expect(h.doc()).toBe(before);
});

describe('updatePaintStroke append', () => {
  /** The stored stroke (the TS engine's own document: no query returns stroke data). */
  function stroke(layer: string, id: string): PaintStroke {
    return readNodePaint(graph.getNode(layer)!)!.strokes.find((x) => x.id === id)!;
  }

  test('joins points and pads the pen arrays one side lacks; undo restores', async () => {
    const add = await h.run({ type: 'addPaintStroke', layer: s.A, stroke: JSON.stringify({ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }), keys: [] });
    const id = add.stroke;
    await h.run({ type: 'updatePaintStroke', layer: s.A, stroke: id, append: true, patch: JSON.stringify({ points: [{ x: 2, y: 2 }], pressure: [0.5] }) });
    const st = stroke(s.A, id);
    expect(st.points).toHaveLength(3);
    expect(st.pressure).toEqual([1, 1, 0.5]);
    expect(st.tiltX).toBeUndefined();
    await h.run({ type: 'undo' });
    expect(stroke(s.A, id).points).toHaveLength(2);
  });
});

describe('mapLayerTime keyframeAxis', () => {
  test("a moved layer's keyframe axis follows its start, both ways", async () => {
    await h.run({ type: 'moveLayersInTime', layers: [s.A], delta: 705_600_000, ripple: false });
    const r = await h.query({ type: 'mapLayerTime', layer: s.A, time: 2 * 705_600_000, outward: false, keyframeAxis: true });
    expect(r.time).toBe(705_600_000);
    const back = await h.query({ type: 'mapLayerTime', layer: s.A, time: 705_600_000, outward: true, keyframeAxis: true });
    expect(back.time).toBe(2 * 705_600_000);
  });
});
