/**
 * Bezier Warp — bend a layer's four edges as cubic Béziers and fill the
 * interior with a Coons patch.
 *
 * The generalisation of Corner Pin. Corner Pin moves four VERTICES and the
 * edges between them stay straight, because a projective map takes lines to
 * lines. Bezier Warp adds two tangent handles per edge, so the edges curve —
 * twelve control points in total — and the interior has to be interpolated
 * rather than solved.
 *
 * ── UI: numeric now, on-canvas handles DEFERRED (stated, not silent) ────
 *
 * The twelve points ship as twenty-four keyframeable offset rows in the
 * inspector — the same surface Corner Pin has, and fully functional: every
 * control point is reachable and animatable.
 *
 * They do NOT ship with draggable handles on the canvas, and that is a real gap
 * rather than an oversight — a warp is the effect people most expect to grab
 * directly. It is deferred rather than half-built because the overlay is its own
 * piece of work and not a corner of this one: hit-testing over twelve points, a
 * drag writing through the same autokey path the transform gizmo uses, and
 * viewport-to-layer coordinate conversion that stays correct under the layer's
 * own transform. That is the gizmo problem, not the warp problem. Shipping the
 * numeric rows quietly and calling the effect finished is what this note exists
 * to prevent.
 *
 * ── The Coons patch ─────────────────────────────────────────────────────
 *
 * Given the four boundary curves, the surface is the sum of two ruled surfaces
 * minus the bilinear patch through the corners:
 *
 *   S(u,v) = (1−v)·Ctop(u) + v·Cbot(u)          ← ruled between top and bottom
 *          + (1−u)·Cleft(v) + u·Cright(v)       ← ruled between left and right
 *          − bilinear(corners)                  ← subtract the double-count
 *
 * The subtraction is the whole trick: each ruled surface already reproduces the
 * corners, so adding them counts every corner twice, and the bilinear term is
 * exactly that excess. The result interpolates all four boundary curves
 * exactly, which is what makes the edges land where the handles say.
 *
 * ── Why the inverse is iterative ────────────────────────────────────────
 *
 * `remap` needs destination → source (see its own note on why a forward map
 * tears). Corner Pin can invert its 3×3 in closed form. A Coons patch cannot be
 * inverted algebraically — it is a bicubic surface — so `solveUV` runs
 * Newton–Raphson on the forward map using its analytic Jacobian. That converges
 * in a handful of steps for any patch that is not folded over itself, and
 * reports failure rather than guessing when it does not.
 */

import { remap } from './distort';

/** A point in layer pixels. */
export interface WarpPt {
  x: number;
  y: number;
}

/**
 * The twelve control points, clockwise from the top-left vertex — AE's own
 * ordering, so the inspector rows read around the shape:
 *
 *    0 TL vertex     1 top h1       2 top h2       3 TR vertex
 *    4 right h1      5 right h2     6 BR vertex
 *    7 bottom h1     8 bottom h2    9 BL vertex
 *   10 left h1      11 left h2
 *
 * Note the BOTTOM and LEFT edges run backwards around the perimeter (BR→BL and
 * BL→TL), which is what "clockwise" means and what the evaluation below undoes.
 */
export type WarpPoints = readonly [
  WarpPt, WarpPt, WarpPt, WarpPt, WarpPt, WarpPt,
  WarpPt, WarpPt, WarpPt, WarpPt, WarpPt, WarpPt,
];

/**
 * The rest configuration for a `w`×`h` box: corners at the corners, handles at
 * the one-third points of each edge.
 *
 * The thirds are not cosmetic. A cubic Bézier whose four control points are
 * evenly spaced along a straight line reduces to the LINEAR parameterisation —
 * B(t) = t·w when the controls are 0, w/3, 2w/3, w — so at rest every edge is
 * a straight, uniformly-parameterised line and the whole patch collapses to the
 * identity map. Any other handle placement would make the default effect a
 * subtle resample of its own input.
 */
