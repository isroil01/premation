/**
 * Merge Paths — boolean operations (union / subtract / intersect / exclude)
 * across SHAPE LAYERS.
 *
 * Two modes:
 *  1. **Bake** (`mergeSelectedPaths`) — destructive: sources are removed and
 *     the result is a static polygonal Geometry. Kept for one-shot cleanup and
 *     tests that pin the bake contract.
 *  2. **Live** (`liveMergeSelectedPaths`) — AE Shape-Group style: sources stay
 *     in the scene (hidden as operands), a result layer stores `booleanOp` +
 *     `booleanSources`, and buildSnapshot re-evaluates the boolean every frame
 *     so animated transforms / path.points on the sources drive the merge.
 *
 * Geometry engine: `polygon-clipping` (Martinez–Rueda). Curved outlines are
 * flattened before the boolean (v1), so results are polygonal.
 */

import polygonClipping, { type Polygon, type MultiPolygon, type Pair } from 'polygon-clipping';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { activeCompRootId } from '@core/scene/activeComp';
import type { SceneNode, ID } from '@core/types';
import { readNodeKind } from '@core/scene/sceneDerive';
import { shapeOutline } from '@core/scene/pathOps';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { useSelectionStore } from '@stores/selectionStore';
import { bumpScene } from '@stores/sceneStore';
import { useHistoryStore } from '@stores/historyStore';

export type MergeOp = 'union' | 'subtract' | 'intersect' | 'exclude';

export const MERGE_OPS: ReadonlyArray<{ op: MergeOp; label: string }> = [
  { op: 'union', label: 'Union (add)' },
  { op: 'subtract', label: 'Subtract (top minus below)' },
  { op: 'intersect', label: 'Intersect' },
  { op: 'exclude', label: 'Exclude (XOR)' },
];

/** fx keys for a live boolean result layer. */
export const BOOLEAN_OP_PROP = 'booleanOp';
export const BOOLEAN_SOURCES_PROP = 'booleanSources';
/** Mark a source as a live-boolean operand (hidden from paint, still sampled). */
export const BOOLEAN_OPERAND_PROP = 'booleanOperand';

export interface LiveBoolean {
  op: MergeOp;
  sources: readonly string[];
}

interface BezierPt {
  x: number;
  y: number;
  inX: number;
  inY: number;
  outX: number;
  outY: number;
}

/** Cubic bezier point at t for one segment (anchors + absolute handles). */
function cubicAt(a: BezierPt, b: BezierPt, t: number): { x: number; y: number } {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * a.x + w1 * a.outX + w2 * b.inX + w3 * b.x,
    y: w0 * a.y + w1 * a.outY + w2 * b.inY + w3 * b.y,
  };
}

/** Flatten a closed bezier outline into a polygon (perSeg samples/segment).
 *  Corner-only segments (handles at anchors) emit just the anchor. */
export function flattenOutline(
  pts: readonly BezierPt[],
  perSeg = 8,
  /**
   * OPEN runs stop at the last anchor instead of wrapping back to the first.
   *
   * Defaults to closed, so every caller that predates stroke taper flattens
   * byte-identically. Added rather than duplicated because the bezier sampling
   * must stay in ONE place: a tapered stroke and the boolean-ops outline that
   * already used this walking the same path differently is the §2·0 shape.
   */
  open = false,
): Array<{ x: number; y: number }> {
  const n = pts.length;
  if (n < 3) return pts.map((p) => ({ x: p.x, y: p.y }));
  const out: Array<{ x: number; y: number }> = [];
  const segments = open ? n - 1 : n;
  for (let i = 0; i < segments; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    out.push({ x: a.x, y: a.y });
    const curved = a.outX !== a.x || a.outY !== a.y || b.inX !== b.x || b.inY !== b.y;
    if (curved) {
      for (let s = 1; s < perSeg; s++) out.push(cubicAt(a, b, s / perSeg));
    }
  }
  // The closed loop emits every anchor as it goes; an open one never reaches
  // its last, because that anchor ends a segment rather than starting one.
  if (open) out.push({ x: pts[n - 1]!.x, y: pts[n - 1]!.y });
  return out;
}

export type NodeSample = (prop: string) => number | undefined;
export type NodePathSample = () => BezierPt[] | undefined;

/**
 * A node's outline as a WORLD-space polygon ring (flattened, transformed).
 * Optional `sample` / `pathSample` pull animated transform + path.points so a
 * live boolean tracks keyframed operands.
 */
