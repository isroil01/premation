/**
 * Port implementations that bind the framework-independent `@motion/workspace`
 * engine to this app's real systems:
 *   • SceneGraphPort  → defaultSceneGraph (@motion/scene)
 *   • SelectionPort   → selectionStore (Zustand, the app's selection truth)
 *   • CommandPort     → scene-graph mutations + bumpScene (undo comes later)
 *
 * The engine reads/drives through these; it never imports the stores directly.
 */

import type {
  SceneGraphPort,
  SelectionPort,
  CommandPort,
  WorkspaceNode,
  WorkspaceCommand,
  NodeId,
} from '@motion/workspace';
import {
  WorkspaceCommandType,
  type MoveNodesPayload,
  type CreateNodePayload,
  type DeleteNodesPayload,
  type ResizeNodePayload,
  type RotateNodePayload,
  type MultiResizeNodesPayload,
  type MultiRotateNodesPayload,
  type MoveAnchorPayload,
  type UpdateNodePathPayload,
  type UpdateMaskPathPayload,
  type CutPathsPayload,
  Mat,
  Rect,
  OBox,
  applyPathTopology,
} from '@motion/workspace';
import { cutPathsWithLine, runFromPolygon, type CutSubpath, type CutPoint } from '@core/geometry/pathCut';
import { shapeOutline } from '@core/scene/pathOps';
import { resolveCornerRadii, clampCornerRadii, type CornerRadiiProps } from '@core/scene/cornerRadii';
import { useHistoryStore } from '@stores/historyStore';
import { readNodeAnchor, anchorCompensation } from '@core/scene/anchor';
import { readTransformProp } from '@core/scene/transformWrite';
import { enableContinuousRasterByDefault } from '@core/scene/continuousRaster';
import { SIZE } from '@core/rendering/buildSnapshot';
import { readNodeKind as kindOf } from '@core/scene/sceneDerive';

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { renderComponentsOf, renderTransformOf } from '@core/scene/SceneGraph';
import { activeCompRootId } from '@core/scene/activeComp';
import { uniqueLayerName } from '@core/scene/layerNames';
import { readNodeKind } from '@core/scene/sceneDerive';
import { SCENE_KIND_PROP, type SceneKind } from '@core/scene/seedDefaultScene';
import { flattenComposition } from '@core/scene/sceneDerive';
import type { SceneNode, ID } from '@core/types';
import { useSelectionStore } from '@stores/selectionStore';
import { useTextEditStore } from '@stores/textEditStore';
import { MIN_BOX_SIZE } from '@core/text/textExtras';
import { useGuidesStore, type Camera3dMode } from '@stores/guidesStore';
import { useViewportDisplayStore } from '@stores/viewportDisplayStore';
import { subscribeTime } from '@stores/playbackClockStore';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import { getEventBus } from '@core/events/EventBus';
import { readGeometry, localBounds, makeHitTestLocal, isDrawableKind as drawable } from './geometry';
import { usePreferenceStore } from '@stores/preferenceStore';
import { defaultAnimation } from '@motion/animation';
import { drawToolOptions } from '@motion/workspace';
import { newShapeFill, newShapeStroke } from '@core/workspace/shapeToolPaint';
import {
  burstTransaction,
  currentToolTransaction,
  gestureAnimEdit,
  gestureSceneBump,
  sendToolEdit,
  runToolEdit,
  settleToolEdits,
  type ToolTransaction,
} from '@core/workspace/viewportGesture';
import { insertBuiltLayers } from '@core/engine/offDocument';
import type { Command, PropRef, Value } from '@motion/engine-api';
import { compOfLayer, isLayer } from '@core/engine/doc';
import { compTime, paths, propRefForTrack } from '@core/engine/propRefs';
import { hasVertexEditState, maskPointsToPath, trackValueCommands, type NodeTrackValues } from '@core/workspace/toolEdits';
import { useProjectStore } from '@stores/projectStore';
import { compToKeyframeTime, getRemappedTime, getTimelineController, governingClipsFor } from '@core/timeline/TimelineController';
import { is3DEnabled, readNode3D } from '@core/scene/threeD';
import { Matrix4Math, Project3D } from '@motion/scene';
import { currentViewProjector, currentViewCamera } from '@core/workspace/viewProjection';
import { orthoViewOf, isSceneCameraView } from '@core/scene/cameraViewMode';
import { viewCameraNode } from '@core/scene/camera3d';
import { composeNodeWorld3d, parentWorld3d, resolveNode3DTransform } from '@core/scene/nodeMatrix';
import { addMaskPath, rectangleMask, ellipseMask, readNodeMask, readNodeMaskAnim, readNodeMaskAt, setMaskPoints, editMaskPathTopology, setMaskPathFlags, MaskPath, MaskPoint, type MaskPathEditState } from '@core/effects/mask';
import { defaultPolystar, POLYSTAR_FX_PROP, type PolystarType } from '@core/scene/polystar';
import { defaultTextSize } from '@core/scene/textDefaults';

/** Convex hull (monotone chain) of 2D points, counter-clockwise. */
function convexHull2D(pts: ReadonlyArray<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  const p = [...pts].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  if (p.length < 3) return p;
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const build = (src: typeof p): typeof p => {
    const out: typeof p = [];
    for (const pt of src) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, pt) <= 0) out.pop();
      out.push(pt);
    }
    out.pop();
    return out;
  };
  return [...build(p), ...build([...p].reverse())];
}

/** Even-odd point-in-polygon. */
function pointInPolygon(pt: { x: number; y: number }, poly: ReadonlyArray<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

// ── SceneGraphPort ────────────────────────────────────────────────
/**
 * `wmCache` memoizes ancestor WORLD MATRICES across one enumeration pass.
 *
 * It must be shared by the caller, not defaulted here: every child asks
 * `worldMatrixOf(parent)`, and resolving a parent means reading its geometry —
 * for a group that walks ALL its children. With a per-call cache that walk
 * repeated per sibling, so one imported 158-shape icon cost getNodes O(N²)
 * (measured 3.4 s of a 3.8 s import, re-run on every scene bump). One shared
 * map turns the pass back into O(N).
 */
/**
 * A node's READ-ONLY view as a plain object — memoized components instead of a
 * rebuild per access.
 *
 * `SceneNode.components` deliberately copies on every read (see
 * `AppNodeView.renderComponents`), and everything below reads it: kind, 3D,
 * anchor, geometry, masks — a dozen times per node. Profiled in the desktop app
 * with 305 layers selected, that one getter was 50.6% of all CPU during
 * playback (2 fps, against 15 fps with nothing selected). This path only ever
 * reads, so it takes the render path's shared arrays, exactly as
 * `staticPrecompCache.plain` does.
 */
function readOnlyView(n: SceneNode): SceneNode {
  return {
    id: n.id, name: n.name, parent: n.parent, children: n.children,
    visible: n.visible, locked: n.locked, solo: (n as { solo?: boolean }).solo,
    color: (n as { color?: string }).color,
    components: renderComponentsOf(n), transform: renderTransformOf(n),
  } as unknown as SceneNode;
}

/** Is `nodeId` the camera that `view` (default: the main viewport's) looks through? */
export function isLookedThrough(nodeId: string, view?: Camera3dMode): boolean {
  const mode = view ?? useGuidesStore.getState().camera3dMode;
  if (!isSceneCameraView(mode)) return false;
  return viewCameraNode(defaultSceneGraph, mode, activeCompRootId() as string)?.id === nodeId;
}

function toWorkspaceNode(
  liveNode: SceneNode,
  zIndex: number,
  wmCache: Map<string, import('@motion/scene').Matrix2D> = new Map(),
  /** Project through THIS view rather than the main viewport's — see
   *  {@link createSceneGraphPort}. */
  view?: Camera3dMode,
): WorkspaceNode | null {
  const node = readOnlyView(liveNode);
  // Retrieve current active tab settings and active playhead time
  const activeTabId = useProjectStore.getState().activeTabId;
  const activeTab = useProjectStore.getState().tabs[activeTabId ?? ''];
  const rawTime = activeTab?.time ?? 0;
  const compositionId = activeTab?.compositionId ?? 'comp_root';
  const comp = useProjectStore.getState().comps[compositionId];
  const width = comp?.width ?? 1920;
  const height = comp?.height ?? 1080;

  // Evaluate the node's properties at the current playhead time
  const localTime = getRemappedTime(node.id, rawTime);
  const av = defaultAnimation.evaluateNode(node.id, localTime);

  const evalMap: Record<string, unknown> = {};
  for (const [k, val] of av.entries()) evalMap[k] = val;
  // `liveChildren`: a GROUP's box is the union of its children, and this is the
  // chrome — the outline, the hit test, the marquee and the snap targets all
  // have to sit on the artwork as drawn, not on where it rests at time 0.
  const g = readGeometry(node, evalMap, { liveChildren: true });
  if (!g) return null;

  const x = av.get('x') ?? g.x;
  const y = av.get('y') ?? g.y;
  const scaleX = av.get('scaleX') ?? av.get('scale') ?? g.scaleX;
  const scaleY = av.get('scaleY') ?? av.get('scale') ?? g.scaleY;
  const rotationDeg = av.get('rotation') ?? g.rotationDeg;
  // The pivot, in local space. The renderer places content at
  // position + R·S·(local − anchor), so the world matrix must carry T(−anchor)
  // or the selection chrome drifts off anchored layers.
  const nodeAnchor = readNodeAnchor(node);
  const anchorX = av.get('anchorX') ?? nodeAnchor.x;
  const anchorY = av.get('anchorY') ?? nodeAnchor.y;

  // The projection MUST match the renderer's (buildSnapshot) exactly, or the
  // selection outline drifts off the layer — ortho views, custom views and the
  // active camera each resolve differently. That branch now lives in
  // `currentViewProjector` so face picking shares this exact chain instead of
  // carrying a third copy that can drift.
  const project = currentViewProjector(width, height, rawTime, view);

  // Calculate the world matrix based on whether 3D is active
  const is3D = is3DEnabled(node);
  const kind = readNodeKind(node);
  // The camera this view looks THROUGH has no presence in it. Seen from inside,
  // its box, its grab handle and its motion path all project onto the middle of
  // the frame — a dashed square and a line across a shot that contains neither.
  // AE never draws the active camera in its own view. From any other view
  // (Top, Left, Custom, another camera) it is a normal, grabbable device.
  if (kind === 'camera' && isLookedThrough(node.id, view)) return null;
  let worldMatrixVal: import('@motion/workspace').Mat2D;
  /** The layer's full 4×4 model matrix — kept for the extruded-silhouette hit
   *  test below, which needs to project corners the flat affine cannot express. */
  let M3D: ReturnType<typeof Matrix4Math.compose> | null = null;

  if (is3D && kind !== 'camera' && kind !== 'light') {
    // Compose from BASE PROPS with the animated values layered on top.
    //
    // This used to read `av.get('z') ?? 0` — and `av` is the ANIMATION map only.
    // `set3DEnabled` writes base props, not keyframes, so the normal case (a
    // layer pushed to z = 500 or tilted 30° with no keyframes) hit-tested as
    // z = 0 / rotX = 0: the selection box, the click target and the 2D handles
    // all sat on the UNPROJECTED layer while the renderer drew it somewhere
    // else. `readNode3D` was already imported here and simply not used.
    //
    // Orientation and anchorZ are composed too — buildSnapshot's `affineAt`
    // composes `rotation: {rX+oriX, rY+oriY, rZ+oriZ}` about `anchorZ`, and
    // omitting them here is the same class of drift.
    const base3D = readNode3D(node);
    // 3D parenting: when an ancestor is 3D the chain is composed as 4×4s and
    // this layer's own transform is LOCAL. `x`/`y` above are already the local
    // props, and the 2D `worldMatrixOf` branch below is what used to apply the
    // parent — so the two must not both run. Mirrors buildSnapshot exactly.
    const parent3d = parentWorld3d(node.id, {
      parentOf: (nid) => defaultSceneGraph.getNode(nid)?.parent ?? null,
      local3DOf: (nid) => {
        const n = defaultSceneGraph.getNode(nid);
        return n ? resolveNode3DTransform(n, rawTime) : null;
      },
      is3DOf: (nid) => {
        const n = defaultSceneGraph.getNode(nid);
        return !!n && is3DEnabled(n);
      },
      world2DOf: (nid) =>
        worldMatrixOf(nid, getLocalTransformForPorts, getParentIdForPorts, wmCache),
    });
    const local = composeNodeWorld3d({
      x, y,
      z: av.get('z') ?? base3D.z,
      rotationX: av.get('rotationX') ?? base3D.rotationX,
      rotationY: av.get('rotationY') ?? base3D.rotationY,
      rotationZ: rotationDeg,
      orientationX: av.get('orientationX') ?? base3D.orientationX,
      orientationY: av.get('orientationY') ?? base3D.orientationY,
      orientationZ: av.get('orientationZ') ?? base3D.orientationZ,
      scaleX, scaleY,
      scaleZ: av.get('scaleZ') ?? 1,
      anchorX, anchorY,
      anchorZ: av.get('anchorZ') ?? base3D.anchorZ,
    });
    const M = parent3d ? Matrix4Math.multiply(parent3d, local) : local;
    M3D = M;

    const O = project(Matrix4Math.transformPoint(M, { x: 0, y: 0, z: 0 }));
    const X = project(Matrix4Math.transformPoint(M, { x: 1, y: 0, z: 0 }));
    const Y = project(Matrix4Math.transformPoint(M, { x: 0, y: 1, z: 0 }));

    const ax = X.x - O.x;
    const ay = X.y - O.y;
    const cx_coeff = Y.x - O.x;
    const cy_coeff = Y.y - O.y;

    worldMatrixVal = { a: ax, b: ay, c: cx_coeff, d: cy_coeff, e: O.x, f: O.y };
  } else {
    const tr = Mat.multiply(Mat.translation(x, y), Mat.rotation((rotationDeg * Math.PI) / 180));
    const rs = Mat.multiply(tr, Mat.scaling(scaleX, scaleY));
    const localMat = Mat.multiply(rs, Mat.translation(-anchorX, -anchorY));
    if (node.parent) {
      const pw = worldMatrixOf(node.parent as string, getLocalTransformForPorts, getParentIdForPorts, wmCache);
      worldMatrixVal = Mat.multiply(pw, localMat);
    } else {
      worldMatrixVal = localMat;
    }
  }

  const localBoundsVal = localBounds(g);
  let worldBoundsVal = Rect.transform(localBoundsVal, worldMatrixVal);
  // The ORIENTED box — the same four corners `Rect.transform` maps, kept as
  // corners instead of collapsed into their bounding rectangle. This is what
  // the selection outline draws and what marquee selection tests against.
  let worldCornersVal = OBox.transformCorners(localBoundsVal, worldMatrixVal);
  let hitTestLocalVal = makeHitTestLocal(g);

  // ── Extruded 3D bodies: hit-test the whole SILHOUETTE, not the front face ──
  //
  // `worldMatrix` above is the affine of the layer's z = 0 plane, and
  // `hitTestLocal` is a flat |x| ≤ w/2 ∧ |y| ≤ h/2 test inside it. That describes
  // the FRONT CAP only. An extruded body runs from z = 0 to z = extrusionDepth
  // (see extrusionFaces), so the moment it is rotated its side walls and back cap
  // project OUTSIDE that quad — and every pixel of them was unclickable. That is
  // the "only one side is selectable, the other side isn't" report: whichever
  // faces happen to fall outside the front-cap quad cannot be picked, and turning
  // the object around makes the previously-working side stop responding.
  //
  // Fix: project the 8 corners of the extruded box, take their convex hull, and
  // accept any point inside it. The broad-phase AABB has to grow to match, or the
  // hull is never consulted.
  if (is3D && kind !== 'camera' && kind !== 'light') {
    const depth = av.get('extrusionDepth') ?? readNode3D(node).extrusionDepth;
    if (M3D && depth > 0 && g.width > 0 && g.height > 0) {
      const hw = g.width / 2;
      const hh = g.height / 2;
      const corners: Array<{ x: number; y: number; z: number }> = [];
      for (const cz of [0, depth]) {
        for (const cx of [-hw, hw]) {
          for (const cy of [-hh, hh]) corners.push({ x: cx, y: cy, z: cz });
        }
      }
      const screen = corners.map((c) => {
        const p = project(Matrix4Math.transformPoint(M3D, c));
        return { x: p.x, y: p.y };
      });
      const hull = convexHull2D(screen);
      if (hull.length >= 3) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of hull) {
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
        }
        worldBoundsVal = Rect.rect(minX, minY, maxX - minX, maxY - minY);
        // A projected 3D body is not a rectangle at all, so there is no honest
        // oriented box for it — its silhouette is an n-gon. The AABB's corners
        // are the truthful answer here, and the 3D gizmo (not this box) is the
        // control surface for those layers anyway.
        worldCornersVal = Rect.corners(worldBoundsVal) as typeof worldCornersVal;
        const m = worldMatrixVal;
        // `hitTestLocal` is handed inverse(worldMatrix)·worldPoint, so re-applying
        // worldMatrix recovers the screen point the hull is expressed in.
        hitTestLocalVal = (p) =>
          pointInPolygon({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }, hull);
      }
    }
  }

  let visibleVal = node.visible !== false;
  // Governing clips, matching the renderer's own gate: a group's members have
  // no clips of their own, so asking for theirs left every member of a trimmed
  // group hit-testable at times it was not drawn.
  const nodeClips = governingClipsFor(node.id as string);
  if (nodeClips.length > 0) {
    const fps = comp?.fps ?? 60;
    const lastFrame = Math.max(0, Math.round((comp?.durationSeconds ?? 10) * fps) - 1);
    const gateFrame = Math.min(Math.round(rawTime * fps), lastFrame);
    if (!nodeClips.some((l: any) => l.isActiveAt(gateFrame))) {
      visibleVal = false;
    }
  }

  return {
    id: node.id as string,
    parentId: (node.parent as string | null) ?? null,
    worldBounds: worldBoundsVal,
    worldCorners: worldCornersVal,
    worldMatrix: worldMatrixVal,
    localBounds: localBoundsVal,
    visible: visibleVal,
    locked: !!node.locked,
    zIndex,
    // Lets the selection layer hide the 2D scale/rotate handles for a 3D layer —
    // the 3D gizmo owns that transform (see WorkspaceNode.is3D).
    is3D: is3D && kind !== 'camera' && kind !== 'light',
    // Cameras and lights are devices: draggable, but with no meaningful scale
    // or rotation (the renderer hardcodes both), so the grips are suppressed —
    // see WorkspaceNode.device for the full reasoning.
    device: kind === 'camera' || kind === 'light',
    hitTestLocal: hitTestLocalVal,
    pathPoints: livePathPoints(node, localTime),
    pathClosed: pathIsClosed(node),
    pathRotoBezier: pathIsRotoBezier(node),
    // Masks are editable outlines too — without these the Direct Selection tool
    // can't see them, which is why a mask's shape was frozen once drawn. Read at
    // the layer's keyframe time, as the renderer does: an ANIMATED mask shows
    // its interpolated shape here, not the static one nothing draws — which a
    // drag would otherwise pick up and write back as the new keyframe.
    maskPaths: (readNodeMaskAt(node, localTime) ?? readNodeMask(node))?.paths.map((p) => ({ id: p.id, points: p.points, closed: p.closed, rotoBezier: (p as MaskPath & MaskPathEditState).rotoBezier === true })),
    anchor: { x: anchorX, y: anchorY },
  };
}

