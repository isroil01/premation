/**
 * Port implementations that bind the framework-independent `@motion/workspace`
 * engine to this app's real systems:
 *   • SceneGraphPort  → the overlay geometry push + the document mirror (geometryPort.ts)
 *   • SelectionPort   → selectionStore (Zustand, the app's selection truth)
 *   • CommandPort     → engine commands (one tool action = one engine gesture / edit)
 *
 * The engine reads/drives through these; it never imports the stores directly.
 * What a write composes from (a layer's transform at the playhead, its parent's
 * space, its outline) is read from the frame's pushed records and the mirror —
 * never from the TypeScript engine's document.
 */

import type {
  SelectionPort,
  CommandPort,
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
  type PathTopologyEdit,
} from '@motion/workspace';
import { cutPathsWithLine, runFromPolygon, type CutSubpath, type CutPoint } from '@core/geometry/pathCut';
import { shapeOutline } from '@core/scene/pathOps';
import { resolveCornerRadii, clampCornerRadii } from '@core/scene/cornerRadii';
import { anchorCompensation } from '@core/scene/anchor';
import { CONTINUOUS_RASTER_PROP, supportsContinuousRaster } from '@core/scene/continuousRaster';

import { activeCompRootId } from '@core/scene/activeComp';
import { uniqueLayerName } from '@core/scene/layerNames';
import { SCENE_KIND_PROP, type SceneKind } from '@core/scene/sceneKind';
import type { SceneNode } from '@core/types';
import { useSelectionStore } from '@stores/selectionStore';
import { useTextEditStore } from '@stores/textEditStore';
import { MIN_BOX_SIZE } from '@core/text/textExtras';
import { useGuidesStore, type Camera3dMode } from '@stores/guidesStore';
import { useViewportDisplayStore } from '@stores/viewportDisplayStore';
import { getEventBus } from '@core/events/EventBus';
import { usePreferenceStore } from '@stores/preferenceStore';
import { drawToolOptions } from '@motion/workspace';
import { newShapeFill, newShapeStroke } from '@core/workspace/shapeToolPaint';
import {
  burstTransaction,
  currentToolTransaction,
  sendToolEdit,
  runToolEdit,
  settleToolEdits,
  type ToolTransaction,
} from '@core/workspace/viewportGesture';
import { reportEngineError } from '@core/engine/uiEdits';
import { FragmentBuilder } from '@/engine-client/fragmentBuilder';
import { pasteBuilt, pastedIds } from '@/engine-client/insertFragment';
import { secondsToFlicks, type Command, type LayerInfo, type PathTopologyOp, type PropRef, type Value } from '@motion/engine-api';
import { compOfLayer, isLayer } from '@core/mirror/docFacts';
import { uiKindOf } from '@core/mirror/layerKinds';
import { readTrack, trackRef } from '@core/mirror/selection';
import { compTime, paths } from '@core/engine/propRefs';
import { maskPointsToPath, trackValueCommands, type NodeTrackValues } from '@core/workspace/toolEdits';
import { outlineOnEngine, outlineRef, SHAPE_PATH } from '@core/workspace/pathEdits';
import { useProjectStore } from '@stores/projectStore';
import { documentMirror } from '@stores/documentMirror';
import { MAIN_VIEWPORT, overlayLayer, type OverlayLayer } from '@stores/overlayGeometry';
import { Project3D } from '@motion/scene';
import { currentViewCamera } from '@core/workspace/viewProjection';
import { orthoViewOf } from '@core/scene/cameraViewMode';
import { rectangleMask, ellipseMask, MaskPath, MaskPoint } from '@core/effects/mask';
import { defaultPolystar, POLYSTAR_FX_PROP, type PolystarType } from '@core/scene/polystar';
import { defaultTextSize } from '@core/scene/textDefaults';
import { affineFromCorners, createSceneGraphPort } from './geometryPort';
import { recordMotionSketchSample, motionSketchNodeId } from '@core/animation/motionSketch';
import { Matrix, type Matrix2D } from '@motion/scene';

// ── SceneGraphPort ────────────────────────────────────────────────
export { createSceneGraphPort };

