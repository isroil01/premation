/**
 * ARAP (As-Rigid-As-Possible) 2D mesh deformation for the puppet tool.
 *
 * Implements the Sorkine–Alexa local/global scheme ("As-Rigid-As-Possible
 * Surface Modeling", SGP 2007) specialised to a planar triangle mesh — the same
 * family of rigidity-preserving deformation After Effects' Puppet tool uses.
 * Unlike Linear Blend Skinning (LBS), which linearly averages per-pin rigid
 * transforms and therefore collapses ("candy-wrapper") when two handles impose
 * conflicting rotations, ARAP minimises a per-vertex rigidity energy so local
 * regions rotate instead of shearing/shrinking to zero area.
 *
 * Energy minimised (Sorkine–Alexa):
 *     E = Σ_i Σ_{j∈N(i)} w_ij · || (p'_i − p'_j) − R_i (p_i − p_j) ||²
 * where p are rest positions, p' deformed positions, R_i the best-fit local
 * rotation at vertex i, and w_ij symmetric cotangent edge weights.
 *
 * Two-step iteration (FIXED outer count → determinism):
 *   • local  step: for each free vertex fit R_i in closed form (2D Procrustes,
 *                  no SVD library needed — θ = atan2(S10−S01, S00+S11));
 *   • global step: solve the cotangent-Laplacian system L p' = b EXACTLY for the
 *                  free (non-handle) vertices. The reduced system matrix is FIXED
 *                  per mesh+handle-set, so it is Cholesky-factorised once and
 *                  cached; each outer iteration only re-runs forward/back
 *                  substitution on the fresh right-hand side. (A dense factor is
 *                  used up to DENSE_MAX free vertices; larger meshes fall back to
 *                  a FIXED-count Gauss–Seidel solve — still fully deterministic.)
 *
 * Handles (pins) are HARD positional constraints on the vertex that each pin's
 * weight column peaks on (argmax). A pin's `rotation` fixes the local rotation
 * R at its constrained vertex, so its 1-ring rotates rigidly by that angle.
 *
 * Stiffness ("starch") is a FIRST-CLASS energy term, not just a warm-start hint.
 * Each pin's `stiffness ≥ 0` diffuses into a per-vertex field via its harmonic
 * weight column:  s_i = Σ_p W_p(i)·max(0, stiffness_p). That field scales the
 * cotangent edge weights  w'_ij = w_ij·(1 + K·(s_i + s_j)/2), so stiffer regions
 * carry more weight in E and the global solve keeps their edges closer to rigid
 * (they resist deformation). A UNIFORM stiffness field scales every weight by the
 * same constant → same argmin → no visible change (correct: only stiffness
 * GRADIENTS bite). With no pin stiffness the field is all-zero and the solver
 * reduces EXACTLY (bit-identically) to the plain cotangent-weight path.
 *
 * Determinism: no Date.now / Math.random; fixed outer/inner iteration counts;
 * fixed traversal and factorisation order; Float64 arithmetic with a Float32
 * result buffer. Same input (pins + rest mesh) → bit-identical output on every
 * call and machine. Per-mesh topology (edge weights + adjacency) and the reduced
 * Cholesky factor are memoised on the mesh object (WeakMap), mirroring the
 * rest-mesh cache, so the constraint-free reduced system is precomputed once.
 *
 * Robustness: degenerate triangles are dropped (uniform fallback weight),
 * isolated / free-floating vertices keep their warm-start position, a
 * non–positive-definite reduced system (a component with no handle) degrades to
 * Gauss–Seidel, and any non-finite result falls back to the LBS field wholesale.
 * Callers pass the already-computed LBS field as both warm start and fallback.
 */

import type { DeformedMesh, DeformPin } from './puppet';

const DEG_TO_RAD = Math.PI / 180;

/** FIXED local/global outer iterations (rotation re-fit + position solve). */
const OUTER_ITERATIONS = 4;
/** FIXED Gauss–Seidel sweeps per global step (large-mesh fallback path only). */
const GS_SWEEPS = 64;
/** Max free-vertex count for the dense Cholesky path (else Gauss–Seidel). */
const DENSE_MAX = 1200;
/**
 * Same value, exported so the UI can tell the user WHEN the solver quality
 * changes. Crossing it is deterministic and stable, but visibly softer — and it
 * used to happen silently while the density slider ran on to 50 (§12.11).
 */
