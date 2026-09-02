/**
 * Knife — cut bezier paths with a straight line.
 *
 * The geometry behind the Knife tool. Given the app's path currency (anchors
 * with ABSOLUTE in/out handles, `open` telling a stroke from a region) and two
 * points, every place the line crosses a path becomes a split:
 *
 *   • an OPEN path becomes two (or more) open paths — just cut the ribbon;
 *   • a CLOSED path becomes two (or more) closed paths, each side capped along
 *     the cut line, so both halves are still fillable regions.
 *
 * ## Why exact roots rather than flattening
 *
 * `mergePaths` flattens outlines before its boolean because polygon-clipping
 * needs polygons; the result is polygonal and that is accepted there. A knife
 * must NOT do that. Cutting a curve should leave two curves — flattening would
 * silently replace a designed outline with a 200-point polyline the moment the
 * user cut it, and there is no undo for lost curvature.
 *
 * So the crossing parameters come from actual root-finding. For a cubic
 * segment P(t) and the line through a→b, the signed side
 *
 *     f(p) = (b−a) × (p−a)
 *
 * is AFFINE in p, so f(P(t)) is itself a cubic in t whose Bernstein
 * coefficients are just f applied to the four control points. Its roots are the
 * crossings; de Casteljau splits the segment there exactly. No sampling, no
 * tolerance on the geometry — only on the root solve, which is bisection inside
 * intervals delimited by the derivative's roots and therefore always converges.
 *
 * ## Capping a closed path
 *
 * Splitting alone leaves open arcs. To close each side, the cut line's own
 * crossings are sorted ALONG the line: for a closed outline the intervals
 * between sorted crossings alternate inside/outside, so pairs (0,1), (2,3), …
 * are exactly the segments of the line that lie inside the shape. Those are the
 * cap edges, shared by both sides with opposite orientation. Walking
 * arc → cap → arc rebuilds every loop of both halves — which is why a concave
 * shape cut once can correctly come back as three pieces, not two.
 *
 * ## The line is INFINITE
 *
 * `a`/`b` define a line, not a segment. A knife that stopped where the drag
 * stopped would leave a shape half-cut — a path with a slit in it, which is not
 * a state this path model can express (a region is one closed run). Extending
 * the cut is the only interpretation that always yields valid geometry, and it
 * matches what the user sees: the tool draws the line across the whole layer.
 */

/** One anchor: position plus absolute in/out handles (the app's BezierPoint). */
export interface CutPoint {
  x: number;
  y: number;
  inX: number;
  inY: number;
  outX: number;
  outY: number;
}

/** One run of a path. `open` distinguishes a stroke from a fillable region. */
export interface CutSubpath {
  points: CutPoint[];
  open: boolean;
}

export interface CutVec {
  x: number;
  y: number;
}

/** A cubic segment as its four control points. */
type Seg = readonly [CutVec, CutVec, CutVec, CutVec];

/** Below this the two endpoints are the same point, and there is no line. */
const MIN_LINE_LENGTH = 1e-9;

/** Path-parameter slack for "this crossing is at an anchor, not inside a segment". */
const ANCHOR_EPS = 1e-7;

/** Two crossings closer than this along the path are the same crossing. */
const MERGE_EPS = 1e-6;

/** Rings thinner than this are the cut line grazing an edge — drop them. */
const MIN_RING_AREA = 1e-9;

// ── Small vector helpers ───────────────────────────────────────────

function lerp(p: CutVec, q: CutVec, t: number): CutVec {
  return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
}

function corner(p: CutVec): CutPoint {
  return { x: p.x, y: p.y, inX: p.x, inY: p.y, outX: p.x, outY: p.y };
}

// ── Segment extraction / reassembly ────────────────────────────────

/**
 * A run's cubic segments. A closed run wraps (n segments for n anchors); an
 * open one stops at the last anchor (n−1).
 *
 * Straight sides come out as cubics with the handles collapsed onto their
 * anchors, which is exactly how the rest of the app stores a corner — so a
 * rectangle round-trips through here byte-identically when nothing crosses it.
 */
function segmentsOf(run: CutSubpath): Seg[] {
  const pts = run.points;
  const n = pts.length;
  if (n < 2) return [];
  const count = run.open ? n - 1 : n;
  const segs: Seg[] = [];
  for (let i = 0; i < count; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    segs.push([
      { x: a.x, y: a.y },
      { x: a.outX, y: a.outY },
      { x: b.inX, y: b.inY },
      { x: b.x, y: b.y },
    ]);
  }
  return segs;
}