// ── What a tool write composes from ───────────────────────────────

/** A layer's own transform at the playhead, stored units (OverlayLayerGeometry.local). */
interface LocalTransformAt {
  x: number;
  y: number;
  z: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  anchorX: number;
  anchorY: number;
}

/** The frame's pushed record of a layer (the main viewport's, at the playhead), or undefined. */
function recordOf(id: string): OverlayLayer | undefined {
  return overlayLayer(MAIN_VIEWPORT, id, secondsToFlicks(playheadSeconds()));
}

/**
 * The layer's own transform at the playhead: the pushed record's (the frame
 * on screen — the canvas subscription names every layer of the active comp),
 * else the mirror's values at the playhead (a layer whose tree is loaded).
 */
function localAt(id: string): LocalTransformAt | null {
  const l = recordOf(id)?.local;
  if (l && l.length >= 9) {
    return { x: l[0]!, y: l[1]!, z: l[2]!, rotation: l[3]!, scaleX: l[4]!, scaleY: l[5]!, anchorX: l[6]!, anchorY: l[7]! };
  }
  const m = documentMirror();
  if (!m.tree(id)) return null;
  const s = playheadSeconds();
  const r = (track: string, d: number): number => readTrack(m, id, track, s) ?? d;
  return {
    x: r('x', 0), y: r('y', 0), z: r('z', 0), rotation: r('rotation', 0),
    scaleX: r('scaleX', 1), scaleY: r('scaleY', 1), anchorX: r('anchorX', 0), anchorY: r('anchorY', 0),
  };
}

/**
 * A layer's 2D world chain at the playhead (no anchor term — the space its
 * CHILDREN's x / y live in): the pushed matrix of a 2D layer, else its box
 * corners solved back to the affine (they run through the 2D chain for every
 * layer). Null when the frame carries neither.
 */
function chain2DOf(id: string): Matrix2D | null {
  const rec = recordOf(id);
  if (!rec) return null;
  const layer = documentMirror().layer(id);
  const k = uiKindOf(layer);
  if (layer && !layer.switches.threeD && k !== 'camera' && k !== 'light' && rec.matrix.length === 16) {
    const m = rec.matrix;
    return { a: m[0]!, b: m[1]!, c: m[4]!, d: m[5]!, e: m[12]!, f: m[13]! };
  }
  return affineFromCorners(rec.box, rec.corners);
}

/** The world affine of a layer's PARENT at the playhead — identity at the top of its composition. */
function parentChain2D(id: string): Matrix2D {
  const parent = documentMirror().layer(id)?.parent;
  return (parent ? chain2DOf(parent) : null) ?? Matrix.identity();
}

/** The layer's drawn content space: its 2D chain with the anchor offset (what its outline and masks are in). */
function contentWorld2D(id: string): Matrix2D | null {
  const chain = chain2DOf(id);
  const l = localAt(id);
  if (!chain) return null;
  const ax = l?.anchorX ?? 0;
  const ay = l?.anchorY ?? 0;
  return { ...chain, e: chain.e - (chain.a * ax + chain.c * ay), f: chain.f - (chain.b * ax + chain.d * ay) };
}

/** A layer of a composition, unlocked: its header, else null. */
function unlockedLayer(id: string): LayerInfo | null {
  const layer = documentMirror().layer(id);
  return layer && !layer.switches.locked ? layer : null;
}

/** The layer's drawn box (local x, y, w, h) on the frame, or null when it has no canvas presence. */
function boxOf(id: string): [number, number, number, number] | null {
  const b = recordOf(id)?.box;
  return b && b.length === 4 ? [b[0]!, b[1]!, b[2]!, b[3]!] : null;
}

