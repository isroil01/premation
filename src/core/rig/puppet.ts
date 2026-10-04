import type { SceneNode } from '../types';

/**
 * What a pin controls. After Effects ships five Puppet tools; we keep the same
 * names so a user fluent in AE does not have to relearn them.
 *
 * `position` — drag to move this point on the mesh.
 * `starch` — keeps a region rigid so nearby pins cannot fold it.
 * `bend` — owns no position; rotation/scale act about a centre the other pins
 *          carry. See `bendPins.ts`.
 * `advanced` — position plus rotation and scale (the historical default).
 * `overlap` — sets which part draws in front when the mesh folds over itself.
 *
 * Absent means `advanced`, so every rig authored before the other tools
 * existed reads back unchanged.
 */
export type PinKind = 'position' | 'starch' | 'bend' | 'advanced' | 'overlap';

/** After Effects' five Puppet tools, in the order the flyout lists them. */
export const PIN_KIND_CATALOG: ReadonlyArray<{
  kind: PinKind;
  label: string;
  short: string;
  color: string;
  hint: string;
}> = [
  { kind: 'position', label: 'Puppet Position Pin Tool', short: 'Position', color: '#ffc107', hint: 'Drag to move this point on the mesh.' },
  { kind: 'starch', label: 'Puppet Starch Pin Tool', short: 'Starch', color: '#ff5252', hint: 'Keeps a region rigid so it resists bending.' },
  { kind: 'bend', label: 'Puppet Bend Pin Tool', short: 'Bend', color: '#7ee787', hint: 'Rotates around a point carried by other pins.' },
  { kind: 'advanced', label: 'Puppet Advanced Pin Tool', short: 'Advanced', color: '#ffd54f', hint: 'Position, plus rotation and scale.' },
  { kind: 'overlap', label: 'Puppet Overlap Pin Tool', short: 'Overlap', color: '#4fc3f7', hint: 'Sets which part draws in front when the mesh folds.' },
];

/** Absent `kind` is Advanced — every pin authored before the other tools existed. */
export function pinKindOf(pin: { kind?: PinKind }): PinKind {
  return pin.kind ?? 'advanced';
}

export function pinColor(kind: PinKind): string {
  return PIN_KIND_CATALOG.find((k) => k.kind === kind)?.color ?? '#ffc107';
}

export function pinHasTransformGizmo(kind: PinKind): boolean {
  return kind === 'advanced' || kind === 'bend';
}

export function draftPin(kind: PinKind, id: string, name: string, x: number, y: number): PuppetPin {
  const pin: PuppetPin = { id, name, x, y, kind };
  if (kind === 'starch') pin.stiffness = 8;
  if (kind === 'overlap') pin.overlap = 50;
  return pin;
}

export interface PuppetPin {
  id: string;
  name: string;
  /**
   * Rest-space anchor. For an `advanced` pin this is also the pin's live
   * position before animation; for a `bend` pin it is ONLY the rest anchor —
   * the live position is derived and this value is never used as a target.
   */
  x: number; // local coordinate x
  y: number; // local coordinate y
  /** Absent = 'advanced'. See {@link PinKind}. */
  kind?: PinKind;
  /**
   * The pin's STATIC position when it has no Position keys (engine API
   * `puppet/pins/<id>/position`, AE's un-keyed Puppet Pin Position). Absent =
   * the rest anchor `x`/`y`. Keys, when present, win.
   */
  position?: { x: number; y: number };
  /** Static rotation in degrees (AE-style: rotates the pin's influence around it). */
  rotation?: number;
  /** Static stiffness ≥ 0 (sharpens this pin's influence falloff; 0 = default). */
  stiffness?: number;
  /**
   * Static uniform scale around the pin (1 = unchanged). AE's Advanced pin is
   * position + rotation + SCALE; this is the third component. Absent or exactly
   * 1 reduces bit-identically to the unscaled path.
   */
  scale?: number;
  /**
   * Overlap depth (AE's blue Overlap pin). Positive brings the region this pin
   * governs toward the viewer, negative pushes it behind — so an arm can be made
   * to pass in FRONT of a torso where the mesh folds over itself. Range is
   * -100..100; absent means "no opinion" and the region composites flat.
   */
  overlap?: number;
  /**
   * How far this pin's overlap influence reaches, as a multiplier on its
   * harmonic weight falloff (default 1). Larger = a broader region carries the
   * pin's depth.
   */
  overlapExtent?: number;
}

