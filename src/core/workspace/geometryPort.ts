/**
 * The geometry-backed SceneGraphPort (docs/B4_MIRROR.md "geometry-backed
 * SceneGraphPort", docs/TS_ENGINE_REMOVAL.md block 3): what the viewport's
 * WorkspaceController hit-tests, selects, snaps and drags against, built from
 * the engine's own answers instead of the page replica.
 *
 *   the overlay geometry PUSH   each canvas layer's world matrix (a 3D layer's
 *                               4×4, else the 2D chain), its drawn LOCAL box and
 *                               that box's 2D-chain corners, a 3D layer's
 *                               extrusion, and the view camera of the mode this
 *                               port projects through — evaluated by the engine
 *                               for the very frame on screen;
 *   the MIRROR                  which layers the active composition has and in
 *                               what order, kinds, switches (visible, locked,
 *                               3D), parents, in/out points, and — for layers
 *                               whose property tree is loaded (the selection's
 *                               are kept loaded) — the anchor, the drawn outline
 *                               and the masks Direct Selection edits.
 *
 * Every port reads the MAIN viewport's records: the matrices and boxes are
 * view-independent, and a secondary pane projects them through its own view
 * camera (the push carries the camera of every subscribed view mode). While
 * any port is subscribed (`onChanged`) the main viewport's subscription names
 * every layer of the active composition — `retainCanvasGeometry`.
 */

import type { SceneGraphPort, WorkspaceNode, NodeId, BezierPoint } from '@motion/workspace';
import { Mat, Rect, OBox } from '@motion/workspace';
import { Matrix4Math, type Matrix4 } from '@motion/scene';
import { flicksToSeconds, secondsToFlicks, type LayerInfo, type Value } from '@motion/engine-api';
import { documentMirror } from '@stores/documentMirror';
import {
  MAIN_VIEWPORT,
  overlayLayer,
  overlayView,
  requestOverlayLayers,
  subscribeOverlayGeometry,
  type OverlayLayer,
} from '@stores/overlayGeometry';
import { useGuidesStore, type Camera3dMode } from '@stores/guidesStore';
import { useProjectStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { subscribeTime } from '@stores/playbackClockStore';
import { flattenCompLayers } from '@core/mirror/compLayers';
import { uiKindOf } from '@core/mirror/layerKinds';
import { mirrorMaskIds } from '@core/mirror/masks';
import { projectorOf, viewCameraOf } from '@core/mirror/viewGeometry';
import { activeCompRootId } from '@core/scene/activeComp';
import { isSceneCameraView } from '@core/scene/cameraViewMode';
import { bezierToPoints } from '@core/engine/props';

type WorkspaceMaskPath = NonNullable<WorkspaceNode['maskPaths']>[number];

/** The view a port projects through: its own, else the main viewport's. */
type ViewOf = () => Camera3dMode | undefined;

const mainMode = (): Camera3dMode => useGuidesStore.getState().camera3dMode;

// ── The main viewport's subscription for the canvas ────────────────────────

const OWNER = 'scenePort';
const OWNER_3D = 'scenePort3d';
/** Subscribed view modes → how many ports hold each. */
const heldModes = new Map<string, number>();
let stopWatch: (() => void) | null = null;
let lastKey = '';

/** The composition the canvas shows. */
function activeComp(): string {
  return activeCompRootId();
}

/** Every layer of the active composition, in paint order (back to front) — the canvas the viewport may pick from. */
function canvasLayerIds(): string[] {
  return flattenCompLayers(documentMirror(), activeComp());
}

/** Send the canvas subscription for the held modes (only when the layer set, the comp or the modes changed). */
function syncCanvasRequest(): void {
  const m = documentMirror();
  const modes = [...heldModes.keys()];
  const key = `${activeComp()}\u0000${m.structRevision}\u0000${modes.join('\u0001')}`;
  if (key === lastKey) return;
  lastKey = key;
  if (modes.length === 0) {
    void requestOverlayLayers(MAIN_VIEWPORT, OWNER, [], []);
    void requestOverlayLayers(MAIN_VIEWPORT, OWNER_3D, [], []);
    return;
  }
  const ids = canvasLayerIds();
  void requestOverlayLayers(MAIN_VIEWPORT, OWNER, ids, ['transform', 'bounds'], modes);
  // A 3D layer's extrusion (its hit silhouette) rides its scene3d record.
  const deep = ids.filter((id) => {
    const l = m.layer(id);
    const k = uiKindOf(l);
    return l?.switches.threeD === true && k !== 'camera' && k !== 'light';
  });
  void requestOverlayLayers(MAIN_VIEWPORT, OWNER_3D, deep, ['scene3d']);
}

/** Hold the canvas subscription with `mode`'s view camera; the release withdraws it with the last holder. */
export function retainCanvasGeometry(mode: string): () => void {
  heldModes.set(mode, (heldModes.get(mode) ?? 0) + 1);
  if (!stopWatch) {
    const offMirror = documentMirror().subscribe(['layers', 'comps'], syncCanvasRequest);
    const offTab = useProjectStore.subscribe((s, prev) => {
      if (s.activeTabId !== prev.activeTabId || s.tabs !== prev.tabs) syncCanvasRequest();
    });
    stopWatch = () => {
      offMirror();
      offTab();
    };
  }
  syncCanvasRequest();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (heldModes.get(mode) ?? 1) - 1;
    if (n > 0) heldModes.set(mode, n);
    else heldModes.delete(mode);
    if (heldModes.size === 0) {
      stopWatch?.();
      stopWatch = null;
    }
    syncCanvasRequest();
  };
}

