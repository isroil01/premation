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

/** Quads per 90° corner arc on a rounded-rect extrusion. */
export const ROUNDED_CORNER_SEGMENTS = 6;

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

export interface ExtrusionOptions {
  /** Chamfer depth in px (0 = no bevel). Clamped by {@link clampBevel}. */
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
 *   back   = T(0, 0, d)                        — w×h plane at z = d
 *   right  = T(+w/2, 0, d/2) · Ry(90°)         — d×h plane; face-x → −z, so
 *                                                 x_f ∈ [−d/2, d/2] spans z ∈ [0, d]
 *   left   = T(−w/2, 0, d/2) · Ry(90°)
 *   top    = T(0, −h/2, d/2) · Rx(90°)         — w×d plane; face-y → +z
 *   bottom = T(0, +h/2, d/2) · Rx(90°)
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
export function extrusionFaces(
  w: number,
  h: number,
  d: number,
  shape: 'rect' | 'ellipse' = 'rect',
  segments: number = ELLIPSE_WALL_SEGMENTS,
  opts: ExtrusionOptions = {},
): ExtrusionFace[] {
  if (!(d > 0) || !(w > 0) || !(h > 0)) return [];
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
    return faces;
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
    return faces;
  }

  const b = clampBevel(w, h, d, opts.bevel ?? 0);
  if (b <= 0) {
    // Unbevelled box: back cap + 4 full-depth walls (unchanged, byte-identical).
    return [
      face(0, 0, d, 0, 0, 0, w, h, 'back', 'back'),
      face(+w / 2, 0, d / 2, 0, 90, 0, d, h, 'wall', 'r'),
      face(-w / 2, 0, d / 2, 0, 90, 0, d, h, 'wall', 'l'),
      face(0, -h / 2, d / 2, 90, 0, 0, w, d, 'wall', 't'),
      face(0, +h / 2, d / 2, 90, 0, 0, w, d, 'wall', 'b'),
    ];
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
      face(+w / 2, 0, d / 2, 0, 90, 0, wd, h, 'wall', 'r'),
      face(-w / 2, 0, d / 2, 0, 90, 0, wd, h, 'wall', 'l'),
      face(0, -h / 2, d / 2, 90, 0, 0, w, wd, 'wall', 't'),
      face(0, +h / 2, d / 2, 90, 0, 0, w, wd, 'wall', 'b'),
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
  return faces;
}
