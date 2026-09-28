/** Every query (ENGINE_API.md §7): answers, never changes the document, and unknown ids are typed errors. */

import { QUERIES, unwrap, type DocumentFragment, type Query, type QueryType } from '@motion/engine-api';
import { setupEngine, sec, type Harness } from '../__testHelpers__/harness';
import { buildScene, type Scene } from '../__testHelpers__/scene';
import { hasCanvas } from '@core/effects/__testHelpers__/canvasFidelity';

jest.useFakeTimers();

let h: Harness;
let s: Scene;
beforeEach(async () => {
  h = await setupEngine();
  s = await buildScene(h);
});
afterEach(async () => { await h.dispose(); });

/** Queries the TypeScript engine cannot answer from document data (they need the renderer). */
const UNSUPPORTED: QueryType[] = ['getWaveform', 'getThumbnail', 'renderDocumentStill', 'hitTest', 'readPixels'];
/** Measured with the page's canvas: answered where the test canvas has metrics, `unsupported` where it has none. */
const NEEDS_METRICS: QueryType[] = ['getTextLayout'];

const CASES: Record<QueryType, (s: Scene) => Query> = {
  getDocument: () => ({ type: 'getDocument', includeProperties: true, includeKeyframes: true }),
  exportDocument: () => ({ type: 'exportDocument' }),
  getComposition: (x) => ({ type: 'getComposition', comp: x.comp }),
  getLayers: (x) => ({ type: 'getLayers', layers: [x.A, x.T] }),
  getPropertyTree: (x) => ({ type: 'getPropertyTree', layer: x.A, path: '', depth: 0, time: sec(1) }),
  getPropertyValues: (x) => ({ type: 'getPropertyValues', props: [{ layer: x.B, path: 'transform/position' }], time: sec(0.5), evaluated: true }),
  sampleProperty: (x) => ({ type: 'sampleProperty', prop: { layer: x.B, path: 'transform/position' }, range: { start: 0, duration: sec(1) }, samples: 5, speed: true }),
  getKeyframes: (x) => ({ type: 'getKeyframes', props: [{ layer: x.B, path: 'transform/position' }] }),
  getMotionPath: (x) => ({ type: 'getMotionPath', layer: x.B, range: { start: 0, duration: sec(1) }, samples: 3 }),
  getMarkers: (x) => ({ type: 'getMarkers', owner: { comp: x.comp } }),
  copyLayers: (x) => ({ type: 'copyLayers', layers: [x.A] }),
  copyKeyframes: (x) => ({ type: 'copyKeyframes', keys: x.posKeys }),
  getMemberKeyframes: (x) => ({ type: 'getMemberKeyframes', layer: x.B, members: [] }),
  copyEffects: (x) => ({ type: 'copyEffects', layer: x.A, effects: [] }),
  getSearchFacts: (x) => ({ type: 'getSearchFacts', layers: [x.A] }),
  getDocumentColors: () => ({ type: 'getDocumentColors', limit: 0 }),
  getCaptionCues: (x) => ({ type: 'getCaptionCues', comp: x.comp }),
  mapLayerTime: (x) => ({ type: 'mapLayerTime', layer: x.A, time: sec(1), outward: false }),
  getSourceSize: (x) => ({ type: 'getSourceSize', layers: [x.A, x.V] }),
  checkPrecompose: (x) => ({ type: 'checkPrecompose', comp: x.comp, layers: [x.A] }),
  getWaveform: (x) => ({ type: 'getWaveform', layer: x.V, range: { start: 0, duration: sec(1) }, buckets: 10 }),
  listFonts: () => ({ type: 'listFonts', query: '' }),
  getItems: (x) => ({ type: 'getItems', items: [x.footage, x.comp2, x.folder] }),
  getSvgDocument: (x) => ({ type: 'getSvgDocument', layer: x.A }),
  getCryptomatte: (x) => ({ type: 'getCryptomatte', item: x.footage }),
  getThumbnail: (x) => ({ type: 'getThumbnail', item: x.footage, time: 0, maxSize: 64 }),
  renderDocumentStill: () => ({ type: 'renderDocumentStill', document: '{}', time: 0, maxSize: 64 }),
  listEffects: () => ({ type: 'listEffects', category: '' }),
  listGroupTypes: (x) => ({ type: 'listGroupTypes', layer: x.T, parent: 'text/animators' }),
  listPresets: () => ({ type: 'listPresets', category: '' }),
  capturePreset: (x) => ({ type: 'capturePreset', layer: x.B }),
  getCapabilities: () => ({ type: 'getCapabilities' }),
  hitTest: (x) => ({ type: 'hitTest', comp: x.comp, time: 0, point: { x: 1, y: 1 }, mode: 'topmost', includeLocked: false }),
  getLayerBounds: (x) => ({ type: 'getLayerBounds', layers: [x.A], time: 0, space: 'comp', includeEffects: false }),
  getLayerTransforms: (x) => ({ type: 'getLayerTransforms', layers: [x.B], time: sec(1) }),
  getTextLayout: (x) => ({ type: 'getTextLayout', layer: x.T, time: 0 }),
  getRigPose: (x) => ({ type: 'getRigPose', layer: x.B, time: 0, points: [{ x: 1, y: 2 }] }),
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
  listPlugins: () => ({ type: 'listPlugins' }),
  getEffectUi: (x) => ({ type: 'getEffectUi', layer: x.A, effect: `effects/${x.fx}` }),
};

