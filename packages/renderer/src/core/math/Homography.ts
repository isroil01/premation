import type { Vec2 } from './Vec2';
import { Mat3 } from './Mat3';

/**
 * Projective 3x3 transforms (homographies) for Corner Pin.
 *
 * A homography maps the layer's source rectangle onto an arbitrary convex
 * quadrilateral, giving the perspective foreshortening you need to paste a
 * graphic onto an angled screen in a device photo. Unlike the affine `Mat3`
 * used everywhere else, its bottom row is NOT (0,0,1): a projected point carries
 * a non-trivial homogeneous `w` and must be divided through — which is exactly
 * why Corner Pin lives as a SEPARATE render stage and never touches
 * `layer.matrix` (whose affine consumers — hit-test, bounds, masks, gizmo,
 * snapping — all read `.xy` without dividing by `.w`).
 *
 * Storage matches `Mat3`: column-major Float32Array of the math matrix
 *   | a b c |
 *   | d e f |
 *   | g h i |
 * i.e. [a,d,g, b,e,h, c,f,i]. For an affine matrix g=h=0, i=1 and every function
 * here reduces to the ordinary affine result — so composing an affine matrix
 * through `project` is identical to `Mat3.transformPoint`.
 *
 * Corner order is [topLeft, topRight, bottomRight, bottomLeft], matching the
 * unit-square corners (0,0),(1,0),(1,1),(0,1) and AE's UL/UR/LR/LL pin order.
 */

/** The four corners a homography maps the unit square onto, in TL,TR,BR,BL order. */
export type Quad = readonly [Vec2, Vec2, Vec2, Vec2];

/** The undistorted unit-square corners (no pin) — TL,TR,BR,BL. */
export const UNIT_QUAD: Quad = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

/**
 * Homography mapping the unit square (0,0),(1,0),(1,1),(0,1) onto `quad`
 * (TL,TR,BR,BL). Heckbert's projective square-to-quad mapping; returns `null`
 * when the quad is degenerate (the denominators vanish for collinear corners).
 *
 * Result is column-major (see the module header). A point (u,v) maps to
 * ((a·u+b·v+c)/w, (d·u+e·v+f)/w) with w = g·u+h·v+1.
 */
export function squareToQuad(quad: Quad): Mat3 | null {
  const [p0, p1, p2, p3] = quad;
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const dy3 = p0.y - p1.y + p2.y - p3.y;

  let a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number;
  if (Math.abs(dx3) < 1e-12 && Math.abs(dy3) < 1e-12) {
    // Affine: the quad is a parallelogram, so no perspective term.
    a = p1.x - p0.x;
    b = p2.x - p1.x;
    c = p0.x;
    d = p1.y - p0.y;
    e = p2.y - p1.y;
    f = p0.y;
    g = 0;
    h = 0;
  } else {
    const den = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(den) < 1e-12) return null; // collinear / degenerate
    g = (dx3 * dy2 - dx2 * dy3) / den;
    h = (dx1 * dy3 - dx3 * dy1) / den;
    a = p1.x - p0.x + g * p1.x;
    b = p3.x - p0.x + h * p3.x;
    c = p0.x;
    d = p1.y - p0.y + g * p1.y;
    e = p3.y - p0.y + h * p3.y;
    f = p0.y;
  }

  // Column-major: [a,d,g, b,e,h, c,f,1].
  const m = new Float32Array(9) as Mat3;
  m[0] = a; m[1] = d; m[2] = g;
  m[3] = b; m[4] = e; m[5] = h;
  m[6] = c; m[7] = f; m[8] = 1;
  return m;
}

/**
 * Apply a projective matrix to a point WITH the perspective divide.
 *
 * For an affine matrix (g=h=0,i=1) this equals `Mat3.transformPoint`. Returns
 * `null` when the point falls on the matrix's vanishing line (w≈0) — geometry
 * there projects to infinity and must not be read as a finite coordinate.
 */
export function project(m: Mat3, p: Vec2): Vec2 | null {
  const w = m[2]! * p.x + m[5]! * p.y + m[8]!;
  if (Math.abs(w) < 1e-9) return null;
  const inv = 1 / w;
  return {
    x: (m[0]! * p.x + m[3]! * p.y + m[6]!) * inv,
    y: (m[1]! * p.x + m[4]! * p.y + m[7]!) * inv,
  };
}

/**
 * Full 3x3 inverse (projective — does NOT assume the affine last row, unlike
 * `Mat3.invert`). Returns `null` when singular. Used by hit-testing to bring a
 * world point back into the un-pinned source rectangle.
 */
export function invertProjective(m: Mat3): Mat3 | null {
  const a = m[0]!, d = m[1]!, g = m[2]!;
  const b = m[3]!, e = m[4]!, h = m[5]!;
  const c = m[6]!, f = m[7]!, i = m[8]!;
  // Cofactors of the math matrix [[a,b,c],[d,e,f],[g,h,i]].
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-18) return null;
  const id = 1 / det;
  const D = -(b * i - c * h);
  const E = a * i - c * g;
  const F = -(a * h - b * g);
  const G = b * f - c * e;
  const H = -(a * f - c * d);
  const I = a * e - b * d;
  // Inverse math matrix = (1/det) · adjugate; adjugate = cofactorᵀ.
  //   | A D G |
  //   | B E H |
  //   | C F I |
  // Store column-major [col0,col1,col2] = [A,B,C, D,E,F, G,H,I] · id.
  const out = new Float32Array(9) as Mat3;
  out[0] = A * id; out[1] = B * id; out[2] = C * id;
  out[3] = D * id; out[4] = E * id; out[5] = F * id;
  out[6] = G * id; out[7] = H * id; out[8] = I * id;
  return out;
}

/** Signed area of the quad (shoelace); TL,TR,BR,BL traversal is negative in a
 *  y-down space, positive in y-up. Magnitude is the area. */
function signedArea(quad: Quad): number {
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const p = quad[i]!;
    const q = quad[(i + 1) % 4]!;
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
}

/**
 * Whether a quad is a valid (strictly convex, non-self-intersecting, non-
 * degenerate) target for a homography.
 *
 * A corner dragged past the quad's opposite edge sends the homography's `w`
 * through zero — inverted geometry, infinite stretching, clipped garbage. This
 * is the interaction-layer guard that rejects such a configuration BEFORE the
 * solve, so a pinned layer never renders as the classic broken corner-pin mess.
 *
 * Strict convexity: every consecutive cross product has the same sign and none
 * is ~0 (which would be a collinear/coincident corner). Also rejects a quad with
 * near-zero area.
 */
export function isConvexQuad(quad: Quad): boolean {
  const area = Math.abs(signedArea(quad));
  if (area < 1e-9) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i]!;
    const b = quad[(i + 1) % 4]!;
    const c = quad[(i + 2) % 4]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) return false; // collinear triple
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false; // reflex corner → non-convex
  }
  return true;
}

/** True when the quad is the undistorted unit square (no pin) — lets the render
 *  and hit-test paths skip the projective stage entirely and stay affine. */
export function isIdentityQuad(quad: Quad, eps = 1e-6): boolean {
  for (let i = 0; i < 4; i++) {
    if (Math.abs(quad[i]!.x - UNIT_QUAD[i]!.x) > eps) return false;
    if (Math.abs(quad[i]!.y - UNIT_QUAD[i]!.y) > eps) return false;
  }
  return true;
}
