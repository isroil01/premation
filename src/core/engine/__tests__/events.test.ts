/**
 * Change events (ENGINE_API.md §8): one batch per applied request with
 * consecutive revisions, full records, and a dumb mirror that applies them
 * ends up equal to `getDocument`.
 */

import type { Event, EventBatch, LayerInfo, ItemInfo, Keyframe, Marker, CompInfo } from '@motion/engine-api';
import { setupEngine, sec, type Harness } from '../__testHelpers__/harness';
import { buildScene } from '../__testHelpers__/scene';

jest.useFakeTimers();

let h: Harness;
beforeEach(async () => { h = await setupEngine(); });
afterEach(async () => { await h.dispose(); });

const revisioned = (b: EventBatch[]): EventBatch[] => b.filter((x) => x.fromRevision !== x.toRevision);
const types = (b: EventBatch): string[] => b.events.map((e) => e.type);
const of = <T extends Event['type']>(b: EventBatch[], t: T): Array<Extract<Event, { type: T }>> =>
  b.flatMap((x) => x.events).filter((e): e is Extract<Event, { type: T }> => e.type === t);

test('each applied edit is one batch; revisions are consecutive; causedBy/origin echo the request', async () => {
  const s = await buildScene(h);
  h.batches.length = 0;
  const r0 = h.engine.documentRevision;
  await h.run({ type: 'renameLayer', layer: s.A, name: 'X' });
  await h.engine.execute({ type: 'renameLayer', layer: s.B, name: 'Y' }, { origin: 'ai' });
  const rev = revisioned(h.batches);
  expect(rev).toHaveLength(2);
  expect(rev[0]!.fromRevision).toBe(r0);
  expect(rev[0]!.toRevision).toBe(r0 + 1);
  expect(rev[1]!.fromRevision).toBe(r0 + 1);
  expect(rev[1]!.origin).toBe('ai');
  expect(typeof rev[0]!.causedBy).toBe('number');
  // A failed request emits no revisioned batch and moves no revision.
  h.batches.length = 0;
  await h.engine.execute({ type: 'renameLayer', layer: 'nope', name: 'Z' });
  expect(revisioned(h.batches)).toHaveLength(0);
  // A no-op edit changes nothing, so no revision and no entry either.
  await h.run({ type: 'renameLayer', layer: s.A, name: 'X' });
  expect(revisioned(h.batches)).toHaveLength(0);
  expect(h.engine.documentRevision).toBe(r0 + 2);
  // historyChanged + dirtyChanged follow every change, ephemeral.
  h.batches.length = 0;
  await h.run({ type: 'renameLayer', layer: s.A, name: 'X2' });
  const eph = h.batches.filter((b) => b.fromRevision === b.toRevision).flatMap(types);
  expect(eph).toEqual(expect.arrayContaining(['historyChanged', 'dirtyChanged']));
});

test('the right event kinds for each family', async () => {
  const s = await buildScene(h);
  const check = async (cmd: Parameters<Harness['run']>[0], want: string[]): Promise<void> => {
    h.batches.length = 0;
    await h.run(cmd);
    const got = new Set(revisioned(h.batches).flatMap(types));
    for (const w of want) expect([cmd.type, w, got.has(w)]).toEqual([cmd.type, w, true]);
  };
  await check({ type: 'createLayer', comp: s.comp, kind: 'null', init: [] }, ['layersChanged', 'layerOrderChanged', 'propertiesChanged']);
  await check({ type: 'deleteLayers', layers: [s.P] }, ['layersRemoved', 'layerOrderChanged']);
  await check({ type: 'setProperty', prop: { layer: s.A, path: 'transform/rotation' }, value: { kind: 'scalar', value: 10 } }, ['propertiesChanged']);
  await check({ type: 'addKeyframes', keys: [{ prop: { layer: s.A, path: 'transform/opacity' }, time: sec(1), value: { kind: 'scalar', value: 5 }, spatialIn: [], spatialOut: [] }] }, ['keyframesChanged']);
  await check({ type: 'addEffect', layers: [s.B], effect: 'glow', params: [] }, ['propertyGroupsChanged']);
  await check({ type: 'addMarkers', markers: [{ owner: { comp: s.comp }, time: sec(1), duration: 0, name: 'n', comment: '', label: 0 }] }, ['markersChanged']);
  await check({ type: 'setCompositionSettings', comp: s.comp, patch: { width: 1000 } }, ['compositionChanged']);
  await check({ type: 'renameItem', item: s.footage, name: 'f' }, ['itemsChanged']);
  await check({ type: 'removeItems', items: [s.folder], removeUsingLayers: false }, ['itemsRemoved']);
  await check({ type: 'setProjectSettings', patch: { framesStartAt: 1 } }, ['projectSettingsChanged']);
  await check({ type: 'addRenderItems', comps: [s.comp], settings: {} }, ['renderQueueChanged']);
  await check({ type: 'moveLayersInTime', layers: [s.A], delta: sec(1), ripple: false }, ['layersChanged']);
  await check({ type: 'undo' }, ['layersChanged']);
});

