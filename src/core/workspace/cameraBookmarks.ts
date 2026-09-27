/**
 * Camera bookmarks — named viewpoints per composition, recalled by
 * `Ctrl+Alt+1…9` and saved by `Ctrl+Alt+Shift+1…9` or the header popover.
 *
 * A bookmark is the whole "how I am looking at this": the 3D view mode
 * (Active Camera / an ortho side / a custom view), that view's pan + zoom
 * framing, and — for a custom view — its orbit, so recalling it puts the
 * scene back exactly where it was left. Stored in `guidesStore.cameraBookmarks`
 * (keyed by comp id) and therefore persisted with the document through
 * `guidesStore.settings()`, beside the grid and safe-area settings.
 *
 * `saveViewFraming` (per-view stash in the same store) is SESSION state that
 * remembers where each view was when you switched away; a bookmark is the
 * deliberate, named version of the same numbers that survives a reopen.
 */

import { getWorkspaceController } from './WorkspaceController';
import { useGuidesStore, type CameraBookmark } from '@stores/guidesStore';
import { DEFAULT_COMPOSITION } from '@stores/compositionStore';
import { useProjectStore } from '@stores/projectStore';
import { documentMirror } from '@stores/documentMirror';
import { isCustomViewId } from './customViews';

export const BOOKMARK_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export type BookmarkSlot = (typeof BOOKMARK_SLOTS)[number];

/** The id bookmarks are keyed under: the active comp, or the virtual root. */
export function bookmarkCompId(): string {
  // The active tab's composition when the document has it (B4: the mirror),
  // else the default composition record's id — as the composition store answered.
  const s = useProjectStore.getState();
  const id = s.activeTabId ? s.tabs[s.activeTabId]?.compositionId : undefined;
  return (id && documentMirror().comp(id) ? id : DEFAULT_COMPOSITION.id) || 'comp_root';
}

/** Bookmarks for the active composition, sorted by slot. */
export function bookmarksForActiveComp(): CameraBookmark[] {
  return useGuidesStore.getState().cameraBookmarks[bookmarkCompId()] ?? [];
}

export function bookmarkAt(slot: number): CameraBookmark | null {
  return bookmarksForActiveComp().find((b) => b.slot === slot) ?? null;
}

/**
 * Capture the current viewpoint into `slot` (replacing what was there). Pure
 * over the workspace controller and the guides store; returns the bookmark.
 */
export function saveCameraBookmark(slot: number, name?: string): CameraBookmark {
  const g = useGuidesStore.getState();
  const mode = g.camera3dMode;
  const bookmark: CameraBookmark = {
    slot,
    name: name ?? bookmarkAt(slot)?.name ?? `Bookmark ${slot}`,
    mode,
    framing: getWorkspaceController().framing(),
    ...(isCustomViewId(mode) ? { customView: { ...g.customViews[mode] } } : {}),
  };
  g.saveCameraBookmark(bookmarkCompId(), bookmark);
  return bookmark;
}

/**
 * Recall `slot`: switch the view, restore its orbit when it is a custom view,
 * then re-frame. Returns false when the slot is empty.
 *
 * Framing is restored AFTER the view switch on purpose: `useWorkspace`
 * reacts to a view change by restoring that view's stashed framing (or
 * fitting the comp), and a restore issued before it would be overwritten.
 * Doing it here, synchronously after the store write, wins because the
 * effect runs on the next commit — and it writes the same framing into the
 * per-view stash so that effect agrees.
 */
export function recallCameraBookmark(slot: number): boolean {
  const b = bookmarkAt(slot);
  if (!b) return false;
  const g = useGuidesStore.getState();
  if (b.customView && isCustomViewId(b.mode)) g.updateCustomView(b.mode, b.customView);
  g.setCamera3dMode(b.mode);
  g.saveViewFraming(b.mode, b.framing);
  getWorkspaceController().restoreFraming(b.framing);
  getWorkspaceController().requestRender();
  return true;
}

export function removeCameraBookmark(slot: number): void {
  useGuidesStore.getState().removeCameraBookmark(bookmarkCompId(), slot);
}

export function renameCameraBookmark(slot: number, name: string): void {
  useGuidesStore.getState().renameCameraBookmark(bookmarkCompId(), slot, name.trim() || `Bookmark ${slot}`);
}

/** The first free slot, or null when all nine are taken. */
export function firstFreeBookmarkSlot(): BookmarkSlot | null {
  const used = new Set(bookmarksForActiveComp().map((b) => b.slot));
  for (const s of BOOKMARK_SLOTS) if (!used.has(s)) return s;
  return null;
}
