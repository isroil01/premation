import type { SceneNode } from '../types';
import { deformArap } from './arap';
import { earClip, subdivide, polygonArea } from './mesh';

export interface PuppetPin {
  id: string;
  name: string;
  x: number; // local coordinate x
  y: number; // local coordinate y
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
   * Meshing strategy. 'grid' (default) is the uniform grid culled against the
   * layer's silhouette / alpha; 'silhouette' ear-clips the outline itself, which
   * distributes triangles far better on thin diagonal artwork where a grid
   * wastes vertices and produces slivers.
   */
  meshMode?: 'grid' | 'silhouette';
}

export interface DeformedMesh {
  vertices: Float32Array; // flat [x, y, u, v, ...]
  triangles: Uint16Array; // flat triangle indices
  pinRestPositions: Record<string, { x: number; y: number }>;
  weights: Record<string, Float32Array>; // pinId -> vertex weights
}

/** Read a node's puppet rig from its fx component. */
export function readNodePuppet(node: SceneNode): PuppetRig | undefined {
  const fx = node.components.find((c) => c.type === 'fx');
  return fx?.props.puppet as PuppetRig | undefined;
}

/** Even-odd point-in-polygon test (deterministic, no epsilon randomness). */
function pointInPolygon(px: number, py: number, poly: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Is the local-space point (x, y) covered by the alpha mask? The mesh is centered
 * on the origin, so local x∈[-w/2, w/2] maps to image u∈[0,1] (v likewise, top→
 * bottom). Points in the pad/expansion margin fall outside [0,1] → not covered,
 * which is exactly what culls the transparent bbox corners.
 */
function coverageCovered(
  mask: PuppetCoverageMask,
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  const u = (x + width / 2) / width;
  const v = (y + height / 2) / height;
  if (u < 0 || u >= 1 || v < 0 || v >= 1) return false;
  const c = Math.min(mask.cols - 1, Math.max(0, Math.floor(u * mask.cols)));
  const r = Math.min(mask.rows - 1, Math.max(0, Math.floor(v * mask.rows)));
  return mask.cells[r * mask.cols + c] !== 0;
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
 * Generate the rest mesh and compute Laplacian harmonic weights for each pin.
 * Recomputes deterministically on document load / pin changes.
 *
 * Grid cells fully outside the artwork are discarded — keeping every cell with
 * any coverage plus one ring of margin — so weights diffuse along the artwork
 * instead of across empty bbox corners. Coverage comes from either a
 * `silhouette` polygon (shape/text layers with path geometry) or an alpha
 * `coverage` mask (image layers with a decoded bitmap). When neither is provided
 * (or both are degenerate) the plain bbox grid is used.
 */
export function buildRestMesh(
  width: number,
  height: number,
  pad: number,
  rig: PuppetRig,
  silhouette?: PuppetSilhouette,
  coverage?: PuppetCoverageMask,
): DeformedMesh {
  // Silhouette mode ear-clips the outline itself rather than culling a grid.
  // Falls back to the grid when there is no usable closed outline, so the mode
  // is always safe to leave on.
  if (rig.meshMode === 'silhouette' && silhouette && silhouette.points.length >= 3) {
    const built = buildSilhouetteMesh(width, height, pad, rig, silhouette);
    if (built) return built;
  }
  const expansion = rig.meshExpansion ?? 8;
  const density = rig.meshDensity ?? 15; // default 15x15 subdivisions

  const cols = Math.max(2, Math.min(50, density));
  const rows = Math.max(2, Math.min(50, density));

  const halfW = width / 2;
  const halfH = height / 2;

  const Xmin = -halfW - pad - expansion;
  const Xmax = halfW + pad + expansion;
  const Ymin = -halfH - pad - expansion;
  const Ymax = halfH + pad + expansion;

  const gridVerts = (cols + 1) * (rows + 1);

  // 1. Generate full-grid vertex positions [x, y, u, v]
  const gridPos = new Float32Array(gridVerts * 4);
  let idx = 0;
  for (let r = 0; r <= rows; r++) {
    const fy = r / rows;
    const y = Ymin + fy * (Ymax - Ymin);
    for (let c = 0; c <= cols; c++) {
      const fx = c / cols;
      const x = Xmin + fx * (Xmax - Xmin);

      // Map to UV space coordinates of the rasterized texture (which includes pad)
      const u = (x + halfW + pad) / (width + 2 * pad);
      const v = (y + halfH + pad) / (height + 2 * pad);

      gridPos[idx * 4 + 0] = x;
      gridPos[idx * 4 + 1] = y;
      gridPos[idx * 4 + 2] = u;
      gridPos[idx * 4 + 3] = v;
      idx++;
    }
  }

  // 2. Decide which cells to keep. Default: all (bbox grid). A single coverage
  //    predicate — polygon silhouette OR image-alpha mask — drives the identical
  //    cull + one-ring-dilate machinery below.
  const cellCount = cols * rows;
  let keepCell: Uint8Array | null = null;
  const poly = silhouette?.points;
  const covered: ((x: number, y: number) => boolean) | null =
    poly && poly.length >= 3
      ? (x, y) => pointInPolygon(x, y, poly)
      : coverage && coverage.cols > 0 && coverage.rows > 0 && coverage.cells.length > 0
        ? (x, y) => coverageCovered(coverage, x, y, width, height)
        : null;
  if (covered) {
    // Inside flags per grid vertex, plus a per-cell center test for thin parts.
    const inside = new Uint8Array(gridVerts);
    for (let i = 0; i < gridVerts; i++) {
      inside[i] = covered(gridPos[i * 4 + 0]!, gridPos[i * 4 + 1]!) ? 1 : 0;
    }
    const kept = new Uint8Array(cellCount);
    let anyKept = false;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i0 = r * (cols + 1) + c;
        const i1 = i0 + 1;
        const i2 = i0 + (cols + 1);
        const i3 = i2 + 1;
        let keep = inside[i0]! || inside[i1]! || inside[i2]! || inside[i3]!;
        if (!keep) {
          const cx = (gridPos[i0 * 4 + 0]! + gridPos[i3 * 4 + 0]!) / 2;
          const cy = (gridPos[i0 * 4 + 1]! + gridPos[i3 * 4 + 1]!) / 2;
          keep = covered(cx, cy) ? 1 : 0;
        }
        if (keep) {
          kept[r * cols + c] = 1;
          anyKept = true;
        }
      }
    }
    if (anyKept) {
      // One ring of margin: dilate the kept-cell set by 1 (8-neighborhood).
      const dilated = new Uint8Array(cellCount);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (!kept[r * cols + c]) continue;
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              const rr = r + dr;
              const cc = c + dc;
              if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) dilated[rr * cols + cc] = 1;
            }
          }
        }
      }
      keepCell = dilated;
    }
  }

  // 3. Compact vertices to those referenced by kept cells and build triangles.
  let vertices: Float32Array;
  let triangles: Uint16Array;
  let numVertices: number;
  if (keepCell) {
    const remap = new Int32Array(gridVerts).fill(-1);
    let next = 0;
    let keptCells = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!keepCell[r * cols + c]) continue;
        keptCells++;
        const corners = [
          r * (cols + 1) + c,
          r * (cols + 1) + (c + 1),
          (r + 1) * (cols + 1) + c,
          (r + 1) * (cols + 1) + (c + 1),
        ];
        for (const g of corners) {
          if (remap[g]! < 0) remap[g] = next++;
        }
      }
    }
    numVertices = next;
    vertices = new Float32Array(numVertices * 4);
    for (let g = 0; g < gridVerts; g++) {
      const n = remap[g]!;
      if (n < 0) continue;
      vertices[n * 4 + 0] = gridPos[g * 4 + 0]!;
      vertices[n * 4 + 1] = gridPos[g * 4 + 1]!;
      vertices[n * 4 + 2] = gridPos[g * 4 + 2]!;
      vertices[n * 4 + 3] = gridPos[g * 4 + 3]!;
    }
    triangles = new Uint16Array(keptCells * 6);
    let triIdx = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!keepCell[r * cols + c]) continue;
        const i0 = remap[r * (cols + 1) + c]!;
        const i1 = remap[r * (cols + 1) + (c + 1)]!;
        const i2 = remap[(r + 1) * (cols + 1) + c]!;
        const i3 = remap[(r + 1) * (cols + 1) + (c + 1)]!;
        triangles[triIdx++] = i0;
        triangles[triIdx++] = i1;
        triangles[triIdx++] = i2;
        triangles[triIdx++] = i1;
        triangles[triIdx++] = i3;
        triangles[triIdx++] = i2;
      }
    }
  } else {
    numVertices = gridVerts;
    vertices = gridPos;
    triangles = new Uint16Array(cols * rows * 6);
    let triIdx = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i0 = r * (cols + 1) + c;
        const i1 = r * (cols + 1) + (c + 1);
        const i2 = (r + 1) * (cols + 1) + c;
        const i3 = (r + 1) * (cols + 1) + (c + 1);

        // Tri 1
        triangles[triIdx++] = i0;
        triangles[triIdx++] = i1;
        triangles[triIdx++] = i2;

        // Tri 2
        triangles[triIdx++] = i1;
        triangles[triIdx++] = i3;
        triangles[triIdx++] = i2;
      }
    }
  }

  return finishRestMesh(vertices, triangles, numVertices, rig);
}