/** The live (possibly animated) pin state fed to `deform`. */
export interface DeformPin {
  id: string;
  x: number;
  y: number;
  /** Absent = 'advanced'. A `bend` pin's `x`/`y` are ignored — see {@link PinKind}. */
  kind?: PinKind;
  /** Degrees. Rotates the displacement field rigidly around the pin. */
  rotation?: number;
  /** ≥ 0. Exponentiates/sharpens the pin's weight column (renormalized). */
  stiffness?: number;
  /** Uniform scale around the pin (1 = unchanged). */
  scale?: number;
  /** Overlap depth, -100..100. Drives per-vertex draw depth, not position. */
  overlap?: number;
  /** Falloff multiplier for this pin's overlap influence (default 1). */
  overlapExtent?: number;
}

/**
 * Layer silhouette (closed local-space polygon, centered like the mesh) used to
 * cull grid cells fully outside the artwork. Optional — image layers keep the
 * plain bbox grid.
 */
export interface PuppetSilhouette {
  points: Array<{ x: number; y: number }>;
}

/**
 * Alpha-derived coverage mask for image layers: a coarse row-major grid (row 0 =
 * top of the image) of 1/0 flags where 1 means "this cell of the bitmap has at
 * least one pixel opaque enough to be artwork". Feeds `buildRestMesh` the same
 * cell-culling machinery the polygon silhouette uses, so puppet pins on an image
 * deform only the visible pixels instead of the empty transparent bbox corners.
 * Normalised to the image box, so it is scale-independent.
 */
export interface PuppetCoverageMask {
  cols: number;
  rows: number;
  /** row-major (row 0 = top). 1 = covered, 0 = fully transparent. */
  cells: Uint8Array;
  /** Deterministic identity for the rest-mesh cache key. */
  key: string;
}

export interface PuppetRig {
  pins: PuppetPin[];
  meshExpansion?: number; // padding to expand past the boundary
  meshDensity?: number;   // controls grid divisions (e.g., 5 to 30)
  /**
   * Deformation solver. 'arap' (As-Rigid-As-Possible, the default) preserves
   * local rigidity so conflicting pin rotations bend instead of collapsing;
   * 'lbs' is the legacy Linear Blend Skinning path. Absent → 'arap'.
   */
  solver?: 'lbs' | 'arap';
  /**
   * Mesh Rotation Refinement (AE): the maximum rotation, in degrees, any single
   * pin may impose on the mesh. Sparse handle sets let ARAP's local step fit
   * large per-vertex rotations that read as twisting; clamping the magnitude
   * suppresses that without changing where the handles sit. Absent = unlimited,
   * and the solve is then bit-identical to the unclamped path.
   */
  maxRotationDeg?: number;
  /**
   * Meshing strategy. 'grid' (absent on old files) is the uniform grid culled
   * against the layer's silhouette / alpha; 'silhouette' ear-clips the outline
   * itself (or a PNG's alpha), which hugs a character instead of the
   * transparent bounding box. New rigs default to silhouette.
   */
  meshMode?: 'grid' | 'silhouette';
}

