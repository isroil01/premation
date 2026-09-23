/**
 * B4: the document mirror equals a fresh `getDocument` after EVERY revision,
 * on both backends (NATIVE_CORE_PLAN §5 B4, ENGINE_API.md §8).
 *
 * The same session — creates, property writes, keys, batches, a drag gesture
 * (committed and cancelled), undo / redo / jumpToHistory, markers, work area,
 * a second composition, New Project (documentReset) — is driven through
 *   - the TypeScript engine, with the in-process sync fast path (querySync),
 *   - the TypeScript engine, async only (the buffering / gap / refetch paths),
 *   - the C++ engine process through `ProcessEngineClient` (skipped when
 *     `premation-engine` is not built), plus an engine kill → restart →
 *     documentReset{engineRestarted}.
 * After every request the mirror is compared with the engine's own answers:
 * revision, layers, compositions (settings, order, markers), items, project
 * settings, render queue, every keyframe list, every retained property tree,
 * history — and `valueAt` with `getPropertyValues`.
 *
 * The TypeScript runs also cover writes made AROUND the engine (a legacy
 * writer): attributed ones arrive as an incremental engine-origin batch,
 * unattributed ones as documentReset{resync} — on the next microtask, not at
 * the next request.
 */

import {
  ProcessEngineClient,
  unwrap,
  type Command,
  type EngineClient,
  type QueryOf,
  type QueryResults,
  type QueryType,
  type EngineResult,
  type Keyframe,
} from '@motion/engine-api';
import { DocumentMirror, type MirrorSource } from '@stores/documentMirror';
import { setupEngine, sec, type Harness } from '../__testHelpers__/harness';
import { nativeEngineExe, startNativeEngine } from '../__testHelpers__/nativeEngine';
import { getEventBus } from '@core/events/EventBus';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { isWriteAroundEngine } from '../externalWrites';
import { LEGACY_DEBOUNCE_RECORDER } from '@stores/historyStore';

// Real timers for the engine process's supervisor (captured before faking).
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
jest.useFakeTimers();

type Client = Pick<EngineClient, 'query' | 'subscribe' | 'execute' | 'batch' | 'beginGesture' | 'endGesture' | 'undo' | 'redo'>;

interface Driver {
  client: Client;
  /** Wait until the mirror has every event the engine sent and no fetch is in flight. */
  settle(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => realSetTimeout(r, ms));

async function waitFor(pred: () => boolean, what: string, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(2);
  }
}

