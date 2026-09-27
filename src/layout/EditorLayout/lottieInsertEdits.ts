/**
 * Lottie inserts through the engine API.
 *
 * A Lottie becomes a layer tree (shapes, keyframes, parent links, track
 * mattes). Since 2026-09-28 the importer is an ENGINE CLIENT
 * (engine-client/lottieFragment.ts): its plan is laid straight into a
 * `pasteLayers` fragment — no scratch run of the TypeScript scene graph — and
 * lands as ONE command: one undo entry, replayable in both engines; the links
 * and mattes between the new layers follow the copies (pasteLayers remaps
 * references inside the fragment). Shared by the Library panel, the canvas
 * drop (Workspace) and File ▸ Import ▸ Lottie (TopNav).
 */

import { edit } from '@core/engine/uiEdits';
import { activeCompIdNow } from '@hooks/useMirror';
import { documentMirror } from '@stores/documentMirror';
import { useSelectionStore } from '@stores/selectionStore';
import { settingsDurationSeconds, settingsFps } from '@core/mirror/compFacts';
import { LOTTIE_DESIGN_CENTER, getLottieItem, prepareLottieFile, previewLottieItem } from '@core/library/lottieLibrary';
import { planLottieImport, type ImportPlan } from '@core/lottie/lottieImport';
import { reportLottieImport, reportLottieImportFailure } from '@core/lottie/lottieImportReport';
import { buildLottieFragment } from '@/engine-client/lottieFragment';

/**
 * Lay `plan` into a fragment for `comp` and paste it (one entry). The new
 * layers are selected. Resolves to their ids ([] when the plan made none,
 * null when the engine refused — reported by `edit`).
 */
async function pasteLottie(label: string, comp: string, plan: ImportPlan, offset: { x: number; y: number }): Promise<string[] | null> {
  const settings = documentMirror().comp(comp)?.settings;
  const { built } = buildLottieFragment(plan, {
    offset,
    compFps: settingsFps(settings),
    compDurationSeconds: settingsDurationSeconds(settings),
  });
  if (!built) return [];
  const res = await edit(label, [{ type: 'pasteLayers', comp, fragment: built.fragment }]);
  if (!res.ok) return null;
  const ids = (res.value[0] as { layers?: string[] } | undefined)?.layers ?? [];
  if (ids.length > 0) useSelectionStore.getState().set(ids);
  return ids;
}

/**
 * Insert a bundled Lottie item, centred at (x, y) (comp centre when omitted).
 * Resolves to the new layer ids ([] when nothing landed, null on a refusal).
 */
export async function insertLottieItemEdit(lottieId: string, x?: number, y?: number): Promise<string[] | null> {
  const item = getLottieItem(lottieId);
  if (!item) return [];
  const comp = activeCompIdNow() ?? 'comp_root';
  const settings = documentMirror().comp(comp)?.settings;
  const px = x ?? (settings?.width ?? 1920) / 2;
  const py = y ?? (settings?.height ?? 1080) / 2;
  const ids = await pasteLottie(`Insert ${item.name}`, comp, planLottieImport(item.doc), { x: px - LOTTIE_DESIGN_CENTER, y: py - LOTTIE_DESIGN_CENTER });
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
  const ids = await pasteLottie(`Import ${file.name}`, activeCompIdNow() ?? 'comp_root', prepared.plan, prepared.offset);
  if (ids === null) return; // refused (toasted by edit)
  reportLottieImport(file.name, { nodeIds: ids, warnings: prepared.warnings });
}