/** de Casteljau: the piece of `s` between t0 and t1 (0 ≤ t0 ≤ t1 ≤ 1). */
function subSegment(s: Seg, t0: number, t1: number): Seg {
  // Split at t1 first and keep the left half, then re-parameterise t0 into it.
  const right = splitRight(s, t0);
  const u = t1 <= t0 ? 0 : (t1 - t0) / (1 - t0);
  return splitLeft(right, Math.min(1, Math.max(0, u)));
}

function splitLeft(s: Seg, t: number): Seg {
  const p01 = lerp(s[0], s[1], t);
  const p12 = lerp(s[1], s[2], t);
  const p23 = lerp(s[2], s[3], t);
  const p012 = lerp(p01, p12, t);
  const p123 = lerp(p12, p23, t);
  const p = lerp(p012, p123, t);
  return [s[0], p01, p012, p];
}

function splitRight(s: Seg, t: number): Seg {
  if (t <= 0) return s;
  const p01 = lerp(s[0], s[1], t);
  const p12 = lerp(s[1], s[2], t);
  const p23 = lerp(s[2], s[3], t);
  const p012 = lerp(p01, p12, t);
  const p123 = lerp(p12, p23, t);
  const p = lerp(p012, p123, t);
  return [p, p123, p23, s[3]];
}

function segAt(s: Seg, t: number): CutVec {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * s[0].x + w1 * s[1].x + w2 * s[2].x + w3 * s[3].x,
    y: w0 * s[0].y + w1 * s[1].y + w2 * s[2].y + w3 * s[3].y,
  };
}

/** Turn a chain of segments back into anchors with absolute handles. */
function chainToRun(segs: readonly Seg[], closed: boolean): CutSubpath | null {
  if (segs.length === 0) return null;
  const points: CutPoint[] = [];
  const first = segs[0]!;
  const last = segs[segs.length - 1]!;
  points.push({
    x: first[0].x,
    y: first[0].y,
    // A closed chain's first anchor inherits the incoming handle of the
    // segment that wraps into it; an open chain starts on a corner.
    inX: closed ? last[2].x : first[0].x,
    inY: closed ? last[2].y : first[0].y,
    outX: first[1].x,
    outY: first[1].y,
  });
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i]!;
    const next = segs[i + 1]!;
    points.push({
      x: s[3].x,
      y: s[3].y,
      inX: s[2].x,
      inY: s[2].y,
      outX: next[1].x,
      outY: next[1].y,
    });
  }
  if (!closed) {
    points.push({ x: last[3].x, y: last[3].y, inX: last[2].x, inY: last[2].y, outX: last[3].x, outY: last[3].y });
  }
  if (points.length < 2) return null;
  return { points, open: !closed };
}

// ── Root finding: where a cubic segment crosses the line ───────────

/** Bernstein cubic evaluated at t, from its four scalar coefficients. */
function bezier1(w0: number, w1: number, w2: number, w3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * w0 + 3 * u * u * t * w1 + 3 * u * t * t * w2 + t * t * t * w3;
}

/**
 * Roots of the scalar cubic in [0,1], by bisection on the intervals its
 * derivative carves out.
 *
 * Not Cardano: the closed form loses precision badly near double roots, which
 * is precisely the tangency case a knife hits every time it grazes an edge.
 * Splitting at the derivative's roots makes each interval monotone, so a sign
 * change there is a single root and bisection cannot miss or double-count it.
 */