/** Every mismatch between the mirror and the engine's queries. */
async function mirrorDiff(m: DocumentMirror, c: Client): Promise<string[]> {
  const out: string[] = [];
  const d = unwrap(await c.query({ type: 'getDocument', includeProperties: false, includeKeyframes: true }));
  if (m.revision !== d.revision) out.push(`revision ${m.revision} ≠ ${d.revision}`);
  if (m.dirty !== d.dirty) out.push(`dirty ${m.dirty} ≠ ${d.dirty}`);
  if (m.projectPath !== d.projectPath) out.push(`projectPath '${m.projectPath}' ≠ '${d.projectPath}'`);
  const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  if (!eq(m.settings, d.settings)) out.push('project settings differ');
  if (!eq([...m.layerIds()].sort(), d.layers.map((l) => l.id).sort())) out.push(`layer ids [${[...m.layerIds()].sort()}] ≠ [${d.layers.map((l) => l.id).sort()}]`);
  for (const l of d.layers) if (!eq(m.layer(l.id), l)) out.push(`layer ${l.id}: ${JSON.stringify(m.layer(l.id))?.slice(0, 200)} ≠ ${JSON.stringify(l).slice(0, 200)}`);
  if (!eq([...m.compIds].sort(), d.comps.map((x) => x.id).sort())) out.push(`comps [${[...m.compIds]}] ≠ [${d.comps.map((x) => x.id)}]`);
  for (const comp of d.comps) {
    const mc = m.comp(comp.id);
    if (!mc) { out.push(`comp ${comp.id} missing`); continue; }
    if (!eq(mc.settings, comp.settings)) out.push(`comp ${comp.id} settings differ`);
    if (!eq(mc.layers, comp.layers)) out.push(`comp ${comp.id} order [${mc.layers}] ≠ [${comp.layers}]`);
    if (!eq(mc.markers, comp.markers)) out.push(`comp ${comp.id} markers differ`);
  }
  const items = new Map(d.items.map((i) => [i.id, i]));
  if (!eq([...m.items.keys()].sort(), [...items.keys()].sort())) out.push('item ids differ');
  for (const [id, i] of items) if (!eq(m.item(id), i)) out.push(`item ${id} differs`);
  if (!eq(m.renderQueue, d.renderQueue)) out.push('render queue differs');
  const keys = new Map<string, Keyframe[]>();
  for (const s of d.keyframes) if (s.keyframes.length) keys.set(`${s.prop.layer}|${s.prop.path}`, s.keyframes);
  const mk = new Map<string, readonly Keyframe[]>();
  for (const id of m.layerIds()) for (const [p, k] of m.layerKeyframes(id)) mk.set(`${id}|${p}`, k);
  for (const [k, v] of keys) if (!eq(mk.get(k), v)) out.push(`keys ${k}: ${JSON.stringify(mk.get(k))?.slice(0, 160)} ≠ ${JSON.stringify(v).slice(0, 160)}`);
  for (const k of mk.keys()) if (!keys.has(k)) out.push(`keys ${k} in the mirror only`);
  for (const layer of m.loadedTreeLayers()) {
    const t = await c.query({ type: 'getPropertyTree', layer, path: '', depth: 0 });
    if (!t.ok) { out.push(`tree ${layer}: engine says ${t.error.code}`); continue; }
    const mt = m.tree(layer)!;
    const want = new Map(t.value.nodes.map((n) => [n.path, n]));
    if (!eq([...mt.nodes.keys()].sort(), [...want.keys()].sort())) {
      const a = new Set(mt.nodes.keys());
      const b = new Set(want.keys());
      out.push(`tree ${layer} paths: mirror-only [${[...a].filter((x) => !b.has(x))}] engine-only [${[...b].filter((x) => !a.has(x))}]`);
    }
    for (const [p, n] of want) if (!eq(mt.nodes.get(p), n)) out.push(`tree ${layer} ${p}: ${JSON.stringify(mt.nodes.get(p))?.slice(0, 200)} ≠ ${JSON.stringify(n).slice(0, 200)}`);
    const roots = t.value.nodes.filter((n) => !n.path.includes('/')).map((n) => n.path);
    if (!eq(mt.roots, roots)) out.push(`tree ${layer} roots [${mt.roots}] ≠ [${roots}]`);
    // Values at a time equal the engine's evaluated values.
    const animated = t.value.nodes.filter((n) => n.kind === 'property' && n.animated).map((n) => n.path);
    if (animated.length) {
      const time = sec(0.5);
      const v = unwrap(await c.query({ type: 'getPropertyValues', props: animated.map((path) => ({ layer, path })), time, evaluated: true }));
      for (const pv of v.values) {
        m.valueAt(layer, pv.prop.path, time);
        await m.whenIdle();
        if (!eq(m.valueAt(layer, pv.prop.path, time), pv.value)) out.push(`valueAt ${layer} ${pv.prop.path}: ${JSON.stringify(m.valueAt(layer, pv.prop.path, time))} ≠ ${JSON.stringify(pv.value)}`);
      }
    }
  }
  const h = await c.query({ type: 'getHistory' });
  if (h.ok && m.history && !eq(m.history.state, h.value)) out.push(`history ${JSON.stringify(m.history.state).slice(0, 200)} ≠ ${JSON.stringify(h.value).slice(0, 200)}`);
  return out;
}

/**
 * The session. Every step is one request; after each, the mirror must equal
 * the engine. `ids` are whatever the engine minted (the two engines mint
 * different ones).
 */
