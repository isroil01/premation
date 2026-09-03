/**
 * Alpha-outline puppet meshing — After Effects' Puppet mesh for a PNG.
 *
 * AE does not lay a lattice over a layer's bounding box. It traces the ALPHA
 * OUTLINE, expands it by a few pixels, and fills the interior with triangles at
 * a chosen density. That is why pinning a hand and dragging it bends the arm:
 * the arm is its own strip of triangles, connected to the torso only where the
 * artwork is connected, so the harmonic weights that drive the deformation fall
 * off along the LIMB rather than across the empty rectangle between limb and
 * body.
 *
 * The grid path in `buildRestMesh` is the AE-1 behaviour: a uniform grid culled
 * against the alpha. It is cheap and it never tears, but a pin near a limb still
 * drags a square neighbourhood of the bounding box, so the torso smears when a
 * hand moves (measured on the reproduction character in
 * `puppetCharacterTear.test.ts`: 11.9px of torso travel per 40px hand drag on
 * the plain bbox grid, 4.1px once the grid is alpha-culled, 1.4px with the
 * outline mesh below).
 *
 * There WAS an outline path for images — `silhouetteFromCoverage` in puppet.ts —
 * and it is disabled, correctly: it kept the raw staircase of coverage-cell
 * corners as the polygon and handed it to ear clipping. Ear clipping a 168-point
 * staircase produces long slivers, and ARAP on a sliver mesh is ill-conditioned:
 * on the reproduction character that mesh flipped 61 triangles and stretched
 * edges 7x for one 40px drag. That is the "broken/torn image" in the bug report.
 * So the outline is not enough on its own — the TRIANGULATION has to be good:
 *
 *   1. marching squares over the coverage mask → closed contours (holes come out
 *      as their own loops, and `extractAlphaContours` already resolves saddles
 *      and returns a canonical start vertex, so this stays deterministic);
 *   2. Douglas–Peucker → the staircase collapses to real edges;
 *   3. outward offset by Mesh Expansion (AE's "Expansion", in px);
 *   4. boundary resampled at the density spacing + a hexagonal lattice of
 *      interior Steiner points, Delaunay-triangulated (Bowyer–Watson) and
 *      clipped back to the region.
 *
 * Hex lattice rather than square: four square-lattice corners are exactly
 * cocircular, which is the degenerate case every incremental Delaunay is worst
 * at. Offsetting alternate rows by half a step removes it by construction.
 *
 * Determinism: no clock, no randomness, fixed traversal and insertion order,
 * fixed tolerances. Same mask + same settings → bit-identical mesh, which is
 * what the rest-mesh cache and the render tests both assume.
 *
 * Every stage is total: any failure (empty mask, degenerate outline, a
 * triangulation that does not validate) returns null and the caller falls back
 * to the grid. A worse mesh is always better than a broken one.
 */

import { extractAlphaContours } from '@core/effects/vegas';
import { pointInRing, signedArea, type Pt2 } from '@core/geometry/polygonTriangulate';
import type { PuppetCoverageMask } from './puppet';

/** One connected piece of artwork: an outer ring plus the holes inside it. */
export interface AlphaRegion {
  outer: Pt2[];
  holes: Pt2[][];
}

export interface AlphaMeshGeometry {
  /** Flat [x, y, u, v, ...] in the layer's centred local space. */
  vertices: Float32Array;
  triangles: Uint16Array;
  numVertices: number;
}

/** Uint16 index buffer — the mesh must stay addressable. */
const MAX_VERTICES = 65535;
/** Point budget for the O(n²) Bowyer–Watson scan. ~2500 → ~40 ms, and cached. */
const MAX_POINTS = 2600;
/** Marching-squares threshold on the 0/255 plane the mask is expanded into. */
const MASK_THRESHOLD = 128;
/** Miter clamp on the expansion offset, so a spike does not shoot off. */
const MITER_LIMIT = 3;

// ── Outline extraction ──────────────────────────────────────────────────────

/**
 * Douglas–Peucker on an OPEN chain. Iterative (explicit stack) so a long
 * contour cannot blow the call stack; ties resolve to the lowest index.
 */