/**
 * Shared tail of every meshing mode: anchor each pin to its nearest vertex,
 * build adjacency, solve the harmonic (Laplacian) weight columns, normalise.
 * Both the grid and silhouette paths end here, so pin binding and weighting can
 * never diverge between them.
 */
function finishRestMesh(
  vertices: Float32Array,
  triangles: Uint16Array,
  numVertices: number,
  rig: PuppetRig,
): DeformedMesh {
  // 3. Find closest mesh vertex for each pin
  const pinRestPositions: Record<string, { x: number; y: number }> = {};
  const pinVertexIndices: Record<string, number> = {};
  const pinVertexIndicesList: number[] = [];

  for (const pin of rig.pins) {
    pinRestPositions[pin.id] = { x: pin.x, y: pin.y };

    let minDist = Infinity;
    let bestIdx = 0;
    for (let i = 0; i < numVertices; i++) {
      const vx = vertices[i * 4 + 0]!;
      const vy = vertices[i * 4 + 1]!;
      const dist = Math.hypot(vx - pin.x, vy - pin.y);
      if (dist < minDist) {
        minDist = dist;
        bestIdx = i;
      }
    }
    pinVertexIndices[pin.id] = bestIdx;
    pinVertexIndicesList.push(bestIdx);
  }

  // 4. Build adjacency/neighbors list
  const neighbors: number[][] = Array.from({ length: numVertices }, () => []);
  for (let i = 0; i < triangles.length; i += 3) {
    const a = triangles[i]!;
    const b = triangles[i + 1]!;
    const c = triangles[i + 2]!;

    if (!neighbors[a]!.includes(b)) neighbors[a]!.push(b);
    if (!neighbors[b]!.includes(a)) neighbors[b]!.push(a);
    if (!neighbors[b]!.includes(c)) neighbors[b]!.push(c);
    if (!neighbors[c]!.includes(b)) neighbors[c]!.push(b);
    if (!neighbors[c]!.includes(a)) neighbors[c]!.push(a);
    if (!neighbors[a]!.includes(c)) neighbors[a]!.push(c);
  }

  // 5. Solve for Laplacian weights using Jacobi iteration (150 iterations)
  const weights: Record<string, Float32Array> = {};
  const pinsList = rig.pins;

  for (const pin of pinsList) {
    const targetIdx = pinVertexIndices[pin.id]!;
    let W = new Float32Array(numVertices);
    W[targetIdx] = 1.0;

    const locked = new Set(pinVertexIndicesList);

    for (let iter = 0; iter < 150; iter++) {
      const nextW = new Float32Array(numVertices);
      nextW[targetIdx] = 1.0;
      for (const vk of pinVertexIndicesList) {
        if (vk !== targetIdx) nextW[vk] = 0.0;
      }

      for (let i = 0; i < numVertices; i++) {
        if (locked.has(i)) continue;
        const nb = neighbors[i]!;
        if (nb.length === 0) continue;
        let sum = 0;
        for (const n of nb) {
          sum += W[n]!;
        }
        nextW[i] = sum / nb.length;
      }
      W = nextW;
    }
    weights[pin.id] = W;
  }

  // 6. Normalize weights per vertex to sum to 1.0
  if (pinsList.length > 0) {
    for (let i = 0; i < numVertices; i++) {
      let sum = 0;
      for (const pin of pinsList) {
        const w = weights[pin.id];
        if (w) sum += w[i] ?? 0;
      }
      if (sum > 0) {
        for (const pin of pinsList) {
          const w = weights[pin.id];
          if (w) w[i] = (w[i] ?? 0) / sum;
        }
      } else {
        const uniform = 1.0 / pinsList.length;
        for (const pin of pinsList) {
          const w = weights[pin.id];
          if (w) w[i] = uniform;
        }
      }
    }
  }

  return {
    vertices,
    triangles,
    pinRestPositions,
    weights,
  };
}