test('propertiesChanged reports only what changed once a layer has been reported', async () => {
  const s = await buildScene(h);
  await h.run({ type: 'setProperty', prop: { layer: s.A, path: 'transform/rotation' }, value: { kind: 'scalar', value: 1 } });
  h.batches.length = 0;
  await h.run({ type: 'setProperty', prop: { layer: s.A, path: 'transform/rotation' }, value: { kind: 'scalar', value: 2 } });
  const pc = of(h.batches, 'propertiesChanged');
  expect(pc).toHaveLength(1);
  expect(pc[0]!.properties.map((p) => p.path)).toEqual(['transform/rotation']);
  expect(pc[0]!.properties[0]!.value).toEqual({ kind: 'scalar', value: 2 });
});

test('keyframesChanged carries FULL lists; the last key gone reports an empty list', async () => {
  const s = await buildScene(h);
  h.batches.length = 0;
  await h.run({ type: 'deleteKeyframes', ids: [s.posKeys[1]!] });
  const kc = of(h.batches, 'keyframesChanged').flatMap((e) => e.sets).filter((x) => x.prop.path === 'transform/position');
  expect(kc.at(-1)!.keyframes.map((k) => k.id)).toEqual([s.posKeys[0]]);
  h.batches.length = 0;
  await h.run({ type: 'deleteKeyframes', ids: [s.posKeys[0]!] });
  const kc2 = of(h.batches, 'keyframesChanged').flatMap((e) => e.sets).filter((x) => x.prop.path === 'transform/position');
  expect(kc2.at(-1)!.keyframes).toEqual([]);
});

// ── A dumb mirror (§8.2) ──────────────────────────────────────────────

class Mirror {
  revision = 0;
  layers = new Map<string, LayerInfo>();
  order = new Map<string, string[]>();
  items = new Map<string, ItemInfo>();
  keys = new Map<string, Keyframe[]>();
  markers = new Map<string, Marker[]>();
  resets = 0;
  apply(b: EventBatch): void {
    if (b.fromRevision === b.toRevision) return;
    if (b.toRevision <= this.revision) return;
    if (b.fromRevision !== this.revision) throw new Error(`gap ${this.revision} → ${b.fromRevision}`);
    for (const e of b.events) {
      switch (e.type) {
        case 'documentReset': this.resets += 1; break;
        case 'layersChanged': for (const l of e.layers) this.layers.set(l.id, l); break;
        case 'layersRemoved': for (const id of e.layers) { this.layers.delete(id); for (const k of [...this.keys.keys()]) if (k.startsWith(`${id}|`)) this.keys.delete(k); } break;
        case 'layerOrderChanged': this.order.set(e.comp, e.layers); break;
        case 'itemsChanged': for (const i of e.items) this.items.set(i.id, i); break;
        case 'itemsRemoved': for (const id of e.items) this.items.delete(id); break;
        case 'keyframesChanged': for (const s of e.sets) { const k = `${s.prop.layer}|${s.prop.path}`; if (s.keyframes.length) this.keys.set(k, s.keyframes); else this.keys.delete(k); } break;
        case 'markersChanged': this.markers.set(`${e.owner.comp}|${e.owner.layer ?? ''}`, e.markers); break;
        default: break;
      }
    }
    this.revision = b.toRevision;
  }
  load(doc: { revision: number; layers: LayerInfo[]; comps: CompInfo[]; items: ItemInfo[]; keyframes: Array<{ prop: { layer: string; path: string }; keyframes: Keyframe[] }> }): void {
    this.revision = doc.revision;
    this.layers = new Map(doc.layers.map((l) => [l.id, l]));
    this.order = new Map(doc.comps.map((c) => [c.id, c.layers]));
    this.items = new Map(doc.items.map((i) => [i.id, i]));
    this.keys = new Map(doc.keyframes.map((s) => [`${s.prop.layer}|${s.prop.path}`, s.keyframes]));
  }
}

test('a mirror fed only by events equals getDocument after a mixed session with undo/redo', async () => {
  const s = await buildScene(h);
  const mirror = new Mirror();
  mirror.load(await h.query({ type: 'getDocument', includeProperties: false, includeKeyframes: true }));
  h.engine.subscribe((b) => mirror.apply(b));
  await h.run({ type: 'renameLayer', layer: s.A, name: 'Alpha' });
  await h.run({ type: 'setParent', layers: [s.B], parent: s.P, keepWorldTransform: true });
  await h.run({ type: 'moveKeyframes', ids: [s.posKeys[1]!], delta: sec(1) });
  await h.run({ type: 'splitLayers', layers: [s.A], time: sec(3) });
  await h.run({ type: 'deleteLayers', layers: [s.T] });
  await h.run({ type: 'precompose', comp: s.comp, layers: [s.V], name: 'Pre', mode: 'moveAll', adjustDuration: false });
  await h.run({ type: 'undo' });
  await h.run({ type: 'undo' });
  await h.run({ type: 'redo' });
  await h.run({ type: 'addKeyframes', keys: [{ prop: { layer: s.A, path: 'transform/scale' }, time: sec(2), spatialIn: [], spatialOut: [] }] });
  const doc = await h.query({ type: 'getDocument', includeProperties: false, includeKeyframes: true });
  expect(mirror.revision).toBe(doc.revision);
  expect(new Map(doc.layers.map((l) => [l.id, l]))).toEqual(mirror.layers);
  for (const c of doc.comps) expect([c.id, mirror.order.get(c.id) ?? c.layers]).toEqual([c.id, c.layers]);
  expect(new Map(doc.keyframes.map((x) => [`${x.prop.layer}|${x.prop.path}`, x.keyframes]))).toEqual(mirror.keys);
  expect(new Map(doc.items.map((i) => [i.id, i]))).toEqual(mirror.items);
});
