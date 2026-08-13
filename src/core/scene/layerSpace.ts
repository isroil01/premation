/**
 * Layer ↔ composition ↔ world coordinate conversion, for the expression
 * functions `toComp` / `toWorld` / `fromComp` / `fromWorld`.
 *
 * ## What these are for, and the thing they must get right
 *
 * Attaching one layer to a POINT ON another: the corner of a rotated, scaled,
 * parented layer, in composition coordinates. Adding the layer's position to
 * the point is correct only while the layer is unrotated, unscaled and
 * unparented — which is exactly the shape of defect the repeater's comp-space
 * copies were, so it is worth naming.
 *
 * ## Where the transforms come from — deliberately not from here
 *
 * Nothing in this file composes a transform. The 2D path goes through
 * `worldMatrixOf`, the 3D path through `nodeWorldWithParents3d` (which uses
 * `nodeMatrix.parentWorld3d`), and the camera through `readSceneCamera` — the
 * same three the renderer uses. This module only chooses between them and
 * marshals points.
 *
 * That is the rule `liveWorld3d` states and this is a third consumer of it:
 * the renderer answers from its own per-frame caches and the chrome answers
 * from the live graph, but both are the SAME computation, not two
 * implementations kept in step by attention.
 *
 * ## KNOWN LIMIT: converting against the layer the expression is ON
 *
 * The transforms here are resolved through `evaluateNode`, which SAMPLES
 * expressions. So an expression on a layer's own Position that calls
 * `thisLayer.toComp(...)` is genuinely circular: the position feeds the
 * transform that computes the position. Measured in the running app —
 * `toComp([42, 7])[0]` on such a layer returned 14904 rather than 42.
 *
 * It does not hang or corrupt anything: `AnimationEngine.sample` catches the
 * cycle and falls back to the track value, so the number is bounded, just
 * meaningless. AE has the same hazard and reports it as a self-reference.
 *
 * Everything else is unaffected, including the case these functions exist for:
 * `thisComp.layer('Other').toComp(...)` involves no cycle and is exact
 * (verified in the running app against hand-derived coordinates). So is
 * `thisLayer.toComp(...)` from a NON-transform property.
 *
 * The fix is to resolve the EVALUATING node's own transform from keyframes
 * only, exactly as `ExprContext.selfAt` already does for `valueAtTime` — which
 * needs a keyframe-only resolver threaded through both this file's 2D path and
 * `resolveNode3DTransform`'s. Doing it for the 2D path alone would leave the
 * two halves disagreeing, so it is logged whole rather than half-applied.
 *
 * ## Why the shot camera, never the viewport's view
 *
 * `buildSnapshot` will project through an ORTHO view when the editor is showing
 * Top/Front/Left, because that is what the viewport is drawing. Expressions must
 * not: an expression's value cannot depend on which preview view happens to be
 * open, or a rig would move when you looked at it from the side and the exported
 * frame would disagree with the one on screen. `toComp` here always means the
 * shot camera.
 */

import { Matrix, Matrix4Math, Project3D, type Matrix2D, type Vec3 } from '@motion/scene';
import type { LayerSpace } from '@motion/animation';
import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getRemappedTime } from '@core/timeline/TimelineController';
import { worldMatrixOf, type LocalOf, type ParentOf } from '@core/scene/worldTransform';
import { readGeometry } from '@core/workspace/geometry';
import { is3DEnabled } from '@core/scene/threeD';
import { readSceneCamera } from '@core/scene/camera3d';
import { nodeWorldWithParents3d, toWorldPointAt } from '@core/scene/liveWorld3d';
import type { SceneNode } from '@core/types';

/** The composition box the projection needs. Injected so tests need no store. */
export interface SpaceComp {
  width: number;
  height: number;
  rootId?: string;
}

/**
 * A node's own local transform at `time`, animated values winning.
 *
 * `readGeometry` is the same reader `liveParent3DResolvers` uses for the 2D
 * fallback, so a parent chain resolves identically whichever path a child takes.
 */
function localOfAt(time: number): LocalOf {
  return (id) => {
    const node = defaultSceneGraph.getNode(id);
    if (!node) return null;
    const g = readGeometry(node);
    if (!g) return null;
    const av = defaultAnimation.evaluateNode(id, getRemappedTime(id, time));
    const sc = av.get('scale');
    return {
      x: av.get('x') ?? g.x,
      y: av.get('y') ?? g.y,
      rotation: av.get('rotation') ?? g.rotationDeg,
      // Per-axis BEFORE the uniform shorthand, matching every other reader of
      // these tracks (buildSnapshot's `localOf`, ports.ts, nodeMatrix). Reading
      // `scale` first would ignore the tracks the scale gizmo actually autokeys.
      scaleX: av.get('scaleX') ?? sc ?? g.scaleX,
      scaleY: av.get('scaleY') ?? sc ?? g.scaleY,
    };
  };
}