test('every query in the schema has a case', () => {
  expect(Object.keys(QUERIES).sort()).toEqual(Object.keys(CASES).sort());
  // 42 + the five B4 round 5 item-fact queries (getDocumentColors … checkPrecompose) + getRigPose (B4 round 5, the rig)
  // + renderDocumentStill (P4, version compare).
  expect(Object.keys(QUERIES)).toHaveLength(49);
});

test('capturePreset: keys rebased to 0 and out of pixels against the layer\'s comp; effects renumbered; empty layers say so', async () => {
  const comp = unwrap(await h.engine.query({ type: 'getComposition', comp: s.comp }));
  const { width, height } = comp.comp.settings;
  const b = await h.query({ type: 'capturePreset', layer: s.B });
  expect(b.empty).toBe(false);
  const body = JSON.parse(b.preset) as { tracks: Array<{ prop: string; unit: string; keyframes: Array<{ t: number; value: number }> }> };
  const x = body.tracks.find((t) => t.prop === 'x')!;
  const y = body.tracks.find((t) => t.prop === 'y')!;
  expect(x.unit).toBe('compW');
  expect(y.unit).toBe('compH');
  expect(x.keyframes.map((k) => k.t)).toEqual([0, 1]);
  expect(x.keyframes[1]!.value).toBeCloseTo(300 / width, 9);
  expect(y.keyframes[0]!.value).toBeCloseTo(100 / height, 9);
  // A layer with only an effect stack is a preset: the stack in the preset's own ids.
  const a = await h.query({ type: 'capturePreset', layer: s.A });
  const fx = (JSON.parse(a.preset) as { effects?: Array<{ id: string; type: string }> }).effects;
  expect(fx?.map((e) => [e.id, e.type])).toEqual([['fx0', 'glow']]);
  // Nothing authored: empty.
  const p = await h.query({ type: 'capturePreset', layer: s.P });
  expect(p).toMatchObject({ empty: true, preset: '{}' });
  const bad = await h.engine.query({ type: 'capturePreset', layer: 'nope' });
  expect(!bad.ok && bad.error.code).toBe('notFound');
});

test('copyKeyframes: whole keys per property in time order; unknown ids skipped', async () => {
  const r = await h.query({ type: 'copyKeyframes', keys: [s.posKeys[1]!, 'nope', s.posKeys[0]!] });
  expect(r.sets).toHaveLength(1);
  expect(r.sets[0]!.prop).toEqual({ layer: s.B, path: 'transform/position' });
  expect(r.sets[0]!.keyframes.map((k) => k.id)).toEqual(s.posKeys);
  expect(r.sets[0]!.keyframes[1]!.value).toEqual({ kind: 'vec2', value: { x: 300, y: 200 } });
  expect((await h.query({ type: 'copyKeyframes', keys: ['nope'] })).sets).toEqual([]);
});

test('getMemberKeyframes: the stored member tracks with their owning property; narrowed by name', async () => {
  const all = (await h.query({ type: 'getMemberKeyframes', layer: s.B, members: [] })).tracks;
  const x = all.find((t) => t.member === 'x')!;
  expect(x).toMatchObject({ path: 'transform/position', index: 0, count: 2, hasExpression: false });
  expect((JSON.parse(x.keyframes) as Array<{ t: number; value: number }>).map((k) => [k.t, k.value])).toEqual([[0, 100], [1, 300]]);
  expect(all.find((t) => t.member === 'y')).toMatchObject({ index: 1 });
  const only = (await h.query({ type: 'getMemberKeyframes', layer: s.B, members: ['y'] })).tracks;
  expect(only.map((t) => t.member)).toEqual(['y']);
  expect((await h.query({ type: 'getMemberKeyframes', layer: s.P, members: [] })).tracks).toEqual([]);
});

