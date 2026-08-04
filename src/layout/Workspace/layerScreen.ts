/**
 * Layer-local ↔ screen, for every viewport overlay that draws on a layer.
 *
 * ## The duplication this closes
 *
 * `PuppetOverlay` and `BoneOverlay` each carried a byte-identical
 * `localToScreen`/`screenToLocal` pair built on `worldMatrix(readGeometry(node))`.
 * The existence table that preceded the effect-handle overlay found them; this
 * is the consolidation, and it is not a tidy-up — `worldMatrix` composes the
 * node's OWN translate/rotate/scale and nothing else, so both overlays drew
 * their handles at the unparented position on any parented layer (F23).
 *
 * ## One projection, and what it means
 *
 * The mapping goes through `layerSpaceAt`, which is the same resolver the
 * expression functions `toComp`/`fromComp` use and the same one the effect
 * handle overlay uses. It composes the parent chain via `worldMatrixOf`, and
 * for a 3D layer it goes through `nodeWorldWithParents3d` and the scene camera —
 * so a rig on a parented 3D layer lands correctly too, which the old 2×3 could
 * not express at all.
 *
 * ## It also follows ANIMATED transforms, and that is a second change
 *
 * `layerSpaceAt` samples the node's animated x/y/rotation/scale at `time`,
 * where `worldMatrix(readGeometry(node))` read the STATIC props only. So an
 * overlay on a layer whose own transform is keyframed now tracks the artwork
 * through the animation instead of sitting at the layer's rest pose.
 *
 * That is the same defect class as the parenting bug — an overlay drawn where
 * the artwork is not — and it arrives with the consolidation rather than being
 * chosen separately. It is called out here, and guarded, rather than absorbed
 * silently, because it moves handles in existing projects for a second reason.
 */

import type { Camera2DLike } from './cameraTypes';
import { layerSpaceAt } from '@core/scene/layerSpace';

export interface LayerScreenMapping {
  /** Layer-local px → viewport screen px. */
  localToScreen: (lx: number, ly: number) => { x: number; y: number };
  /** Viewport screen px → layer-local px. */
  screenToLocal: (sx: number, sy: number) => { x: number; y: number };
}

/**
 * Build the mapping for one layer at one time, or null when the node is gone.
 *
 * `camera` is passed rather than fetched so this stays testable with the 1:1
 * camera the overlay tests mock, and so a secondary viewport pane can supply
 * its own.
 */
export function layerScreenMapping(
  nodeId: string,
  time: number,
  comp: { width: number; height: number; rootId?: string },
  camera: Camera2DLike,
): LayerScreenMapping | null {
  const space = layerSpaceAt(nodeId, time, comp);
  if (!space) return null;
  return {
    localToScreen: (lx, ly) => {
      const [cx, cy] = space.toComp([lx, ly]);
      return camera.worldToScreen({ x: cx, y: cy });
    },
    screenToLocal: (sx, sy) => {
      const w = camera.screenToWorld({ x: sx, y: sy });
      const [lx, ly] = space.fromComp([w.x, w.y]);
      return { x: lx, y: ly };
    },
  };
}
