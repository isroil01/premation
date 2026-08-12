/**
 * Extrusion geometry — pure face-matrix synthesis for REAL 3D objects.
 *
 * A 3D layer with `extrusionDepth` d > 0 is no longer a flat postcard: the
 * renderer draws its front face plus a BACK CAP and SIDE WALLS, all as
 * ordinary depth-tested planes. This module produces each extra face's local
 * matrix in the layer's own CENTERED-PIXEL frame (the same frame `world3d`
 * consumes), so buildSnapshot can synthesize the face's world matrix as
 * `world3d · face.m` and everything downstream (projection, depth test,
 * per-fragment lighting via the face's +Z normal) Just Works.
 *
 * Conventions (see project3d.ts): the default camera sits at z = −focalLength
 * looking down +z, so +z is AWAY from the viewer — the back cap sits at
 * z = +d and walls span z ∈ [0, d].
 *
 * Each face matrix maps FACE-LOCAL centered pixels (its own w×h plane at
 * z = 0) into the layer's local frame; the face's own RenderLayer carries the
 * face w/h, exactly like the front face carries the layer's. Matrices are
 * built with Matrix4Math.compose (T · Rz · Ry · Rx), verified corner-by-corner
 * in extrusion.test.ts.
 */

import { Matrix4Math, type Matrix4 } from '@motion/scene';

const DEG = Math.PI / 180;

/** Fixed tint gain for side walls when the per-fragment lit path is off —
 *  makes depth read even in an unlit comp (AE-like fixed face shading). */
export const EXTRUSION_WALL_GAIN = 0.72;
/** Fixed tint gain for the back cap when the lit path is off. */
export const EXTRUSION_BACK_GAIN = 0.55;

/** Wall fill fallback for content without a usable solid colour (image/video). */
export const EXTRUSION_WALL_FALLBACK_FILL = '#2a2a2a';

/** Number of planar strips approximating an ellipse's side wall. */
export const ELLIPSE_WALL_SEGMENTS = 20;

/** Strips per straight wall when the fill is a gradient — see
 *  {@link ExtrusionOptions.wallSegments}. Matched to the ellipse ring so a box
 *  and a cylinder resolve a ramp at the same fineness. */
export const GRADIENT_WALL_SEGMENTS = 20;

/**
 * How far a wall strip runs past its neighbour, as a fraction of a strip.
 *
 * A solid quad's edge is antialiased to transparent. Two strips butted exactly
 * edge to edge therefore each blend half the BACKGROUND in along the join, and
 * the wall reads as a body ruled with dark hairlines. Overlapping hides the
 * join under the neighbour's opaque interior.
 *
 * Straight walls ONLY. The ellipse and rounded-outline rings have the same
 * seam, but their strips are chords at differing angles, so lengthening one
 * lifts its corners off the outline — which extrusion.test.ts rightly pins,
 * since those corners ARE the object's silhouette. Their seam needs a
 * different fix (one mesh, or unantialiased interior edges), not this one.
 */
export const SEAM_OVERLAP = 0.25;

/** Quads per 90° corner arc on a rounded-rect extrusion. */
export const ROUNDED_CORNER_SEGMENTS = 6;

/**
 * Depth between adjacent slices of a TEXT / complex-shape extrusion, in px.
 *
 * Such a body is not built from wall planes — its silhouette is a glyph or an
 * arbitrary path, which this flat-quad model cannot turn into walls — so it is
 * a stack of thin plates sliced along z. The gaps between plates are what you
 * see when the object is yawed, and a gap of `step` in depth projects to
 * `step · sin(yaw)` on screen. At 1.5 px that is 1.06 px at 45° of yaw, i.e.
 * about the coarsest spacing that still stays sub-pixel through the rotations
 * an extruded title actually gets.
 *
 * The value is unchanged; it was a bare literal, and naming it is what lets
 * {@link MAX_EXTRUSION_SLICES} state the depth up to which it holds.
 */
export const EXTRUSION_SLICE_STEP_PX = 1.5;