export function defaultWarpPoints(w: number, h: number): WarpPoints {
  return [
    { x: 0, y: 0 }, { x: w / 3, y: 0 }, { x: (2 * w) / 3, y: 0 }, { x: w, y: 0 },
    { x: w, y: h / 3 }, { x: w, y: (2 * h) / 3 }, { x: w, y: h },
    { x: (2 * w) / 3, y: h }, { x: w / 3, y: h }, { x: 0, y: h },
    { x: 0, y: (2 * h) / 3 }, { x: 0, y: h / 3 },
  ];
}

const bez = (a: number, b: number, c: number, d: number, t: number): number => {
  const s = 1 - t;
  return s * s * s * a + 3 * s * s * t * b + 3 * s * t * t * c + t * t * t * d;
};

/** dB/dt of the same cubic. */
const bezD = (a: number, b: number, c: number, d: number, t: number): number => {
  const s = 1 - t;
  return 3 * s * s * (b - a) + 6 * s * t * (c - b) + 3 * t * t * (d - c);
};

const curve = (p0: WarpPt, p1: WarpPt, p2: WarpPt, p3: WarpPt, t: number): WarpPt => ({
  x: bez(p0.x, p1.x, p2.x, p3.x, t),
  y: bez(p0.y, p1.y, p2.y, p3.y, t),
});

const curveD = (p0: WarpPt, p1: WarpPt, p2: WarpPt, p3: WarpPt, t: number): WarpPt => ({
  x: bezD(p0.x, p1.x, p2.x, p3.x, t),
  y: bezD(p0.y, p1.y, p2.y, p3.y, t),
});

/**
 * The forward map: unit square (u,v) → layer pixels.
 *
 * `u` runs left→right, `v` runs top→bottom, so (0,0) is the top-left vertex and
 * (1,1) the bottom-right — the same orientation as the pixel grid, which is
 * what lets the identity patch be literally (u·w, v·h).
 */
export function coonsPoint(p: WarpPoints, u: number, v: number): WarpPt {
  const [tl, t1, t2, tr, r1, r2, br, b1, b2, bl, l1, l2] = p;
  const top = curve(tl, t1, t2, tr, u);
  const right = curve(tr, r1, r2, br, v);
  // Stored BR→BL, so increasing u walks it backwards.
  const bot = curve(br, b1, b2, bl, 1 - u);
  // Stored BL→TL, so increasing v walks it backwards.
  const left = curve(bl, l1, l2, tl, 1 - v);
  const bx = (1 - u) * (1 - v) * tl.x + u * (1 - v) * tr.x + u * v * br.x + (1 - u) * v * bl.x;
  const by = (1 - u) * (1 - v) * tl.y + u * (1 - v) * tr.y + u * v * br.y + (1 - u) * v * bl.y;
  return {
    x: (1 - v) * top.x + v * bot.x + (1 - u) * left.x + u * right.x - bx,
    y: (1 - v) * top.y + v * bot.y + (1 - u) * left.y + u * right.y - by,
  };
}

/** ∂S/∂u and ∂S/∂v — analytic, so Newton converges quadratically. */
export function coonsJacobian(
  p: WarpPoints,
  u: number,
  v: number,
): { du: WarpPt; dv: WarpPt } {
  const [tl, t1, t2, tr, r1, r2, br, b1, b2, bl, l1, l2] = p;
  const top = curve(tl, t1, t2, tr, u);
  const topD = curveD(tl, t1, t2, tr, u);
  const right = curve(tr, r1, r2, br, v);
  const rightD = curveD(tr, r1, r2, br, v);
  const bot = curve(br, b1, b2, bl, 1 - u);
  // Chain rule through the reversed parameter: d/du f(1−u) = −f'(1−u).
  const botD = curveD(br, b1, b2, bl, 1 - u);
  const left = curve(bl, l1, l2, tl, 1 - v);
  const leftD = curveD(bl, l1, l2, tl, 1 - v);
  return {
    du: {
      x: (1 - v) * topD.x - v * botD.x - left.x + right.x
        - ((v - 1) * tl.x + (1 - v) * tr.x + v * br.x - v * bl.x),
      y: (1 - v) * topD.y - v * botD.y - left.y + right.y
        - ((v - 1) * tl.y + (1 - v) * tr.y + v * br.y - v * bl.y),
    },
    dv: {
      x: bot.x - top.x - (1 - u) * leftD.x + u * rightD.x
        - ((u - 1) * tl.x - u * tr.x + u * br.x + (1 - u) * bl.x),
      y: bot.y - top.y - (1 - u) * leftD.y + u * rightD.y
        - ((u - 1) * tl.y - u * tr.y + u * br.y + (1 - u) * bl.y),
    },
  };
}

