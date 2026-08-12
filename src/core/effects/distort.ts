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

// ── Polar Coordinates ─────────────────────────────────────────────

/** Which way the conversion runs. */
export type PolarConversion = 'rect-to-polar' | 'polar-to-rect';

/** Map the stored 0/1 to the conversion, defaulting to the AE-default direction. */
export function polarConversion(v: number): PolarConversion {
  return v >= 1 ? 'polar-to-rect' : 'rect-to-polar';
}

/**
 * Polar Coordinates — reinterpret the layer's rows and columns as radius and
 * angle, or undo that.
 *
 * The effect that makes a straight strip into a ring. Rect to Polar reads the
 * source's X as an ANGLE and its Y as a RADIUS, so a horizontal gradient becomes
 * a colour wheel and a line of text bends into a circle; Polar to Rect is the
 * inverse and unrolls a circular thing into a strip. It is the standard way to
 * build a radial wipe from a linear one, a tunnel from a texture, or a
 * clock-sweep from a ramp.
 *
 * Both directions are INVERSE maps like everything else in this file — for each
 * destination pixel, work out which source pixel it shows.
 *
 * ── Where angle zero is ─────────────────────────────────────────────────────
 *
 * Twelve o'clock, increasing clockwise, matching AE. `Math.atan2(y, x)` puts
 * zero at three o'clock and increases anticlockwise in screen coordinates, so
 * the arguments are swapped and Y negated: `atan2(vx, -vy)`. Getting this wrong
 * does not look broken — it looks like a correct effect rotated a quarter turn
 * and flipped, which is precisely the kind of wrongness that survives review and
 * then fails to line up with a hand-authored ramp.
 *
 * `interpolation` (0–100) blends between the identity and the full conversion by
 * moving the SAMPLE POINT rather than cross-fading two images. Cross-fading
 * would show both states at once as a double exposure; moving the sample point
 * makes the geometry travel, which is what the control is for and what makes it
 * animatable.
 */
export function polarCoordinatesData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  interpolation: number,
  conversion: PolarConversion,
): Uint8ClampedArray {
  const t = clamp(interpolation / 100, 0, 1);
  if (t <= 0) return data;

  const cx = w / 2;
  const cy = h / 2;
  // The radius that reaches the corners, so the whole layer participates rather
  // than only the inscribed disc.
  const maxR = Math.hypot(cx, cy);
  const TAU = Math.PI * 2;

  return remap(data, w, h, (dx, dy) => {
    let sx: number;
    let sy: number;

    if (conversion === 'rect-to-polar') {
      const vx = dx - cx;
      const vy = dy - cy;
      const r = Math.hypot(vx, vy);
      // 0 at twelve o'clock, growing clockwise, normalised to 0..1.
      let a = Math.atan2(vx, -vy) / TAU;
      if (a < 0) a += 1;
      sx = a * w;
      sy = (r / maxR) * h;
    } else {
      // The exact inverse: this destination pixel's X is an angle and its Y a
      // radius, so the source sits where that polar coordinate lands.
      const a = (dx / w) * TAU;
      const r = (dy / h) * maxR;
      sx = cx + r * Math.sin(a);
      sy = cy - r * Math.cos(a);
    }

    // Partial conversions travel from the identity towards the mapped point.
    if (t < 1) {
      sx = dx + (sx - dx) * t;
      sy = dy + (sy - dy) * t;
    }
    return { x: sx, y: sy };
  });
}

// ── Mirror ────────────────────────────────────────────────────────

/**
 * Mirror — reflect the layer across an arbitrary line.
 *
 * Everything on the far side of the line is replaced by a mirrored copy of the
 * near side. Cheap, and the backbone of kaleidoscope and symmetry looks: stack
 * two at right angles and you have quadrant symmetry, which is otherwise a
 * pre-comp and four transform layers.
 *
 * `angleDeg` names the direction of the line's NORMAL, measured like the rest of
 * the effects here — 0 points right, growing clockwise on screen. Pixels on the
 * positive-normal side are the ones replaced, so rotating the angle by 180°
 * flips which half survives. That is AE's behaviour and it is the reason the
 * angle usefully runs the full 360° rather than 180°.
 *
 * The reflection of a point across a line through `c` with unit normal `n` is
 * `p − 2(p−c)·n · n`; only points with a positive dot product are reflected, the
 * rest are left where they are.
 */
