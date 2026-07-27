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
  Mat,
  Rect,
} from '@motion/workspace';
import { readNodeAnchor, moveAnchorCompensated } from '@core/scene/anchor';
import { SIZE } from '@core/rendering/buildSnapshot';
import { readNodeKind as kindOf } from '@core/scene/sceneDerive';

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { activeCompRootId } from '@core/scene/activeComp';
import { readNodeKind } from '@core/scene/sceneDerive';
import { SCENE_KIND_PROP, type SceneKind } from '@core/scene/seedDefaultScene';
import { flattenComposition } from '@core/scene/sceneDerive';
import type { SceneNode, ID } from '@core/types';
import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import { getEventBus } from '@core/events/EventBus';
import { readGeometry, localBounds, makeHitTestLocal, isDrawableKind as drawable } from './geometry';
import { usePreferenceStore } from '@stores/preferenceStore';
import { defaultAnimation } from '@motion/animation';
import { drawToolOptions } from '@motion/workspace';
import { runAnimEdit } from '@core/animation/animationCommands';
import { useProjectStore } from '@stores/projectStore';
import { getRemappedTime, getTimelineController } from '@core/timeline/TimelineController';
import { is3DEnabled, readNode3D } from '@core/scene/threeD';
import { Matrix4Math } from '@motion/scene';
import { currentViewProjector } from '@core/workspace/viewProjection';
import { composeNodeWorld3d } from '@core/scene/nodeMatrix';
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
 * repeated per sibling, so one imported 158-shape icon cost getNodes() O(N²)
 * (measured 3.4 s of a 3.8 s import, re-run on every scene bump). One shared
 * map turns the pass back into O(N).
 */
function toWorkspaceNode(
  node: SceneNode,
  zIndex: number,
  wmCache: Map<string, import('@motion/scene').Matrix2D> = new Map(),
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
  const g = readGeometry(node, evalMap);
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
  const project = currentViewProjector(width, height, rawTime);

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
    const M = composeNodeWorld3d({
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
        const m = worldMatrixVal;
        // `hitTestLocal` is handed inverse(worldMatrix)·worldPoint, so re-applying
        // worldMatrix recovers the screen point the hull is expressed in.
        hitTestLocalVal = (p) =>
          pointInPolygon({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }, hull);
      }
    }
  }

  let visibleVal = node.visible !== false;
  const controller = getTimelineController();
  const nodeClips = controller.getLayersForNode(node.id);
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
    worldMatrix: worldMatrixVal,
    localBounds: localBoundsVal,
    visible: visibleVal,
    locked: !!node.locked,
    zIndex,
    // Lets the selection layer hide the 2D scale/rotate handles for a 3D layer —
    // the 3D gizmo owns that transform (see WorkspaceNode.is3D).
    is3D: is3D && kind !== 'camera' && kind !== 'light',
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

