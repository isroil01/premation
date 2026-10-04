/**
 * Parametric Polystar — AE's Polygon / Star shape, kept as PARAMETERS rather
 * than baked anchors.
 *
 * The Polygon and Star tools used to bake their outline once, at draw time,
 * into fixed bezier anchors: a five-point star was five fixed spikes forever,
 * and "make it seven points" meant redrawing. This stores AE's parameter set
 * on the layer instead — type, points, rotation, the two radii and the two
 * roundnesses — and `buildSnapshot` recomputes the outline from the LIVE
 * values every frame, before the path-operator chain seeds. So the parameters
 * keyframe like anything else, and trim / repeater / wiggle apply on top of
 * the parametric outline exactly as they do on a drawn path.
 *
 * ── Storage and keyframe paths ──────────────────────────────────────────────
 *
 * The config lives on the node's `fx` component under one key
 * (`fx.polystar`), like `stroke` and `pathOps`. A layer has at most ONE
 * polystar (it IS the layer's geometry), so the keyframe paths are plain keys
 * — `polystar.points`, `polystar.outerRadius`, … — the `cornerRadius*`
 * pattern, not the id-scoped `pathop.<id>.*` one, which exists only because
 * operators are a reorderable LIST.
 *
 * Old projects are untouched: a baked polygon is just a 'path' shape with a
 * Geometry component and no `fx.polystar`, and keeps rendering through the
 * path branch it always took. No migration.
 *
 * ── Roundness ───────────────────────────────────────────────────────────────
 *
 * AE's polystar roundness bulges the SEGMENTS: each vertex becomes a bezier
 * anchor whose tangent handles run along the travel direction with length
 * proportional to the segment — `π·r·(roundness/100) / (2·points)`, the same
 * constant Lottie renders AE's `sr` shape with, so an exported polystar and
 * this outline agree. Roundness 0 collapses the handles onto the vertex
 * (plain corners); negative roundness flips them (concave curls), as AE
 * allows.
 */

import type { SceneNode } from '@core/types';

export type PolystarType = 'polygon' | 'star';

export interface Polystar {
  starType: PolystarType;
  /** Named points (a star's spikes; a polygon's corners). ≥ 3. */
  points: number;
  /** Rotation of the whole outline, degrees (0 = first point straight up). */
  rotation: number;
  /** Spike / corner radius, px. */
  outerRadius: number;
  /** Valley radius, px — read only when `starType` is 'star'. */
  innerRadius: number;
  /** Segment bulge at the outer vertices, percent (signed). */
  outerRoundness: number;
  /** Segment bulge at the inner vertices, percent (signed). Star only. */
  innerRoundness: number;
}

/** The `fx` component key the config is stored under. */
export const POLYSTAR_FX_PROP = 'polystar';

/**
 * The keyframeable parameters. `starType` deliberately is NOT here — it is
 * discrete, like a path operator's `composite`: interpolating between polygon
 * and star has no meaning.
 */
export const POLYSTAR_PARAMS = [
  'points', 'rotation', 'outerRadius', 'innerRadius', 'outerRoundness', 'innerRoundness',
] as const;
export type PolystarParam = (typeof POLYSTAR_PARAMS)[number];

/** The keyframe path for one polystar parameter. */
export function polystarPropPath(param: PolystarParam): string {
  return `polystar.${param}`;
}

/** One editable parameter, and how to present it — same shape as
 *  `pathOpParamSpecs`, consumed by the inspector section AND the timeline's
 *  Contents rows so the two cannot list different parameters. */
export interface PolystarParamSpec {
  param: PolystarParam;
  label: string;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Signed parameter — suppresses the non-negative floor. */
  signed?: boolean;
}

/** The rows a polystar of this type actually has, in AE's order. A polygon
 *  has no inner pair — showing dead controls would be worse than none. */
export function polystarParamSpecs(starType: PolystarType): ReadonlyArray<PolystarParamSpec> {
  const rows: PolystarParamSpec[] = [
    { param: 'points', label: 'Points', min: 3, max: 100, step: 1 },
    { param: 'rotation', label: 'Rotation', unit: '°', signed: true },
    { param: 'outerRadius', label: 'Outer Radius', unit: 'px', min: 0 },
  ];
  if (starType === 'star') {
    rows.push({ param: 'innerRadius', label: 'Inner Radius', unit: 'px', min: 0 });
  }
  rows.push({ param: 'outerRoundness', label: 'Outer Roundness', unit: '%', signed: true });
  if (starType === 'star') {
    rows.push({ param: 'innerRoundness', label: 'Inner Roundness', unit: '%', signed: true });
  }
  return rows;
}