test('copyEffects: the capture pasteEffects takes, stack order; the same effect captures equal until it changes', async () => {
  const all = await h.query({ type: 'copyEffects', layer: s.A, effects: [] });
  const one = await h.query({ type: 'copyEffects', layer: s.A, effects: [`effects/${s.fx}`, 'effects/nope'] });
  expect(one.paths).toEqual([`effects/${s.fx}`]);
  expect(all.paths).toContain(`effects/${s.fx}`);
  const cap = JSON.parse(one.effects) as Array<{ effect: { id: string; type: string }; tracks: Record<string, unknown> }>;
  expect(cap[0]!.effect).toMatchObject({ id: s.fx, type: 'glow' });
  expect(cap[0]!.tracks).toEqual({});
  expect((await h.query({ type: 'copyEffects', layer: s.A, effects: [`effects/${s.fx}`] })).effects).toBe(one.effects);
  await h.run({ type: 'setAnimated', prop: { layer: s.A, path: `effects/${s.fx}/radius` }, animated: true, time: 0 });
  const keyed = JSON.parse((await h.query({ type: 'copyEffects', layer: s.A, effects: [`effects/${s.fx}`] })).effects) as typeof cap;
  expect(Object.keys(keyed[0]!.tracks)).toEqual(['radius']);
});

test('getSvgDocument / LayerInfo.svg: none for an ordinary layer; getCryptomatte: none decoded; unknown ids notFound', async () => {
  expect(await h.query({ type: 'getSvgDocument', layer: s.A })).toMatchObject({ role: 'none', sanitizedMarkup: '', capabilities: '{}' });
  expect((await h.query({ type: 'getLayers', layers: [s.A] })).layers[0]!.svg).toBe('none');
  expect((await h.query({ type: 'getCryptomatte', item: s.footage })).layers).toEqual([]);
  const bad = await h.engine.query({ type: 'getCryptomatte', item: 'nope' });
  expect(!bad.ok && bad.error.code).toBe('notFound');
});

test('getLayerBounds: the drawn box in layer and comp space at the time; viewport space is the overlay push\'s', async () => {
  // B's Position is keyed 100,100 → 300,200 over the first second.
  const at = async (t: number, space: 'layer' | 'comp') => (await h.query({ type: 'getLayerBounds', layers: [s.B], time: t, space, includeEffects: false })).bounds[0]!;
  const local = await at(0, 'layer');
  expect(local.corners).toHaveLength(8);
  expect(local.bounds.x).toBeCloseTo(-local.bounds.width / 2, 6);
  const c0 = await at(0, 'comp');
  const c1 = await at(sec(1), 'comp');
  expect(c0.bounds.x + c0.bounds.width / 2).toBeCloseTo(100, 6);
  expect(c1.bounds.x + c1.bounds.width / 2).toBeCloseTo(300, 6);
  expect(c1.bounds.y + c1.bounds.height / 2).toBeCloseTo(200, 6);
  expect(c1.bounds.width).toBeCloseTo(local.bounds.width, 6);
  const vp = await h.engine.query({ type: 'getLayerBounds', layers: [s.B], time: 0, space: 'viewport', includeEffects: false });
  expect(!vp.ok && vp.error.code).toBe('unsupported');
});

test('listPlugins: the TypeScript engine hosts no native plugins (G1: the C++ engine does)', async () => {
  expect((await h.query({ type: 'listPlugins' })).plugins).toEqual([]);
});

test('getEffectUi: a builtin effect has every param enabled and visible; an unknown effect is notFound', async () => {
  const ui = await h.query({ type: 'getEffectUi', layer: s.A, effect: `effects/${s.fx}` });
  expect(ui.params.length).toBeGreaterThan(0);
  expect(ui.params.every((p) => p.enabled && !p.hidden && p.key !== '' && p.name !== '')).toBe(true);
  const r = await h.engine.query({ type: 'getEffectUi', layer: s.A, effect: 'effects/nope' });
  expect(!r.ok && r.error.code).toBe('notFound');
});