export interface DeformedMesh {
  vertices: Float32Array; // flat [x, y, u, v, ...]
  triangles: Uint16Array; // flat triangle indices
  pinRestPositions: Record<string, { x: number; y: number }>;
  weights: Record<string, Float32Array>; // pinId -> vertex weights
  /**
   * pinId → the mesh vertex each pin was anchored to (its nearest vertex).
   *
   * Already computed while binding pins; it used to be discarded at the end of
   * `finishRestMesh`. Bend pins need it: "where did the other pins carry this
   * pin's rest point" is answered by reading that vertex out of the deformed
   * array, which is exact, rather than re-blending an approximation of it.
   */
  pinVertexIndices: Record<string, number>;
  /**
   * Which mesher produced this. The AUTHORING OVERLAY needs it: AE's gold
   * lattice is drawn as boxes (a grid cell's diagonal omitted), and that rule
   * only makes sense on a grid. Applied to an outline mesh it keeps whichever
   * edges happen to be axis-aligned and drops the rest, which draws a scatter
   * of disconnected dashes over the artwork.
   *
   * Optional so a mesh built by older code (or by a test) still type-checks;
   * absent reads as 'grid', which is what every such mesh is.
   */
  layout?: 'grid' | 'outline';
}

/** Read a node's puppet rig from its fx component. */
export function readNodePuppet(node: SceneNode): PuppetRig | undefined {
  const fx = node.components.find((c) => c.type === 'fx');
  return fx?.props.puppet as PuppetRig | undefined;
}

/**
 * Derive a coarse coverage mask from a decoded bitmap's alpha channel, fully
 * deterministically: a fixed `maxSamples`×`maxSamples` grid (capped at the image
 * size), each cell covered when any of a bounded, evenly-strided set of pixels in
 * its region has alpha ≥ `alphaThreshold`. No randomness, no time — the same
 * bitmap always yields the same mask, so it can be cached by asset identity.
 */
export function coverageMaskFromImageData(
  img: { data: Uint8ClampedArray | Uint8Array; width: number; height: number },
  opts?: { maxSamples?: number; alphaThreshold?: number },
): PuppetCoverageMask {
  const maxSamples = Math.max(2, Math.min(64, Math.floor(opts?.maxSamples ?? 64)));
  const threshold = Math.max(1, Math.min(255, Math.floor(opts?.alphaThreshold ?? 12)));
  const W = Math.max(1, img.width | 0);
  const H = Math.max(1, img.height | 0);
  const cols = Math.max(1, Math.min(maxSamples, W));
  const rows = Math.max(1, Math.min(maxSamples, H));
  const cells = new Uint8Array(cols * rows);
  const data = img.data;
  // Per-cell sub-sampling budget: at most 8×8 evenly-spaced probes, max alpha.
  const SUB = 8;
  for (let ry = 0; ry < rows; ry++) {
    const y0 = Math.floor((ry / rows) * H);
    const y1 = Math.max(y0 + 1, Math.floor(((ry + 1) / rows) * H));
    const stepY = Math.max(1, Math.floor((y1 - y0) / SUB));
    for (let cx = 0; cx < cols; cx++) {
      const x0 = Math.floor((cx / cols) * W);
      const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) / cols) * W));
      const stepX = Math.max(1, Math.floor((x1 - x0) / SUB));
      let maxA = 0;
      for (let py = y0; py < y1 && maxA < threshold; py += stepY) {
        const rowBase = py * W;
        for (let px = x0; px < x1; px += stepX) {
          const a = data[(rowBase + px) * 4 + 3]!;
          if (a > maxA) {
            maxA = a;
            if (maxA >= threshold) break;
          }
        }
      }
      cells[ry * cols + cx] = maxA >= threshold ? 1 : 0;
    }
  }
  // FNV-1a over dims + threshold + cell bytes → stable cache identity.
  let h = 2166136261 >>> 0;
  h = (Math.imul(h ^ cols, 16777619)) >>> 0;
  h = (Math.imul(h ^ rows, 16777619)) >>> 0;
  h = (Math.imul(h ^ threshold, 16777619)) >>> 0;
  for (let i = 0; i < cells.length; i++) h = (Math.imul(h ^ cells[i]!, 16777619)) >>> 0;
  return { cols, rows, cells, key: `cov${cols}x${rows}:${h}` };
}