export function mirrorData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  centerX: number,
  centerY: number,
  angleDeg: number,
): Uint8ClampedArray {
  const rad = (angleDeg * Math.PI) / 180;
  const nx = Math.cos(rad);
  const ny = Math.sin(rad);

  return remap(data, w, h, (dx, dy) => {
    const d = (dx - centerX) * nx + (dy - centerY) * ny;
    // Exactly on the line, and on the near side, the pixel is its own source.
    if (d <= 0) return { x: dx, y: dy };
    return { x: dx - 2 * d * nx, y: dy - 2 * d * ny };
  });
}

// ── Offset ────────────────────────────────────────────────────────

/**
 * Offset — pan the layer's contents, WRAPPING at the edges.
 *
 * The wrap is the entire point. Panning without it is what the Transform effect
 * and the layer's own position already do; wrapping is what makes a texture
 * scroll seamlessly forever, which is how every conveyor, starfield and
 * endless-background shot is built.
 *
 * ── Why this does not use `remap` ───────────────────────────────────────────
 *
 * `remap` reads out-of-range neighbours as TRANSPARENT, which is right for every
 * other warp in this file — it stops a corner pin smearing its border pixel into
 * a streak. Here it is exactly wrong: the bilinear footprint at the seam
 * straddles the edge, so three of its four taps would come back empty and the
 * wrap would render as a one-pixel transparent scar down the middle of an
 * otherwise seamless scroll. The whole effect is judged on that seam being
 * invisible, so this samples with WRAPPING neighbours instead.
 *
 * `shiftX`/`shiftY` are the position the layer's centre moves TO, in pixels,
 * matching AE's "Shift Center To". `blend` (0–100) mixes the original back, and
 * at 100 the effect is a no-op.
 */
export function offsetData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  shiftX: number,
  shiftY: number,
  blend: number,
): Uint8ClampedArray {
  const keep = clamp(blend / 100, 0, 1);
  if (keep >= 1 || w <= 0 || h <= 0) return data;

  // "Shift centre TO" is a destination, so the translation is how far that is
  // from where the centre already is.
  const tx = shiftX - w / 2;
  const ty = shiftY - h / 2;

  // Positive modulo — `%` keeps the sign of the dividend in JS, so a leftward
  // shift would index negatively and read nothing.
  const wrap = (v: number, n: number): number => ((v % n) + n) % n;

  const out = new Uint8ClampedArray(data.length);
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const di = (dy * w + dx) * 4;

      const sx = wrap(dx + 0.5 - tx, w) - 0.5;
      const sy = wrap(dy + 0.5 - ty, h) - 0.5;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;

      for (let c = 0; c < 4; c++) {
        let acc = 0;
        for (let j = 0; j <= 1; j++) {
          for (let i = 0; i <= 1; i++) {
            // The wrap is applied to the NEIGHBOUR index too — that is what
            // closes the seam.
            const px = wrap(x0 + i, w);
            const py = wrap(y0 + j, h);
            const weight = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
            acc += data[(py * w + px) * 4 + c]! * weight;
          }
        }
        out[di + c] = keep <= 0 ? acc : acc + (data[di + c]! - acc) * keep;
      }
    }
  }
  data.set(out);
  return data;
}

export { clamp as __clampForTests };

// ── Optics Compensation ───────────────────────────────────────────

