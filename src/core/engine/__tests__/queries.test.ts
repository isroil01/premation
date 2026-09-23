/** Every query (ENGINE_API.md §7): answers, never changes the document, and unknown ids are typed errors. */

import { QUERIES, unwrap, type Query, type QueryType } from '@motion/engine-api';
import { setupEngine, sec, type Harness } from '../__testHelpers__/harness';
import { buildScene, type Scene } from '../__testHelpers__/scene';

jest.useFakeTimers();

let h: Harness;
let s: Scene;
beforeEach(async () => {
  h = await setupEngine();
  s = await buildScene(h);
});
afterEach(async () => { await h.dispose(); });

/** Queries the TypeScript engine cannot answer from document data (they need the renderer). */
const UNSUPPORTED: QueryType[] = ['getWaveform', 'getThumbnail', 'hitTest', 'getLayerBounds', 'getTextLayout', 'readPixels'];

const CASES: Record<QueryType, (s: Scene) => Query> = {
  getDocument: () => ({ type: 'getDocument', includeProperties: true, includeKeyframes: true }),
  getComposition: (x) => ({ type: 'getComposition', comp: x.comp }),
  getLayers: (x) => ({ type: 'getLayers', layers: [x.A, x.T] }),
  getPropertyTree: (x) => ({ type: 'getPropertyTree', layer: x.A, path: '', depth: 0, time: sec(1) }),
  getPropertyValues: (x) => ({ type: 'getPropertyValues', props: [{ layer: x.B, path: 'transform/position' }], time: sec(0.5), evaluated: true }),
  sampleProperty: (x) => ({ type: 'sampleProperty', prop: { layer: x.B, path: 'transform/position' }, range: { start: 0, duration: sec(1) }, samples: 5, speed: true }),
  getKeyframes: (x) => ({ type: 'getKeyframes', props: [{ layer: x.B, path: 'transform/position' }] }),
  getMotionPath: (x) => ({ type: 'getMotionPath', layer: x.B, range: { start: 0, duration: sec(1) }, samples: 3 }),
  getMarkers: (x) => ({ type: 'getMarkers', owner: { comp: x.comp } }),
  copyLayers: (x) => ({ type: 'copyLayers', layers: [x.A] }),
  getWaveform: (x) => ({ type: 'getWaveform', layer: x.V, range: { start: 0, duration: sec(1) }, buckets: 10 }),
  listFonts: () => ({ type: 'listFonts', query: '' }),
  getItems: (x) => ({ type: 'getItems', items: [x.footage, x.comp2, x.folder] }),
  getThumbnail: (x) => ({ type: 'getThumbnail', item: x.footage, time: 0, maxSize: 64 }),
  listEffects: () => ({ type: 'listEffects', category: '' }),
  listGroupTypes: (x) => ({ type: 'listGroupTypes', layer: x.T, parent: 'text/animators' }),
  listPresets: () => ({ type: 'listPresets', category: '' }),
  getCapabilities: () => ({ type: 'getCapabilities' }),
  hitTest: (x) => ({ type: 'hitTest', comp: x.comp, time: 0, point: { x: 1, y: 1 }, mode: 'topmost', includeLocked: false }),
  getLayerBounds: (x) => ({ type: 'getLayerBounds', layers: [x.A], time: 0, space: 'comp', includeEffects: false }),
  getLayerTransforms: (x) => ({ type: 'getLayerTransforms', layers: [x.B], time: sec(1) }),
  getTextLayout: (x) => ({ type: 'getTextLayout', layer: x.T, time: 0 }),
  evaluateExpression: (x) => ({ type: 'evaluateExpression', prop: { layer: x.A, path: 'transform/rotation' }, time: sec(2), source: 'time * 10' }),
  readPixels: () => ({ type: 'readPixels', viewport: 1, region: { x: 0, y: 0, width: 1, height: 1 } }),
  findLayers: (x) => ({ type: 'findLayers', comp: x.comp, name: '', kinds: ['solid'], effect: 'glow' }),
  getDependencies: (x) => ({ type: 'getDependencies', layer: x.A }),
  getHistory: () => ({ type: 'getHistory' }),
  getRenderStats: () => ({ type: 'getRenderStats' }),
  getLayerErrors: (x) => ({ type: 'getLayerErrors', comp: x.comp }),
  getJobs: () => ({ type: 'getJobs' }),
  getRenderQueue: () => ({ type: 'getRenderQueue' }),
  getCommandLog: () => ({ type: 'getCommandLog', fromRevision: 0 }),
};

test('every query in the schema has a case', () => {
  expect(Object.keys(QUERIES).sort()).toEqual(Object.keys(CASES).sort());
  expect(Object.keys(QUERIES)).toHaveLength(32);
});

test.each(Object.keys(CASES) as QueryType[])('%s answers (or says unsupported) and changes nothing', async (type) => {
  const before = h.doc();
  const rev = h.engine.documentRevision;
  const r = await h.engine.query(CASES[type](s));
  if (UNSUPPORTED.includes(type)) {
    expect(!r.ok && r.error.code).toBe('unsupported');
  } else {
    if (!r.ok) throw new Error(`${type}: ${r.error.code} ${r.error.message}`);
  }
  expect(h.doc()).toBe(before);
  expect(h.engine.documentRevision).toBe(rev);
});

test('answers carry the document as the engine holds it', async () => {
  const doc = unwrap(await h.engine.query({ type: 'getDocument', includeProperties: true, includeKeyframes: true }));
  expect(doc.comps.map((c) => c.id).sort()).toEqual([s.comp, s.comp2].sort());
  expect(doc.comps.find((c) => c.id === s.comp)!.layers).toEqual([s.A, s.B, s.T, s.V, s.P]);
  const layerA = doc.layers.find((l) => l.id === s.A)!;
  expect(layerA.kind).toBe('solid');
  const tree = doc.propertyTrees.find((t) => t.layer === s.A)!.nodes;
  expect(tree.some((n) => n.path === `effects/${s.fx}` && n.kind === 'group')).toBe(true);
  expect(tree.some((n) => n.path === `masks/${s.mask}/path` && n.valueType === 'path')).toBe(true);
  const keys = unwrap(await h.engine.query({ type: 'getKeyframes', props: [{ layer: s.B, path: 'transform/position' }] })).sets[0]!.keyframes;
  expect(keys.map((k) => k.id)).toEqual(s.posKeys);
  expect(keys.map((k) => k.time)).toEqual([0, sec(1)]);
  expect(keys[1]!.value).toEqual({ kind: 'vec2', value: { x: 300, y: 200 } });
  const mid = unwrap(await h.engine.query({ type: 'getPropertyValues', props: [{ layer: s.B, path: 'transform/position' }], time: sec(0.5), evaluated: true }));
  expect(mid.values[0]!.value).toEqual({ kind: 'vec2', value: { x: 200, y: 150 } });
  const expr = unwrap(await h.engine.query({ type: 'evaluateExpression', prop: { layer: s.A, path: 'transform/rotation' }, time: sec(2), source: 'time * 10' }));
  expect(expr.value).toEqual({ kind: 'scalar', value: 20 });
  const found = unwrap(await h.engine.query({ type: 'findLayers', name: '', kinds: ['solid'], effect: 'glow' }));
  expect(found.layers).toEqual([s.A]);
  const bad = await h.engine.query({ type: 'getLayers', layers: ['nope'] });
  expect(!bad.ok && bad.error.code).toBe('notFound');
});