/**
 * Make the given pins' weight columns a partition of unity: every vertex's
 * columns sum to 1.
 *
 * Where the harmonic solve left NOTHING (sum 0) the vertex is unreachable from
 * every listed pin. The default is to leave it at zero so it STAYS AT REST — a
 * disconnected alpha island with no pin of its own must not move at all. The
 * old equal-share fallback made every such island travel by the AVERAGE of all
 * pin displacements, which is exactly the "drag one hand and the whole PNG
 * smears" failure. `uniformWhere` re-opens the equal-share branch per vertex
 * for the one caller that needs it: `bendPins.driverRestMesh` re-normalises
 * over the DRIVERS alone, and a bend pin's own anchor vertex (Dirichlet-locked
 * to 0 in every driver column, but very much part of the connected artwork)
 * must travel with the drivers rather than act as a starch pin.
 */
export function normalizeWeightColumns(
  weights: Record<string, Float32Array>,
  pinIds: readonly string[],
  numVertices: number,
  uniformWhere?: Uint8Array,
): void {
  if (pinIds.length === 0) return;
  for (let i = 0; i < numVertices; i++) {
    let sum = 0;
    for (const id of pinIds) {
      const w = weights[id];
      if (w) sum += w[i] ?? 0;
    }
    if (sum > 0) {
      for (const id of pinIds) {
        const w = weights[id];
        if (w) w[i] = (w[i] ?? 0) / sum;
      }
    } else if (uniformWhere?.[i]) {
      const uniform = 1.0 / pinIds.length;
      for (const id of pinIds) {
        const w = weights[id];
        if (w) w[i] = uniform;
      }
    }
    // else: reachable from no pin — leave zero, the vertex stays at rest.
  }
}

const DEG_TO_RAD = Math.PI / 180;

/**
 * Map a point in DEFORMED mesh space back to rest space.
 *
 * A pin's `x`/`y` is a rest-space anchor, but the user places a pin by clicking
 * the artwork as it currently looks — which, once any pin has moved, is the
 * deformed mesh. Storing that click as the anchor binds the new pin to whatever
 * rest vertex happens to lie under a deformed-space coordinate (a different
 * body part, or empty space), and because a fresh pin's live position IS its
 * anchor, the mesh then snaps toward it the instant the pin lands. Inverting
 * the deformation first puts the anchor on the artwork the user actually
 * clicked.
 *
 * Finds the deformed triangle containing `p` and carries its barycentric
 * coordinates onto the rest triangle. Returns null when no triangle contains
 * the point (outside the mesh, or in a fold the painter's order hides) — the
 * caller then falls back to the raw coordinate. Where several folded triangles
 * overlap, the first in index order wins, deterministically.
 */
export function restPointFromDeformed(
  p: { x: number; y: number },
  restMesh: DeformedMesh,
  deformed: Float32Array,
): { x: number; y: number } | null {
  const tris = restMesh.triangles;
  const rest = restMesh.vertices;
  // A little tolerance so a click exactly on a shared edge is not lost to
  // floating point between the two triangles that own it.
  const EPS = -1e-4;
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t]!;
    const b = tris[t + 1]!;
    const c = tris[t + 2]!;
    const ax = deformed[a * 4]!, ay = deformed[a * 4 + 1]!;
    const bx = deformed[b * 4]!, by = deformed[b * 4 + 1]!;
    const cx = deformed[c * 4]!, cy = deformed[c * 4 + 1]!;
    const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(det) < 1e-12) continue;
    const u = ((bx - p.x) * (cy - p.y) - (cx - p.x) * (by - p.y)) / det;
    const v = ((cx - p.x) * (ay - p.y) - (ax - p.x) * (cy - p.y)) / det;
    const w = 1 - u - v;
    if (u < EPS || v < EPS || w < EPS) continue;
    return {
      x: u * rest[a * 4]! + v * rest[b * 4]! + w * rest[c * 4]!,
      y: u * rest[a * 4 + 1]! + v * rest[b * 4 + 1]! + w * rest[c * 4 + 1]!,
    };
  }
  return null;
}

