/**
 * Outline → extruded triangle mesh.
 *
 * This is what replaces the quad-synthesis model of `scene/extrusion.ts` for
 * rendering: instead of approximating a solid with flat strips (20 facets
 * around a cylinder, a stack of 400 plates for a glyph), the outline of the
 * layer — rect, rounded rect, ellipse, path, traced text — is swept along z
 * into a single watertight mesh with:
 *
 *   • SIDE WALLS — one quad per outline edge, sharing vertices along runs
 *     where adjacent edges meet below `smoothAngleDeg` (a polygonised curve
 *     lights as a smooth surface) and splitting them at real corners (a box
 *     keeps crisp edges);
 *   • BEVELS — a chamfer ring on the front and back between an inset copy of
 *     the outline and the outline proper, with `angular` (one flat chamfer),
 *     `convex` (quarter-round, bulging out) and `concave` (cove) profiles;
 *   • CAPS — the back cap always (and the front when asked), triangulated
 *     with holes so a glyph's counters stay open.
 *
 * Frame: layer-centred pixels, y down, +z AWAY from the viewer (the default
 * camera looks down +z — see project3d.ts). The front cap sits at z = 0, the
 * back at z = depth.
 *
 * Output is ONE interleaved vertex buffer (position xyz, normal xyz, uv) and
 * an index buffer with a per-role range table, so the renderer can draw each
 * material group (back / side / bevel / front) as its own indexed draw off
 * shared buffers. Pure; no DOM.
 */

import { triangulateRings, groupRings, signedArea, dedupeRing, type Pt2, type Ring } from './polygonTriangulate';

export type MeshRole = 'front' | 'back' | 'side' | 'bevel';

export type BevelProfile = 'angular' | 'concave' | 'convex';

export interface ExtrudeOptions {
  /** z extent in px; the solid spans z ∈ [0, depth]. */
  depth: number;
  /** Chamfer size in px per side (0 = none). Clamped to depth/2 and to a
   *  fraction of the outline's smallest extent. */
  bevel?: number;
  bevelStyle?: BevelProfile;
  /** Segments across a concave/convex profile (angular is always 1). */
  bevelSegments?: number;
  /** Corners sharper than this split their wall normals; gentler ones smooth. */
  smoothAngleDeg?: number;
  /** Emit the front cap (off by default — the layer's own quad draws it). */
  frontCap?: boolean;
  /** Emit the back cap (default on). */
  backCap?: boolean;
  /** Box the cap UVs are normalised against (layer width/height). Defaults
   *  to the outline's bounding box. */
  uvBox?: { x: number; y: number; width: number; height: number };
}

export interface MeshRange {
  role: MeshRole;
  /** First index (not byte) into `indices`. */
  first: number;
  /** Index count. */
  count: number;
}

export interface ExtrudedMesh {
  /** Interleaved: x y z  nx ny nz  u v — 8 floats, 32 bytes per vertex. */
  vertices: Float32Array;
  vertexCount: number;
  indices: Uint16Array | Uint32Array;
  ranges: MeshRange[];
  /** Bevel actually applied (after clamping), px. The front cap must inset by this. */
  bevel: number;
}

export const MESH_VERTEX_FLOATS = 8;
export const MESH_VERTEX_STRIDE_BYTES = MESH_VERTEX_FLOATS * 4;

const DEG = Math.PI / 180;

interface Corner {
  /** Outline position. */
  x: number;
  y: number;
  /** Unit 2D outward normal for THIS corner record. */
  nx: number;
  ny: number;
  /** Inset position (outline moved inward by the bevel, mitred). */
  ix: number;
  iy: number;
}

interface PreparedRing {
  /** Corner records, in ring order; `edgeStart[i]`/`edgeEnd[i]` index them. */
  corners: Corner[];
  /** For edge i (p_i → p_{i+1}): which corner record starts / ends it. */
  edgeStart: number[];
  edgeEnd: number[];
  /** Outline and inset rings as plain point lists (one per outline vertex). */
  outline: Pt2[];
  inset: Pt2[];
  hole: boolean;
}

