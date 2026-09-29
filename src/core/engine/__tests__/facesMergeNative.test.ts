/**
 * B4 round 8 on the REAL `premation-engine`: face picking's geometry
 * (`getLayerFaces`), Live Merge Paths (`createLiveMerge`) and the legacy
 * precomp group upgrade (`migrateLegacyPrecomps`).
 *
 * Skipped, saying so, when the engine binary is not built.
 */

import { ProcessEngineClient, unwrap, type EngineClient } from '@motion/engine-api';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '../__testHelpers__/nativeEngine';
import { projectWorldFaces, pickFace, type WorldFace } from '@core/scene/facePicking';
import { Project3D } from '@motion/scene';

jest.setTimeout(120_000);

const exe = nativeEngineExe();
const full = !!exe && !/headless/i.test(exe);
if (!full) console.log('[faces / merge native] the full premation-engine is not built — skipped');
const maybe = full ? describe : describe.skip;

maybe('faces, live merge and legacy precomps on the real engine', () => {
  let native: NativeEngine;
  let client: EngineClient;

  beforeAll(async () => {
    native = await startNativeEngine({ extraArgs: [] }); // with the GPU: the frame builder (faces, polygon booleans)
    const c = new ProcessEngineClient(native.bridge);
    await c.whenReady();
    client = c;
  });
  afterAll(async () => {
    await native?.stop();
  });

  const newComp = async (name: string) =>
    unwrap(await client.execute({ type: 'createComposition', settings: { name, width: 1920, height: 1080 }, fromItems: [] })).item;

  it('answers an extruded 3D layer\'s faces in world px, pickable through the view camera', async () => {
    const comp = await newComp('Faces');
    const box = unwrap(await client.execute({ type: 'createLayer', comp, kind: 'rectangle', name: 'Box', init: [] })).layer;
    unwrap(await client.execute({ type: 'setLayerSwitches', layers: [box], patch: { threeD: true } }));
    const flat = unwrap(await client.query({ type: 'getLayerFaces', layer: box, time: 0 })).faces;
    expect(flat).toEqual([]);
    unwrap(await client.execute({ type: 'setProperties', writes: [{ prop: { layer: box, path: 'geometry/extrusionDepth' }, value: { kind: 'scalar', value: 60 } }] }));
    const faces = unwrap(await client.query({ type: 'getLayerFaces', layer: box, time: 0 })).faces;
    expect(faces.length).toBeGreaterThan(4);
    const kinds = new Set(faces.map((f) => f.kind));
    expect(kinds.has('front')).toBe(true);
    expect(kinds.has('side')).toBe(true);
    // The front cap sits on the layer's plane (z 0) around its position (the comp centre).
    const front = faces.filter((f) => f.kind === 'front').flatMap((f) => f.points);
    expect(Math.min(...front.map((p) => p.z))).toBeCloseTo(0, 3);
    const xs = front.map((p) => p.x);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(960, 0);
    // Projected through the default camera, a click at the comp centre picks the front.
    const world: WorldFace[] = faces.map((f) => ({
      kind: f.kind as WorldFace['kind'], suffix: f.suffix, points: f.points,
      ...(f.verts.length === 3 ? { verts: [f.verts[0]!, f.verts[1]!, f.verts[2]!] as const } : {}),
    }));
    const cam = Project3D.defaultCamera(1920, 1080);
    const picked = pickFace(projectWorldFaces(world, (p) => Project3D.projectPoint(p, cam)), { x: 960, y: 540 });
    expect(picked?.kind).toBe('front');
  });

  it('creates a live boolean of two overlapping rectangles as one entry; the operands flagged and hidden', async () => {
    const comp = await newComp('Merge');
    const a = unwrap(await client.execute({ type: 'createLayer', comp, kind: 'rectangle', name: 'A', init: [{ path: 'transform/position', value: { kind: 'vec2', value: { x: 900, y: 540 } } }] })).layer;
    const b = unwrap(await client.execute({ type: 'createLayer', comp, kind: 'rectangle', name: 'B', init: [{ path: 'transform/position', value: { kind: 'vec2', value: { x: 1020, y: 540 } } }] })).layer;
    const before = unwrap(await client.query({ type: 'getHistory' })).entries.length;
    const res = unwrap(await client.execute({ type: 'createLiveMerge', layers: [a, b], op: 'union' }));
    const info = unwrap(await client.query({ type: 'getLayers', layers: [res.layer, a, b] })).layers;
    expect(info[0]!.name).toBe('Boolean (union)');
    expect(info[1]!.switches.visible).toBe(false);
    expect(info[2]!.switches.visible).toBe(false);
    const history = unwrap(await client.query({ type: 'getHistory' })).entries;
    expect(history.length).toBe(before + 1);
    expect(history.at(-1)!.label).toBe('Live Merge Paths (union)');
    // One path only: refused, nothing written.
    const one = await client.execute({ type: 'createLiveMerge', layers: [a], op: 'union' });
    expect(one.ok).toBe(false);
    unwrap(await client.execute({ type: 'undo' }));
    const back = unwrap(await client.query({ type: 'getLayers', layers: [a] })).layers[0]!;
    expect(back.switches.visible).toBe(true);
  });

  it('migrates nothing (and records no entry) on a document with no legacy precomp groups', async () => {
    const before = unwrap(await client.query({ type: 'getHistory' })).entries.length;
    const res = unwrap(await client.execute({ type: 'migrateLegacyPrecomps' }));
    expect(res.items).toEqual([]);
    expect(unwrap(await client.query({ type: 'getHistory' })).entries.length).toBe(before);
  });
});
