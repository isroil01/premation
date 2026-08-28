/**
 * Scene revision store.
 *
 * The scene graph is a plain (non-reactive) data structure. UI that derives
 * from it (the Scene tree) subscribes to this revision counter and recomputes
 * when it changes. Any mutation to the graph should call `bumpScene`.
 */

import { create } from 'zustand';
import { getEventBus } from '@core/events/EventBus';

/** Nesting depth of the current `batchScene` (0 = notify immediately). */
let batchDepth = 0;
/** Whether anything asked to bump while the batch was held. */
let batchDirty = false;
/** As above, for revision-only bumps — no `SceneGraphChanged` on the flush. */
let batchRevDirty = false;

interface SceneRevisionState {
  rev: number;
  bump(): void;
  bumpRevision(): void;
}

export const useSceneRevision = create<SceneRevisionState>((set) => ({
  rev: 0,
  bump: () => {
    if (batchDepth > 0) {
      batchDirty = true;
      return;
    }
    set((s) => ({ rev: s.rev + 1 }));
    // Static import, emitted synchronously. This used to be a dynamic
    // `import(...).then(...)` per call: an extra promise allocation 30-60×/s
    // during a drag, and — worse — it made `SceneGraphChanged` land a microtask
    // AFTER the revision bump, so handlers that read `rev` saw an ordering that
    // lagged the event. EventBus imports nothing from the stores, so there is no
    // cycle to dodge.
    getEventBus().emit('SceneGraphChanged', undefined);
  },

  /**
   * Advance the revision WITHOUT announcing a structural change.
   *
   * For a write that changes a value on an existing node and nothing else. Such
   * a write already announces itself as `NodeUpdated`; every reader that wants
   * the detail is on that. What it also has to do is re-render the views that
   * rebuild from the revision — the timeline's expanded property rows read the
   * scene during render, so without a bump they froze at whatever they last
   * drew while the viewport and the inspector moved on without them.
   *
   * Emitting `SceneGraphChanged` for it instead is the tempting one-liner and
   * it is wrong twice: it walks the whole scene to reconcile a timeline whose
   * STRUCTURE did not change, and — because history treats a change of event
   * key as a change of ACTION — it splits one prop edit into two undo steps.
   * `SceneGraphChanged` means add/delete/reparent; this does not.
   */
  bumpRevision: () => {
    if (batchDepth > 0) {
      batchRevDirty = true;
      return;
    }
    set((s) => ({ rev: s.rev + 1 }));
  },
}));

/** Non-hook helper to bump the revision from anywhere. */
export function bumpScene(): void {
  useSceneRevision.getState().bump();
}

/** Non-hook helper for a value-only write — see `bumpRevision`. */
export function bumpSceneRevision(): void {
  useSceneRevision.getState().bumpRevision();
}

/**
 * Run `fn` with scene notifications held, then bump ONCE if anything changed.
 * Nests; only the outermost batch flushes, and it flushes even when `fn` throws
 * (listeners must not be left stale about mutations that already landed).
 *
 * `SceneGraphChanged` is expensive and synchronous — its main subscriber walks
 * the whole scene to reconcile the timeline. That is the right trade for one
 * interactive edit and quadratic for a bulk build: a Lottie import creating 89
 * nodes paid 89 full-scene walks over a growing scene, and almost all of its
 * 1.6s was notification. The GRAPH is mutated immediately either way, so
 * anything inside the batch that reads the scene still sees the truth — only
 * the announcement waits.
 *
 * The same trade the AnimationEngine already makes for keyframes
 * (`defaultAnimation.batch`).
 */
export function batchScene<T>(fn: () => T): T {
  batchDepth++;
  try {
    return fn();
  } finally {
    batchDepth--;
    // A batch that saw any structural bump flushes as one — that subsumes the
    // revision-only bumps, which are the same bump minus the announcement.
    // No early `return` here: a return inside `finally` would DISCARD `fn`'s
    // value, which is the one thing this wrapper must pass through.
    if (batchDepth === 0) {
      if (batchDirty) {
        batchDirty = false;
        batchRevDirty = false;
        bumpScene();
      } else if (batchRevDirty) {
        batchRevDirty = false;
        bumpSceneRevision();
      }
    }
  }
}
