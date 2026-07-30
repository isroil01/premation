/**
 * "Export as .motion" — the escape hatch that makes read-only cloud honest.
 *
 * This is the single most load-bearing feature in the whole trial design. The
 * pitch to a lapsed account is "your projects are read-only, but you can always
 * export them and run the free self-hosted build" — and that sentence is only
 * true if the export button actually works, offline, with no subscription. A
 * read-only cloud that could not hand your work back would be a hostage
 * situation, and the AGPL story would be a bluff.
 *
 * There is no new machinery here, and that is the point: a cloud project and a
 * local one share ONE in-memory scene graph, and `ProjectManager.saveAs` already
 * captures that graph and writes it as a `.motion` bundle through the native save
 * dialog. So "export a cloud project" is just "save the current scene to a file
 * the user picks" — the same code the local-first Save As has always run. The
 * read-only paywall gates the SERVER; it was never able to gate the bytes already
 * decoded in this process.
 */

import { getProjectManager } from '@core/services/coreServices';

/** A filesystem-safe stem from a human title, or a sensible default. */
function safeName(raw: string | null | undefined): string {
  const cleaned = (raw ?? '').trim().replace(/[/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Native dialogs suggest this and let the user change it, so a bland fallback
  // is fine — it never silently becomes the final filename.
  return cleaned || 'Motion project';
}

export interface ExportResult {
  /** True when a file was written. False when the user cancelled the dialog. */
  saved: boolean;
  /** Set only on a real failure — a cancel is not an error. */
  error?: string;
}

/**
 * Write the current scene to a `.motion` bundle the user chooses.
 *
 * `saveAs` opens the native save dialog, so a cancelled dialog resolves `false`
 * and must NOT read as a failure — showing an error because someone changed their
 * mind is its own small insult. A thrown error is the real failure.
 */
export async function exportCurrentProjectAsBundle(suggestedName?: string): Promise<ExportResult> {
  try {
    const saved = await getProjectManager().saveAs(safeName(suggestedName));
    return { saved };
  } catch (err) {
    return { saved: false, error: err instanceof Error ? err.message : 'Could not export the project.' };
  }
}