/**
 * Ceiling on the number of slices one such extrusion may emit.
 *
 * ── What the old ceiling did ────────────────────────────────────────────────
 *
 * It was 45, written as a bare literal in a bulk commit with no stated reason —
 * so the honest answer to "what was the cap for?" is that nothing records one.
 * What it DID is precise, though, and is not what the shape of the code
 * suggests: the stack always spanned the full depth, because `sliceStep` is
 * `extrusionDepth / sliceCount`. Nothing was ever truncated. What saturated was
 * the DENSITY — past 45 × 1.5 = 67.5 px of depth the same 45 plates simply
 * moved further apart:
 *
 *     depth  40   → 27 slices, 1.48 px apart
 *     depth  67.5 → 45 slices, 1.50 px      ← the ceiling binds here
 *     depth 100   → 45 slices, 2.22 px
 *     depth 300   → 45 slices, 6.67 px      ← 4.3 px gaps at 40° yaw: combing
 *
 * That is the "stair-stepping along the trailing edge at depth 300 where depth
 * 40 is clean" report, and it is specifically a TEXT bug — a rect uses exact
 * wall planes and never slices.
 *
 * ── Why 400, measured ───────────────────────────────────────────────────────
 *
 * A slice is a flat quad in the shared depth pass with no offscreen resolve of
 * its own, and every slice of one layer shares a `contentHash`, so they share
 * one rasterized texture. Slices are therefore MUCH cheaper than the
 * effect-laden faces `faceEffects.ts` has to budget for. Single frame including
 * readback, this machine, 2026-08-12:
 *
 *     slices    WebGL2    WebGPU
 *        45      471 ms    102 ms
 *       100      673 ms    104 ms
 *       200      648 ms    129 ms
 *       400      934 ms    154 ms
 *
 * ~1.3 ms per extra slice on WebGL2 and ~0.15 ms on WebGPU: a 9× increase in
 * slice count costs 2× the frame on the slower backend, and only for a layer
 * that actually asks for that depth.
 *
 * 400 × 1.5 px keeps the spacing at its intended 1.5 px all the way to **600 px
 * of depth**, which covers any extrusion that fits in a normal comp. Past that
 * the spacing widens again, but from a far better starting point — at depth
 * 1200 it is 3 px, where the old ceiling gave 6.67 px at depth 300.
 *
 * ── What this is NOT ────────────────────────────────────────────────────────
 *
 * Still an approximation of a solid by a stack of plates. The real fix is to
 * generate wall geometry from the glyph/path outline, exactly as the rect path
 * already does from its own outline, which removes the density question
 * entirely rather than pushing it out of range. That needs outline extraction
 * for text and is a much larger change; this bounds the visible defect in the
 * meantime, and the numbers above are what a proposal to do it should be
 * measured against.
 */
export const MAX_EXTRUSION_SLICES = 400;

export interface ExtrusionFace {
  /** Face-local centered px → layer-local centered px (column-major mat4). */
  m: Matrix4;
  /** Face plane size in px (the face RenderLayer's width/height). */
  w: number;
  h: number;
  role: 'back' | 'wall';
  /** Stable id suffix (`back`, `r`, `l`, `t`, `b`, `w0`…`wN`, or a bevel
   *  chamfer `cfr`/`cfl`/`cft`/`cfb` front, `cbr`/`cbl`/`cbt`/`cbb` back). */
  suffix: string;
}

/** Bevel profile. Only `angular` (a single 45° chamfer ring) ships today;
 *  `concave`/`convex` are accepted + stored but currently render as `angular`
 *  (rounded profiles are a documented deferral — see extrusionFaces). */
export type BevelStyle = 'angular' | 'concave' | 'convex';
export const DEFAULT_BEVEL_STYLE: BevelStyle = 'angular';

/**
 * What {@link extrusionGeometry} produced: the faces, and whether it actually
 * emitted a bevel.
 *
 * The second field exists because the caller cannot infer it. The bevel is
 * honoured on a square-cornered rect and IGNORED on a rounded one and on an
 * ellipse, each for a reason recorded at its own branch — but `buildSnapshot`
 * was insetting the front face from `clampBevel(...)` regardless, so on a
 * rounded layer it shrank the front face to meet a chamfer ring that had never
 * been emitted. A rounded front face floated ~12 px inside the outline with the
 * darker back cap showing through the ring-shaped gap.
 *
 * That is a contract failure, not a maths error: the decision was taken in one
 * module and acted on in another that was never told. So it is reported
 * ALONGSIDE the faces rather than recomputed by a second function — a predicate
 * that re-derives "did this shape get a bevel?" from w/h/d/cornerRadius is the
 * same coupling again, with an extra copy of the branch logic to keep in step.
 */
export interface ExtrusionGeometry {
  faces: ExtrusionFace[];
  /** Chamfer depth actually emitted, in px — CLAMPED, and 0 when no chamfer
   *  ring was produced. This is the amount the caller must inset the front face
   *  by, and nothing else is. */
  bevel: number;
}