async function runSession(d: Driver, m: DocumentMirror, label: string, extra?: (step: (name: string, fn: () => Promise<unknown>) => Promise<void>, ids: Record<string, string>) => Promise<void>): Promise<number> {
  const c = d.client;
  let steps = 0;
  const check = async (name: string): Promise<void> => {
    await d.settle();
    const diff = await mirrorDiff(m, c);
    expect([label, name, diff]).toEqual([label, name, []]);
    steps += 1;
  };
  const step = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
    await fn();
    await check(name);
  };
  const ok = async <T>(p: Promise<EngineResult<T>>): Promise<T> => {
    const r = await p;
    if (!r.ok) throw new Error(`${label}: ${JSON.stringify(r.error)}`);
    return r.value;
  };

  await check('initial');
  const comp = m.compIds[0]!;
  const ids: Record<string, string> = {};
  await step('create solid', async () => { ids.A = (await ok(c.execute({ type: 'createLayer', comp, kind: 'solid', name: 'A', init: [] }))).layer; });
  await step('create shape', async () => { ids.B = (await ok(c.execute({ type: 'createLayer', comp, kind: 'shape', name: 'B', init: [] }))).layer; });
  await step('create text', async () => { ids.T = (await ok(c.execute({ type: 'createLayer', comp, kind: 'text', name: 'T', init: [] }))).layer; });
  await step('create null', async () => { ids.N = (await ok(c.execute({ type: 'createLayer', comp, kind: 'null', name: 'N', init: [] }))).layer; });
  // Retain trees: the property events apply to them from here on.
  const releases = [ids.A!, ids.B!, ids.T!].map((l) => m.retainTree(l));
  await check('trees retained');
  await step('rename', () => ok(c.execute({ type: 'renameLayer', layer: ids.A!, name: 'Alpha' })));
  await step('static rotation', () => ok(c.execute({ type: 'setProperty', prop: { layer: ids.A!, path: 'transform/rotation' }, value: { kind: 'scalar', value: 30 } })));
  await step('keys on position', () => ok(c.execute({
    type: 'addKeyframes',
    keys: [
      { prop: { layer: ids.B!, path: 'transform/position' }, time: 0, value: { kind: 'vec2', value: { x: 100, y: 100 } }, spatialIn: [], spatialOut: [] },
      { prop: { layer: ids.B!, path: 'transform/position' }, time: sec(1), value: { kind: 'vec2', value: { x: 300, y: 200 } }, spatialIn: [], spatialOut: [] },
    ],
  })));
  await step('batch: switches + opacity', () => ok(c.batch('Tweak', [
    { type: 'setLayerSwitches', layers: [ids.A!, ids.B!], patch: { locked: true, label: 3 } },
    { type: 'setProperty', prop: { layer: ids.T!, path: 'transform/opacity' }, value: { kind: 'scalar', value: 40 } },
  ] as Command[])));
  // A drag: one gesture, many coalesced writes, then commit.
  const g = await ok(c.beginGesture('Drag'));
  for (let i = 1; i <= 6; i++) {
    await step(`drag ${i}`, () => ok(c.execute({ type: 'setProperty', prop: { layer: ids.A!, path: 'transform/position' }, value: { kind: 'vec2', value: { x: 100 + i * 10, y: 50 } } })));
  }
  await step('drag end (commit)', () => ok(c.endGesture(g.gesture, true)));
  // A drag cancelled with Esc: the document returns exactly.
  const g2 = await ok(c.beginGesture('Drag'));
  await step('drag 2 move', () => ok(c.execute({ type: 'setProperty', prop: { layer: ids.A!, path: 'transform/rotation' }, value: { kind: 'scalar', value: 90 } })));
  await step('drag 2 cancel', () => ok(c.endGesture(g2.gesture, false)));
  await step('reorder', () => ok(c.execute({ type: 'reorderLayers', comp, layers: [ids.N!], toIndex: 0 })));
  await step('parent', () => ok(c.execute({ type: 'setParent', layers: [ids.A!], parent: ids.N!, keepWorldTransform: true })));
  await step('comp marker', () => ok(c.execute({ type: 'addMarkers', markers: [{ owner: { comp }, time: sec(2), duration: 0, name: 'M1', comment: '', label: 0 }] })));
  await step('work area', () => ok(c.execute({ type: 'setWorkArea', comp, range: { start: sec(1), duration: sec(2) } })));
  await step('undo', () => ok(c.undo()));
  await step('undo', () => ok(c.undo()));
  await step('redo', () => ok(c.redo()));
  const hist = await ok(c.query({ type: 'getHistory' }));
  await step('jump back 4', () => ok(c.execute({ type: 'jumpToHistory', position: Math.max(0, hist.position - 4) })));
  await step('jump forward', () => ok(c.execute({ type: 'jumpToHistory', position: hist.position })));
  await step('delete a layer', () => ok(c.execute({ type: 'deleteLayers', layers: [ids.T!] })));
  await step('undo delete', () => ok(c.undo()));
  await step('second comp', async () => { ids.C2 = (await ok(c.execute({ type: 'createComposition', settings: { name: 'C2', width: 640, height: 360 }, fromItems: [] }))).item; });
  await step('layer in C2', async () => { ids.C2L = (await ok(c.execute({ type: 'createLayer', comp: ids.C2!, kind: 'solid', name: 'in C2', init: [] }))).layer; });
  if (extra) await extra(step, ids);
  await step('new project (documentReset)', () => ok(c.execute({ type: 'newProject' })));
  for (const r of releases) r();
  return steps;
}