/**
 * Mesh Rotation Refinement, pin side: clamp each pin's authored rotation to
 * ±`maxRotationDeg`. Returns the SAME array when there is no limit or nothing
 * exceeds it, so the untouched path stays bit-identical (and allocation-free).
 */
export function clampPinRotations(pins: DeformPin[], maxRotationDeg?: number): DeformPin[] {
  if (maxRotationDeg === undefined || !Number.isFinite(maxRotationDeg)) return pins;
  const lim = Math.abs(maxRotationDeg);
  let needs = false;
  for (const p of pins) {
    if (Math.abs(p.rotation ?? 0) > lim) { needs = true; break; }
  }
  if (!needs) return pins;
  return pins.map((p) => {
    const r = p.rotation ?? 0;
    return Math.abs(r) <= lim ? p : { ...p, rotation: r < 0 ? -lim : lim };
  });
}

/**
 * Linear Blend Skinning with per-pin rigid transforms:
 *   • translation — the pin's displacement from its rest position;
 *   • rotation (AE-style) — the displacement field rotates rigidly around the
 *     pin, weighted by that pin's weight;
 *   • stiffness — sharpens the pin's influence falloff by exponentiating its
 *     weight column and renormalizing per vertex.
 *
 * Fully deterministic: pure arithmetic, no wall-clock or randomness. With no
 * rotation/stiffness on any pin the result is bit-identical to the legacy
 * translate-only path.
 */