function cubicRoots01(w0: number, w1: number, w2: number, w3: number): number[] {
  const f = (t: number): number => bezier1(w0, w1, w2, w3, t);
  // Power basis, needed only to differentiate.
  const c1 = 3 * (w1 - w0);
  const c2 = 3 * (w2 - 2 * w1 + w0);
  const c3 = w3 - 3 * w2 + 3 * w1 - w0;

  const crit: number[] = [];
  const da = 3 * c3;
  const db = 2 * c2;
  const dc = c1;
  if (Math.abs(da) < 1e-14) {
    if (Math.abs(db) > 1e-14) crit.push(-dc / db);
  } else {
    const disc = db * db - 4 * da * dc;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      crit.push((-db + sq) / (2 * da), (-db - sq) / (2 * da));
    }
  }

  const bounds = [0, ...crit.filter((t) => t > 0 && t < 1), 1].sort((p, q) => p - q);
  const roots: number[] = [];
  const push = (t: number): void => {
    const clamped = Math.min(1, Math.max(0, t));
    if (!roots.some((r) => Math.abs(r - clamped) < 1e-9)) roots.push(clamped);
  };

  for (let i = 0; i < bounds.length - 1; i++) {
    let lo = bounds[i]!;
    let hi = bounds[i + 1]!;
    if (hi - lo < 1e-12) continue;
    let flo = f(lo);
    const fhi = f(hi);
    if (flo === 0) push(lo);
    if (fhi === 0) push(hi);
    if (flo === 0 || fhi === 0 || flo * fhi > 0) continue;
    // 70 halvings takes a unit interval below double precision.
    for (let k = 0; k < 70; k++) {
      const mid = (lo + hi) / 2;
      const fm = f(mid);
      if (fm === 0) {
        lo = mid;
        hi = mid;
        break;
      }
      if (flo * fm < 0) {
        hi = mid;
      } else {
        lo = mid;
        flo = fm;
      }
    }
    push((lo + hi) / 2);
  }
  return roots.sort((p, q) => p - q);
}

// ── The cut ────────────────────────────────────────────────────────

interface Crossing {
  /** Global path parameter: segment index + t, in [0, segCount). */
  u: number;
  point: CutVec;
  /** Position along the cut line, for the inside/outside pairing. */
  s: number;
}

/**
 * Cut every run in `paths` with the line through `a`→`b`.
 *
 * Returns the SAME array instance when the line crosses nothing, so a caller
 * can test `result === paths` to decide whether the gesture did anything at all
 * — cheaper and more honest than deep-comparing float geometry.
 *
 * All coordinates are in ONE space; the caller decides which. The Knife tool
 * measures in world space and converts both the drag and the result through the
 * layer's own matrix, because a layer's stored points are local.
 */
export function cutPathsWithLine(
  paths: readonly CutSubpath[],
  a: CutVec,
  b: CutVec,
): CutSubpath[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < MIN_LINE_LENGTH) return paths as CutSubpath[];

  const side = (p: CutVec): number => dx * (p.y - a.y) - dy * (p.x - a.x);
  const along = (p: CutVec): number => ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;

  const out: CutSubpath[] = [];
  let cutAny = false;
  for (const run of paths) {
    const pieces = cutRun(run, side, along);
    if (pieces === null) {
      out.push(run);
    } else {
      cutAny = true;
      out.push(...pieces);
    }
  }
  return cutAny ? out : (paths as CutSubpath[]);
}