// ── TypeScript engine ────────────────────────────────────────────────────

let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

function tsSource(harness: Harness, sync: boolean): MirrorSource {
  const e = harness.engine;
  return {
    subscribe: (l) => e.subscribe(l),
    query: <T extends QueryType>(q: QueryOf<T>): Promise<EngineResult<QueryResults[T]>> => e.query(q),
    ...(sync ? { querySync: <T extends QueryType>(q: QueryOf<T>) => e.querySync(q) } : {}),
  };
}

const legacyWrites = async (step: (name: string, fn: () => Promise<unknown>) => Promise<void>, ids: Record<string, string>): Promise<void> => {
  const batches: boolean[] = [];
  const off = h!.engine.subscribe((b) => { if (b.fromRevision !== b.toRevision) batches.push(isWriteAroundEngine(b)); });
  // Attributed: a node written around the engine + the bus naming it.
  await step('legacy write (attributed)', async () => {
    const n = defaultSceneGraph.getNode(ids.A!)!;
    n.name = 'Renamed around the engine';
    getEventBus().emit('NodeUpdated', { nodeId: ids.A!, componentId: '', propName: 'name', value: n.name });
  });
  // Unattributed: the mirror refetches.
  await step('legacy write (unattributed)', async () => {
    const n = defaultSceneGraph.getNode(ids.B!)!;
    n.name = 'Also renamed';
    getEventBus().emit('SceneGraphChanged', undefined);
  });
  off();
  expect(batches.filter(Boolean).length).toBe(2);
};

test('TypeScript engine, in-process fast path: the mirror equals getDocument after every revision', async () => {
  h = await setupEngine();
  const m = new DocumentMirror(tsSource(h, true)).start();
  expect(m.status).toBe('ready'); // synchronous initial load
  const d: Driver = { client: h.engine, settle: async () => { await h!.engine.whenIdle(); await m.whenIdle(); } };
  const n = await runSession(d, m, 'ts-sync', legacyWrites);
  expect(n).toBeGreaterThan(30);
  m.stop();
});

test('TypeScript engine, async only: buffering, refetch and tree loads converge', async () => {
  h = await setupEngine();
  const m = new DocumentMirror(tsSource(h, false)).start();
  expect(m.status).toBe('loading');
  const d: Driver = {
    client: h.engine,
    settle: async () => {
      await h!.engine.whenIdle();
      for (let i = 0; i < 5; i++) { await m.whenIdle(); await Promise.resolve(); }
    },
  };
  await d.settle();
  const n = await runSession(d, m, 'ts-async', legacyWrites);
  expect(n).toBeGreaterThan(30);
  m.stop();
});