/** A fresh polystar: AE's defaults scaled to the drawn radius. */
export function defaultPolystar(
  starType: PolystarType,
  outerRadius = 100,
  points?: number,
  innerRatio = 0.5,
): Polystar {
  return {
    starType,
    points: Math.max(3, Math.round(points ?? 5)),
    rotation: 0,
    outerRadius: Math.max(1, outerRadius),
    innerRadius: Math.max(0, outerRadius * Math.min(0.9, Math.max(0.1, innerRatio))),
    outerRoundness: 0,
    innerRoundness: 0,
  };
}

const num = (v: unknown, fb: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fb;

/** Validate one stored config, or null when the node carries none. */
export function readNodePolystar(node: SceneNode): Polystar | null {
  const fx = node.components.find((c) => c.type === 'fx');
  const raw = fx?.props[POLYSTAR_FX_PROP];
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Partial<Polystar>;
  return {
    starType: o.starType === 'polygon' ? 'polygon' : 'star',
    points: Math.max(3, Math.round(num(o.points, 5))),
    rotation: num(o.rotation, 0),
    outerRadius: Math.max(0, num(o.outerRadius, 100)),
    innerRadius: Math.max(0, num(o.innerRadius, 50)),
    outerRoundness: num(o.outerRoundness, 0),
    innerRoundness: num(o.innerRoundness, 0),
  };
}

/**
 * The config with its animated values applied — the same fold every other
 * animatable shape parameter takes (`av` is the node's evaluated track map at
 * the layer's own time; static base falls through).
 */
export function resolvePolystar(cfg: Polystar, av: Map<string, number> | undefined): Polystar {
  const v = (p: PolystarParam, fb: number): number => av?.get(polystarPropPath(p)) ?? fb;
  return {
    starType: cfg.starType,
    // A keyframe gliding 5 → 7 steps at each whole point count; fractional
    // point counts have no outline (a 5.4-gon is not a polygon).
    points: Math.max(3, Math.round(v('points', cfg.points))),
    rotation: v('rotation', cfg.rotation),
    outerRadius: Math.max(0, v('outerRadius', cfg.outerRadius)),
    innerRadius: Math.max(0, v('innerRadius', cfg.innerRadius)),
    outerRoundness: v('outerRoundness', cfg.outerRoundness),
    innerRoundness: v('innerRoundness', cfg.innerRoundness),
  };
}

/** Bezier anchor with ABSOLUTE handles — structurally `BezierPoint`, restated
 *  here so scene code does not import across the workspace package boundary. */
export interface PolystarPoint {
  x: number;
  y: number;
  inX: number;
  inY: number;
  outX: number;
  outY: number;
}

const DEG = Math.PI / 180;

/**
 * The outline, centred on (0, 0), first point straight up at rotation 0,
 * travelling clockwise. Pure.
 *
 * Handle length is `π·r·(roundness/100) / (2·points)` along the travel
 * tangent — segment-proportional, the constant Lottie uses for AE's `sr`
 * shape (star: 2πr/(2n)·pct over 2n vertices; polygon: 2πr/(4n)·pct over n —
 * both reduce to this). Roundness 0 emits pure corners.
 */
export function polystarOutline(cfg: Polystar): PolystarPoint[] {
  const n = Math.max(3, Math.round(cfg.points));
  const star = cfg.starType === 'star';
  const total = star ? n * 2 : n;
  const step = (Math.PI * 2) / total;
  const start = (cfg.rotation - 90) * DEG;
  const out: PolystarPoint[] = [];
  for (let i = 0; i < total; i++) {
    const outer = !star || i % 2 === 0;
    const r = outer ? cfg.outerRadius : cfg.innerRadius;
    const pct = (outer ? cfg.outerRoundness : cfg.innerRoundness) / 100;
    const a = start + i * step;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    // Travel tangent (d/da of the vertex position, unit length).
    const tx = -Math.sin(a);
    const ty = Math.cos(a);
    const hl = (Math.PI * r * pct) / (2 * n);
    out.push({
      x, y,
      inX: x - tx * hl, inY: y - ty * hl,
      outX: x + tx * hl, outY: y + ty * hl,
    });
  }
  return out;
}
