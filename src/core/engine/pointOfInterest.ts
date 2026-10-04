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

export const POI_PATH = 'transform/orientTowardsPointOfInterest';
const POI = ['poiX', 'poiY', 'poiZ'] as const;

export function hasPointOfInterest(node: SceneNode): boolean {
  return node.components.some((c) => POI.some((k) => typeof (c.props as Record<string, unknown>)[k] === 'number'));
}

export function readPointOfInterest(node: SceneNode): Value {
  return { kind: 'bool', value: hasPointOfInterest(node) };
}
