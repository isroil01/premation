/**
 * The steps that must happen AROUND a project write or a project load.
 *
 * These were open-coded per command, and every command implemented a different
 * subset: `File ▸ Save` cleared the dirty flag and the recovery snapshot,
 * `Save As` and `Increment and Save` cleared neither (so a successful save left
 * the unsaved indicator up and the next New/Open still prompted to discard),
 * and `New Project` re-baselined nothing — so one Ctrl+Z after it stepped back
 * into the PREVIOUS document, the exact failure `openProjectPath` exists to
 * prevent.
 *
 * One document transition, one helper. A new project-lifecycle command calls
 * these rather than re-deriving which four stores it has to touch.
 */

import { useProjectStore } from '@stores/projectStore';
import { useHistoryStore } from '@stores/historyStore';
import { clearRecovery } from '@core/persistence/recovery';
import { getTimelineController } from '@core/timeline/TimelineController';
import { resetSessionAssets } from '@core/project/sessionAssets';

/**
 * Drop the active tab's unsaved marker.
 *
 * MUST run after any `bumpScene()`, not before: `bumpScene` emits
 * `SceneGraphChanged`, which the boot wiring turns straight back into
 * `markDirty(true)`.
 */
export function markProjectClean(): void {
  const ws = useProjectStore.getState();
  if (ws.activeTabId) ws.actions.markDirty(ws.activeTabId, false);
}

/**
 * Flag the active tab as having edits that are not in durable storage.
 *
 * The workspace tab is the ONLY dirty flag anything reads —
 * `hasUnsavedChanges`, the discard prompt and the unsaved indicator all come
 * from here. `ProjectManager` used to carry a second one that nothing read.
 */
export function markProjectDirty(): void {
  const ws = useProjectStore.getState();
  if (ws.activeTabId) ws.actions.markDirty(ws.activeTabId, true);
}

/**
 * The document now matches durable storage: clear the unsaved marker and the
 * crash-recovery snapshot it was protecting.
 *
 * Call ONLY after a write that actually succeeded. Calling it on a failed or
 * cancelled save is what made a failure indistinguishable from a success — and
 * worse, deleted the recovery snapshot that was the user's last copy.
 */
export function afterProjectSaved(): void {
  markProjectClean();
  clearRecovery();
}

/**
 * Re-baseline undo against a document that is about to become live.
 *
 * History is a flat stack with no project identity in it, so a transition that
 * leaves it intact lets one Ctrl+Z step back into the previous document.
 * Call BEFORE the viewport re-reads the scene, so nothing can record an edit
 * against the old stack.
 */
export function baselineProjectHistory(label = 'Open'): void {
  useHistoryStore.getState().reset();
  useHistoryStore.getState().record(label, true);
}

/**
 * The document now IS what was just loaded (or created): it has no unsaved
 * edits, and the recovery snapshot belongs to the document we just replaced.
 *
 * Call AFTER `bumpScene()` — see `markProjectClean`.
 */
export function afterProjectLoaded(): void {
  markProjectClean();
  clearRecovery();
}

/**
 * The part of "new project" that an empty DOCUMENT cannot say.
 *
 * `restoreDocument` is tolerant of partial documents by design — an absent key
 * means "keep what you have", because a file written before a field existed
 * must not wipe it. That is right for opening a file and wrong for starting a
 * new project, and there is no key meaning "drop the compositions I did not
 * mention". `projectDocumentIO.createEmpty` states the defaults it can
 * (comps, motion blur, guides); these three it cannot.
 *
 * The third is the asset list. It is not part of the document at all — it is
 * the device's footage library doubling as the project's — so a fresh
 * "Untitled" with 0 layers used to open with the previous project's clips
 * still listed in its Assets panel. Session-only: see `sessionAssets.ts` for
 * why the library underneath is left alone. Neither Open nor crash-recovery
 * restore comes through here, so neither loses the footage it rebinds against.
 *
 * Call AFTER the new document is restored, so the timeline re-initialises
 * against the new comp settings rather than the outgoing project's — and so no
 * layer is still decoding from an object URL the asset reset revokes.
 */
export function resetProjectWorkspace(): void {
  useProjectStore.getState().actions.resetTabs();
  getTimelineController().reset();
  resetSessionAssets();
}

/**
 * The session half of Close Project — what `ProjectManager.close()` runs, via
 * the document IO's `unload`, after the empty document is restored.
 *
 * Close is New Project without the project: the same workspace reset and the
 * same undo re-baseline (one Ctrl+Z after closing must not pull the closed
 * project's scene back onto the canvas).
 *
 * The clean-mark is DEFERRED, and that is deliberate. Every caller follows
 * `close()` with a `bumpScene()` — the command does, and so does the boot
 * wiring's ProjectUnloaded listener — and each bump emits SceneGraphChanged,
 * which is turned straight back into markDirty(true). Marking clean here,
 * synchronously, would be undone before the command returned, and the start
 * screen's New Project would then ask to discard "unsaved changes" in an empty
 * scene. A microtask runs after the caller's synchronous tail and before
 * anything the user can do.
 */
export function unloadProjectSession(): void {
  resetProjectWorkspace();
  baselineProjectHistory('Close Project');
  queueMicrotask(afterProjectLoaded);
}