function simplifyChain(pts: readonly Pt2[], tol: number): Pt2[] {
  const n = pts.length;
  if (n <= 2) return pts.map((p) => ({ x: p.x, y: p.y }));
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!;
    if (hi - lo < 2) continue;
    const a = pts[lo]!;
    const b = pts[hi]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstD = tol;
    for (let i = lo + 1; i < hi; i++) {
      const p = pts[i]!;
      let d: number;
      if (len2 < 1e-12) {
        d = Math.hypot(p.x - a.x, p.y - a.y);
      } else {
        let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        d = Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
      }
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push([lo, worst], [worst, hi]);
  }
  const out: Pt2[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push({ x: pts[i]!.x, y: pts[i]!.y });
  return out;
}

/**
 * Douglas–Peucker on a CLOSED ring. The ring is cut at its first vertex and at
 * the vertex farthest from it — a deterministic pair of anchors that cannot
 * both be simplified away, which is what keeps the loop from collapsing.
 */
function simplifyRing(ring: readonly Pt2[], tol: number): Pt2[] {
  const n = ring.length;
  if (n < 4 || tol <= 0) return ring.map((p) => ({ x: p.x, y: p.y }));
  const a = ring[0]!;
  let far = 1;
  let farD = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(ring[i]!.x - a.x, ring[i]!.y - a.y);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const first = simplifyChain(ring.slice(0, far + 1), tol);
  const second = simplifyChain([...ring.slice(far), ring[0]!], tol);
  // Both chains carry their shared endpoints; drop the duplicates.
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

/** Drop consecutive duplicate vertices (and a closing repeat of the first). */
function dedupe(ring: readonly Pt2[], eps: number): Pt2[] {
  const out: Pt2[] = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < eps && Math.abs(last.y - p.y) < eps) continue;
    out.push({ x: p.x, y: p.y });
  }
  while (out.length > 1) {
    const f = out[0]!;
    const l = out[out.length - 1]!;
    if (Math.abs(f.x - l.x) < eps && Math.abs(f.y - l.y) < eps) out.pop();
    else break;
  }
  return out;
}

/** Force positive shoelace orientation (see polygonTriangulate's header). */
function orientPositive(ring: Pt2[]): Pt2[] {
  return signedArea(ring) < 0 ? ring.slice().reverse() : ring;
}

/**
 * Offset a positively-oriented ring by `d` along its outward normals (negative
 * `d` shrinks it). Vertex normals are the bisector of the two incident edge
 * normals, scaled by 1/cos(half-angle) so straight runs stay parallel, with a
 * miter clamp on sharp corners.
 *
 * This is a MITER offset, not a full polygon-offset with self-intersection
 * repair: at the expansions this is used for (0–100px against artwork tens of
 * px across) a clamped miter is stable, and the triangulator's region test
 * discards anything that folds.
 */
function offsetRing(ring: readonly Pt2[], d: number): Pt2[] {
  const n = ring.length;
  if (n < 3 || d === 0) return ring.map((p) => ({ x: p.x, y: p.y }));
  // Outward normal of an edge on a positively-oriented ring is (dy, -dx).
  const nx = new Float64Array(n);
  const ny = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % n]!;
    const ex = q.x - p.x;
    const ey = q.y - p.y;
    const len = Math.hypot(ex, ey);
    if (len < 1e-9) continue;
    nx[i] = ey / len;
    ny[i] = -ex / len;
  }
  const out: Pt2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = (i - 1 + n) % n;
    let bx = nx[prev]! + nx[i]!;
    let by = ny[prev]! + ny[i]!;
    const len = Math.hypot(bx, by);
    if (len < 1e-9) {
      bx = nx[i]!;
      by = ny[i]!;
    } else {
      bx /= len;
      by /= len;
    }
    const cos = bx * nx[i]! + by * ny[i]!;
    const scale = Math.min(MITER_LIMIT, 1 / Math.max(0.25, cos));
    out.push({ x: ring[i]!.x + bx * d * scale, y: ring[i]!.y + by * d * scale });
  }
  return out;
}

/**
 * Trace a coverage mask into simplified, expanded outline REGIONS in the
 * layer's centred local space.
 *
 * `expansion` grows the artwork outward in layer px (AE's Expansion). Holes are
 * shrunk by the same amount, which is the same thing said from inside.
 */
