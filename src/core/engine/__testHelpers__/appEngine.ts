/**
 * The APP's engine (engineInstance.ts) in a test: the same booted-enough editor
 * the B2 harness builds (CommandSystem, unified history, scene→timeline mirror,
 * the 700 ms recorder), but the engine is the session singleton UI code reaches
 * through `engine()` — with `legacyUiRefresh` on, as in the app, plus
 * `verifyScopes`. Returns a `Harness`, so `buildScene` works unchanged.
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
import { canonicalJson } from '../canonical';
import { bootEngine, shutdownEngine } from '../engineInstance';
import type { LocalEngine } from '../LocalEngine';
import { fakePorts, type Harness } from './harness';

let subs: Array<{ dispose(): void }> = [];

// jsdom has no object URLs; New Project revokes the session's asset URLs.
const U = URL as unknown as { revokeObjectURL?: (u: string) => void; createObjectURL?: (b: unknown) => string };
U.revokeObjectURL ??= () => {};
U.createObjectURL ??= () => 'blob:test';

export async function setupAppEngine(): Promise<Harness & { engine: LocalEngine }> {
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
  const engine = bootEngine({ ports: fakePorts(files), engineOptions: { verifyScopes: true } });
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