export function deformLbs(pins: DeformPin[], restMesh: DeformedMesh): Float32Array {
  const restVertices = restMesh.vertices;
  const numVertices = restVertices.length / 4;
  const deformedVertices = new Float32Array(restVertices.length);

  // Precompute per-pin data once (not per vertex) for determinism and speed.
  const n = pins.length;
  const weightCols: Array<Float32Array | undefined> = new Array(n);
  const restX = new Float64Array(n);
  const restY = new Float64Array(n);
  const dX = new Float64Array(n);
  const dY = new Float64Array(n);
  const cosR = new Float64Array(n);
  const sinR = new Float64Array(n);
  /** True when the pin needs the full rigid branch (rotation and/or scale). */
  const rotated: boolean[] = new Array(n).fill(false);
  const stiffExp = new Float64Array(n);
  let hasStiffness = false;
  for (let p = 0; p < n; p++) {
    const pin = pins[p]!;
    weightCols[p] = restMesh.weights[pin.id];
    const rest = restMesh.pinRestPositions[pin.id];
    restX[p] = rest?.x ?? pin.x;
    restY[p] = rest?.y ?? pin.y;
    dX[p] = rest ? pin.x - rest.x : 0;
    dY[p] = rest ? pin.y - rest.y : 0;
    const rot = pin.rotation ?? 0;
    const scl = pin.scale ?? 1;
    // Fold uniform scale into the rotation matrix — a similarity transform.
    // rot 0 + scale 1 leaves `rotated` false, so the translate-only fast path
    // (and its bit-identical output) is untouched.
    if ((rot !== 0 || scl !== 1) && rest) {
      rotated[p] = true;
      cosR[p] = Math.cos(rot * DEG_TO_RAD) * scl;
      sinR[p] = Math.sin(rot * DEG_TO_RAD) * scl;
    }
    const s = Math.max(0, pin.stiffness ?? 0);
    stiffExp[p] = 1 + s;
    if (s > 0) hasStiffness = true;
  }

  const w = new Float64Array(n);

  for (let i = 0; i < numVertices; i++) {
    const vx = restVertices[i * 4 + 0]!;
    const vy = restVertices[i * 4 + 1]!;
    const u = restVertices[i * 4 + 2]!;
    const v = restVertices[i * 4 + 3]!;

    // Effective weights: raw harmonic weights, optionally sharpened.
    if (hasStiffness) {
      let sum = 0;
      for (let p = 0; p < n; p++) {
        const base = weightCols[p]?.[i] ?? 0;
        const sharp = base > 0 ? Math.pow(base, stiffExp[p]!) : 0;
        w[p] = sharp;
        sum += sharp;
      }
      if (sum > 1e-12) {
        for (let p = 0; p < n; p++) w[p] = w[p]! / sum;
      } else {
        for (let p = 0; p < n; p++) w[p] = weightCols[p]?.[i] ?? 0;
      }
    } else {
      for (let p = 0; p < n; p++) w[p] = weightCols[p]?.[i] ?? 0;
    }

    let dispX = 0;
    let dispY = 0;

    for (let p = 0; p < n; p++) {
      const wp = w[p]!;
      if (wp > 0 && weightCols[p]) {
        if (rotated[p]) {
          // Rigid transform: rotate the vertex around the pin's rest position,
          // then translate by the pin displacement. Expressed as a displacement
          // so θ=0 reduces exactly to the translate-only path.
          const relX = vx - restX[p]!;
          const relY = vy - restY[p]!;
          const tx = cosR[p]! * relX - sinR[p]! * relY + restX[p]! + dX[p]! - vx;
          const ty = sinR[p]! * relX + cosR[p]! * relY + restY[p]! + dY[p]! - vy;
          dispX += wp * tx;
          dispY += wp * ty;
        } else {
          dispX += wp * dX[p]!;
          dispY += wp * dY[p]!;
        }
      }
    }

    deformedVertices[i * 4 + 0] = vx + dispX;
    deformedVertices[i * 4 + 1] = vy + dispY;
    deformedVertices[i * 4 + 2] = u;
    deformedVertices[i * 4 + 3] = v;
  }

  return deformedVertices;
}
/**
 * Per-vertex OVERLAP DEPTH (AE's blue Overlap pin), diffused through the same
 * harmonic weight columns the deformation uses:
 *
 *     d_i = Σ_p W_p(i)^(1/extent_p) · overlap_p   (normalised by the same weights)
 *
 * `overlapExtent` reaches further by flattening the pin's falloff (a root, the
 * inverse of what `stiffness` does with a power). The result is a signed scalar
 * per vertex: positive draws toward the viewer, so an arm can be made to pass in
 * front of a torso where the mesh folds over itself.
 *
 * Returns null when no pin declares an overlap — callers then skip depth
 * entirely and the mesh composites exactly as before.
 */
export function overlapDepthField(
  pins: DeformPin[],
  restMesh: DeformedMesh,
): Float32Array | null {
  let any = false;
  for (const p of pins) {
    if ((p.overlap ?? 0) !== 0 && restMesh.weights[p.id]) { any = true; break; }
  }
  if (!any) return null;

  const n = restMesh.vertices.length / 4;
  const depth = new Float32Array(n);
  const total = new Float32Array(n);
  for (const pin of pins) {
    const o = pin.overlap ?? 0;
    if (o === 0) continue;
    const col = restMesh.weights[pin.id];
    if (!col || col.length < n) continue;
    const extent = Math.max(0.05, pin.overlapExtent ?? 1);
    const exp = 1 / extent;
    for (let i = 0; i < n; i++) {
      const w = col[i] ?? 0;
      if (w <= 0) continue;
      const wf = extent === 1 ? w : Math.pow(w, exp);
      depth[i] = depth[i]! + wf * o;
      total[i] = total[i]! + wf;
    }
  }
  for (let i = 0; i < n; i++) {
    if (total[i]! > 1e-12) depth[i] = depth[i]! / total[i]!;
  }
  return depth;
}