export function alphaOutlineRegions(
  mask: PuppetCoverageMask,
  width: number,
  height: number,
  expansion = 0,
): AlphaRegion[] {
  const { cols, rows, cells } = mask;
  if (cols < 1 || rows < 1 || width <= 0 || height <= 0) return [];
  if (cells.length < cols * rows) return [];

  // Marching squares wants an alpha plane, not a bit mask.
  const plane = new Uint8Array(cols * rows);
  for (let i = 0; i < plane.length; i++) plane[i] = cells[i] ? 255 : 0;

  const contours = extractAlphaContours(plane, cols, rows, MASK_THRESHOLD);
  if (contours.length === 0) return [];

  // Contour coordinates are in mask-CELL-CENTRE units: (0,0) is the centre of
  // the top-left cell. Map to the centred local space the mesh and pins live in.
  const cellW = width / cols;
  const cellH = height / rows;
  const toLocal = (p: Pt2): Pt2 => ({
    x: ((p.x + 0.5) / cols - 0.5) * width,
    y: ((p.y + 0.5) / rows - 0.5) * height,
  });

  // Simplify away the staircase. Half a cell is enough to straighten a 45°
  // run without eating a real corner.
  const tol = Math.max(0.25, Math.min(cellW, cellH) * 0.5);
  const eps = Math.min(cellW, cellH) * 1e-3;
  const minArea = Math.max(1, width * height * 1e-4);

  const rings: Array<{ points: Pt2[]; hole: boolean; area: number }> = [];
  for (const c of contours) {
    const local = dedupe(c.map(toLocal), eps);
    if (local.length < 3) continue;
    const simple = dedupe(simplifyRing(local, tol), eps);
    if (simple.length < 3) continue;
    const area = signedArea(simple);
    if (Math.abs(area) < minArea) continue;
    rings.push({ points: simple, hole: false, area: Math.abs(area) });
  }
  if (rings.length === 0) return [];

  // Containment depth decides outer vs hole: a ring nested an odd number of
  // times is a hole. Orientation alone is not trusted — a shape that touches
  // the layer edge can produce a contour the marching-squares border wraps the
  // other way around.
  const depth = rings.map((r, i) => {
    let d = 0;
    for (let j = 0; j < rings.length; j++) {
      if (i === j) continue;
      if (rings[j]!.area > r.area && pointInRing(r.points[0]!, rings[j]!.points)) d++;
    }
    return d;
  });

  const regions: AlphaRegion[] = [];
  const outerIndex = new Map<number, number>();
  for (let i = 0; i < rings.length; i++) {
    if (depth[i]! % 2 !== 0) continue;
    outerIndex.set(i, regions.length);
    regions.push({ outer: orientPositive(rings[i]!.points), holes: [] });
  }
  for (let i = 0; i < rings.length; i++) {
    if (depth[i]! % 2 === 0) continue;
    // Smallest even-depth ring that contains this hole owns it.
    let best = -1;
    let bestArea = Infinity;
    for (const [j, ri] of outerIndex) {
      if (rings[j]!.area <= rings[i]!.area) continue;
      if (!pointInRing(rings[i]!.points[0]!, rings[j]!.points)) continue;
      if (rings[j]!.area < bestArea) {
        bestArea = rings[j]!.area;
        best = ri;
      }
    }
    if (best >= 0) regions[best]!.holes.push(orientPositive(rings[i]!.points));
  }

  if (expansion !== 0) {
    for (const r of regions) {
      r.outer = dedupe(offsetRing(r.outer, expansion), eps);
      r.holes = r.holes
        .map((h) => dedupe(offsetRing(h, -expansion), eps))
        .filter((h) => h.length >= 3 && Math.abs(signedArea(h)) >= minArea);
    }
  }

  return regions.filter((r) => r.outer.length >= 3);
}

// ── Point sampling ──────────────────────────────────────────────────────────

