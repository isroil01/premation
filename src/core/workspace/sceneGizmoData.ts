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
import { flattenComposition, readNodeKind } from '@core/scene/sceneDerive';
import { activeCompRootId } from '@core/scene/activeComp';
import { canBe3D, is3DEnabled, readNode3D } from '@core/scene/threeD';
import { readNodeLight } from '@core/scene/light';
import {
  cameraFromNode,
  readCameraFocusDistance,
  readCameraPoi,
} from '@core/scene/camera3d';
import {
  deviceWorldPosition,
  deviceWorldRotationDeg,
  nodeWorldWithParents3d,
  toWorldPointAt,
} from '@core/scene/liveWorld3d';
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

  // Comp-scoped, not scene-wide. In After Effects a camera or light belongs to
  // its composition and affects nothing outside it — there is no scene-wide
  // anything. Walking the whole project drew every other composition's cameras
  // and lights into this one's viewport.
  for (const node of flattenComposition(defaultSceneGraph, activeCompRootId())) {
    const kind = readNodeKind(node);
    const selected = selectedIds.has(node.id);

    if (kind === 'camera') {
      if (node.id === opts.viewingThroughCameraId) continue;
      const sample = sampleOf(node.id);
      // `toWorldPointAt` is the SAME parent lift the renderer hands
      // `cameraFromNode`. Without it the gizmo resolved the camera's raw local
      // props, so every parented camera's frustum and chassis were drawn at the
      // position the rig had moved it away from.
      const cam = cameraFromNode(node, compWidth, compHeight, sample, (id, p) =>
        toWorldPointAt(id, time, p),
      );
      out.push(
        SceneGizmos.buildCameraGizmo({
          nodeId: node.id,
          position: cam.position,
          orientation: cam.orientation,
          focalLength: cam.focalLength,
          focusDistance: readCameraFocusDistance(node, compWidth, sample),
          // `readCameraPoi` returns null for a ONE-node camera, and that
          // distinction has to survive the parent lift — defaulting the POI
          // would draw a target crosshair on every camera that never had one.
          // When it exists it rides the parent transform with the eye (see
          // `liveWorld3d`'s POI convention note).
          poi: (() => {
            const local = readCameraPoi(node, compWidth, compHeight, sample);
            return local ? toWorldPointAt(node.id, time, local) : null;
          })(),
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
      // Parent-aware, through the same resolver the renderer's wash, Lambert
      // shading and shadow light all use. This read the raw LOCAL props, so a
      // light on a null rig had its cone and falloff sphere drawn where the
      // light used to be while the pixels it produced came from somewhere else.
      const position = deviceWorldPosition(node, time);
      // The aim rides the same parent transform as the origin — otherwise
      // parenting a spot to a null swings its source while its target stays
      // nailed to a fixed comp point, i.e. the cone shears open as the rig moves.
      const poi = lt.poi
        ? toWorldPointAt(node.id, time, {
            x: values.get('poiX') ?? lt.poi.x,
            y: values.get('poiY') ?? lt.poi.y,
            z: values.get('poiZ') ?? lt.poi.z,
          })
        : null;
      out.push(
        SceneGizmos.buildLightGizmo({
          nodeId: node.id,
          type: lt.type,
          position,
          radius: values.get('radius') ?? lt.radius,
          cone: values.get('lightCone') ?? lt.cone,
          coneFeatherPct: values.get('lightConeFeather') ?? lt.coneFeather,
          // Direction PLUS the layer's world rotation — the same sum
          // `buildSnapshot` aims the wash and the shading with.
          angleDeg: (values.get('lightAngle') ?? lt.angle) + deviceWorldRotationDeg(node, time),
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

    // Parent chain INCLUDED. `nodeWorld3d` composes a node's own local
    // transform only, so every parented 3D layer's bounding box was drawn at
    // its unparented position — the same drift as the camera and light gizmos,
    // in a third place.
    const world = nodeWorldWithParents3d(node, time);
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
