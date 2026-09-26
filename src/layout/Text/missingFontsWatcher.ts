/**
 * The missing-font warning: after a project opens, scan its text layers and,
 * when any family cannot be drawn here, show ONE toast — "N fonts missing" —
 * whose action opens Replace Fonts.
 *
 * One toast, grouped, not one per font: a project from another machine can be
 * missing a dozen, and a dozen toasts is a wall. The dialog is where the list
 * belongs.
 *
 * Runs on `ProjectLoaded` (every open path through ProjectManager: new, open,
 * open-path, adopt). Deferred a beat so the document's web fonts have had a
 * chance to register before availability is judged.
 */

import { getEventBus } from '@core/events/EventBus';
import { documentMirror } from '@stores/documentMirror';
import { loadTextTrees, mirrorMissingFonts } from '@core/mirror/fonts';
import { useUIStore } from '@stores/uiStore';
import { detectFontAvailability } from '@core/fonts/fontAvailability';
import { familyKey, missingFontsMessage, type FontUsage } from '@core/fonts/missingFonts';
import { openReplaceFontsDialog } from './ReplaceFontsDialog';

export const MISSING_FONTS_TOAST_GROUP = 'missing-fonts';

/** Scan now and warn if anything is missing. Resolves the missing usages. */
export async function checkMissingFonts(
  isAvailable?: (family: string) => boolean,
): Promise<FontUsage[]> {
  // B4: every text layer's families from the document mirror (its trees loaded first).
  const m = documentMirror();
  await loadTextTrees(m);
  const check = isAvailable ?? await detectFontAvailability();
  const missing = mirrorMissingFonts(m, check);
  if (missing.length > 0) {
    const keys = new Set(missing.map((m) => familyKey(m.family)));
    useUIStore.getState().notify({
      level: 'warning',
      message: missingFontsMessage(missing.length),
      detail: missing.map((m) => m.family).join(', '),
      durationMs: 12000,
      group: MISSING_FONTS_TOAST_GROUP,
      action: { label: 'Replace Fonts…', onSelect: () => openReplaceFontsDialog(missing, keys) },
    });
  }
  return missing;
}

let installed = false;

/** Subscribe to project opens (idempotent). */
export function installMissingFontsWatcher(): void {
  if (installed) return;
  installed = true;
  getEventBus().on('ProjectLoaded', () => {
    setTimeout(() => { void checkMissingFonts(); }, 400);
  });
}
