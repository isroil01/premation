/**
 * D5 / F2: the session with the C++ ENGINE AS THE OWNER, end to end in
 * process — `bootEngine({ ownsDocument: true })` over the real
 * `premation-engine` (headless, through the same EngineSupervisor + bridge the
 * app uses). The page keeps no replica (block 3).
 *
 *   - `engine()` is the owner and no TypeScript engine is created;
 *   - edits, batches, a drag gesture, undo / redo reach the owner and the
 *     mirror follows its revisions;
 *   - a project transition does not create a TypeScript engine.
 *
 * Skipped, saying so, when the engine is not built (PREMATION_ENGINE_PATH =
 * <native build>/engine/premation-engine-headless[.exe]).
 */

import { unwrap, type DocumentSnapshot, type EngineClient } from '@motion/engine-api';
import { CommandSystem, setCommandSystem } from '@core/commands/CommandSystem';
import type { CommandServices } from '@core/commands/Command';
import { getEventBus } from '@core/events/EventBus';
import { getTimelineController } from '@core/timeline/TimelineController';
import { performUndo, performRedo } from '@stores/historyStore';
import { resetSnapshotSharing } from '@core/commands/snapshotSharing';
import { documentMirror } from '@stores/documentMirror';
import type { EditorDocument } from '@core/api/cloudDocument';
import { bootEngine, engine, engineIdle, localEngine, ownedEngine, shutdownEngine } from '../engineInstance';
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

maybe('D5: the C++ engine owns the document, the page keeps no replica', () => {
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

  it('routes the session to the owner through edits, a gesture and undo/redo', async () => {
    await shutdownEngine();
    setCommandSystem(new CommandSystem({ services: {} as CommandServices, getState: () => ({}) }));
    resetSnapshotSharing();
    subs = [
      getEventBus().on('SceneGraphChanged', () => getTimelineController().syncFromScene()),
    ];
    setEngineOwnsDocument(true);
    const files = new Map<string, EditorDocument>();
    bootEngine({ ports: fakePorts(files), ownsDocument: true });
    expect(engineOwnsDocumentNow()).toBe(true);
    const owner = ownedEngine();
    expect(owner).not.toBeNull();
    expect(engine()).toBe(owner);
    expect(localEngine()).toBeNull();
    const settle = async (): Promise<void> => {
      await engineIdle();
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
    expect(documentMirror().layer(b)?.name).toBe('Rig 2');

    // The app's Ctrl+Z / Ctrl+Shift+Z route to the owner.
    await performUndo();
    await performUndo();
    await settle();
    const undone = await contentOf(owner!);
    expect(JSON.stringify(undone)).not.toContain('Rig 2');
    await performRedo();
    await performRedo();
    await settle();
    expect(await contentOf(owner!)).toEqual(built);

    // The mirror reads the owner.
    expect(documentMirror().revision).toBe(owner!.revision);
    expect(documentMirror().comp(comp)?.settings.name).toBe('Owned');

    // A project transition creates no TypeScript engine.
    getEventBus().emit('ProjectLoaded', { projectId: 'p' });
    unwrap(await engine().execute({ type: 'newProject' }));
    await settle();
    expect(localEngine()).toBeNull();
    expect(engine()).toBe(owner);
  });
});
