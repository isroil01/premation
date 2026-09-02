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
  type MoveAnchorPayload,
  type UpdateNodePathPayload,
  type UpdateMaskPathPayload,
  type CutPathsPayload,
  Mat,
  Rect,
  OBox,
} from '@motion/workspace';
import { cutPathsWithLine, runFromPolygon, type CutSubpath, type CutPoint } from '@core/geometry/pathCut';
import { shapeOutline } from '@core/scene/pathOps';
import { useHistoryStore } from '@stores/historyStore';
import { readNodeAnchor, moveAnchorCompensated } from '@core/scene/anchor';
import { enableContinuousRasterByDefault } from '@core/scene/continuousRaster';
import { SIZE } from '@core/rendering/buildSnapshot';
import { readNodeKind as kindOf } from '@core/scene/sceneDerive';

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { activeCompRootId } from '@core/scene/activeComp';
import { readNodeKind } from '@core/scene/sceneDerive';
import { SCENE_KIND_PROP, type SceneKind } from '@core/scene/seedDefaultScene';
import { flattenComposition } from '@core/scene/sceneDerive';
import type { SceneNode, ID } from '@core/types';
import { useSelectionStore } from '@stores/selectionStore';
import { useGuidesStore, type Camera3dMode } from '@stores/guidesStore';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import { getEventBus } from '@core/events/EventBus';
import { readGeometry, localBounds, makeHitTestLocal, isDrawableKind as drawable } from './geometry';
import { usePreferenceStore } from '@stores/preferenceStore';
import { defaultAnimation } from '@motion/animation';
import { drawToolOptions } from '@motion/workspace';
import { gestureAnimEdit, gestureSceneBump } from '@core/workspace/viewportGesture';
import { useProjectStore } from '@stores/projectStore';
import { getRemappedTime, getTimelineController, governingClipsFor } from '@core/timeline/TimelineController';
import { is3DEnabled, readNode3D } from '@core/scene/threeD';
import { Matrix4Math, Project3D } from '@motion/scene';
import { currentViewProjector, currentViewCamera } from '@core/workspace/viewProjection';
import { isCustomViewId } from '@core/workspace/customViews';
import { composeNodeWorld3d, parentWorld3d, resolveNode3DTransform } from '@core/scene/nodeMatrix';
import { addMaskPath, rectangleMask, ellipseMask, readNodeMask, setMaskPoints, MaskPath, MaskPoint } from '@core/effects/mask';

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
function toWorkspaceNode(
  node: SceneNode,
  zIndex: number,
  wmCache: Map<string, import('@motion/scene').Matrix2D> = new Map(),
  /** Project through THIS view rather than the main viewport's — see
   *  {@link createSceneGraphPort}. */
  view?: Camera3dMode,
): WorkspaceNode | null {
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
    pathPoints: node.components.find((c) => c.type === 'Geometry')?.props.points as import('@motion/workspace').BezierPoint[] | undefined,
    // Masks are editable outlines too — without these the Direct Selection tool
    // can't see them, which is why a mask's shape was frozen once drawn.
    maskPaths: readNodeMask(node)?.paths.map((p) => ({ id: p.id, points: p.points })),
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
      let lastTime: number | undefined;
      const unsubTime = useProjectStore.subscribe((s) => {
        const activeTab = s.tabs[s.activeTabId ?? ''];
        const t = activeTab?.time;
        if (t !== lastTime) {
          lastTime = t;
          listener();
        }
      });
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
): SceneNode {
  const id = `${kind}_${(createSeq += 1)}_${Math.random().toString(36).slice(2, 6)}`;
  const displayName = ellipse ? 'Circle' : name;
  const transform = { position: { x: cx, y: cy }, rotation: 0, scale: { x: 1, y: 1 } };
  const nameLower = (name ?? '').toLowerCase();
  const isRectOrEllipse = nameLower.includes('rect') || nameLower.includes('ellipse') || nameLower.includes('circle');
  // Open strokes (line / pencil / pen) enclose no area, so a fill is invisible —
  // give them a visible stroke and a transparent fill instead. Colours/widths
  // come from the tool-options bar (drawToolOptions singleton).
  const stroked =
    STROKED_KINDS.has(nameLower) ||
    (!CLOSED_POINT_KINDS.has(nameLower) && !!points && points.length > 0 && !ellipse && !isRectOrEllipse);
  const styleProps = stroked
    ? {
        opacity: 100,
        fill: 'rgba(0,0,0,0)',
        stroke: {
          color: drawToolOptions.pencilColor || '#38bdf8',
          width: Math.max(1, drawToolOptions.pencilWidth || 2),
          opacity: 1,
          cap: 'round',
          join: 'round',
          align: 'center',
          dash: [],
        },
      }
    : { opacity: 100, fill: nameLower === 'brush' ? drawToolOptions.brushColor : '#2b7eff' };

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
      { id: `${id}_c`, type: 'Text', props: { content: 'Text', fontSize: 32, opacity: 100 } },
    );
  } else {
    components.push(
      { id: `${id}_t`, type: 'Transform', props: transformProps },
      { id: `${id}_s`, type: 'Style', props: { opacity: styleProps.opacity, fill: styleProps.fill } },
    );
    if ('stroke' in styleProps) {
      components.push({ id: `${id}_fx`, type: 'fx', props: { stroke: (styleProps as any).stroke } });
    }
  }

  if (kind === 'shape' && points) {
    // Open strokes (line / pencil) must render as an un-closed polyline; mark
    // the geometry so the renderer doesn't wrap the last point back to the first.
    const openProps = stroked ? { open: true } : {};
    components.push({ id: `${id}_g`, type: 'Geometry', props: { points, ...openProps } });
  }

  return { id, name: displayName, parent: null, children: [], transform, visible: true, locked: false, components };
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

