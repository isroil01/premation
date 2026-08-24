/**
 * Polygon-with-holes triangulation — ear clipping after hole bridging.
 *
 * The cap of an extruded glyph or path is a polygon with holes (the counter
 * of an `O`, the two of a `B`). The existing `earClip` in `rig/mesh.ts` only
 * takes a SIMPLE polygon, and its inclusive point-in-triangle test rejects an
 * ear whose triangle merely TOUCHES another vertex — which every bridge edge
 * does twice. So this is a separate, self-contained implementation:
 *
 *   1. Orient the outer ring counter-clockwise and each hole clockwise.
 *   2. Bridge every hole into the outer ring (Eberly): from the hole's
 *      rightmost vertex cast a ray to +x, find the nearest outer edge it
 *      crosses, pick the visible vertex of that edge (or the reflex vertex that
 *      hides it, if any), and splice the hole in through a doubled bridge edge.
 *      Holes are processed rightmost-first so a bridge never crosses a hole
 *      that is still to be inserted.
 *   3. Clip ears off the resulting weakly-simple polygon. The inside test is
 *      STRICT and skips vertices that coincide with the ear's corners, which is
 *      what lets the doubled bridge vertices through.
 *
 * Coordinates are screen-space (y down); "counter-clockwise" here means the
 * signed shoelace area is POSITIVE in that frame, and nothing downstream needs
 * the visual handedness — only that outer and hole rings disagree.
 *
 * O(n²) on the ear search, which is fine for the sizes this sees (a traced
 * glyph is a few hundred vertices, a word a few thousand) and the result is
 * cached per outline by the caller. Pure; no DOM.
 */

export interface Pt2 {
  x: number;
  y: number;
}

export interface Ring {
  points: ReadonlyArray<Pt2>;
  hole: boolean;
}

/** Signed shoelace area (positive = "CCW" in a y-down frame, see header). */
export function signedArea(pts: ReadonlyArray<Pt2>): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += pts[j]!.x * pts[i]!.y - pts[i]!.x * pts[j]!.y;
  }
  return a / 2;
}

/** Drop consecutive duplicates (and a closing point equal to the first). */
export function dedupeRing(pts: ReadonlyArray<Pt2>, eps = 1e-6): Pt2[] {
  const out: Pt2[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < eps && Math.abs(last.y - p.y) < eps) continue;
    out.push({ x: p.x, y: p.y });
  }
  if (out.length > 1) {
    const f = out[0]!;
    const l = out[out.length - 1]!;
    if (Math.abs(f.x - l.x) < eps && Math.abs(f.y - l.y) < eps) out.pop();
  }
  return out;
}

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

/** Strictly inside the triangle (points ON an edge or AT a corner are outside). */
function strictlyInside(p: Pt2, a: Pt2, b: Pt2, c: Pt2): boolean {
  const d1 = cross(b.x - a.x, b.y - a.y, p.x - a.x, p.y - a.y);
  const d2 = cross(c.x - b.x, c.y - b.y, p.x - b.x, p.y - b.y);
  const d3 = cross(a.x - c.x, a.y - c.y, p.x - c.x, p.y - c.y);
  return (d1 > 0 && d2 > 0 && d3 > 0) || (d1 < 0 && d2 < 0 && d3 < 0);
}

function samePoint(a: Pt2, b: Pt2): boolean {
  return a.x === b.x && a.y === b.y;
}

/**
 * Splice `hole` (CW) into `outer` (CCW) through a bridge, returning the merged
 * ring. Vertices are carried as indices into `verts` so the result stays a
 * ring of indices the caller's triangles can refer to.
 */
