/**
 * A layer's local ↔ screen mapping for a viewport overlay (layout/Workspace/
 * layerScreen.ts): subscribes the layer to the overlay geometry push (kind
 * `transform`) and rebuilds the mapping when a frame's records land, the time,
 * the view mode (a 3D layer is seen through the view on screen) or the 2D view
 * (`camera`) changes. Null until the first record.
 */

import { useMemo } from 'react';
import type { OverlayKind } from '@motion/engine-api';
import { useOverlayRequest } from '@hooks/useOverlayRequest';
import { useGuidesStore } from '@stores/guidesStore';
import { layerScreenMapping, type LayerScreenMapping } from './layerScreen';
import type { Camera2DLike } from './cameraTypes';

/** What a mapping reads off the push. */
export const LAYER_SCREEN_KINDS: readonly OverlayKind[] = ['transform', 'bounds'];
const NO_VIEWS: readonly string[] = [];

export function useLayerScreenMapping(
  nodeId: string | null,
  time: number,
  comp: { width: number; height: number },
  camera: Camera2DLike,
  deps: unknown = 0,
): LayerScreenMapping | null {
  const layers = useMemo(() => (nodeId ? [nodeId] : []), [nodeId]);
  // The view the layer is seen through (layerScreen.ts): its pushed camera rides
  // the frames for the viewport's lifetime (viewNav.ts `requestMainViewCamera`).
  const mode = useGuidesStore((s) => s.camera3dMode);
  const tick = useOverlayRequest('layerScreen', layers, LAYER_SCREEN_KINDS, NO_VIEWS);
  return useMemo(() => {
    if (!nodeId) return null;
    return layerScreenMapping(nodeId, time, comp, camera);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- comp by size; camera: a new one per view (useDisplayedCamera2D); mode: the view projected through; deps: the caller's own redraw trigger
  }, [nodeId, time, comp.width, comp.height, camera, tick, mode, deps]);
}
