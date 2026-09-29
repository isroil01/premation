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
import { rebaseTransformProps } from '@core/scene/transformWrite';
import { createOrbitNullEdit } from '@core/scene/cameraCommands';
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

async function contentOf(c: EngineClient): Promise<string> {
  const d = unwrap(await c.query({ type: 'getDocument', includeProperties: true, includeKeyframes: true }));
  const { revision: _r, dirty: _d, projectPath: _p, ...rest } = d;
  return JSON.stringify(rest as Content);
}

const sec = (s: number): number => Math.round(s * 705_600_000);

interface Layers { comp: string; a: string; b: string }

type Expect = 'owner' | 'replica-only';

/** One feature and how it is reached from the UI. */
interface AuditCase {
  name: string;
  expect: Expect;
  run: (l: Layers) => void | Promise<unknown>;
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
  { name: 'Re-base transform (transformWrite.rebaseTransformProps)', expect: 'owner', run: ({ a }) => rebaseTransformProps(a, [{ prop: 'x', value: 300, delta: 40 }]) },
  { name: 'runAnimEdit writing a switch, a parent and a static value', expect: 'owner', run: ({ a, b }) => runAnimEdit('Mixed', () => { set3DEnabled(b, true); reparentNode(b, a); }) },
  // ── palette commands with their own engine path ──
  { name: 'Create Orbit Null (camera palette command)', expect: 'owner', run: async ({ comp }) => {
    const cam = unwrap(await engine().execute({ type: 'createLayer', comp, kind: 'camera', name: 'Cam', init: [] })).layer;
    await localEngine()!.whenIdle();
    const id = await createOrbitNullEdit(cam, 0);
    expect(id).not.toBeNull();
  } },
  // ── scene-graph writers NOT recorded as animation edits (core helpers; the UI sends the engine
  //    commands for these — setLayerSwitches / setParent / setLayerTiming — so they are not reached
  //    from a menu, but anything that still calls them writes the replica only) ──
  { name: 'Animate In (choreography — P4 is porting it to engine edits)', expect: 'replica-only', run: ({ a, b }) => runChoreography({ kind: 'in', nodeIds: [a, b], params: commandStaggerParams('in', [a, b], 30) }) },
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
    const before = await contentOf(owner);
    await c.run(layers);
    await settle();
    const ownerAfter = await contentOf(owner);
    const replicaAfter = await contentOf(localEngine()!);
    const reached = ownerAfter !== before && ownerAfter === replicaAfter;
    findings.push(`${reached ? 'REACHES the engine ' : 'replica only       '} ${c.name}`);
    if (!reached) await refreshReplicaFromEngine();
    expect(reached ? 'owner' : 'replica-only').toBe(c.expect);
  });
});