export function nodeWorldPolygon(
  node: SceneNode,
  sample?: NodeSample,
  pathSample?: NodePathSample,
): Polygon | null {
  // Booleans operate on REGIONS, so an open path is rejected here — it has no
  // inside. `nodeWorldOutline` below is the shared resolution; this wraps it
  // in the polygon contract.
  const outline = nodeWorldOutline(node, sample, pathSample);
  if (!outline || !outline.closed || outline.points.length < 3) return null;
  const ring: Pair[] = outline.points.map((pt) => [pt.x, pt.y] as Pair);
  ring.push([ring[0]![0], ring[0]![1]]);
  return [ring];
}

/**
 * A shape node's outline as WORLD-space points — flattened, transformed, and
 * labelled open or closed.
 *
 * Extracted from {@link nodeWorldPolygon} so the CLONER's path mode and the
 * boolean ops resolve a layer's outline through ONE implementation. The two
 * want different contracts — a boolean needs a closed region, a path cloner is
 * happiest on an open pen stroke — but the resolution underneath (primitive
 * outline vs Geometry points vs animated `path.points`, then the node's own
 * transform) must not exist twice, or clones would sit on a subtly different
 * curve than the one on screen.
 */
export function nodeWorldOutline(
  node: SceneNode,
  sample?: NodeSample,
  pathSample?: NodePathSample,
): { points: Array<{ x: number; y: number }>; closed: boolean } | null {
  if (readNodeKind(node) !== 'shape') return null;
  const t = node.components.find((c) => c.type === 'Transform');
  if (!t) return null;
  const p = t.props as Record<string, unknown>;
  const num = (v: unknown, fb: number): number => (typeof v === 'number' ? v : fb);
  const x = sample?.('x') ?? num(p.x, 0);
  const y = sample?.('y') ?? num(p.y, 0);
  const w = sample?.('width') ?? num(p.width, 100);
  const h = sample?.('height') ?? num(p.height, 100);
  const rot = ((sample?.('rotation') ?? num(p.rotation, 0)) * Math.PI) / 180;
  const sx = sample?.('scaleX') ?? sample?.('scale') ?? num(p.scaleX, 1);
  const sy = sample?.('scaleY') ?? sample?.('scale') ?? num(p.scaleY, 1);

  const geom = node.components.find((c) => c.type === 'Geometry');
  let local: Array<{ x: number; y: number }>;
  let closed = true;
  const livePts = pathSample?.();
  if (livePts && livePts.length >= 3) {
    local = flattenOutline(livePts);
  } else if (geom && Array.isArray(geom.props.points) && (geom.props.points as BezierPt[]).length >= 2) {
    // Open paths flatten open (the last anchor ends the walk instead of
    // wrapping) — that is the case the boolean rejected outright, and the one
    // a path cloner most wants: clones along a drawn pen line.
    closed = geom.props.open !== true;
    local = flattenOutline(geom.props.points as BezierPt[], 8, !closed);
  } else {
    const shapeType = typeof p.shapeType === 'string' ? p.shapeType : 'rect';
    const outline = shapeOutline(shapeType === 'ellipse' ? 'ellipse' : 'rect', w, h, 32);
    local = outline ?? [];
  }
  if (local.length < 2) return null;

  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  return {
    closed,
    points: local.map((pt) => {
      const lx = pt.x * sx;
      const ly = pt.y * sy;
      return { x: x + lx * cos - ly * sin, y: y + lx * sin + ly * cos };
    }),
  };
}

/** Run the boolean over world-space polygons: first vs the rest. */
export function booleanPolygons(polys: Polygon[], op: MergeOp): MultiPolygon {
  if (polys.length === 0) return [];
  const [first, ...rest] = polys;
  if (rest.length === 0) return [first!];
  switch (op) {
    case 'union':
      return polygonClipping.union(first!, ...rest);
    case 'subtract':
      return polygonClipping.difference(first!, ...rest);
    case 'intersect':
      return polygonClipping.intersection(first!, ...rest);
    case 'exclude':
      return polygonClipping.xor(first!, ...rest);
  }
}

/** Drop a GeoJSON closing vertex that duplicates the first. */
function dropClosingPair(ring: Pair[]): Pair[] {
  if (
    ring.length > 1 &&
    ring[0]![0] === ring[ring.length - 1]![0] &&
    ring[0]![1] === ring[ring.length - 1]![1]
  ) {
    return ring.slice(0, -1);
  }
  return ring;
}

/** Every closed ring in a MultiPolygon, exterior then holes, winding preserved. */
function collectClosedRings(multi: MultiPolygon): Pair[][] {
  const rings: Pair[][] = [];
  for (const polygon of multi) {
    for (const ring of polygon) {
      const open = dropClosingPair(ring);
      if (open.length >= 3) rings.push(open);
    }
  }
  return rings;
}

