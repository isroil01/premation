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
 * Deterministic: fixed traversal order, a plain binary heap keyed (dist, id)
 * with id as tie-break, pure arithmetic. Same mesh + bones → identical weights.
 * Cost is O(bones · E log V) once per binding — cached by getSkeletonBinding.
 */

import type { Vec2 } from './ik';
import type { DeformedMesh } from './puppet';
import { autoWeightVertex, distanceToSegment, type BoneSegment } from './autoWeight';
import { normalizeWeights, type VertexWeight } from './skinning';

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

/**
 * Auto-weight every mesh vertex against the bone segments by GEODESIC distance.
 * Same falloff/influence contract as `autoWeightVertex` (1/(d^falloff + eps),
 * normalized, capped); a vertex reachable from NO bone gets an empty list and
 * `skinVertex` leaves it at the bind pose.
 */
export function geodesicAutoWeights(
  mesh: DeformedMesh,
  segments: readonly BoneSegment[],
  falloff = 2,
  maxInfluences = 4,
): VertexWeight[][] {
  const n = mesh.vertices.length / 4;
  const graph = buildEdgeGraph(mesh);
  const perBone = segments.map((s) => geodesicDistanceToSegment(mesh, graph, s));

  const out: VertexWeight[][] = new Array(n);
  const raw: VertexWeight[] = [];
  for (let i = 0; i < n; i++) {
    raw.length = 0;
    for (let b = 0; b < segments.length; b++) {
      const d = perBone[b]![i]!;
      if (!Number.isFinite(d)) continue;
      raw.push({ boneId: segments[b]!.id, weight: 1 / (Math.pow(d, falloff) + 1e-6) });
    }
    out[i] = normalizeWeights(raw, maxInfluences);
  }
  return out;
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
    // Sorted for determinism, then re-normalized/capped like every other path.
    const merged = [...acc.entries()]
      .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
      .map(([boneId, weight]) => ({ boneId, weight }));
    return normalizeWeights(merged);
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

  // Outside every triangle (nothing renders there) → smooth Euclidean field.
  return autoWeightVertex(p, segments);
}