/**
 * The nodes the VIEWPORT may select, hit-test and drag.
 *
 * Two things this excludes that `flattenScene` does not:
 *
 *  1. **Other compositions.** Comps are sibling root subtrees in one graph, so
 *     walking every root exposed comp #2's layers to clicks inside comp #1.
 *  2. **The composition root itself.** It carries `__kind: 'group'`, which
 *     `isDrawableKind` accepts, so the comp node reported a 280×280 group box at
 *     the comp's (0,0) corner: a small blueprint rectangle that could be clicked,
 *     shown handles, and — because a comp root parents every layer — dragged the
 *     ENTIRE composition around as if the view were panning. A composition is a
 *     container, not a layer; it is selectable in the Scene tree only.
 */
function isCanvasNode(node: SceneNode): boolean {
  return node.parent !== null;
}

function canvasNodes(): SceneNode[] {
  return flattenComposition(defaultSceneGraph, activeCompRootId()).filter(isCanvasNode);
}

/**
 * @param viewOf Which view this port's nodes are projected through. Omit for the
 *   main viewport, which follows `guidesStore.camera3dMode`. A SECONDARY pane
 *   passes its own view so its hit-testing and selection chrome describe the
 *   pixels IT shows — without this every pane would hit-test against the main
 *   viewport's projection, and clicking a layer in a Top pane would select
 *   whatever happened to sit at that point in the Active Camera view.
 *
 *   A getter rather than a value so a pane can change its view without
 *   rebuilding its port (and its Workspace) from scratch.
 */
export function createSceneGraphPort(viewOf?: () => Camera3dMode): SceneGraphPort {
  const view = (): Camera3dMode | undefined => viewOf?.();
  return {
    getNodes(): Iterable<WorkspaceNode> {
      const out: WorkspaceNode[] = [];
      const flat = canvasNodes();
      // One ancestor-matrix cache for the whole pass — see toWorkspaceNode.
      const wmCache = new Map<string, import('@motion/scene').Matrix2D>();
      const v = view();
      flat.forEach((node, i) => {
        const wn = toWorkspaceNode(node, i, wmCache, v);
        if (wn) out.push(wn);
      });
      return out;
    },
    getNodesById(ids: readonly NodeId[]): Map<NodeId, WorkspaceNode> {
      // `getNode`'s per-call setup, paid once: one flatten, one index map, one
      // ancestor-matrix cache for the whole batch.
      const out = new Map<NodeId, WorkspaceNode>();
      const index = new Map<string, number>();
      canvasNodes().forEach((n, i) => index.set(n.id as string, i));
      const wmCache = new Map<string, import('@motion/scene').Matrix2D>();
      const v = view();
      for (const id of ids) {
        const node = defaultSceneGraph.getNode(id as ID);
        if (!node || !isCanvasNode(node)) continue;
        const wn = toWorkspaceNode(node, index.get(id as string) ?? 0, wmCache, v);
        if (wn) out.set(id, wn);
      }
      return out;
    },
    getNode(id: NodeId): WorkspaceNode | undefined {
      const node = defaultSceneGraph.getNode(id as ID);
      if (!node || !isCanvasNode(node)) return undefined;
      // z-index from document order (cheap; the flattened list is small).
      const flat = canvasNodes();
      const idx = flat.findIndex((n) => (n.id as string) === id);
      return toWorkspaceNode(node, idx < 0 ? 0 : idx, undefined, view()) ?? undefined;
    },
    selectionGroup(id: NodeId): readonly NodeId[] | null {
      const rootId = activeCompRootId() as string;
      const start = defaultSceneGraph.getNode(id as ID);
      if (!start) return null;
      let top = start;
      let guard = 0;
      while (top.parent && (top.parent as string) !== rootId && guard++ < 256) {
        const p = defaultSceneGraph.getNode(top.parent as ID);
        if (!p) break;
        top = p;
      }
      // If the parent group is ALREADY selected, select the clicked sub-layer directly!
      const currentSelection = useSelectionStore.getState().ids;
      if (top.id !== start.id && currentSelection.includes(top.id)) {
        return [id];
      }
      // Otherwise, select the parent group so it moves & resizes as 1 body by default.
      if (top.id !== start.id || defaultSceneGraph.getChildren(top.id).length > 0) {
        return [top.id as NodeId];
      }
      return null;
    },
    onChanged(listener: () => void): () => void {
      const unsubScene = useSceneRevision.subscribe(listener);
      // The LIVE clock, not the tab record: the record is a ≤4Hz mirror while
      // playing, so a hit-test index keyed on it lagged the picture by up to a
      // quarter second. Re-bound whenever the active tab changes.
      let offTime: (() => void) | null = null;
      let boundTab: string | null = null;
      const bindTime = (): void => {
        const tab = useProjectStore.getState().activeTabId;
        if (tab === boundTab) return;
        offTime?.();
        boundTab = tab;
        offTime = tab ? subscribeTime(tab, () => listener()) : null;
      };
      bindTime();
      const unsubTab = useProjectStore.subscribe((s, prev) => {
        if (s.activeTabId !== prev.activeTabId) {
          bindTime();
          listener();
        }
      });
      const unsubTime = (): void => {
        unsubTab();
        offTime?.();
        offTime = null;
      };
      // The VIEW is an input to every node this port emits.
      //
      // `worldMatrix` / `worldBounds` / `worldCorners` are all projected through
      // `currentViewProjector`, so switching Front → Top moves every 3D layer
      // even though the scene itself did not change. Without this subscription
      // nothing invalidated, and the hit-test spatial index kept describing the
      // PREVIOUS view: layers were then unselectable wherever they had moved to,
      // and clicking their old positions selected them. Custom-view orbit params
      // feed the same projector, so they count too.
      // Seeded from the CURRENT state, not left undefined: the guides store also
      // carries grid/ROI/draft flags, and an unseeded comparison treats the first
      // write of any of them as a view change — one spurious full re-enumeration
      // of the scene per subscription.
      let lastView: unknown = useGuidesStore.getState().camera3dMode;
      let lastCustom: unknown = useGuidesStore.getState().customViews;
      const unsubView = useGuidesStore.subscribe((s) => {
        if (s.camera3dMode === lastView && s.customViews === lastCustom) return;
        lastView = s.camera3dMode;
        lastCustom = s.customViews;
        listener();
      });
      return () => {
        unsubScene();
        unsubTime();
        unsubView();
      };
    },
  };
}

