/**
 * One prompt, one undo entry.
 *
 * A single request ("make the title fade in and rise, then pulse") can fan out
 * into dozens of tool calls touching both the scene graph and the animation
 * engine. To the user that was *one act*, so pressing undo once must put
 * everything back.
 *
 * `runAnimEdit` can't do this — it only captures the animation engine, and the
 * AI creates layers too. So we take the coarse route deliberately: snapshot the
 * whole document before the run, snapshot after, and push a single
 * `StoreSnapshotCommand`. Fine-grained diffing across mixed edits would buy
 * nothing a user actually wants.
 *
 * The mutations land live, so the canvas animates as the model works.
 */

import { StoreSnapshotCommand, restoreSnapshotState } from '@stores/historyStore';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { bumpScene } from '@stores/sceneStore';
import { captureSharedState, statesEqual, type DocState } from '@core/commands/snapshotSharing';

/**
 * Scene + animation (+ clip geometry under the unified history), structurally
 * shared with every other history snapshot — so a run's entry restores the
 * timeline too, and a long session of runs does not hold a document per step.
 */
const capture = (): DocState => captureSharedState();

/** The store's own restore path: clones, restores every half, re-baselines. */
const restore = (s: DocState): void => restoreSnapshotState(s);

export interface AiTransaction {
  /** Push one undo entry covering everything the run changed. */
  commit(): void;
  /** Put the document back as it was. */
  rollback(): void;
}

/**
 * Begin an AI run.
 *
 * Call `commit` when the run finishes and `rollback` if it throws or the
 * user cancels — a half-applied AI edit is worse than none, because the user
 * can't tell which half landed.
 */
/**
 * The same one-act-one-undo transaction for NON-AI bulk edits.
 *
 * A file import is the other operation that fans out into dozens of scene and
 * animation mutations plus a timeline resync. Without this a Lottie import was
 * effectively un-undoable: `syncFromScene` pushed a timeline command per created
 * clip, so Ctrl+Z peeled the import off one layer at a time (measured: 25
 * presses to walk a 23-layer import back, leaving a half-deleted scene on the
 * way). Same machinery, honest name.
 */
export function beginDocumentTransaction(label: string): AiTransaction {
  return beginAiTransaction(label);
}

export function beginAiTransaction(label: string): AiTransaction {
  const before = capture();
  let settled = false;

  // Other subsystems push their own commands as a side effect of work the run
  // triggers — lazily booting a comp's timeline emits an "Add Track", for
  // instance (TimelineController bridges the timeline package's history into
  // ours). Those are noise here: the before/after snapshot already covers
  // everything, so a stray entry would just be a second undo step that half-
  // undoes the run. Suppress for the duration; our own push happens after.
  const history = getCommandSystem().getHistory();
  history.suspend();
  const release = (): void => history.resume();

  return {
    commit(): void {
      if (settled) return;
      settled = true;
      release();
      const after = capture();
      // A read-only run (the model just answered a question) must not litter
      // the undo stack with a no-op entry. Same JSON equality as before, walked
      // only through what the run changed.
      if (statesEqual(before, after)) return;
      history.push(new StoreSnapshotCommand(label, before, after));
      bumpScene();
    },

    rollback(): void {
      if (settled) return;
      settled = true;
      release();
      restore(before);
    },
  };
}
