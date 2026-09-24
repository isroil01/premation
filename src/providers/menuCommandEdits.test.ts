/**
 * The Animation menu's key-building assistants through the engine API:
 * Exponential Scale is ONE `setKeyframes` on Scale (a geometric ramp, a key
 * per frame), Convert Expression to Keyframes refuses with the reason the
 * engine reports. One undo entry each; undo restores.
 */

import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import { sec } from '@core/engine/__testHelpers__/harness';
import { engineIdle } from '@core/engine/engineInstance';
import { catalogFor, numbersOf, readKeys } from '@core/engine/props';
import { values } from '@core/engine/propRefs';
import { exponentialScaleEdit, expressionBakeEdit } from './menuCommandEdits';

let h: Harness;

beforeEach(async () => {
  h = await setupAppEngine();
});

afterEach(async () => {
  await h.dispose();
});

async function addShape(): Promise<string> {
  const { layer } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name: 'S', init: [] });
  await engineIdle();
  return layer;
}

async function keyScale(layer: string, keys: Array<[number, number, number]>): Promise<void> {
  await h.run({
    type: 'addKeyframes',
    keys: keys.map(([t, x, y]) => ({ prop: { layer, path: 'transform/scale' }, time: sec(t), value: values.vec2(x, y), spatialIn: [], spatialOut: [] })),
  });
  await engineIdle();
}

const scaleKeys = (layer: string): Array<{ t: number; v: number[] }> => {
  const b = catalogFor(layer).byMember.get('scaleX')!;
  return readKeys(layer, b).map((k) => ({ t: k.t, v: numbersOf(b, k.value) }));
};

describe('Exponential Scale', () => {
  it('rebuilds Scale as a geometric ramp, one key per frame — ONE entry, undo restores', async () => {
    const layer = await addShape();
    await keyScale(layer, [[0, 10, 50], [1, 1000, 50]]);
    const before = h.doc();
    const entries = historyLabels().length;

    const r = await exponentialScaleEdit(layer);
    await engineIdle();

    expect(r.refusal).toBeNull();
    // Only X ramps; Y is constant.
    expect([...r.written.keys()]).toEqual(['scaleX']);
    const keys = scaleKeys(layer);
    expect(keys).toHaveLength(31); // 30 fps over 1 s, both ends
    expect(keys[0]!.v.slice(0, 2)).toEqual([10, 50]);
    expect(keys[30]!.v.slice(0, 2)).toEqual([1000, 50]);
    // Halfway through a 10 → 1000 ramp is the geometric mean, 100 — not 505.
    expect(keys[15]!.t).toBeCloseTo(0.5);
    expect(keys[15]!.v[0]).toBeCloseTo(100, 6);
    expect(keys[15]!.v[1]).toBeCloseTo(50, 6);
    expect(historyLabels().slice(entries)).toEqual(['Exponential scale']);

    await h.run({ type: 'undo' });
    await engineIdle();
    expect(h.doc()).toBe(before);
  });

  it('refuses a ramp through zero, and writes nothing', async () => {
    const layer = await addShape();
    await keyScale(layer, [[0, 0, 100], [1, 100, 100]]);
    const before = h.doc();
    const entries = historyLabels().length;

    const r = await exponentialScaleEdit(layer);
    await engineIdle();

    expect(r.refusal).toBe('non-positive-scale');
    expect(h.doc()).toBe(before);
    expect(historyLabels()).toHaveLength(entries);
  });

  it('needs two keys', async () => {
    const layer = await addShape();
    await keyScale(layer, [[0, 50, 50]]);
    expect((await exponentialScaleEdit(layer)).refusal).toBe('needs-two-keyframes');
  });
});

describe('Convert Expression to Keyframes — refusals', () => {
  it('says the expression is switched off when it is', async () => {
    const layer = await addShape();
    await h.run({ type: 'setExpression', prop: { layer, path: 'transform/rotation' }, source: 'time * 45', enabled: false });
    await engineIdle();
    const entries = historyLabels().length;

    const r = await expressionBakeEdit(layer);

    expect(r.refusal).toBe('expression-disabled');
    expect(historyLabels()).toHaveLength(entries);
  });

  it('says there is no expression when there is none', async () => {
    const layer = await addShape();
    expect((await expressionBakeEdit(layer)).refusal).toBe('no-expression');
  });
});