function cidOf(node: SceneNode, prop: string): string {
  const c = node.components.find((comp) => comp.props[prop] !== undefined);
  return c?.id ?? node.components[0]?.id ?? '';
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
 * Apply 3D-gizmo transform writes through the SAME dual path the canvas drag
 * uses (moveNodes/rotateNode/resizeNode): a prop with a lit stopwatch — or any
 * prop while Auto-Keyframe is on — keyframes at the current remapped playhead
 * (one coalesced undo entry per drag via the stable merge key); the static
 * base always follows too (harmless when animated — animated reads win — and
 * it keeps the inspector and every other consumer in agreement).
 */
export function applyGizmo3DTransforms(updates: readonly Gizmo3DNodeUpdate[]): void {
  if (updates.length === 0) return;
  const autoKeyframe = usePreferenceStore.getState().timelineAutoKeyframe;
  const rawTime = useProjectStore.getState().tabs[useProjectStore.getState().activeTabId ?? '']?.time ?? 0;

  const keyed: Array<{ nodeId: ID; prop: string; lt: number; value: number }> = [];
  let changed = false;

  for (const u of updates) {
    const node = defaultSceneGraph.getNode(u.id as ID);
    if (!node || node.locked) continue;
    const transComp = node.components.find((c) => c.type === 'Transform');
    if (!transComp) continue;
    const lt = getRemappedTime(node.id, rawTime);
    for (const [prop, value] of Object.entries(u.values)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      if (autoKeyframe || hasAnyTrack(node.id, GIZMO_TRACK_GROUPS[prop as keyof Transform3DValues] ?? [prop])) {
        keyed.push({ nodeId: node.id, prop, lt, value });
      }
      defaultSceneGraph.writeProp(node.id, transComp.id, prop, value);
      changed = true;
    }
  }

  if (keyed.length > 0) {
    gestureAnimEdit(
      'Keyframe 3D Transform',
      () => {
        for (const k of keyed) defaultAnimation.setKeyframe(k.nodeId, k.prop, k.lt, k.value);
      },
      // Stable for the whole drag (playhead can't move mid-drag) → ONE undo
      // entry per gizmo drag, matching the canvas drag pattern above.
      `gizmo3d:${rawTime}:${updates.map((u) => u.id).join(',')}`,
    );
  }

  if (changed) gestureSceneBump();
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
  if (view === 'active' || isCustomViewId(view)) return null;
  const { right, down } = Project3D.orthoDragBasis(view as Project3D.OrthoView);
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

function moveNodes(payload: MoveNodesPayload, viewOf?: () => Camera3dMode): void {
  const autoKeyframe = usePreferenceStore.getState().timelineAutoKeyframe;
  const rawTime = useProjectStore.getState().tabs[useProjectStore.getState().activeTabId ?? '']?.time ?? 0;
  const view = viewOf?.() ?? useGuidesStore.getState().camera3dMode;
  const orthoSpatial = orthoDelta3D(payload.delta, view);
  const toKey: SceneNode[] = [];
  const toWrite: SceneNode[] = [];
  for (const id of payload.ids) {
    const node = defaultSceneGraph.getNode(id as ID);
    if (!node || node.locked) continue;
    // A layer being MOTION SKETCHED always keyframes, whatever the
    // Auto-Keyframe preference says and whether or not it already has a track.
    // Recording a path is an explicit request for keyframes — the same intent
    // as a lit stopwatch — and without this the commonest case does nothing at
    // all: a fresh layer has no x/y track, so with Auto-Keyframe off it takes
    // the static-write branch, the recorder is never fed, and the take comes
    // back empty with no error. Found by driving the real command in the app;
    // no unit test on the reduction could have seen it (rule 5·0).
    if (autoKeyframe || hasAnyTrack(node.id, ['x', 'y']) || motionSketchNodeId() === node.id) {
      toKey.push(node);
    } else toWrite.push(node);
  }

  const comp = useProjectStore.getState().comps[
    useProjectStore.getState().tabs[useProjectStore.getState().activeTabId ?? '']?.compositionId ?? 'comp_root'
  ];
  const compW = comp?.width ?? 1920;
  const compH = comp?.height ?? 1080;
  // Resolved once: every node in one drag shares the view, and resolving the
  // camera walks the scene.
  const viewCamera = orthoSpatial ? null : currentViewCamera(compW, compH, rawTime, view);

  /**
   * This drag as a WORLD translation for `node`, or null when the node is 2D
   * (which keeps the plain projected delta — a 2D layer has no depth to move in
   * and its position is camera-independent by definition).
   */
  const spatialFor = (node: SceneNode): { x: number; y: number; z: number } | null => {
    if (!is3DEnabled(node)) return null;
    if (orthoSpatial) return orthoSpatial;
    if (!viewCamera) return null;
    const g = readGeometry(node);
    const n3 = readNode3D(node);
    return perspectiveDelta3D(payload.delta, viewCamera, { x: g?.x ?? 0, y: g?.y ?? 0, z: n3.z ?? 0 });
  };

  /** Depth component of this drag for a 3D layer, or null when it has none. */
  const depthDeltaFor = (node: SceneNode): number | null => {
    const s = spatialFor(node);
    if (!s) return null;
    return Math.abs(s.z) > 1e-9 ? s.z : null;
  };
  /** The in-plane (x/y) part, which is what the existing writes consume. */
  const planarDelta = (node: SceneNode): { x: number; y: number } => {
    const s = spatialFor(node);
    return s ? { x: s.x, y: s.y } : payload.delta;
  };

  let changed = false;
  if (toKey.length > 0) {
    gestureAnimEdit(
      'Keyframe Position',
      () => {
        for (const node of toKey) {
          const g = readGeometry(node);
          if (!g) continue;
          let delta = planarDelta(node);
          const dz = depthDeltaFor(node);
          if (node.parent) {
            const pw = worldMatrixOf(node.parent as string, getLocalTransformForPorts, getParentIdForPorts);
            const inv = Matrix.invert(pw);
            delta = {
              x: inv.a * delta.x + inv.c * delta.y,
              y: inv.b * delta.x + inv.d * delta.y,
            };
          }
          const lt = getRemappedTime(node.id, rawTime);
          const curX = defaultAnimation.sample(node.id, 'x', lt) ?? g.x;
          const curY = defaultAnimation.sample(node.id, 'y', lt) ?? g.y;
          defaultAnimation.setKeyframe(node.id, 'x', lt, curX + delta.x);
          defaultAnimation.setKeyframe(node.id, 'y', lt, curY + delta.y);
          const cx = cidOf(node, 'x');
          const cy = cidOf(node, 'y');
          defaultSceneGraph.writeProp(node.id, cx, 'x', curX + delta.x);
          defaultSceneGraph.writeProp(node.id, cy, 'y', curY + delta.y);
          // Motion Sketch records HERE and nowhere else, because this is the
          // one place a viewport drag has already become the layer's OWN x/y —
          // through the parent's inverse world matrix above, on the keyframe
          // axis via `getRemappedTime`. A recorder sampling the pointer itself
          // would need a second copy of both conversions and would be wrong
          // under a moving parent in exactly the way F23 was. No-ops unless a
          // recording is armed for this node.
          recordMotionSketchSample(node.id, curX + delta.x, curY + delta.y, lt);
          // Depth is NOT run through the parent inverse above: that is a 2×3
          // affine with no z, so it cannot express the depth axis. A 3D parent
          // chain's own depth handling lives in nodeMatrix.parentWorld3d.
          if (dz !== null) {
            const curZ = defaultAnimation.sample(node.id, 'z', lt) ?? (readNode3D(node).z ?? 0);
            defaultAnimation.setKeyframe(node.id, 'z', lt, curZ + dz);
            defaultSceneGraph.writeProp(node.id, cidOf(node, 'z'), 'z', curZ + dz);
          }
          changed = true;
        }
      },
      `drag:move:${rawTime}:${toKey.map((n) => n.id).join(',')}`,
    );
  }

  for (const node of toWrite) {
    const g = readGeometry(node);
    if (!g) continue;
    let delta = planarDelta(node);
    const dz = depthDeltaFor(node);
    if (node.parent) {
      const pw = worldMatrixOf(node.parent as string, getLocalTransformForPorts, getParentIdForPorts);
      const inv = Matrix.invert(pw);
      delta = {
        x: inv.a * delta.x + inv.c * delta.y,
        y: inv.b * delta.x + inv.d * delta.y,
      };
    }
    const cidX = cidOf(node, 'x');
    const cidY = cidOf(node, 'y');
    defaultSceneGraph.writeProp(node.id, cidX, 'x', g.x + delta.x);
    defaultSceneGraph.writeProp(node.id, cidY, 'y', g.y + delta.y);
    if (dz !== null) {
      const curZ = readNode3D(node).z ?? 0;
      defaultSceneGraph.writeProp(node.id, cidOf(node, 'z'), 'z', curZ + dz);
    }
    changed = true;
  }
  if (changed) gestureSceneBump();
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

    const parentWorldMat = worldMatrixOf(parentId, getLocalTransformForPorts, getParentIdForPorts);
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
    
    addMaskPath(parentId, newMask);
    useSelectionStore.getState().set([parentId]);
    bumpScene();
    return;
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

  const node = makeNodeAt(kind, payload.kind, outX, outY, ellipse, outPoints, outW, outH);
  const rootId = activeCompRootId() as ID;
  defaultSceneGraph.addChild(rootId, node);
  // The same default every MENU and LIBRARY insert applies. This path — every
  // layer the user DRAWS — was the one place that did not, so a pen path went
  // soft past 400% while the identical shape from the Layer menu stayed sharp.
  // Must follow `addChild`: the helper reads the node back out of the graph.
  enableContinuousRasterByDefault(node.id as string);

  useSelectionStore.getState().set([node.id]);
  bumpScene();
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
      // (Reflowing a paragraph box is a `boxWidth` edit, which no resize path
      // performs today.)
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
  const nextW = payload.size ? Math.max(1, Math.abs(payload.size.x)) : baseW;
  const nextH = payload.size ? Math.max(1, Math.abs(payload.size.y)) : baseH;
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
  
  const autoKeyframe = usePreferenceStore.getState().timelineAutoKeyframe;
  const rawTime = useProjectStore.getState().tabs[useProjectStore.getState().activeTabId ?? '']?.time ?? 0;
  // Layer-local sampling time — see moveNodes for why toLayerTime must NOT be
  // applied on top (it double-subtracts the clip start).
  const lt = getRemappedTime(node.id, rawTime);

  // World → parent space. `centre` and `scaleX/scaleY` are what the TOOL
  // measured on screen; `x`/`y`/`scaleX`/`scaleY` are stored relative to the
  // parent. Identity for an unparented layer, so nothing changes there.
  const ps = parentSpaceOf(node.id, rawTime);
  const localCentre = Matrix.transformPoint(ps.inv, centre);
  const localScaleX = scaleX / ps.scaleX;
  const localScaleY = scaleY / ps.scaleY;

  // Per-property stopwatch contract (see hasAnyTrack): position and scale
  // decide independently, so scaling an animated-scale layer keyframes scale
  // while its un-animated position stays a static write.
  const keyPos = autoKeyframe || hasAnyTrack(node.id, ['x', 'y']);
  // Whichever property the gesture is actually writing is the one that gets a
  // keyframe — keyframing Scale on a Size drag would record a value the drag
  // never changed, and leave the real change un-keyframed.
  const keySize = sizing && (autoKeyframe || hasAnyTrack(node.id, ['width', 'height']));
  const keyScale = !sizing && (autoKeyframe || hasAnyTrack(node.id, ['scaleX', 'scaleY', 'scale']));

  if (keyPos || keyScale || keySize) {
    gestureAnimEdit(
      'Keyframe Resize',
      () => {
        if (keyPos) {
          defaultAnimation.setKeyframe(node.id, 'x', lt, localCentre.x);
          defaultAnimation.setKeyframe(node.id, 'y', lt, localCentre.y);
        }
        if (keyScale) {
          defaultAnimation.setKeyframe(node.id, 'scaleX', lt, localScaleX);
          defaultAnimation.setKeyframe(node.id, 'scaleY', lt, localScaleY);
        }
        if (keySize) {
          defaultAnimation.setKeyframe(node.id, 'width', lt, nextW);
          defaultAnimation.setKeyframe(node.id, 'height', lt, nextH);
        }
      },
      `drag:resize:${rawTime}:${node.id}`,
    );
  }

  // Static base always follows the manipulation (harmless when animated —
  // animated reads win — and it keeps every consumer in agreement).
  defaultSceneGraph.writeProp(node.id, cid, 'x', localCentre.x);
  defaultSceneGraph.writeProp(node.id, cid, 'y', localCentre.y);
  if (sizing) {
    // Scale is deliberately left ALONE. The drag expressed itself entirely in
    // width/height, and writing the (unchanged) scale back would push the
    // WORLD scale the tool measured onto a node whose own scale is a different
    // number the moment it has a parent.
    const sizeCid = transComp?.id ?? cid;
    defaultSceneGraph.writeProp(node.id, sizeCid, 'width', nextW);
    defaultSceneGraph.writeProp(node.id, sizeCid, 'height', nextH);
  } else {
    defaultSceneGraph.writeProp(node.id, cid, 'scaleX', localScaleX);
    defaultSceneGraph.writeProp(node.id, cid, 'scaleY', localScaleY);
  }
  gestureSceneBump();
}

function rotateNode(payload: RotateNodePayload): void {
  const node = defaultSceneGraph.getNode(payload.id as ID);
  if (!node || node.locked) return;
  const cid = transformComponentId(node);
  if (!cid) return;

  const autoKeyframe = usePreferenceStore.getState().timelineAutoKeyframe;
  const rawTime = useProjectStore.getState().tabs[useProjectStore.getState().activeTabId ?? '']?.time ?? 0;
  // The tool's angle is ABSOLUTE and in WORLD space (it starts from
  // `node.worldMatrix`); `rotation` is stored relative to the parent. Subtract
  // the parent's world rotation — zero, and so a no-op, without a parent.
  const deg = (payload.rotation * 180) / Math.PI - parentSpaceOf(node.id, rawTime).rotationDeg;

  if (autoKeyframe || hasAnyTrack(node.id, ['rotation'])) {
    gestureAnimEdit(
      'Keyframe Rotate',
      () => {
        // Layer-local time — no toLayerTime on top (see moveNodes).
        defaultAnimation.setKeyframe(node.id, 'rotation', getRemappedTime(node.id, rawTime), deg);
      },
      `drag:rotate:${rawTime}:${node.id}`,
    );
  }

  defaultSceneGraph.writeProp(node.id, cid, 'rotation', deg);
  gestureSceneBump();
}

function moveAnchor(payload: MoveAnchorPayload): void {
  const node = defaultSceneGraph.getNode(payload.id as ID);
  if (!node || node.locked) return;
  // moveAnchorCompensated re-pivots and shifts x/y so the layer stays put.
  moveAnchorCompensated(node.id, payload.anchor.x, payload.anchor.y);
}

function deleteNodes(payload: DeleteNodesPayload): void {
  if (payload.ids.length === 0) return;
  for (const id of payload.ids) defaultSceneGraph.removeNode(id as ID);
  const remaining = useSelectionStore.getState().ids.filter((id) => !payload.ids.includes(id));
  useSelectionStore.getState().set(remaining);
  bumpScene();
}

function updateNodePath(payload: UpdateNodePathPayload): void {
  const node = defaultSceneGraph.getNode(payload.id as ID);
  if (!node || node.locked) return;
  const geomComponent = node.components.find((c) => c.type === 'Geometry');
  if (geomComponent) {
    defaultSceneGraph.writeProp(node.id, geomComponent.id, 'points', payload.points);
    gestureSceneBump();
  }
}

/**
 * Reshape one of a layer's masks (the Direct Selection drag on canvas).
 *
 * Routes through `setMaskPoints` with the playhead, so reshaping an ANIMATED
 * mask writes a keyframe at the current time instead of the static shape that
 * nothing renders.
 */
function updateMaskPathCmd(payload: UpdateMaskPathPayload): void {
  const node = defaultSceneGraph.getNode(payload.id as ID);
  if (!node || node.locked) return;
  // Comp time — the same base `keyframeMask` uses from the Effects panel, so
  // canvas edits and the panel's keyframe button land on the same keyframes.
  setMaskPoints(payload.id as string, payload.maskId, payload.points as MaskPoint[], getTimelineController().currentSeconds);
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
  const shapeType = node.components.find((c) => c.type === 'Transform')?.props.shapeType;
  if (typeof shapeType === 'string' && shapeType !== 'rect' && shapeType !== 'rectangle' && shapeType !== 'ellipse') {
    return null;
  }
  const outline = shapeOutline(primitive, g.width, g.height, 48);
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