export interface ExtrusionOptions {
  /** Chamfer depth in px (0 = no bevel). Clamped by {@link clampBevel}, and
   *  ignored entirely by the rounded-outline and ellipse branches — read
   *  {@link ExtrusionGeometry.bevel} for what was actually emitted. */
  bevel?: number;
  /** Bevel profile (see {@link BevelStyle}). */
  bevelStyle?: BevelStyle;
  /**
   * The layer's corner radius, so the extruded BODY follows the rounded
   * outline instead of the bounding box.
   *
   * Without this the walls were four full-width planes on the raw w×h box while
   * the front cap drew rounded — a rounded face stuck on a square block, with
   * the box corners poking out past the curve. Corner radius simply had no
   * effect on anything 3D.
   */
  cornerRadius?: number;
  /**
   * Split each straight wall of a RECT extrusion into this many strips along
   * its length (default 1 = one strip per side, the original geometry).
   *
   * A wall is drawn as one flat colour, sampled at its own centre. That is
   * exact for a solid fill and for a wall the gradient does not vary along —
   * but the left and right walls of a vertically-ranked box span the WHOLE
   * ramp, so a single sample renders them a flat mid-colour butted against a
   * front face that ramps: the object reads as painted panels rather than one
   * surface. Splitting the wall lets each strip sample its own position, so the
   * ramp runs down the side continuously. It is the same reason the ellipse
   * path already emits a segmented ring, and why a cylinder wrapped smoothly
   * while a box did not.
   *
   * Strips are flat solid quads — no rasters, no textures — so this costs a few
   * more draws in the same depth pass and nothing else. Only worth paying for a
   * gradient; callers leave it at 1 for a solid fill.
   */
  wallSegments?: number;
}

/** Points around a rounded-rect outline, centred on the origin. */
function roundedRectOutline(w: number, h: number, r: number, arcSegments: number): Array<{ x: number; y: number }> {
  const a = w / 2;
  const b = h / 2;
  const rr = Math.max(0, Math.min(r, Math.min(a, b)));
  const pts: Array<{ x: number; y: number }> = [];
  const n = Math.max(1, Math.floor(arcSegments));
  // Four corner centres, walked in order with the straight runs between them.
  // Angles use screen orientation (y down), matching the ellipse branch.
  const corners: Array<{ cx: number; cy: number; from: number }> = [
    { cx: a - rr, cy: b - rr, from: 0 },       // bottom-right: 0° → 90°
    { cx: -(a - rr), cy: b - rr, from: 90 },   // bottom-left
    { cx: -(a - rr), cy: -(b - rr), from: 180 }, // top-left
    { cx: a - rr, cy: -(b - rr), from: 270 },  // top-right
  ];
  for (const c of corners) {
    if (rr <= 0) {
      pts.push({ x: c.cx, y: c.cy });
      continue;
    }
    for (let i = 0; i <= n; i++) {
      const ang = (c.from + (90 * i) / n) * DEG;
      pts.push({ x: c.cx + rr * Math.cos(ang), y: c.cy + rr * Math.sin(ang) });
    }
  }
  return pts;
}

/**
 * Clamp a requested bevel depth to a geometry-safe value: never more than half
 * the smallest planar dimension (the inset front/back would invert) nor half
 * the extrusion depth (the walls would vanish or cross). Returns 0 for any
 * non-positive request or degenerate box, so the caller can treat 0 as "no
 * bevel" and stay on the byte-identical unbevelled path.
 */
export function clampBevel(w: number, h: number, d: number, bevel: number): number {
  if (!(bevel > 0) || !(w > 0) || !(h > 0) || !(d > 0)) return 0;
  return Math.min(bevel, w / 2, h / 2, d / 2);
}

function face(
  px: number, py: number, pz: number,
  rxDeg: number, ryDeg: number, rzDeg: number,
  w: number, h: number,
  role: 'back' | 'wall',
  suffix: string,
): ExtrusionFace {
  return {
    m: Matrix4Math.compose({
      position: { x: px, y: py, z: pz },
      rotation: { x: rxDeg * DEG, y: ryDeg * DEG, z: rzDeg * DEG },
      scale: { x: 1, y: 1, z: 1 },
      anchor: { x: 0, y: 0, z: 0 },
    }),
    w, h, role, suffix,
  };
}

