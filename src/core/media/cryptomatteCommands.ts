/**
 * "ID matte from Cryptomatte" — the command behind the Track Matte picker's
 * "ID matte: <object>" entries (plan C2).
 *
 * Which Cryptomatte set a layer carries (the bake, `idMattePngFile`, is pure
 * and lives in cryptomatte.ts). The edit itself (import, insert above the EXR
 * layer, set as its LUMA matte) goes through the engine —
 * src/layout/Inspector/idMatteEdits.ts.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getCryptomatteForAsset, type CryptomatteSet } from './cryptomatte';

/** The EXR asset a layer draws, if it carries a Cryptomatte set. */
export function cryptomatteForNode(nodeId: string): { assetId: string; set: CryptomatteSet } | null {
  const node = defaultSceneGraph.getNode(nodeId);
  const t = node?.components.find((c) => c.type === 'Transform');
  const assetId = t?.props.assetId;
  if (typeof assetId !== 'string' || !assetId) return null;
  const set = getCryptomatteForAsset(assetId);
  return set ? { assetId, set } : null;
}