/** Kinds the viewport can resize / rotate (the drawable kinds; a box on the frame says the same). */
function drawable(id: string): boolean {
  return boxOf(id) !== null;
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
    // A node that is not a composition's layer, or a prop with no API property
    // on it: nothing the engine can write — the handle does nothing rather
    // than write around the engine (cameras and lights, their Point of
    // Interest included, are all addressable).
    console.warn(`[sendNodeValues] ${nodeId}: ${Object.keys(values).join(', ')} not addressable by the engine`);
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

/**
 * The layer's PARENT space, for turning the tool's answers back into the props
 * a layer actually stores. Every transform tool measures in WORLD space; a
 * layer's `rotation`, `x`/`y` and `scaleX`/`scaleY` are PARENT-space values —
 * without this a child of a turned / scaled null was thrown across the comp by
 * a rotate or a resize (identity, and so a no-op, without a parent).
 */
function parentSpaceOf(nodeId: string): {
  inv: Matrix2D; rotationDeg: number; scaleX: number; scaleY: number;
} {
  const m = parentChain2D(nodeId);
  const d = Matrix.decompose(m);
  const nz = (v: number): number => (Math.abs(v) > 1e-9 ? v : 1);
  return {
    inv: Matrix.invert(m),
    rotationDeg: (d.rotation * 180) / Math.PI,
    scaleX: nz(d.scale.x),
    scaleY: nz(d.scale.y),
  };
}

function captureMoveStarts(ids: readonly NodeId[], view: Camera3dMode): MoveStart[] {
  const rawTime = playheadSeconds();
  const { w: compW, h: compH } = activeCompSize();
  const orthoX = orthoDelta3D({ x: 1, y: 0 }, view);
  const orthoY = orthoDelta3D({ x: 0, y: 1 }, view);
  // Resolved once: every node in one drag shares the view.
  const viewCamera = orthoX ? null : currentViewCamera(compW, compH, rawTime, view);
  const out: MoveStart[] = [];
  for (const id of ids) {
    const layer = unlockedLayer(id);
    const l = layer ? localAt(id) : null;
    if (!layer || !l) continue;
    let basis: MoveStart['basis'] = null;
    if (layer.switches.threeD) {
      if (orthoX && orthoY) basis = { dx: orthoX, dy: orthoY };
      else if (viewCamera) {
        // Linear in the delta (the depth scale is sampled at the START
        // position), so the basis is the delta's two unit columns.
        const at = { x: l.x, y: l.y, z: l.z };
        basis = {
          dx: perspectiveDelta3D({ x: 1, y: 0 }, viewCamera, at),
          dy: perspectiveDelta3D({ x: 0, y: 1 }, viewCamera, at),
        };
      }
    }
    let inv: MoveStart['inv'] = null;
    if (layer.parent) {
      const m = Matrix.invert(parentChain2D(id));
      inv = { a: m.a, b: m.b, c: m.c, d: m.d };
    }
    out.push({
      id,
      x: l.x,
      y: l.y,
      z: l.z,
      inv,
      basis,
      // A layer being MOTION SKETCHED always keyframes, whatever the
      // Auto-Keyframe preference says: recording a path is an explicit request
      // for keyframes.
      sketch: motionSketchNodeId() === id,
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
      // Composition time: the engine maps it onto the layer's keyframe axis when the take is written.
      recordMotionSketchSample(s.id, v.x!, v.y!, rawTime);
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
    // A node outside a composition has no masks the API can address.
    if (!isLayer(parentId)) return;

    // The SAME local→world matrix the viewport draws and edits this layer's
    // outlines through (the scene port's node: position · R · S · T(−anchor),
    // the projected plane for a 3D layer) — so a mask lands where it was drawn
    // and Direct Selection then shows its vertices there.
    const parentWorldMat =
      createSceneGraphPort().getNode(parentId)?.worldMatrix ??
      contentWorld2D(parentId) ??
      Matrix.identity();
    const invParentWorldMat = Matrix.invert(parentWorldMat);

    let newMask: MaskPath;
    if (payload.points && payload.points.length > 0) {
      const points: MaskPoint[] = payload.points.map((p) => {
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
    sendToolEdit('New Mask', [{
      type: 'addMask',
      layer: parentId,
      path: (maskPointsToPath(newMask.points, newMask.closed) as Extract<Value, { kind: 'path' }>).value,
      mode: newMask.mode,
      inverted: newMask.inverted === true,
    }]);
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
 * named `label`): the drawn-layer builder below lays them into a fragment
 * and the result goes to the engine as one `pasteLayers` (`pasteBuilt`) —
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
  const b = new FragmentBuilder({ idPrefix: 'drawn' });
  const scratch: string[] = [];
  try {
    for (const payload of payloads) {
      const { node, polystar } = drawnLayerOf(payload);
      b.addChild(comp, node);
      if (polystar) b.setFx(node.id, POLYSTAR_FX_PROP, polystar);
      // The same default every MENU and LIBRARY insert applies. This path —
      // every layer the user DRAWS — was the one place that did not, so a pen
      // path went soft past 400% while the identical shape from the Layer menu
      // stayed sharp.
      if (supportsContinuousRaster(node)) b.setFx(node.id, CONTINUOUS_RASTER_PROP, true);
      scratch.push(node.id);
    }
  } catch (err) {
    reportEngineError(label, { code: 'internal', message: err instanceof Error ? err.message : String(err) });
    return null;
  }
  const built = b.build();
  const ids = await pasteBuilt(label, comp, built, { select: scratch });
  return ids && built ? pastedIds(built, ids, scratch) : ids;
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
  const id = payload.id as string;
  const layer = unlockedLayer(id);
  const box = layer ? boxOf(id) : null;
  if (!layer || !box) return;
  const kind = uiKindOf(layer);
  // The drawn box the tool resized (the frame's — what readGeometry measures).
  const baseW = box[2] > 0 ? box[2] : 100;
  const baseH = box[3] > 0 ? box[3] : 100;
  /*
   * Ctrl on a handle asks for the layer's SIZE rather than its Scale, and the
   * tool says so by sending `size` (the new box in the layer's own units).
   *
   * TEXT is sized by its glyphs, not by a size property (a paragraph box's
   * reflow is the Type tool's box handles — layout/Workspace/textBoxReflow.ts),
   * and a layer whose Size the API cannot address keeps scaling instead —
   * falling back beats swallowing the gesture.
   */
  const sizing = payload.size !== undefined && kind !== 'text';
  const nextW = payload.size ? snapPx(Math.max(1, Math.abs(payload.size.x))) : baseW;
  const nextH = payload.size ? snapPx(Math.max(1, Math.abs(payload.size.y))) : baseH;
  const b = payload.bounds;
  // Prefer the scale the TOOL resolved (absolute against drag-start state, the
  // ratio contract `resizeRotated.test.ts` pins). Inferring it as
  // `worldAABB.width / localWidth` is only right for an unrotated layer — the
  // fallback for older callers.
  const rawCentre = payload.center ?? { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const scaleX = payload.scale ? payload.scale.x : baseW > 0 ? b.width / baseW : 1;
  const scaleY = payload.scale ? payload.scale.y : baseH > 0 ? b.height / baseH : 1;

  // The tool hands back the new box's CENTRE, which for most layers is also the
  // node's position. A box offset from its origin (a group's union, a text
  // layer's font box) is converted back through the same rotation / scale.
  const offX = box[0] + box[2] / 2;
  const offY = box[1] + box[3] / 2;
  const rotationDeg = localAt(id)?.rotation ?? 0;
  const centre = (() => {
    if (offX === 0 && offY === 0) return rawCentre;
    const rad = (rotationDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const ox = offX * scaleX;
    const oy = offY * scaleY;
    return { x: rawCentre.x - (ox * cos - oy * sin), y: rawCentre.y - (ox * sin + oy * cos) };
  })();

  // World → parent space (identity for an unparented layer).
  const ps = parentSpaceOf(id);
  const localCentreRaw = Matrix.transformPoint(ps.inv, centre);
  const localCentre = { x: snapPx(localCentreRaw.x), y: snapPx(localCentreRaw.y) };
  const localScaleX = scaleX / ps.scaleX;
  const localScaleY = scaleY / ps.scaleY;

  // Per-property stopwatch contract: position and scale (or size) decide
  // independently whether they key — `trackValueCommands` asks each.
  const scaleValues = { x: localCentre.x, y: localCentre.y, scaleX: localScaleX, scaleY: localScaleY };
  if (sizing) {
    // Scale is deliberately left ALONE: the drag expressed itself in width /
    // height, and keying Scale on a Size drag would record a value it never changed.
    const sized = sendLayerValues('Resize', [{ nodeId: id, values: { x: localCentre.x, y: localCentre.y, width: nextW, height: nextH } }]);
    if (sized) return;
  }
  sendLayerValues('Scale', [{ nodeId: id, values: scaleValues }]);
}

function rotateNode(payload: RotateNodePayload): void {
  const id = payload.id as string;
  if (!unlockedLayer(id) || !drawable(id)) return;
  // The tool's angle is ABSOLUTE and in WORLD space (it starts from
  // `node.worldMatrix`); `rotation` is stored relative to the parent.
  const deg = (payload.rotation * 180) / Math.PI - parentSpaceOf(id).rotationDeg;
  sendLayerValues('Rotate', [{ nodeId: id, values: { rotation: deg } }]);
}

/**
 * Whether a layer can take its share of a MULTI-selection transform: a drawn
 * one, not a device (the renderer ignores their scale / rotation), not 3D (the
 * gizmo owns those) — the gates the tool applies before it sends.
 */
function multiTransformable(id: string): boolean {
  const layer = unlockedLayer(id);
  const kind = uiKindOf(layer ?? undefined);
  return !!layer && drawable(id) && kind !== 'light' && kind !== 'camera' && !layer.switches.threeD;
}

/**
 * Scale a multi-selection about one fixed world pivot — the group-box handle
 * drag. The TOOL resolved everything absolute; this converts world → parent
 * space. Every node goes in ONE message, so the drag is one undo entry.
 * `item.position` is the ANCHOR's world point, `parentWorld · (x, y)`.
 */
function multiResizeNodes(payload: MultiResizeNodesPayload): void {
  if (payload.items.length === 0) return;
  const items: NodeTrackValues[] = [];
  for (const item of payload.items) {
    const id = item.id as string;
    if (!multiTransformable(id)) continue;
    const ps = parentSpaceOf(id);
    const localPos = Matrix.transformPoint(ps.inv, item.position);
    items.push({
      nodeId: id,
      values: { x: localPos.x, y: localPos.y, scaleX: item.scale.x / ps.scaleX, scaleY: item.scale.y / ps.scaleY },
    });
  }
  sendLayerValues('Scale', items);
}

/** Rotate a multi-selection about the group centre — same shape as `multiResizeNodes`. */
function multiRotateNodes(payload: MultiRotateNodesPayload): void {
  if (payload.items.length === 0) return;
  const items: NodeTrackValues[] = [];
  for (const item of payload.items) {
    const id = item.id as string;
    if (!multiTransformable(id)) continue;
    const ps = parentSpaceOf(id);
    const localPos = Matrix.transformPoint(ps.inv, item.position);
    items.push({
      nodeId: id,
      values: { rotation: (item.rotation * 180) / Math.PI - ps.rotationDeg, x: localPos.x, y: localPos.y },
    });
  }
  sendLayerValues('Rotate', items);
}

/**
 * Pan Behind (AE Y): move the anchor and compensate Position so the layer
 * stays put. The tool sends the new anchor ABSOLUTE (layer-local); the
 * compensation is computed from the DRAG-START anchor, position, rotation and
 * scale at the playhead, so every message is the whole answer.
 */
function moveAnchor(payload: MoveAnchorPayload): void {
  const id = payload.id as string;
  if (!unlockedLayer(id)) return;
  const capture = (): { ax: number; ay: number; x: number; y: number; rot: number; sx: number; sy: number } | null => {
    const l = localAt(id);
    return l ? { ax: l.anchorX, ay: l.anchorY, x: l.x, y: l.y, rot: l.rotation, sx: l.scaleX, sy: l.scaleY } : null;
  };
  const txn = currentToolTransaction();
  const anchor = { ...payload.anchor };
  sendLayerValues('Pan Behind', () => {
    // Captured once per drag, when its first message can go.
    const st = txn ? txn.memo(`anchor:${id}`, capture) : capture();
    if (!st) return [];
    const d = anchorCompensation(anchor.x - st.ax, anchor.y - st.ay, st.rot, st.sx, st.sy);
    return [{ nodeId: id, values: { anchorX: anchor.x, anchorY: anchor.y, x: st.x + d.dx, y: st.y + d.dy } }];
  }, txn);
}

/**
 * Delete / Backspace in the viewport: one `deleteLayers` per composition, ONE
 * entry. Locked layers stay (the context menu's Delete skips them the same
 * way); the rest of the selection is kept.
 */
function deleteNodes(payload: DeleteNodesPayload): void {
  if (payload.ids.length === 0) return;
  const byComp = new Map<string, string[]>();
  for (const id of new Set(payload.ids as readonly string[])) {
    const comp = unlockedLayer(id) ? compOfLayer(id) : null;
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

/** History labels for the structural path edits, as AE names them. */
const TOPOLOGY_LABEL: Record<string, string> = {
  insert: 'Add Vertex',
  delete: 'Delete Vertex',
  deleteMany: 'Delete Vertices',
  firstVertex: 'Set First Vertex',
  reverse: 'Reverse Path Direction',
  extend: 'Continue Path',
};

type PathValue = Extract<Value, { kind: 'path' }>;

/** A tool's replayable topology edit as the API's `editPathTopology` op. */
function topologyOp(t: PathTopologyEdit): PathTopologyOp {
  const base = { segment: 0, u: 0, indices: [] as number[], atStart: false };
  switch (t.op) {
    case 'insert': return { ...base, kind: 'insert', segment: t.segment, u: t.u };
    case 'delete': return { ...base, kind: 'remove', indices: [t.index] };
    case 'deleteMany': return { ...base, kind: 'remove', indices: [...t.indices] };
    case 'firstVertex': return { ...base, kind: 'firstVertex', indices: [t.index] };
    case 'reverse': return { ...base, kind: 'reverse' };
    case 'extend':
      return { ...base, kind: 'extend', atStart: t.atStart, points: (maskPointsToPath(t.points as MaskPoint[], false) as PathValue).value };
    default: return { ...base, kind: 'reverse' };
  }
}

/** One tool edit of an outline, as it reaches the port. */
interface OutlinePayload {
  points: ReadonlyArray<PathPoint>;
  topology?: PathTopologyEdit;
  closed?: boolean;
  rotoBezier?: boolean;
}

/**
 * A tool's edit of one outline — a mask's `masks/<id>/path` or a drawn
 * shape's `layer/path.points` — through the engine, as part of the current
 * tool action (one entry per drag / click):
 *
 *   - STRUCTURAL steps (a vertex added / removed / continued on an ANIMATED
 *     outline, its Closed switch while animated, the RotoBezier switch) are
 *     `editPathTopology` — the engine replays them on EVERY state, so the keys
 *     keep one vertex count and morph — and `setProperty` on the switch. They
 *     go as a KEPT gesture message: the drag's later reshapes build on them,
 *     and latest-wins must not drop them.
 *   - the whole outline at the playhead (absolute): `setProperty {time}` — a
 *     key there on an animated outline (the engine maps the comp time onto the
 *     layer's keyframe axis, where `buildSnapshot` reads it), the static shape
 *     on an unanimated one (whose topology edit IS that shape). A topology edit
 *     of an animated outline keys nothing at the playhead (it changed every
 *     key already).
 */
function sendOutlineEdit(
  label: string,
  prop: PropRef,
  rotoProp: PropRef,
  animated: boolean,
  closedNow: boolean,
  payload: OutlinePayload,
): void {
  const structural: Command[] = [];
  if (payload.rotoBezier !== undefined) structural.push({ type: 'setProperty', prop: rotoProp, value: { kind: 'bool', value: payload.rotoBezier } });
  const closedChange = payload.closed !== undefined && payload.closed !== closedNow ? payload.closed : undefined;
  if (animated && (payload.topology || closedChange !== undefined)) {
    structural.push({
      type: 'editPathTopology', prop,
      ...(payload.topology ? { op: topologyOp(payload.topology) } : {}),
      ...(closedChange !== undefined ? { closed: closedChange } : {}),
    });
  }
  const reshape: Command[] = animated && payload.topology ? [] : [{
    type: 'setProperty', prop,
    value: maskPointsToPath(payload.points as MaskPoint[], payload.closed ?? closedNow),
    time: compTime(playheadSeconds()),
  }];
  const txn = currentToolTransaction();
  if (!txn) {
    // A key press (Delete) or a click outside a drag: one entry.
    void runToolEdit(label, [...structural, ...reshape]);
    return;
  }
  if (structural.length > 0) txn.send(label, structural, { keep: true });
  if (reshape.length > 0) txn.send(label, reshape);
}

/** A path property's state on the mirror: whether it is keyed, and its stored Closed. */
function pathState(id: string, path: string): { animated: boolean; closed: boolean; valueType: string } | null {
  const m = documentMirror();
  const info = m.tree(id)?.nodes.get(path);
  if (!info) return null;
  return {
    animated: info.animated || m.keyframes(id, path).length > 0,
    closed: info.value?.kind === 'path' ? info.value.value.closed : true,
    valueType: info.valueType,
  };
}

/**
 * Direct Selection / Pen edits of a layer's own outline (`layer/path.points`,
 * see `sendOutlineEdit`). A primitive shape with an animated `path.points`
 * track and no drawn outline keys its reshapes through the same property; a
 * structural edit needs the drawn outline.
 */
function updateNodePath(payload: UpdateNodePathPayload): void {
  const id = payload.id as string;
  if (!unlockedLayer(id)) return;
  const st = pathState(id, SHAPE_PATH);
  if (!st) return;
  const label = payload.topology ? TOPOLOGY_LABEL[payload.topology.op] ?? 'Edit Path' : 'Edit Path';
  const rotoProp: PropRef = { layer: id, path: 'layer/pathRotoBezier' };
  if (outlineOnEngine({ nodeId: id, maskId: null })) {
    sendOutlineEdit(label, outlineRef({ nodeId: id, maskId: null }), rotoProp, st.animated, st.closed, payload);
    return;
  }
  if (st.animated && st.valueType === 'path' && !payload.topology && payload.closed === undefined && payload.rotoBezier === undefined) {
    sendOutlineEdit(label, { layer: id, path: SHAPE_PATH }, rotoProp, true, st.closed, payload);
  }
}

/**
 * Reshape / restructure one of a layer's masks (Direct Selection, Pen in mask
 * mode, Convert Vertex) — `masks/<id>/path` through `sendOutlineEdit`.
 */
function updateMaskPathCmd(payload: UpdateMaskPathPayload): void {
  const id = payload.id as string;
  if (!unlockedLayer(id)) return;
  const target = { nodeId: id, maskId: payload.maskId };
  const st = pathState(id, paths.mask(payload.maskId, 'path'));
  if (!st || !outlineOnEngine(target)) return;
  const label = payload.topology ? TOPOLOGY_LABEL[payload.topology.op] ?? 'Edit Mask' : 'Edit Mask';
  sendOutlineEdit(label, outlineRef(target), { layer: id, path: paths.mask(payload.maskId, 'rotoBezier') },
    st.animated, st.closed, payload);
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
 * A shape layer's outline as runs the knife can cut, in LOCAL space — read from
 * the mirror and the frame:
 *   1. its drawn outline (`layer/path.points`, the single-run shape);
 *   2. a PRIMITIVE rectangle / ellipse never converted to a path: its outline
 *      from the drawn box, the corner radii (per-corner over uniform, CSS
 *      clamping, comp-px radii through the layer's scale — the renderer's seed)
 *      and the layer's scale at the playhead. A freshly drawn rectangle has no
 *      stored points at all, and a knife that refused the shape tools' shapes
 *      would be a knife for imported art only.
 *
 * A multi-run outline (an SVG import, a previous cut: `Geometry.subpaths`) has
 * no API property to read its runs from — it is not cut (null) rather than cut
 * as a shape it isn't (docs: block 3 report, "Knife on multi-run shapes").
 */
function readCutRuns(id: string, layer: LayerInfo): CutSubpath[] | null {
  const m = documentMirror();
  const v = m.tree(id)?.nodes.get(SHAPE_PATH)?.value;
  if (v?.kind === 'path' && v.value.vertices.length >= 4) {
    const b = v.value;
    const pts: CutPoint[] = [];
    for (let i = 0; i < b.vertices.length / 2; i++) {
      const x = b.vertices[2 * i]!;
      const y = b.vertices[2 * i + 1]!;
      pts.push(toCutPoint({
        x, y,
        inX: x + (b.inTangents[2 * i] ?? 0), inY: y + (b.inTangents[2 * i + 1] ?? 0),
        outX: x + (b.outTangents[2 * i] ?? 0), outY: y + (b.outTangents[2 * i + 1] ?? 0),
      }));
    }
    return [{ points: pts, open: !b.closed }];
  }
  // Only the two primitives whose outline `shapeOutline` actually knows: a
  // polygon or a star would come back as a rectangle.
  const shapeType = layer.shapeType;
  if (shapeType !== 'rect' && shapeType !== 'rectangle' && shapeType !== 'ellipse') return null;
  const box = boxOf(id);
  const l = localAt(id);
  if (!box || box[2] <= 0 || box[3] <= 0) return null;
  const s = playheadSeconds();
  const corner = (track: string): number | undefined => {
    // A radius the layer does not STORE is absent (the API reports every
    // property with its default filled in): per-corner over uniform only
    // where a corner was set.
    const info = trackRef(m, id, track)?.info;
    if (!info || (!info.stored && !info.animated)) return undefined;
    const n = readTrack(m, id, track, s);
    return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, n) : undefined;
  };
  const radii = clampCornerRadii(box[2], box[3], resolveCornerRadii({
    cornerRadius: corner('cornerRadius'),
    cornerRadiusTL: corner('cornerRadiusTL'),
    cornerRadiusTR: corner('cornerRadiusTR'),
    cornerRadiusBR: corner('cornerRadiusBR'),
    cornerRadiusBL: corner('cornerRadiusBL'),
  }));
  const outline = shapeOutline(
    shapeType === 'ellipse' ? 'ellipse' : 'rect', box[2], box[3], 48, 0,
    radii, [Math.abs(l?.scaleX ?? 1), Math.abs(l?.scaleY ?? 1)],
  );
  return outline.length >= 3 ? [runFromPolygon(outline)] : null;
}

/**
 * Knife — split each targeted layer's outline along a world-space line, ONE
 * history entry for the whole gesture. The halves stay on the SAME layer, as
 * sibling runs: one `setShapeOutline` per cut layer.
 */
function cutPaths(payload: CutPathsPayload): void {
  const m = documentMirror();
  const cmds: Command[] = [];

  for (const rawId of payload.ids) {
    const id = rawId as string;
    const layer = unlockedLayer(id);
    if (!layer || uiKindOf(layer) !== 'shape') continue;
    // An animated outline wins over stored geometry every frame (the engine
    // refuses a cut of it): doing nothing beats writing what never renders.
    if (m.keyframes(id, SHAPE_PATH).length > 0) continue;

    const runs = readCutRuns(id, layer);
    if (!runs) continue;

    // The drag is measured in WORLD space; stored points are local. One
    // inverse per layer (its drawn content space: the chain with the anchor).
    const world = contentWorld2D(id);
    if (!world) continue;
    const inv = Matrix.invert(world);
    const a = Matrix.transformPoint(inv, payload.a);
    const b = Matrix.transformPoint(inv, payload.b);

    const cut = cutPathsWithLine(runs, a, b);
    // Identity: a line that crossed nothing costs no write and no undo entry.
    if (cut === runs) continue;

    cmds.push({
      type: 'setShapeOutline',
      layer: id,
      runs: cut.map((r) => (maskPointsToPath(r.points as MaskPoint[], !r.open) as PathValue).value),
    });
  }

  if (cmds.length === 0) return;
  sendToolEdit(cmds.length > 1 ? `Knife (${cmds.length} layers)` : 'Knife', cmds);
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
