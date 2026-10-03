/**
 * OWNER-WRITE AUDIT (B4 round 8, release blocker): in the app the C++ engine
 * owns the document and the page's TypeScript engine is its replica
 * (ownedEngineClient.ts forwards owner → replica only). A feature that writes
 * the page engine directly changes nothing the engine saves, renders or
 * exports.
 *
 * Each case runs one user-facing feature in an OWNER session — `engine()` is
 * the OwnedEngineClient over the REAL premation-engine, the LocalEngine app
 * harness its replica — and compares the two documents afterwards
 * (getDocument with properties and keyframes):
 *
 *   'owner'        the feature reached the engine: owner == replica, and the
 *                  owner changed;
 *   'replica-only' KNOWN not to reach the engine yet: the documents differ.
 *                  The case fails the day it starts reaching the engine, so
 *                  the list is kept honest (move it to 'owner').
 *
 * After every case the replica is refreshed from the owner, so one feature's
 * drift never leaks into the next.
 *
 * Skipped, saying so, when the engine is not built.
 */

import { unwrap, type DocumentSnapshot, type EngineClient } from '@motion/engine-api';
import { CommandSystem, setCommandSystem } from '@core/commands/CommandSystem';
import type { CommandServices } from '@core/commands/Command';
import { getEventBus } from '@core/events/EventBus';
import { getTimelineController } from '@core/timeline/TimelineController';
import { resetSnapshotSharing } from '@core/commands/snapshotSharing';
import { documentMirror } from '@stores/documentMirror';
import { useSelectionStore } from '@stores/selectionStore';
import type { EditorDocument } from '@core/api/cloudDocument';
import { runAnimEdit } from '@core/animation/animationCommands';
import { easyEaseAll, timeReverseKeyframes } from '@core/animation/keyframeAssistants';
import { applyExponentialScale } from '@core/animation/exponentialScale';
import { convertExpressionToKeyframes } from '@core/animation/convertExpressionToKeyframes';
import { addExpression, removeExpression } from '@core/animation/expressionCommands';
import { commandStaggerParams, runChoreography } from '@core/animation/choreographyCommands';
import { set3DEnabled } from '@core/scene/threeD';
import { reparentNode } from '@core/scene/parenting';
import { applyStretch } from '@core/animation/layerTimeCommands';
import { createOrbitNullEdit } from '@core/scene/cameraCommands';
import { importGltfModel } from '@core/scene/modelImport';
import { importModelEdit } from '@layout/Assets/modelImportEdits';
import { buildQuadGlb } from '@/__testHelpers__/buildTestGlb';
import { createMulticamEdit } from '@layout/Multicam/multicamEdits';
import { itemAssetsOf } from '@core/mirror/itemAssets';
import { stylePresetCommands } from '@layout/Inspector/StylePresetsSection';
import { STYLE_PRESETS } from '@core/style/stylePresets';
import { essentialPropMenuItems } from '@core/inspector/propertyMenu';
import { insertBuiltLayers } from '@core/engine/offDocument';
import { insertPrimitive } from '@core/scene/sceneInsert';
import { activeCompRootId } from '@core/scene/activeComp';
import { edit } from '@core/engine/uiEdits';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A 1×1 PNG. */
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
import { bootEngine, engine, localEngine, ownedEngine, refreshReplicaFromEngine, shutdownEngine } from '../engineInstance';
import { resetEngineOwnership, setEngineOwnsDocument } from '../engineOwnership';
import { resetProcessEngine } from '../process/processEngine';
import { fakePorts } from '../__testHelpers__/harness';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '../__testHelpers__/nativeEngine';

jest.setTimeout(180_000);

const U = URL as unknown as { revokeObjectURL?: (u: string) => void; createObjectURL?: (b: unknown) => string };
U.revokeObjectURL ??= () => {};
U.createObjectURL ??= () => 'blob:test';

type Content = Omit<DocumentSnapshot, 'revision' | 'dirty' | 'projectPath'>;

async function contentOf(c: EngineClient, ignoreItems = false): Promise<string> {
  const d = unwrap(await c.query({ type: 'getDocument', includeProperties: true, includeKeyframes: true }));
  const { revision: _r, dirty: _d, projectPath: _p, ...rest } = d;
  // Footage metadata the page cannot probe (a still's size) differs by design; the layers must not.
  const items = ignoreItems ? { items: rest.items.filter((i) => i.kind !== 'footage') } : {};
  return JSON.stringify({ ...rest, ...items } as Content);
}

