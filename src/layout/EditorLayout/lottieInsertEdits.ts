/**
 * Lottie inserts through the engine API (B3z WS-L1).
 *
 * A Lottie becomes a layer tree (shapes, keyframes, parent links, track
 * mattes) built by the importer. The builder runs OFF-document and the result
 * lands as ONE `pasteLayers` — one undo entry, replayable in both engines; the
 * links and mattes between the new layers follow the copies (pasteLayers
 * remaps references inside the fragment). Shared by the Library panel, the
 * canvas drop (Workspace) and File ▸ Import ▸ Lottie (TopNav).
 */

import { insertBuiltLayers } from '@core/engine/offDocument';
import { activeCompIdNow } from '@hooks/useMirror';
import { buildLottieFile, buildLottieItem, getLottieItem, prepareLottieFile, previewLottieItem } from '@core/library/lottieLibrary';
import { reportLottieImport, reportLottieImportFailure } from '@core/lottie/lottieImportReport';
import { documentMirror } from '@stores/documentMirror';
import { DEFAULT_COMPOSITION } from '@stores/compositionStore';
import { settingsDurationSeconds } from '@core/mirror/compFacts';

/** The active composition's size and length (the document mirror, B4); the default comp when there is none. */
function activeCompFrame(): { width: number; height: number; durationSeconds: number } {
  const s = documentMirror().comp(activeCompIdNow() ?? '')?.settings;
  if (!s) return { width: DEFAULT_COMPOSITION.width, height: DEFAULT_COMPOSITION.height, durationSeconds: DEFAULT_COMPOSITION.durationSeconds };
  return { width: s.width, height: s.height, durationSeconds: settingsDurationSeconds(s) };
}

/**
 * Insert a bundled Lottie item, centred at (x, y) (comp centre when omitted).
 * Resolves to the new layer ids ([] when nothing landed, null on a refusal).
 */
export async function insertLottieItemEdit(lottieId: string, x?: number, y?: number): Promise<string[] | null> {
  const item = getLottieItem(lottieId);
  if (!item) return [];
  // B4-kept: the builder runs OFF-document against the TS engine's scratch state (insertBuiltLayers → ONE pasteLayers).
  const ids = await insertBuiltLayers(`Insert ${item.name}`, (activeCompIdNow() ?? 'comp_root'), () => buildLottieItem(lottieId, x, y));
  if (ids && ids.length > 0) previewLottieItem(lottieId);
  return ids;
}

/** Import a user's .json / .lottie file into the active comp and report the outcome. */
export async function importLottieFileEdit(file: File): Promise<void> {
  let prepared;
  try {
    prepared = await prepareLottieFile(file, activeCompFrame);
  } catch (err) {
    reportLottieImportFailure(file.name, err);
    return;
  }
  const ids = await insertBuiltLayers(`Import ${file.name}`, (activeCompIdNow() ?? 'comp_root'), () => buildLottieFile(prepared));
  if (ids === null) return; // refused (toasted by insertBuiltLayers)
  reportLottieImport(file.name, { nodeIds: ids, warnings: prepared.warnings });
}