// ── One layer as the workspace sees it ─────────────────────────────────────

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
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

type Mat2D = WorkspaceNode['worldMatrix'];

/**
 * The 2D affine that maps the local box onto its pushed corners (TL, TR, BR,
 * BL through the 2D world chain) — a device's chain, whose `matrix` is its 3D
 * world position instead. Null for a degenerate box.
 */
export function affineFromCorners(box: readonly number[], corners: readonly number[]): Mat2D | null {
  if (box.length !== 4 || corners.length < 8) return null;
  const [l, t, w, h] = box as [number, number, number, number];
  if (!(Math.abs(w) > 1e-9) || !(Math.abs(h) > 1e-9)) return null;
  const a = (corners[2]! - corners[0]!) / w;
  const b = (corners[3]! - corners[1]!) / w;
  const c = (corners[6]! - corners[0]!) / h;
  const d = (corners[7]! - corners[1]!) / h;
  return { a, b, c, d, e: corners[0]! - (a * l + c * t), f: corners[1]! - (b * l + d * t) };
}

/** Frames per second of a composition setting. */
function fpsOf(rate: { num: number; den: number } | undefined): number {
  return rate && rate.den > 0 && rate.num > 0 ? rate.num / rate.den : 30;
}

/**
 * Whether the layer draws at comp time `t` (flicks) by its bar — and, for a
 * member of a group, by the group's (a group's members are gated by it, as the
 * renderer gates them). The frame the playhead is on, clamped to the
 * composition's last frame (the renderer's gate).
 */
function activeAt(layerId: string, t: number): boolean {
  const m = documentMirror();
  let cur: LayerInfo | undefined = m.layer(layerId);
  const settings = cur ? m.comp(cur.comp)?.settings : undefined;
  const fps = fpsOf(settings?.frameRate);
  const frameOf = (flicks: number): number => Math.round(flicksToSeconds(flicks) * fps);
  const lastFrame = settings ? Math.max(0, frameOf(settings.duration) - 1) : Infinity;
  const frame = Math.min(frameOf(t), lastFrame);
  let first = true;
  for (let guard = 0; cur && guard < 64; guard++) {
    if (first || uiKindOf(cur) === 'group') {
      if (frame < frameOf(cur.timing.inPoint) || frame >= frameOf(cur.timing.outPoint)) return false;
    }
    first = false;
    cur = cur.parent ? m.layer(cur.parent) : undefined;
  }
  return true;
}

