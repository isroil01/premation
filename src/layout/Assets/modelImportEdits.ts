/**
 * 3D model import through the engine (B4 round 8, the owner-write audit): the
 * glTF importer lays its layer tree (root null + mesh / node layers, the first
 * clip baked as keys, the model bytes on the root) into a fragment — no page
 * replica — and it lands as ONE `pasteLayers` in the active composition, the
 * root selected.
 */

import type { ModelImportResult } from '@core/scene/modelImport';
import type { FragmentBuilder } from '@/engine-client/fragmentBuilder';
import { insertFragment, type InsertFrame } from '@/engine-client/insertFragment';

/** Run `build` (buildGltfModel / buildModelFiles) as one engine entry. Null when it failed or the engine refused (toasted). */
export async function importModelEdit(
  label: string,
  build: (b: FragmentBuilder, frame: InsertFrame) => ModelImportResult,
): Promise<ModelImportResult | null> {
  let result: ModelImportResult | null = null;
  const ids = await insertFragment(label, (b, frame) => {
    result = build(b, frame);
    return result.rootId;
  });
  return ids && ids.length > 0 ? result : null;
}
