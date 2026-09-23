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
import { activeCompRootId } from '@core/scene/activeComp';
import { buildLottieFile, buildLottieItem, getLottieItem, prepareLottieFile, previewLottieItem } from '@core/library/lottieLibrary';
import { reportLottieImport, reportLottieImportFailure } from '@core/lottie/lottieImportReport';

/**
 * Insert a bundled Lottie item, centred at (x, y) (comp centre when omitted).
 * Resolves to the new layer ids ([] when nothing landed, null on a refusal).
 */
export async function insertLottieItemEdit(lottieId: string, x?: number, y?: number): Promise<string[] | null> {
  const item = getLottieItem(lottieId);
  if (!item) return [];
  const ids = await insertBuiltLayers(`Insert ${item.name}`, activeCompRootId(), () => buildLottieItem(lottieId, x, y));
  if (ids && ids.length > 0) previewLottieItem(lottieId);
  return ids;
}

/** Import a user's .json / .lottie file into the active comp and report the outcome. */
export async function importLottieFileEdit(file: File): Promise<void> {
  let prepared;
  try {
    prepared = await prepareLottieFile(file);
  } catch (err) {
    reportLottieImportFailure(file.name, err);
    return;
  }
  const ids = await insertBuiltLayers(`Import ${file.name}`, activeCompRootId(), () => buildLottieFile(prepared));
  if (ids === null) return; // refused (toasted by insertBuiltLayers)
  reportLottieImport(file.name, { nodeIds: ids, warnings: prepared.warnings });
}