/** One run. `null` means "the line does not cut this", so keep the original. */
function cutRun(
  run: CutSubpath,
  side: (p: CutVec) => number,
  along: (p: CutVec) => number,
): CutSubpath[] | null {
  const segs = segmentsOf(run);
  const n = segs.length;
  if (n === 0) return null;

  // ── 1. Candidate crossing parameters, canonicalised to the path ──
  const candidates: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = segs[i]!;
    const w0 = side(s[0]);
    const w1 = side(s[1]);
    const w2 = side(s[2]);
    const w3 = side(s[3]);
    // The whole segment lies on the line — a cut along an existing edge. There
    // is no crossing to find and splitting there would emit zero-area rings.
    if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0) continue;
    for (const t of cubicRoots01(w0, w1, w2, w3)) {
      // A root at a segment END is the same POINT as the next segment's start.
      // Snapping to the anchor keeps a corner-crossing from being found twice
      // and from splitting off a zero-length arc.
      let u = i + t;
      if (t > 1 - ANCHOR_EPS) u = i + 1;
      else if (t < ANCHOR_EPS) u = i;
      if (!run.open && u >= n) u -= n;
      if (run.open && u > n) u = n;
      candidates.push(u);
    }
  }
  if (candidates.length === 0) return null;

  candidates.sort((p, q) => p - q);
  const unique: number[] = [];
  for (const u of candidates) {
    const last = unique[unique.length - 1];
    if (last === undefined || u - last > MERGE_EPS) unique.push(u);
  }

  // ── 2. Keep only the ones where the side genuinely FLIPS ─────────
  // A tangency — the line kissing a curve's extremum, or touching a corner
  // without passing through — is a root but not a crossing. Splitting there
  // would produce a piece with an empty interior on one side of a "cut" that
  // never divided anything.
  const evalAt = (u: number): number => {
    let v = u;
    if (!run.open) {
      v = ((v % n) + n) % n;
    } else {
      v = Math.min(n, Math.max(0, v));
    }
    let i = Math.floor(v);
    let t = v - i;
    if (i >= n) {
      i = n - 1;
      t = 1;
    }
    return side(segAt(segs[i]!, t));
  };

  const crossings: Crossing[] = [];
  for (let k = 0; k < unique.length; k++) {
    const u = unique[k]!;
    const prev = unique[(k - 1 + unique.length) % unique.length]!;
    const next = unique[(k + 1) % unique.length]!;
    const gapBack = k === 0 ? (run.open ? u : u + n - prev) : u - prev;
    const gapFwd = k === unique.length - 1 ? (run.open ? n - u : next + n - u) : next - u;
    const delta = Math.min(1e-3, Math.max(1e-9, gapBack / 3), Math.max(1e-9, gapFwd / 3));
    if (run.open && (u <= ANCHOR_EPS || u >= n - ANCHOR_EPS)) continue; // endpoint, nothing to split
    const before = evalAt(u - delta);
    const after = evalAt(u + delta);
    if (before === 0 || after === 0 || before * after > 0) continue;
    let i = Math.floor(u);
    let t = u - i;
    if (i >= n) {
      i = n - 1;
      t = 1;
    }
    const point = segAt(segs[i]!, t);
    crossings.push({ u, point, s: along(point) });
  }
  if (crossings.length === 0) return null;

  // ── 3. Split the run into arcs at those parameters ───────────────
  const arcs = splitIntoArcs(segs, crossings.map((c) => c.u), run.open);
  if (arcs.length < 2) return null;

  if (run.open) {
    const runs = arcs
      .map((arc) => chainToRun(arc.segs, false))
      .filter((r): r is CutSubpath => r !== null);
    return runs.length >= 2 ? runs : null;
  }

  // ── 4. Closed: cap each side along the line ──────────────────────
  return capClosed(arcs, crossings, side);
}

interface Arc {
  segs: Seg[];
  /** Index into `crossings` of the crossing this arc starts / ends at. */
  startCrossing: number;
  endCrossing: number;
}

/**
 * Cut the segment list at each parameter, yielding arcs between consecutive
 * crossings. A closed run's arcs are cyclic, so the piece that runs off the end
 * of the last segment is the same arc as the one that starts at u=0 — they are
 * emitted as ONE arc rather than two, or every closed cut would come back with
 * a spurious seam at the path's arbitrary start point.
 */
function splitIntoArcs(segs: readonly Seg[], us: readonly number[], open: boolean): Arc[] {
  const n = segs.length;
  const arcs: Arc[] = [];
  if (open) {
    const bounds = [0, ...us, n];
    for (let i = 0; i < bounds.length - 1; i++) {
      const lo = bounds[i]!;
      const hi = bounds[i + 1]!;
      if (hi - lo < MERGE_EPS) continue;
      // An open run's arcs are never re-joined, so they carry no crossing
      // identity — capping is a closed-path concern.
      arcs.push({ segs: extract(segs, lo, hi, n), startCrossing: -1, endCrossing: -1 });
    }
    return arcs;
  }
  for (let i = 0; i < us.length; i++) {
    const lo = us[i]!;
    const hiRaw = us[(i + 1) % us.length]!;
    const hi = i === us.length - 1 ? hiRaw + n : hiRaw;
    if (hi - lo < MERGE_EPS) continue;
    arcs.push({ segs: extract(segs, lo, hi, n), startCrossing: i, endCrossing: (i + 1) % us.length });
  }
  return arcs;
}

/** The chain of segments between two global path parameters (u1 may exceed n). */
function extract(segs: readonly Seg[], u0: number, u1: number, n: number): Seg[] {
  const out: Seg[] = [];
  let i = Math.floor(u0 + 1e-12);
  let t0 = u0 - i;
  if (t0 < 0) t0 = 0;
  // Guard rather than `while (true)`: a NaN parameter would otherwise spin.
  for (let guard = 0; guard <= n + 2; guard++) {
    const rel = u1 - i;
    const seg = segs[((i % n) + n) % n]!;
    if (rel <= 1 + 1e-12) {
      const t1 = Math.min(1, rel);
      if (t1 - t0 > 1e-12) out.push(subSegment(seg, t0, t1));
      break;
    }
    if (1 - t0 > 1e-12) out.push(subSegment(seg, t0, 1));
    i += 1;
    t0 = 0;
  }
  return out;
}