// ── SelectionPort ─────────────────────────────────────────────────
export function createSelectionPort(): SelectionPort {
  const store = useSelectionStore;
  return {
    get: () => store.getState().ids,
    has: (id) => store.getState().isSelected(id),
    set: (ids) => store.getState().set([...ids]),
    add: (id) => store.getState().add(id),
    remove: (id) => store.getState().remove(id),
    toggle: (id) => store.getState().toggle(id),
    clear: () => store.getState().clear(),
    onChanged: (listener) => {
      const sub = getEventBus().on('SelectionChanged', (p: { ids: readonly string[] }) => listener(p.ids));
      return () => sub.dispose();
    },
  };
}

// ── CommandPort ───────────────────────────────────────────────────
const KIND_FOR_CREATE: Record<string, SceneKind> = {
  Rectangle: 'shape',
  Ellipse: 'shape',
  Path: 'shape',
  Polygon: 'shape',
  Star: 'shape',
  Line: 'shape',
  Pencil: 'shape',
  Brush: 'shape',
  Text: 'text',
  /** Type tool click-drag: text whose box is the dragged rectangle. */
  ParagraphText: 'text',
  /** Vertical Type tool: click (point) and click-drag (box) — `orientation: 'vertical'`. */
  VerticalText: 'text',
  VerticalParagraphText: 'text',
  Image: 'image',
  Video: 'video',
};

/** Kinds that are open strokes (no enclosed area) → render with a stroke, no fill. */
const STROKED_KINDS = new Set(['line', 'pencil', 'path', 'pen', 'brush', 'curvature']);

/**
 * Point-built shapes that enclose an area — they must be FILLED and CLOSED.
 *
 * These arrive with a `points` outline exactly like a pencil scribble does, and
 * the `stroked` heuristic below used to catch them by that alone: a drawn Star
 * or Polygon was created with `fill: rgba(0,0,0,0)` and `Geometry.open = true`,
 * so it rendered as a hollow outline whose CLOSING SEGMENT was never drawn —
 * the "part of the shape isn't drawn" report. Naming them explicitly is the
 * only reliable signal; the outline itself cannot say whether it encloses.
 */
const CLOSED_POINT_KINDS = new Set(['polygon', 'star', 'rect', 'rectangle', 'ellipse', 'circle']);

let createSeq = 0;

function makeNodeAt(
  kind: SceneKind,
  name: string,
  cx: number,
  cy: number,
  ellipse: boolean,
  points?: import('@motion/workspace').BezierPoint[],
  width?: number,
  height?: number,
  /** The pen closed the outline: a filled shape, not a stroke (see CreateNodePayload.closed). */
  closed = false,
): SceneNode {
  const id = `${kind}_${(createSeq += 1)}_${Math.random().toString(36).slice(2, 6)}`;
  const displayName = ellipse ? 'Circle' : name;
  const transform = { position: { x: cx, y: cy }, rotation: 0, scale: { x: 1, y: 1 } };
  const nameLower = (name ?? '').toLowerCase();
  const isRectOrEllipse = nameLower.includes('rect') || nameLower.includes('ellipse') || nameLower.includes('circle');
  // Open strokes (line / pencil / pen) enclose no area, so a fill is invisible —
  // give them a visible stroke and a transparent fill instead. Colours/widths
  // come from the tool-options bar (drawToolOptions singleton).
  // A CLOSED pen outline encloses an area even though its kind is 'path', so it
  // takes the filled branch (the default fill every closed shape gets, as AE's
  // Pen does) and no `open` flag — the renderer wraps it back to the start.
  const stroked =
    !closed &&
    (STROKED_KINDS.has(nameLower) ||
      (!CLOSED_POINT_KINDS.has(nameLower) && !!points && points.length > 0 && !ellipse && !isRectOrEllipse));
  // AE's toolbar Fill / Stroke (`shapeToolPaint`) for what the shape and pen
  // tools draw. Its defaults reproduce the old constants exactly — a solid
  // #2b7eff fill and no stroke — so an untouched toolbar creates the same node.
  const toolPaint = kind === 'shape' && nameLower !== 'brush';
  const toolFill = newShapeFill();
  // An open PEN path takes the toolbar stroke once one is chosen; until then
  // it keeps the pencil bar's, as it always has.
  const penStroke = stroked && (nameLower === 'pen' || nameLower === 'path' || nameLower === 'curvature')
    ? newShapeStroke(undefined, true)
    : undefined;
  const styleProps = stroked
    ? {
        opacity: 100,
        fill: 'rgba(0,0,0,0)',
        stroke: penStroke ?? {
          color: drawToolOptions.pencilColor || '#38bdf8',
          width: Math.max(1, drawToolOptions.pencilWidth || 2),
          opacity: 1,
          cap: 'round',
          join: 'round',
          align: 'center',
          dash: [],
        },
      }
    : { opacity: 100, fill: nameLower === 'brush' ? drawToolOptions.brushColor : toolPaint ? toolFill.styleFill : '#2b7eff' };
  const toolStroke = !stroked && toolPaint ? newShapeStroke() : undefined;

  const transformProps: Record<string, unknown> = {
    [SCENE_KIND_PROP]: kind,
    x: cx,
    y: cy,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    anchorX: 0,
    anchorY: 0,
  };
  
  if (width !== undefined) transformProps.width = width;
  if (height !== undefined) transformProps.height = height;
  if (ellipse || name.toLowerCase().includes('ellipse') || name.toLowerCase().includes('circle')) {
    transformProps.shapeType = 'ellipse';
  } else if (name === 'Rectangle' || name === 'Rect' || name.toLowerCase().includes('rect') || (kind === 'shape' && (!points || points.length === 0))) {
    transformProps.shapeType = 'rect';
  } else if (kind === 'shape') {
    transformProps.shapeType = 'path';
  }

  const components: SceneNode['components'] = [];
  if (kind === 'text') {
    components.push(
      { id: `${id}_t`, type: 'Transform', props: transformProps },
      { id: `${id}_c`, type: 'Text', props: { content: 'Text', fontSize: defaultTextSize(), opacity: 100 } },
    );
  } else {
    components.push(
      { id: `${id}_t`, type: 'Transform', props: transformProps },
      { id: `${id}_s`, type: 'Style', props: { opacity: styleProps.opacity, fill: styleProps.fill } },
    );
    // One `fx` component for whatever paint the node was born with: an open
    // path's stroke, or the toolbar's stroke / gradient fill on a closed shape.
    const fxProps: Record<string, unknown> = {};
    if ('stroke' in styleProps) fxProps.stroke = (styleProps as any).stroke;
    else if (toolStroke) fxProps.stroke = toolStroke;
    if (!stroked && toolPaint && toolFill.paint) fxProps.fill = toolFill.paint;
    if (Object.keys(fxProps).length > 0) {
      components.push({ id: `${id}_fx`, type: 'fx', props: fxProps });
    }
  }

  if (kind === 'shape' && points) {
    // Open strokes (line / pencil) must render as an un-closed polyline; mark
    // the geometry so the renderer doesn't wrap the last point back to the first.
    const openProps = stroked ? { open: true } : {};
    components.push({ id: `${id}_g`, type: 'Geometry', props: { points, ...openProps } });
  }

  return { id, name: uniqueLayerName(displayName), parent: null, children: [], transform, visible: true, locked: false, components };
}

/** Find the id of the component that carries this node's x/y (the transform). */
function transformComponentId(node: SceneNode): ID | null {
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
    if (typeof p.x === 'number' || typeof p.y === 'number') return c.id;
  }
  return null;
}

import { worldMatrixOf } from '@core/scene/worldTransform';
import { localTransformAt, parentWorld2DAt, world2DAt } from '@core/scene/layerSpace';
import { recordMotionSketchSample, motionSketchNodeId } from '@core/animation/motionSketch';
import { Matrix } from '@motion/scene';

/**
 * The local transform every PARENT-CHAIN walk in this file composes, sampled at
 * the playhead — animated values winning, exactly as `buildSnapshot` reads them.
 *
 * It used to read `readGeometry` alone, i.e. the static base props, so an
 * ANIMATED parent contributed the place it sits at frame 0 rather than the place
 * it is now. Everything downstream of that inherited the error: the selection
 * outline and handles of a layer parented to a moving Null sat somewhere the
 * layer was not, marquee and click hit-testing agreed with the box rather than
 * the pixels, and a viewport drag inverted the wrong parent matrix when turning
 * a screen delta into the layer's own x/y.
 *
 * `localTransformAt` is the reader `world2DAt` and the parenting compensation
 * already use, so the chrome, the expression conversions and the renderer are
 * one computation rather than three that have to be kept in step.
 */
function getLocalTransformForPorts(id: string) {
  const s = useProjectStore.getState();
  return localTransformAt(id, s.tabs[s.activeTabId ?? '']?.time ?? 0);
}

/**
 * The layer's PARENT space, for turning the tool's answers back into the props
 * a layer actually stores.
 *
 * ── THE MISMATCH THIS CLOSES ────────────────────────────────────────────────
 * Every transform tool measures in WORLD space: the rotate tool takes its start
 * angle off `node.worldMatrix`, the resize tool hands back a world-space centre
 * and the world scale it resolved. A layer's `rotation`, `x`/`y` and
 * `scaleX`/`scaleY` are PARENT-space values. With no parent the two are the
 * same thing and nothing showed; under a parent the writes were wrong by the
 * parent's whole transform, and both gestures threw the layer across the comp:
 *
 *   • rotate, child of a null turned 30°  → asked for 10°, layer went to 40°
 *   • resize, child of a null at x = 400 scaled 2× → asked for 1.5× at x = 100,
 *     layer landed at x = 600 scaled 3×
 *
 * `moveNodes` already inverted the parent for its drag delta (and says so); the
 * other two gestures never did. Parenting a layer to a Null and then scaling or
 * spinning it is an everyday rig, so this was reachable in two clicks.
 */
function parentSpaceOf(nodeId: string, rawTime: number): {
  inv: import('@motion/scene').Matrix2D; rotationDeg: number; scaleX: number; scaleY: number;
} {
  const m = parentWorld2DAt(nodeId, rawTime);
  const d = Matrix.decompose(m);
  const nz = (v: number): number => (Math.abs(v) > 1e-9 ? v : 1);
  return {
    inv: Matrix.invert(m),
    rotationDeg: (d.rotation * 180) / Math.PI,
    scaleX: nz(d.scale.x),
    scaleY: nz(d.scale.y),
  };
}

function getParentIdForPorts(id: string) {
  const node = defaultSceneGraph.getNode(id as ID);
  return node?.parent ?? null;
}

/**
 * AE keyframing contract: a property with a lit stopwatch (an existing track)
 * ALWAYS keyframes on direct manipulation — the global Auto-Keyframe mode only
 * decides whether *un-animated* properties start recording. Writing a static
 * value to a tracked property is useless: the renderer reads animated values
 * first (`av.get(...) ?? g.x`), so the write would silently do nothing.
 */
function hasAnyTrack(nodeId: ID, props: readonly string[]): boolean {
  return defaultAnimation.tracksFor(nodeId).some((t) => props.includes(t.prop as string));
}

// ── 3D gizmo transform I/O (shared read/write path with canvas drags) ──

/** The transform props the 3D gizmo reads & writes. */
export interface Transform3DValues {
  x: number;
  y: number;
  z: number;
  rotationX: number;
  rotationY: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
}

/**
 * A node's transform SAMPLED at the current playhead (animated tracks win,
 * base props fall through) — the same read the renderer does. The gizmo must
 * anchor on this, not the static base props, or it desyncs off any keyframed
 * layer (mirror of the light-icon fix in useWorkspace's paintOverlay).
 */
export function sampleTransform3DAtPlayhead(node: SceneNode): Transform3DValues {
  const g = readGeometry(node);
  const n3d = readNode3D(node);
  const rawTime = useProjectStore.getState().tabs[useProjectStore.getState().activeTabId ?? '']?.time ?? 0;
  const lt = getRemappedTime(node.id, rawTime);
  const av = defaultAnimation.evaluateNode(node.id, lt);
  return {
    x: av.get('x') ?? g?.x ?? 0,
    y: av.get('y') ?? g?.y ?? 0,
    z: av.get('z') ?? n3d.z,
    rotationX: av.get('rotationX') ?? n3d.rotationX,
    rotationY: av.get('rotationY') ?? n3d.rotationY,
    rotation: av.get('rotation') ?? g?.rotationDeg ?? 0,
    scaleX: av.get('scaleX') ?? av.get('scale') ?? g?.scaleX ?? 1,
    scaleY: av.get('scaleY') ?? av.get('scale') ?? g?.scaleY ?? 1,
    // Depth scale: the Z cube on the scale gizmo writes it, buildSnapshot's
    // affineAt composes it, extrusion bodies stretch along it. Static read is
    // straight off the Transform props — readNode3D predates the property.
    scaleZ: av.get('scaleZ') ?? staticScaleZOf(node),
  };
}