/**
 * Silhouette-conforming mesh: ear-clip the layer's own outline, then subdivide
 * for interior resolution. On thin diagonal artwork a uniform grid spends most
 * of its vertices on empty space and leaves slivers along the edge; triangulating
 * the outline puts every vertex on the artwork and follows the boundary exactly.
 *
 * `meshDensity` maps to subdivision rounds (each round splits every triangle
 * into four), capped so a dense setting cannot explode the vertex count past the
 * Uint16 index limit.
 *
 * Returns null when the outline cannot be triangulated (self-intersecting,
 * degenerate) so the caller falls back to the grid — never throws.
 */
function buildSilhouetteMesh(
  width: number,
  height: number,
  pad: number,
  rig: PuppetRig,
  silhouette: PuppetSilhouette,
): DeformedMesh | null {
  const poly = silhouette.points.map((p) => ({ x: p.x, y: p.y }));
  // Reject degenerate outlines BEFORE triangulating. `earClip` pushes the final
  // triangle of a 3-point ring unconditionally, so three collinear points yield
  // a zero-area "mesh" that passes a triangle-count check and then deforms
  // nothing. Require a real fraction of the layer's area.
  const minArea = Math.max(1, width * height * 1e-4);
  if (Math.abs(polygonArea(poly)) < minArea) return null;
  const tris = earClip(poly);
  if (tris.length === 0) return null;

  // density 2..50 → 0..3 subdivision rounds (4^3 = 64x triangles at the top).
  const density = Math.max(2, Math.min(50, rig.meshDensity ?? 15));
  const rounds = density < 8 ? 0 : density < 18 ? 1 : density < 32 ? 2 : 3;
  let mesh = subdivide({ vertices: poly, triangles: tris }, rounds);

  // Uint16 index buffer — bail to the grid rather than silently truncating.
  if (mesh.vertices.length > 65535) {
    mesh = subdivide({ vertices: poly, triangles: tris }, Math.max(0, rounds - 1));
    if (mesh.vertices.length > 65535) return null;
  }

  const numVertices = mesh.vertices.length;
  const vertices = new Float32Array(numVertices * 4);
  const halfW = width / 2;
  const halfH = height / 2;
  for (let i = 0; i < numVertices; i++) {
    const v = mesh.vertices[i]!;
    vertices[i * 4 + 0] = v.x;
    vertices[i * 4 + 1] = v.y;
    // Same UV mapping as the grid path: into the padded rasterized texture.
    vertices[i * 4 + 2] = (v.x + halfW + pad) / (width + 2 * pad);
    vertices[i * 4 + 3] = (v.y + halfH + pad) / (height + 2 * pad);
  }
  const triangles = new Uint16Array(mesh.triangles.length * 3);
  let ti = 0;
  for (const [a, b, c] of mesh.triangles) {
    triangles[ti++] = a;
    triangles[ti++] = b;
    triangles[ti++] = c;
  }
  return finishRestMesh(vertices, triangles, numVertices, rig);
}