/** A path Value's points as the workspace's bezier points (absolute handles, editing flags kept). */
function pathPoints(v: Value | undefined): { points: BezierPoint[]; closed: boolean } | undefined {
  if (v?.kind !== 'path' || v.value.vertices.length < 4) return undefined;
  return { points: bezierToPoints(v.value) as BezierPoint[], closed: v.value.closed };
}

/**
 * Carry `broken` / `tension` onto sampled points from the key at or before `t`
 * (flicks): an interpolated outline has lost its vertices' editing state, and
 * it is the same vertex as that key's (topology edits keep every key's count).
 */
function withKeyFlags(
  p: { points: BezierPoint[]; closed: boolean } | undefined,
  keys: ReadonlyArray<{ time: number; value: Value }>,
  t: number,
): { points: BezierPoint[]; closed: boolean } | undefined {
  if (!p || keys.length === 0) return p;
  let key = keys[0]!;
  for (const k of keys) if (k.time <= t) key = k;
  const src = pathPoints(key.value)?.points as Array<{ broken?: boolean; tension?: number }> | undefined;
  if (!src || src.length !== p.points.length) return p;
  return {
    closed: p.closed,
    points: p.points.map((q, i) => {
      const s = src[i]!;
      if (!s.broken && typeof s.tension !== 'number') return q;
      return { ...q, ...(s.broken ? { broken: true } : {}), ...(typeof s.tension === 'number' ? { tension: s.tension } : {}) };
    }),
  };
}

/**
 * What only the layer's property tree knows — the anchor, its drawn outline
 * and its masks at the playhead — for a layer whose tree the mirror already
 * holds (never fetched here: 2,000 layers' trees are not loaded wholesale; the
 * selection's are kept loaded by the subscribed port). An animated value is
 * the mirror's batched value at the playhead.
 */
function treeFacts(id: string, t: number, loaded: ReadonlySet<string>): {
  path?: { points: BezierPoint[]; closed: boolean; rotoBezier: boolean };
  masks?: WorkspaceMaskPath[];
} {
  const m = documentMirror();
  if (!loaded.has(id)) return {};
  const tree = m.tree(id);
  if (!tree) return {};
  const out: ReturnType<typeof treeFacts> = {};
  const at = (path: string): Value | undefined => (tree.nodes.has(path) ? m.valueAt(id, path, t) : undefined);
  if (uiKindOf(m.layer(id)) === 'shape') {
    const p = withKeyFlags(pathPoints(at('layer/path.points')), m.keyframes(id, 'layer/path.points'), t);
    const roto = at('layer/pathRotoBezier');
    if (p) out.path = { ...p, rotoBezier: roto?.kind === 'bool' && roto.value };
  }
  const maskIds = mirrorMaskIds(tree);
  if (maskIds.length > 0) {
    const masks: WorkspaceMaskPath[] = [];
    for (const mid of maskIds) {
      const p = pathPoints(at(`masks/${mid}/path`));
      if (!p) continue;
      const roto = at(`masks/${mid}/rotoBezier`);
      masks.push({ id: mid, points: p.points, closed: p.closed, rotoBezier: roto?.kind === 'bool' && roto.value });
    }
    out.masks = masks;
  }
  return out;
}

interface ViewContext {
  mode: Camera3dMode;
  /** Comp time of the frame, flicks. */
  time: number;
  /** The layers whose trees the mirror holds right now (one lookup per enumeration). */
  loaded: ReadonlySet<string>;
  compWidth: number;
  compHeight: number;
  project: (p: { x: number; y: number; z: number }) => { x: number; y: number };
  /** The camera layer this view looks through ('' = none). */
  lookedThrough: string;
}

