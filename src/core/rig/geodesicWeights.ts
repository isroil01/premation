/**
 * Geodesic (mesh-graph) bone auto-weights.
 *
 * `autoWeightVertex` weights by EUCLIDEAN distance to the bone segment, which
 * ignores what the artwork actually connects to: on a PNG character a torso
 * vertex sitting spatially near an arm bone binds to the arm, and rotating the
 * arm drags the ribcage across the transparent gap — the bone-rig version of
 * "one pin crashes the whole image". Professional riggers (Spine, Rive,
 * Blender's bone heat) make influence travel THROUGH the mesh instead.
 *
 * Here: each bone seeds the vertices lying under (or nearest to) its segment,
 * then distance propagates over the mesh edge graph (Dijkstra, edge = rest
 * length). Influence must walk around the armpit to reach the torso, so it
 * arrives weak; a disconnected island no bone touches is UNREACHABLE (infinite
 * distance → no weight → `skinVertex` leaves it at the bind pose), matching the
 * puppet solver's island rule.
 *
 * Distance is only half of it. What that distance is turned INTO is the other
 * half, and it is where this module's original version went wrong: an
 * inverse-square weight normalized to sum 1 lets distance set the ratio between
 * bones but never whether a bone reaches the vertex at all, so the geodesic
 * field was computed carefully and then thrown away. `partitionWeights` below
 * is the replacement — nearest bone owns the vertex, one narrow seam at the
 * joint — and the module header of that section carries the measurements.
 *
 * Deterministic: fixed traversal order, a plain binary heap keyed (dist, id)
 * with id as tie-break, pure arithmetic. Same mesh + bones → identical weights.
 * Cost is O(bones · E log V) once per binding — cached by getSkeletonBinding.
 */

import type { Vec2 } from './ik';
import type { DeformedMesh } from './puppet';
import { distanceToSegment, type BoneSegment } from './autoWeight';
import { clampWeights, normalizeWeights, type VertexWeight } from './skinning';

/** Edge adjacency with rest-space edge lengths, derived from the triangles. */
interface EdgeGraph {
  off: Int32Array;
  nbrIdx: Int32Array;
  nbrLen: Float64Array;
  meanEdge: number;
}

const graphCache = new WeakMap<DeformedMesh, EdgeGraph>();

function buildEdgeGraph(mesh: DeformedMesh): EdgeGraph {
  const cached = graphCache.get(mesh);
  if (cached) return cached;

  const verts = mesh.vertices;
  const tris = mesh.triangles;
  const n = verts.length / 4;

  // Unique undirected edges via a deterministic keyed map (key = lo*n + hi).
  const edges = new Map<number, number>(); // key → length
  const addEdge = (a: number, b: number): void => {
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const key = lo * n + hi;
    if (edges.has(key)) return;
    const dx = verts[lo * 4 + 0]! - verts[hi * 4 + 0]!;
    const dy = verts[lo * 4 + 1]! - verts[hi * 4 + 1]!;
    edges.set(key, Math.hypot(dx, dy));
  };
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t]!;
    const b = tris[t + 1]!;
    const c = tris[t + 2]!;
    addEdge(a, b);
    addEdge(b, c);
    addEdge(a, c);
  }

  const degree = new Int32Array(n);
  let lenSum = 0;
  for (const [key, len] of edges) {
    const lo = Math.floor(key / n);
    const hi = key - lo * n;
    degree[lo]!++;
    degree[hi]!++;
    lenSum += len;
  }
  const off = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) off[i + 1] = off[i]! + degree[i]!;
  const nbrIdx = new Int32Array(off[n]!);
  const nbrLen = new Float64Array(off[n]!);
  const cursor = Int32Array.from(off.subarray(0, n));
  for (const [key, len] of edges) {
    const lo = Math.floor(key / n);
    const hi = key - lo * n;
    nbrIdx[cursor[lo]!] = hi;
    nbrLen[cursor[lo]!] = len;
    cursor[lo]!++;
    nbrIdx[cursor[hi]!] = lo;
    nbrLen[cursor[hi]!] = len;
    cursor[hi]!++;
  }

  const graph: EdgeGraph = {
    off,
    nbrIdx,
    nbrLen,
    meanEdge: edges.size > 0 ? lenSum / edges.size : 0,
  };
  graphCache.set(mesh, graph);
  return graph;
}

