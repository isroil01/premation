/**
 * The legacy snapshot history entry (the 700 ms recorder's, the AI
 * transaction's, the dynamics bake's) and its ONE restore path. History
 * infrastructure, not a UI edit: ENGINE_API.md §15.3 deletes it with the
 * recorder.
 */

import { sceneProjectIO } from '@core/scene/sceneProjectIO';
import { defaultAnimation } from '@motion/animation';
import { bumpScene, batchScene } from '@stores/sceneStore';
import type { IUndoableCommand, CommandContext } from './Command';
import {
  applySharedClips,
  cloneStateForRestore,
  internState,
  noteRestoredState,
  type DocState,
} from './snapshotSharing';

/**
 * Make the live document match a snapshot. The ONE restore path for every
 * snapshot entry — `StoreSnapshotCommand` and the AI transaction's rollback.
 *
 * With clip geometry in the snapshot (unified history), the restore runs as
 * one scene batch in this order: scene, animation, then the timeline —
 * membership reconciled against the restored scene for EVERY registered
 * composition (not just the active one, which is all the `SceneGraphChanged`
 * subscriber syncs), then geometry written onto the bars that differ. A
 * snapshot from before the flag (no `clips`) restores as it always did and the
 * `SceneGraphChanged` subscriber re-seeds its bars.
 */
export function restoreSnapshotState(state: DocState): void {
  // A private copy: the stores keep what they are given, and these objects
  // are shared with neighbouring entries.
  const copy = cloneStateForRestore(state);
  if (copy.clips) {
    batchScene(() => {
      sceneProjectIO.restore(copy.scene);
      defaultAnimation.restore(copy.anim);
      applySharedClips(copy.clips);
    });
  } else {
    sceneProjectIO.restore(copy.scene);
    defaultAnimation.restore(copy.anim);
  }
  noteRestoredState(state.scene, state.anim, state.clips);
  bumpScene();
}

export class StoreSnapshotCommand implements IUndoableCommand {
  readonly label: string;
  /**
   * A deliberate, user-meaningful entry (the "Open" baseline, a pinned
   * snapshot) rather than an auto-captured edit. `record`'s flag used to be
   * ignored while the History panel read `(e as any).named` — always undefined
   * — so a pinned snapshot looked identical to every auto entry.
   */
  readonly named: boolean;
  private readonly before: DocState;
  private readonly after: DocState;

  constructor(label: string, before: DocState, after: DocState, named = false) {
    this.label = label;
    // Callers outside this store (the AI transaction, the dynamics bake) still
    // build full copies; interning re-expresses them with shared nodes so a long
    // session of those entries does not hold a document per step. Same content.
    this.before = internState(before);
    this.after = before === after ? this.before : internState(after);
    this.named = named;
  }

  execute(_ctx: CommandContext): void {
    this.apply(this.after);
  }

  undo(_ctx: CommandContext): void {
    this.apply(this.before);
  }

  private apply(state: DocState): void {
    restoreSnapshotState(state);
  }
}
