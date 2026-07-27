/**
 * The CURRENT VIEW's world→screen projection, in one place.
 *
 * Every surface that has to agree with the rendered pixels needs this exact
 * branch — ortho views project with no camera at all, custom views project
 * through their STORED view camera (the scene camera is ignored), and the active
 * camera resolves position + focal + orbit through the same `readSceneCamera` the
 * renderer uses. Getting any of that subtly different is what makes selection
 * outlines drift off the layers they belong to.
 *
 * `ports.ts` had the only correct copy, inline. This is that logic extracted so
 * face picking (and anything else that needs to hit-test projected 3D geometry)
 * cannot drift from it.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { flattenScene, readNodeKind } from '@core/scene/sceneDerive';
import { readSceneCamera } from '@core/scene/camera3d';
import { getRemappedTime } from '@core/timeline/TimelineController';
import { defaultAnimation } from '@motion/animation';
import { Project3D } from '@motion/scene';
import { useGuidesStore } from '@stores/guidesStore';
import { customViewCamera, isCustomViewId } from '@core/workspace/customViews';
import type { SceneNode } from '@core/types';

export type Projector = (p: { x: number; y: number; z: number }) => Project3D.Projected;

/**
 * One-entry memo of the projector, valid for the CURRENT TASK ONLY.
 *
 * The view is the same for every layer in a frame, but the hit-test index is
 * rebuilt per node — and building a projector walks the whole scene to find the
 * camera, twice (once here, once inside `readSceneCamera`). That made a rebuild
 * O(N²) full-scene traversals, on every playhead tick during playback and on
 * every drag tick.
 *
 * Scoped to the task rather than keyed on revisions on purpose. The N calls that
 * matter all happen inside ONE synchronous rebuild, so a task-scoped memo
 * collapses the whole cost — while a longer-lived cache would have to enumerate
 * everything a projection depends on (view mode, custom view, camera position,
 * orbit, focal length, AND camera keyframes edited while the playhead is
 * parked). Getting that list wrong freezes the projection and drifts the
 * selection chrome off the layers, which is the exact bug this module exists to
 * prevent. A stale projector is far worse than a repeated one.
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
 * `time` is raw COMP time — the camera's own remap is applied internally, so a
 * caller passes the playhead, not a layer time.
 */
export function currentViewProjector(width: number, height: number, time: number): Projector {
  const key = `${width}|${height}|${time}|${useGuidesStore.getState().camera3dMode}`;
  if (memo && memo.key === key) return memo.projector;
  const projector = buildViewProjector(width, height, time);
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

function buildViewProjector(width: number, height: number, time: number): Projector {
  const cameraMode = useGuidesStore.getState().camera3dMode;

  const orthoView: Project3D.OrthoView | null =
    cameraMode === 'active' || isCustomViewId(cameraMode)
      ? null
      : (cameraMode as Project3D.OrthoView);

  if (orthoView) {
    return (p) => Project3D.projectOrtho(p, orthoView, width, height);
  }

  if (isCustomViewId(cameraMode)) {
    const camera = customViewCamera(useGuidesStore.getState().customViews[cameraMode], width, height);
    return (p) => Project3D.projectPoint(p, camera);
  }

  let cameraNode: SceneNode | undefined;
  for (const n of flattenScene(defaultSceneGraph)) {
    if (readNodeKind(n) === 'camera') {
      cameraNode = n;
      break;
    }
  }

  let camera: Project3D.Camera3D;
  if (!cameraNode) {
    camera = Project3D.defaultCamera(width, height);
  } else {
    // Sample the camera at the playhead — an animated/orbited camera otherwise
    // projects through frame 0's view.
    const camNode = cameraNode;
    const camTime = getRemappedTime(camNode.id, time);
    const camValues = defaultAnimation.evaluateNode(camNode.id, camTime);
    camera = readSceneCamera(defaultSceneGraph, width, height, (id, p) =>
      id === camNode.id ? camValues.get(p) : undefined,
    );
  }
  return (p) => Project3D.projectPoint(p, camera);
}