/**
 * Reorder triangles back-to-front by their overlap depth — a painter's-algorithm
 * resolve of the mesh's self-occlusion.
 *
 * WHY ORDERING RATHER THAN A DEPTH BUFFER: overlap is a LAYER-LOCAL question
 * ("does this arm pass in front of this torso?"), not a scene-depth one. The
 * mesh is a single textured draw with alpha blending, so a real depth test would
 * both need a fifth vertex attribute (shader + pipeline change) and fight
 * blending at the silhouette edges. Sorting the index buffer needs neither: the
 * geometry, the shader and the blend state are untouched, and for an opaque
 * folded mesh the result is the same picture.
 *
 * Deterministic: a stable sort keyed on (depth, original index), so equal depths
 * keep their authored order and the output never depends on sort internals.
 */
export function sortTrianglesByDepth(
  triangles: Uint16Array,
  depth: Float32Array,
): Uint16Array {
  const triCount = triangles.length / 3;
  const order = new Array<number>(triCount);
  const key = new Float64Array(triCount);
  for (let t = 0; t < triCount; t++) {
    order[t] = t;
    key[t] =
      (depth[triangles[t * 3]!]! +
        depth[triangles[t * 3 + 1]!]! +
        depth[triangles[t * 3 + 2]!]!) / 3;
  }
  // Ascending: most-negative (furthest back) drawn first, so positive overlap
  // ends up painted last and therefore on top.
  order.sort((a, b) => (key[a]! - key[b]!) || (a - b));
  const out = new Uint16Array(triangles.length);
  for (let i = 0; i < triCount; i++) {
    const t = order[i]!;
    out[i * 3] = triangles[t * 3]!;
    out[i * 3 + 1] = triangles[t * 3 + 1]!;
    out[i * 3 + 2] = triangles[t * 3 + 2]!;
  }
  return out;
}

const restMeshCache = new Map<string, DeformedMesh>();

/** Test/debug seam: drop cached rest meshes. */
export function clearRestMeshCache(): void {
  restMeshCache.clear();
}

/** Test/debug seam: current cache occupancy. */
export function restMeshCacheSize(): number {
  return restMeshCache.size;
}

/**
 * Build a silhouette from a layer's path outline (local centered coordinates,
 * the same space as pins/mesh). Returns undefined when there is no usable
 * closed outline — callers then fall back to the bbox grid.
 */
export function silhouetteFromPathPoints(
  points: Array<{ x: number; y: number }> | undefined,
  open?: boolean,
): PuppetSilhouette | undefined {
  if (open || !points || points.length < 3) return undefined;
  return { points: points.map((p) => ({ x: p.x, y: p.y })) };
}

/**
 * The outline `buildRestMesh` should EAR-CLIP.
 *
 * A closed vector path always wins, and it is the only thing that ever wins:
 * an image layer returns undefined here and keeps its alpha as a coverage MASK.
 * That is not because an image gets no outline — in `'silhouette'` mode it now
 * gets a much better one — but because the two go through different meshers.
 * Handing the raw traced occupancy to `earClip` (which is what returning it
 * here would do) produces sliver triangles that ARAP then shreds; see
 * `silhouetteFromCoverage` below and the counter-example in
 * `puppetCharacterTear.test.ts`. The image route is `alphaMesh.ts`, reached
 * from `buildRestMesh` off the coverage mask directly.
 */
export function resolvePuppetSilhouette(
  pathSil: PuppetSilhouette | undefined,
  _coverage: PuppetCoverageMask | undefined,
  _width: number,
  _height: number,
  _meshMode: PuppetRig['meshMode'],
): PuppetSilhouette | undefined {
  if (pathSil && pathSil.points.length >= 3) return pathSil;
  return undefined;
}