/**
 * Optics Compensation — add or remove lens barrel/pincushion distortion.
 *
 * The effect a shot needs before it can be tracked, composited into, or
 * stitched: a real lens bends straight lines, and anything added in post is
 * drawn with a pinhole camera that does not. Removing the distortion makes the
 * plate match the CG; re-applying it afterwards makes the CG match the plate,
 * which is why `reverse` is a first-class control rather than a negative field
 * of view.
 *
 * ── The model ───────────────────────────────────────────────────────────────
 *
 * A single-parameter radial division model, which is what AE's Field of View
 * control is: for a point at normalised radius `r` from the optical centre,
 *
 *     r_distorted = r / (1 + k·r²)
 *
 * `k` is derived from the field of view so the control reads in degrees rather
 * than in an abstract coefficient. Division rather than the polynomial
 * `r·(1 + k·r²)` because it INVERTS in closed form, and this effect is used in
 * pairs — remove on the way in, re-apply on the way out. A polynomial model
 * needs an iterative solve to invert, and a round trip that does not land back
 * where it started is the one thing this effect must not do.
 *
 * ── Which radius is normalised ──────────────────────────────────────────────
 *
 * By the half-DIAGONAL, not the half-width. A lens distorts by angle from the
 * optical axis, so the corners — the largest angle — must be the extreme of the
 * model. Normalising by width would make the effect depend on the layer's
 * aspect ratio and stop a round trip closing on anything that is not square.
 *
 * `centerX`/`centerY` are offsets from the layer centre in pixels, because a
 * real optical centre is rarely the exact middle of the sensor.
 */
export function opticsCompensationData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  fieldOfView: number,
  reverse: boolean,
  centerX: number,
  centerY: number,
): Uint8ClampedArray {
  const fov = clamp(fieldOfView, 0, 180);
  // Zero FOV is the identity, and returning early keeps it EXACTLY so — a
  // resample at k = 0 is still a resample, and would soften the layer by a
  // bilinear tap for a control the user has left switched off.
  if (fov <= 0) return data;

  const cx = w / 2 + centerX;
  const cy = h / 2 + centerY;
  // Half-diagonal of the layer, not of the offset centre: the model's extent is
  // a property of the frame, so moving the optical centre slides the field
  // rather than rescaling it.
  const norm = Math.hypot(w / 2, h / 2) || 1;

  /*
    Field of view → k.

    tan(fov/2) grows without bound toward 180°, which is the physically right
    shape (a fisheye approaches an infinite angle) and numerically hostile at the
    end of the slider. Scaling by a half keeps k in a usable range across the
    whole control while staying monotonic, so dragging the slider always bends
    further in the same direction.
  */
  const k = Math.tan((fov * Math.PI) / 360) * 0.5;

  return remap(data, w, h, (dx, dy) => {
    const vx = dx - cx;
    const vy = dy - cy;
    const r = Math.hypot(vx, vy) / norm;
    if (r === 0) return { x: dx, y: dy };
    /*
      `remap` walks DESTINATION pixels and asks where to read from, so this is
      the INVERSE of the visual transform — which is why the two branches look
      swapped relative to the names. Getting this backwards produces a warp of
      the right magnitude in the wrong direction, which looks entirely plausible
      in a still and is only caught by a directional test.
    */
    let scale: number;
    if (reverse) {
      scale = 1 / (1 + k * r * r);
    } else {
      /*
        The EXACT inverse of the branch above, solved rather than guessed.

        The tempting expression is `1 + k·r²` — and it is wrong. That is the
        POLYNOMIAL distortion model, a different curve that merely looks like
        the opposite of the division one. Composing the two leaves a residual
        that grows with radius, which is exactly the drift a matched
        remove/apply pair exists to avoid and is invisible in any single frame.

        Inverting `s = r / (1 + k·r²)` for r gives `s·k·r² − r + s = 0`, hence

            r = (1 − √(1 − 4·s²·k)) / (2·s²·k) · s

        taking the root through the origin. Written below as a scale factor on
        the vector, so both branches return the same shape.
      */
      const disc = 1 - 4 * r * r * k;
      // Past this radius the model has no real inverse: no undistorted point
      // maps here, because the field folds over itself. Continuing at the fold's
      // own scale keeps the warp continuous rather than producing NaN, which
      // `remap` would turn into a blank pixel.
      scale = disc <= 0
        ? 1 / (2 * r * r * k)
        : (1 - Math.sqrt(disc)) / (2 * r * r * k);
    }
    return { x: cx + vx * scale, y: cy + vy * scale };
  });
}

