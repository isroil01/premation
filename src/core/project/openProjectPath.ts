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
import type { ProjectRef } from '@core/project/ProjectManager';
import { bumpScene } from '@stores/sceneStore';
import { useHistoryStore } from '@stores/historyStore';

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
  useHistoryStore.getState().reset();
  useHistoryStore.getState().record('Open', true);
  bumpScene();
  return ref;
}