function bridgeHole(verts: ReadonlyArray<Pt2>, outer: number[], hole: number[]): number[] {
  // Rightmost hole vertex M.
  let mi = 0;
  for (let i = 1; i < hole.length; i++) if (verts[hole[i]!]!.x > verts[hole[mi]!]!.x) mi = i;
  const M = verts[hole[mi]!]!;

  // Nearest crossing of the +x ray from M with an outer edge.
  let bestT = Infinity;
  let bestEdge = -1;
  let bestPt: Pt2 | null = null;
  for (let i = 0; i < outer.length; i++) {
    const P = verts[outer[i]!]!;
    const Q = verts[outer[(i + 1) % outer.length]!]!;
    // Only edges crossing the ray in the winding's own direction (increasing y
    // for a positive-area ring). A bridge is two coincident edges traversed in
    // opposite directions; counting both would let a later hole splice into the
    // wrong occurrence of the shared vertex and the ring would stop being
    // weakly simple.
    if (!(P.y <= M.y && Q.y > M.y)) continue;
    const t = (M.y - P.y) / (Q.y - P.y);
    const x = P.x + t * (Q.x - P.x);
    if (x < M.x) continue;
    const dist = x - M.x;
    if (dist < bestT) {
      bestT = dist;
      bestEdge = i;
      bestPt = { x, y: M.y };
    }
  }
  if (bestEdge < 0 || !bestPt) {
    // Hole outside the outer ring (degenerate input) — drop the hole.
    return outer;
  }

  // Candidate: the edge endpoint with the larger x (it is visible from M
  // unless a reflex vertex sits inside triangle (M, I, candidate)).
  const ia = bestEdge;
  const ib = (bestEdge + 1) % outer.length;
  let cand = verts[outer[ia]!]!.x > verts[outer[ib]!]!.x ? ia : ib;
  const Pc = verts[outer[cand]!]!;
  if (!samePoint(Pc, bestPt)) {
    let bestAngle = Infinity;
    let bestDist = Infinity;
    for (let i = 0; i < outer.length; i++) {
      if (i === cand) continue;
      const R = verts[outer[i]!]!;
      if (R.x < M.x || R.x > Pc.x) continue;
      if (!strictlyInside(R, M, bestPt, Pc) && !(R.y === M.y && R.x > M.x && R.x < Pc.x)) continue;
      // Reflex vertex only.
      const prev = verts[outer[(i - 1 + outer.length) % outer.length]!]!;
      const next = verts[outer[(i + 1) % outer.length]!]!;
      if (cross(R.x - prev.x, R.y - prev.y, next.x - R.x, next.y - R.y) > 0) continue;
      const dx = R.x - M.x;
      const dy = Math.abs(R.y - M.y);
      const angle = Math.atan2(dy, dx);
      const dist = dx * dx + dy * dy;
      if (angle < bestAngle || (angle === bestAngle && dist < bestDist)) {
        bestAngle = angle;
        bestDist = dist;
        cand = i;
      }
    }
  }

  // Splice: outer[0..cand], hole starting at M around to M again, outer[cand..].
  const merged: number[] = [];
  for (let i = 0; i <= cand; i++) merged.push(outer[i]!);
  for (let k = 0; k <= hole.length; k++) merged.push(hole[(mi + k) % hole.length]!);
  for (let i = cand; i < outer.length; i++) merged.push(outer[i]!);
  return merged;
}

/**
 * Triangulate one outer ring with its holes. Returns index triples into the
 * concatenated vertex list this function also returns (outer first, then holes
 * in the order given). Degenerate input yields no triangles, never throws.
 */
export function triangulateRings(outer: ReadonlyArray<Pt2>, holes: ReadonlyArray<ReadonlyArray<Pt2>> = []): {
  vertices: Pt2[];
  triangles: number[];
} {
  const verts: Pt2[] = [];
  const outerPts = dedupeRing(outer);
  if (outerPts.length < 3) return { vertices: [], triangles: [] };
  if (signedArea(outerPts) < 0) outerPts.reverse();
  const outerIdx: number[] = [];
  for (const p of outerPts) {
    outerIdx.push(verts.length);
    verts.push(p);
  }

  const holeIdx: number[][] = [];
  for (const h of holes) {
    const pts = dedupeRing(h);
    if (pts.length < 3) continue;
    if (signedArea(pts) > 0) pts.reverse(); // holes clockwise
    const idx: number[] = [];
    for (const p of pts) {
      idx.push(verts.length);
      verts.push(p);
    }
    holeIdx.push(idx);
  }
  // Rightmost holes first so a bridge cannot cross a hole still to be inserted.
  holeIdx.sort((a, b) => {
    const ax = Math.max(...a.map((i) => verts[i]!.x));
    const bx = Math.max(...b.map((i) => verts[i]!.x));
    return bx - ax;
  });

  let ring = outerIdx;
  for (const h of holeIdx) ring = bridgeHole(verts, ring, h);

  return { vertices: verts, triangles: earClipRing(verts, ring) };
}

