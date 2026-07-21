/**
 * Merge Paths — boolean operations (union / subtract / intersect / exclude)
 * across SHAPE LAYERS, the long-deferred AE feature. The geometry engine is
 * `polygon-clipping` (Martinez–Rueda; battle-tested in turf.js) rather than a
 * hand-rolled clipper — boolean robustness is exactly where home-grown
 * geometry dies on degenerate inputs.
 *
 * v1 semantics (documented, honest):
 *  - Curved outlines are FLATTENED (each bezier segment sampled) before the
 *    boolean, so results are polygonal. Round Corners / Smooth restores flow.
 *  - Result polygons keep their exterior rings; holes become separate layers
 *    too (rendered as independent shapes, not true even-odd holes).
 *  - The first selected layer donates its style (fill/stroke) to the results.
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

export type MergeOp = 'union' | 'subtract' | 'intersect' | 'exclude';

export const MERGE_OPS: ReadonlyArray<{ op: MergeOp; label: string }> = [
  { op: 'union', label: 'Union (add)' },
  { op: 'subtract', label: 'Subtract (top minus below)' },
  { op: 'intersect', label: 'Intersect' },
  { op: 'exclude', label: 'Exclude (XOR)' },
];

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
export function flattenOutline(pts: readonly BezierPt[], perSeg = 8): Array<{ x: number; y: number }> {
  const n = pts.length;
  if (n < 3) return pts.map((p) => ({ x: p.x, y: p.y }));
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    out.push({ x: a.x, y: a.y });
    const curved = a.outX !== a.x || a.outY !== a.y || b.inX !== b.x || b.inY !== b.y;
    if (curved) {
      for (let s = 1; s < perSeg; s++) out.push(cubicAt(a, b, s / perSeg));
    }
  }
  return out;
}

/** A node's outline as a WORLD-space polygon ring (flattened, transformed). */
export function nodeWorldPolygon(node: SceneNode): Polygon | null {
  if (readNodeKind(node) !== 'shape') return null;
  const t = node.components.find((c) => c.type === 'Transform');
  if (!t) return null;
  const p = t.props as Record<string, unknown>;
  const num = (v: unknown, fb: number): number => (typeof v === 'number' ? v : fb);
  const x = num(p.x, 0);
  const y = num(p.y, 0);
  const w = num(p.width, 100);
  const h = num(p.height, 100);
  const rot = (num(p.rotation, 0) * Math.PI) / 180;
  const sx = num(p.scaleX, 1);
  const sy = num(p.scaleY, 1);

  // Local outline: explicit geometry beats the primitive shape.
  const geom = node.components.find((c) => c.type === 'Geometry');
  let local: Array<{ x: number; y: number }>;
  if (geom && Array.isArray(geom.props.points) && (geom.props.points as BezierPt[]).length >= 3) {
    if (geom.props.open === true) return null; // open strokes enclose no area
    local = flattenOutline(geom.props.points as BezierPt[]);
  } else {
    const shapeType = typeof p.shapeType === 'string' ? p.shapeType : 'rect';
    const outline = shapeOutline(shapeType === 'ellipse' ? 'ellipse' : 'rect', w, h, 32);
    local = outline ?? [];
  }
  if (local.length < 3) return null;

  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const ring: Pair[] = local.map((pt) => {
    const lx = pt.x * sx;
    const ly = pt.y * sy;
    return [x + lx * cos - ly * sin, y + lx * sin + ly * cos] as Pair;
  });
  // polygon-clipping wants closed-ring semantics; it tolerates unclosed input,
  // but be explicit.
  if (ring.length > 0) ring.push([ring[0]![0], ring[0]![1]]);
  return [ring];
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

let mergeSeq = 0;

/** Copy the style-bearing components (Style + fx paints) from a source node. */
function cloneStyle(source: SceneNode, newId: string): SceneNode['components'] {
  const out: SceneNode['components'] = [];
  const style = source.components.find((c) => c.type === 'Style');
  out.push({
    id: `${newId}_s`,
    type: 'Style',
    props: style ? { ...style.props } : { opacity: 100, fill: '#2b7eff' },
  });
  const fx = source.components.find((c) => c.type === 'fx');
  if (fx) out.push({ id: `${newId}_fx`, type: 'fx', props: { ...fx.props } });
  return out;
}

/**
 * Merge the currently selected shape layers with `op`. Selection ORDER is the
 * stack order the user chose them in: the FIRST selected layer is the base
 * (and donates its style); the others apply to it. Sources are removed and
 * the result layer(s) selected. Returns the new node ids ([] = no-op).
 */
import { useHistoryStore } from '@stores/historyStore';

export function mergeSelectedPaths(op: MergeOp): string[] {
  useHistoryStore.getState().flush();
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
  if (polys.length < 2) return [];

  const result = booleanPolygons(polys, op);
  const parentId = sources[0]!.parent ?? activeCompRootId();
  const newIds: string[] = [];

  for (const polygon of result) {
    for (const ring of polygon) {
      if (ring.length < 3) continue;
      // Drop the closing duplicate vertex if present.
      const openRing =
        ring.length > 1 &&
        ring[0]![0] === ring[ring.length - 1]![0] &&
        ring[0]![1] === ring[ring.length - 1]![1]
          ? ring.slice(0, -1)
          : ring;
      if (openRing.length < 3) continue;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [px, py] of openRing) {
        if (px < minX) minX = px;
        if (py < minY) minY = py;
        if (px > maxX) maxX = px;
        if (py > maxY) maxY = py;
      }
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const id = `merge_${(mergeSeq += 1)}_${Math.random().toString(36).slice(2, 6)}`;
      const points = openRing.map(([px, py]) => ({
        x: px - cx, y: py - cy, inX: px - cx, inY: py - cy, outX: px - cx, outY: py - cy,
      }));
      const node: SceneNode = {
        id: id as ID,
        name: `Merged (${op})`,
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
          ...cloneStyle(sources[0]!, id),
          { id: `${id}_g`, type: 'Geometry', props: { points } },
        ],
      };
      defaultSceneGraph.addChild(parentId, node);
      newIds.push(id);
    }
  }

  if (newIds.length === 0) return [];
  for (const s of sources) defaultSceneGraph.removeNode(s.id);
  sel.set(newIds);
  bumpScene();
  useHistoryStore.getState().record(`Merge Paths (${op})`);
  return newIds;
}