/**
 * Build the per-ring corner table: outward edge normals, smooth-vs-hard
 * decisions, and the mitred inset.
 */
function prepareRing(pts: ReadonlyArray<Pt2>, hole: boolean, bevel: number, smoothCos: number): PreparedRing | null {
  const ring = dedupeRing(pts);
  const n = ring.length;
  if (n < 3) return null;
  // Outer rings positive area, holes negative — then (dy, −dx) is outward for
  // both (into the hole for a hole, which is away from the solid).
  const area = signedArea(ring);
  if ((area < 0) !== hole) ring.reverse();
  const ringArea = signedArea(ring);

  const en: Array<{ x: number; y: number }> = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    en[i] = { x: dy / len, y: -dx / len };
  }

  const outline: Pt2[] = ring.map((p) => ({ x: p.x, y: p.y }));

  /*
    LOCAL CLEARANCE — how much room each vertex has before the inset would
    cross the ring's own opposite wall. A glyph's stroke is a long thin loop:
    the two sides run a few pixels apart while being far apart ALONG the ring.
    That signature — euclidean distance far smaller than arc distance — is the
    test; a smooth curve (ellipse) or a sparse ring (rect) never trips it, so
    only genuinely pinched outlines are limited. Quadratic, but rings are at
    most a few thousand points and the mesh is cached per outline.
  */
  const clearance: number[] = new Array(n).fill(Infinity);
  if (bevel > 0) {
    const arc: number[] = new Array(n + 1);
    arc[0] = 0;
    for (let i = 0; i < n; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % n]!;
      arc[i + 1] = arc[i]! + Math.hypot(b.x - a.x, b.y - a.y);
    }
    const total = arc[n]!;
    const reach = bevel * 4;
    for (let i = 0; i < n; i++) {
      const a = ring[i]!;
      for (let j = i + 2; j < n; j++) {
        const b = ring[j]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        if (Math.abs(dx) > reach || Math.abs(dy) > reach) continue;
        const d = Math.hypot(dx, dy);
        if (d >= reach) continue;
        const along = Math.min(arc[j]! - arc[i]!, total - (arc[j]! - arc[i]!));
        if (along < d * 3) continue; // the ring merely continues; not a far wall
        if (d < clearance[i]!) clearance[i] = d;
        if (d < clearance[j]!) clearance[j] = d;
      }
    }
  }

  const insetAt = (b: number): Pt2[] => {
    const out: Pt2[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = ring[i]!;
      const nPrev = en[(i - 1 + n) % n]!;
      const nNext = en[i]!;
      // Mitred inset along the bisector of the two edge normals. For a 90°
      // corner this is exactly bevel·√2 along the diagonal — the inset square.
      let bx = nPrev.x + nNext.x;
      let by = nPrev.y + nNext.y;
      const bl = Math.hypot(bx, by);
      // Never travel past ~half the local thickness — the vertex-wise version
      // of the global thinness clamp, for the pinches that clamp cannot see.
      const cap = clearance[i]! * 0.45;
      if (bl < 1e-6) {
        // 180° reversal — no sensible bisector; inset along one normal.
        const d = Math.min(b, cap);
        out[i] = { x: p.x - nNext.x * d, y: p.y - nNext.y * d };
      } else {
        bx /= bl;
        by /= bl;
        const cosHalf = Math.max(0.35, bx * nNext.x + by * nNext.y); // miter limit ≈ 2.9×
        const d = Math.min(b / cosHalf, cap);
        out[i] = { x: p.x - bx * d, y: p.y - by * d };
      }
    }
    return out;
  };

  /*
    The global clamp bounds the bevel by the outline's OVERALL thinness, but a
    ring can still pinch locally (a glyph's tight join). A folded inset ring is
    worse than a shallower chamfer: its cap triangulates as a bowtie and its
    chamfer quads face backwards over the front of the object. So the inset is
    validated — same orientation, no drastic area change — and halved until it
    passes; 0 degrades the chamfer to a vertical rim, which is merely invisible
    rather than wrong.
  */
  let effective = bevel;
  let inset = insetAt(effective);
  for (let tries = 0; tries < 3 && effective > 0; tries++) {
    const a = signedArea(inset);
    const shrunk = Math.abs(a) < Math.abs(ringArea) * 0.05;
    const flipped = a !== 0 && Math.sign(a) !== Math.sign(ringArea);
    // A hole's inset GROWS (erosion widens holes), an outer ring's shrinks —
    // growth on an outer ring means the ring folded somewhere.
    const grewWildly = !hole && Math.abs(a) > Math.abs(ringArea) * 1.05;
    if (!flipped && !shrunk && !grewWildly) break;
    effective /= 2;
    if (effective <= 0.25) {
      effective = 0;
      inset = outline.map((p) => ({ x: p.x, y: p.y }));
    } else {
      inset = insetAt(effective);
    }
  }

  const corners: Corner[] = [];
  const edgeStart: number[] = new Array(n);
  const edgeEnd: number[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const p = ring[i]!;
    const nPrev = en[(i - 1 + n) % n]!;
    const nNext = en[i]!;
    let bx = nPrev.x + nNext.x;
    let by = nPrev.y + nNext.y;
    const bl = Math.hypot(bx, by);
    if (bl >= 1e-6) {
      bx /= bl;
      by /= bl;
    }
    const ix = inset[i]!.x;
    const iy = inset[i]!.y;
    const cosA = nPrev.x * nNext.x + nPrev.y * nNext.y;
    if (cosA >= smoothCos && bl >= 1e-6) {
      // Smooth: one record with the averaged normal, shared by both edges.
      corners.push({ x: p.x, y: p.y, nx: bx, ny: by, ix, iy });
      edgeEnd[(i - 1 + n) % n] = corners.length - 1;
      edgeStart[i] = corners.length - 1;
    } else {
      // Hard: two records, one per edge.
      corners.push({ x: p.x, y: p.y, nx: nPrev.x, ny: nPrev.y, ix, iy });
      edgeEnd[(i - 1 + n) % n] = corners.length - 1;
      corners.push({ x: p.x, y: p.y, nx: nNext.x, ny: nNext.y, ix, iy });
      edgeStart[i] = corners.length - 1;
    }
  }
  return { corners, edgeStart, edgeEnd, outline, inset, hole };
}