const sec = (s: number): number => Math.round(s * 705_600_000);

interface Layers { comp: string; a: string; b: string }

type Expect = 'owner' | 'replica-only';

/** One feature and how it is reached from the UI. */
interface AuditCase {
  name: string;
  expect: Expect;
  run: (l: Layers, prepared?: unknown) => void | Promise<unknown>;
  /** Compare without footage items (their probed metadata is the owner's alone). */
  ignoreItems?: boolean;
  /** Engine-side setup before the comparison starts (the replica is then refreshed from the owner). */
  setup?: (l: Layers) => Promise<unknown>;
}

const CASES: AuditCase[] = [
  // ── page-history animation edits (runAnimEdit / recordAnimEdit): the bridge ──
  { name: 'Easy Ease (keyframe assistant)', expect: 'owner', run: ({ a }) => runAnimEdit('Easy Ease', () => { easyEaseAll(a); }) },
  { name: 'Time-Reverse Keyframes', expect: 'owner', run: ({ a }) => runAnimEdit('Time-Reverse Keyframes', () => { timeReverseKeyframes(a); }) },
  { name: 'Exponential Scale', expect: 'owner', run: ({ a }) => applyExponentialScale(a) },
  { name: 'Add Expression', expect: 'owner', run: ({ b }) => addExpression([{ nodeId: b, prop: 'rotation' }], { openEditor: false }) },
  { name: 'Remove Expression', expect: 'owner', run: ({ a }) => removeExpression([{ nodeId: a, prop: 'rotation' }]) },
  { name: 'Convert Expression to Keyframes', expect: 'owner', run: ({ b }) => convertExpressionToKeyframes(b, ['opacity']) },
  // runAnimEdit that also writes node props (static values): the whole run goes off-document.
  { name: 'runAnimEdit writing a switch, a parent and a static value', expect: 'owner', run: ({ a, b }) => runAnimEdit('Mixed', () => { set3DEnabled(b, true); reparentNode(b, a); }) },
  // ── palette commands with their own engine path ──
  { name: 'Create Orbit Null (camera palette command)', expect: 'owner', run: async ({ comp }) => {
    const cam = unwrap(await engine().execute({ type: 'createLayer', comp, kind: 'camera', name: 'Cam', init: [] })).layer;
    await localEngine()!.whenIdle();
    const id = await createOrbitNullEdit(cam, 0);
    expect(id).not.toBeNull();
  } },
  // ── layer builders: off-document, one pasteLayers ──
  { name: 'Import 3D Model (glTF — AssetsPanel / File ▸ Import 3D Model)', expect: 'owner', run: async () => {
    const bytes = buildQuadGlb();
    const r = await importModelEdit('Import quad.glb', () => importGltfModel(bytes, 'quad.glb'));
    expect(r?.layerCount).toBeGreaterThan(0);
  } },
  { name: 'Import 3D Model called directly (the old path)', expect: 'replica-only', run: () => {
    importGltfModel(buildQuadGlb(), 'quad.glb');
  } },
  { name: 'New Multicam from Library (palette command)', expect: 'owner', ignoreItems: true,
    // Importing footage is its own feature (the replica cannot probe a still's size): done first, then compared from.
    setup: async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'premation-audit-'));
      const files = [0, 1].map((i) => {
        const f = path.join(dir, `angle${i}.png`);
        writeFileSync(f, Buffer.from(PNG_1PX, 'base64'));
        return { path: f, asSequence: false, createComposition: false };
      });
      return unwrap(await engine().execute({ type: 'importFiles', files })).items;
    },
    run: async (_l, prepared) => {
      await documentMirror().whenIdle();
      const assets = itemAssetsOf(documentMirror(), prepared as string[]);
      const comp = await createMulticamEdit(assets);
      expect(comp).not.toBeNull();
      const layers = unwrap(await ownedEngine()!.query({ type: 'getComposition', comp: comp! })).comp.layers;
      const infos = unwrap(await ownedEngine()!.query({ type: 'getLayers', layers })).layers;
      expect(infos.map((l) => l.multicamAngle).sort()).toEqual([1, 2]);
    } },
  // ── inspector / menu edits built as engine commands ──
  { name: 'Style preset (Inspector ▸ Style Presets)', expect: 'owner', run: async ({ a }) => {
    const plan = stylePresetCommands(a, undefined, STYLE_PRESETS[0]!, '#3366ff', 0);
    expect(plan.cmds.length).toBeGreaterThan(0);
    expect((await edit('Apply Style', plan.cmds)).ok).toBe(true);
  } },
  { name: 'Animation preset (Presets panel / viewport drop: applyPreset at the playhead)', expect: 'owner', run: async ({ b }) => {
    // What MotionPresetsPanel.apply sends: "Pop In" (scale 0→full over 0.5 s, opacity 0→100 over 0.3 s) at 1 s.
    expect((await edit('Apply animation preset', { type: 'applyPreset', layers: [b], preset: 'Pop In', time: sec(1) })).ok).toBe(true);
    const doc = unwrap(await ownedEngine()!.query({ type: 'getDocument', includeProperties: false, includeKeyframes: true }));
    const times = (path: string): number[] =>
      (doc.keyframes.find((k) => k.prop.layer === b && k.prop.path === path)?.keyframes ?? []).map((k) => k.time);
    // In the ENGINE's document, on the comp-time axis the playhead is on (the layer starts at 0).
    expect(times('layer/scale')).toEqual([sec(1), sec(1.5)]);
    expect(times('transform/opacity')).toEqual([sec(1), sec(1.3)]);
  } },
  { name: 'Add to Essential Properties (property row menu)', expect: 'owner', run: async ({ a }) => {
    const item = essentialPropMenuItems(a, 'opacity').find((i) => i.id === 'essential-toggle');
    expect(item).toBeDefined();
    (item as { onSelect: () => void }).onSelect();
  } },
  { name: 'Insert shape layer (Library / Layer ▸ New, off-document)', expect: 'owner', run: async () => {
    // Into the ACTIVE composition, as the menu does (insertPrimitive places in it).
    const ids = await insertBuiltLayers('New Shape Layer', activeCompRootId(), () => insertPrimitive('shape', 'Shape'));
    expect(ids?.length).toBe(1);
  } },
  // ── The three page scene-graph writers, called DIRECTLY (still replica-only by nature). Every user-facing
  //    caller is on an engine path (audited 2026-09-29): set3DEnabled — the Timeline / Layers 3D switch sends
  //    setLayerSwitches (toggleLayerFlagEdit), presets send applyPreset, the AI's model null is built
  //    off-document, the page engine's own handlers are the replica applying a forwarded request;
  //    reparentNode — the parent pick-whip / Layers drag send setParent, Lottie builds a fragment, the page
  //    Create Orbit Null is the TS-owner path only; applyStretch — Time Stretch sends setLayerTiming /
  //    timeStretchLayers (layerTimeCommands in providers). Inside runAnimEdit they reach the engine (above).)
  { name: 'Animate In (choreography, engine edits since bcb9b64a)', expect: 'owner', run: ({ a, b }) => runChoreography({ kind: 'in', nodeIds: [a, b], params: commandStaggerParams('in', [a, b], 30) }) },
  { name: 'threeD.set3DEnabled called directly (helper)', expect: 'replica-only', run: ({ b }) => set3DEnabled(b, true) },
  { name: 'parenting.reparentNode called directly (helper)', expect: 'replica-only', run: ({ a, b }) => reparentNode(b, a) },
  { name: 'layerTimeCommands.applyStretch (helper)', expect: 'replica-only', run: ({ a }) => applyStretch([a], 200) },
];