/**
 * Rebuild both halves of a cut closed outline.
 *
 * See the header: the sorted crossings pair up into the intervals of the line
 * that lie INSIDE the outline, and those intervals are the cap edges. Walking
 * arc → cap → arc closes every loop on a side. If the walk ever lands on an arc
 * belonging to the other side the pairing was wrong for this geometry (a
 * self-intersecting outline, a cut that grazes a vertex), and the honest answer
 * is to leave the layer alone rather than emit a scrambled shape.
 */
function capClosed(arcs: Arc[], crossings: Crossing[], side: (p: CutVec) => number): CutSubpath[] | null {
  const k = crossings.length;
  if (k < 2 || k % 2 !== 0) return null;
  if (arcs.length !== k) return null;

  const order = crossings.map((_, i) => i).sort((p, q) => crossings[p]!.s - crossings[q]!.s);
  const partner = new Array<number>(k).fill(-1);
  for (let i = 0; i + 1 < order.length; i += 2) {
    const p = order[i]!;
    const q = order[i + 1]!;
    partner[p] = q;
    partner[q] = p;
  }
  if (partner.some((p) => p < 0)) return null;

  // Which arc starts at each crossing, and which side that arc is on.
  const arcAtStart = new Array<number>(k).fill(-1);
  const arcSide: number[] = arcs.map((arc) => {
    const mid = arc.segs[Math.floor(arc.segs.length / 2)] ?? arc.segs[0]!;
    return Math.sign(side(segAt(mid, 0.5)));
  });
  arcs.forEach((arc, i) => {
    if (arc.startCrossing >= 0) arcAtStart[arc.startCrossing] = i;
  });
  if (arcAtStart.some((i) => i < 0)) return null;

  const used = new Array<boolean>(arcs.length).fill(false);
  const rings: CutSubpath[] = [];
  for (let start = 0; start < arcs.length; start++) {
    if (used[start]) continue;
    const wanted = arcSide[start]!;
    // A zero here means the arc's midpoint sits ON the line; it carries no
    // side, so it cannot anchor a half.
    if (wanted === 0) return null;
    const chain: Seg[] = [];
    let cursor = start;
    for (let guard = 0; guard <= arcs.length; guard++) {
      if (used[cursor]) {
        if (cursor !== start) return null;
        break;
      }
      used[cursor] = true;
      const arc = arcs[cursor]!;
      chain.push(...arc.segs);
      const exit = arc.endCrossing;
      const entry = partner[exit]!;
      const capFrom = crossings[exit]!.point;
      const capTo = crossings[entry]!.point;
      if (Math.hypot(capTo.x - capFrom.x, capTo.y - capFrom.y) > 1e-9) {
        chain.push([
          capFrom,
          lerp(capFrom, capTo, 1 / 3),
          lerp(capFrom, capTo, 2 / 3),
          capTo,
        ]);
      }
      const next = arcAtStart[entry]!;
      if (next === start) break;
      if (arcSide[next] !== wanted) return null;
      cursor = next;
    }
    const ring = chainToRun(chain, true);
    if (ring && Math.abs(ringArea(ring)) > MIN_RING_AREA) rings.push(ring);
  }
  return rings.length >= 2 ? rings : null;
}

/** Shoelace over the anchors — only used to reject degenerate slivers. */
function ringArea(run: CutSubpath): number {
  const p = run.points;
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[i]!;
    const r = p[(i + 1) % p.length]!;
    a += q.x * r.y - r.x * q.y;
  }
  return a / 2;
}

/**
 * Build the run list for a shape whose geometry is a primitive outline
 * (a rect or ellipse with no stored points) — the Knife's way in for a layer
 * that has never been converted to a path.
 *
 * Kept here rather than in the tool so the polygon-vs-curve choice sits beside
 * the code that has to cut it.
 */
export function runFromPolygon(points: ReadonlyArray<CutVec>, open = false): CutSubpath {
  return { points: points.map(corner), open };
}
