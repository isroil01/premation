/**
 * One undo entry for a multi-domain operation.
 *
 * The editor keeps two independent history mechanisms, and the note in
 * `TimelineController.splitLayerAtFrame` explains why:
 *
 *   • the ENGINE records clip geometry as explicit commands, and
 *   • the APP auto-captures a debounced scene + animation SNAPSHOT.
 *
 * Split needed both, and solved it by hand-writing an exact inverse. That works
 * for one bar. It does not work for an ASSEMBLY — create a comp, insert eight
 * clips, split at forty cuts, delete the runts, sequence the survivors and
 * write crossfades — where the inverse is not a small edit but "the project as
 * it was", and where a third domain (the comp table and its tab) joins in.
 *
 * So this takes the other route: capture the whole editor document before and
 * after, and push ONE command that swaps between them. `captureDocument` is
 * already the save format — scene, animation, comps, timelines, tabs, guides —
 * which is exactly the set an assembly touches, and it is the only capture in
 * the app that includes clip geometry (the scene snapshot does not).
 *
 * It is heavier than a targeted inverse, and deliberately so: it is reserved
 * for operations a user thinks of as ONE act but which no small diff describes.
 * Do not reach for it to move a keyframe.
 *
 * ## What must hold while `fn` runs
 *
 *   • the engine history is SUSPENDED, so the split/delete/sequence commands
 *     underneath do not each become their own undo step, and
 *   • the app snapshot store is marked `restoring`, so the burst of
 *     SceneGraphChanged events does not land a debounced entry 700 ms later
 *     describing half the operation.
 *
 * Both are restored in a `finally`, and the store is re-baselined afterwards so
 * the next ordinary edit diffs against the assembled document rather than
 * against the one that preceded it.
 *
 * `fn` may be async — which is the reason this exists rather than
 * `historyStore.runRestoring`, whose callback is synchronous and so cannot span
 * an `await insertMedia(...)`.
 */

import { captureDocument, restoreDocument, type EditorDocument } from '@core/api/cloudDocument';
import { useHistoryStore } from '@stores/historyStore';
import { getCommandSystem } from '@core/commands/CommandSystem';
import type { HistoryService } from '@core/commands/HistoryService';
import { bumpScene } from '@stores/sceneStore';

/** The app history service, or null in a headless context that has no CommandSystem. */
function historyService(): HistoryService | null {
  try {
    return getCommandSystem().getHistory();
  } catch {
    return null;
  }
}

function restore(doc: EditorDocument): void {
  // Cloned per restore: `restoreDocument` hands these objects to the stores,
  // which then own and mutate them. Handing over the same instance twice would
  // make the second undo restore a document the first one had since edited.
  restoreDocument(structuredClone(doc));
  bumpScene();
}

/**
 * Run `fn` and record it as a single undoable step labelled `label`.
 *
 * Returns whatever `fn` returned. Nothing is pushed when `fn` throws — the
 * partial state is left as it is (there is no half-assembly worth an undo
 * entry), and the error propagates to the caller, which owns the message.
 */
export async function runAsOneHistoryEntry<T>(
  label: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const store = useHistoryStore.getState();
  // Commit whatever edit was mid-debounce, so it keeps its OWN step rather than
  // being swallowed by the baseline this operation is about to take.
  store.flush();

  const before = captureDocument();
  const history = historyService();

  history?.suspend();
  useHistoryStore.setState({ restoring: true });
  let result: T;
  try {
    result = await fn();
  } finally {
    useHistoryStore.setState({ restoring: false });
    // A no-op restore, purely to re-baseline `lastState` (which is module
    // private to the store — this is the only door to it).
    useHistoryStore.getState().runRestoring(() => {});
    history?.resume();
  }

  const after = captureDocument();
  history?.push({
    label,
    // Undo/redo arrive through `performUndo`/`performRedo`, which already wrap
    // the call in `runRestoring` — so these must NOT nest another one. The
    // engine push still has to be suspended, hence the explicit pair.
    execute: () => {
      history?.suspend();
      try {
        restore(after);
      } finally {
        history?.resume();
      }
    },
    undo: () => {
      history?.suspend();
      try {
        restore(before);
      } finally {
        history?.resume();
      }
    },
  });
  return result;
}