/** Resample a closed ring so no edge is longer than `spacing`. Corners kept. */
function resampleRing(ring: readonly Pt2[], spacing: number): Pt2[] {
  const out: Pt2[] = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    out.push({ x: a.x, y: a.y });
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.floor(len / spacing);
    for (let k = 1; k <= steps; k++) {
      const t = k / (steps + 1);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

/** Squared distance from p to segment ab. */
function distSqToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 < 1e-12 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t;
  const qy = ay + dy * t;
  return (px - qx) * (px - qx) + (py - qy) * (py - qy);
}

function insideRegion(p: Pt2, region: AlphaRegion): boolean {
  if (!pointInRing(p, region.outer)) return false;
  for (const h of region.holes) if (pointInRing(p, h)) return false;
  return true;
}

// ── Delaunay (Bowyer–Watson) ────────────────────────────────────────────────

/** 2× signed area of the triangle abc; positive = positively oriented. */
function cross2(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
}

/**
 * Bowyer–Watson triangulation of a point set. Triangles come back positively
 * oriented, as index triples. Returns null when the incremental insertion
 * cannot keep a valid triangulation (the caller then falls back).
 *
 * Deterministic: points are inserted in the given order and every scan runs in
 * index order — no hashing over object identity, no randomised rebucketing.
 */
function delaunay(px: Float64Array, py: Float64Array, n: number): Int32Array | null {
  if (n < 3) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    if (px[i]! < minX) minX = px[i]!;
    if (px[i]! > maxX) maxX = px[i]!;
    if (py[i]! < minY) minY = py[i]!;
    if (py[i]! > maxY) maxY = py[i]!;
  }
  const span = Math.max(maxX - minX, maxY - minY, 1e-6);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const R = span * 20;

  // Super-triangle vertices live past the end of the real point arrays.
  const X = new Float64Array(n + 3);
  const Y = new Float64Array(n + 3);
  X.set(px.subarray(0, n));
  Y.set(py.subarray(0, n));
  X[n] = cx - R;
  Y[n] = cy - R;
  X[n + 1] = cx + R;
  Y[n + 1] = cy - R;
  X[n + 2] = cx;
  Y[n + 2] = cy + R;

  /** Triangles as flat index triples; `dead` marks removed slots. */
  const tri: number[] = [n, n + 1, n + 2];
  const dead: boolean[] = [false];
  // Orient the super-triangle positively so the incircle test has a fixed sign.
  if (cross2(X[n]!, Y[n]!, X[n + 1]!, Y[n + 1]!, X[n + 2]!, Y[n + 2]!) < 0) {
    tri[1] = n + 2;
    tri[2] = n + 1;
  }

  // Scale-normalised tolerance: the incircle determinant is degree 4 in the
  // coordinates, so the epsilon has to scale the same way or it means nothing
  // at one layer size and everything at another.
  const eps = span * span * span * span * 1e-12;

  const inCircle = (a: number, b: number, c: number, d: number): boolean => {
    const adx = X[a]! - X[d]!;
    const ady = Y[a]! - Y[d]!;
    const bdx = X[b]! - X[d]!;
    const bdy = Y[b]! - Y[d]!;
    const cdx = X[c]! - X[d]!;
    const cdy = Y[c]! - Y[d]!;
    const det =
      (adx * adx + ady * ady) * (bdx * cdy - cdx * bdy) -
      (bdx * bdx + bdy * bdy) * (adx * cdy - cdx * ady) +
      (cdx * cdx + cdy * cdy) * (adx * bdy - bdx * ady);
    return det > eps;
  };

  const badTris: number[] = [];
  const edges: number[] = [];
  for (let p = 0; p < n; p++) {
    badTris.length = 0;
    for (let t = 0; t < dead.length; t++) {
      if (dead[t]) continue;
      if (inCircle(tri[t * 3]!, tri[t * 3 + 1]!, tri[t * 3 + 2]!, p)) badTris.push(t);
    }
    if (badTris.length === 0) continue; // exact duplicate / cocircular — skip it
    // Cavity boundary: the edges of the bad set that appear exactly once.
    edges.length = 0;
    for (const t of badTris) {
      for (let k = 0; k < 3; k++) {
        const a = tri[t * 3 + k]!;
        const b = tri[t * 3 + ((k + 1) % 3)]!;
        let dup = -1;
        for (let e = 0; e < edges.length; e += 2) {
          if (edges[e] === b && edges[e + 1] === a) {
            dup = e;
            break;
          }
        }
        if (dup >= 0) {
          edges[dup] = -1;
          edges[dup + 1] = -1;
        } else {
          edges.push(a, b);
        }
      }
    }
    for (const t of badTris) dead[t] = true;
    let added = 0;
    for (let e = 0; e < edges.length; e += 2) {
      const a = edges[e]!;
      const b = edges[e + 1]!;
      if (a < 0) continue;
      if (Math.abs(cross2(X[a]!, Y[a]!, X[b]!, Y[b]!, X[p]!, Y[p]!)) < 1e-12) continue;
      tri.push(a, b, p);
      dead.push(false);
      added++;
    }
    if (added === 0) return null; // cavity collapsed — refuse rather than corrupt
  }

  const out: number[] = [];
  for (let t = 0; t < dead.length; t++) {
    if (dead[t]) continue;
    const a = tri[t * 3]!;
    const b = tri[t * 3 + 1]!;
    const c = tri[t * 3 + 2]!;
    if (a >= n || b >= n || c >= n) continue; // touches the super-triangle
    if (cross2(X[a]!, Y[a]!, X[b]!, Y[b]!, X[c]!, Y[c]!) > 0) out.push(a, b, c);
    else out.push(a, c, b);
  }
  return out.length >= 3 ? Int32Array.from(out) : null;
}

