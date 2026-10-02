/**
 * The CURRENT VIEW's world→screen projection, in one place.
 *
 * Every surface that has to agree with the rendered pixels needs this exact
 * branch — ortho views project with no camera at all, custom views project
 * through their STORED view camera (the scene camera is ignored), and the
 * active camera / a `camera:<id>` view project through the camera the engine
 * resolved for the frame on screen (the overlay geometry push's view camera,
 * `OverlayView` — position, focal length, orbit, parents lifted, exactly as it
 * rendered). Getting any of that subtly different is what makes selection
 * outlines drift off the layers they belong to.
 *
 * The view mode's camera rides the main viewport's frames once someone asks
 * for it (`requestOverlayLayers(…, views)`: the viewport's own mode is held by
 * viewNav.ts, a pane's by its scene port); before the first such frame the
 * default camera framed to the comp stands in.
 */

import { secondsToFlicks } from '@motion/engine-api';
import { Project3D } from '@motion/scene';
import { useGuidesStore, type Camera3dMode } from '@stores/guidesStore';
import { MAIN_VIEWPORT, overlayView } from '@stores/overlayGeometry';
import { orthoViewOf } from '@core/scene/cameraViewMode';
import { projectorOf, viewCameraOf } from '@core/mirror/viewGeometry';

export type Projector = (p: { x: number; y: number; z: number }) => Project3D.Projected;

/**
 * One-entry memo of the projector, valid for the CURRENT TASK ONLY: the view
 * is the same for every layer in a frame, and the hit-test index asks per
 * node. Scoped to the task rather than keyed on revisions, so a camera edit
 * landing in a later task can never be served a projector built before it.
 */
let memo: { key: string; projector: Projector } | null = null;
let memoScheduled = false;

/** Invalidate the cached projector (exported for tests). */
export function resetViewProjectorCache(): void {
  memo = null;
}

/**
 * Build the projector for the view that is on screen right now.
 *
 * `time` is raw COMP time (seconds) — the frame whose view camera is used.
 */
export function currentViewProjector(
  width: number,
  height: number,
  time: number,
  view?: Camera3dMode,
): Projector {
  // An explicit view is what lets a SECONDARY pane be interactive: its nodes
  // must project through the view IT shows, not through whatever the main
  // viewport happens to be set to.
  const mode = view ?? useGuidesStore.getState().camera3dMode;
  const key = `${width}|${height}|${time}|${mode}`;
  if (memo && memo.key === key) return memo.projector;
  const camera = viewCameraOf(mode, overlayView(MAIN_VIEWPORT, mode, secondsToFlicks(time)), useGuidesStore.getState().customViews, width, height);
  const projector: Projector = projectorOf(mode, camera, width, height);
  memo = { key, projector };
  if (!memoScheduled) {
    memoScheduled = true;
    // Drop it before anything else can run — no state change can be missed.
    queueMicrotask(() => {
      memo = null;
      memoScheduled = false;
    });
  }
  return projector;
}

/**
 * The CAMERA a view projects through, or null for the six orthographic views
 * (which are parallel projections and have no camera at all).
 *
 * Exported because turning a drag back into a world translation needs the same
 * camera the projection used — its basis for direction, and a layer's projected
 * `scale` for magnitude.
 */
export function currentViewCamera(
  width: number,
  height: number,
  time: number,
  view?: Camera3dMode,
): Project3D.Camera3D | null {
  const mode = view ?? useGuidesStore.getState().camera3dMode;
  if (orthoViewOf(mode)) return null;
  return viewCameraOf(mode, overlayView(MAIN_VIEWPORT, mode, secondsToFlicks(time)), useGuidesStore.getState().customViews, width, height);
}