export const ARAP_DENSE_MAX = DENSE_MAX;
/**
 * Stiffness → energy coupling constant K in  w'_ij = w_ij·(1 + K·(s_i+s_j)/2).
 * Larger K = stiffer regions resist deformation harder. Fixed → deterministic.
 */
const STIFF_K = 6.0;
/** Fixed quantization for the per-vertex stiffness signature (factor cache key). */
const STIFF_QUANT = 1024;
/**
 * Perf guard for the O(m³) refactor cliff under ANIMATED stiffness. A changing
 * stiffness signature invalidates the cached Cholesky factor every frame; above
 * this free-vertex count we skip the dense factor entirely and use the (already
 * deterministic, fixed-sweep) Gauss–Seidel path instead of paying an O(m³)
 * refactor per frame. Static stiffness (the common case) caches once regardless.
 * Chosen below DENSE_MAX so mid/large stiff meshes stay bounded per frame.
 */
const STIFF_DENSE_MAX = 512;
/** Exported alongside ARAP_DENSE_MAX for the same UI-disclosure reason. */
export const ARAP_STIFF_DENSE_MAX = STIFF_DENSE_MAX;

/**
 * Highest `meshDensity` whose mesh still fits the EXACT dense-Cholesky solve.
 *
 * A bbox grid at density d has (d+1)² vertices; handles subtract a couple, and
 * silhouette / alpha culling can remove many more, so this is the CONSERVATIVE
 * bound — a heavily culled mesh may stay exact somewhat above it. Above this
 * density the solver is guaranteed-or-likely to fall back to the fixed-sweep
 * Gauss–Seidel path: still deterministic, still stable, just softer.
 *
 * Any pin with stiffness > 0 uses the lower cap, because animated stiffness
 * would otherwise force an O(m³) refactor every frame.
 */
export function maxExactMeshDensity(hasStiffness: boolean): number {
  const cap = hasStiffness ? STIFF_DENSE_MAX : DENSE_MAX;
  return Math.max(2, Math.floor(Math.sqrt(cap)) - 1);
}

/**
 * Highest `meshDensity` that still solves fast enough for smooth playback.
 *
 * MEASURED (600x300 layer, 2 pins, warm cache — i.e. the steady per-frame cost
 * once the factorisation is cached; the first call after any change to the mesh
 * or handle set is far worse):
 *
 *   density  verts   first call   warm/frame   ~fps
 *   15        256       27 ms       3.1 ms      319   ← default
 *   25        676      122 ms      10.2 ms       98
 *   33       1156      673 ms      36.5 ms       27   ← maxExactMeshDensity
 *   40       1681      110 ms      34.1 ms       29
 *   50       2601       68 ms      43.4 ms       23
 *
 * Two things that surprise people, both visible above:
 *   • The EXACT-solve boundary is not the performance boundary. Density 33 is
 *     the last density that fits the dense Cholesky path, and it is also where
 *     a 673 ms hitch and 27 fps live — the factorisation is O(m³). Quality
 *     guidance and cost guidance must be given separately or the "exact"
 *     marker reads as a recommendation to go there.
 *   • Past 33 the FIRST call gets cheaper (no dense factorisation) while the
 *     steady cost stays high — so a slow first frame is not a reliable signal.
 *
 * Cost scales with the LAYER's vertex count and is paid per rigged layer per
 * frame, so several rigged layers multiply it.
 */
export const SMOOTH_PLAYBACK_MAX_DENSITY = 25;
/**
 * Bounded LRU-ish cap on distinct stiffness-signature factorisations kept per
 * mesh (insertion-order eviction). Static stiffness needs 1; animating stiffness
 * churns keys but memory stays bounded. Base (no-stiffness) factors live in a
 * separate, uncapped map keyed only by the handle set.
 */
const STIFF_FACTOR_CACHE_CAP = 8;
/** Clamp for cotangent weights (avoid negative / exploding weights on slivers). */
const COT_MIN = 1e-3;
const COT_MAX = 1e3;
/** A vertex whose summed edge weight is below this is treated as isolated. */
const DIAG_EPS = 1e-9;