// ── Assembly ────────────────────────────────────────────────────────────────

/**
 * `meshDensity` (2–50, the same slider the grid path uses) → triangle spacing in
 * layer px. Density d puts roughly d triangles across the layer's longest side,
 * so a given density produces a comparable triangle size in both modes.
 */
export function densityToSpacing(width: number, height: number, density: number): number {
  const d = Math.max(2, Math.min(50, Math.round(density)));
  return Math.max(1, Math.max(width, height) / d);
}

/**
 * Triangulate one region: boundary resampled at `spacing`, a hexagonal lattice
 * of interior Steiner points, Delaunay, then clipped back to the region.
 *
 * The clip tests the centroid AND the three edge midpoints. The centroid alone
 * lets a triangle bridge a narrow concavity (the gap between two fingers, the
 * armpit) — its centroid can sit inside the artwork while two of its edges cross
 * empty space. Both tests together are a cheap stand-in for a constrained
 * Delaunay, exact whenever the boundary is sampled at least as finely as the
 * local feature size, which `spacing` guarantees for anything the mask resolves.
 */
function triangulateRegion(
  region: AlphaRegion,
  spacing: number,
): { pts: Pt2[]; tris: number[] } | 'over-budget' | null {
  const rings = [region.outer, ...region.holes];
  const pts: Pt2[] = [];
  for (const r of rings) pts.push(...resampleRing(r, spacing));
  if (pts.length < 3) return null;

  // Interior lattice. Odd rows shift half a step so no four points are
  // cocircular — the degenerate case incremental Delaunay handles worst.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of region.outer) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const rowH = spacing * 0.866; // equilateral row height
  const clearance = spacing * 0.5;
  const clearance2 = clearance * clearance;
  const segs: number[] = [];
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      const a = r[i]!;
      const b = r[(i + 1) % r.length]!;
      segs.push(a.x, a.y, b.x, b.y);
    }
  }
  let row = 0;
  for (let y = minY + rowH * 0.5; y < maxY; y += rowH, row++) {
    const xOff = row % 2 === 0 ? 0 : spacing * 0.5;
    for (let x = minX + xOff + spacing * 0.5; x < maxX; x += spacing) {
      const p = { x, y };
      if (!insideRegion(p, region)) continue;
      let ok = true;
      for (let s = 0; s < segs.length; s += 4) {
        if (distSqToSegment(x, y, segs[s]!, segs[s + 1]!, segs[s + 2]!, segs[s + 3]!) < clearance2) {
          ok = false;
          break;
        }
      }
      if (ok) pts.push(p);
    }
  }

  const n = pts.length;
  if (n < 3) return null;
  // Distinguished from "cannot mesh this": the caller must COARSEN and retry,
  // not drop the region. Dropping it silently deleted the biggest piece of the
  // artwork — the torso — and meshed only the specks that fitted.
  if (n > MAX_POINTS) return 'over-budget';
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    px[i] = pts[i]!.x;
    py[i] = pts[i]!.y;
  }
  const idx = delaunay(px, py, n);
  if (!idx) return null;

  const tris: number[] = [];
  const minTriArea = spacing * spacing * 1e-3;
  for (let t = 0; t < idx.length; t += 3) {
    const a = pts[idx[t]!]!;
    const b = pts[idx[t + 1]!]!;
    const c = pts[idx[t + 2]!]!;
    if (Math.abs(cross2(a.x, a.y, b.x, b.y, c.x, c.y)) / 2 < minTriArea) continue;
    const centroid = { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3 };
    if (!insideRegion(centroid, region)) continue;
    if (!insideRegion({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, region)) continue;
    if (!insideRegion({ x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 }, region)) continue;
    if (!insideRegion({ x: (c.x + a.x) / 2, y: (c.y + a.y) / 2 }, region)) continue;
    tris.push(idx[t]!, idx[t + 1]!, idx[t + 2]!);
  }
  return tris.length >= 3 ? { pts, tris } : null;
}