test('the mirror notifies once per batch, and a restated record keeps its identity', async () => {
  h = await setupEngine();
  const m = new DocumentMirror(tsSource(h, true)).start();
  const comp = m.compIds[0]!;
  const A = unwrap(await h.engine.execute({ type: 'createLayer', comp, kind: 'solid', name: 'A', init: [] })).layer;
  const B = unwrap(await h.engine.execute({ type: 'createLayer', comp, kind: 'solid', name: 'B', init: [] })).layer;
  m.retainTree(A);
  m.retainTree(B);
  const headerB = m.layer(B);
  const treeB = m.tree(B);
  let aCalls = 0;
  let bCalls = 0;
  m.subscribe([`layer:${A}`, `prop:${A}|transform/rotation`, `tree:${A}`], () => { aCalls += 1; });
  m.subscribe([`layer:${B}`, `tree:${B}`], () => { bCalls += 1; });
  await h.engine.execute({ type: 'setProperty', prop: { layer: A, path: 'transform/rotation' }, value: { kind: 'scalar', value: 12 } });
  expect(aCalls).toBe(1); // several keys matched, one call
  expect(bCalls).toBe(0);
  expect(m.layer(B)).toBe(headerB);
  expect(m.tree(B)).toBe(treeB);
  expect(m.property(A, 'transform/rotation')?.value).toEqual({ kind: 'scalar', value: 12 });
  m.stop();
});

test('engine edits keep exact undo with the legacy debounce recorder switched off', async () => {
  LEGACY_DEBOUNCE_RECORDER.enabled = false;
  try {
    h = await setupEngine();
    const m = new DocumentMirror(tsSource(h, true)).start();
    const comp = m.compIds[0]!;
    const A = unwrap(await h.engine.execute({ type: 'createLayer', comp, kind: 'solid', name: 'A', init: [] })).layer;
    const g = unwrap(await h.engine.beginGesture('Drag'));
    for (let i = 0; i < 5; i++) unwrap(await h.engine.execute({ type: 'setProperty', prop: { layer: A, path: 'transform/rotation' }, value: { kind: 'scalar', value: i * 10 } }));
    unwrap(await h.engine.endGesture(g.gesture, true));
    expect(m.history?.state.entries.map((e) => e.label)).toEqual(['Create Layer', 'Drag']);
    unwrap(await h.engine.undo());
    expect(m.property(A, 'transform/rotation')?.value).toEqual({ kind: 'scalar', value: 0 });
    jest.advanceTimersByTime(2000); // nothing debounced is pending: no extra entry appears
    expect(m.history?.state.entries.length).toBe(2);
    m.stop();
  } finally {
    LEGACY_DEBOUNCE_RECORDER.enabled = true;
  }
});

// ── C++ engine process ───────────────────────────────────────────────────

const describeNative = nativeEngineExe() ? describe : describe.skip;
if (!nativeEngineExe()) console.warn('[B4 mirror] premation-engine is not built — `node scripts/native.mjs build --engine`; the C++ run is skipped.');

describeNative('C++ engine process', () => {
  test('the mirror equals getDocument after every revision, across an engine restart', async () => {
    const native = await startNativeEngine();
    const c = new ProcessEngineClient(native.bridge);
    try {
      await c.whenReady();
      unwrap(await c.execute({ type: 'newProject' }));
      const m = new DocumentMirror({ subscribe: (l) => c.subscribe(l), query: (q) => c.query(q) }).start();
      const d: Driver = {
        client: c,
        settle: async () => {
          await waitFor(() => m.revision >= c.revision || m.status !== 'ready', 'the mirror to reach the response revision');
          for (let i = 0; i < 5; i++) { await m.whenIdle(); await sleep(1); }
        },
      };
      await d.settle();
      const n = await runSession(d, m, 'c++', async (step, ids) => {
        // Kill the engine: it restarts, replays the command log, and the mirror
        // refetches on documentReset{engineRestarted}.
        const before = m.generation;
        const layer = ids.A!;
        m.retainTree(layer);
        await step('engine restart', async () => {
          native.kill();
          await waitFor(() => m.generation > before, 'the mirror to refetch after the restart', 20000);
          await c.whenReady();
        });
        expect(m.layer(layer)).toBeDefined();
      });
      expect(n).toBeGreaterThan(30);
      m.stop();
    } finally {
      await c.close();
      await native.stop();
    }
  }, 120_000);
});