/** Bevel cross-section: inset fraction u (1 → 0) and depth fraction v (0 → 1)
 *  at parameter t, plus their derivatives for the normal. */
function profileAt(style: BevelProfile, t: number): { u: number; v: number; du: number; dv: number } {
  if (style === 'convex') {
    const th = t * Math.PI / 2;
    return { u: 1 - Math.sin(th), v: 1 - Math.cos(th), du: -Math.cos(th), dv: Math.sin(th) };
  }
  if (style === 'concave') {
    const th = t * Math.PI / 2;
    return { u: Math.cos(th), v: Math.sin(th), du: -Math.sin(th), dv: Math.cos(th) };
  }
  return { u: 1 - t, v: t, du: -1, dv: 1 };
}

class MeshBuilder {
  verts: number[] = [];
  count = 0;
  byRole: Record<MeshRole, number[]> = { back: [], side: [], bevel: [], front: [] };

  constructor(private readonly uv: { x: number; y: number; width: number; height: number }) {}

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number): number {
    const nl = Math.hypot(nx, ny, nz) || 1;
    this.verts.push(x, y, z, nx / nl, ny / nl, nz / nl, (x - this.uv.x) / this.uv.width, (y - this.uv.y) / this.uv.height);
    return this.count++;
  }

  /** Push a triangle, flipping its winding so its geometric normal agrees with its vertex normals. */
  tri(role: MeshRole, a: number, b: number, c: number): void {
    const v = this.verts;
    const A = a * MESH_VERTEX_FLOATS, B = b * MESH_VERTEX_FLOATS, C = c * MESH_VERTEX_FLOATS;
    const e1x = v[B]! - v[A]!, e1y = v[B + 1]! - v[A + 1]!, e1z = v[B + 2]! - v[A + 2]!;
    const e2x = v[C]! - v[A]!, e2y = v[C + 1]! - v[A + 1]!, e2z = v[C + 2]! - v[A + 2]!;
    const gx = e1y * e2z - e1z * e2y;
    const gy = e1z * e2x - e1x * e2z;
    const gz = e1x * e2y - e1y * e2x;
    if (gx === 0 && gy === 0 && gz === 0) return; // degenerate
    const nx = v[A + 3]! + v[B + 3]! + v[C + 3]!;
    const ny = v[A + 4]! + v[B + 4]! + v[C + 4]!;
    const nz = v[A + 5]! + v[B + 5]! + v[C + 5]!;
    const out = this.byRole[role];
    if (gx * nx + gy * ny + gz * nz >= 0) out.push(a, b, c);
    else out.push(a, c, b);
  }

  quad(role: MeshRole, a: number, b: number, c: number, d: number): void {
    this.tri(role, a, b, c);
    this.tri(role, a, c, d);
  }

  finish(bevel: number): ExtrudedMesh {
    const order: MeshRole[] = ['back', 'side', 'bevel', 'front'];
    const total = order.reduce((s, r) => s + this.byRole[r].length, 0);
    const indices = this.count > 65535 ? new Uint32Array(total) : new Uint16Array(total);
    const ranges: MeshRange[] = [];
    let o = 0;
    for (const role of order) {
      const list = this.byRole[role];
      if (list.length === 0) continue;
      indices.set(list, o);
      ranges.push({ role, first: o, count: list.length });
      o += list.length;
    }
    return { vertices: new Float32Array(this.verts), vertexCount: this.count, indices, ranges, bevel };
  }
}

