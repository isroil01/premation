/**
 * Geometric distortions — Bulge, Twirl, Spherize and Corner Pin.
 *
 * All four are INVERSE maps: for each DESTINATION pixel they compute where it
 * came from in the source and sample there. That direction is not a style
 * choice. A forward map (push each source pixel to where it lands) tears — any
 * expansion leaves destination pixels no source pixel happened to land on, and
 * they stay as holes. Sampling backwards, every destination pixel gets exactly
 * one answer by construction, and the same expansion simply reads its
 * neighbours more than once.
 *
 * They share `remap`, which owns the sampling. Each effect supplies only the
 * geometry: destination → source, in pixels.
 *
 * Bilinear rather than nearest, because these are smooth warps whose whole
 * appeal is that straight edges bend cleanly; nearest sampling makes a twirl
 * look like a staircase at every angle away from the axes.
 */

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * Resample `data` through an inverse map, returning new pixels.
 *
 * `invert(dx, dy)` answers "which source pixel does destination (dx,dy) show?"
 * Returning null means "nothing" — the destination pixel is left fully
 * transparent, which is what a corner pin needs outside its quad.
 *
 * Out-of-range source coordinates read as transparent rather than clamping to
 * the edge. Edge-clamping smears the border pixel outwards into a streak, which
 * on a layer with an alpha edge (most of them) invents opaque content where the
 * layer does not exist.
 */
export function remap(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  invert: (dx: number, dy: number) => { x: number; y: number } | null,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data.length);
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const di = (dy * w + dx) * 4;
      const src = invert(dx + 0.5, dy + 0.5);
      if (!src) continue;
      const sx = src.x - 0.5;
      const sy = src.y - 0.5;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      for (let c = 0; c < 4; c++) {
        let acc = 0;
        for (let j = 0; j <= 1; j++) {
          for (let i = 0; i <= 1; i++) {
            const px = x0 + i;
            const py = y0 + j;
            if (px < 0 || px >= w || py < 0 || py >= h) continue;
            const weight = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
            acc += data[(py * w + px) * 4 + c]! * weight;
          }
        }
        out[di + c] = acc;
      }
    }
  }
  return out;
}

/**
 * A radial falloff shared by Bulge and Spherize: 1 at the centre, 0 at the
 * radius, smooth at both ends.
 *
 * Smoothstep rather than linear specifically so the edge of the affected disc
 * is invisible. A linear falloff reaches the radius with a non-zero slope, and
 * that slope discontinuity shows up as a hard circular seam in the warped
 * image — the single most common way a bulge looks wrong.
 */
function radialFalloff(dist: number, radius: number): number {
  if (radius <= 0 || dist >= radius) return 0;
  const t = 1 - dist / radius;
  return t * t * (3 - 2 * t);
}

/**
 * Bulge — magnify (or pinch) inside a disc.
 *
 * `height` > 0 magnifies, < 0 pinches. Implemented by pulling the sample point
 * TOWARDS the centre in proportion to the falloff: reading from nearer the
 * centre than you should makes the centre's content cover more of the frame,
 * which is magnification.
 */
export function bulgeData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  centerX: number,
  centerY: number,
  radius: number,
  height: number,
): Uint8ClampedArray {
  const amount = height / 100;
  if (amount === 0 || radius <= 0) return data;
  return remap(data, w, h, (dx, dy) => {
    const vx = dx - centerX;
    const vy = dy - centerY;
    const dist = Math.hypot(vx, vy);
    const f = radialFalloff(dist, radius);
    if (f === 0) return { x: dx, y: dy };
    const scale = 1 - amount * f;
    return { x: centerX + vx * scale, y: centerY + vy * scale };
  });
}

/**
 * Spherize — map the disc as though it were wrapped onto a sphere.
 *
 * Distinct from Bulge, and the difference is the reason both exist: Bulge's
 * falloff is an arbitrary smooth curve, while this one is the actual spherical
 * refraction, `sin` of the normalised radius. The result is that a Spherize
 * looks like a lens over the image — straight lines through the centre stay
 * straight and everything else bows correctly — whereas a Bulge looks like the
 * image was pushed from behind.
 */
export function spherizeData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  centerX: number,
  centerY: number,
  radius: number,
  amountPct: number,
): Uint8ClampedArray {
  const amount = amountPct / 100;
  if (amount === 0 || radius <= 0) return data;
  return remap(data, w, h, (dx, dy) => {
    const vx = dx - centerX;
    const vy = dy - centerY;
    const dist = Math.hypot(vx, vy);
    if (dist >= radius || dist === 0) return { x: dx, y: dy };
    const nr = dist / radius;
    // The refraction, INVERTED — `asin`, not `sin`.
    //
    // The forward optics are "a point at normalised radius r on the sphere
    // appears at sin(r·π/2)". But `remap` asks the opposite question: this is a
    // destination pixel, where did it come from? That is the inverse,
    // (2/π)·asin(nr), and the distinction is not cosmetic — since sin(r·π/2) > r
    // across the whole open interval, using the forward form makes `scale`
    // greater than 1, so every destination pixel reads from FARTHER out and the
    // lens minifies. It still produces a plausible, smooth, spherical-looking
    // warp, in the wrong direction; only a test that checks which WAY content
    // moves catches it.
    //
    // Continuous at both ends: asin(nr)·2/π → nr as nr → 0, and → 1 as nr → 1,
    // so the disc edge is a fixed point and the centre is unwarped.
    const bent = (2 / Math.PI) * Math.asin(nr);
    const scale = 1 + amount * (bent / nr - 1);
    return { x: centerX + vx * scale, y: centerY + vy * scale };
  });
}

