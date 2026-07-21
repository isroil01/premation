/**
 * Path operations (Prompt 11 / MG Phase C) — procedural shape deformation. A
 * shape's outline (or drawn path) is transformed into a new polyline before
 * rendering: Zig-Zag ruffles the edges, Round Corners softens the vertices.
 * The amount/detail are keyframeable, so an animated zig-zag amplitude gives a
 * wobbling squiggle — classic generative motion graphics.
 *
 * Every operator is a pure point→point function (unit-tested); buildSnapshot
 * generates the base outline, applies the op, and hands the result to the
 * renderer as a path.
 */

import type { Pt } from './trimPath';
import type { SceneNode } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';

export type PathOpType = 'none' | 'zigzag' | 'roundCorners' | 'pucker' | 'twist' | 'offset' | 'roughen';

export interface PathOp {
  type: PathOpType;
  /** Zig-Zag amplitude (px) or Round-Corners radius (px). */
  amount: number;
  /** Zig-Zag ridges per edge, or Round-Corners arc steps. */
  detail: number;
}

export const PATHOP_PARAMS = ['amount', 'detail'] as const;
export type PathOpParam = (typeof PATHOP_PARAMS)[number];
export function pathOpPropPath(param: PathOpParam): string {
  return `pathop.${param}`;
}
export function defaultPathOp(): PathOp {
  return { type: 'zigzag', amount: 20, detail: 4 };
}

const DEG = Math.PI / 180;

// ── Pure geometry (tested) ───────────────────────────────────────────

/**
 * A shape's outline as a closed polyline in local space (centred at 0,0).
 * `subdivide` inserts extra points along rect edges (0 = plain corners) so
 * pucker/twist deform smoothly rather than just moving the four corners.
 */
export function shapeOutline(
  primitive: string | undefined,
  w: number,
  h: number,
  ellipseSteps = 48,
  subdivide = 0,
): Pt[] {
  if (primitive === 'ellipse') {
    const pts: Pt[] = [];
    for (let i = 0; i < ellipseSteps; i++) {
      const a = (i / ellipseSteps) * Math.PI * 2;
      pts.push({ x: Math.cos(a) * (w / 2), y: Math.sin(a) * (h / 2) });
    }
    return pts;
  }
  const corners: Pt[] = [
    { x: -w / 2, y: -h / 2 },
    { x: w / 2, y: -h / 2 },
    { x: w / 2, y: h / 2 },
    { x: -w / 2, y: h / 2 },
  ];
  if (subdivide <= 0) return corners;
  const out: Pt[] = [];
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % corners.length]!;
    for (let s = 0; s < subdivide + 1; s++) {
      const t = s / (subdivide + 1);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

/**
 * Ruffle each edge into `segments` sub-steps, offsetting the interior points
 * alternately ±amplitude perpendicular to the edge. Original vertices stay.
 */
export function zigzag(pts: readonly Pt[], closed: boolean, amplitude: number, segments: number): Pt[] {
  const seg = Math.max(1, Math.floor(segments));
  const n = pts.length;
  if (n < 2) return [...pts];
  const count = closed ? n : n - 1;
  const out: Pt[] = [];
  for (let i = 0; i < count; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len; // perpendicular unit
    const ny = dx / len;
    out.push({ x: a.x, y: a.y }); // keep the vertex
    for (let s = 1; s < seg; s++) {
      const t = s / seg;
      const off = amplitude * (s % 2 === 1 ? 1 : -1);
      out.push({ x: a.x + dx * t + nx * off, y: a.y + dy * t + ny * off });
    }
  }
  if (!closed) out.push({ x: pts[n - 1]!.x, y: pts[n - 1]!.y });
  return out;
}

/**
 * Replace each vertex with a rounded corner: cut back along both edges by
 * `radius` (clamped to half the shorter edge) and fill with a quadratic arc.
 */
export function roundCorners(pts: readonly Pt[], closed: boolean, radius: number, steps = 4): Pt[] {
  const n = pts.length;
  if (n < 3 || radius <= 0) return [...pts];
  const st = Math.max(1, Math.floor(steps));
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const cur = pts[i]!;
    if (!closed && (i === 0 || i === n - 1)) {
      out.push({ x: cur.x, y: cur.y });
      continue;
    }
    const prev = pts[(i - 1 + n) % n]!;
    const next = pts[(i + 1) % n]!;
    const v1x = prev.x - cur.x;
    const v1y = prev.y - cur.y;
    const v2x = next.x - cur.x;
    const v2y = next.y - cur.y;
    const l1 = Math.hypot(v1x, v1y) || 1;
    const l2 = Math.hypot(v2x, v2y) || 1;
    const d = Math.min(radius, l1 / 2, l2 / 2);
    const p1 = { x: cur.x + (v1x / l1) * d, y: cur.y + (v1y / l1) * d };
    const p2 = { x: cur.x + (v2x / l2) * d, y: cur.y + (v2y / l2) * d };
    out.push(p1);
    for (let s = 1; s < st; s++) {
      const t = s / st;
      const mt = 1 - t;
      out.push({
        x: mt * mt * p1.x + 2 * mt * t * cur.x + t * t * p2.x,
        y: mt * mt * p1.y + 2 * mt * t * cur.y + t * t * p2.y,
      });
    }
    out.push(p2);
  }
  return out;
}

