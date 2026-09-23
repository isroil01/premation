/**
 * G2 — engine-internal correctness: reference (TypeScript) bugs the C++ port
 * did not copy, each pinned here on the TS engine; the cross-engine replay
 * (crossEngine.test.ts) holds both engines to the same behaviour.
 */

import { setupEngine, sec, docDiff, type Harness } from '../__testHelpers__/harness';
import { buildScene } from '../__testHelpers__/scene';

jest.useFakeTimers();

let h: Harness;
beforeEach(async () => { h = await setupEngine(); });
afterEach(async () => { await h.dispose(); });

describe('batches that create several things undo all of them', () => {
  test('undoing a batch of two createComposition removes BOTH comps, and redo brings both back', async () => {
    await buildScene(h);
    const d0 = h.doc();
    const before = (await h.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false })).comps.length;
    h.batches.length = 0;
    const [a, b] = await h.batch('Two comps', [
      { type: 'createComposition', settings: { name: 'One' }, fromItems: [] },
      { type: 'createComposition', settings: { name: 'Two' }, fromItems: [] },
    ]);
    const ids = [(a as { item: string }).item, (b as { item: string }).item];
    // The batch's events name both new comps.
    const upserted = h.batches.flatMap((x) => x.events).flatMap((e) => (e.type === 'itemsChanged' ? e.items.map((i) => i.id) : []));
    expect(upserted).toEqual(expect.arrayContaining(ids));
    const d1 = h.doc();
    expect((await h.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false })).comps.length).toBe(before + 2);
    await h.run({ type: 'undo' });
    expect(docDiff(d0, h.doc())).toEqual([]);
    await h.run({ type: 'redo' });
    expect(docDiff(d1, h.doc())).toEqual([]);
  });

  test('a batch that creates comps from footage (layers inside) undoes the layers too', async () => {
    const s = await buildScene(h);
    const d0 = h.doc();
    h.batches.length = 0;
    await h.batch('From clips', [
      { type: 'createComposition', settings: {}, fromItems: [s.footage] },
      { type: 'createComposition', settings: {}, fromItems: [s.footage2] },
    ]);
    const changed = h.batches.flatMap((x) => x.events).flatMap((e) => (e.type === 'layersChanged' ? e.layers.map((l) => l.id) : []));
    expect(changed).toHaveLength(2);
    await h.run({ type: 'undo' });
    expect(docDiff(d0, h.doc())).toEqual([]);
  });

  test('two editWorkArea in one batch, on two comps, journal every layer they remove or add', async () => {
    const s = await buildScene(h);
    // Comp 2: a layer entirely inside its work area (lift removes it).
    await h.run({ type: 'setWorkArea', comp: s.comp2, range: { start: 0, duration: sec(10) } });
    const d0 = h.doc();
    h.batches.length = 0;
    await h.batch('Lift both', [
      { type: 'editWorkArea', comp: s.comp, edit: 'lift', layers: [] },
      { type: 'editWorkArea', comp: s.comp2, edit: 'lift', layers: [] },
    ]);
    const removed = h.batches.flatMap((x) => x.events).flatMap((e) => (e.type === 'layersRemoved' ? e.layers : []));
    expect(removed).toContain(s.c2layer);
    const d1 = h.doc();
    await h.run({ type: 'undo' });
    expect(docDiff(d0, h.doc())).toEqual([]);
    await h.run({ type: 'redo' });
    expect(docDiff(d1, h.doc())).toEqual([]);
  });
});

describe('a multi-entry jumpToHistory reports every keyframe list it changed', () => {
  /** The keyframe lists an event-fed mirror holds (it keeps a removed layer's lists: §8.2 only requires upserts). */
  const keysMirror = (from: number): Map<string, string[]> => {
    const m = new Map<string, string[]>();
    for (const b of h.batches.slice(from)) {
      for (const e of b.events) {
        if (e.type === 'documentReset') m.clear();
        if (e.type === 'keyframesChanged') for (const s of e.sets) m.set(`${s.prop.layer}|${s.prop.path}`, s.keyframes.map((k) => k.id));
      }
    }
    return m;
  };

  test('restoring a removed layer AND un-keying it in one jump sends its empty list', async () => {
    const s = await buildScene(h);
    const from = h.batches.length;
    const hist0 = (await h.query({ type: 'getHistory' })).position;
    // Entry 1: key the layer's opacity. Entry 2: delete the layer.
    await h.run({ type: 'addKeyframes', keys: [{ prop: { layer: s.A, path: 'transform/opacity' }, time: sec(1), value: { kind: 'scalar', value: 40 }, spatialIn: [], spatialOut: [] }] });
    await h.run({ type: 'deleteLayers', layers: [s.A] });
    // One jump over both: the layer comes back with no opacity keys.
    await h.run({ type: 'jumpToHistory', position: hist0 });
    const live = await h.query({ type: 'getKeyframes', props: [{ layer: s.A, path: 'transform/opacity' }] });
    expect(live.sets[0]?.keyframes ?? []).toEqual([]);
    expect(keysMirror(from).get(`${s.A}|transform/opacity`) ?? []).toEqual([]);
  });

  test('moving a bar and un-keying it in one jump sends the empty list', async () => {
    const s = await buildScene(h);
    const from = h.batches.length;
    const hist0 = (await h.query({ type: 'getHistory' })).position;
    await h.run({ type: 'addKeyframes', keys: [{ prop: { layer: s.A, path: 'transform/rotation' }, time: sec(1), value: { kind: 'scalar', value: 40 }, spatialIn: [], spatialOut: [] }] });
    await h.run({ type: 'moveLayersInTime', layers: [s.A], delta: sec(0.5), ripple: false });
    await h.run({ type: 'jumpToHistory', position: hist0 });
    expect(keysMirror(from).get(`${s.A}|transform/rotation`) ?? []).toEqual([]);
  });
});

describe('applyPreset: `time` is composition time on any layer axis (AE: the first key at the CTI)', () => {
  const keyTimes = async (layer: string, path: string): Promise<number[]> =>
    ((await h.query({ type: 'getKeyframes', props: [{ layer, path }] })).sets[0]?.keyframes ?? []).map((k) => k.time);

  test('a layer starting at 1 s: Fade In at 2 s keys opacity at 2 s and 2.5 s', async () => {
    const { layer } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'Late', init: [] });
    await h.run({ type: 'moveLayersInTime', layers: [layer], delta: sec(1), ripple: false });
    await h.run({ type: 'applyPreset', layers: [layer], preset: 'Fade In', time: sec(2) });
    expect(await keyTimes(layer, 'transform/opacity')).toEqual([sec(2), sec(2.5)]);
  });

  test('a layer stretched 200 %: the preset starts at the CTI and its spacing stretches with the layer', async () => {
    const { layer } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'Slow', init: [] });
    await h.run({ type: 'setLayerTiming', items: [{ layer, stretch: 2 }] });
    // The TS stretch model anchors the stretch at the layer's first keyframe
    // (layerTime.remapTime, the renderer's own rule); a key at 0 pins the anchor.
    await h.run({ type: 'addKeyframes', keys: [{ prop: { layer, path: 'transform/rotation' }, time: 0, value: { kind: 'scalar', value: 0 }, spatialIn: [], spatialOut: [] }] });
    await h.run({ type: 'applyPreset', layers: [layer], preset: 'Fade In', time: sec(1) });
    expect(await keyTimes(layer, 'transform/opacity')).toEqual([sec(1), sec(2)]);
  });
});