/**
 * Twirl — rotate the image about a centre, by an angle that falls off with
 * distance.
 *
 * The falloff is what makes it a twirl rather than a rotation: full angle at
 * the centre, zero at the radius, so the image shears continuously between the
 * two and the disc's edge stays put.
 */
export function twirlData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  centerX: number,
  centerY: number,
  radius: number,
  angleDeg: number,
): Uint8ClampedArray {
  const maxAngle = (angleDeg * Math.PI) / 180;
  if (maxAngle === 0 || radius <= 0) return data;
  return remap(data, w, h, (dx, dy) => {
    const vx = dx - centerX;
    const vy = dy - centerY;
    const dist = Math.hypot(vx, vy);
    if (dist >= radius) return { x: dx, y: dy };
    // Linear in distance — the classic twirl. Smoothstep here would flatten the
    // centre's rotation, which is the part you actually want to see.
    const angle = maxAngle * (1 - dist / radius);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return {
      x: centerX + vx * cos - vy * sin,
      y: centerY + vx * sin + vy * cos,
    };
  });
}

// ── Corner Pin ────────────────────────────────────────────────────

/** A 3×3 projective matrix, row-major. */
type Mat3 = [number, number, number, number, number, number, number, number, number];

/**
 * The homography taking the unit square's corners to four arbitrary points.
 *
 * Solved in closed form rather than by a general linear solver, which is what
 * makes Corner Pin cheap enough to run per frame. The standard construction:
 * find the projective weights `g`/`hh` from the two diagonal deficits, then the
 * affine part follows directly.
 *
 * Returns null when the four points are degenerate (three collinear, or the
 * quad folded), because the inverse does not exist and every sample would be a
 * division by ~0. Callers treat null as "draw nothing" rather than rendering
 * a frame of noise.
 */
function squareToQuad(
  x0: number, y0: number, x1: number, y1: number,
  x2: number, y2: number, x3: number, y3: number,
): Mat3 | null {
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(den) < 1e-9) return null;
  const g = (dx3 * dy2 - dx2 * dy3) / den;
  const hh = (dx1 * dy3 - dx3 * dy1) / den;
  return [
    x1 - x0 + g * x1, x3 - x0 + hh * x3, x0,
    y1 - y0 + g * y1, y3 - y0 + hh * y3, y0,
    g, hh, 1,
  ];
}

/** 3×3 inverse via the adjugate. Null when singular. */
function invert3(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const s = 1 / det;
  return [
    A * s, (c * h - b * i) * s, (b * f - c * e) * s,
    B * s, (a * i - c * g) * s, (c * d - a * f) * s,
    C * s, (b * g - a * h) * s, (a * e - b * d) * s,
  ];
}

/**
 * Corner Pin — map the layer's four corners to four arbitrary points.
 *
 * A PROJECTIVE map, not an affine one, and that is the entire point of the
 * effect. An affine transform (which the Transform effect already offers)
 * always keeps opposite edges parallel, so it can skew a rectangle into a
 * parallelogram and no further. A projective map can send it to any convex
 * quad, which is what produces perspective — the reason you reach for Corner
 * Pin to lay an image onto a wall or a screen in footage.
 *
 * Corners arrive in pixels, in the order top-left, top-right, bottom-right,
 * bottom-left. A degenerate quad clears the layer rather than rendering
 * garbage.
 */
export function cornerPinData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  corners: readonly [number, number, number, number, number, number, number, number],
): Uint8ClampedArray {
  const [tlx, tly, trx, try_, brx, bry, blx, bly] = corners;
  const forward = squareToQuad(tlx, tly, trx, try_, brx, bry, blx, bly);
  const inverse = forward ? invert3(forward) : null;
  if (!inverse) return new Uint8ClampedArray(data.length);

  const [a, b, c, d, e, f, g, hh, i] = inverse;
  return remap(data, w, h, (dx, dy) => {
    const den = g * dx + hh * dy + i;
    if (Math.abs(den) < 1e-9) return null;
    // Unit-square coordinates, then back into source pixels.
    const u = (a * dx + b * dy + c) / den;
    const v = (d * dx + e * dy + f) / den;
    // Outside the quad there is no source content — transparent, not clamped.
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    return { x: u * w, y: v * h };
  });
}

/** Corner defaults in pixels for a `w`×`h` layer — the untransformed rectangle. */
export function defaultCorners(w: number, h: number): [number, number, number, number, number, number, number, number] {
  return [0, 0, w, 0, w, h, 0, h];
}

export { clamp as __clampForTests };