/**
 * The five extra faces of a rectangular extrusion (back cap + 4 walls), or the
 * back cap + a segmented wall ring for `shape === 'ellipse'`.
 *
 * Rect face math (layer w×h, depth d; all in the layer's centered frame):
 *   back   = T(0, 0, d) — w×h plane at z = d
 *   right  = T(+w/2, 0, d/2) · Ry(90°) — d×h plane; face-x → −z, so
 *                                                 x_f ∈ [−d/2, d/2] spans z ∈ [0, d]
 *   left   = T(−w/2, 0, d/2) · Ry(270°)
 *   top    = T(0, −h/2, d/2) · Rx(90°) — w×d plane; face-y → +z
 *   bottom = T(0, +h/2, d/2) · Rx(270°)
 *
 * ── The 180° on the far wall of each pair, and why it is not cosmetic ───────
 *
 * Left shared Ry(90°) with right, and bottom shared Rx(90°) with top. A quad's
 * normal is its own +Z axis, so each pair came out with the SAME normal — and
 * since the two walls of a pair sit on opposite sides of the body, one of every
 * pair pointed INTO the solid. Every face of a box was wound as if the box had
 * no far side.
 *
 * It stayed invisible because lighting is two-sided: `lightShading.ts` and the
 * four `builtin.ts` shaders all take `abs(dot(N, L))`, which cannot tell a
 * normal from its negation. So the wrong sign produced the SAME gain as the
 * right one, and a box lit hard from one side came out lit identically on both
 * — the thing that reads as "it doesn't look like a solid". Nothing in the
 * suite could catch it either: every assertion about a wall was about where its
 * corners land, and mirroring a quad in its own plane moves no corner.
 *
 * The bevel chamfer rings below were always wound correctly, and they are where
 * the intended pattern is written down: `cfr` Ry(135°) against `cfl` Ry(225°),
 * i.e. the far member of a pair is the near one plus 180°. The walls now follow
 * the rings rather than the rings being the exception.
 *
 * Mirroring a wall flips its local x (or y) axis and nothing else: the plane is
 * the same plane, covering the same pixels, and a wall is a flat solid quad
 * with no content to be mirrored. Gradient sampling reads the matrix's
 * TRANSLATION (`wallFillAt`), which does not move. So this changes no pixel
 * today; it is what makes one-sided shading expressible at all.
 *
 * Ellipse walls: N chord strips. Strip i spans the perimeter chord from angle
 * θ_i to θ_{i+1} (semi-axes a = w/2, b = h/2); its matrix is
 *   T(mid_x, mid_y, d/2) · Rz(φ) · Rx(90°)
 * (φ = chord angle), an L×d plane whose face-y spans the depth. Corners land
 * ON the ellipse outline at z = 0 and z = d (asserted in tests).
 *
 * Faces are returned back-cap FIRST so the caller can emit them before the
 * front face and keep painter order back→front on the affine fallback.
 *
 * BEVEL (rect only): with `opts.bevel = b > 0` the front face shrinks inward by
 * b on every side (w−2b × h−2b, still at z = 0 — the CALLER insets the front
 * content; extrusionFaces only reports faces + the shrunk BACK cap) and the
 * walls retreat to span z ∈ [b, d−b]. Two 45° chamfer rings bridge the gap:
 *   • front ring (`cf*`): shrunk-front edge (z = 0) → wall front edge (z = b),
 *   • back ring  (`cb*`): wall back edge (z = d−b) → shrunk-back edge (z = d).
 * Each chamfer's own +Z normal points OUTWARD-AND-FORWARD (front ring) or
 * OUTWARD-AND-BACKWARD (back ring) — exactly the facets that catch a grazing
 * light and make the bevel read. b is clamped by {@link clampBevel}; at the
 * clamp limits degenerate (zero-extent) walls / back cap are simply omitted.
 * Chamfer strips run the FULL wall length and overlap in the four corner
 * wedges (both wall-coloured, so the overlap is invisible) — an intentional
 * "angular" approximation that avoids separate mitred corner facets. Ellipse
 * bevel is deferred (the ring-inset maths is messy); an ellipse ignores bevel.
 */