export function createSceneGraphPort(): SceneGraphPort {
  return {
    getNodes(): Iterable<WorkspaceNode> {
      const out: WorkspaceNode[] = [];
      const flat = canvasNodes();
      // One ancestor-matrix cache for the whole pass — see toWorkspaceNode.
      const wmCache = new Map<string, import('@motion/scene').Matrix2D>();
      flat.forEach((node, i) => {
        const wn = toWorkspaceNode(node, i, wmCache);
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
      return toWorkspaceNode(node, idx < 0 ? 0 : idx) ?? undefined;
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
      return () => {
        unsubScene();
        unsubTime();
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
import { Matrix } from '@motion/scene';

function getLocalTransformForPorts(id: string) {
  const node = defaultSceneGraph.getNode(id as ID);
  if (!node) return null;
  const g = readGeometry(node);
  if (!g) return null;
  return { x: g.x, y: g.y, rotation: g.rotationDeg, scaleX: g.scaleX, scaleY: g.scaleY };
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
  };
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
    runAnimEdit(
      'Keyframe 3D Transform',
      () => {
        for (const k of keyed) defaultAnimation.setKeyframe(k.nodeId, k.prop, k.lt, k.value);
      },
      // Stable for the whole drag (playhead can't move mid-drag) → ONE undo
      // entry per gizmo drag, matching the canvas drag pattern above.
      `gizmo3d:${rawTime}:${updates.map((u) => u.id).join(',')}`,
    );
  }

  if (changed) bumpScene();
}

function moveNodes(payload: MoveNodesPayload): void {
  const autoKeyframe = usePreferenceStore.getState().timelineAutoKeyframe;
  const rawTime = useProjectStore.getState().tabs[useProjectStore.getState().activeTabId ?? '']?.time ?? 0;
  const toKey: SceneNode[] = [];
  const toWrite: SceneNode[] = [];
  for (const id of payload.ids) {
    const node = defaultSceneGraph.getNode(id as ID);
    if (!node || node.locked) continue;
    if (autoKeyframe || hasAnyTrack(node.id, ['x', 'y'])) toKey.push(node);
    else toWrite.push(node);
  }

  let changed = false;
  if (toKey.length > 0) {
    runAnimEdit(
      'Keyframe Position',
      () => {
        for (const node of toKey) {
          const g = readGeometry(node);
          if (!g) continue;
          let delta = payload.delta;
          if (node.parent) {
            const pw = worldMatrixOf(node.parent as string, getLocalTransformForPorts, getParentIdForPorts);
            const inv = Matrix.invert(pw);
            delta = {
              x: inv.a * payload.delta.x + inv.c * payload.delta.y,
              y: inv.b * payload.delta.x + inv.d * payload.delta.y,
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
          changed = true;
        }
      },
      `drag:move:${rawTime}:${toKey.map((n) => n.id).join(',')}`,
    );
  }

  for (const node of toWrite) {
    const g = readGeometry(node);
    if (!g) continue;
    let delta = payload.delta;
    if (node.parent) {
      const pw = worldMatrixOf(node.parent as string, getLocalTransformForPorts, getParentIdForPorts);
      const inv = Matrix.invert(pw);
      delta = {
        x: inv.a * payload.delta.x + inv.c * payload.delta.y,
        y: inv.b * payload.delta.x + inv.d * payload.delta.y,
      };
    }
    const cidX = cidOf(node, 'x');
    const cidY = cidOf(node, 'y');
    defaultSceneGraph.writeProp(node.id, cidX, 'x', g.x + delta.x);
    defaultSceneGraph.writeProp(node.id, cidY, 'y', g.y + delta.y);
    changed = true;
  }
  if (changed) bumpScene();
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
  
  let baseW = (SIZE as Record<string, { w: number; h: number }>)[kind]?.w ?? 100;
  let baseH = (SIZE as Record<string, { w: number; h: number }>)[kind]?.h ?? 100;
  const transComp = node.components.find((c) => c.type === 'Transform');
  if (transComp && transComp.props) {
    if (typeof transComp.props.width === 'number') baseW = transComp.props.width;
    if (typeof transComp.props.height === 'number') baseH = transComp.props.height;
  }
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

  // Per-property stopwatch contract (see hasAnyTrack): position and scale
  // decide independently, so scaling an animated-scale layer keyframes scale
  // while its un-animated position stays a static write.
  const keyPos = autoKeyframe || hasAnyTrack(node.id, ['x', 'y']);
  const keyScale = autoKeyframe || hasAnyTrack(node.id, ['scaleX', 'scaleY', 'scale']);

  if (keyPos || keyScale) {
    runAnimEdit(
      'Keyframe Resize',
      () => {
        if (keyPos) {
          defaultAnimation.setKeyframe(node.id, 'x', lt, centre.x);
          defaultAnimation.setKeyframe(node.id, 'y', lt, centre.y);
        }
        if (keyScale) {
          defaultAnimation.setKeyframe(node.id, 'scaleX', lt, scaleX);
          defaultAnimation.setKeyframe(node.id, 'scaleY', lt, scaleY);
        }
      },
      `drag:resize:${rawTime}:${node.id}`,
    );
  }

  // Static base always follows the manipulation (harmless when animated —
  // animated reads win — and it keeps every consumer in agreement).
  defaultSceneGraph.writeProp(node.id, cid, 'x', centre.x);
  defaultSceneGraph.writeProp(node.id, cid, 'y', centre.y);
  defaultSceneGraph.writeProp(node.id, cid, 'scaleX', scaleX);
  defaultSceneGraph.writeProp(node.id, cid, 'scaleY', scaleY);
  bumpScene();
}

function rotateNode(payload: RotateNodePayload): void {
  const node = defaultSceneGraph.getNode(payload.id as ID);
  if (!node || node.locked) return;
  const cid = transformComponentId(node);
  if (!cid) return;

  const autoKeyframe = usePreferenceStore.getState().timelineAutoKeyframe;
  const rawTime = useProjectStore.getState().tabs[useProjectStore.getState().activeTabId ?? '']?.time ?? 0;
  const deg = (payload.rotation * 180) / Math.PI;

  if (autoKeyframe || hasAnyTrack(node.id, ['rotation'])) {
    runAnimEdit(
      'Keyframe Rotate',
      () => {
        // Layer-local time — no toLayerTime on top (see moveNodes).
        defaultAnimation.setKeyframe(node.id, 'rotation', getRemappedTime(node.id, rawTime), deg);
      },
      `drag:rotate:${rawTime}:${node.id}`,
    );
  }

  defaultSceneGraph.writeProp(node.id, cid, 'rotation', deg);
  bumpScene();
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
    bumpScene();
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
  bumpScene();
}

export function createCommandPort(): CommandPort {
  return {
    execute(command: WorkspaceCommand): void {
      switch (command.type) {
        case WorkspaceCommandType.MoveNodes:
          moveNodes(command.payload as MoveNodesPayload);
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
        default:
          break;
      }
    },
  };
}

export { drawable as isDrawableKind, readNodeKind };