/** Bounding box of all rings. */
function bounds(rings: ReadonlyArray<Ring>): { x: number; y: number; width: number; height: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rings) for (const p of r.points) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, width: 1, height: 1 };
  return { x: x0, y: y0, width: Math.max(1e-6, x1 - x0), height: Math.max(1e-6, y1 - y0) };
}

/**
 * Clamp the requested bevel to what the outline and depth can carry.
 *
 * The limiting feature is the outline's THINNEST part, not its bounding box —
 * a glyph's box is the whole letter while its stems are a few pixels wide, and
 * an inset larger than half a stem folds the ring over itself (the chamfer
 * then draws as back-facing chaos over the cap). `area / perimeter` is a sound
 * thinness estimate: for a long strip of width t it converges to t/2, and for
 * fat shapes it under-reports, which only makes the clamp safe. Holes count
 * too — a thin counter pinches exactly like a thin stem.
 */
export function clampMeshBevel(rings: ReadonlyArray<Ring>, depth: number, bevel: number): number {
  if (!(bevel > 0)) return 0;
  let thinnest = Infinity;
  for (const r of rings) {
    const pts = dedupeRing(r.points);
    if (pts.length < 3) continue;
    let per = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      per += Math.hypot(b.x - a.x, b.y - a.y);
    }
    if (per <= 0) continue;
    thinnest = Math.min(thinnest, Math.abs(signedArea(pts)) / per);
  }
  if (!Number.isFinite(thinnest)) return 0;
  return Math.max(0, Math.min(bevel, depth / 2, thinnest * 0.8));
}

/**
 * Build the extruded mesh. Returns null when no ring survives preparation
 * (empty / degenerate outlines).
 */