// ── Mesh Warp ─────────────────────────────────────────────────────

/** Lattice size. See {@link meshWarpData} for why it is fixed. */
export const MESH_WARP_N = 4;

/**
 * Mesh Warp — deform the layer by moving a lattice of control points.
 *
 * ── What this does that Bezier Warp cannot ──────────────────────────────────
 *
 * Bezier Warp bends the layer's BOUNDARY: four corners and eight tangents, with
 * the interior following whatever the patch implies. It cannot put a bump in
 * the middle of a shot while leaving the frame edges pinned, which is most of
 * what a mesh warp is used for — pushing a face, easing a horizon, hiding a
 * seam. This one carries interior vertices, so the deformation can live
 * anywhere.
 *
 * ── The offsets are an inverse map, on purpose ──────────────────────────────
 *
 * `remap` walks destination pixels and asks where to read from, so a vertex
 * offset is SUBTRACTED rather than added: the pixel at `p` reads from
 * `p − offset(p)`, and dragging a vertex right moves the image right. That
 * matches how Displace already behaves here, and it avoids inverting a
 * general mesh — which has no closed form and would need a per-pixel search.
 *
 * The cost, stated: for offsets approaching the lattice spacing the map can
 * fold, and a fold reads as a pinch rather than an error. AE's mesh warp has
 * the same property; it is inherent to a displacement formulation.
 *
 * ── Why the lattice is 4×4 and not adjustable ───────────────────────────────
 *
 * Effect parameters here are NUMBERS, because that is what rides the keyframe
 * path — and the distortion mesh is the thing users animate. A variable-size
 * mesh would have to be stored as an opaque blob, which cannot keyframe through
 * `buildParamRamp` at all. A fixed lattice keeps every vertex individually
 * animatable, which is worth more than an adjustable row count that freezes the
 * whole mesh. Sixteen vertices is also where the parameter list stops being
 * navigable: Bezier Warp's twelve already fill a panel.
 */
export function meshWarpData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  /** `MESH_WARP_N × MESH_WARP_N` offsets in px, row-major from the top-left. */
  offsets: ReadonlyArray<{ x: number; y: number }>,
): Uint8ClampedArray {
  const n = MESH_WARP_N;
  if (offsets.length < n * n) return data;
  // An untouched mesh is the identity, and returning the input keeps it
  // EXACTLY so — a resample of a rest mesh still costs a bilinear tap of
  // softening, which is a real cost for a control nobody has moved.
  if (offsets.every((o) => o.x === 0 && o.y === 0)) return data;

  // Lattice spacing in pixels. The outer vertices sit ON the layer's edges, so
  // a corner vertex moves the corner rather than a point near it.
  const stepX = w / (n - 1);
  const stepY = h / (n - 1);

  return remap(data, w, h, (dx, dy) => {
    // Which cell, and where inside it. Clamped so the half-pixel sample offset
    // at the far edge cannot index past the last vertex.
    const gx = Math.min(n - 2, Math.max(0, Math.floor(dx / stepX)));
    const gy = Math.min(n - 2, Math.max(0, Math.floor(dy / stepY)));
    const tx = clamp((dx - gx * stepX) / stepX, 0, 1);
    const ty = clamp((dy - gy * stepY) / stepY, 0, 1);

    const at = (ix: number, iy: number): { x: number; y: number } => offsets[iy * n + ix]!;
    const o00 = at(gx, gy);
    const o10 = at(gx + 1, gy);
    const o01 = at(gx, gy + 1);
    const o11 = at(gx + 1, gy + 1);

    // Bilinear across the cell. Smooth enough that a moved vertex reads as a
    // dent rather than a facet, and cheap enough to run per pixel.
    const top = { x: o00.x + (o10.x - o00.x) * tx, y: o00.y + (o10.y - o00.y) * tx };
    const bot = { x: o01.x + (o11.x - o01.x) * tx, y: o01.y + (o11.y - o01.y) * tx };
    const ox = top.x + (bot.x - top.x) * ty;
    const oy = top.y + (bot.y - top.y) * ty;

    return { x: dx - ox, y: dy - oy };
  });
}