/** The Transform component's static scaleZ (1 when absent — flat layers). */
function staticScaleZOf(node: SceneNode): number {
  const t = node.components.find((c) => c.type === 'Transform');
  const v = t ? (t.props as Record<string, unknown>).scaleZ : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : 1;
}

/**
 * Per-prop stopwatch groups: which existing tracks force a keyframe write for
 * a given gizmo prop (position pair matches moveNodes; scale matches
 * resizeNode's aliases).
 */
const GIZMO_TRACK_GROUPS: Record<keyof Transform3DValues, readonly string[]> = {
  x: ['x', 'y'],
  y: ['x', 'y'],
  z: ['z'],
  rotationX: ['rotationX'],
  rotationY: ['rotationY'],
  rotation: ['rotation'],
  scaleX: ['scaleX', 'scaleY', 'scale'],
  scaleY: ['scaleX', 'scaleY', 'scale'],
  scaleZ: ['scaleZ'],
};

export interface Gizmo3DNodeUpdate {
  id: string;
  values: Partial<Transform3DValues>;
}

/**
 * Apply 3D-gizmo transform writes through the engine — the SAME rule the
 * canvas drag uses (moveNodes / rotateNode / resizeNode): a property with a lit
 * stopwatch — or any property while Auto-Keyframe is on — keys at the
 * playhead, the rest take the value. Values are ABSOLUTE (drag-start state +
 * drag); inside a viewport pointer gesture they go into its one engine
 * gesture (one undo entry per drag), outside it as a one-shot edit. Locked
 * and vanished nodes are skipped. Returns false when the API cannot address
 * one of the writes (a node that is not a composition's layer, a member with
 * no API property — a 2D layer's z) and nothing was sent.
 *
 * `useGizmo3d` builds the same commands itself (`trackValueCommands` into its
 * own `GestureSession`); this is the port-level entry for other callers.
 */
export function applyGizmo3DTransforms(updates: readonly Gizmo3DNodeUpdate[]): boolean {
  const items: NodeTrackValues[] = [];
  for (const u of updates) {
    const values: Record<string, number> = {};
    for (const [prop, value] of Object.entries(u.values)) {
      if (typeof value === 'number' && Number.isFinite(value)) values[prop] = value;
    }
    if (Object.keys(values).length > 0) items.push({ nodeId: u.id, values });
  }
  if (items.length === 0) return true;
  const props = items.flatMap((i) => Object.keys(i.values));
  const label = props.some((p) => p.startsWith('rotation')) ? 'Rotate' : props.some((p) => p.startsWith('scale')) ? 'Scale' : 'Move';
  return sendLayerValues(label, items);
}

/**
 * Write arbitrary numeric props to ONE node through the same dual path
 * `applyGizmo3DTransforms` uses: static base prop always, plus a keyframe when
 * the prop is already animated or Auto-Keyframe is on.
 *
 * Exists because camera navigation writes props the layer-transform type does
 * not cover — `orbitYaw`, `orbitPitch`, `poiX/Y/Z`, `focalLength`. Those writes
 * went straight to `updateNodeComponentProp`, i.e. base props only, so the C
 * tool could move a camera but could never ANIMATE one: with Auto-Keyframe on,
 * dragging the camera silently produced no keyframes while dragging a layer's
 * gizmo produced them normally. In After Effects the camera tools keyframe like
 * anything else.
 *
 * `mergeKey` coalesces a whole drag into one undo entry — pass something stable
 * for the gesture's duration.
 */
// B3-gap: the fallback `sendNodeValues` takes for props the API cannot
// address yet: a LIGHT's Point of Interest (`poiX/Y/Z`) before the layer
// stores it (the catalog lists a one-node camera's POI and its orbit props
// latent, not a light's — `propRefForTrack(light, 'poiX')` is null), and a
// node that is not a composition's layer. (`cameraCommands` still calls this
// directly for addressable props — its migration belongs to that module:
// `sendNodeValues` is the engine route.)
export function applyNodePropsKeyframed(
  nodeId: string,
  values: Readonly<Record<string, number>>,
  mergeKey: string,
): void {
  const node = defaultSceneGraph.getNode(nodeId as ID);
  if (!node || node.locked) return;
  const transComp = node.components.find((c) => c.type === 'Transform');
  if (!transComp) return;

  const autoKeyframe = usePreferenceStore.getState().timelineAutoKeyframe;
  const rawTime = useProjectStore.getState().tabs[useProjectStore.getState().activeTabId ?? '']?.time ?? 0;
  const lt = getRemappedTime(nodeId, rawTime);

  const keyed: Array<{ prop: string; value: number }> = [];
  let changed = false;
  for (const [prop, value] of Object.entries(values)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    // Position keyframes as a group (x/y together) so a track lit on one axis
    // keyframes both — the same rule the layer gizmo applies.
    const group = GIZMO_TRACK_GROUPS[prop as keyof Transform3DValues] ?? [prop];
    if (autoKeyframe || hasAnyTrack(nodeId, group)) keyed.push({ prop, value });
    // B3-gap: a light's poiX/Y/Z (no property until stored) — see above.
    defaultSceneGraph.writeProp(nodeId as ID, transComp.id, prop, value);
    changed = true;
  }

  if (keyed.length > 0) {
    gestureAnimEdit(
      'Keyframe Camera',
      () => {
        for (const k of keyed) defaultAnimation.setKeyframe(nodeId, k.prop, lt, k.value);
      },
      mergeKey,
    );
  }
  if (changed) gestureSceneBump();
}

/**
 * A drag in an ORTHOGRAPHIC view moves the layer along that view's axes.
 *
 * The delta arrives in projected 2D. In Front view that happens to equal world
 * x/y, which is why writing it straight into x/y looked right for years — but in
 * Top view the vertical axis is DEPTH, and in Left/Right the horizontal one is.
 * Writing x/y there moves the layer along the axis the view projects away: it
 * sits still on screen while its real position drifts, and the axis you actually
 * dragged never changes. Measured before this fix: dragging down 223 units in
 * Top view wrote y 540 → 762.8 and left z at 0.
 *
 * Returns null for the active camera and custom views — those are perspective
 * and go through {@link perspectiveDelta3D}, which additionally needs the
 * layer's depth.
 */
/**
 * A projected 2D drag delta as a WORLD translation, for whichever view is
 * active — the ortho table or the camera's own basis, chosen the same way the
 * layer drag chooses it.
 *
 * Exported so dragging a camera or light handle cannot grow a fourth way to
 * turn a pointer movement into world motion. `at` supplies the depth the
 * perspective case divides by.
 */
export function viewDragToWorldDelta(
  delta: { x: number; y: number },
  view: Camera3dMode,
  at: { x: number; y: number; z: number },
  compW: number,
  compH: number,
  rawTime: number,
): { x: number; y: number; z: number } {
  const ortho = orthoDelta3D(delta, view);
  if (ortho) return ortho;
  const camera = currentViewCamera(compW, compH, rawTime, view);
  // No view camera (shouldn't happen once ortho is excluded) ⇒ treat the drag
  // as in-plane, which is the pre-3D behaviour.
  if (!camera) return { x: delta.x, y: delta.y, z: 0 };
  return perspectiveDelta3D(delta, camera, at);
}

function orthoDelta3D(
  delta: { x: number; y: number },
  view: Camera3dMode,
): { x: number; y: number; z: number } | null {
  const ortho = orthoViewOf(view);
  if (!ortho) return null;
  const { right, down } = Project3D.orthoDragBasis(ortho);
  return {
    x: right.x * delta.x + down.x * delta.y,
    y: right.y * delta.x + down.y * delta.y,
    z: right.z * delta.x + down.z * delta.y,
  };
}

/**
 * The same conversion for a PERSPECTIVE view (Active Camera, Custom View 1–3).
 *
 * Two differences from the orthographic case. The basis comes from the camera's
 * orientation rather than a fixed table — so once the camera is orbited, screen-
 * right is no longer world +X. And the magnitude is depth-dependent: dividing by
 * the layer's own projected `scale` inverts the pinhole divide exactly, which is
 * what keeps the layer under the pointer instead of lagging when it is far away
 * and overshooting when it is close.
 *
 * Degenerates to the old behaviour precisely where the old behaviour was right:
 * an un-orbited camera gives right = (1,0,0) / down = (0,1,0), and a layer on
 * the comp plane projects at scale 1, so the delta passes through untouched.
 *
 * `at` is the layer's current world position, used only to sample the depth.
 */
function perspectiveDelta3D(
  delta: { x: number; y: number },
  camera: Project3D.Camera3D,
  at: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const { right, down } = Project3D.cameraDragBasis(camera);
  // scale = focal / depth, so 1/scale converts a projected delta back to world.
  const s = Project3D.projectPoint(at, camera).scale;
  const k = Math.abs(s) > 1e-9 ? 1 / s : 1;
  const dx = delta.x * k;
  const dy = delta.y * k;
  return {
    x: right.x * dx + down.x * dy,
    y: right.y * dx + down.y * dy,
    z: right.z * dx + down.z * dy,
  };
}

/**
 * Snap to Pixel (View ▸ Snap to Pixel): round a layer-local coordinate or size
 * to a whole pixel when the toggle is on. Applied at the WRITE, so a drag, an
 * arrow-key nudge and a resize all land on integers, and a sub-pixel delta
 * accumulates until it crosses a pixel rather than being dropped — the layer
 * still moves under a slow drag, one pixel at a time.
 */
export function snapPx(v: number): number {
  return useViewportDisplayStore.getState().snapToPixel ? Math.round(v) : v;
}

/** The playhead of the active tab, in comp seconds. */
function playheadSeconds(): number {
  const s = useProjectStore.getState();
  return s.tabs[s.activeTabId ?? '']?.time ?? 0;
}

function activeCompSize(): { w: number; h: number } {
  const s = useProjectStore.getState();
  const comp = s.comps[s.tabs[s.activeTabId ?? '']?.compositionId ?? 'comp_root'];
  return { w: comp?.width ?? 1920, h: comp?.height ?? 1080 };
}

type LayerValueItem = NodeTrackValues & { forceKey?: boolean };

/** Layer values as commands (null: the API cannot address one of them). */
function layerValueCommands(items: ReadonlyArray<LayerValueItem>): Command[] | null {
  if (items.length === 0) return [];
  const seconds = playheadSeconds();
  const autoKeyframe = usePreferenceStore.getState().timelineAutoKeyframe;
  const a = trackValueCommands(items.filter((i) => !i.forceKey), { seconds, autoKeyframe });
  const b = trackValueCommands(items.filter((i) => i.forceKey), { seconds, autoKeyframe: true });
  return a && b ? [...a, ...b] : null;
}

/**
 * Send layer-value writes (stored units: scale as a multiplier) as ONE tool
 * edit: into the pointer gesture's transaction during a drag, a burst's when
 * one is given, else a one-shot `edit`. An animated property — or any
 * property while Auto-Keyframe is on, or `forceKey` — keys at the playhead.
 * `items` may be a builder, run when the message can go (see
 * `ToolTransaction.send`). Returns false when the API cannot address the
 * write (nothing was sent) — known only for eager items.
 */
function sendLayerValues(
  label: string,
  items: ReadonlyArray<LayerValueItem> | (() => ReadonlyArray<LayerValueItem>),
  txn: ToolTransaction | null = currentToolTransaction(),
): boolean {
  if (typeof items === 'function') {
    sendToolEdit(label, () => layerValueCommands(items()), txn);
    return true;
  }
  const cmds = layerValueCommands(items);
  if (!cmds) return false;
  sendToolEdit(label, cmds, txn);
  return true;
}

/**
 * Write numeric props to ONE node through the engine, as part of the current
 * tool action (a drag's gesture, or `txn`). The route is decided ONCE per
 * action (`key`): a node whose props the API cannot address yet (a light's
 * Point of Interest has no API property until the layer stores it)
 * keeps the legacy dual write for the whole action, so one drag never mixes
 * the two histories.
 */
export function sendNodeValues(
  nodeId: string,
  values: Readonly<Record<string, number>>,
  label: string,
  key: string,
  txn: ToolTransaction | null = currentToolTransaction(),
): void {
  const addressable = (): boolean =>
    trackValueCommands([{ nodeId, values }], { seconds: playheadSeconds() }) !== null;
  const decide = (): 'engine' | 'legacy' => (addressable() ? 'engine' : 'legacy');
  const route = txn ? txn.memo(`route:${key}`, decide) : decide();
  if (route === 'legacy') {
    // B3-legacy: engine gap — a prop with no API property on this layer yet
    // (a light's poiX/Y/Z before the layer stores them): the catalog lists
    // them only once they exist.
    applyNodePropsKeyframed(nodeId, values, key);
    return;
  }
  sendLayerValues(label, [{ nodeId, values }], txn);
}

// ── Move / nudge ───────────────────────────────────────────────────