const DEG_TO_RAD = Math.PI / 180;

/**
 * Swappable CPU skinning dispatcher: deform(pins, restMesh, solver) ->
 * deformedPositions. Defaults to ARAP (higher quality — preserves local
 * rigidity); 'lbs' selects the legacy Linear Blend Skinning path.
 *
 * ARAP always warm-starts from — and gracefully falls back to — the LBS field,
 * so degenerate inputs (<2 pins, singular systems) never produce NaN or throw.
 * Fully deterministic in either mode: pure arithmetic, fixed iteration counts,
 * no wall-clock or randomness. Same input → bit-identical output.
 */
export function deform(
  pins: DeformPin[],
  restMesh: DeformedMesh,
  solver: 'lbs' | 'arap' = 'arap',
  maxRotationDeg?: number,
): Float32Array {
  const clamped = clampPinRotations(pins, maxRotationDeg);
  const lbs = deformLbs(clamped, restMesh);
  if (solver === 'lbs') return lbs;
  return deformArap(clamped, restMesh, lbs, maxRotationDeg);
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
 * Bounded rest-mesh cache.
 *
 * The key embeds every pin's static `id:x:y`, so each pin add, each pin moved
 * in rest space, and each density / expansion change mints a NEW key. This map
 * had no eviction, so an authoring session leaked a full mesh — vertices,
 * triangles, and one Float32Array weight column PER PIN — for every rig state
 * ever visited. At max density that is ~175 KB a piece.
 *
 * Eviction is true LRU (a hit moves its entry to the end), NOT the
 * insertion-order policy the ARAP factor cache uses. That difference matters
 * here: the ACTIVE mesh is fetched every frame, and under insertion-order
 * eviction adding `CAP` pins in a row would evict the very mesh being rendered
 * and force a full rebuild + 150-iteration weight solve on the next frame.
 *
 * CAP is sized to comfortably exceed the number of layers rigged at once
 * (each rigged layer holds one live entry), while bounding worst-case memory
 * at roughly 3 MB.
 */
const REST_MESH_CACHE_CAP = 16;
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

/** Deterministic FNV-1a key for a silhouette polygon (0.1px quantization). */
function silhouetteKey(s?: PuppetSilhouette): string {
  const pts = s?.points;
  if (!pts || pts.length < 3) return 'nosil';
  let h = 2166136261 >>> 0;
  for (const p of pts) {
    h = (Math.imul(h ^ Math.round(p.x * 10), 16777619)) >>> 0;
    h = (Math.imul(h ^ Math.round(p.y * 10), 16777619)) >>> 0;
  }
  return `sil${pts.length}:${h}`;
}

/** Retrieve a cached rest mesh or build a new one if not cached. */
export function getCachedRestMesh(
  nodeId: string,
  width: number,
  height: number,
  pad: number,
  rig: PuppetRig,
  silhouette?: PuppetSilhouette,
  coverage?: PuppetCoverageMask,
): DeformedMesh {
  const pinsKey = rig.pins.map((p) => `${p.id}:${p.x}:${p.y}`).join(',');
  const covKey = coverage?.key ?? 'nocov';
  const key = `${nodeId}:${width}:${height}:${pad}:${rig.meshExpansion ?? 8}:${rig.meshDensity ?? 15}:${silhouetteKey(silhouette)}:${covKey}:${pinsKey}`;

  const cached = restMeshCache.get(key);
  if (cached) {
    // LRU touch: re-insert so the live mesh is always the most-recent entry and
    // can never be the one evicted.
    restMeshCache.delete(key);
    restMeshCache.set(key, cached);
    return cached;
  }

  const built = buildRestMesh(width, height, pad, rig, silhouette, coverage);
  if (restMeshCache.size >= REST_MESH_CACHE_CAP) {
    const oldest = restMeshCache.keys().next().value;
    if (oldest !== undefined) restMeshCache.delete(oldest);
  }
  restMeshCache.set(key, built);
  return built;
}

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