/** Centroid of a point set. */
function centroid(pts: readonly Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  const n = pts.length || 1;
  return { x: x / n, y: y / n };
}

/**
 * Pucker & Bloat — push points out from (bloat, amount > 0) or pull them in
 * toward (pucker, amount < 0) the centroid, as a percentage of their radius.
 */
export function puckerBloat(pts: readonly Pt[], amountPct: number): Pt[] {
  if (pts.length < 3) return [...pts];
  const c = centroid(pts);
  const f = 1 + amountPct / 100;
  return pts.map((p) => ({ x: c.x + (p.x - c.x) * f, y: c.y + (p.y - c.y) * f }));
}

/**
 * Twist — rotate each point around the centroid by an angle proportional to its
 * distance from the centre, spiralling the outline. Pure.
 */
export function twist(pts: readonly Pt[], angleDeg: number): Pt[] {
  if (pts.length < 3) return [...pts];
  const c = centroid(pts);
  let maxD = 0;
  for (const p of pts) {
    const d = Math.hypot(p.x - c.x, p.y - c.y);
    if (d > maxD) maxD = d;
  }
  if (maxD === 0) return [...pts];
  return pts.map((p) => {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const a = (angleDeg * DEG) * (Math.hypot(dx, dy) / maxD);
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
  });
}

/**
 * Offset Paths — move every point along its averaged-edge normal. Sign flips
 * expand vs contract (which is which depends on the outline's winding). Naive
 * normal offset with no self-intersection cleanup — AE's is fancier, but this
 * covers the classic "grow/shrink the shape" use. Pure.
 */
export function offsetPath(pts: readonly Pt[], closed: boolean, amount: number): Pt[] {
  const n = pts.length;
  if (n < 2 || amount === 0) return [...pts];
  const normalOf = (a: Pt, b: Pt): Pt => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: -dy / len, y: dx / len };
  };
  return pts.map((p, i) => {
    const hasPrev = closed || i > 0;
    const hasNext = closed || i < n - 1;
    const np = hasPrev ? normalOf(pts[(i - 1 + n) % n]!, p) : null;
    const nn = hasNext ? normalOf(p, pts[(i + 1) % n]!) : null;
    let nx = (np?.x ?? 0) + (nn?.x ?? 0);
    let ny = (np?.y ?? 0) + (nn?.y ?? 0);
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    return { x: p.x + nx * amount, y: p.y + ny * amount };
  });
}

/**
 * Roughen — subdivide each edge `detail` times, then displace every point
 * along its normal by a DETERMINISTIC per-index hash scaled by `amount`
 * (stable across frames, so animating amount wobbles smoothly instead of
 * boiling). AE's Roughen Edges, the vector version. Pure.
 */