/**
 * The puppet rest geometry for an image layer, traced from its alpha.
 *
 * Returns null for anything it cannot mesh well — an empty mask, an outline
 * below a usable area, a point budget blown at every density it will try, a
 * triangulation that does not validate — so `buildRestMesh` falls back to the
 * grid rather than shipping a broken mesh.
 *
 * Only vertices that carry artwork are emitted, so an island the triangulator
 * dropped costs nothing, and unreferenced boundary samples are compacted away
 * (their indices would otherwise be dead weight in every weight column).
 */
export function buildAlphaOutlineGeometry(
  width: number,
  height: number,
  pad: number,
  density: number,
  expansion: number,
  mask: PuppetCoverageMask,
): AlphaMeshGeometry | null {
  const regions = alphaOutlineRegions(mask, width, height, expansion);
  if (regions.length === 0) return null;

  const base = densityToSpacing(width, height, density);
  // Coarsen and retry rather than fail: a dense setting on a big layer blows the
  // point budget, and a slightly coarser mesh beats falling back to the bbox grid.
  for (let attempt = 0; attempt < 4; attempt++) {
    const spacing = base * Math.pow(1.6, attempt);
    const verts: Pt2[] = [];
    const tris: number[] = [];
    let ok = true;
    for (const region of regions) {
      const r = triangulateRegion(region, spacing);
      if (r === 'over-budget') {
        ok = false;
        break;
      }
      // A region too small for this spacing is skipped, not fatal: a stray
      // 3-cell speck of alpha should not deny the character a mesh.
      if (!r) continue;
      const offset = verts.length;
      for (const p of r.pts) verts.push(p);
      for (const i of r.tris) tris.push(i + offset);
      if (verts.length > MAX_VERTICES) {
        ok = false;
        break;
      }
    }
    if (!ok || tris.length < 3) continue;

    // Compact to referenced vertices only.
    const remap = new Int32Array(verts.length).fill(-1);
    let next = 0;
    for (const i of tris) if (remap[i]! < 0) remap[i] = next++;
    if (next > MAX_VERTICES) continue;

    const vertices = new Float32Array(next * 4);
    const halfW = width / 2;
    const halfH = height / 2;
    for (let i = 0; i < verts.length; i++) {
      const m = remap[i]!;
      if (m < 0) continue;
      const p = verts[i]!;
      vertices[m * 4 + 0] = p.x;
      vertices[m * 4 + 1] = p.y;
      // Same UV mapping as every other mesh path: into the padded raster.
      vertices[m * 4 + 2] = (p.x + halfW + pad) / (width + 2 * pad);
      vertices[m * 4 + 3] = (p.y + halfH + pad) / (height + 2 * pad);
    }
    const triangles = new Uint16Array(tris.length);
    for (let i = 0; i < tris.length; i++) triangles[i] = remap[tris[i]!]!;
    return { vertices, triangles, numVertices: next };
  }
  return null;
}
