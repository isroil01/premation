/**
 * B3 paths: the outline properties and commands the Mask and Shape Path verbs,
 * the Pen / Direct Selection ports, the Knife and Create Nulls From Paths
 * write through (ENGINE_API.md §15.10) — a shape layer's `layer/path.points`
 * path value, `BezierPath.vertexStates`, `masks/<id>/rotoBezier`,
 * `layer/pathRotoBezier`, `layer/pointBindings`, a light's latent Point of
 * Interest, `editPathTopology` and `setShapeOutline`. Each: one entry, exact
 * undo, redo.
 */

import { pasteDrawnShape } from '../__testHelpers__/fixtures';
import type { BezierPath, Command, PropRef, Value } from '@motion/engine-api';
import { readNodeMask, readNodeMaskAnim } from '@core/effects/mask';
import { setupAppEngine } from '../__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import { buildScene, type Scene } from '../__testHelpers__/scene';
import { sec, type Harness } from '../__testHelpers__/appEngine';

let h: Harness;
let s: Scene;

beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
});
afterEach(async () => {
  await h.dispose();
});

async function exact(cmd: Command | Command[]): Promise<unknown> {
  const before = (await h.doc());
  const res = Array.isArray(cmd) ? await h.batch('B', cmd) : await h.run(cmd);
  const after = (await h.doc());
  expect(after).not.toEqual(before);
  await h.run({ type: 'undo' });
  expect((await h.doc())).toEqual(before);
  await h.run({ type: 'redo' });
  expect((await h.doc())).toEqual(after);
  return res;
}

const refused = async (cmd: Command, code: string): Promise<void> => {
  const before = (await h.doc());
  const r = await h.client.execute(cmd);
  expect(r.ok ? 'ok' : r.error.code).toBe(code);
  expect((await h.doc())).toBe(before);
};

const tri = (k: number) => [
  { x: 0, y: -k, inX: 0, inY: -k, outX: 0, outY: -k },
  { x: k, y: k, inX: k, inY: k, outX: k, outY: k },
  { x: -k, y: k, inX: -k, inY: k, outX: -k, outY: k },
];
const bez = (k: number, closed = true, extra: Partial<BezierPath> = {}): BezierPath => ({
  vertices: [0, -k, k, k, -k, k], inTangents: [0, 0, 0, 0, 0, 0], outTangents: [0, 0, 0, 0, 0, 0], closed,
  featherPoints: [], vertexStates: [], ...extra,
});
const path = (b: BezierPath): Value => ({ kind: 'path', value: b });

/** A drawn path layer D (the Pen's Geometry points), as the tools leave it. */
let D = '';
async function drawnShape(): Promise<PropRef> {
  D = await pasteDrawnShape(s.comp, tri(10), { name: 'D' });
  await h.run({ type: 'setProperty', prop: { layer: s.A, path: 'transform/opacity' }, value: { kind: 'scalar', value: 50 } });
  return { layer: D, path: 'layer/path.points' };
}

const geom = async (id: string) => (await docView()).getNode(id)!.components.find((c) => c.type === 'Geometry')!.props as Record<string, unknown>;
const maskRef = (): PropRef => ({ layer: s.A, path: `masks/${s.mask}/path` });

describe("a shape layer's outline: layer/path.points", () => {
  it('is a path value: static Geometry points + Closed, with each vertex\'s editing state', async () => {
    const ref = await drawnShape();
    const tree = await h.query({ type: 'getPropertyValues', props: [ref], time: 0, evaluated: false });
    expect(tree.values[0]!.value).toEqual(path(bez(10)));
    await exact({ type: 'setProperty', prop: ref, value: path(bez(20, false, { vertexStates: [{ vertex: 1, broken: true, tension: 0.5 }] })) });
    expect((await geom(D)).points).toEqual([
      { x: 0, y: -20, inX: 0, inY: -20, outX: 0, outY: -20 },
      { x: 20, y: 20, inX: 20, inY: 20, outX: 20, outY: 20, broken: true, tension: 0.5 },
      { x: -20, y: 20, inX: -20, inY: 20, outX: -20, outY: 20 },
    ]);
    expect((await geom(D)).open).toBe(true);
    // An EMPTY list keeps each vertex's state by index; a per-vertex feather is refused.
    await h.run({ type: 'setProperty', prop: ref, value: path(bez(30, false)) });
    expect(((await geom(D)).points as Array<Record<string, unknown>>)[1]).toMatchObject({ x: 30, broken: true, tension: 0.5 });
    await refused({ type: 'setProperty', prop: ref, value: path(bez(30, false, { featherPoints: [{ segment: 0, t: 0, radius: 4, tension: 0 }] })) }, 'unsupported');
    await refused({ type: 'setProperty', prop: ref, value: path(bez(30, false, { vertexStates: [{ vertex: 0, broken: false, tension: 2 }] })) }, 'outOfRange');
  });

  it('the stopwatch keys the whole outline on path.points and, off, leaves it static at the playhead', async () => {
    const ref = await drawnShape();
    await exact({ type: 'setAnimated', prop: ref, animated: true, time: 0 });
    expect((await docView()).getDataTrack(D, 'path.points')!.keyframes).toHaveLength(1);
    await exact({ type: 'setProperty', prop: ref, value: path(bez(40, false)), time: sec(1) });
    expect((await docView()).getDataTrack(D, 'path.points')!.keyframes).toHaveLength(2);
    // Closed is the whole outline's switch: the key write turned it off everywhere.
    expect((await geom(D)).open).toBe(true);
    const keys = await h.query({ type: 'getKeyframes', props: [ref] });
    expect(keys.sets[0]!.keyframes.map((k) => (k.value as { value: BezierPath }).value.closed)).toEqual([false, false]);
    await exact({ type: 'setAnimated', prop: ref, animated: false, time: sec(1) });
    expect((await docView()).getDataTrack(D, 'path.points') ?? null).toBeNull();
    expect(((await geom(D)).points as Array<{ x: number }>)[1]!.x).toBe(40);
  });
});