/** One layer's state when a move began — every message is start + total drag. */
interface MoveStart {
  id: string;
  /** Position at the playhead, stored units (animated value winning). */
  x: number;
  y: number;
  z: number;
  /** The parent's world → parent-space linear map (null: unparented). */
  inv: { a: number; b: number; c: number; d: number } | null;
  /**
   * A 3D layer's WORLD translation per projected drag pixel along screen x and
   * y — the view's axes (ortho) or the camera's basis over the layer's depth
   * (perspective). Null for a 2D layer: its position is camera-independent.
   */
  basis: { dx: { x: number; y: number; z: number }; dy: { x: number; y: number; z: number } } | null;
  /** Being Motion Sketched: always keys, and feeds the recorder. */
  sketch: boolean;
}

function captureMoveStarts(ids: readonly NodeId[], view: Camera3dMode): MoveStart[] {
  const rawTime = playheadSeconds();
  const { w: compW, h: compH } = activeCompSize();
  const orthoX = orthoDelta3D({ x: 1, y: 0 }, view);
  const orthoY = orthoDelta3D({ x: 0, y: 1 }, view);
  // Resolved once: every node in one drag shares the view, and resolving the
  // camera walks the scene.
  const viewCamera = orthoX ? null : currentViewCamera(compW, compH, rawTime, view);
  const out: MoveStart[] = [];
  for (const id of ids) {
    const node = defaultSceneGraph.getNode(id as ID);
    if (!node || node.locked) continue;
    const g = readGeometry(node);
    if (!g) continue;
    const n3 = readNode3D(node);
    const lt = getRemappedTime(node.id, rawTime);
    let basis: MoveStart['basis'] = null;
    if (is3DEnabled(node)) {
      if (orthoX && orthoY) basis = { dx: orthoX, dy: orthoY };
      else if (viewCamera) {
        // Linear in the delta (the depth scale is sampled at the START
        // position), so the basis is the delta's two unit columns.
        const at = { x: g.x, y: g.y, z: n3.z ?? 0 };
        basis = {
          dx: perspectiveDelta3D({ x: 1, y: 0 }, viewCamera, at),
          dy: perspectiveDelta3D({ x: 0, y: 1 }, viewCamera, at),
        };
      }
    }
    let inv: MoveStart['inv'] = null;
    if (node.parent) {
      const m = Matrix.invert(worldMatrixOf(node.parent as string, getLocalTransformForPorts, getParentIdForPorts));
      inv = { a: m.a, b: m.b, c: m.c, d: m.d };
    }
    out.push({
      id: node.id as string,
      x: defaultAnimation.sample(node.id, 'x', lt) ?? g.x,
      y: defaultAnimation.sample(node.id, 'y', lt) ?? g.y,
      z: defaultAnimation.sample(node.id, 'z', lt) ?? (n3.z ?? 0),
      inv,
      basis,
      // A layer being MOTION SKETCHED always keyframes, whatever the
      // Auto-Keyframe preference says: recording a path is an explicit request
      // for keyframes, and a fresh layer (no x/y track, Auto-Keyframe off)
      // would otherwise feed the recorder nothing (found in the real app).
      sketch: motionSketchNodeId() === node.id,
    });
  }
  return out;
}

/** The layer values for `start` moved by the projected world drag `total`. */
function movedValues(s: MoveStart, total: { x: number; y: number }): Record<string, number> {
  let planar = total;
  let dz: number | null = null;
  if (s.basis) {
    const { dx, dy } = s.basis;
    planar = { x: dx.x * total.x + dy.x * total.y, y: dx.y * total.x + dy.y * total.y };
    // Depth only where this view's drag reaches it (Top/Left views, an
    // orbited camera). Decided by the basis, not by this message's value, so
    // a drag that crosses zero depth still writes z every message.
    if (Math.abs(dx.z) > 1e-9 || Math.abs(dy.z) > 1e-9) dz = dx.z * total.x + dy.z * total.y;
  }
  if (s.inv) {
    // World → parent space. Depth is NOT run through it: a 2×3 affine has no
    // z (a 3D parent chain's depth lives in nodeMatrix.parentWorld3d).
    planar = { x: s.inv.a * planar.x + s.inv.c * planar.y, y: s.inv.b * planar.x + s.inv.d * planar.y };
  }
  const values: Record<string, number> = { x: snapPx(s.x + planar.x), y: snapPx(s.y + planar.y) };
  if (dz !== null) values.z = s.z + dz;
  return values;
}

/**
 * The commands for a move/nudge action: `st.starts` is captured on the
 * action's FIRST message that can go (a builder — after the previous action's
 * gesture closed, so the start reads the document that action left), `st.total`
 * is the drag so far, accumulated eagerly as the tool reports it.
 */
interface MoveAction {
  starts: MoveStart[] | null;
  total: { x: number; y: number };
}

function sendMove(label: string, st: MoveAction, ids: readonly NodeId[], view: Camera3dMode, txn: ToolTransaction | null): void {
  const sketching = motionSketchNodeId();
  if (sketching !== null && ids.includes(sketching as NodeId)) {
    // Motion Sketch records EVERY pointer sample, in real time — not only the
    // messages that reach the engine (latest wins drops some) — so its layer's
    // start is captured now and the sample fed here, where a drag has already
    // become the layer's OWN x/y (parent inverse applied, keyframe axis).
    st.starts ??= captureMoveStarts(ids, view);
    const rawTime = playheadSeconds();
    for (const s of st.starts) {
      if (!s.sketch) continue;
      const v = movedValues(s, st.total);
      recordMotionSketchSample(s.id, v.x!, v.y!, getRemappedTime(s.id, rawTime));
    }
  }
  sendLayerValues(label, () => {
    st.starts ??= captureMoveStarts(ids, view);
    return st.starts.map((s) => ({ nodeId: s.id, values: movedValues(s, st.total), forceKey: s.sketch }));
  }, txn);
}

/**
 * The move tool and the selection drag. The tool reports INCREMENTS (each
 * pointer move's share of the drag); the engine takes ABSOLUTE values
 * (docs/B3_PATTERNS.md §3), so the action keeps each layer's drag-start
 * position and the running total, and every message is start + total.
 */
function moveNodes(payload: MoveNodesPayload, viewOf?: () => Camera3dMode): void {
  const view = viewOf?.() ?? useGuidesStore.getState().camera3dMode;
  const txn = currentToolTransaction();
  const init = (): MoveAction => ({ starts: null, total: { x: 0, y: 0 } });
  const st = txn ? txn.memo(`move:${payload.ids.join(',')}`, init) : init();
  st.total = { x: st.total.x + payload.delta.x, y: st.total.y + payload.delta.y };
  sendMove('Move', st, payload.ids, view, txn);
}

/** Idle that ends an arrow-key burst — the timeline's keyframe nudge uses the same. */
export const NUDGE_BURST_MS = 300;

/**
 * Arrow-key nudge of the selection by a world-space delta. A burst of presses
 * (holding an arrow) is ONE undo entry: one engine gesture kept open while
 * presses keep coming, committed after {@link NUDGE_BURST_MS} of quiet or by
 * any other key / press — the timeline's keyframe nudge behaves the same.
 * Each message is the layers' burst-start position + the burst's total.
 */
export function nudgeNodes(ids: readonly NodeId[], dx: number, dy: number, viewOf?: () => Camera3dMode): void {
  if (ids.length === 0) return;
  const view = viewOf?.() ?? useGuidesStore.getState().camera3dMode;
  const txn = burstTransaction(`nudge:${ids.join(',')}`, NUDGE_BURST_MS);
  const st = txn.memo<MoveAction>('nudge', () => ({ starts: null, total: { x: 0, y: 0 } }));
  st.total = { x: st.total.x + dx, y: st.total.y + dy };
  sendMove('Nudge', st, ids, view, txn);
}