test.each(Object.keys(CASES) as QueryType[])('%s answers (or says unsupported) and changes nothing', async (type) => {
  const before = h.doc();
  const rev = h.engine.documentRevision;
  const r = await h.engine.query(CASES[type](s));
  if (UNSUPPORTED.includes(type) || (NEEDS_METRICS.includes(type) && !hasCanvas)) {
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
  // B4: `member` — the draft drives that dimension; `value` is that member's own.
  const y = unwrap(await h.engine.query({ type: 'evaluateExpression', prop: { layer: s.B, path: 'transform/position' }, time: sec(0.5), source: 'value + 1', member: 1 }));
  expect(y.value).toEqual({ kind: 'scalar', value: 151 });
  const x = unwrap(await h.engine.query({ type: 'evaluateExpression', prop: { layer: s.B, path: 'transform/position' }, time: sec(0.5), source: 'value + 1' }));
  expect(x.value).toEqual({ kind: 'scalar', value: 201 });
  const tooFar = await h.engine.query({ type: 'evaluateExpression', prop: { layer: s.B, path: 'transform/position' }, time: 0, source: 'value', member: 5 });
  expect(!tooFar.ok && tooFar.error.code).toBe('outOfRange');
  // Source Text: the draft's text + style result, never stored.
  const text = unwrap(await h.engine.query({
    type: 'evaluateExpression', prop: { layer: s.T, path: 'text/sourceText' }, time: 0,
    source: 'value.style.setFontSize(20).setFillColor([1, 0, 0], 0, 2).setBaselineShift(4, 1, 1)',
  }));
  expect(text.value).toBeUndefined();
  expect(text.diagnostics).toEqual([]);
  expect(text.text).toEqual({ text: expect.any(String), styleKeys: ['fontSize'], ranges: 2, rangeKeys: ['fill', 'baselineShift'] });
  const broken = unwrap(await h.engine.query({ type: 'evaluateExpression', prop: { layer: s.T, path: 'text/sourceText' }, time: 0, source: 'nope(' }));
  expect(broken.text).toBeUndefined();
  expect(broken.diagnostics).toHaveLength(1);
  // B4: the document-wide search facts — effect match names in stack order, every expression's source.
  await h.run({ type: 'setExpression', prop: { layer: s.A, path: 'transform/opacity' }, source: 'wiggle(1, 5)', enabled: false });
  const facts = unwrap(await h.engine.query({ type: 'getSearchFacts', layers: [] }));
  const fa = facts.layers.find((f) => f.layer === s.A)!;
  expect(fa.effects).toContain('glow');
  expect(fa.expressions).toContain('wiggle(1, 5)');
  expect(facts.layers.map((f) => f.layer)).toEqual(expect.arrayContaining([s.A, s.B, s.T]));
  const one = unwrap(await h.engine.query({ type: 'getSearchFacts', layers: [s.B, 'nope'] }));
  expect(one.layers.map((f) => f.layer)).toEqual([s.B]);
  const found = unwrap(await h.engine.query({ type: 'findLayers', name: '', kinds: ['solid'], effect: 'glow' }));
  expect(found.layers).toEqual([s.A]);
  const bad = await h.engine.query({ type: 'getLayers', layers: ['nope'] });
  expect(!bad.ok && bad.error.code).toBe('notFound');
});

test('LayerInfo.pluginSchemaVersion: a custom plugin layer\'s stored schema version (the C++ test_b4_round3 twin)', async () => {
  const frag = (await h.query({ type: 'copyLayers', layers: [s.A] })) as DocumentFragment;
  const base = new TextDecoder().decode(frag.data);
  const withComponent = async (component: string): Promise<number | undefined> => {
    const key = '"components":[';
    const at = base.indexOf(key);
    expect(at).toBeGreaterThanOrEqual(0);
    const text = `${base.slice(0, at + key.length)}${component},${base.slice(at + key.length)}`;
    const r = (await h.run({ type: 'pasteLayers', comp: s.comp, fragment: { ...frag, data: new TextEncoder().encode(text) } })) as { layers: string[] };
    return (await h.query({ type: 'getLayers', layers: [r.layers[0]!] })).layers[0]!.pluginSchemaVersion;
  };
  expect(await withComponent('{"id":"plg1","props":{"__kind":"studio.acme.lab.depthImage","__schemaVersion":3},"type":"pluginLayer:studio.acme.lab.depthImage"}')).toBe(3);
  expect(await withComponent('{"id":"plg2","props":{"__kind":"studio.acme.lab.depthImage"},"type":"pluginLayer:studio.acme.lab.depthImage"}')).toBe(1);
  expect(await withComponent('{"id":"plg3","props":{"__kind":"nodot"},"type":"pluginLayer:nodot"}')).toBeUndefined();
  expect((await h.query({ type: 'getLayers', layers: [s.A] })).layers[0]!.pluginSchemaVersion).toBeUndefined();
});
