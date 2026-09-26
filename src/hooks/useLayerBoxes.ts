/**
 * Re-render when the engine's layer boxes land (`layerBoxAt`, src/stores/layerBoxes.ts).
 * Read the boxes in render with `layerBoxAt(layer, time)`; the document revision
 * that invalidates them already re-renders a component reading the mirror.
 */

import { useSyncExternalStore } from 'react';
import { layerBoxesVersion, subscribeLayerBoxes } from '@stores/layerBoxes';

export function useLayerBoxes(): number {
  return useSyncExternalStore(subscribeLayerBoxes, layerBoxesVersion, layerBoxesVersion);
}