export function extrusionGeometry(
  w: number,
  h: number,
  d: number,
  shape: 'rect' | 'ellipse' = 'rect',
  segments: number = ELLIPSE_WALL_SEGMENTS,
  opts: ExtrusionOptions = {},
): ExtrusionGeometry {
  if (!(d > 0) || !(w > 0) || !(h > 0)) return { faces: [], bevel: 0 };
  if (shape === 'ellipse') {
    const faces: ExtrusionFace[] = [face(0, 0, d, 0, 0, 0, w, h, 'back', 'back')];
    const a = w / 2;
    const b = h / 2;
    const n = Math.max(3, Math.floor(segments));
    for (let i = 0; i < n; i++) {
      const t0 = (i / n) * Math.PI * 2;
      const t1 = ((i + 1) / n) * Math.PI * 2;
      const x0 = a * Math.cos(t0), y0 = b * Math.sin(t0);
      const x1 = a * Math.cos(t1), y1 = b * Math.sin(t1);
      const dx = x1 - x0, dy = y1 - y0;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      const phi = Math.atan2(dy, dx) / DEG;
      faces.push(face((x0 + x1) / 2, (y0 + y1) / 2, d / 2, 90, 0, phi, len, d, 'wall', `w${i}`));
    }
    // Ellipse bevel is deferred (the ring-inset maths is messy), so this branch
    // emits no chamfer and reports none.
    return { faces, bevel: 0 };
  }

  // Rounded rect: extrude the OUTLINE. Emitted before the bevel path because a
  // bevel on a rounded corner is a torus section, which this flat-quad wall
  // model cannot express — a rounded layer therefore takes the un-bevelled
  // rounded body rather than silently drawing square corners.
  const cr = Math.max(0, Math.min(opts.cornerRadius ?? 0, Math.min(w, h) / 2));
  if (cr > 0) {
    const faces: ExtrusionFace[] = [face(0, 0, d, 0, 0, 0, w, h, 'back', 'back')];
    const outline = roundedRectOutline(w, h, cr, ROUNDED_CORNER_SEGMENTS);
    for (let i = 0; i < outline.length; i++) {
      const p0 = outline[i]!;
      const p1 = outline[(i + 1) % outline.length]!;
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      const phi = Math.atan2(dy, dx) / DEG;
      faces.push(face((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, d / 2, 90, 0, phi, len, d, 'wall', `w${i}`));
    }
    // NO CHAMFER, and the caller is now told so.
    //
    // This branch returns before the bevel path below, deliberately — a bevel on
    // a rounded corner is a torus section, which a flat-quad wall model cannot
    // express, so a rounded layer takes the un-bevelled rounded body rather than
    // silently drawing square corners. That decision was right and was never
    // communicated: `buildSnapshot` computed its front-face inset from
    // `clampBevel` unconditionally, so a rounded layer with a bevel set shrank
    // its front face by 12 px to meet a chamfer ring that does not exist. What
    // you saw was a rounded front face floating inside the outline with the
    // darker back cap showing through the ring-shaped gap.
    return { faces, bevel: 0 };
  }

  const segs = Math.max(1, Math.floor(opts.wallSegments ?? 1));
  /**
   * The four straight walls of a box, each split into `segs` strips along its
   * length. `wd` is how deep the walls run (the full depth, or the shorter
   * span left between two chamfer rings when bevelled).
   *
   * At segs = 1 this returns exactly the four faces the unsplit code did —
   * same order, same suffixes, same matrices — so a solid-filled extrusion is
   * untouched.
   */
  const walls = (wd: number): ExtrusionFace[] => {
    if (segs <= 1) {
      return [
        face(+w / 2, 0, d / 2, 0, 90, 0, wd, h, 'wall', 'r'),
        face(-w / 2, 0, d / 2, 0, 270, 0, wd, h, 'wall', 'l'),
        face(0, -h / 2, d / 2, 90, 0, 0, w, wd, 'wall', 't'),
        face(0, +h / 2, d / 2, 270, 0, 0, w, wd, 'wall', 'b'),
      ];
    }
    const out: ExtrusionFace[] = [];
    /**
     * Strip `i` of `segs` across a span of `total`, as [centre, size].
     *
     * Every strip but the last runs LONG, into its successor. Butted exactly
     * edge to edge they left a dark hairline at each join: a solid quad's edge
     * is antialiased to transparent, so two neighbouring edges each blended
     * half the BACKGROUND in rather than blending into each other. Overlapping
     * puts the seam inside the next strip's opaque body, and since the strips
     * are drawn in order and are coplanar (depth test LEQUAL), the later one
     * simply covers the extension. The final strip is left exact so the wall
     * still ends on the box's corner instead of poking past it.
     */
    const strip = (total: number, i: number): [number, number] => {
      const s = total / segs;
      const lo = -total / 2 + i * s;
      const hi = lo + s + (i === segs - 1 ? 0 : s * SEAM_OVERLAP);
      return [(lo + hi) / 2, hi - lo];
    };
    // Left / right walls run along the box's HEIGHT, so they split along y.
    for (let i = 0; i < segs; i++) {
      const [cy, sh] = strip(h, i);
      out.push(face(+w / 2, cy, d / 2, 0, 90, 0, wd, sh, 'wall', `r${i}`));
      out.push(face(-w / 2, cy, d / 2, 0, 270, 0, wd, sh, 'wall', `l${i}`));
    }
    // Top / bottom walls run along the box's WIDTH, so they split along x.
    for (let i = 0; i < segs; i++) {
      const [cx, sw] = strip(w, i);
      out.push(face(cx, -h / 2, d / 2, 90, 0, 0, sw, wd, 'wall', `t${i}`));
      out.push(face(cx, +h / 2, d / 2, 270, 0, 0, sw, wd, 'wall', `b${i}`));
    }
    return out;
  };

  const b = clampBevel(w, h, d, opts.bevel ?? 0);
  if (b <= 0) {
    // Unbevelled box: back cap + 4 full-depth walls.
    return { faces: [face(0, 0, d, 0, 0, 0, w, h, 'back', 'back'), ...walls(d)], bevel: 0 };
  }

  // Bevelled rect. Inset caps (w−2b × h−2b), walls span z ∈ [b, d−b] (depth wd),
  // and two chamfer rings of slant length L = b·√2 tilted ±45°.
  const iw = w - 2 * b, ih = h - 2 * b; // inset front/back plane size
  const wd = d - 2 * b;                 // wall depth after both chamfers
  const L = b * Math.SQRT2;             // chamfer slant length
  const faces: ExtrusionFace[] = [];
  // Back cap, inset to match the shrunk front (omit if the clamp collapsed it).
  if (iw > 0 && ih > 0) faces.push(face(0, 0, d, 0, 0, 0, iw, ih, 'back', 'back'));
  // Side walls, now spanning only z ∈ [b, d−b] (centred at d/2).
  if (wd > 0) {
    faces.push(
      ...walls(wd),
    );
  }
  // Front chamfer ring: shrunk-front edge (z = 0) → wall front edge (z = b).
  // Normals point outward + forward (−z toward the viewer). Ry(135°)/Rx(135°)
  // and their 225° mirrors tilt each strip 45° off its wall plane.
  faces.push(
    face(+w / 2 - b / 2, 0, b / 2, 0, 135, 0, L, h, 'wall', 'cfr'),
    face(-w / 2 + b / 2, 0, b / 2, 0, 225, 0, L, h, 'wall', 'cfl'),
    face(0, -h / 2 + b / 2, b / 2, 135, 0, 0, w, L, 'wall', 'cft'),
    face(0, +h / 2 - b / 2, b / 2, 225, 0, 0, w, L, 'wall', 'cfb'),
  );
  // Back chamfer ring: wall back edge (z = d−b) → shrunk-back edge (z = d).
  // Normals point outward + backward (+z, away from the viewer).
  faces.push(
    face(+w / 2 - b / 2, 0, d - b / 2, 0, 45, 0, L, h, 'wall', 'cbr'),
    face(-w / 2 + b / 2, 0, d - b / 2, 0, 315, 0, L, h, 'wall', 'cbl'),
    face(0, -h / 2 + b / 2, d - b / 2, 45, 0, 0, w, L, 'wall', 'cbt'),
    face(0, +h / 2 - b / 2, d - b / 2, 315, 0, 0, w, L, 'wall', 'cbb'),
  );
  // The ONLY branch that emits a chamfer, so the only one that reports a bevel.
  // `b` is the CLAMPED value, not the requested one, so the caller's front-face
  // inset matches the geometry even when the request was clamped down.
  return { faces, bevel: b };
}

/**
 * The faces alone, for callers with no interest in the bevel — hit-testing
 * (`facePicking`) and the geometry tests.
 *
 * A thin reader over {@link extrusionGeometry} rather than a second
 * implementation: the bevel report and the faces have to come from the same
 * decision, which is the whole point of the change that introduced it.
 */
export function extrusionFaces(
  w: number,
  h: number,
  d: number,
  shape: 'rect' | 'ellipse' = 'rect',
  segments: number = ELLIPSE_WALL_SEGMENTS,
  opts: ExtrusionOptions = {},
): ExtrusionFace[] {
  return extrusionGeometry(w, h, d, shape, segments, opts).faces;
}
