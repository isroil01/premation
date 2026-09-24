/**
 * "ID matte from Cryptomatte" through the engine API (B3, docs/B3_PATTERNS.md)
 * — the Track Matte picker's "ID matte: <object>" entries (plan C2).
 *
 * The chosen objects' coverage is baked to a grey PNG in memory and imported
 * from its bytes (`importBytes`); the PNG is then inserted as a layer, moved
 * directly above the EXR layer and set as that layer's LUMA matte by
 * reference, all in ONE entry ("ID Matte"). An ID matte is a matte layer like
 * any other, so it keys, animates, blurs and exports through the machinery
 * track mattes already have.
 *
 * Reads come from the document mirror (B4); the Cryptomatte set itself is
 * media, not document, and is read from the decoded EXR.
 */

import type { Command } from '@motion/engine-api';
import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow } from '@hooks/useMirror';
import { getCryptomatteForAsset, idMattePngFile } from '@core/media/cryptomatte';
import { useSelectionStore } from '@stores/selectionStore';
import { importBrowserFilesEdit } from '@layout/Assets/assetEdits';
import { insertMediaEdit } from '@layout/Workspace/footageEdits';

/** Resolves to the matte layer's id, or null when nothing was made (no set, a refusal — toasted). */
export async function createIdMatteLayerEdit(nodeId: string, layerName: string, objectNames: ReadonlyArray<string>): Promise<string | null> {
  const m = documentMirror();
  const layer = m.layer(nodeId);
  const set = layer?.source ? getCryptomatteForAsset(layer.source) : undefined;
  if (!set) return null;
  const file = await idMattePngFile(set, layerName, objectNames, layer?.name ?? 'EXR');
  if (!file) return null;
  const { imported: [asset] } = await importBrowserFilesEdit([{ file }], 'Import ID Matte');
  if (!asset) return null;

  const comp = activeCompIdNow();
  if (!comp) return null;
  // Directly above the EXR layer when it sits at the top of the comp, where
  // the insert lands (a reorder never re-parents). Its stack index is taken
  // now: the matte arrives at the top, so the index without it is unchanged.
  const toIndex = layer && layer.parent === undefined ? (m.comp(comp)?.layers.indexOf(nodeId) ?? -1) : -1;
  const ids = await insertMediaEdit([asset], {
    label: 'ID Matte',
    follow: (selected): Command[] => {
      const matte = selected[0];
      if (!matte) return [];
      const out: Command[] = [];
      if (toIndex >= 0) out.push({ type: 'reorderLayers', comp, layers: [matte], toIndex });
      // By reference, so a later reorder cannot detach it.
      out.push({ type: 'setTrackMatte', layer: nodeId, matte: { layer: matte, mode: 'luma' } });
      return out;
    },
  });
  const matteId = ids?.[0] ?? null;
  if (matteId) useSelectionStore.getState().set([nodeId]);
  return matteId;
}