/** How far outside the unit square a solution may wander before it is rejected. */
const UV_SLACK = 1e-4;

/**
 * Invert the patch: find (u,v) with S(u,v) ≈ target, or null.
 *
 * Newton from the identity guess (x/w, y/h), which is EXACT at rest and close
 * for any moderate warp. Null means the destination pixel is not covered by the
 * patch — transparent, exactly as Corner Pin treats the outside of its quad,
 * rather than clamping and smearing the edge outward.
 */
export function solveUV(
  p: WarpPoints,
  target: WarpPt,
  w: number,
  h: number,
): { u: number; v: number } | null {
  let u = w > 0 ? target.x / w : 0;
  let v = h > 0 ? target.y / h : 0;
  for (let i = 0; i < 24; i++) {
    const s = coonsPoint(p, u, v);
    const ex = s.x - target.x;
    const ey = s.y - target.y;
    if (ex * ex + ey * ey < 1e-8) break;
    const { du, dv } = coonsJacobian(p, u, v);
    const det = du.x * dv.y - dv.x * du.y;
    // A folded or pinched patch has no unique pre-image here. Reporting failure
    // beats returning whichever branch the iteration happened to be nearest.
    if (Math.abs(det) < 1e-12) return null;
    u -= (dv.y * ex - dv.x * ey) / det;
    v -= (du.x * ey - du.y * ex) / det;
    // Bounded so a diverging step cannot walk off to infinity and spend the
    // remaining iterations there. The slack is generous enough that a solution
    // just outside the square is still found and then rejected below on its
    // merits, rather than being clamped INTO range and silently accepted.
    if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
    if (u < -1) u = -1; else if (u > 2) u = 2;
    if (v < -1) v = -1; else if (v > 2) v = 2;
  }
  // Confirm the answer actually maps back. Newton can exit on iteration count
  // having converged to nothing, and an unverified (u,v) would sample a
  // plausible wrong pixel — which reads as texture rather than as an error.
  const f = coonsPoint(p, u, v);
  if ((f.x - target.x) ** 2 + (f.y - target.y) ** 2 > 0.25) return null;
  if (u < -UV_SLACK || u > 1 + UV_SLACK || v < -UV_SLACK || v > 1 + UV_SLACK) return null;
  return { u, v };
}

/** True when every control point sits at its rest position — the identity. */
export function isRestWarp(p: WarpPoints, w: number, h: number): boolean {
  const d = defaultWarpPoints(w, h);
  return p.every((q, i) => q.x === d[i]!.x && q.y === d[i]!.y);
}

/**
 * Resample the layer through the patch.
 *
 * Destination pixel → (u,v) → source pixel at (u·w, v·h). The source box is the
 * layer's own rectangle, so at rest every pixel maps to itself.
 */
export function bezierWarpData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  p: WarpPoints,
): Uint8ClampedArray {
  return remap(data, w, h, (dx, dy) => {
    const uv = solveUV(p, { x: dx, y: dy }, w, h);
    if (!uv) return null;
    return { x: uv.u * w, y: uv.v * h };
  });
}