// ── Liquify ───────────────────────────────────────────────────────

/**
 * Liquify — push, twirl and pinch the image inside a brush.
 *
 * ── What this is, and what it is NOT ────────────────────────────────────────
 *
 * ★ This is the MATHS of Liquify's tools as a parameterised, keyframeable
 * effect. It is not AE's brush-stroke workflow, and the difference is worth
 * stating plainly rather than discovering.
 *
 * AE's Liquify is modal: you pick a tool, drag over the layer, and each stroke
 * accumulates into a stored distortion MESH which the effect then replays. That
 * mesh is an opaque per-layer buffer — it cannot travel through a parameter
 * system whose values are numbers, and numbers are what ride the keyframe path
 * here. A stored-mesh Liquify would therefore be a Liquify that cannot animate,
 * which is the wrong half to keep.
 *
 * So this is one brush, placed by its centre and radius, carrying the three
 * deformations that matter:
 *
 *   push    — a directional shove (AE's Warp tool), and the only one of the
 *             three with no equivalent already in this file
 *   twirl   — rotation falling off to the brush edge
 *   pinch   — radial contraction, negative values bloat
 *
 * Every one of them is animatable, and several can be stacked for several
 * strokes. What is genuinely absent is freehand painting and Reconstruct.
 *
 * ── Why one effect rather than three ────────────────────────────────────────
 *
 * They share a centre, a radius and a falloff, and in use they are applied
 * together — a push that also twists is one gesture, not two. Three separate
 * effects would each carry a duplicate centre to keep in sync, and stacking
 * them would resample three times where this resamples once.
 *
 * The falloff is `radialFalloff`, the same smoothstep Bulge and Spherize use, so
 * a brush edge is invisible here for the same reason a bulge's is.
 */
export function liquifyData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  centerX: number,
  centerY: number,
  radius: number,
  pushX: number,
  pushY: number,
  twirlDeg: number,
  pinchPct: number,
): Uint8ClampedArray {
  const twirlRad = (twirlDeg * Math.PI) / 180;
  const pinch = pinchPct / 100;
  // Every control at rest is the identity, and returning the input keeps it
  // exactly so rather than paying a bilinear tap to reproduce the layer.
  if (radius <= 0 || (pushX === 0 && pushY === 0 && twirlRad === 0 && pinch === 0)) return data;

  return remap(data, w, h, (dx, dy) => {
    const vx = dx - centerX;
    const vy = dy - centerY;
    const dist = Math.hypot(vx, vy);
    const f = radialFalloff(dist, radius);
    if (f === 0) return { x: dx, y: dy };

    /*
      All three are INVERSE displacements — `remap` asks where a destination
      pixel reads FROM, so the push is subtracted. Dragging the control right
      moves the image right, which is the direction a user expects and the
      opposite of what adding it would do.
    */
    let sx = dx - pushX * f;
    let sy = dy - pushY * f;

    if (twirlRad !== 0 || pinch !== 0) {
      // Rotation and radial scale are about the brush centre, so they are
      // applied to the vector AFTER the push has moved the sample point —
      // otherwise a pushed pixel would twirl about a centre it no longer
      // relates to, and the two controls would visibly fight.
      const rx = sx - centerX;
      const ry = sy - centerY;
      const angle = -twirlRad * f;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      // `1 + pinch·f`: reading from FURTHER out contracts the image toward the
      // centre, which is what pinch means. Negative values read closer in and
      // bloat.
      const scale = 1 + pinch * f;
      sx = centerX + (rx * cos - ry * sin) * scale;
      sy = centerY + (rx * sin + ry * cos) * scale;
    }

    return { x: sx, y: sy };
  });
}