/** Precomputed, frame-invariant mesh topology for the ARAP global system. */
interface ArapTopology {
  numVertices: number;
  /** Flattened CSR-style adjacency: neighbours of vertex i in [off[i], off[i+1]). */
  nbrIdx: Int32Array;
  nbrW: Float64Array;
  off: Int32Array;
  /** Σ_j w_ij per vertex (Laplacian diagonal). */
  diag: Float64Array;
  restX: Float64Array;
  restY: Float64Array;
  /** Reduced-system factorisations keyed by the pinned-vertex signature. */
  factors: Map<string, ReducedFactor>;
  /**
   * Stiffness-dependent factorisations keyed by handle-set + quantized stiffness
   * signature. Capped (insertion-order eviction) so animated stiffness stays
   * bounded; the no-stiffness path never touches this map.
   */
  stiffFactors: Map<string, ReducedFactor>;
}

/** Reduced (free-vertex) linear system for a fixed handle set. */
interface ReducedFactor {
  m: number;                 // number of free vertices
  freeOf: Int32Array;        // compact index → vertex id
  compactOf: Int32Array;     // vertex id → compact index (−1 if pinned/isolated)
  L: Float64Array | null;    // dense Cholesky lower factor (m·m) or null → Gauss–Seidel
}

/** Topology cache keyed by the (cached, reused) rest-mesh object. */
const topologyCache = new WeakMap<DeformedMesh, ArapTopology>();

/** cot of the angle at vertex A of triangle (A,B,C): dot(AB,AC)/|cross(AB,AC)|. */
function cotAngle(
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number,
): number {
  const ux = bx - ax, uy = by - ay;
  const vx = cx - ax, vy = cy - ay;
  const dot = ux * vx + uy * vy;
  const cross = ux * vy - uy * vx;
  const area2 = Math.abs(cross);
  if (area2 < 1e-12) return NaN; // degenerate triangle
  const cot = dot / area2;
  if (!Number.isFinite(cot)) return NaN;
  return Math.max(-COT_MAX, Math.min(COT_MAX, cot));
}

/**
 * Build (or fetch cached) cotangent-Laplacian topology for a rest mesh. Edge
 * weights accumulate 0.5·cot(opposite angle) over each incident triangle;
 * degenerate triangles fall back to a uniform 0.5 on their three edges. Negative
 * cotangents (obtuse slivers) are clamped up to COT_MIN so the diagonal stays
 * positive and the system stays positive-definite.
 */
