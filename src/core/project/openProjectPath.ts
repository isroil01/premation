/**
 * Opening a project path into the ALREADY-RUNNING editor.
 *
 * Three surfaces need this now — the Open command, the recovery path, and the
 * start screen's recent list — and opening is not a one-liner: a document that
 * lands in the scene graph without the viewport being told, or with the undo
 * stack still holding the previous project's history, is a project that looks
 * open and behaves wrong.
 *
 * The undo reset is the part worth stating. History is a flat stack with no
 * project identity in it, so an open that leaves it intact lets one Ctrl+Z step
 * back into the PREVIOUS document's state — which this repo has already shipped
 * once, in the form of an undo that wiped a project because history was
 * baselined at the wrong moment. Resetting and re-baselining here is what makes
 * "the first undo after opening does nothing" true.
 *
 * Deliberately NOT a command: commands take no arguments, and a path-carrying
 * "open this specific project" would otherwise have to smuggle its argument
 * through a store.
 */

import { getProjectManager } from '@core/services/coreServices';
import { getCommandSystem } from '@core/commands/CommandSystem';
import type { ProjectRef } from '@core/project/ProjectManager';
import { bumpScene } from '@stores/sceneStore';
import { baselineProjectHistory, afterProjectLoaded } from '@core/project/projectSession';
import { restoreBundleAssets } from '@core/assets/local/bundleAssetCollect';
import { rehydrateReferencedAssets } from '@core/project/sessionAssets';

/**
 * Open `path` and make it the current project. Returns the ref, or null when
 * the path could not be opened (missing bundle, unreadable file).
 *
 * Callers own the user-facing message: the start screen marks a row missing,
 * while the Open command raises a toast, and those are different responses to
 * the same null.
 */
export async function openProjectPath(path: string): Promise<ProjectRef | null> {
  const ref = await getProjectManager().openPath(path);
  if (!ref) return null;
  // Order matters: re-baseline history against the NEW document before the
  // viewport re-reads it, so nothing can record an edit against the old stack.
  baselineProjectHistory('Open');
  bumpScene();
  // And AFTER the bump, because `bumpScene` emits SceneGraphChanged, which the
  // boot wiring turns straight back into markDirty(true) — so a freshly opened
  // project used to arrive already flagged as having unsaved changes.
  afterProjectLoaded();

  // The bundle's own assets back into the library. Fire-and-forget: layers
  // already resolve `motion-blob:` refs straight out of the bundle, so nothing
  // on screen is waiting on this — what it restores is the Assets PANEL, and
  // holding the open on a disk read for a side panel would be the wrong trade.
  // It rebinds and bumps the scene itself when it lands.
  void settleClean(restoreBundleAssets(ref.path));
  // And the DEVICE library's half. New/Close Project empty the session's asset
  // list, so an open that follows one finds nothing to rebind a single-file
  // project's dead `blob:` srcs against. A no-op unless a reset actually parked
  // something this document references; fire-and-forget for the reason above.
  void settleClean(rehydrateReferencedAssets());
  return ref;
}

/**
 * Re-filling the Assets panel is not an edit.
 *
 * Both restores above land a few seconds after the open and bump the scene so
 * layers rebind — and every scene bump is wired to mean "unsaved change". So an
 * untouched project turned "Unsaved changes" three seconds after it opened
 * (seen in the desktop app), and closing it asked whether to discard work
 * nobody had done. Once the restore settles the project is marked clean again —
 * but ONLY if the undo history has not moved since the open: an edit made in
 * those seconds is real, and its dirty flag (and recovery snapshot) must stay.
 */
async function settleClean(work: Promise<unknown>): Promise<void> {
  const history = getCommandSystem().getHistory();
  const entries = history.getEntries().length;
  const index = history.getIndex();
  const opened = getProjectManager().getState().current;
  try { await work; } catch { /* the restore reports its own failures */ }
  // Let the bump it raised (and the markDirty that follows) land first.
  await Promise.resolve();
  const untouched = history.getEntries().length === entries && history.getIndex() === index;
  if (untouched && getProjectManager().getState().current === opened) afterProjectLoaded();
}