/** Deterministic binary min-heap of (dist, vertex) with vertex id tie-break. */
class MinHeap {
  private d: number[] = [];
  private v: number[] = [];
  get size(): number {
    return this.d.length;
  }
  push(dist: number, vert: number): void {
    const d = this.d;
    const v = this.v;
    d.push(dist);
    v.push(vert);
    let i = d.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (d[p]! < d[i]! || (d[p] === d[i] && v[p]! <= v[i]!)) break;
      [d[p], d[i]] = [d[i]!, d[p]!];
      [v[p], v[i]] = [v[i]!, v[p]!];
      i = p;
    }
  }
  pop(): { dist: number; vert: number } {
    const d = this.d;
    const v = this.v;
    const top = { dist: d[0]!, vert: v[0]! };
    const ld = d.pop()!;
    const lv = v.pop()!;
    if (d.length > 0) {
      d[0] = ld;
      v[0] = lv;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < d.length && (d[l]! < d[m]! || (d[l] === d[m] && v[l]! < v[m]!))) m = l;
        if (r < d.length && (d[r]! < d[m]! || (d[r] === d[m] && v[r]! < v[m]!))) m = r;
        if (m === i) break;
        [d[m], d[i]] = [d[i]!, d[m]!];
        [v[m], v[i]] = [v[i]!, v[m]!];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Per-vertex geodesic distance to one bone segment.
 *
 * Seeds are the vertices whose EUCLIDEAN distance to the segment is within a
 * band of the minimum (1.5 mean edge lengths — wide enough that the bone always
 * grabs the artwork directly under it, narrow enough that it cannot leap a
 * silhouette gap). Each seed starts at its Euclidean distance so the field
 * stays smooth near the bone, then Dijkstra extends it along mesh edges.
 * Unreached vertices keep Infinity.
 */
function geodesicDistanceToSegment(
  mesh: DeformedMesh,
  graph: EdgeGraph,
  seg: BoneSegment,
): Float64Array {
  const verts = mesh.vertices;
  const n = verts.length / 4;
  const dist = new Float64Array(n).fill(Infinity);
  if (n === 0) return dist;

  let minD = Infinity;
  const d0 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d = distanceToSegment({ x: verts[i * 4 + 0]!, y: verts[i * 4 + 1]! }, seg.a, seg.b);
    d0[i] = d;
    if (d < minD) minD = d;
  }
  const band = minD + Math.max(1.5 * graph.meanEdge, 1e-6);

  const heap = new MinHeap();
  for (let i = 0; i < n; i++) {
    if (d0[i]! <= band) {
      dist[i] = d0[i]!;
      heap.push(d0[i]!, i);
    }
  }
  while (heap.size > 0) {
    const { dist: d, vert: i } = heap.pop();
    if (d > dist[i]!) continue; // stale entry
    const start = graph.off[i]!;
    const end = graph.off[i + 1]!;
    for (let k = start; k < end; k++) {
      const j = graph.nbrIdx[k]!;
      const nd = d + graph.nbrLen[k]!;
      if (nd < dist[j]!) {
        dist[j] = nd;
        heap.push(nd, j);
      }
    }
  }
  return dist;
}

// ────────────────────────────────────────────────────────────────────────────
// The influence kernel
// ────────────────────────────────────────────────────────────────────────────

/**
 * PARTITION, not inverse distance. This is the fix for "rotating a bone breaks
 * the whole image".
 *
 * The old kernel was `w = 1/(d^2 + eps)` over every bone, normalized to sum 1.
 * Normalizing to 1 is what broke it: distance then only ever set the RATIO
 * between bones and never whether a bone reached the vertex at all. On the
 * reference character (a torso block with one thin arm, bones only on the arm)
 * the far BOTTOM-LEFT corner of the torso — a hundred pixels of mesh away from
 * the forearm — came out `upper 0.67 / fore 0.33`, so rotating the elbow 45°
 * dragged the torso 20px. It also left the hand at `fore 0.98 / upper 0.02`,
 * so the limb sheared instead of rotating rigidly.
 *
 * The rule here is the one riggers actually describe: the geodesically NEAREST
 * bone owns the vertex, and the only place two bones share it is a narrow seam
 * around their joint.
 *
 *   t_b   = (d_b − d_min) / band       — how far behind the nearest bone this
 *                                        bone is, in seam widths
 *   w_b   = (1 − t_b)³   for t_b < 1,  0 otherwise
 *
 * Both properties fall out. A vertex deep in the forearm has t_upper ≫ 1 for
 * the shoulder bone, so the forearm is RIGID. A vertex at the elbow is
 * equidistant, so t = 0 for both and it splits 50/50 — and because `d_min` and
 * every `d_b` are continuous, so are the weights: the seam is smooth even
 * though the owner flips across it. The cubic reaches the seam edge with zero
 * value, slope and curvature, so there is no crease where it lands.
 *
 * `radius` then answers the question a partition cannot: a partition always
 * hands every vertex to SOME bone, so on a one-armed rig the shoulder still
 * owns the torso. Past `0.75 · radius` the weights fade smoothly to nothing and
 * `skinVertex` spends the shortfall on the bind pose. Absent = unlimited, which
 * is the behaviour every existing rig has.
 */