function viewContext(viewOf: ViewOf): ViewContext {
  const mode = viewOf() ?? mainMode();
  // The active tab's playhead — the time the tools write at (ports.ts
  // `playheadSeconds`); a C++-drawn viewport's records are its frame's anyway.
  const s = useProjectStore.getState();
  const time = secondsToFlicks(s.tabs[s.activeTabId ?? '']?.time ?? 0);
  const settings = documentMirror().comp(activeComp())?.settings;
  const compWidth = settings?.width ?? 1920;
  const compHeight = settings?.height ?? 1080;
  const view = overlayView(MAIN_VIEWPORT, mode, time);
  const cam = viewCameraOf(mode, view, useGuidesStore.getState().customViews, compWidth, compHeight);
  return {
    mode,
    time,
    loaded: new Set(documentMirror().loadedTreeLayers()),
    compWidth,
    compHeight,
    project: projectorOf(mode, cam, compWidth, compHeight),
    lookedThrough: isSceneCameraView(mode) ? view?.camera ?? '' : '',
  };
}

/** One canvas layer as a WorkspaceNode, or null when the frame carries no box for it (no canvas presence). */
function workspaceNodeOf(id: string, zIndex: number, rec: OverlayLayer | undefined, ctx: ViewContext): WorkspaceNode | null {
  const m = documentMirror();
  const layer = m.layer(id);
  if (!layer || !rec || rec.box.length !== 4) return null;
  const kind = uiKindOf(layer);
  const device = kind === 'camera' || kind === 'light';
  // The camera this view looks THROUGH has no presence in it (AE never draws
  // the active camera in its own view); from any other view it is a device.
  if (kind === 'camera' && ctx.lookedThrough === id) return null;
  const is3D = layer.switches.threeD === true && !device;
  const [bx, by, bw, bh] = rec.box as [number, number, number, number];
  const localBoundsVal = Rect.rect(bx, by, bw, bh);

  // The pivot, in local space: the 2D chain the push carries has no anchor
  // term (content sits at matrix · T(−anchor)); a 3D world matrix has it.
  const anchor = rec.local.length >= 9 ? { x: rec.local[6]!, y: rec.local[7]! } : { x: 0, y: 0 };
  const withAnchor = (w: Mat2D | null): Mat2D | null => (w ? Mat.multiply(w, Mat.translation(-anchor.x, -anchor.y)) : null);
  let worldMatrixVal: Mat2D | null = null;
  let M3D: Matrix4 | null = null;
  if (is3D && rec.matrix.length === 16) {
    // The layer's z = 0 plane through the view: the affine of its projected axes.
    M3D = rec.matrix as unknown as Matrix4;
    const O = ctx.project(Matrix4Math.transformPoint(M3D, { x: 0, y: 0, z: 0 }));
    const X = ctx.project(Matrix4Math.transformPoint(M3D, { x: 1, y: 0, z: 0 }));
    const Y = ctx.project(Matrix4Math.transformPoint(M3D, { x: 0, y: 1, z: 0 }));
    worldMatrixVal = { a: X.x - O.x, b: X.y - O.y, c: Y.x - O.x, d: Y.y - O.y, e: O.x, f: O.y };
  } else if (!device && rec.matrix.length === 16) {
    const mm = rec.matrix;
    worldMatrixVal = withAnchor({ a: mm[0]!, b: mm[1]!, c: mm[4]!, d: mm[5]!, e: mm[12]!, f: mm[13]! });
  } else {
    // A device sits where its 2D chain puts its icon box (its `matrix` is its
    // 3D world position — the device handles' business, not the box's).
    worldMatrixVal = withAnchor(affineFromCorners(rec.box, rec.corners));
  }
  if (!worldMatrixVal) return null;

  let worldBoundsVal = Rect.transform(localBoundsVal, worldMatrixVal);
  let worldCornersVal = OBox.transformCorners(localBoundsVal, worldMatrixVal);
  const rx = bw / 2;
  const ry = bh / 2;
  const ox = bx + rx;
  const oy = by + ry;
  let hitTestLocalVal: (p: { x: number; y: number }) => boolean = layer.shapeType === 'ellipse'
    ? (p) => ((p.x - ox) * (p.x - ox)) / (rx * rx) + ((p.y - oy) * (p.y - oy)) / (ry * ry) <= 1
    : (p) => Math.abs(p.x - ox) <= rx && Math.abs(p.y - oy) <= ry;

  // An extruded 3D body: the whole projected SILHOUETTE is clickable, not only
  // its front cap (the side walls and back cap project outside that quad).
  const depth = rec.scene?.role === 'layer' ? rec.scene.extrusion : 0;
  if (M3D && depth > 0 && bw > 0 && bh > 0) {
    const screen: Array<{ x: number; y: number }> = [];
    for (const cz of [0, depth]) {
      for (const cx of [bx, bx + bw]) {
        for (const cy of [by, by + bh]) {
          const p = ctx.project(Matrix4Math.transformPoint(M3D, { x: cx, y: cy, z: cz }));
          screen.push({ x: p.x, y: p.y });
        }
      }
    }
    const hull = convexHull2D(screen);
    if (hull.length >= 3) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of hull) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      }
      worldBoundsVal = Rect.rect(minX, minY, maxX - minX, maxY - minY);
      // A projected body is not a rectangle: the AABB's corners are the honest box.
      worldCornersVal = Rect.corners(worldBoundsVal) as typeof worldCornersVal;
      const wm = worldMatrixVal;
      hitTestLocalVal = (p) => pointInPolygon({ x: wm.a * p.x + wm.c * p.y + wm.e, y: wm.b * p.x + wm.d * p.y + wm.f }, hull);
    }
  }

  const facts = treeFacts(id, ctx.time, ctx.loaded);
  return {
    id,
    parentId: layer.parent ?? null,
    worldBounds: worldBoundsVal,
    worldCorners: worldCornersVal,
    worldMatrix: worldMatrixVal,
    localBounds: localBoundsVal,
    visible: layer.switches.visible !== false && activeAt(id, ctx.time),
    locked: layer.switches.locked === true,
    zIndex,
    is3D,
    device,
    hitTestLocal: hitTestLocalVal,
    ...(facts.path ? { pathPoints: facts.path.points, pathClosed: facts.path.closed, pathRotoBezier: facts.path.rotoBezier } : {}),
    ...(facts.masks ? { maskPaths: facts.masks } : {}),
    anchor,
  };
}