const run = !!nativeEngineExe();
if (!run) console.log('[owner-write audit] premation-engine is not built — skipped');
const maybe = run ? describe : describe.skip;

maybe('owner-write audit: features reach the engine that owns the document', () => {
  let native: NativeEngine;
  let subs: Array<{ dispose(): void }> = [];
  let layers: Layers;
  const findings: string[] = [];

  const settle = async (): Promise<void> => {
    // Bridged edits are sent asynchronously; let them reach the owner and the replica.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 20));
      await localEngine()!.whenIdle();
      await documentMirror().whenIdle();
    }
  };

  beforeAll(async () => {
    native = await startNativeEngine();
    (window as unknown as { motionEditor?: unknown }).motionEditor = { engine: native.bridge };
    await shutdownEngine();
    setCommandSystem(new CommandSystem({ services: {} as CommandServices, getState: () => ({}) }));
    resetSnapshotSharing();
    subs = [getEventBus().on('SceneGraphChanged', () => getTimelineController().syncFromScene())];
    setEngineOwnsDocument(true);
    bootEngine({ ports: fakePorts(new Map<string, EditorDocument>()), ownsDocument: true });
    expect(ownedEngine()).not.toBeNull();
  });
  afterAll(async () => {
    console.log(`[owner-write audit]\n${findings.join('\n')}`);
    await shutdownEngine();
    await resetProcessEngine();
    resetEngineOwnership();
    for (const s of subs) s.dispose();
    subs = [];
    delete (window as unknown as { motionEditor?: unknown }).motionEditor;
    await native.stop();
  });

  beforeEach(async () => {
    const e = engine();
    unwrap(await e.execute({ type: 'newProject' }));
    const comp = unwrap(await e.execute({ type: 'createComposition', settings: { name: 'Audit', width: 1280, height: 720, frameRate: { num: 30, den: 1 } }, fromItems: [] })).item;
    const a = unwrap(await e.execute({ type: 'createLayer', comp, kind: 'rectangle', name: 'A', init: [] })).layer;
    const b = unwrap(await e.execute({ type: 'createLayer', comp, kind: 'rectangle', name: 'B', init: [] })).layer;
    const scalar = (value: number) => ({ kind: 'scalar' as const, value });
    unwrap(await e.execute({ type: 'setKeyframes', prop: { layer: a, path: 'transform/opacity' }, keys: [0, 0.5, 1, 1.5].map((t, i) => ({ id: '', time: sec(t), value: scalar(i % 2 ? 100 : 20), easing: 'linear' as const, continuous: false, roving: false, spatialInterp: 'legacy' as const, spatialIn: [], spatialOut: [], label: 0, dims: [] })) }));
    unwrap(await e.execute({ type: 'setKeyframes', prop: { layer: a, path: 'transform/scale' }, keys: [0, 2].map((t, i) => ({ id: '', time: sec(t), value: { kind: 'vec2' as const, value: { x: i ? 400 : 100, y: i ? 400 : 100 } }, easing: 'linear' as const, continuous: false, roving: false, spatialInterp: 'legacy' as const, spatialIn: [], spatialOut: [], label: 0, dims: [] })) }));
    unwrap(await e.execute({ type: 'setExpression', prop: { layer: a, path: 'transform/rotation' }, source: 'time * 90', enabled: true }));
    unwrap(await e.execute({ type: 'setExpression', prop: { layer: b, path: 'transform/opacity' }, source: '50 + 50 * Math.sin(time)', enabled: true }));
    useSelectionStore.getState().set([a, b]);
    layers = { comp, a, b };
    await settle();
    expect(await contentOf(localEngine()!)).toEqual(await contentOf(ownedEngine()!));
  });

  it.each(CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const owner = ownedEngine()!;
    let prepared: unknown;
    if (c.setup) {
      prepared = await c.setup(layers);
      await settle();
      await refreshReplicaFromEngine();
      await settle();
    }
    const before = await contentOf(owner, c.ignoreItems);
    await c.run(layers, prepared);
    await settle();
    const ownerAfter = await contentOf(owner, c.ignoreItems);
    const replicaAfter = await contentOf(localEngine()!, c.ignoreItems);
    const reached = ownerAfter !== before && ownerAfter === replicaAfter;
    findings.push(`${reached ? 'REACHES the engine ' : 'replica only       '} ${c.name}`);
    if (!reached && c.expect === 'owner') {
      let i = 0;
      while (i < ownerAfter.length && ownerAfter[i] === replicaAfter[i]) i++;
      console.log(`[owner-write audit] ${c.name}: first difference at ${i}
 owner   …${ownerAfter.slice(Math.max(0, i - 200), i + 200)}
 replica …${replicaAfter.slice(Math.max(0, i - 200), i + 200)}`);
    }
    if (!reached) await refreshReplicaFromEngine();
    expect(reached ? 'owner' : 'replica-only').toBe(c.expect);
  });
});
