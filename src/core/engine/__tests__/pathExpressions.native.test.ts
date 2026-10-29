/**
 * AE path expressions on the engine: a Mask Path's and a shape Path's
 * expression (`masks/<id>/path`, `layer/path.points`) — `createPath`, the
 * path's own `value`, another layer's mask read through
 * `thisComp.layer(…).mask(…).maskPath` — evaluated by getPropertyValues
 * (`evaluated: true`) as the frame draws it; an error keeps the path.
 */

import type { BezierPath, PropRef, Value } from '@motion/engine-api';
import { pasteDrawnShape } from '../__testHelpers__/fixtures';
import { setupAppEngine, type Harness } from '../__testHelpers__/appEngine';
import { buildScene, type Scene } from '../__testHelpers__/scene';

let h: Harness;
let s: Scene;

beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
});
afterEach(async () => {
  await h.dispose();
});

const tri = (k: number) => [
  { x: 0, y: -k, inX: 0, inY: -k, outX: 0, outY: -k },
  { x: k, y: k, inX: k, inY: k, outX: k, outY: k },
  { x: -k, y: k, inX: -k, inY: k, outX: -k, outY: k },
];

async function pathOf(prop: PropRef, evaluated = true, time = 0): Promise<BezierPath> {
  const r = await h.query({ type: 'getPropertyValues', props: [prop], time, evaluated });
  const v = r.values[0]!.value as Value;
  expect(v.kind).toBe('path');
  return (v as { kind: 'path'; value: BezierPath }).value;
}

const setExpr = (prop: PropRef, source: string) =>
  h.client.execute({ type: 'setExpression', prop, source, enabled: true });

describe('path expressions', () => {
  it("a shape's Path: createPath from its own points, moved", async () => {
    const D = await pasteDrawnShape(s.comp, tri(10), { name: 'D' });
    const ref: PropRef = { layer: D, path: 'layer/path.points' };
    const r = await setExpr(ref, 'var p = value.points();\nfor (var i = 0; i < p.length; i++) p[i] = p[i] + [5, 0];\ncreatePath(p, value.inTangents(), value.outTangents(), value.isClosed())');
    expect(r.ok).toBe(true);
    expect((await pathOf(ref, false)).vertices).toEqual([0, -10, 10, 10, -10, 10]);
    const out = await pathOf(ref);
    expect(out.vertices).toEqual([5, -10, 15, 10, -5, 10]);
    expect(out.closed).toBe(true);
  });

  it("a Mask Path: built by createPath, open, and read from another layer's mask", async () => {
    const ref: PropRef = { layer: s.A, path: `masks/${s.mask}/path` };
    expect((await setExpr(ref, 'createPath([[0,0],[40,0],[40,30]], [], [[10,0],[0,0],[0,0]], false)')).ok).toBe(true);
    const own = await pathOf(ref);
    expect(own.vertices).toEqual([0, 0, 40, 0, 40, 30]);
    expect(own.outTangents.slice(0, 2)).toEqual([10, 0]);
    expect(own.closed).toBe(false);

    // A shape that follows A's (post-expression) mask.
    const D = await pasteDrawnShape(s.comp, tri(10), { name: 'D' });
    const dRef: PropRef = { layer: D, path: 'layer/path.points' };
    expect((await setExpr(dRef, `thisComp.layer("#${s.A}").mask(1).maskPath`)).ok).toBe(true);
    const followed = await pathOf(dRef);
    expect(followed.vertices).toEqual([0, 0, 40, 0, 40, 30]);
    expect(followed.closed).toBe(false);
  });

  it('pointOnPath on the mask drives a number', async () => {
    const ref: PropRef = { layer: s.A, path: `masks/${s.mask}/path` };
    await setExpr(ref, 'createPath([[0,0],[100,0]], [], [], false)');
    const pos: PropRef = { layer: s.A, path: 'transform/rotation' };
    expect((await setExpr(pos, 'mask(1).maskPath.pointOnPath(0.25)[0]')).ok).toBe(true);
    const v = await h.query({ type: 'getPropertyValues', props: [pos], time: 0, evaluated: true });
    expect((v.values[0]!.value as { value: number }).value).toBeCloseTo(25, 1);
  });

  it('an expression that does not return a path keeps the path', async () => {
    const ref: PropRef = { layer: s.A, path: `masks/${s.mask}/path` };
    const before = await pathOf(ref, false);
    await setExpr(ref, '42');
    expect(await pathOf(ref)).toEqual(before);
  });
});