function buildTopology(restMesh: DeformedMesh): ArapTopology {
  const cached = topologyCache.get(restMesh);
  if (cached) return cached;

  const verts = restMesh.vertices;
  const tris = restMesh.triangles;
  const n = verts.length / 4;

  const restX = new Float64Array(n);
  const restY = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    restX[i] = verts[i * 4 + 0]!;
    restY[i] = verts[i * 4 + 1]!;
  }

  // Symmetric edge-weight accumulation via a deterministic map (key = a*n + b, a<b).
  const edgeW = new Map<number, number>();
  const addEdge = (a: number, b: number, w: number): void => {
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const key = lo * n + hi;
    edgeW.set(key, (edgeW.get(key) ?? 0) + w);
  };

  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t]!;
    const b = tris[t + 1]!;
    const c = tris[t + 2]!;
    const ax = restX[a]!, ay = restY[a]!;
    const bx = restX[b]!, by = restY[b]!;
    const cx = restX[c]!, cy = restY[c]!;

    // cot at A → edge (B,C); cot at B → edge (A,C); cot at C → edge (A,B).
    const cotA = cotAngle(ax, ay, bx, by, cx, cy);
    const cotB = cotAngle(bx, by, ax, ay, cx, cy);
    const cotC = cotAngle(cx, cy, ax, ay, bx, by);
    if (!Number.isFinite(cotA) || !Number.isFinite(cotB) || !Number.isFinite(cotC)) {
      // Degenerate triangle → uniform fallback keeps connectivity without NaNs.
      addEdge(b, c, 0.5);
      addEdge(a, c, 0.5);
      addEdge(a, b, 0.5);
      continue;
    }
    addEdge(b, c, 0.5 * Math.max(COT_MIN, cotA));
    addEdge(a, c, 0.5 * Math.max(COT_MIN, cotB));
    addEdge(a, b, 0.5 * Math.max(COT_MIN, cotC));
  }

  // Convert the edge map to CSR adjacency (per-vertex lists sorted ascending).
  const nbrLists: Array<Array<{ j: number; w: number }>> = Array.from(
    { length: n },
    () => [],
  );
  for (const [key, w] of edgeW) {
    const lo = Math.floor(key / n);
    const hi = key - lo * n;
    nbrLists[lo]!.push({ j: hi, w });
    nbrLists[hi]!.push({ j: lo, w });
  }

  let total = 0;
  for (let i = 0; i < n; i++) {
    nbrLists[i]!.sort((p, q) => p.j - q.j);
    total += nbrLists[i]!.length;
  }

  const off = new Int32Array(n + 1);
  const nbrIdx = new Int32Array(total);
  const nbrW = new Float64Array(total);
  const diag = new Float64Array(n);
  let cursor = 0;
  for (let i = 0; i < n; i++) {
    off[i] = cursor;
    let d = 0;
    for (const { j, w } of nbrLists[i]!) {
      nbrIdx[cursor] = j;
      nbrW[cursor] = w;
      d += w;
      cursor++;
    }
    diag[i] = d;
  }
  off[n] = cursor;

  const topo: ArapTopology = {
    numVertices: n, nbrIdx, nbrW, off, diag, restX, restY,
    factors: new Map(), stiffFactors: new Map(),
  };
  topologyCache.set(restMesh, topo);
  return topo;
}

/**
 * In-place dense Cholesky: A (row-major m·m, symmetric positive-definite) → L
 * lower-triangular with A = L·Lᵀ. Returns false (no PD factor) if a pivot is
 * non-positive — the caller then degrades to Gauss–Seidel. Deterministic:
 * fixed loop order, pure arithmetic.
 */
function choleskyFactor(A: Float64Array, m: number): boolean {
  for (let j = 0; j < m; j++) {
    let sum = A[j * m + j]!;
    for (let k = 0; k < j; k++) {
      const ljk = A[j * m + k]!;
      sum -= ljk * ljk;
    }
    if (sum <= 1e-12) return false;
    const ljj = Math.sqrt(sum);
    A[j * m + j] = ljj;
    for (let i = j + 1; i < m; i++) {
      let s = A[i * m + j]!;
      for (let k = 0; k < j; k++) {
        s -= A[i * m + k]! * A[j * m + k]!;
      }
      A[i * m + j] = s / ljj;
      A[j * m + i] = 0; // keep the strict upper triangle clean
    }
  }
  return true;
}

/** Solve A x = b given the Cholesky factor L stored in A's lower triangle. */
function choleskySolve(L: Float64Array, m: number, b: Float64Array, x: Float64Array): void {
  // Forward: L z = b  (reuse x as z).
  for (let i = 0; i < m; i++) {
    let s = b[i]!;
    const base = i * m;
    for (let k = 0; k < i; k++) s -= L[base + k]! * x[k]!;
    x[i] = s / L[base + i]!;
  }
  // Back: Lᵀ x = z.
  for (let i = m - 1; i >= 0; i--) {
    let s = x[i]!;
    for (let k = i + 1; k < m; k++) s -= L[k * m + i]! * x[k]!;
    x[i] = s / L[i * m + i]!;
  }
}

/**
 * Build/fetch the reduced factorisation for a given pinned-vertex set and a set
 * of EFFECTIVE edge weights (`effDiag`/`effNbrW` — either the base cotangent
 * weights or the stiffness-scaled ones). `denseCap` gates the dense Cholesky
 * path (else Gauss–Seidel); `factorMap`/`cacheCap` select the destination cache
 * and its bounded-eviction policy (cacheCap ≤ 0 → no eviction). The free-vertex
 * set is decided from the BASE topology diagonal so it is stiffness-invariant
 * (stiffness only ever scales weights up, never zeroes an edge).
 */
