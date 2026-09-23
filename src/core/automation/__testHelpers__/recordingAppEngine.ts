/**
 * The APP's engine in a test (like core/engine/__testHelpers__/appEngine.ts —
 * the booted-enough editor, `engine()` is the session singleton UI code
 * reaches), with the command log RECORDING and `verifyScopes` on. B5's
 * record/replay, AI-turn and script tests drive the real UI edit paths
 * through it.
 */

import { unwrap } from '@motion/engine-api';
import { CommandSystem, setCommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import type { CommandServices } from '@core/commands/Command';
import { setUnifiedHistory } from '@core/config/flags';
import { getEventBus } from '@core/events/EventBus';
import { getTimelineController } from '@core/timeline/TimelineController';
import { attachHistoryRecording, useHistoryStore } from '@stores/historyStore';
import { resetSnapshotSharing } from '@core/commands/snapshotSharing';
import type { EditorDocument } from '@core/api/cloudDocument';
import { canonicalJson } from '@core/engine/canonical';
import { bootEngine, shutdownEngine } from '@core/engine/engineInstance';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { fakePorts, type Harness } from '@core/engine/__testHelpers__/harness';

let subs: Array<{ dispose(): void }> = [];

const U = URL as unknown as { revokeObjectURL?: (u: string) => void; createObjectURL?: (b: unknown) => string };
U.revokeObjectURL ??= () => {};
U.createObjectURL ??= () => 'blob:test';

export async function setupRecordingAppEngine(): Promise<Harness & { engine: LocalEngine }> {
  for (const s of subs) s.dispose();
  await shutdownEngine();
  setUnifiedHistory(true);
  setCommandSystem(new CommandSystem({ services: {} as CommandServices, getState: () => ({}) }));
  resetSnapshotSharing();
  subs = [
    getEventBus().on('SceneGraphChanged', () => getTimelineController().syncFromScene()),
    attachHistoryRecording(),
  ];
  const files = new Map<string, EditorDocument>();
  const engine = bootEngine({ ports: fakePorts(files), recordLog: true, engineOptions: { verifyScopes: true } });
  const batches: Harness['batches'] = [];
  engine.subscribe((b) => batches.push(b));
  const h: Harness & { engine: LocalEngine } = {
    engine,
    batches,
    files,
    run: async (cmd) => unwrap(await engine.execute(cmd)),
    batch: async (label, cmds) => unwrap(await engine.batch(label, cmds)),
    query: async (q) => unwrap(await engine.query(q)),
    doc: () => canonicalJson(),
    dispose: async () => {
      await shutdownEngine();
      for (const s of subs) s.dispose();
      subs = [];
    },
  };
  await h.run({ type: 'newProject' });
  useHistoryStore.getState().reset();
  getCommandSystem().getHistory().clear();
  return h;
}

/** Labels on the unified history stack, oldest first. */
export function historyLabels(): string[] {
  return getCommandSystem().getHistory().getEntries().map((e) => e.label);
}
