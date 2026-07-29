/**
 * Collect the scene's reference geometry for the viewport overlay.
 *
 * This is the app-side half of `@motion/workspace`'s sceneGizmos: it walks the
 * live scene at the current playhead, resolves each camera / light / 3D layer
 * the same way the RENDERER resolves it, and hands the pure geometry builders
 * exactly the numbers buildSnapshot would use. Resolving them any other way is
 * how chrome drifts off the pixels, which this codebase has already paid for
 * more than once (see the `av.get(p) ?? base` note in nodeMatrix.ts).
 *
 * Everything here is world-space; projection is the overlay's job, so the same
 * output serves the active camera, the six axis views and the custom views.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { flattenScene, readNodeKind } from '@core/scene/sceneDerive';
import { canBe3D, is3DEnabled, readNode3D } from '@core/scene/threeD';
import { readNodeLight } from '@core/scene/light';
import {
  cameraFromNode,
  readCameraFocusDistance,
  readCameraPoi,
} from '@core/scene/camera3d';
import { nodeWorld3d } from '@core/scene/nodeMatrix';
import { readGeometry, localBounds } from '@core/workspace/geometry';
import { getRemappedTime } from '@core/timeline/TimelineController';
import { defaultAnimation } from '@motion/animation';
import { SceneGizmos, type SceneGizmo } from '@motion/workspace';

export interface CollectGizmosOptions {
  /** Raw comp time of the playhead. */
  time: number;
  compWidth: number;
  compHeight: number;
  /** Selected node ids — selected gizmos draw brighter. */
  selectedIds: ReadonlySet<string>;
  /**
   * The camera layer the viewport is currently looking THROUGH, if any.
   *
   * Its gizmo is suppressed: AE draws a camera in every view except its own,
   * and for good reason — from inside the camera the frustum cone is a shape
   * wrapped around the viewer, which renders as a full-screen X of lines over
   * the whole comp.
   */
  viewingThroughCameraId: string | null;
  /** Draw bounding boxes for 3D layers. Off in Draft 3D-less flat scenes. */
  includeLayerBoxes: boolean;
}

export function collectSceneGizmos(opts: CollectGizmosOptions): SceneGizmo[] {
  const { time, compWidth, compHeight, selectedIds } = opts;
  const out: SceneGizmo[] = [];

  /** Animated-value lookup for one node at the playhead (remapped like the renderer). */
  const sampleOf = (nodeId: string) => {
    const values = defaultAnimation.evaluateNode(nodeId, getRemappedTime(nodeId, time));
    return (id: string, prop: string): number | undefined =>
      id === nodeId ? values.get(prop) : undefined;
  };

  for (const node of flattenScene(defaultSceneGraph)) {
    const kind = readNodeKind(node);
    const selected = selectedIds.has(node.id);

    if (kind === 'camera') {
      if (node.id === opts.viewingThroughCameraId) continue;
      const sample = sampleOf(node.id);
      const cam = cameraFromNode(node, compWidth, compHeight, sample);
      out.push(
        SceneGizmos.buildCameraGizmo({
          nodeId: node.id,
          position: cam.position,
          orientation: cam.orientation,
          focalLength: cam.focalLength,
          focusDistance: readCameraFocusDistance(node, compWidth, sample),
          poi: readCameraPoi(node, compWidth, compHeight, sample),
          compWidth,
          compHeight,
          selected,
        }),
      );
      continue;
    }

    if (kind === 'light') {
      const values = defaultAnimation.evaluateNode(node.id, getRemappedTime(node.id, time));
      const lt = readNodeLight(node);
      const g = readGeometry(node);
      // Same trap the renderer documents twice: `values` holds ANIMATED props
      // only, so falling back to a literal pins un-keyframed lights to the
      // origin / to z = 0 instead of where the user actually put them.
      const position = {
        x: values.get('x') ?? g?.x ?? compWidth / 2,
        y: values.get('y') ?? g?.y ?? compHeight / 2,
        z: values.get('z') ?? readNode3D(node).z,
      };
      const poi = lt.poi
        ? {
            x: values.get('poiX') ?? lt.poi.x,
            y: values.get('poiY') ?? lt.poi.y,
            z: values.get('poiZ') ?? lt.poi.z,
          }
        : null;
      out.push(
        SceneGizmos.buildLightGizmo({
          nodeId: node.id,
          type: lt.type,
          position,
          radius: values.get('radius') ?? lt.radius,
          cone: values.get('lightCone') ?? lt.cone,
          coneFeatherPct: values.get('lightConeFeather') ?? lt.coneFeather,
          angleDeg: values.get('lightAngle') ?? lt.angle,
          poi,
          compWidth,
          selected,
        }),
      );
      continue;
    }

    if (!opts.includeLayerBoxes) continue;
    if (!canBe3D(node) || !is3DEnabled(node)) continue;
    if (node.visible === false) continue;

    const world = nodeWorld3d(node, time);
    const g = readGeometry(node);
    if (!world || !g) continue;
    const values = defaultAnimation.evaluateNode(node.id, getRemappedTime(node.id, time));
    out.push(
      SceneGizmos.buildLayerBoxGizmo({
        nodeId: node.id,
        world,
        bounds: localBounds(g),
        extrusionDepth: Math.max(0, values.get('extrusionDepth') ?? readNode3D(node).extrusionDepth),
        selected,
      }),
    );
  }

  return out;
}
