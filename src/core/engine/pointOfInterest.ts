/**
 * `transform/orientTowardsPointOfInterest` (B3z, ENGINE_API.md §15.9) — AE's
 * Auto-Orientation ▸ Orient Towards Point of Interest for a camera or a light:
 * a two-node camera / targeted light carries Point of Interest X/Y/Z
 * (`poiX/poiY/poiZ` on its Transform); a one-node one carries none.
 *
 *   read    true while any component stores a numeric poiX / poiY / poiZ
 *   true    adds the missing ones at the composition centre (w/2, h/2, 0 —
 *           sceneInsert's two-node camera); a layer that has them is unchanged
 *   false   removes all three with their keyframes and expressions (the
 *           renderer samples poi tracks: a leftover key would keep the layer
 *           two-node)
 *
 * The C++ engine ports this file (native/engine/src/core/strokes.cpp).
 */

import type { Value } from '@motion/engine-api';
import type { SceneNode } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useProjectStore } from '@stores/projectStore';
import { fail } from './errors';
import { compOfLayer } from './doc';
import { dropTrackProps } from './fields';

export const POI_PATH = 'transform/orientTowardsPointOfInterest';
const POI = ['poiX', 'poiY', 'poiZ'] as const;

export function hasPointOfInterest(node: SceneNode): boolean {
  return node.components.some((c) => POI.some((k) => typeof (c.props as Record<string, unknown>)[k] === 'number'));
}

export function readPointOfInterest(node: SceneNode): Value {
  return { kind: 'bool', value: hasPointOfInterest(node) };
}

export function writePointOfInterest(layerId: string, node: SceneNode, value: Value): void {
  if (value.kind !== 'bool') fail('typeMismatch', `'${POI_PATH}' takes a bool, got ${value.kind}`, { path: POI_PATH, detail: JSON.stringify({ expected: 'bool' }) });
  if (!value.value) {
    for (const c of node.components) {
      for (const k of POI) if ((c.props as Record<string, unknown>)[k] !== undefined) defaultSceneGraph.writeProp(layerId, c.id, k, undefined);
    }
    dropTrackProps(layerId, new Set(POI));
    return;
  }
  if (hasPointOfInterest(node)) return;
  const t = node.components.find((c) => c.type === 'Transform');
  if (!t) fail('notFound', `layer '${layerId}' has no Transform`, { layer: layerId, path: POI_PATH });
  const comp = compOfLayer(layerId);
  const rec = (comp ? useProjectStore.getState().comps[comp] : undefined) as { width?: number; height?: number } | undefined;
  defaultSceneGraph.writeProp(layerId, t.id, 'poiX', (rec?.width ?? 1920) / 2);
  defaultSceneGraph.writeProp(layerId, t.id, 'poiY', (rec?.height ?? 1080) / 2);
  defaultSceneGraph.writeProp(layerId, t.id, 'poiZ', 0);
}