function boundsOfPairs(pts: ReadonlyArray<Pair>): {
  minX: number; minY: number; maxX: number; maxY: number;
  cx: number; cy: number; width: number; height: number;
} {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [px, py] of pts) {
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
  }
  return {
    minX, minY, maxX, maxY,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

function pairsToLocalBezier(ring: ReadonlyArray<Pair>, cx: number, cy: number): BezierPt[] {
  return ring.map(([px, py]) => ({
    x: px - cx, y: py - cy, inX: px - cx, inY: py - cy, outX: px - cx, outY: py - cy,
  }));
}

/** Read a live-boolean config off a node's fx component, or null. */
export function readLiveBoolean(node: SceneNode): LiveBoolean | null {
  const fx = node.components.find((c) => c.type === 'fx');
  if (!fx) return null;
  const op = fx.props[BOOLEAN_OP_PROP];
  const sources = fx.props[BOOLEAN_SOURCES_PROP];
  if (op !== 'union' && op !== 'subtract' && op !== 'intersect' && op !== 'exclude') return null;
  if (!Array.isArray(sources) || sources.length < 2) return null;
  const ids = sources.filter((s): s is string => typeof s === 'string' && s.length > 0);
  if (ids.length < 2) return null;
  return { op, sources: ids };
}

/** True when this node is a hidden operand of a live boolean (do not paint). */
export function isBooleanOperand(node: SceneNode): boolean {
  const fx = node.components.find((c) => c.type === 'fx');
  return fx?.props[BOOLEAN_OPERAND_PROP] === true;
}

/**
 * Evaluate a live boolean into LOCAL path points for the result layer
 * (centred on the result's current x/y). Returns null when operands are gone
 * or the boolean collapses to nothing.
 *
 * Compound results (holes, disjoint islands) come back as `subpaths` — one
 * closed run per ring, winding preserved so a reverse-wound hole still cuts.
 * A single exterior still uses the `points` shorthand.
 */
export function evaluateLiveBoolean(
  result: SceneNode,
  getNode: (id: string) => SceneNode | undefined,
  sampleOf: (nodeId: string) => NodeSample | undefined,
  pathOf: (nodeId: string) => NodePathSample | undefined,
): {
  points: BezierPt[];
  subpaths?: Array<{ points: BezierPt[]; open: boolean }>;
  width: number;
  height: number;
  cx: number;
  cy: number;
} | null {
  const cfg = readLiveBoolean(result);
  if (!cfg) return null;
  const polys: Polygon[] = [];
  for (const id of cfg.sources) {
    const n = getNode(id);
    if (!n) continue;
    const poly = nodeWorldPolygon(n, sampleOf(id), pathOf(id));
    if (poly) polys.push(poly);
  }
  if (polys.length < 2) return null;
  const multi = booleanPolygons(polys, cfg.op);
  const rings = collectClosedRings(multi);
  if (rings.length === 0) return null;

  const box = boundsOfPairs(rings.flat());
  const subpaths = rings.map((ring) => ({
    points: pairsToLocalBezier(ring, box.cx, box.cy),
    open: false,
  }));
  return {
    points: subpaths[0]!.points,
    ...(subpaths.length > 1 ? { subpaths } : {}),
    width: box.width,
    height: box.height,
    cx: box.cx,
    cy: box.cy,
  };
}

let mergeSeq = 0;

/** Copy the style-bearing components (Style + fx paints) from a source node. */
function cloneStyle(source: SceneNode, newId: string, extraFx?: Record<string, unknown>): SceneNode['components'] {
  const out: SceneNode['components'] = [];
  const style = source.components.find((c) => c.type === 'Style');
  out.push({
    id: `${newId}_s`,
    type: 'Style',
    props: style ? { ...style.props } : { opacity: 100, fill: '#2b7eff' },
  });
  const fx = source.components.find((c) => c.type === 'fx');
  const props = { ...(fx ? { ...fx.props } : {}), ...(extraFx ?? {}) };
  // Never inherit operand / solid flags onto the result.
  delete props[BOOLEAN_OPERAND_PROP];
  delete props.solid;
  out.push({ id: `${newId}_fx`, type: 'fx', props });
  return out;
}

function collectMergeableSelection(): { polys: Polygon[]; sources: SceneNode[] } {
  const sel = useSelectionStore.getState();
  const nodes = sel.ids
    .map((id) => defaultSceneGraph.getNode(id))
    .filter((n): n is SceneNode => !!n && !n.locked);
  const polys: Polygon[] = [];
  const sources: SceneNode[] = [];
  for (const n of nodes) {
    const poly = nodeWorldPolygon(n);
    if (poly) {
      polys.push(poly);
      sources.push(n);
    }
  }
  return { polys, sources };
}

/**
 * LIVE merge — sources stay editable/animatable. Creates a result layer that
 * re-evaluates the boolean each frame; sources are marked as operands and
 * hidden from paint.
 */
export function liveMergeSelectedPaths(op: MergeOp): string[] {
  useHistoryStore.getState().flush();
  const { polys, sources } = collectMergeableSelection();
  if (polys.length < 2) return [];

  // Sanity-check the boolean produces geometry before wiring the live link.
  const probe = booleanPolygons(polys, op);
  if (probe.length === 0) return [];

  const parentId = sources[0]!.parent ?? activeCompRootId();
  const id = `live_merge_${(mergeSeq += 1)}_${Math.random().toString(36).slice(2, 6)}`;

  // Seed result transform from the union bounds of the static probe.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const polygon of probe) {
    for (const ring of polygon) {
      for (const [px, py] of ring) {
        if (px < minX) minX = px;
        if (py < minY) minY = py;
        if (px > maxX) maxX = px;
        if (py > maxY) maxY = py;
      }
    }
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const sourceIds = sources.map((s) => s.id);

  const node: SceneNode = {
    id: id as ID,
    name: `Boolean (${op})`,
    parent: null,
    children: [],
    transform: { position: { x: cx, y: cy }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [
      {
        id: `${id}_t`,
        type: 'Transform',
        props: {
          [SCENE_KIND_PROP]: 'shape',
          x: cx, y: cy, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0,
          width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY),
          shapeType: 'path',
        },
      },
      ...cloneStyle(sources[0]!, id, {
        [BOOLEAN_OP_PROP]: op,
        [BOOLEAN_SOURCES_PROP]: sourceIds,
      }),
      { id: `${id}_g`, type: 'Geometry', props: { points: [] } },
    ],
  };

  defaultSceneGraph.addChild(parentId, node);

  // Hide sources from paint but keep them for sampling / timeline edit.
  for (const s of sources) {
    defaultSceneGraph.setFxKey(s.id, BOOLEAN_OPERAND_PROP, true);
    const sn = defaultSceneGraph.getNode(s.id);
    if (sn) sn.visible = false;
  }

  useSelectionStore.getState().set([id]);
  bumpScene();
  useHistoryStore.getState().record(`Live Merge Paths (${op})`);
  return [id];
}

/**
 * Bake merge — sources are removed; result is a static Geometry. Prefer
 * {@link liveMergeSelectedPaths} for designed motion where operands animate.
 */
export function mergeSelectedPaths(op: MergeOp): string[] {
  useHistoryStore.getState().flush();
  const { polys, sources } = collectMergeableSelection();
  if (polys.length < 2) return [];

  const result = booleanPolygons(polys, op);
  const parentId = sources[0]!.parent ?? activeCompRootId();
  const newIds: string[] = [];

  // One layer per Polygon (disconnected island). Holes of that polygon stay
  // on the SAME layer as reverse-wound subpaths — promoting them to extra
  // filled layers used to fill the hole instead of cutting it.
  for (const polygon of result) {
    const rings = collectClosedRings([polygon]);
    if (rings.length === 0) continue;
    const box = boundsOfPairs(rings.flat());
    const local = rings.map((ring) => pairsToLocalBezier(ring, box.cx, box.cy));
    const id = `merge_${(mergeSeq += 1)}_${Math.random().toString(36).slice(2, 6)}`;
    const geomProps =
      local.length > 1
        ? { subpaths: local.map((points) => ({ points, open: false })) }
        : { points: local[0]! };
    const node: SceneNode = {
      id: id as ID,
      name: `Merged (${op})`,
      parent: null,
      children: [],
      transform: { position: { x: box.cx, y: box.cy }, rotation: 0, scale: { x: 1, y: 1 } },
      visible: true,
      locked: false,
      components: [
        {
          id: `${id}_t`,
          type: 'Transform',
          props: {
            [SCENE_KIND_PROP]: 'shape',
            x: box.cx, y: box.cy, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0,
            width: box.width, height: box.height,
            shapeType: 'path',
          },
        },
        ...cloneStyle(sources[0]!, id),
        { id: `${id}_g`, type: 'Geometry', props: geomProps },
      ],
    };
    defaultSceneGraph.addChild(parentId, node);
    newIds.push(id);
  }

  if (newIds.length === 0) return [];
  for (const s of sources) defaultSceneGraph.removeNode(s.id);
  useSelectionStore.getState().set(newIds);
  bumpScene();
  useHistoryStore.getState().record(`Merge Paths (${op})`);
  return newIds;
}
