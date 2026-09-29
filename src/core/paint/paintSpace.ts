/**
 * Comp viewer → paint space: where a pointer lands in a layer's own centred
 * pixels, AT THE CURRENT TIME, through everything that places the layer.
 *
 * `compToLayerLocal` (paintCoords) inverts the layer's STATIC x/y/rotation/
 * scale and nothing else. That is right for an unparented, unanimated 2D layer
 * and wrong for every other one: a keyframed layer took the stroke at its rest
 * pose, a parented layer ignored the parent's transform, and a 3D layer was
 * inverted as if it lay flat on the comp — the paint landed somewhere the user
 * did not point, on exactly the layers that move.
 *
 * The transforms come from the resolvers the renderer and the chrome already
 * share, not from a fourth composition kept in step by attention:
 *
 *   · 2D — `world2DAt` (parent chain, animated values, time remap), then the
 *     anchor, which the renderer applies as `−anchor` inside the quad and which
 *     the world affine does not carry.
 *   · 3D — `nodeWorldWithParents3d` (anchor included: its local origin IS the
 *     box centre), and a ray through the VIEW ON SCREEN (`currentViewCamera`,
 *     or the ortho basis for Top/Front/…) intersected with the layer's plane.
 *     An edge-on layer has no intersection, so the caller gets null and says so
 *     rather than painting at the layer origin.
 *
 * Pure pieces (`local2D`, `local3D`, `localBrushSizeVia`, `thinSamples`) are
 * exported for tests; `paintSpaceAt` is the live resolver that gathers inputs.
 */

import { Project3D } from '@motion/scene';
import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { world2DAt } from '@core/scene/layerSpace';
import { nodeWorldWithParents3d } from '@core/scene/liveWorld3d';
import { is3DEnabled } from '@core/scene/threeD';
import { readNodeAnchor } from '@core/scene/anchor';
import { orthoViewOf } from '@core/scene/cameraViewMode';
import { getRemappedTime } from '@core/timeline/TimelineController';
import { currentViewCamera } from '@core/workspace/viewProjection';
import { useGuidesStore } from '@stores/guidesStore';
import { layerScaleOf } from './paintCoords';

type Pt = { x: number; y: number };

export { local2D, local3D, localBrushSizeVia } from './paintLocal';
import { local2D, local3D, localBrushSizeVia } from './paintLocal';

/**
 * Indices of the samples worth keeping: each at least `minDist` from the last
 * kept one (sub-pixel pointer jitter adds nothing to a round-capped polyline),
 * with the final sample always kept so the stroke ends where the pointer did.
 * The Layer panel applies the same 0.5 px rule as it appends (`appendPoint`).
 */
export function thinSamples(points: ReadonlyArray<Pt>, minDist = 0.5): number[] {
  if (points.length === 0) return [];
  const keep = [0];
  let last = points[0]!;
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    if (Math.hypot(p.x - last.x, p.y - last.y) >= minDist) {
      keep.push(i);
      last = p;
    }
  }
  const end = points.length - 1;
  if (keep[keep.length - 1] !== end) keep.push(end);
  return keep;
}

export interface PaintSpace {
  /** Comp px → the layer's centred paint px; null where the layer has no
   *  surface under the point (edge-on 3D, zero scale). */
  toLocal: (cp: Pt) => Pt | null;
  /** Comp-px brush diameter → local units at `cp`. */
  brushSize: (cp: Pt, compSize: number) => number;
  is3D: boolean;
}

/** The live mapping for one layer at comp time `time`, or null when it is gone. */
export function paintSpaceAt(nodeId: string, time: number, comp: { width: number; height: number }): PaintSpace | null {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;
  const fallbackScale = layerScaleOf(node);
  const withSize = (toLocal: PaintSpace['toLocal'], is3D: boolean): PaintSpace => ({
    toLocal,
    brushSize: (cp, size) => localBrushSizeVia(toLocal, cp, size) ?? size / fallbackScale,
    is3D,
  });

  if (is3DEnabled(node)) {
    const world = nodeWorldWithParents3d(node, time);
    if (!world) return null;
    const mode = useGuidesStore.getState().camera3dMode;
    const ortho = orthoViewOf(mode);
    const camera = currentViewCamera(comp.width, comp.height, time) ?? Project3D.defaultCamera(comp.width, comp.height);
    return withSize(
      (cp) => local3D(world, Project3D.unprojectScreenRay(cp.x, cp.y, camera, ortho, comp.width, comp.height)),
      true,
    );
  }

  const world = world2DAt(nodeId, time);
  // Animated anchor wins, as in every other transform reader.
  const av = defaultAnimation.evaluateNode(nodeId, getRemappedTime(nodeId, time));
  const rest = readNodeAnchor(node);
  const anchor = { x: av.get('anchorX') ?? rest.x, y: av.get('anchorY') ?? rest.y };
  return withSize((cp) => local2D(world, anchor, cp), false);
}