describe('BezierPath.vertexStates on a mask', () => {
  it('stores split handles / tension, keeps them for an empty list, clears them for an authoritative one', async () => {
    const square = { vertices: [0, 0, 100, 0, 100, 100, 0, 100], inTangents: [], outTangents: [], closed: true, featherPoints: [] };
    await exact({ type: 'setProperty', prop: maskRef(), value: path({ ...square, vertexStates: [{ vertex: 2, broken: true }, { vertex: 3, broken: false, tension: 0.25 }] }) });
    const pts = async () => readNodeMask((await docView()).getNode(s.A)!)!.paths[0]!.points as unknown as Array<Record<string, unknown>>;
    expect((await pts())[2]!.broken).toBe(true);
    expect((await pts())[3]!.tension).toBe(0.25);
    const read = await h.query({ type: 'getPropertyValues', props: [maskRef()], time: 0, evaluated: false });
    expect((read.values[0]!.value as { value: BezierPath }).value.vertexStates).toEqual([{ vertex: 2, broken: true }, { vertex: 3, broken: false, tension: 0.25 }]);
    await h.run({ type: 'setProperty', prop: maskRef(), value: path({ ...square, vertexStates: [] }) });
    expect((await pts())[2]!.broken).toBe(true);
    await h.run({ type: 'setProperty', prop: maskRef(), value: path({ ...square, vertexStates: [{ vertex: 0, broken: false }] }) });
    expect((await pts()).some((p) => p.broken !== undefined || p.tension !== undefined)).toBe(false);
    await refused({ type: 'setProperty', prop: maskRef(), value: path({ ...square, vertexStates: [{ vertex: 9, broken: true }] }) }, 'invalidArgument');
  });
});

describe('RotoBezier switches', () => {
  it("masks/<id>/rotoBezier holds in the static mask and every shape key", async () => {
    await h.run({ type: 'setAnimated', prop: maskRef(), animated: true, time: 0 });
    await h.run({ type: 'setProperty', prop: maskRef(), value: path(bez(50)), time: sec(1) });
    await exact({ type: 'setProperty', prop: { layer: s.A, path: `masks/${s.mask}/rotoBezier` }, value: { kind: 'bool', value: true } });
    const node = (await docView()).getNode(s.A)!;
    expect((readNodeMask(node)!.paths[0] as { rotoBezier?: boolean }).rotoBezier).toBe(true);
    expect(readNodeMaskAnim(node).every((k) => (k.mask.paths[0] as { rotoBezier?: boolean }).rotoBezier === true)).toBe(true);
    await exact({ type: 'setProperty', prop: { layer: s.A, path: `masks/${s.mask}/rotoBezier` }, value: { kind: 'bool', value: false } });
    expect(readNodeMaskAnim((await docView()).getNode(s.A)!).some((k) => 'rotoBezier' in k.mask.paths[0]!)).toBe(false);
  });

  it('layer/pathRotoBezier and layer/pointBindings are fields of the Geometry', async () => {
    await drawnShape();
    await exact({ type: 'setProperty', prop: { layer: D, path: 'layer/pathRotoBezier' }, value: { kind: 'bool', value: true } });
    expect((await geom(D)).rotoBezier).toBe(true);
    await exact({ type: 'setProperty', prop: { layer: D, path: 'layer/pointBindings' }, value: { kind: 'json', value: JSON.stringify([{ index: 0, nullId: s.P }]) } });
    expect((await geom(D)).pointBindings).toEqual([{ index: 0, nullId: s.P }]);
  });
});

