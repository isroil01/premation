/**
 * A layer's local ↔ screen mapping for a viewport overlay (layout/Workspace/
 * layerScreen.ts): subscribes the layer to the overlay geometry push (kind
 * `transform`, the `active` view camera) and rebuilds the mapping when a
 * frame's records land or the time changes. Null until the first record.
 */

import { useMemo } from 'react';
import type { OverlayKind } from '@motion/engine-api';
import { useOverlayRequest } from '@hooks/useOverlayRequest';
import { layerScreenMapping, type LayerScreenMapping } from './layerScreen';
import type { Camera2DLike } from './cameraTypes';

/** What a mapping reads off the push. */
export const LAYER_SCREEN_KINDS: readonly OverlayKind[] = ['transform', 'bounds'];
export const LAYER_SCREEN_VIEWS: readonly string[] = ['active'];

export function useLayerScreenMapping(
  nodeId: string | null,
  time: number,
  comp: { width: number; height: number },
  camera: Camera2DLike,
  deps: unknown = 0,
): LayerScreenMapping | null {
  const layers = useMemo(() => (nodeId ? [nodeId] : []), [nodeId]);
  const tick = useOverlayRequest('layerScreen', layers, LAYER_SCREEN_KINDS, LAYER_SCREEN_VIEWS);
  return useMemo(() => {
    if (!nodeId) return null;
    return layerScreenMapping(nodeId, time, comp, camera);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- camera is a live singleton; deps: the caller's own redraw trigger
  }, [nodeId, time, comp.width, comp.height, tick, deps]);
}