function getReducedFactor(
  topo: ArapTopology,
  pinnedFlag: Uint8Array,
  effDiag: Float64Array,
  effNbrW: Float64Array,
  cacheKey: string,
  factorMap: Map<string, ReducedFactor>,
  denseCap: number,
  cacheCap: number,
): ReducedFactor {
  const existing = factorMap.get(cacheKey);
  if (existing) return existing;

  const n = topo.numVertices;
  const compactOf = new Int32Array(n).fill(-1);
  let m = 0;
  for (let i = 0; i < n; i++) {
    // Free = not pinned and not isolated (a weightless vertex stays put).
    if (!pinnedFlag[i] && topo.diag[i]! > DIAG_EPS) compactOf[i] = m++;
  }
  const freeOf = new Int32Array(m);
  for (let i = 0; i < n; i++) {
    const c = compactOf[i]!;
    if (c >= 0) freeOf[c] = i;
  }

  let L: Float64Array | null = null;
  if (m > 0 && m <= denseCap) {
    const A = new Float64Array(m * m);
    for (let p = 0; p < m; p++) {
      const i = freeOf[p]!;
      A[p * m + p] = effDiag[i]!;
      const start = topo.off[i]!;
      const end = topo.off[i + 1]!;
      for (let k = start; k < end; k++) {
        const j = topo.nbrIdx[k]!;
        const q = compactOf[j]!;
        if (q >= 0) {
          const idx = p * m + q;
          A[idx] = A[idx]! - effNbrW[k]!;
        }
      }
    }
    if (choleskyFactor(A, m)) L = A; // A now holds the lower factor
  }

  const factor: ReducedFactor = { m, freeOf, compactOf, L };
  // Bounded eviction (insertion order) for the churny animated-stiffness map.
  if (cacheCap > 0 && factorMap.size >= cacheCap) {
    const oldest = factorMap.keys().next().value;
    if (oldest !== undefined) factorMap.delete(oldest);
  }
  factorMap.set(cacheKey, factor);
  return factor;
}

/**
 * Deterministic quantized hash of the per-vertex stiffness field. Fixed
 * quantization (STIFF_QUANT) → static stiffness yields one stable key (cache
 * hit, no per-frame factor cost); animated stiffness changes the key only when a
 * value crosses a quantization bucket. FNV-1a over 32-bit quantized values.
 */
function stiffnessSignature(sVert: Float64Array): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < sVert.length; i++) {
    const q = Math.round(sVert[i]! * STIFF_QUANT) | 0;
    h = Math.imul(h ^ (q & 0xffff), 16777619) >>> 0;
    h = Math.imul(h ^ ((q >>> 16) & 0xffff), 16777619) >>> 0;
  }
  return `${sVert.length}:${h.toString(36)}`;
}

/**
 * Resolve each pin to the mesh vertex its weight column peaks on (argmax). This
 * is the vertex the pin hard-constrains. Returns the distinct constrained-vertex
 * count so the caller can gate (ARAP needs ≥2 handles to be meaningful).
 */