describe('editPathTopology', () => {
  it('splits a segment of an animated mask in EVERY state (static + each key), ids and times kept', async () => {
    await h.run({ type: 'setAnimated', prop: maskRef(), animated: true, time: 0 });
    await h.run({ type: 'setProperty', prop: maskRef(), value: path({ ...bez(50), vertices: [0, 0, 200, 0, 200, 200, 0, 200], inTangents: [], outTangents: [] }), time: sec(1) });
    const before = await h.query({ type: 'getKeyframes', props: [maskRef()] });
    await exact({ type: 'editPathTopology', prop: maskRef(), op: { kind: 'insert', segment: 0, u: 0.5, indices: [], atStart: false } });
    const node = (await docView()).getNode(s.A)!;
    expect(readNodeMask(node)!.paths[0]!.points).toHaveLength(5);
    expect(readNodeMaskAnim(node).map((k) => k.mask.paths[0]!.points.length)).toEqual([5, 5]);
    expect(readNodeMaskAnim(node)[1]!.mask.paths[0]!.points[1]).toMatchObject({ x: 100, y: 0 });
    const after = await h.query({ type: 'getKeyframes', props: [maskRef()] });
    expect(after.sets[0]!.keyframes.map((k) => [k.id, k.time])).toEqual(before.sets[0]!.keyframes.map((k) => [k.id, k.time]));
    // Closed in every state, alone.
    await exact({ type: 'editPathTopology', prop: maskRef(), closed: false });
    expect(readNodeMaskAnim((await docView()).getNode(s.A)!).every((k) => k.mask.paths[0]!.closed === false)).toBe(true);
  });

  it('reverses / re-starts a shape outline and its keys; refuses what applies nowhere', async () => {
    const ref = await drawnShape();
    await h.run({ type: 'setAnimated', prop: ref, animated: true, time: 0 });
    await exact({ type: 'editPathTopology', prop: ref, op: { kind: 'firstVertex', segment: 0, u: 0, indices: [2], atStart: false } });
    expect(((await geom(D)).points as Array<{ x: number }>)[0]!.x).toBe(-10);
    expect(((await docView()).getDataTrack(D, 'path.points')!.keyframes[0]!.value as Array<{ x: number }>)[0]!.x).toBe(-10);
    await exact({ type: 'editPathTopology', prop: ref, op: { kind: 'extend', segment: 0, u: 0, indices: [], atStart: false, points: bez(5, false) }, closed: false });
    expect((await geom(D)).points as unknown[]).toHaveLength(6);
    expect((await geom(D)).open).toBe(true);
    await refused({ type: 'editPathTopology', prop: ref, op: { kind: 'insert', segment: 40, u: 0.5, indices: [], atStart: false } }, 'invalidArgument');
    await refused({ type: 'editPathTopology', prop: ref, op: { kind: 'insert', segment: 0, u: 1, indices: [], atStart: false } }, 'invalidArgument');
    await refused({ type: 'editPathTopology', prop: { layer: s.A, path: 'transform/opacity' }, closed: true }, 'invalidArgument');
    await refused({ type: 'editPathTopology', prop: ref }, 'invalidArgument');
  });
});

describe('setShapeOutline', () => {
  it("replaces a shape's outline with runs; refuses a non-shape and an animated outline", async () => {
    await drawnShape();
    await exact({ type: 'setShapeOutline', layer: D, runs: [bez(10, true), bez(4, false)] });
    const g = (await geom(D));
    expect(g.points).toBeUndefined();
    expect((g.subpaths as Array<{ open: boolean }>).map((r) => r.open)).toEqual([false, true]);
    const t = (await docView()).getNode(D)!.components.find((c) => c.type === 'Transform')!;
    expect(t.props.shapeType).toBe('path');
    await refused({ type: 'setShapeOutline', layer: s.T, runs: [bez(10)] }, 'invalidArgument');
    await refused({ type: 'setShapeOutline', layer: D, runs: [] }, 'invalidArgument');
    // An ANIMATED drawn outline (a second drawn shape, keyed on path.points) is refused.
    const K = await pasteDrawnShape(s.comp, tri(5), { name: 'K' });
    await h.run({ type: 'addKeyframes', keys: [{ prop: { layer: K, path: 'layer/path.points' }, time: 0, value: path(bez(3)), spatialIn: [], spatialOut: [] }] });
    await refused({ type: 'setShapeOutline', layer: K, runs: [bez(10)] }, 'animated');
  });
});

describe("a light's Point of Interest", () => {
  it('is addressable before the light stores it (the first write stores it on the Transform)', async () => {
    const { layer: L } = await h.run({ type: 'createLayer', comp: s.comp, kind: 'light', name: 'L', init: [] });
    await exact({ type: 'setProperty', prop: { layer: L, path: 'light/poiX' }, value: { kind: 'scalar', value: 320 } });
    const t = (await docView()).getNode(L)!.components.find((c) => c.type === 'Transform')!;
    expect(t.props.poiX).toBe(320);
  });
});
