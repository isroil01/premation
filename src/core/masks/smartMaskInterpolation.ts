/**
 * Smart Mask Interpolation (AE parity 5.4) — the in-between mask shapes for
 * two mask path keyframes, as AE's panel builds them: both outlines are
 * resampled to the same number of vertices by arc length (Add Mask Shape
 * Vertices), the vertex correspondence is chosen (First Vertices Match, or the
 * rotation / direction that matches the shapes best — Quality sets how hard
 * it searches), and each in-between interpolates every vertex about the
 * moving centroid in polar form, so a turning shape turns instead of
 * collapsing through its middle. `oneToOne` keeps the authored vertices when
 * both shapes have the same count (AE's "Use 1:1 Vertex Matches").
 *
 * Pure: two BezierPaths in, in-between BezierPaths out (straight segments —
 * the in-betweens carry dense vertices, as AE's do).
 */

import type { BezierPath } from '@motion/engine-api';

export interface SmartMaskOptions {
  /** Pixels between added vertices along the outline (AE "Add Mask Shape Vertices"); 0 = no extra vertices. */
  vertexSpacing: number;
  /** Vertex 1 of A goes to vertex 1 of B (no rotation search). */
  firstVerticesMatch: boolean;
  /** Keep the authored vertices 1:1 when both shapes have as many. */
  oneToOne: boolean;
  /** 0…1: how many start offsets the correspondence search tries (1 = every one). */
  quality: number;
}

export const DEFAULT_SMART_MASK_OPTIONS: SmartMaskOptions = {
  vertexSpacing: 10,
  firstVerticesMatch: false,
  oneToOne: false,
  quality: 0.5,
};

interface P { x: number; y: number }

/** The outline as a dense polyline (each cubic sampled `steps` times). */
export function flattenPath(path: BezierPath, steps = 16): P[] {
  const n = path.vertices.length / 2;
  const out: P[] = [];
  const v = (i: number): P => ({ x: path.vertices[i * 2]!, y: path.vertices[i * 2 + 1]! });
  const tin = (i: number): P => ({ x: path.inTangents[i * 2] ?? 0, y: path.inTangents[i * 2 + 1] ?? 0 });
  const tout = (i: number): P => ({ x: path.outTangents[i * 2] ?? 0, y: path.outTangents[i * 2 + 1] ?? 0 });
  const segs = path.closed ? n : n - 1;
  for (let s = 0; s < segs; s++) {
    const a = v(s);
    const b = v((s + 1) % n);
    const c1 = { x: a.x + tout(s).x, y: a.y + tout(s).y };
    const c2 = { x: b.x + tin((s + 1) % n).x, y: b.y + tin((s + 1) % n).y };
    const straight = c1.x === a.x && c1.y === a.y && c2.x === b.x && c2.y === b.y;
    const k = straight ? 1 : steps;
    for (let j = 0; j < k; j++) {
      const t = j / k;
      const u = 1 - t;
      out.push({
        x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
        y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
      });
    }
  }
  if (!path.closed && n > 0) out.push(v(n - 1));
  return out;
}

/** `pts` resampled to `count` points evenly spaced by arc length (closed: around the loop). */
export function resample(pts: readonly P[], count: number, closed: boolean): P[] {
  if (pts.length === 0 || count <= 0) return [];
  const ring = closed ? [...pts, pts[0]!] : [...pts];
  const cum = [0];
  for (let i = 1; i < ring.length; i++) cum.push(cum[i - 1]! + Math.hypot(ring[i]!.x - ring[i - 1]!.x, ring[i]!.y - ring[i - 1]!.y));
  const total = cum[cum.length - 1]!;
  if (total <= 0) return Array.from({ length: count }, () => ({ ...pts[0]! }));
  const out: P[] = [];
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const target = closed ? (k / count) * total : (count === 1 ? 0 : (k / (count - 1)) * total);
    while (seg < cum.length - 2 && cum[seg + 1]! < target) seg++;
    const len = cum[seg + 1]! - cum[seg]!;
    const t = len > 0 ? (target - cum[seg]!) / len : 0;
    const a = ring[seg]!;
    const b = ring[seg + 1] ?? a;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}

function perimeter(pts: readonly P[], closed: boolean): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  if (closed && pts.length > 1) s += Math.hypot(pts[0]!.x - pts[pts.length - 1]!.x, pts[0]!.y - pts[pts.length - 1]!.y);
  return s;
}

function centroid(pts: readonly P[]): P {
  let x = 0, y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / Math.max(1, pts.length), y: y / Math.max(1, pts.length) };
}

/**
 * The correspondence: `b` reordered so that b[i] belongs with a[i]. Tries
 * start offsets (and the reversed direction) on a closed outline, scoring each
 * by the summed squared distance with both shapes centred.
 */