function resolvePinnedVertices(
  pins: DeformPin[],
  restMesh: DeformedMesh,
  n: number,
): {
  pinnedFlag: Uint8Array;
  targetX: Float64Array;
  targetY: Float64Array;
  cos: Float64Array;
  sin: Float64Array;
  distinct: number;
  key: string;
} {
  const pinnedFlag = new Uint8Array(n);
  const targetX = new Float64Array(n);
  const targetY = new Float64Array(n);
  const cos = new Float64Array(n);
  const sin = new Float64Array(n);
  const pinnedVerts: number[] = [];

  for (const pin of pins) {
    const col = restMesh.weights[pin.id];
    if (!col || col.length < n) continue;
    // argmax of the weight column (the vertex this pin controls).
    let best = 0;
    let bestW = -Infinity;
    for (let i = 0; i < n; i++) {
      const w = col[i]!;
      if (w > bestW) {
        bestW = w;
        best = i;
      }
    }
    if (!pinnedFlag[best]) pinnedVerts.push(best);
    pinnedFlag[best] = 1;
    // Handle target is the BOUND VERTEX's rest, plus the pin's displacement
    // from ITS rest. Snapping the vertex onto the click (`target = pin.x/y`)
    // made the mesh jump the moment a pin was placed between vertices — the
    // pin had not moved, but the nearest vertex was yanked onto it.
    const authored = restMesh.pinRestPositions[pin.id];
    const vx = restMesh.vertices[best * 4 + 0]!;
    const vy = restMesh.vertices[best * 4 + 1]!;
    const restX = authored?.x ?? pin.x;
    const restY = authored?.y ?? pin.y;
    targetX[best] = vx + (pin.x - restX);
    targetY[best] = vy + (pin.y - restY);
    const rot = (pin.rotation ?? 0) * DEG_TO_RAD;
    // Uniform scale folds into the local frame as a SIMILARITY (R·s). The local
    // step fixes this frame at the pin's vertex, so its 1-ring rotates AND
    // scales rigidly — the "as-similar-as-possible" relaxation of ARAP. scale 1
    // leaves this a pure rotation, bit-identical to the unscaled path.
    const scl = pin.scale ?? 1;
    cos[best] = Math.cos(rot) * scl;
    sin[best] = Math.sin(rot) * scl;
  }

  // Stable signature of the handle set (drives the factor cache).
  pinnedVerts.sort((a, b) => a - b);
  return {
    pinnedFlag, targetX, targetY, cos, sin,
    distinct: pinnedVerts.length,
    key: pinnedVerts.join(','),
  };
}

/**
 * ARAP deform. `lbsResult` is BOTH the warm start (good initial guess for the
 * first rotation fit) and the graceful fallback returned verbatim when ARAP
 * cannot help (fewer than two distinct handles, empty mesh) or would produce a
 * non-finite result. Never throws, never returns NaN.
 */
