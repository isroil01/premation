/**
 * Mesh — turn a vector outline into a deformable triangle mesh.
 *
 *   flattenOutline: bezier path (absolute handles) → boundary polygon
 *   earClip: simple polygon → triangle indices (ear clipping)
 *   buildMesh: polygon → { vertices, triangles }
 *   subdivide: midpoint 1→4 split to add interior resolution so the mesh
 *                    bends smoothly, not just at the hull
 *
 * Pure and framework-free. The skinning layer deforms `vertices`; `triangles`
 * index into them for drawing (CPU) or as a GPU index buffer.
 */

import type { Vec2 } from './ik';

export type Triangle = [number, number, number];

export interface Mesh {
  vertices: Vec2[];
  triangles: Triangle[];
}

export interface OutlinePoint {
  x: number;
  y: number;
  inX?: number;
  inY?: number;
  outX?: number;
  outY?: number;
}

/** Signed area of a polygon (>0 = counter-clockwise). */
export function polygonArea(poly: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function cubic(p0: Vec2, c0: Vec2, c1: Vec2, p1: Vec2, t: number): Vec2 {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * c0.x + c * c1.x + d * p1.x, y: a * p0.y + b * c0.y + c * c1.y + d * p1.y };
}

/**
 * Flatten a bezier outline (absolute in/out handles) to a polygon by sampling
 * each segment `samplesPerSegment` times. Produces no duplicate vertices for a
 * closed loop.
 */
export function flattenOutline(points: readonly OutlinePoint[], samplesPerSegment = 8, closed = true): Vec2[] {
  const n = points.length;
  if (n < 2) return points.map((p) => ({ x: p.x, y: p.y }));
  const segCount = closed ? n : n - 1;
  const out: Vec2[] = [];
  const samples = Math.max(1, samplesPerSegment);
  for (let i = 0; i < segCount; i++) {
    const A = points[i]!;
    const B = points[(i + 1) % n]!;
    const p0: Vec2 = { x: A.x, y: A.y };
    const c0: Vec2 = { x: A.outX ?? A.x, y: A.outY ?? A.y };
    const c1: Vec2 = { x: B.inX ?? B.x, y: B.inY ?? B.y };
    const p1: Vec2 = { x: B.x, y: B.y };
    for (let k = 0; k < samples; k++) out.push(cubic(p0, c0, c1, p1, k / samples));
  }
  if (!closed) out.push({ x: points[n - 1]!.x, y: points[n - 1]!.y });
  return out;
}

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

function pointInTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const d1 = cross(p.x - a.x, p.y - a.y, b.x - a.x, b.y - a.y);
  const d2 = cross(p.x - b.x, p.y - b.y, c.x - b.x, c.y - b.y);
  const d3 = cross(p.x - c.x, p.y - c.y, a.x - c.x, a.y - c.y);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/**
 * Ear-clipping triangulation of a simple polygon. Returns triangles as index
 * triples into the input polygon, wound counter-clockwise.
 */
export function earClip(polygon: readonly Vec2[]): Triangle[] {
  const n = polygon.length;
  if (n < 3) return [];
  // Work on an index ring, oriented CCW.
  let idx = polygon.map((_, i) => i);
  if (polygonArea(polygon) < 0) idx = idx.reverse();

  const tris: Triangle[] = [];
  let guard = 0;
  const maxGuard = n * n + 16;

  while (idx.length > 3 && guard++ < maxGuard) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i - 1 + idx.length) % idx.length]!;
      const ib = idx[i]!;
      const ic = idx[(i + 1) % idx.length]!;
      const a = polygon[ia]!;
      const b = polygon[ib]!;
      const c = polygon[ic]!;
      // Convex corner? (CCW → positive cross)
      if (cross(b.x - a.x, b.y - a.y, c.x - b.x, c.y - b.y) <= 0) continue;
      // No other vertex inside the candidate ear?
      let contains = false;
      for (let j = 0; j < idx.length; j++) {
        const ij = idx[j]!;
        if (ij === ia || ij === ib || ij === ic) continue;
        if (pointInTriangle(polygon[ij]!, a, b, c)) { contains = true; break; }
      }
      if (contains) continue;
      tris.push([ia, ib, ic]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // degenerate — stop rather than loop forever
  }
  if (idx.length === 3) tris.push([idx[0]!, idx[1]!, idx[2]!]);
  return tris;
}

/** Build a mesh from a polygon (its vertices become the mesh vertices). */
export function buildMesh(polygon: readonly Vec2[]): Mesh {
  return { vertices: polygon.map((p) => ({ x: p.x, y: p.y })), triangles: earClip(polygon) };
}

const edgeKey = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);

/**
 * Midpoint-subdivide every triangle into four, sharing edge midpoints between
 * neighbours. Adds interior vertices so skinning deforms the mesh smoothly.
 * Midpoints of a triangle are interior to it, so the mesh stays valid.
 */
export function subdivide(mesh: Mesh, iterations = 1): Mesh {
  let m = mesh;
  for (let it = 0; it < iterations; it++) {
    const vertices = m.vertices.map((v) => ({ ...v }));
    const midCache = new Map<string, number>();
    const mid = (a: number, b: number): number => {
      const key = edgeKey(a, b);
      const cached = midCache.get(key);
      if (cached !== undefined) return cached;
      const va = vertices[a]!;
      const vb = vertices[b]!;
      const i = vertices.length;
      vertices.push({ x: (va.x + vb.x) / 2, y: (va.y + vb.y) / 2 });
      midCache.set(key, i);
      return i;
    };
    const triangles: Triangle[] = [];
    for (const [a, b, c] of m.triangles) {
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      triangles.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
    }
    m = { vertices, triangles };
  }
  return m;
}
