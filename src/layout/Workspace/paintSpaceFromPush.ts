/**
 * The paint tools' layer space from the ENGINE's frame geometry (B4 round 8):
 * where a comp point lands in a layer's paint-local pixels at the playhead —
 * the layer → comp matrix of the overlay push (kind `transform`: the parent
 * chain and animated values, as drawn) and, for a 3D layer, the view camera
 * the push resolves for the main view mode, the pointer's ray met on the
 * layer's plane (core/paint/paintLocal.ts). A 2D layer's anchor (animated
 * value winning) comes off the document mirror.
 *
 * The layer must be subscribed with `transform` (the selection is; a clone
 * source on another layer rides `useWorkspace`'s paint request).
 */

import { secondsToFlicks } from '@motion/engine-api';
import { Project3D } from '@motion/scene';
import type { Matrix4 } from '@motion/scene';
import { local2D, local3D, localBrushSizeVia } from '@core/paint/paintLocal';
import type { PaintSpace } from '@core/paint/paintSpace';
import { orthoViewOf } from '@core/scene/cameraViewMode';
import { mainViewCamera } from '@core/workspace/displayedView';
import { readTrack } from '@core/mirror/selection';
import { documentMirror } from '@stores/documentMirror';
import { useGuidesStore } from '@stores/guidesStore';
import { MAIN_VIEWPORT, overlayLayer } from '@stores/overlayGeometry';

export function paintSpaceFromPush(nodeId: string, time: number, comp: { width: number; height: number }): PaintSpace | null {
  const m = documentMirror();
  const layer = m.layer(nodeId);
  if (!layer) return null;
  const at = secondsToFlicks(time);
  const mat = overlayLayer(MAIN_VIEWPORT, nodeId, at)?.matrix;
  if (!mat || mat.length < 16) return null;
  // The on-screen scale the matrix carries: what a brush size falls back to where the mapping has no answer.
  const sx = Math.hypot(mat[0]!, mat[1]!) || 1;
  const sy = Math.hypot(mat[4]!, mat[5]!) || 1;
  const fallbackScale = Math.sqrt(sx * sy) || 1;
  const withSize = (toLocal: PaintSpace['toLocal'], is3D: boolean): PaintSpace => ({
    toLocal,
    brushSize: (cp, size) => localBrushSizeVia(toLocal, cp, size) ?? size / fallbackScale,
    is3D,
  });

  if (layer.switches.threeD) {
    const mode = useGuidesStore.getState().camera3dMode;
    // The view on screen — the pointer is over the picture of it.
    const camera = mainViewCamera(comp.width, comp.height, at, mode);
    const ortho = orthoViewOf(mode);
    const world = [...mat] as unknown as Matrix4;
    return withSize(
      (cp) => local3D(world, Project3D.unprojectScreenRay(cp.x, cp.y, camera, ortho, comp.width, comp.height)),
      true,
    );
  }

  const world = { a: mat[0]!, b: mat[1]!, c: mat[4]!, d: mat[5]!, e: mat[12]!, f: mat[13]! };
  const anchor = { x: readTrack(m, nodeId, 'anchorX', time) ?? 0, y: readTrack(m, nodeId, 'anchorY', time) ?? 0 };
  return withSize((cp) => local2D(world, anchor, cp), false);
}