export function extrudeOutline(rings: ReadonlyArray<Ring>, opts: ExtrudeOptions): ExtrudedMesh | null {
  const depth = Math.max(0, opts.depth);
  if (depth <= 0) return null;
  const bevel = clampMeshBevel(rings, depth, opts.bevel ?? 0);
  const style = opts.bevelStyle ?? 'angular';
  const segs = style === 'angular' ? 1 : Math.max(1, Math.min(16, Math.floor(opts.bevelSegments ?? 4)));
  const smoothCos = Math.cos((opts.smoothAngleDeg ?? 35) * DEG);
  const uvBox = opts.uvBox ?? bounds(rings);

  const prepared: PreparedRing[] = [];
  for (const r of rings) {
    const p = prepareRing(r.points, r.hole, bevel, smoothCos);
    if (p) prepared.push(p);
  }
  if (prepared.length === 0) return null;

  const mb = new MeshBuilder(uvBox);
  const zWall0 = bevel;
  const zWall1 = depth - bevel;

  // ── Walls ──
  if (zWall1 - zWall0 > 1e-6) {
    for (const ring of prepared) {
      const base0 = mb.count;
      for (const c of ring.corners) mb.vertex(c.x, c.y, zWall0, c.nx, c.ny, 0);
      const base1 = mb.count;
      for (const c of ring.corners) mb.vertex(c.x, c.y, zWall1, c.nx, c.ny, 0);
      const n = ring.edgeStart.length;
      for (let i = 0; i < n; i++) {
        const s = ring.edgeStart[i]!;
        const e = ring.edgeEnd[i]!;
        mb.quad('side', base0 + s, base0 + e, base1 + e, base1 + s);
      }
    }
  }

  // ── Bevels (front: z 0 → bevel, back: z depth → depth − bevel) ──
  if (bevel > 0) {
    for (const front of [true, false]) {
      for (const ring of prepared) {
        // Rows of vertices across the profile, t = 0 at the cap edge.
        const rows: number[] = [];
        for (let k = 0; k <= segs; k++) {
          const t = k / segs;
          const pr = profileAt(style, t);
          const base = mb.count;
          rows.push(base);
          for (const c of ring.corners) {
            // Position: inset by bevel·u along this corner's inset direction.
            const x = c.x + (c.ix - c.x) * pr.u;
            const y = c.y + (c.iy - c.y) * pr.u;
            const z = front ? bevel * pr.v : depth - bevel * pr.v;
            // Cross-section normal (radial, z): (dv, du) → outward/front for the
            // front ring; the back ring mirrors z.
            const nz = front ? pr.du : -pr.du;
            mb.vertex(x, y, z, c.nx * pr.dv, c.ny * pr.dv, nz);
          }
        }
        const n = ring.edgeStart.length;
        for (let k = 0; k < segs; k++) {
          const r0 = rows[k]!;
          const r1 = rows[k + 1]!;
          for (let i = 0; i < n; i++) {
            const s = ring.edgeStart[i]!;
            const e = ring.edgeEnd[i]!;
            mb.quad('bevel', r0 + s, r0 + e, r1 + e, r1 + s);
          }
        }
      }
    }
  }

  // ── Caps ──
  const capRings: Ring[] = prepared.map((r) => ({ points: bevel > 0 ? r.inset : r.outline, hole: r.hole }));
  const groups = groupRings(capRings);
  const emitCap = (role: 'front' | 'back'): void => {
    const z = role === 'front' ? 0 : depth;
    const nz = role === 'front' ? -1 : 1;
    for (const g of groups) {
      const { vertices, triangles } = triangulateRings(g.outer, g.holes);
      if (triangles.length === 0) continue;
      const base = mb.count;
      for (const p of vertices) mb.vertex(p.x, p.y, z, 0, 0, nz);
      for (let i = 0; i < triangles.length; i += 3) {
        mb.tri(role, base + triangles[i]!, base + triangles[i + 1]!, base + triangles[i + 2]!);
      }
    }
  };
  if (opts.backCap !== false) emitCap('back');
  if (opts.frontCap) emitCap('front');

  if (mb.count === 0) return null;
  return mb.finish(bevel);
}

// ── Outline helpers for the primitive shapes ─────────────────────────