// ── The port ──────────────────────────────────────────────────────────────

/**
 * @param viewOf Which view this port's nodes are projected through. Omit for
 *   the main viewport, which follows `guidesStore.camera3dMode`. A SECONDARY
 *   pane passes its own view so its hit-testing and selection chrome describe
 *   the pixels IT shows. A getter, so a pane can change its view without
 *   rebuilding its port.
 */
export function createSceneGraphPort(viewOf?: () => Camera3dMode): SceneGraphPort {
  const view: ViewOf = () => viewOf?.();
  /** The mode this port's subscription holds (re-held when a pane switches views). */
  let held: { mode: string; release: () => void } | null = null;
  let subscribers = 0;
  const holdMode = (): void => {
    if (subscribers === 0) return;
    const mode = view() ?? mainMode();
    if (held?.mode === mode) return;
    const prev = held;
    held = { mode, release: retainCanvasGeometry(mode) };
    prev?.release();
  };

  const nodesOf = (ids: readonly string[], index: (id: string, i: number) => number, loadTrees = false): Map<string, WorkspaceNode> => {
    holdMode();
    // Nodes asked for BY ID are the ones a tool is about to edit: their trees
    // are fetched (one layer each, never the whole canvas).
    if (loadTrees) for (const id of ids) documentMirror().tree(id);
    const ctx = viewContext(view);
    const out = new Map<string, WorkspaceNode>();
    ids.forEach((id, i) => {
      const wn = workspaceNodeOf(id, index(id, i), overlayLayer(MAIN_VIEWPORT, id, ctx.time), ctx);
      if (wn) out.set(id, wn);
    });
    return out;
  };

  return {
    getNodes(): Iterable<WorkspaceNode> {
      return nodesOf(canvasLayerIds(), (_id, i) => i).values();
    },
    getNodesById(ids: readonly NodeId[]): Map<NodeId, WorkspaceNode> {
      const order = new Map<string, number>();
      canvasLayerIds().forEach((id, i) => order.set(id, i));
      return nodesOf(ids.filter((id) => order.has(id)), (id) => order.get(id) ?? 0, true);
    },
    getNode(id: NodeId): WorkspaceNode | undefined {
      const idx = canvasLayerIds().indexOf(id);
      if (idx < 0) return undefined;
      return nodesOf([id], () => idx, true).get(id);
    },
    selectionGroup(id: NodeId): readonly NodeId[] | null {
      const m = documentMirror();
      const root = activeComp();
      const start = m.layer(id);
      if (!start) return null;
      // Up to the layer at the top of the ACTIVE composition — through a legacy
      // nested precomp group (its members are the top of their own comp).
      let top = start;
      for (let guard = 0; guard < 256; guard++) {
        const up = top.parent ?? (top.comp !== root ? top.comp : undefined);
        const next = up ? m.layer(up) : undefined;
        if (!next) break;
        top = next;
      }
      // A group already selected: the click reaches the sub-layer itself.
      if (top.id !== start.id && useSelectionStore.getState().ids.includes(top.id)) return [id];
      // Otherwise the whole top-level group moves and resizes as one body.
      if (top.id !== start.id || top.children.length > 0) return [top.id];
      return null;
    },
    onChanged(listener: () => void): () => void {
      subscribers += 1;
      holdMode();
      // Any document change (switches, outlines, masks, the layer set): once per engine batch.
      const offDoc = documentMirror().subscribe(['doc'], () => {
        holdMode();
        listener();
      });
      // A drawn frame's geometry (the C++ engine's push) — the picture moved.
      const offGeo = subscribeOverlayGeometry(MAIN_VIEWPORT, listener);
      // The LIVE clock (an in-process engine computes the records per time), re-bound with the tab.
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
      const offTab = useProjectStore.subscribe((s, prev) => {
        if (s.activeTabId !== prev.activeTabId) {
          bindTime();
          listener();
        }
      });
      // The VIEW is an input to every node (its projection): a view switch or a
      // custom view's orbit re-enumerates. Seeded from the current state so the
      // guides store's other writes (grid, ROI) are not taken for one.
      let lastView: unknown = useGuidesStore.getState().camera3dMode;
      let lastCustom: unknown = useGuidesStore.getState().customViews;
      const offView = useGuidesStore.subscribe((s) => {
        if (s.camera3dMode === lastView && s.customViews === lastCustom) return;
        lastView = s.camera3dMode;
        lastCustom = s.customViews;
        holdMode();
        listener();
      });
      // The selection's property trees stay loaded: their anchors, outlines and
      // masks are what the transform and path tools read.
      let treeHolds = new Map<string, () => void>();
      const holdTrees = (ids: readonly string[]): void => {
        const next = new Map<string, () => void>();
        for (const tid of ids) {
          const hold = treeHolds.get(tid) ?? documentMirror().retainTree(tid);
          next.set(tid, hold);
        }
        for (const [tid, release] of treeHolds) if (!next.has(tid)) release();
        treeHolds = next;
      };
      holdTrees(useSelectionStore.getState().ids);
      const offSel = useSelectionStore.subscribe((s, prev) => {
        if (s.ids !== prev.ids) holdTrees(s.ids);
      });
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        offDoc();
        offGeo();
        offTime?.();
        offTab();
        offView();
        offSel();
        holdTrees([]);
        subscribers -= 1;
        if (subscribers === 0) {
          held?.release();
          held = null;
        }
      };
    },
  };
}