/** Ear-clip a (weakly simple, CCW) ring of vertex indices. */
function earClipRing(verts: ReadonlyArray<Pt2>, ringIn: ReadonlyArray<number>): number[] {
  const ring = ringIn.slice();
  const tris: number[] = [];
  const n0 = ring.length;
  if (n0 < 3) return tris;

  const isConvex = (i: number): boolean => {
    const n = ring.length;
    const a = verts[ring[(i - 1 + n) % n]!]!;
    const b = verts[ring[i]!]!;
    const c = verts[ring[(i + 1) % n]!]!;
    return cross(b.x - a.x, b.y - a.y, c.x - b.x, c.y - b.y) > 0;
  };

  let guard = 0;
  let i = 0;
  while (ring.length > 3 && guard++ < n0 * n0 + 64) {
    const n = ring.length;
    const ia = ring[(i - 1 + n) % n]!;
    const ib = ring[i]!;
    const ic = ring[(i + 1) % n]!;
    const a = verts[ia]!;
    const b = verts[ib]!;
    const c = verts[ic]!;
    // Degenerate spike left by a bridge (…P, M, P…) or a collinear run: no
    // area to clip, so the vertex is simply removed — otherwise it is neither
    // convex nor reflex and the walk would circle it forever.
    const twice = cross(b.x - a.x, b.y - a.y, c.x - a.x, c.y - a.y);
    if (samePoint(a, c) || (Math.abs(twice) < 1e-9 && samePoint(a, b) === false)) {
      ring.splice(i, 1);
      if (i >= ring.length) i = 0;
      guard = 0;
      continue;
    }
    let ear = isConvex(i);
    if (ear) {
      for (let j = 0; j < n; j++) {
        const ij = ring[j]!;
        if (ij === ia || ij === ib || ij === ic) continue;
        const p = verts[ij]!;
        if (samePoint(p, a) || samePoint(p, b) || samePoint(p, c)) continue;
        if (strictlyInside(p, a, b, c)) {
          ear = false;
          break;
        }
      }
    }
    if (ear) {
      // Skip zero-area slivers but still remove the vertex.
      if (Math.abs(cross(b.x - a.x, b.y - a.y, c.x - a.x, c.y - a.y)) > 1e-9) tris.push(ia, ib, ic);
      ring.splice(i, 1);
      if (i >= ring.length) i = 0;
      guard = 0;
    } else {
      i = (i + 1) % n;
    }
  }
  if (ring.length === 3) {
    const [ia, ib, ic] = ring as [number, number, number];
    const a = verts[ia]!;
    const b = verts[ib]!;
    const c = verts[ic]!;
    if (Math.abs(cross(b.x - a.x, b.y - a.y, c.x - a.x, c.y - a.y)) > 1e-9) tris.push(ia, ib, ic);
  }
  return tris;
}

/**
 * Group rings into outer+holes sets by containment: each hole is assigned to
 * the smallest outer ring that contains its first vertex. Rings that are
 * flagged `hole` but sit in no outer ring are dropped.
 */
export function groupRings(rings: ReadonlyArray<Ring>): Array<{ outer: ReadonlyArray<Pt2>; holes: ReadonlyArray<Pt2>[] }> {
  const outers = rings.filter((r) => !r.hole && r.points.length >= 3)
    .map((r) => ({ outer: r.points, holes: [] as ReadonlyArray<Pt2>[], area: Math.abs(signedArea(r.points)) }));
  for (const h of rings) {
    if (!h.hole || h.points.length < 3) continue;
    const p = h.points[0]!;
    let best: (typeof outers)[number] | null = null;
    for (const o of outers) {
      if (pointInRing(p, o.outer) && (!best || o.area < best.area)) best = o;
    }
    if (best) best.holes.push(h.points);
  }
  return outers.map(({ outer, holes }) => ({ outer, holes }));
}

/** Even-odd point-in-polygon. */
export function pointInRing(p: Pt2, ring: ReadonlyArray<Pt2>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