const REACH_FADE = 0.25;

/** Smooth 1→0 ramp over the outer `REACH_FADE` of a bone's radius. */
function reachFade(dist: number, radius: number | undefined): number {
  // Non-positive is UNLIMITED, matching what the Falloff field means when it
  // reads 0 — a bone that influences nothing is not a state worth encoding.
  if (radius === undefined || !Number.isFinite(radius) || radius <= 0) return 1;
  if (dist >= radius) return 0;
  const inner = radius * (1 - REACH_FADE);
  if (dist <= inner) return 1;
  const s = (radius - dist) / (radius - inner);
  return s * s * (3 - 2 * s);
}

/**
 * One vertex's weights from its per-bone distances (geodesic on the mesh,
 * Euclidean off it — the rule is the same either way).
 *
 * `distances[b]` may be Infinity for a bone that cannot reach the vertex
 * through the artwork at all; an unreachable-from-everything vertex returns an
 * empty list and `skinVertex` leaves it at the bind pose.
 */
export function partitionWeights(
  distances: readonly number[],
  segments: readonly BoneSegment[],
  band: number,
  maxInfluences = 4,
): VertexWeight[] {
  let dMin = Infinity;
  for (const d of distances) if (d < dMin) dMin = d;
  if (!Number.isFinite(dMin)) return [];

  const width = Math.max(band, 1e-6);
  const raw: VertexWeight[] = [];
  for (let b = 0; b < segments.length; b++) {
    const d = distances[b]!;
    if (!Number.isFinite(d)) continue;
    const t = (d - dMin) / width;
    if (t >= 1) continue;
    const share = (1 - t) ** 3;
    const fade = reachFade(d, segments[b]!.radius);
    if (fade <= 0) continue;
    raw.push({ boneId: segments[b]!.id, weight: share * fade });
  }
  if (raw.length === 0) return [];

  // Two steps, in this order. SPLIT the vertex among the bones that reached it
  // (sum 1) — that is what keeps a limb rigid, because the split is scale-free
  // and the nearest bone takes all of it. Then scale the whole vertex by how
  // strongly the STRONGEST bone reached it, which is 1 everywhere except in the
  // outer fade of a bounded bone. `skinVertex` spends the shortfall on the bind
  // pose, so the artwork thins out of the bone's grip instead of tearing off
  // the unbound artwork next to it.
  //
  // With no radius set anywhere `bound` is exactly 1 and this is a plain
  // normalize, which is what every existing rig gets.
  const split = normalizeWeights(raw, maxInfluences);
  let bound = 0;
  for (const w of raw) if (w.weight > bound) bound = w.weight;
  if (bound >= 1) return split;
  return split.map((w) => ({ boneId: w.boneId, weight: w.weight * bound }));
}

/**
 * The seam width for a mesh + skeleton: how wide the smooth blend around a
 * joint should be, in layer-local units.
 *
 * Two floors, and each one prevents a different artefact. Below ~1.5 mesh edges
 * the seam is thinner than the mesh can represent and the joint creases; below
 * a fraction of the bone length the blend stops reading as a bend at all. The
 * larger wins, so it adapts to both a dense mesh on stubby bones and a coarse
 * mesh on long ones.
 */
export function seamBand(meanEdge: number, segments: readonly BoneSegment[]): number {
  let lenSum = 0;
  for (const s of segments) lenSum += Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
  const meanBone = segments.length > 0 ? lenSum / segments.length : 0;
  return Math.max(1.5 * meanEdge, 0.18 * meanBone, 1e-6);
}

/** `seamBand` for a mesh, exposed so callers can weight arbitrary points with it. */
export function meshSeamBand(mesh: DeformedMesh, segments: readonly BoneSegment[]): number {
  return seamBand(buildEdgeGraph(mesh).meanEdge, segments);
}