/** Rect outline (centred), with optional per-corner radii TL→TR→BR→BL. */
export function rectOutline(width: number, height: number, radii?: readonly [number, number, number, number] | number, segmentsPer90 = 8): Ring[] {
  const hw = width / 2;
  const hh = height / 2;
  const r = typeof radii === 'number' ? [radii, radii, radii, radii] : (radii ?? [0, 0, 0, 0]);
  const maxR = Math.min(hw, hh);
  const rr = r.map((v) => Math.max(0, Math.min(v ?? 0, maxR))) as [number, number, number, number];
  const pts: Pt2[] = [];
  // Corner centres and start angles (y down): TL, TR, BR, BL.
  const corners: Array<{ cx: number; cy: number; a0: number; r: number }> = [
    { cx: -hw + rr[0], cy: -hh + rr[0], a0: Math.PI, r: rr[0] },
    { cx: hw - rr[1], cy: -hh + rr[1], a0: -Math.PI / 2, r: rr[1] },
    { cx: hw - rr[2], cy: hh - rr[2], a0: 0, r: rr[2] },
    { cx: -hw + rr[3], cy: hh - rr[3], a0: Math.PI / 2, r: rr[3] },
  ];
  for (const c of corners) {
    if (c.r <= 0) {
      pts.push({ x: c.cx, y: c.cy });
      continue;
    }
    const n = Math.max(2, Math.round(segmentsPer90 * Math.min(1, c.r / 6 + 0.25)));
    for (let i = 0; i <= n; i++) {
      const a = c.a0 + (i / n) * (Math.PI / 2);
      pts.push({ x: c.cx + Math.cos(a) * c.r, y: c.cy + Math.sin(a) * c.r });
    }
  }
  return [{ points: pts, hole: false }];
}

/** Ellipse outline (centred). Segment count scales with size so large
 *  cylinders stay round and small ones stay cheap. */
export function ellipseOutline(width: number, height: number, segments?: number): Ring[] {
  const n = segments ?? Math.max(24, Math.min(128, Math.round(Math.max(width, height) / 3)));
  const pts: Pt2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push({ x: Math.cos(a) * width / 2, y: Math.sin(a) * height / 2 });
  }
  return [{ points: pts, hole: false }];
}

/**
 * Flatten closed Bézier runs (absolute in/out handles) into rings and sort
 * them into outers/holes by even-odd nesting depth.
 */
export function bezierRunsToRings(
  runs: ReadonlyArray<{ points: ReadonlyArray<{ x: number; y: number; inX: number; inY: number; outX: number; outY: number }>; open?: boolean }>,
  tolerance = 0.75,
): Ring[] {
  const flat: Pt2[][] = [];
  for (const run of runs) {
    if (run.open) continue;
    const n = run.points.length;
    if (n < 3) continue;
    const out: Pt2[] = [];
    for (let i = 0; i < n; i++) {
      const A = run.points[i]!;
      const B = run.points[(i + 1) % n]!;
      const c0x = A.outX, c0y = A.outY, c1x = B.inX, c1y = B.inY;
      const straight = (c0x === A.x && c0y === A.y && c1x === B.x && c1y === B.y);
      if (straight) {
        out.push({ x: A.x, y: A.y });
        continue;
      }
      // Segment count from the control polygon length at the given tolerance.
      const len = Math.hypot(c0x - A.x, c0y - A.y) + Math.hypot(c1x - c0x, c1y - c0y) + Math.hypot(B.x - c1x, B.y - c1y);
      const segs = Math.max(2, Math.min(64, Math.ceil(Math.sqrt(len / tolerance) * 1.2)));
      for (let k = 0; k < segs; k++) {
        const t = k / segs;
        const mt = 1 - t;
        const x = mt * mt * mt * A.x + 3 * mt * mt * t * c0x + 3 * mt * t * t * c1x + t * t * t * B.x;
        const y = mt * mt * mt * A.y + 3 * mt * mt * t * c0y + 3 * mt * t * t * c1y + t * t * t * B.y;
        out.push({ x, y });
      }
    }
    const d = dedupeRing(out);
    if (d.length >= 3 && Math.abs(signedArea(d)) > 1e-3) flat.push(d);
  }
  // Even-odd nesting: a ring inside an odd number of others is a hole.
  return flat.map((ring) => {
    const p = ring[0]!;
    let inside = 0;
    for (const other of flat) {
      if (other === ring) continue;
      if (pointInRingEO(p, other)) inside++;
    }
    return { points: ring, hole: inside % 2 === 1 };
  });
}

function pointInRingEO(p: Pt2, ring: ReadonlyArray<Pt2>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
