/**
 * Viewport drag gesture — one transaction per pointer GESTURE instead of one
 * per pointer EVENT.
 *
 * The transform ports (`moveNodes`, `resizeNode`, `rotateNode`,
 * `applyGizmo3DTransforms`, …) are called once per pointermove — 120-240×/s on
 * a modern mouse. Each call used to pay two O(project) costs that exist only
 * for bookkeeping, not pixels:
 *
 *   • `runAnimEdit` takes TWO full `engine.snapshot()`s (every keyframe of
 *     every track in the project, deep-copied) plus a whole-project diff, per
 *     event — when `beginAnimEdit`/`commit` exists precisely so a drag can pay
 *     that once. The graph editor, puppet and bone overlays already use the
 *     transaction; the viewport never did.
 *   • `bumpScene()` announces a STRUCTURAL change, whose subscribers walk the
 *     whole scene (timeline syncFromScene, selection pruning, autosave and
 *     thumbnail scheduling) — for a write that moved a value on an existing
 *     node. `InspectorAPI.ts` documents `bumpSceneRevision()` as the correct
 *     call for value-only writes; the live UI reads `NodeUpdated` anyway.
 *
 * While a gesture is open, `gestureAnimEdit` mutates the engine directly under
 * one lazily-started transaction, and `gestureSceneBump` degrades to the cheap
 * revision bump. `endViewportGesture` records the single undo command (same
 * label/mergeKey the per-event path would have used, so cross-drag coalescing
 * at the same playhead is unchanged) and fires ONE structural `bumpScene()` —
 * which the coarse history store still needs, because a static (un-keyframed)
 * drag's undo lives there and nowhere else.
 *
 * Outside a gesture every helper falls through to the classic path, so
 * keyboard nudges, AI tools and tests behave exactly as before.
 */

import { beginAnimEdit, recordAnimEdit, runAnimEdit } from '@core/animation/animationCommands';
import { bumpScene, bumpSceneRevision } from '@stores/sceneStore';

type AnimTx = ReturnType<typeof beginAnimEdit>;

/** Nesting depth — a stray second pointer must not end the first drag's tx. */
let depth = 0;
let tx: AnimTx | null = null;
let txLabel = '';
let txMergeKey: string | undefined;
let structuralDirty = false;

/** True while a viewport pointer gesture is in flight. */
export function viewportGestureActive(): boolean {
  return depth > 0;
}

/** Open a gesture. Pair with `endViewportGesture` on pointerup/cancel/blur. */
export function beginViewportGesture(): void {
  depth++;
}

/**
 * Close the gesture: record the drag's single undo command and announce the
 * one structural change. Safe to call without a matching begin (no-op).
 */
export function endViewportGesture(): void {
  if (depth === 0) return;
  depth--;
  if (depth > 0) return;
  const pending = tx;
  tx = null;
  if (pending) recordAnimEdit(pending.commit(txLabel, txMergeKey));
  if (structuralDirty) {
    structuralDirty = false;
    bumpScene();
  }
}

/**
 * `runAnimEdit`, gesture-aware: inside a gesture the mutation applies directly
 * under the gesture's single transaction; outside it is the classic
 * capture-per-call. The LAST label/mergeKey of the gesture wins — they are
 * stable for a drag by construction (`drag:move:<t>:<ids>` etc.).
 */
export function gestureAnimEdit(label: string, mutate: () => void, mergeKey?: string): void {
  if (depth === 0) {
    runAnimEdit(label, mutate, mergeKey);
    return;
  }
  if (!tx) tx = beginAnimEdit();
  txLabel = label;
  txMergeKey = mergeKey;
  mutate();
}

/**
 * `bumpScene()`, gesture-aware: inside a gesture only the revision advances
 * (live views re-render off `NodeUpdated`/rev); the structural announcement is
 * deferred to `endViewportGesture`, once.
 */
export function gestureSceneBump(): void {
  if (depth === 0) {
    bumpScene();
    return;
  }
  structuralDirty = true;
  bumpSceneRevision();
}