export function matchVertices(a: readonly P[], b: readonly P[], closed: boolean, opts: Pick<SmartMaskOptions, 'firstVerticesMatch' | 'quality'>): P[] {
  const n = a.length;
  if (!closed || opts.firstVerticesMatch || n < 3) return [...b];
  const ca = centroid(a);
  const cb = centroid(b);
  const step = Math.max(1, Math.round(n / Math.max(4, Math.round(n * Math.max(0.05, Math.min(1, opts.quality))))));
  let best = { cost: Infinity, offset: 0, reversed: false };
  for (const reversed of [false, true]) {
    const src = reversed ? [...b].reverse() : b;
    for (let off = 0; off < n; off += step) {
      let cost = 0;
      for (let i = 0; i < n && cost < best.cost; i++) {
        const p = src[(i + off) % n]!;
        const dx = (a[i]!.x - ca.x) - (p.x - cb.x);
        const dy = (a[i]!.y - ca.y) - (p.y - cb.y);
        cost += dx * dx + dy * dy;
      }
      if (cost < best.cost) best = { cost, offset: off, reversed };
    }
  }
  const src = best.reversed ? [...b].reverse() : b;
  return Array.from({ length: n }, (_, i) => src[(i + best.offset) % n]!);
}

/** The shortest signed angle from `a` to `b`, radians. */
function angleDelta(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/**
 * The in-between shapes at fractions `ts` (0 < t < 1) from `a` to `b`.
 * Every result has the same vertex count, straight segments, `a`'s closedness.
 */
export function smartInterpolate(a: BezierPath, b: BezierPath, ts: readonly number[], options: Partial<SmartMaskOptions> = {}): BezierPath[] {
  const opts = { ...DEFAULT_SMART_MASK_OPTIONS, ...options };
  const closed = a.closed;
  const na = a.vertices.length / 2;
  const nb = b.vertices.length / 2;
  let pa: P[];
  let pb: P[];
  if (opts.oneToOne && na === nb && na > 0) {
    pa = Array.from({ length: na }, (_, i) => ({ x: a.vertices[i * 2]!, y: a.vertices[i * 2 + 1]! }));
    pb = Array.from({ length: nb }, (_, i) => ({ x: b.vertices[i * 2]!, y: b.vertices[i * 2 + 1]! }));
  } else {
    const fa = flattenPath(a);
    const fb = flattenPath(b);
    const longest = Math.max(perimeter(fa, closed), perimeter(fb, closed));
    const count = Math.max(na, nb, 3, opts.vertexSpacing > 0 ? Math.min(512, Math.ceil(longest / opts.vertexSpacing)) : 0);
    pa = resample(fa, count, closed);
    pb = matchVertices(pa, resample(fb, count, closed), closed, opts);
  }
  const ca = centroid(pa);
  const cb = centroid(pb);
  return ts.map((t) => {
    const c = { x: ca.x + (cb.x - ca.x) * t, y: ca.y + (cb.y - ca.y) * t };
    const vertices: number[] = [];
    for (let i = 0; i < pa.length; i++) {
      // Polar about the moving centroid: radius and angle interpolate.
      const ax = pa[i]!.x - ca.x, ay = pa[i]!.y - ca.y;
      const bx = pb[i]!.x - cb.x, by = pb[i]!.y - cb.y;
      const ra = Math.hypot(ax, ay), rb = Math.hypot(bx, by);
      const angA = Math.atan2(ay, ax);
      const ang = angA + angleDelta(angA, Math.atan2(by, bx)) * t;
      const r = ra + (rb - ra) * t;
      const polar = { x: c.x + Math.cos(ang) * r, y: c.y + Math.sin(ang) * r };
      // Near the centroid the angle is meaningless: blend toward the straight lerp.
      const lin = { x: pa[i]!.x + (pb[i]!.x - pa[i]!.x) * t, y: pa[i]!.y + (pb[i]!.y - pa[i]!.y) * t };
      const w = Math.min(1, Math.min(ra, rb) / 4);
      vertices.push(lin.x + (polar.x - lin.x) * w, lin.y + (polar.y - lin.y) * w);
    }
    const zeros = vertices.map(() => 0);
    return { vertices, inTangents: zeros, outTangents: [...zeros], closed, featherPoints: [], vertexStates: [] };
  });
}

/** The key times (seconds) between `t0` and `t1` at `rate` keys per second, exclusive of both ends. */
export function interpolationTimes(t0: number, t1: number, rate: number): number[] {
  if (!(t1 > t0) || !(rate > 0)) return [];
  const out: number[] = [];
  const step = 1 / rate;
  for (let t = t0 + step; t < t1 - step * 1e-3; t += step) out.push(Math.round(t * 1e6) / 1e6);
  return out;
}