const parentOf: ParentOf = (id) => defaultSceneGraph.getNode(id)?.parent ?? null;

/** The 2D world affine of a node at `time`, parent chain included. */
export function world2DAt(nodeId: string, time: number): Matrix2D {
  return worldMatrixOf(nodeId, localOfAt(time), parentOf, new Map());
}

/** The layer's plane in world space: a point on it and its normal (+Z axis). */
function planeOf(m: readonly number[]): { point: Vec3; normal: Vec3 } {
  const point = Matrix4Math.transformPoint(m as never, { x: 0, y: 0, z: 0 });
  const zAxis = Matrix4Math.transformPoint(m as never, { x: 0, y: 0, z: 1 });
  return {
    point,
    normal: { x: zAxis.x - point.x, y: zAxis.y - point.y, z: zAxis.z - point.z },
  };
}

/**
 * The conversions for one layer at one time, or undefined when the node is gone.
 *
 * 2D and 3D are genuinely different code paths, not one with a flag: a 2D
 * layer's conversion is an invertible affine, while a 3D layer's `fromComp` is a
 * ray/plane intersection that has no matrix form at all.
 */
export function layerSpaceAt(
  nodeId: string,
  time: number,
  comp: SpaceComp,
): LayerSpace | undefined {
  const node: SceneNode | undefined = defaultSceneGraph.getNode(nodeId) ?? undefined;
  if (!node) return undefined;

  if (!is3DEnabled(node)) {
    // ── 2D. The composition IS the world plane. ──────────────────────
    const w = world2DAt(nodeId, time);
    const inv = Matrix.invert(w);
    const toComp = (p: readonly [number, number]): [number, number] => {
      const q = Matrix.transformPoint(w, { x: p[0], y: p[1] });
      return [q.x, q.y];
    };
    const fromComp = (p: readonly [number, number]): [number, number] => {
      const q = Matrix.transformPoint(inv, { x: p[0], y: p[1] });
      return [q.x, q.y];
    };
    return {
      toComp,
      fromComp,
      // z = 0: a 2D layer lives on the composition plane, so its world point is
      // its comp point. AE reports the same for a 2D layer.
      toWorld: (p: readonly [number, number]) => { const [x, y] = toComp(p); return [x, y, 0] as [number, number, number]; },
      // The z of a world point is DROPPED rather than rejected. A 2D layer has
      // no depth to resolve it against, and refusing would break the ordinary
      // `otherLayer.toWorld(...)` → `thisLayer.fromWorld(...)` round trip the
      // moment either layer is 2D.
      fromWorld: (p: readonly [number, number, number]) => fromComp([p[0], p[1]]),
    };
  }

  // ── 3D. Layer → world is a 4×4; world → comp is the camera. ────────
  const m = nodeWorldWithParents3d(node, time);
  if (!m) return undefined;
  const mi = Matrix4Math.invert(m);
  const camera = readSceneCamera(
    defaultSceneGraph,
    comp.width,
    comp.height,
    (id, prop) => defaultAnimation.evaluateNode(id, getRemappedTime(id, time)).get(prop),
    comp.rootId,
    (id, point) => toWorldPointAt(id, time, point),
  );
  const plane = planeOf(m);

  const toWorld = (p: readonly [number, number]): [number, number, number] => {
    const q = Matrix4Math.transformPoint(m, { x: p[0], y: p[1], z: 0 });
    return [q.x, q.y, q.z];
  };
  const fromWorld = (p: readonly [number, number, number]): [number, number] => {
    if (!mi) return [p[0], p[1]];
    const q = Matrix4Math.transformPoint(mi, { x: p[0], y: p[1], z: p[2] });
    return [q.x, q.y];
  };
  return {
    toWorld,
    fromWorld,
    toComp: (p: readonly [number, number]) => {
      const [x, y, z] = toWorld(p);
      const o = Project3D.projectPoint({ x, y, z }, camera);
      return [o.x, o.y];
    },
    // The inverse of a projection is a RAY, not a point. AE resolves it onto the
    // layer's own plane, which is the only choice that makes
    // `fromComp(toComp(p)) === p` hold — so that is what this does.
    fromComp: (p: readonly [number, number]) => {
      const ray = Project3D.unprojectScreenRay(p[0], p[1], camera, null, comp.width, comp.height);
      const hit = Project3D.intersectRayPlane(ray, plane.point, plane.normal);
      // A layer edge-on to the camera has no intersection. Returning the layer
      // origin is wrong but bounded; throwing here would take down an expression
      // for one frame of a rotation that passes through 90 degrees.
      return hit ? fromWorld([hit.x, hit.y, hit.z]) : [0, 0];
    },
  };
}