/**
 * Auto-weight every mesh vertex against the bone segments by GEODESIC distance,
 * using the nearest-bone partition above. A vertex reachable from NO bone gets
 * an empty list and `skinVertex` leaves it at the bind pose.
 */
export function geodesicAutoWeights(
  mesh: DeformedMesh,
  segments: readonly BoneSegment[],
  maxInfluences = 4,
): VertexWeight[][] {
  const n = mesh.vertices.length / 4;
  const graph = buildEdgeGraph(mesh);
  const perBone = segments.map((s) => geodesicDistanceToSegment(mesh, graph, s));
  const band = seamBand(graph.meanEdge, segments);

  const out: VertexWeight[][] = new Array(n);
  const dist: number[] = new Array(segments.length);
  for (let i = 0; i < n; i++) {
    for (let b = 0; b < segments.length; b++) dist[b] = perBone[b]![i]!;
    out[i] = partitionWeights(dist, segments, band, maxInfluences);
  }
  return out;
}

/**
 * The same partition evaluated on EUCLIDEAN distance, for points that are not
 * mesh vertices (the transparent margin outside every triangle). Off the mesh
 * there is no graph to walk, but the rule — nearest bone owns it, seam blends —
 * must still match or an overlay dot skins differently from the artwork under
 * it.
 */
export function euclideanPartitionWeights(
  p: Vec2,
  segments: readonly BoneSegment[],
  band: number,
  maxInfluences = 4,
): VertexWeight[] {
  const dist = segments.map((s) => distanceToSegment(p, s.a, s.b));
  return partitionWeights(dist, segments, band, maxInfluences);
}

/**
 * The binding's weights evaluated at an arbitrary rest-space point, for the
 * overlay point helpers (`skinPointAt` / `unskinPoint`). ON the mesh it
 * interpolates the containing triangle's vertex weights barycentrically — so a
 * pin dot skins with the SAME (geodesic) field the mesh renders with. OFF the
 * mesh (the transparent margin, where nothing renders) it falls back to the
 * smooth Euclidean field: `unskinPoint` iterates a fixed point through this
 * function, and a piecewise-constant nearest-vertex fallback left it unable to
 * converge whenever a click's rest preimage lay outside the mesh.
 */
export function weightsAtPoint(
  mesh: DeformedMesh,
  weights: readonly VertexWeight[][],
  p: Vec2,
  segments: readonly BoneSegment[],
  band?: number,
): VertexWeight[] {
  const verts = mesh.vertices;
  const tris = mesh.triangles;

  const blend = (ia: number, ib: number, ic: number, wa: number, wb: number, wc: number): VertexWeight[] => {
    const acc = new Map<string, number>();
    const add = (list: readonly VertexWeight[] | undefined, f: number): void => {
      if (!list || f <= 0) return;
      for (const { boneId, weight } of list) {
        acc.set(boneId, (acc.get(boneId) ?? 0) + weight * f);
      }
    };
    add(weights[ia], wa);
    add(weights[ib], wb);
    add(weights[ic], wc);
    // Sorted for determinism, then capped like every other path. `clampWeights`
    // rather than `normalizeWeights`: a triangle whose corners are only
    // PARTIALLY bound (the fade at a bounded bone's edge) must interpolate to a
    // partial weight, not be scaled back up to a full one.
    const merged = [...acc.entries()]
      .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
      .map(([boneId, weight]) => ({ boneId, weight }));
    return clampWeights(merged);
  };

  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t]!;
    const b = tris[t + 1]!;
    const c = tris[t + 2]!;
    const ax = verts[a * 4 + 0]!, ay = verts[a * 4 + 1]!;
    const bx = verts[b * 4 + 0]!, by = verts[b * 4 + 1]!;
    const cx = verts[c * 4 + 0]!, cy = verts[c * 4 + 1]!;
    const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(det) < 1e-12) continue;
    const wa = ((bx - p.x) * (cy - p.y) - (cx - p.x) * (by - p.y)) / det;
    const wb = ((cx - p.x) * (ay - p.y) - (ax - p.x) * (cy - p.y)) / det;
    const wc = 1 - wa - wb;
    const EPS = -1e-6;
    if (wa >= EPS && wb >= EPS && wc >= EPS) {
      return blend(a, b, c, Math.max(0, wa), Math.max(0, wb), Math.max(0, wc));
    }
  }

  // Outside every triangle (nothing renders there) → the same partition rule,
  // measured Euclidean because there is no mesh to walk.
  return euclideanPartitionWeights(p, segments, band ?? meshSeamBand(mesh, segments));
}
