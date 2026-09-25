/**
 * D5 / F2: the session with the C++ ENGINE AS THE OWNER, end to end in
 * process — `bootEngine({ ownsDocument: true })` over the real
 * `premation-engine` (headless, through the same EngineSupervisor + bridge the
 * app uses), the TypeScript engine as the page's replica.
 *
 *   - `engine()` is the owner; the mirror follows the owner's revisions;
 *   - edits, batches, a drag gesture, undo / redo reach both engines and the
 *     two documents stay equal (the replica is what the page's overlays read);
 *   - the replica counts no difference;
 *   - a project transition does not rebuild the replica (it received the same
 *     newProject the owner did).
 *
 * Skipped, saying so, when the engine is not built (PREMATION_ENGINE_PATH =
 * <native build>/engine/premation-engine-headless[.exe]).
 */

import { unwrap, type DocumentSnapshot, type EngineClient } from '@motion/engine-api';
import { CommandSystem, setCommandSystem } from '@core/commands/CommandSystem';
import type { CommandServices } from '@core/commands/Command';
import { setUnifiedHistory } from '@core/config/flags';
import { getEventBus } from '@core/events/EventBus';
import { getTimelineController } from '@core/timeline/TimelineController';
import { attachHistoryRecording, performUndo, performRedo } from '@stores/historyStore';
import { resetSnapshotSharing } from '@core/commands/snapshotSharing';
import { documentMirror } from '@stores/documentMirror';
import type { EditorDocument } from '@core/api/cloudDocument';
import { bootEngine, engine, localEngine, ownedEngine, shutdownEngine } from '../engineInstance';
import { engineOwnsDocumentNow, resetEngineOwnership, setEngineOwnsDocument } from '../engineOwnership';
import { resetProcessEngine } from '../process/processEngine';
import { fakePorts } from '../__testHelpers__/harness';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '../__testHelpers__/nativeEngine';

jest.setTimeout(120_000);

const U = URL as unknown as { revokeObjectURL?: (u: string) => void; createObjectURL?: (b: unknown) => string };
U.revokeObjectURL ??= () => {};
U.createObjectURL ??= () => 'blob:test';

type Content = Omit<DocumentSnapshot, 'revision' | 'dirty' | 'projectPath'>;

async function contentOf(c: EngineClient): Promise<Content> {
  const d = unwrap(await c.query({ type: 'getDocument', includeProperties: true, includeKeyframes: true }));
  const { revision: _r, dirty: _d, projectPath: _p, ...rest } = d;
  return rest;
}

const run = !!nativeEngineExe();
if (!run) console.log('[D5 owner mode] premation-engine is not built — skipped (PREMATION_ENGINE_PATH=<premation-engine-headless>)');
const maybe = run ? describe : describe.skip;

maybe('D5: the C++ engine owns the document, the page keeps a replica', () => {
  let native: NativeEngine;
  let subs: Array<{ dispose(): void }> = [];

  beforeAll(async () => {
    native = await startNativeEngine();
    (window as unknown as { motionEditor?: unknown }).motionEditor = { engine: native.bridge };
  });
  afterAll(async () => {
    await shutdownEngine();
    await resetProcessEngine();
    resetEngineOwnership();
    for (const s of subs) s.dispose();
    subs = [];
    delete (window as unknown as { motionEditor?: unknown }).motionEditor;
    await native.stop();
  });

  it('routes the session to the owner and keeps the replica equal through edits, a gesture and undo/redo', async () => {
    await shutdownEngine();
    setUnifiedHistory(true);
    setCommandSystem(new CommandSystem({ services: {} as CommandServices, getState: () => ({}) }));
    resetSnapshotSharing();
    subs = [
      getEventBus().on('SceneGraphChanged', () => getTimelineController().syncFromScene()),
      attachHistoryRecording(),
    ];
    setEngineOwnsDocument(true);
    const files = new Map<string, EditorDocument>();
    bootEngine({ ports: fakePorts(files), ownsDocument: true });
    expect(engineOwnsDocumentNow()).toBe(true);
    const owner = ownedEngine();
    expect(owner).not.toBeNull();
    expect(engine()).toBe(owner);
    const replica = localEngine()!;
    const settle = async (): Promise<void> => {
      await replica.whenIdle();
      await documentMirror().whenIdle();
    };

    unwrap(await engine().execute({ type: 'newProject' }));
    const comp = unwrap(await engine().execute({ type: 'createComposition', settings: { name: 'Owned', width: 1280, height: 720 }, fromItems: [] })).item;
    const a = unwrap(await engine().execute({ type: 'createLayer', comp, kind: 'solid', name: 'A', init: [] })).layer;
    const b = unwrap(await engine().execute({ type: 'createLayer', comp, kind: 'solid', name: 'B', init: [] })).layer;
    await engine().batch('Name them', [
      { type: 'renameLayer', layer: a, name: 'Plate' },
      { type: 'renameLayer', layer: b, name: 'Rig' },
    ]);
    const g = unwrap(await engine().execute({ type: 'beginGesture', label: 'Drag' })).gesture;
    for (const x of [10, 20, 30]) {
      unwrap(await engine().execute({ type: 'setProperty', prop: { layer: a, path: 'transform/rotation' }, value: { kind: 'scalar', value: x } }));
    }
    unwrap(await engine().execute({ type: 'endGesture', gesture: g, commit: true }));
    unwrap(await engine().execute({ type: 'renameLayer', layer: b, name: 'Rig 2' }));
    await settle();
    const built = await contentOf(owner!);
    expect(JSON.stringify(built)).toContain('Rig 2');
    expect(await contentOf(replica)).toEqual(built);

    // The app's Ctrl+Z / Ctrl+Shift+Z route to the owner (and so to the replica).
    await performUndo();
    await performUndo();
    await settle();
    const undone = await contentOf(owner!);
    expect(JSON.stringify(undone)).not.toContain('Rig 2');
    expect(await contentOf(replica)).toEqual(undone);
    await performRedo();
    await settle();
    expect(await contentOf(replica)).toEqual(await contentOf(owner!));

    // The mirror reads the owner.
    expect(documentMirror().revision).toBe(owner!.revision);
    expect(documentMirror().comp(comp)?.settings.name).toBe('Owned');

    // A project transition keeps the replica (it got the same newProject).
    getEventBus().emit('ProjectLoaded', { projectId: 'p' });
    expect(localEngine()).toBe(replica);
    unwrap(await engine().execute({ type: 'newProject' }));
    await settle();
    expect(await contentOf(replica)).toEqual(await contentOf(owner!));

    expect(owner!.replicaStats.mismatches).toBe(0);
    expect(owner!.replicaStats.forwarded).toBeGreaterThan(10);
  });
});
