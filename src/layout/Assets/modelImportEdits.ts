/**
 * 3D model import through the engine (B4 round 8, the owner-write audit): the
 * glTF importer builds its layer tree (root null + mesh / node layers, the
 * first clip baked as keys, the model bytes on the root) OFF-document and it
 * lands as ONE `pasteLayers` in the active composition — the engine that owns
 * the document gets it, not only the page's replica.
 */

import { insertBuiltLayers } from '@core/engine/offDocument';
import type { ModelImportResult } from '@core/scene/modelImport';
import { activeCompIdNow } from '@hooks/useMirror';

/** Run `build` (importGltfModel / importModelFiles) as one engine entry. Null when the engine refused. */
export async function importModelEdit(label: string, build: () => ModelImportResult): Promise<ModelImportResult | null> {
  let result: ModelImportResult | null = null;
  const ids = await insertBuiltLayers(label, activeCompIdNow() ?? 'comp_root', () => {
    result = build();
  });
  return ids && ids.length > 0 ? result : null;
}