export function roughen(pts: readonly Pt[], closed: boolean, amount: number, detail: number): Pt[] {
  const n = pts.length;
  if (n < 2 || amount === 0) return [...pts];
  const sub = Math.max(1, Math.min(10, Math.round(detail)));
  const dense: Pt[] = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    for (let s = 0; s < sub; s++) {
      const t = s / sub;
      dense.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  if (!closed) dense.push(pts[n - 1]!);
  const m = dense.length;
  const rnd = (i: number): number => {
    let h = (i + 1) * 374761393;
    h = (h ^ (h >>> 13)) * 1274126177;
    return (((h ^ (h >>> 16)) >>> 0) / 4294967296) * 2 - 1;
  };
  return dense.map((p, i) => {
    const prev = dense[(i - 1 + m) % m]!;
    const next = dense[(i + 1) % m]!;
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    const d = amount * rnd(i);
    return { x: p.x + (-dy / len) * d, y: p.y + (dx / len) * d };
  });
}

/** Apply the configured operator to an outline. Pure. */
export function applyPathOp(pts: readonly Pt[], closed: boolean, op: PathOp): Pt[] {
  switch (op.type) {
    case 'zigzag':
      return zigzag(pts, closed, op.amount, op.detail);
    case 'roundCorners':
      return roundCorners(pts, closed, op.amount, op.detail);
    case 'pucker':
      return puckerBloat(pts, op.amount);
    case 'twist':
      return twist(pts, op.amount);
    case 'offset':
      return offsetPath(pts, closed, op.amount);
    case 'roughen':
      return roughen(pts, closed, op.amount, op.detail);
    default:
      return [...pts];
  }
}

// ── Scene integration ────────────────────────────────────────────────

const num = (v: unknown, fb: number): number => (typeof v === 'number' ? v : fb);
function fxProps(node: SceneNode): Record<string, unknown> | undefined {
  return node.components.find((c) => c.type === 'fx')?.props as Record<string, unknown> | undefined;
}

const PATH_OP_TYPES: readonly PathOpType[] = ['none', 'zigzag', 'roundCorners', 'pucker', 'twist', 'offset', 'roughen'];

function isPathOpType(v: unknown): v is PathOpType {
  return typeof v === 'string' && (PATH_OP_TYPES as readonly string[]).includes(v);
}

export function readPathOpConfig(node: SceneNode): PathOp | null {
  const raw = fxProps(node)?.pathOp;
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Partial<PathOp>;
  const d = defaultPathOp();
  // Validate against the whole union. This used to allowlist only
  // roundCorners/none and coerce EVERYTHING else to 'zigzag', so Pucker & Bloat
  // and Twist could be selected but never read back — the dropdown snapped
  // straight back and `applyPathOp`'s pucker/twist branches were unreachable.
  const type: PathOpType = isPathOpType(o.type) ? o.type : d.type;
  return { type, amount: num(o.amount, d.amount), detail: num(o.detail, d.detail) };
}

export function hasPathOp(node: SceneNode): boolean {
  const o = readPathOpConfig(node);
  return !!o && o.type !== 'none';
}

export function resolvePathOp(node: SceneNode, av: Map<string, number> | undefined): PathOp | null {
  const base = readPathOpConfig(node);
  if (!base) return null;
  const v = (p: PathOpParam, fb: number): number => av?.get(pathOpPropPath(p)) ?? fb;
  return { type: base.type, amount: v('amount', base.amount), detail: v('detail', base.detail) };
}

export function setPathOp(nodeId: string, op: PathOp | null): void {
  defaultSceneGraph.setPathOp(nodeId, op ?? undefined);
  bumpScene();
}

export function updatePathOp(nodeId: string, patch: Partial<PathOp>): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const base = readPathOpConfig(node) ?? defaultPathOp();
  setPathOp(nodeId, { ...base, ...patch });
}