function createNode(payload: CreateNodePayload): void {
  const kind = KIND_FOR_CREATE[payload.kind] ?? 'shape';
  const cx = payload.bounds.x + payload.bounds.width / 2;
  const cy = payload.bounds.y + payload.bounds.height / 2;
  // Ellipse is true only for explicit Ellipse kind
  const ellipse = payload.kind === 'Ellipse';
  
  const width = payload.bounds.width;
  const height = payload.bounds.height;
  
  if (payload.maskTargetId) {
    const parentId = payload.maskTargetId as string;
    const parentNode = defaultSceneGraph.getNode(parentId as ID);
    if (!parentNode) return;

    // The SAME local→world matrix the viewport draws and edits this layer's
    // outlines through (`toWorkspaceNode`): position · R · S · T(−anchor), and
    // the projected plane for a 3D layer. `worldMatrixOf` has no anchor term
    // and no projection, so a mask drawn on a layer with a moved anchor landed
    // offset by the anchor, and on a 3D layer somewhere else entirely — while
    // Direct Selection then showed its vertices where the renderer put them,
    // not where they were clicked.
    const parentWorldMat =
      toWorkspaceNode(parentNode, 0)?.worldMatrix ??
      worldMatrixOf(parentId, getLocalTransformForPorts, getParentIdForPorts);
    const invParentWorldMat = Matrix.invert(parentWorldMat);

    let newMask: MaskPath;
    if (payload.points && payload.points.length > 0) {
      const points: MaskPoint[] = payload.points.map((p: any) => {
        // Convert drawn point (relative to bounds center) to world space
        const wp = { x: p.x + cx, y: p.y + cy };
        const win = { x: p.inX + cx, y: p.inY + cy };
        const wout = { x: p.outX + cx, y: p.outY + cy };
        // Transform to parent's local space
        const lp = Matrix.transformPoint(invParentWorldMat, wp);
        const lin = Matrix.transformPoint(invParentWorldMat, win);
        const lout = Matrix.transformPoint(invParentWorldMat, wout);
        return { x: lp.x, y: lp.y, inX: lin.x, inY: lin.y, outX: lout.x, outY: lout.y };
      });
      newMask = {
        id: `mask_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        mode: 'add',
        closed: true,
        feather: 0,
        opacity: 1,
        expansion: 0,
        inverted: false,
        points,
      };
    } else {
      // Fallback if points were missing, though workspace tools should provide them.
      newMask = ellipse ? ellipseMask(width, height) : rectangleMask(width, height);
    }
    
    useSelectionStore.getState().set([parentId]);
    if (isLayer(parentId) && !hasVertexEditState(newMask.points)) {
      sendToolEdit('New Mask', [{
        type: 'addMask',
        layer: parentId,
        path: (maskPointsToPath(newMask.points, newMask.closed) as Extract<Value, { kind: 'path' }>).value,
        mode: newMask.mode,
        inverted: newMask.inverted === true,
      }]);
      return;
    }
    // B3-gap: the API's BezierPath has no per-vertex `broken` (Alt-split
    // handles) / `tension` state, so a pen mask drawn with split handles would
    // come back re-joined through `addMask`.
    addMaskPath(parentId, newMask);
    bumpScene();
    return;
  }

  const text = kind === 'text';
  void insertDrawnLayers(drawnLayerLabel(payload), [payload]).then((ids) => {
    // AE: creating text with the Type tool (click or drag) puts you straight
    // into typing it.
    const id = ids?.[0];
    if (text && id) useTextEditStore.getState().begin(id);
  });
}

/** The undo label of a drawn layer. */
function drawnLayerLabel(payload: CreateNodePayload): string {
  return KIND_FOR_CREATE[payload.kind] === 'text' ? 'New Text Layer' : `New ${payload.kind}`;
}

/**
 * Draw layers into the active composition as ONE engine edit (one undo entry
 * named `label`): the drawn-layer builder below runs off-document and the
 * result goes to the engine as one `pasteLayers` (B3z, `insertBuiltLayers`) —
 * the API's `createLayer` cannot carry what a drawn layer is born with (the
 * toolbar Fill / Stroke paints, the drawn outline, a paragraph box, a
 * Polystar's parameters, the continuous-raster default). The new layers are
 * selected. Resolves to their ids in payload order, or null when the insert
 * failed (toasted).
 *
 * Runs after any tool action still closing, so the build reads the document
 * that action left. Also the entry point for commands that create drawn
 * layers from computed outlines (Convert Mask to Shape Layer).
 */
export async function insertDrawnLayers(label: string, payloads: readonly CreateNodePayload[]): Promise<string[] | null> {
  if (payloads.length === 0) return [];
  await settleToolEdits();
  const comp = activeCompRootId() as string;
  return insertBuiltLayers(label, comp, () => {
    for (const payload of payloads) {
      // Built one after another so each name is unique against the last.
      const { node, polystar } = drawnLayerOf(payload);
      defaultSceneGraph.addChild(comp as ID, node);
      if (polystar) defaultSceneGraph.setFxKey(node.id, POLYSTAR_FX_PROP, polystar);
      // The same default every MENU and LIBRARY insert applies. This path —
      // every layer the user DRAWS — was the one place that did not, so a pen
      // path went soft past 400% while the identical shape from the Layer menu
      // stayed sharp. Must follow `addChild`: the helper reads the node back.
      enableContinuousRasterByDefault(node.id as string);
    }
  });
}

/**
 * A drawn layer as a detached node (and its Polystar parameters, for the
 * Polygon / Star tools). Pure: reads the tool options, writes nothing.
 */
function drawnLayerOf(payload: CreateNodePayload): { node: SceneNode; polystar: ReturnType<typeof defaultPolystar> | null } {
  const kind = KIND_FOR_CREATE[payload.kind] ?? 'shape';
  const cx = payload.bounds.x + payload.bounds.width / 2;
  const cy = payload.bounds.y + payload.bounds.height / 2;
  const ellipse = payload.kind === 'Ellipse';
  const width = payload.bounds.width;
  const height = payload.bounds.height;

  // ── Parametric Polystar (AE parity) ─────────────────────────────────
  // The Polygon / Star tools create a PARAMETRIC layer: the drag sets the
  // outer radius, the tool options seed points / inner radius, and the
  // outline is recomputed from the live parameters every frame
  // (buildSnapshot ▸ polystarOutline) — so "make it 7 points" is a property
  // edit, not a redraw. The tool still hands baked points for its on-canvas
  // preview; they are deliberately NOT stored, or the layer would be a fixed
  // path with a parameter set painted on top.
  const polystarType: PolystarType | null =
    payload.kind === 'Polygon' ? 'polygon' : payload.kind === 'Star' ? 'star' : null;
  if (polystarType) {
    const outerR = Math.max(1, Math.max(width, height) / 2);
    const node = makeNodeAt('shape', payload.kind, cx, cy, false, undefined, outerR * 2, outerR * 2);
    const t = node.components.find((c) => c.type === 'Transform');
    // Not 'rect' (makeNodeAt's no-points fallback): the polystar branch owns
    // the geometry, and 'rect' would draw a square anywhere the config were
    // ever missing — better to say what the layer is.
    if (t) (t.props as Record<string, unknown>).shapeType = 'polystar';
    const cfg = defaultPolystar(
      polystarType,
      outerR,
      polystarType === 'polygon'
        ? Math.max(3, Math.min(12, Math.round(drawToolOptions.polygonSides)))
        : Math.max(3, Math.min(12, Math.round(drawToolOptions.starPoints))),
      drawToolOptions.starInnerRatio,
    );
    return { node, polystar: cfg };
  }

  // Fit the layer box to the OUTLINE, not to the drag rectangle.
  //
  // A drag rect is only the gesture; the geometry it generates rarely fills it.
  // A 5-point star inscribed in a 400×400 drag covers 380×362 and sits 19px
  // above the rect centre, so storing the rect as the layer's width/height left
  // the selection outline (which reads exactly those props) floating with a
  // visible margin on three sides and off-centre on the fourth — the "blueprint
  // border doesn't fit the shape like After Effects" report. Re-basing the
  // points onto their own bbox centre makes the box hug the outline AND puts the
  // layer origin on the shape's own centre, which is what every later rotate /
  // scale / anchor operation assumes.
  let outX = cx;
  let outY = cy;
  let outW = width;
  let outH = height;
  let outPoints = payload.points;
  if (payload.points && payload.points.length > 0) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of payload.points) {
      // Control hull (anchor + both handles) — always contains the drawn curve.
      minX = Math.min(minX, p.x, p.inX, p.outX);
      minY = Math.min(minY, p.y, p.inY, p.outY);
      maxX = Math.max(maxX, p.x, p.inX, p.outX);
      maxY = Math.max(maxY, p.y, p.inY, p.outY);
    }
    if (Number.isFinite(minX) && Number.isFinite(minY)) {
      const bcx = (minX + maxX) / 2;
      const bcy = (minY + maxY) / 2;
      outX = cx + bcx;
      outY = cy + bcy;
      outW = Math.max(1, maxX - minX);
      outH = Math.max(1, maxY - minY);
      outPoints = payload.points.map((p) => ({
        x: p.x - bcx, y: p.y - bcy,
        inX: p.inX - bcx, inY: p.inY - bcy,
        outX: p.outX - bcx, outY: p.outY - bcy,
      }));
    }
  }

  // POINT text carries no authored size. Its box IS its glyphs (`readGeometry`
  // and `buildSnapshot` both measure a text layer and ignore these props), so a
  // stored width/height is a number in the inspector that describes nothing —
  // and it read as a fixed box the type then failed to fit. Paragraph kinds
  // keep theirs as `boxWidth`/`boxHeight` below, which IS what wraps them.
  const pointText = payload.kind === 'Text' || payload.kind === 'VerticalText';
  const node = makeNodeAt(
    kind, payload.kind, outX, outY, ellipse, outPoints,
    pointText ? undefined : outW, pointText ? undefined : outH,
    payload.closed === true,
  );
  if (payload.kind === 'ParagraphText' || payload.kind === 'VerticalParagraphText') {
    // AE paragraph text: the dragged rectangle IS the box. The layer origin is
    // the rect centre (text content is centred on it), so the box lands exactly
    // where it was drawn. Fixed height, top aligned — AE's defaults.
    node.name = 'Text';
    const textComp = node.components.find((c) => c.type === 'Text');
    if (textComp) {
      Object.assign(textComp.props, {
        boxWidth: Math.max(MIN_BOX_SIZE, Math.round(width)),
        boxHeight: Math.max(MIN_BOX_SIZE, Math.round(height)),
        boxAutoSize: 'off',
      });
    }
  }
  if (payload.kind === 'VerticalText' || payload.kind === 'VerticalParagraphText') {
    node.name = 'Text';
    const textComp = node.components.find((c) => c.type === 'Text');
    // A fresh literal not yet in the graph (see the box props above).
    if (textComp) Object.assign(textComp.props, { orientation: 'vertical' });
  }
  return { node, polystar: null };
}

function resizeNode(payload: ResizeNodePayload): void {
  const node = defaultSceneGraph.getNode(payload.id as ID);
  if (!node || node.locked) return;
  const cid = transformComponentId(node);
  if (!cid) return;
  const kind = kindOf(node);
  if (!drawable(kind)) return;
  
  // An SVG layer has no `SIZE` key — it rasterizes down the image path — so it
  // must borrow the image base rather than fall through to the 100×100 default.
  const sizeKey = kind === 'svg' ? 'image' : kind;
  let baseW = (SIZE as Record<string, { w: number; h: number }>)[sizeKey]?.w ?? 100;
  let baseH = (SIZE as Record<string, { w: number; h: number }>)[sizeKey]?.h ?? 100;
  const transComp = node.components.find((c) => c.type === 'Transform');
  let authoredSize = false;
  if (transComp && transComp.props) {
    if (typeof transComp.props.width === 'number') baseW = transComp.props.width;
    if (typeof transComp.props.height === 'number') baseH = transComp.props.height;
    authoredSize =
      typeof transComp.props.width === 'number' &&
      typeof transComp.props.height === 'number' &&
      // TEXT is sized by its glyphs, not by these props: `readGeometry` throws
      // away a text layer's authored width/height and measures the type
      // instead. Writing them would move the numbers in the inspector and
      // change nothing on canvas — worse than the scale the drag would
      // otherwise have applied, because it looks like the drag did nothing.
      // (Reflowing a paragraph box is a `boxWidth`/`boxHeight` edit, made by the
      // Type-tool / text-editing box handles — layout/Workspace/textBoxReflow.ts —
      // never by this Selection-tool scale path, exactly as in AE.)
      kind !== 'text';
  }
  /*
   * Ctrl on a handle asks for the layer's SIZE rather than its Scale, and the
   * tool says so by sending `size` (the new box in the layer's own units).
   *
   * A layer that cannot express the drag as a size — text, or anything that
   * somehow lost its dimensions — keeps scaling instead, which is what it did
   * before the modifier existed. Falling back beats swallowing the gesture.
   */
  const sizing = payload.size !== undefined && authoredSize;
  const nextW = payload.size ? snapPx(Math.max(1, Math.abs(payload.size.x))) : baseW;
  const nextH = payload.size ? snapPx(Math.max(1, Math.abs(payload.size.y))) : baseH;
  const b = payload.bounds;
  // Prefer the scale the TOOL resolved. Inferring it here as
  // `worldAABB.width / localWidth` is wrong for anything rotated — rotation
  // inflates the AABB, so the first drag tick multiplied the scale by that
  // inflation and every later tick re-inflated it. That is what made a corner
  // drag on a rotated or 3D layer lurch sideways and grow without settling, and
  // why a text box could never match its glyph width (its local width and
  // rendered extents disagree, so the ratio was never 1).
  //
  // The fallback keeps older callers and tests working; it is only correct for
  // an unrotated layer, which is the only case it was ever right for.
  const rawCentre = payload.center ?? { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const scaleX = payload.scale ? payload.scale.x : baseW > 0 ? b.width / baseW : 1;
  const scaleY = payload.scale ? payload.scale.y : baseH > 0 ? b.height / baseH : 1;

  // The tool hands back the new box's CENTRE, which for most layers is also the
  // node's position. For a node whose box is offset from its origin (a group,
  // whose bounds are its children's union) they differ, and writing the box
  // centre straight into x/y would teleport it by that offset on the first
  // drag tick. Convert back through the same rotation/scale the box was
  // measured in.
  const geo = readGeometry(node);
  const centre = (() => {
    if (!geo || (geo.offsetX === 0 && geo.offsetY === 0)) return rawCentre;
    const rad = (geo.rotationDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const ox = geo.offsetX * scaleX;
    const oy = geo.offsetY * scaleY;
    return { x: rawCentre.x - (ox * cos - oy * sin), y: rawCentre.y - (ox * sin + oy * cos) };
  })();
  
  const rawTime = playheadSeconds();

  // World → parent space. `centre` and `scaleX/scaleY` are what the TOOL
  // measured on screen; `x`/`y`/`scaleX`/`scaleY` are stored relative to the
  // parent. Identity for an unparented layer, so nothing changes there.
  const ps = parentSpaceOf(node.id, rawTime);
  const localCentreRaw = Matrix.transformPoint(ps.inv, centre);
  const localCentre = { x: snapPx(localCentreRaw.x), y: snapPx(localCentreRaw.y) };
  const localScaleX = scaleX / ps.scaleX;
  const localScaleY = scaleY / ps.scaleY;

  // Everything the tool resolved is ABSOLUTE against drag-start state (the
  // ratio contract `resizeRotated.test.ts` pins), so each message is the whole
  // answer. Per-property stopwatch contract: position and scale (or size)
  // decide independently whether they key — `trackValueCommands` asks each.
  const scaleValues = { x: localCentre.x, y: localCentre.y, scaleX: localScaleX, scaleY: localScaleY };
  if (sizing) {
    // Scale is deliberately left ALONE. The drag expressed itself entirely in
    // width/height, and writing the (unchanged) scale back would push the
    // WORLD scale the tool measured onto a node whose own scale is a different
    // number the moment it has a parent. Keying Scale on a Size drag would
    // record a value the drag never changed.
    const sized = sendLayerValues('Resize', [{ nodeId: node.id as string, values: { x: localCentre.x, y: localCentre.y, width: nextW, height: nextH } }]);
    if (sized) return;
    // A layer whose Size the API cannot address keeps scaling — falling back
    // beats swallowing the gesture (the same rule as a layer with no size).
  }
  sendLayerValues('Scale', [{ nodeId: node.id as string, values: scaleValues }]);
}
function rotateNode(payload: RotateNodePayload): void {
  const node = defaultSceneGraph.getNode(payload.id as ID);
  if (!node || node.locked) return;
  if (!transformComponentId(node)) return;
  // The tool's angle is ABSOLUTE and in WORLD space (it starts from
  // `node.worldMatrix`); `rotation` is stored relative to the parent. Subtract
  // the parent's world rotation — zero, and so a no-op, without a parent.
  const deg = (payload.rotation * 180) / Math.PI - parentSpaceOf(node.id, playheadSeconds()).rotationDeg;
  sendLayerValues('Rotate', [{ nodeId: node.id as string, values: { rotation: deg } }]);
}

/**
 * Whether a node can take its share of a MULTI-selection transform.
 *
 * Mirrors the single-node gates: `resizeNode` refuses non-drawable kinds, the
 * selection controller withholds the 2D grips from 3D layers (the gizmo owns
 * them) and devices (the renderer ignores their scale/rotation outright). The
 * tool filters the same way before it ever sends the command; this is the
 * belt-and-braces for any other caller.
 */
function multiTransformable(node: SceneNode): boolean {
  const kind = kindOf(node);
  return drawable(kind) && kind !== 'light' && kind !== 'camera' && !is3DEnabled(node);
}

/**
 * Scale a multi-selection about one fixed world pivot — the group-box handle
 * drag. The TOOL resolved everything absolute (per-node world scale and the
 * world point each node's anchor lands on, both derived from drag-START state,
 * the same ratio contract as `resizeNode`); this handler only converts
 * world → parent space. Every node goes in ONE message, so the drag is one
 * undo entry.
 *
 * `item.position` is the ANCHOR's world point, which is `parentWorld · (x, y)`
 * by the renderer's model — so the layer's own x/y is just the parent inverse
 * applied to it, with none of the box-centre/offset correction `resizeNode`
 * needs for its centre-based payload.
 */
function multiResizeNodes(payload: MultiResizeNodesPayload): void {
  if (payload.items.length === 0) return;
  const rawTime = playheadSeconds();
  const items: NodeTrackValues[] = [];
  for (const item of payload.items) {
    const node = defaultSceneGraph.getNode(item.id as ID);
    if (!node || node.locked || !multiTransformable(node)) continue;
    if (!transformComponentId(node)) continue;
    // World → parent space, the space x/y and scaleX/scaleY actually live in.
    const ps = parentSpaceOf(node.id, rawTime);
    const localPos = Matrix.transformPoint(ps.inv, item.position);
    items.push({
      nodeId: node.id as string,
      values: { x: localPos.x, y: localPos.y, scaleX: item.scale.x / ps.scaleX, scaleY: item.scale.y / ps.scaleY },
    });
  }
  sendLayerValues('Scale', items);
}

/**
 * Rotate a multi-selection about the group centre: each node's rotation adds
 * the drag's sweep and its anchor orbits the pivot — both resolved ABSOLUTE by
 * the tool. Same shape as `multiResizeNodes`.
 */
function multiRotateNodes(payload: MultiRotateNodesPayload): void {
  if (payload.items.length === 0) return;
  const rawTime = playheadSeconds();
  const items: NodeTrackValues[] = [];
  for (const item of payload.items) {
    const node = defaultSceneGraph.getNode(item.id as ID);
    if (!node || node.locked || !multiTransformable(node)) continue;
    if (!transformComponentId(node)) continue;
    const ps = parentSpaceOf(node.id, rawTime);
    // The tool's angle is ABSOLUTE world; `rotation` is stored parent-relative
    // — the same subtraction rotateNode performs.
    const localPos = Matrix.transformPoint(ps.inv, item.position);
    items.push({
      nodeId: node.id as string,
      values: { rotation: (item.rotation * 180) / Math.PI - ps.rotationDeg, x: localPos.x, y: localPos.y },
    });
  }
  sendLayerValues('Rotate', items);
}

/**
 * Pan Behind (AE Y): move the anchor and compensate Position so the layer
 * stays put. The tool sends the new anchor ABSOLUTE (layer-local); the
 * compensation is computed from the DRAG-START anchor, position, rotation and
 * scale — all read at the playhead, animated values winning (see
 * `moveAnchorCompensated`, whose arithmetic this is) — so every message is
 * the whole answer and a dropped one loses nothing.
 */
function moveAnchor(payload: MoveAnchorPayload): void {
  const node = defaultSceneGraph.getNode(payload.id as ID);
  if (!node || node.locked) return;
  const id = node.id as string;
  const capture = (): { ax: number; ay: number; x: number; y: number; rot: number; sx: number; sy: number } => ({
    ax: readTransformProp(id, 'anchorX', 0),
    ay: readTransformProp(id, 'anchorY', 0),
    x: readTransformProp(id, 'x', 0),
    y: readTransformProp(id, 'y', 0),
    rot: readTransformProp(id, 'rotation', 0),
    sx: readTransformProp(id, 'scaleX', 1),
    sy: readTransformProp(id, 'scaleY', 1),
  });
  const txn = currentToolTransaction();
  const anchor = { ...payload.anchor };
  sendLayerValues('Pan Behind', () => {
    // Captured once per drag, when its first message can go.
    const st = txn ? txn.memo(`anchor:${id}`, capture) : capture();
    const d = anchorCompensation(anchor.x - st.ax, anchor.y - st.ay, st.rot, st.sx, st.sy);
    return [{ nodeId: id, values: { anchorX: anchor.x, anchorY: anchor.y, x: st.x + d.dx, y: st.y + d.dy } }];
  }, txn);
}

/**
 * Delete / Backspace in the viewport: one `deleteLayers` per composition, ONE
 * entry. Locked layers and composition roots stay (the context menu's Delete
 * skips them the same way); the rest of the selection is kept.
 */
function deleteNodes(payload: DeleteNodesPayload): void {
  if (payload.ids.length === 0) return;
  const byComp = new Map<string, string[]>();
  for (const id of new Set(payload.ids as readonly string[])) {
    const n = defaultSceneGraph.getNode(id as ID);
    const comp = n && !n.locked ? compOfLayer(id) : null;
    if (!comp) continue;
    const list = byComp.get(comp);
    if (list) list.push(id);
    else byComp.set(comp, [id]);
  }
  const doomed = [...byComp.values()].flat();
  if (doomed.length === 0) return;
  const cmds: Command[] = [...byComp.values()].map((layers) => ({ type: 'deleteLayers', layers }));
  void runToolEdit(doomed.length === 1 ? 'Delete layer' : 'Delete layers', cmds).then((res) => {
    if (!res?.ok) return;
    const remaining = useSelectionStore.getState().ids.filter((id) => !doomed.includes(id));
    useSelectionStore.getState().set(remaining);
  });
}

type PathPoint = import('@motion/workspace').BezierPoint;

/** A `path.points` data value as full bezier points (a corner's handles collapse onto it). */
function toBezierPoints(value: unknown): PathPoint[] | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const first = value[0] as unknown;
  if (typeof first !== 'object' || first === null || !('x' in first)) return undefined;
  return (value as Array<{ x: number; y: number; inX?: number; inY?: number; outX?: number; outY?: number; broken?: boolean; tension?: number }>).map(
    (p) => ({
      x: p.x, y: p.y, inX: p.inX ?? p.x, inY: p.inY ?? p.y, outX: p.outX ?? p.x, outY: p.outY ?? p.y,
      // The editing flags ride along — dropping them here would un-break
      // every Alt-split handle of an animated path on its next edit.
      ...(p.broken ? { broken: true } : {}),
      ...(typeof p.tension === 'number' ? { tension: p.tension } : {}),
    }),
  );
}

/**
 * Carry `broken` / `tension` onto sampled points from the keyframe at or before
 * `t`. The data-track sampler interpolates geometry only, so a sampled vertex
 * has lost its editing state; it is the same vertex as that keyframe's (same
 * index — topology edits keep every keyframe's count equal).
 */
function withKeyframeFlags(nodeId: string, points: PathPoint[], t: number): PathPoint[] {
  const track = defaultAnimation.dataTracksFor(nodeId).find((d) => d.prop === 'path.points');
  if (!track || track.keyframes.length === 0) return points;
  let key = track.keyframes[0]!;
  for (const k of track.keyframes) if (k.t <= t + 1e-9) key = k;
  const src = key.value as Array<{ broken?: boolean; tension?: number }>;
  if (!Array.isArray(src) || src.length !== points.length) return points;
  return points.map((p, i) => {
    const s = src[i];
    if (!s || (!s.broken && typeof s.tension !== 'number')) return p;
    return { ...p, ...(s.broken ? { broken: true } : {}), ...(typeof s.tension === 'number' ? { tension: s.tension } : {}) };
  });
}

/**
 * The outline the renderer DRAWS at `localTime`: an animated `path.points`
 * track wins over the static Geometry points, exactly as in `buildSnapshot`.
 *
 * This read the static points only, so on an animated shape Direct Selection
 * showed vertices where the path had been at creation and every drag wrote
 * the static prop — which nothing renders once the track exists. The edit
 * never appeared.
 */
function livePathPoints(node: SceneNode, localTime: number): PathPoint[] | undefined {
  const live = toBezierPoints(defaultAnimation.sampleData(node.id as string, 'path.points', localTime));
  if (live) return withKeyframeFlags(node.id as string, live, localTime);
  return node.components.find((c) => c.type === 'Geometry')?.props.points as PathPoint[] | undefined;
}

/** `Geometry.open` marks a stroke; everything else wraps, as the renderer reads it. */
function pathIsClosed(node: SceneNode): boolean | undefined {
  const geom = node.components.find((c) => c.type === 'Geometry');
  return geom ? geom.props.open !== true : undefined;
}

/** `Geometry.rotoBezier` — the layer's own outline has computed handles. */
function pathIsRotoBezier(node: SceneNode): boolean {
  return node.components.find((c) => c.type === 'Geometry')?.props.rotoBezier === true;
}

/** History labels for the structural path edits, as AE names them. */
const TOPOLOGY_LABEL: Record<string, string> = {
  insert: 'Add Vertex',
  delete: 'Delete Vertex',
  deleteMany: 'Delete Vertices',
  firstVertex: 'Set First Vertex',
  reverse: 'Reverse Path Direction',
  extend: 'Continue Path',
};

/**
 * Write the outline-level switches a path payload carries (Closed, RotoBezier).
 * B3-gap: `Geometry.open` / `Geometry.rotoBezier` have no API property.
 */
function writeGeometryFlags(node: SceneNode, flags: { closed?: boolean; rotoBezier?: boolean }): void {
  const geom = node.components.find((c) => c.type === 'Geometry');
  if (!geom) return;
  // `open: true` marks a stroke; a closed path stores NO key, which is how a
  // Pen-closed path and every primitive already read.
  if (flags.closed !== undefined) defaultSceneGraph.writeProp(node.id, geom.id, 'open', flags.closed ? undefined : true);
  if (flags.rotoBezier !== undefined) defaultSceneGraph.writeProp(node.id, geom.id, 'rotoBezier', flags.rotoBezier ? true : undefined);
}

/**
 * The API property of a layer's ANIMATED outline (`path.points`, a path
 * value), or null when the engine cannot take the write: not a composition's
 * layer, or a static outline (the TS engine gives `path.points` no static
 * value — "key it instead").
 */
function animatedPathRef(id: string): PropRef | null {
  if (!isLayer(id) || !defaultAnimation.isDataAnimated(id, 'path.points')) return null;
  const r = propRefForTrack(id, 'path.points');
  return r && r.valueType === 'path' ? r.ref : null;
}

/**
 * Direct Selection / Pen edits of a layer's own outline.
 *
 * A RESHAPE of an ANIMATED outline (the whole outline at the playhead,
 * absolute) goes to the engine as the Path at the playhead — a key there, one
 * gesture per drag, the comp time mapped onto the layer's keyframe axis by the
 * engine — WHEN the catalog types the layer's `path.points` as a path value
 * (a `path.points` data track on a layer with no drawn Geometry outline, e.g.
 * a primitive shape).
 * The route is decided once per drag, so one drag never mixes the two
 * histories.
 *
 * B3-gap: everything else keeps the legacy writer, one gesture transaction
 * per drag: a DRAWN shape layer's Path is catalogued as a scalar
 * `layer/path.points` (static or animated, so `animatedPathRef` is null for
 * it), the TS engine gives `path.points` no static value ("key it instead"),
 * a BezierPath drops each vertex's `broken` / `tension` editing state, and
 * Closed / RotoBezier (`Geometry.open`, `rotoBezier`) and a vertex added or
 * removed on EVERY keyframe have no command.
 */
function updateNodePath(payload: UpdateNodePathPayload): void {
  const node = defaultSceneGraph.getNode(payload.id as ID);
  if (!node || node.locked) return;
  const id = node.id as string;
  const geomComponent = node.components.find((c) => c.type === 'Geometry');
  const topology = payload.topology;

  if (!topology && payload.closed === undefined && payload.rotoBezier === undefined && !hasVertexEditState(payload.points)) {
    const txn = currentToolTransaction();
    const ref = txn ? txn.memo(`pathroute:${id}`, () => animatedPathRef(id)) : animatedPathRef(id);
    if (ref) {
      sendToolEdit('Edit Path', [{
        type: 'setProperty',
        prop: ref,
        value: maskPointsToPath(payload.points as MaskPoint[], geomComponent?.props.open !== true),
        time: compTime(getTimelineController().currentSeconds),
      }], txn);
      return;
    }
  }

  // An ANIMATED outline: write the track the renderer reads, like a mask edit.
  // A reshape keys the playhead (on the layer's keyframe axis, see
  // `updateMaskPathCmd`); a vertex added or removed is replayed on EVERY
  // keyframe, or the keyframes disagree on their vertex count and the path
  // stops morphing. Through the gesture's anim transaction, so the drag is one
  // undo step.
  // The closed state BEFORE this edit's flags: a Continue that closes the path
  // appended its run to the outline as it was, open.
  const wasClosed = geomComponent?.props.open !== true;
  // B3-gap: see the function comment (no Closed / RotoBezier / shape-path property).
  writeGeometryFlags(node, payload);
  if (defaultAnimation.isDataAnimated(id, 'path.points')) {
    if (topology) {
      const closed = wasClosed;
      gestureAnimEdit(TOPOLOGY_LABEL[topology.op] ?? 'Edit Path', () => {
        const track = defaultAnimation.getDataTrack(id, 'path.points');
        if (!track) return;
        defaultAnimation.setDataTrack(id, 'path.points', {
          ...track,
          keyframes: track.keyframes.map((k) => {
            const pts = toBezierPoints(k.value);
            const next = pts ? applyPathTopology(pts, topology, closed) : null;
            return next ? { ...k, value: next } : k;
          }),
        });
      });
    } else {
      const t = compToKeyframeTime(id, getTimelineController().currentSeconds);
      gestureAnimEdit(
        'Edit Path',
        () => defaultAnimation.setDataKeyframe(id, 'path.points', 'points', t, payload.points),
        `drag:path:${t}:${id}`,
      );
    }
    gestureSceneBump();
    return;
  }

  if (geomComponent) {
    defaultSceneGraph.writeProp(node.id, geomComponent.id, 'points', payload.points);
    gestureSceneBump();
  }
}

/**
 * Reshape one of a layer's masks (the Direct Selection drag on canvas).
 *
 * The payload is the WHOLE outline at the playhead (absolute), so it goes to
 * the engine as the Mask Path at the playhead: a key there on an animated mask
 * (AE), the shape itself on a static one — one gesture per drag. The engine
 * maps the comp time onto the layer's keyframe axis, where `buildSnapshot`
 * reads the mask.
 */
function updateMaskPathCmd(payload: UpdateMaskPathPayload): void {
  const node = defaultSceneGraph.getNode(payload.id as ID);
  if (!node || node.locked) return;
  const id = payload.id as string;
  const topology = payload.topology;
  const current = readNodeMask(node)?.paths.find((p) => p.id === payload.maskId);
  const viaEngine = (): boolean =>
    isLayer(id) && !!current &&
    // RotoBezier is a mask-level switch the API does not have.
    payload.rotoBezier === undefined &&
    // A vertex added / removed on an ANIMATED mask changes every keyframe.
    !(topology && readNodeMaskAnim(node).length > 0) &&
    // Split handles / RotoBezier tension would be dropped by a BezierPath.
    !hasVertexEditState(payload.points) && !hasVertexEditState(current.points);
  // Decided once per drag, so one gesture never mixes the two histories.
  const txn = currentToolTransaction();
  const route = txn ? txn.memo(`maskroute:${id}:${payload.maskId}`, viaEngine) : viaEngine();
  if (route && current) {
    sendToolEdit(topology ? TOPOLOGY_LABEL[topology.op] ?? 'Edit Mask' : 'Edit Mask', [{
      type: 'setProperty',
      prop: { layer: id, path: paths.mask(payload.maskId, 'path') },
      value: maskPointsToPath(payload.points as MaskPoint[], payload.closed ?? current.closed),
      time: compTime(getTimelineController().currentSeconds),
    }], txn);
    return;
  }
  // B3-gap: RotoBezier (a mask-level switch with no property), per-vertex
  // `broken` / `tension` (no BezierPath field), and a vertex added / removed on
  // every key of an animated mask: expressible as `updateKeyframes` value
  // patches, but those need the keys' engine ids, and this port runs inside a
  // pointer gesture's synchronous builder (`querySync` answers null while the
  // gesture's own sends are in flight) — no one-command "apply topology to
  // every keyframe" exists (see the conditions above).
  //
  // The playhead on the layer's KEYFRAME axis — where `buildSnapshot` reads the
  // mask (`remapOf`), and where the Effects panel, the timeline and the Layer
  // panel write. Raw comp time is the same number only for an untrimmed bar at
  // 0; on a moved or trimmed layer it put the keyframe where the shape is not.
  const t = compToKeyframeTime(id, getTimelineController().currentSeconds);
  if (payload.closed !== undefined || payload.rotoBezier !== undefined) {
    setMaskPathFlags(id, payload.maskId, { closed: payload.closed, rotoBezier: payload.rotoBezier });
  }
  if (topology) {
    // Adding or deleting a vertex changes every keyframe, not the one at the
    // playhead — see `editMaskPathTopology`. Splitting is linear in the control
    // points, so the shape at the playhead comes out as `payload.points`.
    editMaskPathTopology(id, payload.maskId, (points, closed) =>
      applyPathTopology(points, topology, closed) as MaskPoint[] | null,
    );
  } else {
    setMaskPoints(id, payload.maskId, payload.points as MaskPoint[], t);
  }
  gestureSceneBump();
}

// ── Knife ───────────────────────────────────────────────────────────

/** Normalise a stored anchor: a missing handle collapses onto its vertex. */
function toCutPoint(p: {
  x: number; y: number;
  inX?: number; inY?: number; outX?: number; outY?: number;
}): CutPoint {
  return {
    x: p.x, y: p.y,
    inX: p.inX ?? p.x, inY: p.inY ?? p.y,
    outX: p.outX ?? p.x, outY: p.outY ?? p.y,
  };
}

/**
 * A shape layer's outline as runs the knife can cut, in LOCAL space.
 *
 * Three storage shapes, in the order `buildSnapshot` resolves them, so the
 * knife cuts the outline the renderer is actually drawing:
 *   1. `subpaths` — the multi-run form (an SVG import, a previous cut);
 *   2. `points` — the single-run shorthand;
 *   3. neither — a PRIMITIVE that has never been converted to a path.
 *
 * Case 3 is the one that makes the tool feel finished: a freshly drawn
 * rectangle has no stored points at all, and a knife that refused to cut the
 * shapes the shape tools produce would be a knife for imported art only.
 */
function readCutRuns(node: SceneNode): CutSubpath[] | null {
  const geom = node.components.find((c) => c.type === 'Geometry');
  const subs = geom?.props.subpaths as
    | Array<{ points?: Array<Parameters<typeof toCutPoint>[0]>; open?: boolean }>
    | undefined;
  if (Array.isArray(subs) && subs.length > 0) {
    const runs = subs
      .map((r) => ({ points: (r.points ?? []).map(toCutPoint), open: r.open === true }))
      .filter((r) => r.points.length >= 2);
    return runs.length > 0 ? runs : null;
  }
  const pts = geom?.props.points as Array<Parameters<typeof toCutPoint>[0]> | undefined;
  if (Array.isArray(pts) && pts.length >= 2) {
    return [{ points: pts.map(toCutPoint), open: geom?.props.open === true }];
  }
  const g = readGeometry(node);
  if (!g) return null;
  // Only the two primitives whose outline `shapeOutline` actually knows. A
  // polygon or a star would come back as a rectangle, and cutting a shape into
  // halves of a shape it isn't is worse than not cutting it.
  const primitive = g.ellipse ? 'ellipse' : 'rect';
  const tProps = node.components.find((c) => c.type === 'Transform')?.props as
    | Record<string, unknown>
    | undefined;
  const shapeType = tProps?.shapeType;
  if (typeof shapeType === 'string' && shapeType !== 'rect' && shapeType !== 'rectangle' && shapeType !== 'ellipse') {
    return null;
  }
  // A rounded rect's rounding is part of its outline: seeding the cut from the
  // sharp rect made the knife split a shape the screen was not showing — the
  // halves came back square-cornered. Same resolution (per-corner over uniform,
  // CSS clamping, comp-px radii mapped through the layer's scale) as the
  // renderer's own seed in `buildSnapshot`.
  const corner = (key: keyof CornerRadiiProps): number | undefined => {
    const v = tProps?.[key];
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : undefined;
  };
  const radii = clampCornerRadii(g.width, g.height, resolveCornerRadii({
    cornerRadius: corner('cornerRadius'),
    cornerRadiusTL: corner('cornerRadiusTL'),
    cornerRadiusTR: corner('cornerRadiusTR'),
    cornerRadiusBR: corner('cornerRadiusBR'),
    cornerRadiusBL: corner('cornerRadiusBL'),
  }));
  const outline = shapeOutline(
    primitive, g.width, g.height, 48, 0,
    radii, [Math.abs(g.scaleX), Math.abs(g.scaleY)],
  );
  return outline.length >= 3 ? [runFromPolygon(outline)] : null;
}

/**
 * Knife — split each targeted layer's outline along a world-space line.
 *
 * ONE history entry for the whole gesture, even across several layers: the user
 * made one drag, and an undo that put back three of five cut layers would be a
 * worse state than either end of it. `flush` first, for the same reason every
 * other structural edit does it — a coalescing drag still open would otherwise
 * absorb this into itself.
 *
 * The halves stay on the SAME layer, as sibling runs, which is what the path
 * model already expresses (it is how a boolean's islands and an imported
 * icon's counters are stored). Splitting into sibling LAYERS would need new
 * ids, and layer ids are not stable across a session — so the pieces would be
 * unreachable by anything holding a reference, expressions included.
 */
/*
 * B3-gap: the knife writes a shape layer's `Geometry.subpaths` (multi-run
 * outline), clears `Geometry.points` and flips its `shapeType` to 'path'; the
 * API has no property for any of them, so the flush / record around it stay
 * on the legacy recorder too.
 */
function cutPaths(payload: CutPathsPayload): void {
  const time = getTimelineController().currentSeconds;
  const touched: string[] = [];
  useHistoryStore.getState().flush();

  for (const rawId of payload.ids) {
    const id = rawId as string;
    const node = defaultSceneGraph.getNode(id as ID);
    if (!node || node.locked) continue;
    if (readNodeKind(node) !== 'shape') continue;
    // An animated outline wins over stored geometry every frame, so a cut
    // written to the static props would simply not appear. Silently doing
    // nothing is better than writing geometry that never renders.
    if (defaultAnimation.isAnimated(id, 'path.points')) continue;

    const runs = readCutRuns(node);
    if (!runs) continue;

    // The drag is measured in WORLD space; stored points are local and centred
    // on the layer's own origin. One inverse per layer, so a single drag cuts a
    // rotated child and its unrotated parent along the same visible line.
    const inv = Matrix.invert(world2DAt(id, time));
    const a = Matrix.transformPoint(inv, payload.a);
    const b = Matrix.transformPoint(inv, payload.b);

    const cut = cutPathsWithLine(runs, a, b);
    // Identity: `cutPathsWithLine` hands back the input array when the line
    // crossed nothing, so a miss costs no write and no undo entry.
    if (cut === runs) continue;

    const geom = node.components.find((c) => c.type === 'Geometry');
    const subpaths = cut.map((r) => ({ points: r.points, open: r.open }));
    if (geom) {
      defaultSceneGraph.writeProp(id as ID, geom.id, 'subpaths', subpaths);
      // `points` and `subpaths` are mutually exclusive (raster/subpaths.ts);
      // leaving the old flat run behind would let the two disagree about the
      // layer's shape, with the fill drawn from one and the stroke the other.
      defaultSceneGraph.writeProp(id as ID, geom.id, 'points', undefined);
    } else {
      defaultSceneGraph.addComponent(id as ID, {
        id: `${id}_g`,
        type: 'Geometry',
        props: { subpaths },
      });
    }
    // A cut rectangle is no longer a rectangle. Without this the renderer keeps
    // drawing the primitive from width/height and the cut is invisible.
    const transform = node.components.find((c) => c.type === 'Transform');
    if (transform) defaultSceneGraph.writeProp(id as ID, transform.id, 'shapeType', 'path');
    touched.push(id);
  }

  if (touched.length === 0) return;
  bumpScene();
  useHistoryStore.getState().record(touched.length > 1 ? `Knife (${touched.length} layers)` : 'Knife');
}

/**
 * @param viewOf Which view the gestures driving this port come from. Omit for
 *   the main viewport (follows the store). A secondary pane passes its own, so a
 *   drag in a Top pane resolves against Top's axes even while the main viewport
 *   shows Front — without it every pane's drag would be interpreted through the
 *   main viewport's view and move the layer along the wrong axis.
 */
export function createCommandPort(viewOf?: () => Camera3dMode): CommandPort {
  return {
    execute(command: WorkspaceCommand): void {
      switch (command.type) {
        case WorkspaceCommandType.MoveNodes:
          moveNodes(command.payload as MoveNodesPayload, viewOf);
          break;
        case WorkspaceCommandType.CreateNode:
          createNode(command.payload as CreateNodePayload);
          break;
        case WorkspaceCommandType.ResizeNode:
          resizeNode(command.payload as ResizeNodePayload);
          break;
        case WorkspaceCommandType.RotateNode:
          rotateNode(command.payload as RotateNodePayload);
          break;
        case WorkspaceCommandType.MultiResizeNodes:
          multiResizeNodes(command.payload as MultiResizeNodesPayload);
          break;
        case WorkspaceCommandType.MultiRotateNodes:
          multiRotateNodes(command.payload as MultiRotateNodesPayload);
          break;
        case WorkspaceCommandType.MoveAnchor:
          moveAnchor(command.payload as MoveAnchorPayload);
          break;
        case WorkspaceCommandType.DeleteNodes:
          deleteNodes(command.payload as DeleteNodesPayload);
          break;
        case WorkspaceCommandType.UpdateNodePath:
          updateNodePath(command.payload as UpdateNodePathPayload);
          break;
        case WorkspaceCommandType.UpdateMaskPath:
          updateMaskPathCmd(command.payload as UpdateMaskPathPayload);
          break;
        case WorkspaceCommandType.CutPaths:
          cutPaths(command.payload as CutPathsPayload);
          break;
        default:
          break;
      }
    },
  };
}

export { drawable as isDrawableKind, readNodeKind };