export function deformArap(
  pins: DeformPin[],
  restMesh: DeformedMesh,
  lbsResult: Float32Array,
  maxRotationDeg?: number,
): Float32Array {
  const verts = restMesh.vertices;
  const n = verts.length / 4;
  if (n === 0) return lbsResult;

  const topo = buildTopology(restMesh);
  const { restX, restY, off, nbrIdx, nbrW, diag } = topo;

  const { pinnedFlag, targetX, targetY, cos: pinCos, sin: pinSin, distinct, key } =
    resolvePinnedVertices(pins, restMesh, n);

  // Need at least two distinct handles for a rigidity problem; otherwise the LBS
  // path already gives an exact rigid translate/rotation (single/zero pin).
  if (distinct < 2) return lbsResult;

  // ---- Per-vertex stiffness field: s_i = Σ_p W_p(i)·max(0, stiffness_p) ----
  // Diffuse each pin's stiffness through its harmonic weight column. Zero when no
  // pin has stiffness → we keep the base cotangent weights and the base factor
  // cache, so the result is BIT-IDENTICAL to the no-stiffness path.
  let hasStiffness = false;
  for (const pin of pins) {
    if (Math.max(0, pin.stiffness ?? 0) > 0 && restMesh.weights[pin.id]) {
      hasStiffness = true;
      break;
    }
  }

  // Effective (possibly stiffness-scaled) edge weights + factor-cache selection.
  let effNbrW: Float64Array = nbrW;
  let effDiag: Float64Array = diag;
  let factorKey = key;
  let factorMap = topo.factors;
  let denseCap = DENSE_MAX;
  let cacheCap = 0;

  if (hasStiffness) {
    const sVert = new Float64Array(n);
    for (const pin of pins) {
      const s = Math.max(0, pin.stiffness ?? 0);
      if (s <= 0) continue;
      const col = restMesh.weights[pin.id];
      if (!col || col.length < n) continue;
      for (let i = 0; i < n; i++) sVert[i] = sVert[i]! + (col[i] ?? 0) * s;
    }
    // Scale cotangent weights: w'_ij = w_ij·(1 + K·(s_i+s_j)/2). Diagonal is the
    // consistent row-sum of the scaled off-diagonals (keeps the system PD).
    const sNbrW = new Float64Array(nbrW.length);
    const sDiag = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const start = off[i]!;
      const end = off[i + 1]!;
      const si = sVert[i]!;
      let d = 0;
      for (let k = start; k < end; k++) {
        const j = nbrIdx[k]!;
        const f = 1 + STIFF_K * 0.5 * (si + sVert[j]!);
        const w = nbrW[k]! * f;
        sNbrW[k] = w;
        d += w;
      }
      sDiag[i] = d;
    }
    effNbrW = sNbrW;
    effDiag = sDiag;
    factorKey = `${key}|${stiffnessSignature(sVert)}`;
    factorMap = topo.stiffFactors;
    // Guard the O(m³) refactor cliff on large meshes under animated stiffness.
    denseCap = STIFF_DENSE_MAX;
    cacheCap = STIFF_FACTOR_CACHE_CAP;
  }

  const factor = getReducedFactor(
    topo, pinnedFlag, effDiag, effNbrW, factorKey, factorMap, denseCap, cacheCap,
  );
  const { m, freeOf, compactOf, L } = factor;

  // Warm start from the LBS field; handles clamped exactly onto their targets.
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (pinnedFlag[i]) {
      x[i] = targetX[i]!;
      y[i] = targetY[i]!;
    } else {
      x[i] = lbsResult[i * 4 + 0]!;
      y[i] = lbsResult[i * 4 + 1]!;
    }
  }

  /** Local-step rotation cap in radians, or null for unlimited. */
  const rotLimit =
    maxRotationDeg !== undefined && Number.isFinite(maxRotationDeg)
      ? Math.abs(maxRotationDeg) * DEG_TO_RAD
      : null;

  const cosV = new Float64Array(n);
  const sinV = new Float64Array(n);
  // RHS + solution scratch for the dense path.
  const bx = L ? new Float64Array(m) : null;
  const by = L ? new Float64Array(m) : null;
  const sx = L ? new Float64Array(m) : null;
  const sy = L ? new Float64Array(m) : null;

  for (let outer = 0; outer < OUTER_ITERATIONS; outer++) {
    // ---- Local step: best-fit rotation per vertex ----
    for (let i = 0; i < n; i++) {
      if (pinnedFlag[i]) {
        cosV[i] = pinCos[i]!;
        sinV[i] = pinSin[i]!;
        continue;
      }
      let s00 = 0, s01 = 0, s10 = 0, s11 = 0;
      const start = off[i]!;
      const end = off[i + 1]!;
      for (let k = start; k < end; k++) {
        const j = nbrIdx[k]!;
        const w = effNbrW[k]!;
        const ex = restX[i]! - restX[j]!;
        const ey = restY[i]! - restY[j]!;
        const epx = x[i]! - x[j]!;
        const epy = y[i]! - y[j]!;
        s00 += w * ex * epx;
        s01 += w * ex * epy;
        s10 += w * ey * epx;
        s11 += w * ey * epy;
      }
      // 2D orthogonal Procrustes.
      //
      // The global step below applies R(θ) = [[c,−s],[s,c]] to the REST edge
      // (`cs·ex − sn·ey`, `sn·ex + cs·ey`), so R·e_rest is its target for the
      // deformed edge, and the local step must return the θ MAXIMISING
      // Σ w (R·e_rest)·e_def. With S = Σ w·e_rest⊗e_def as accumulated above,
      //
      //   (R·e)·e' = c·(ex·epx + ey·epy) + s·(ex·epy − ey·epx)
      //            = c·(s00 + s11) + s·(s01 − s10)
      //
      // which is maximal at θ = atan2(s01 − s10, s00 + s11).
      //
      // This read `atan2(s10 − s01, …)` — the NEGATION — until F33. Check it on
      // one edge: a rest edge (1,0) rotated by +90° becomes (0,1), giving
      // s01 = 1 and s00 = s10 = s11 = 0; the expression above returns +90°, the
      // old one returned −90°. The two writers into `cosV`/`sinV` disagreed as a
      // result: `resolvePinnedVertices` stores `sin = +sin(rot)` at a pinned
      // vertex, so handles turned one way while every fitted interior vertex
      // turned the other, and the local step spent each iteration undoing the
      // global step. The tell is that the iteration ANTI-converged: on a rigidly
      // rotated handle set — whose exact energy minimum is that rigid rotation —
      // worst-vertex error GREW with the outer count (2 iters 21.4px, 4 30.2,
      // 8 43.9, 16 53.7, 32 56.9). Corrected it converges instead.
      //
      // It survived because ARAP warm-starts from LBS and falls back to it, so
      // the symptom read as a mesh that was insufficiently rigid rather than one
      // visibly backwards — and because no assertion in `src/core/rig` observed
      // the sign at all (see `arapRotationDirection.test.ts` and
      // `scripts/symmetrySweep.mjs`).
      let theta = Math.atan2(s01 - s10, s00 + s11);
      // Mesh Rotation Refinement: cap how far any vertex may rotate. A sparse
      // handle set lets the local step fit large rotations that read as
      // twisting; clamping the magnitude suppresses that. No limit → untouched.
      if (rotLimit !== null) {
        if (theta > rotLimit) theta = rotLimit;
        else if (theta < -rotLimit) theta = -rotLimit;
      }
      cosV[i] = Math.cos(theta);
      sinV[i] = Math.sin(theta);
    }

    // ---- Global step: solve L p' = b for the free vertices ----
    if (L && bx && by && sx && sy) {
      // Assemble RHS: b_i = Σ_j w_ij·0.5(R_i+R_j)(p_i−p_j) + Σ_{j pinned} w_ij·p'_j.
      for (let p = 0; p < m; p++) {
        const i = freeOf[p]!;
        let rbx = 0;
        let rby = 0;
        const ci = cosV[i]!;
        const si = sinV[i]!;
        const start = off[i]!;
        const end = off[i + 1]!;
        for (let k = start; k < end; k++) {
          const j = nbrIdx[k]!;
          const w = effNbrW[k]!;
          const ex = restX[i]! - restX[j]!;
          const ey = restY[i]! - restY[j]!;
          const cs = ci + cosV[j]!;
          const sn = si + sinV[j]!;
          rbx += w * 0.5 * (cs * ex - sn * ey);
          rby += w * 0.5 * (sn * ex + cs * ey);
          // Pinned neighbours contribute their fixed position to the RHS.
          if (compactOf[j]! < 0) {
            rbx += w * x[j]!;
            rby += w * y[j]!;
          }
        }
        bx[p] = rbx;
        by[p] = rby;
      }
      choleskySolve(L, m, bx, sx);
      choleskySolve(L, m, by, sy);
      for (let p = 0; p < m; p++) {
        const i = freeOf[p]!;
        x[i] = sx[p]!;
        y[i] = sy[p]!;
      }
    } else {
      // Gauss–Seidel fallback (large mesh or non-PD reduced system).
      for (let sweep = 0; sweep < GS_SWEEPS; sweep++) {
        for (let i = 0; i < n; i++) {
          if (pinnedFlag[i] || compactOf[i]! < 0) continue;
          const d = effDiag[i]!;
          let accX = 0;
          let accY = 0;
          const ci = cosV[i]!;
          const si = sinV[i]!;
          const start = off[i]!;
          const end = off[i + 1]!;
          for (let k = start; k < end; k++) {
            const j = nbrIdx[k]!;
            const w = effNbrW[k]!;
            const ex = restX[i]! - restX[j]!;
            const ey = restY[i]! - restY[j]!;
            const cs = ci + cosV[j]!;
            const sn = si + sinV[j]!;
            accX += w * (x[j]! + 0.5 * (cs * ex - sn * ey));
            accY += w * (y[j]! + 0.5 * (sn * ex + cs * ey));
          }
          x[i] = accX / d;
          y[i] = accY / d;
        }
      }
    }
  }

  // Assemble output; UVs carried straight from the rest mesh.
  const out = new Float32Array(verts.length);
  for (let i = 0; i < n; i++) {
    const xi = x[i]!;
    const yi = y[i]!;
    if (!Number.isFinite(xi) || !Number.isFinite(yi)) {
      // Pathological (singular) result → fall back to the LBS field wholesale.
      return lbsResult;
    }
    out[i * 4 + 0] = xi;
    out[i * 4 + 1] = yi;
    out[i * 4 + 2] = verts[i * 4 + 2]!;
    out[i * 4 + 3] = verts[i * 4 + 3]!;
  }
  return out;
}
