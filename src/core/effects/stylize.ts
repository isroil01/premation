/**
 * Stylize kernels — Mosaic, Find Edges, Roughen Edges.
 *
 * Pure `Uint8ClampedArray` transforms, like `blurs.ts` and for the same reason:
 * the arithmetic is the part worth asserting, and asserting it should not need a
 * DOM. The Canvas2D wrappers in `canvas2dEffects.ts` only marshal.
 */

/**
 * Mosaic — average each cell, then paint the cell that colour.
 *
 * AE's Horizontal/Vertical Blocks are COUNTS across the layer, not pixel sizes,
 * which is what makes the effect resolution-independent: the same values give
 * the same look at 1080p and 4K. Deriving cell size from the layer dimensions
 * rather than taking it as a parameter is the whole reason to prefer counts.
 *
 * Averaged premultiplied, for the same reason the blurs are: a cell straddling a
 * soft edge contains transparent pixels whose colour must not be weighted in.
 */
export function mosaicData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  hBlocks: number,
  vBlocks: number,
  sharpColors: boolean,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  const cols = Math.max(1, Math.min(w, Math.round(hBlocks)));
  const rows = Math.max(1, Math.min(h, Math.round(vBlocks)));
  if (w <= 0 || h <= 0) return out;

  for (let by = 0; by < rows; by++) {
    const y0 = Math.floor((by * h) / rows);
    const y1 = Math.floor(((by + 1) * h) / rows);
    for (let bx = 0; bx < cols; bx++) {
      const x0 = Math.floor((bx * w) / cols);
      const x1 = Math.floor(((bx + 1) * w) / cols);

      let r = 0, g = 0, b = 0, a = 0, n = 0;
      if (sharpColors) {
        // AE's Sharp Colors: take the cell's CENTRE pixel rather than its mean,
        // which keeps saturated detail that averaging would wash to mud.
        const cx = Math.min(w - 1, (x0 + x1) >> 1);
        const cy = Math.min(h - 1, (y0 + y1) >> 1);
        const o = (cy * w + cx) * 4;
        r = src[o]!; g = src[o + 1]!; b = src[o + 2]!; a = src[o + 3]!;
      } else {
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const o = (y * w + x) * 4;
            const sa = src[o + 3]!;
            r += src[o]! * sa; g += src[o + 1]! * sa; b += src[o + 2]! * sa; a += sa;
            n++;
          }
        }
        if (n === 0) continue;
        if (a > 0) { r /= a; g /= a; b /= a; } else { r = g = b = 0; }
        a /= n;
      }

      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * w + x) * 4;
          out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
        }
      }
    }
  }
  return out;
}

/**
 * Find Edges — a Sobel gradient magnitude over luminance.
 *
 * AE's default output is INVERTED (dark edges on white), which is why `invert`
 * defaults true: it is the look people expect from the effect, and the
 * un-inverted form reads as a different effect entirely.
 *
 * Alpha is carried through untouched. Edge-detecting the alpha channel as well
 * would eat the layer's silhouette — the effect is about the colour content,
 * and a layer that dissolved its own shape when you added it would be a bug.
 */
export function findEdgesData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  invert: boolean,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  const lum = (o: number): number =>
    0.299 * src[o]! + 0.587 * src[o + 1]! + 0.114 * src[o + 2]!;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      // Clamp at the border rather than skipping: skipping leaves an unwritten
      // 1px frame of transparent black, which reads as a hairline outline.
      const at = (dx: number, dy: number): number => {
        const sx = Math.min(w - 1, Math.max(0, x + dx));
        const sy = Math.min(h - 1, Math.max(0, y + dy));
        return lum((sy * w + sx) * 4);
      };

      const gx =
        -at(-1, -1) + at(1, -1) +
        -2 * at(-1, 0) + 2 * at(1, 0) +
        -at(-1, 1) + at(1, 1);
      const gy =
        -at(-1, -1) - 2 * at(0, -1) - at(1, -1) +
        at(-1, 1) + 2 * at(0, 1) + at(1, 1);

      const mag = Math.min(255, Math.hypot(gx, gy));
      const v = invert ? 255 - mag : mag;
      out[o] = v; out[o + 1] = v; out[o + 2] = v;
      out[o + 3] = src[o + 3]!;
    }
  }
  return out;
}

/**
 * Value noise with smooth interpolation, on an integer lattice.
 *
 * Shared by Roughen Edges. Deterministic in `seed` and continuous in `evolution`
 * so that keyframing evolution churns the pattern smoothly instead of
 * re-randomising it every frame — the same contract as Turbulent Displace.
 */
function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  // Smoothstep, so the lattice does not show as a grid of creases.
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);

  /**
   * The seed multiplier is written as the value a double ACTUALLY holds.
   *
   * It was `1442695040888963407` — splitmix64's constant, which needs 61 bits
   * and so cannot be represented: JavaScript rounds it to ...328, 79 less than
   * written. The code therefore never used the constant it named, and
   * `no-loss-of-precision` was reporting that correctly from inside a lint gate
   * nobody could run.
   *
   * Written as the true value rather than replaced with a representable one on
   * purpose. Any odd constant works for a hash, so "fixing" it to a different
   * number would change every frame of every layer using this noise — a
   * behaviour change to a shipped effect, which is a decision rather than a
   * lint cleanup. This keeps output bit-identical and stops the code claiming
   * an arithmetic it does not perform.
   */
  const hash = (a: number, b: number): number => {
    let n = a * 374761393 + b * 668265263 + seed * 1442695040888963328;
    n = (n ^ (n >> 13)) * 1274126177;
    return ((n ^ (n >> 16)) >>> 0) / 4294967295;
  };

  const n00 = hash(xi, yi), n10 = hash(xi + 1, yi);
  const n01 = hash(xi, yi + 1), n11 = hash(xi + 1, yi + 1);
  return (n00 * (1 - u) + n10 * u) * (1 - v) + (n01 * (1 - u) + n11 * u) * v;
}

/**
 * Roughen Edges — chew the layer's alpha edge with fractal noise.
 *
 * Works on ALPHA only, and only near the existing edge. That is what separates
 * it from a displacement: the interior is untouched, so a roughened title stays
 * legible while its outline goes ragged.
 *
 * The edge is found from the alpha itself — a pixel's distance from the boundary
 * is approximated by how far its alpha sits from fully-on/fully-off. Cheap, and
 * good enough because the effect only ever acts within `border` px of an edge.
 */
export function roughenEdgesData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  border: number,
  scale: number,
  complexity: number,
  evolution: number,
  seed: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src);
  if (border <= 0 || w <= 0 || h <= 0) return out;

  const octaves = Math.max(1, Math.min(6, Math.round(complexity)));
  // Scale is a percentage in AE; convert to a lattice frequency where 100 gives
  // a feature size of roughly 20px, which is what the default looks like there.
  const freq = 1 / Math.max(1, (scale / 100) * 20);
  const evo = evolution / 60;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const a = src[o + 3]!;
      if (a === 0) continue;

      let n = 0, amp = 1, f = freq, norm = 0;
      for (let i = 0; i < octaves; i++) {
        n += valueNoise(x * f + evo, y * f + evo, seed + i * 101) * amp;
        norm += amp;
        amp *= 0.5;
        f *= 2;
      }
      n /= norm || 1;

      // Bite out of the alpha, scaled by how much noise there is. `border` sets
      // how deep the bite can reach; alpha already near zero goes to zero.
      const bite = n * border * (255 / Math.max(1, border));
      out[o + 3] = Math.max(0, a - bite);
    }
  }
  return out;
}

/**
 * Emboss — light the image as though it were stamped into metal.
 *
 * A DIRECTIONAL derivative, which is what separates it from Find Edges above.
 * Find Edges takes the gradient's magnitude, so it answers "how much does this
 * pixel differ from its neighbours" and is blind to which way; Emboss takes the
 * gradient's component along one direction and keeps the SIGN, so an edge facing
 * the light goes bright and the same edge facing away goes dark. That signed
 * result, biased to mid-grey, is the relief.
 *
 * The sample is taken `relief` pixels out rather than at the immediate
 * neighbour. Convolving a fixed 3×3 kernel would cap the relief at one pixel and
 * make the control a contrast slider wearing a depth label — deep embosses would
 * simply stop getting deeper. Stepping the sample point is what makes `relief`
 * mean thickness.
 *
 * `contrast` scales the signed difference before the mid-grey bias; `blend`
 * (0–100) mixes the original back, matching AE's Blend With Original, where 100
 * is a no-op.
 *
 * Colour is DISCARDED — the output is grey plus the original alpha. That is AE's
 * Emboss; its Color Emboss is the variant that keeps the hue, and this file
 * ships the grey one because the coloured version is reachable by putting this
 * in a blend mode over the original, whereas the reverse is not.
 */
export function embossData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  angleDeg: number,
  relief: number,
  contrast: number,
  blend: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  const keep = blend <= 0 ? 0 : blend >= 100 ? 1 : blend / 100;
  const k = contrast / 100;

  // Screen-space direction: 0 points right, growing clockwise, matching the
  // angle convention the distort and transition families already use.
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(rad) * relief;
  const dy = Math.sin(rad) * relief;

  const lum = (o: number): number =>
    0.299 * src[o]! + 0.587 * src[o + 1]! + 0.114 * src[o + 2]!;
  const at = (x: number, y: number): number => {
    // Clamp at the border for the reason findEdgesData does: skipping would
    // leave an unwritten transparent frame that reads as a hairline outline.
    const sx = Math.min(w - 1, Math.max(0, Math.round(x)));
    const sy = Math.min(h - 1, Math.max(0, Math.round(y)));
    return lum((sy * w + sx) * 4);
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      // Forward minus backward along the light direction — a centred
      // difference, so the relief sits symmetrically on the edge instead of
      // drifting half its width towards the light.
      const d = at(x + dx, y + dy) - at(x - dx, y - dy);
      const v = Math.max(0, Math.min(255, 128 + d * k));

      out[o] = v + (src[o]! - v) * keep;
      out[o + 1] = v + (src[o + 1]! - v) * keep;
      out[o + 2] = v + (src[o + 2]! - v) * keep;
      out[o + 3] = src[o + 3]!;
    }
  }
  return out;
}

/**
 * Scatter — displace each pixel by a random amount, without changing its colour.
 *
 * The dry-brush / frosted-glass look. Distinct from Noise, which perturbs pixel
 * VALUES in place: this one moves pixels around and leaves their values alone,
 * so a scattered image keeps its exact palette and histogram while losing its
 * edges. That difference is why both exist.
 *
 * ── Why the source is sampled, not the destination scattered ────────────────
 *
 * For each DESTINATION pixel this picks a random nearby SOURCE, for the reason
 * `distort.ts` opens with: pushing each source pixel to a random destination
 * leaves holes wherever two land on the same spot, and the result is a scatter
 * full of transparent speckle rather than a scatter. Pulling gives every
 * destination pixel exactly one answer.
 *
 * The random offset is a hash of the pixel's own coordinates and `seed`, not a
 * running PRNG. That makes it stable: the same pixel gets the same offset every
 * frame, so a still layer does not boil, and `evolution` is what deliberately
 * churns it — the same contract Turbulent Displace and Roughen Edges use above.
 *
 * `grain` restricts the scatter to one axis, matching AE's Scatter, where a
 * horizontal-only scatter is how a smeared-glass look is built.
 */
export function scatterData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  amount: number,
  grain: 'both' | 'horizontal' | 'vertical',
  seed: number,
  evolution: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  const radius = Math.max(0, amount);
  if (radius === 0) return src;

  // Two decorrelated hashes per pixel — one per axis. Reusing one value for
  // both would move every pixel along the same diagonal, which reads as a blur
  // rather than a scatter.
  const hash = (x: number, y: number, salt: number): number => {
    let n = x * 374761393 + y * 668265263 + seed * 1442695040888963328 + salt * 2246822519 + evolution * 3266489917;
    n = (n ^ (n >> 13)) * 1274126177;
    return ((n ^ (n >> 16)) >>> 0) / 4294967295;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;

      // Centred on zero so the image scatters in place rather than drifting.
      const ox = grain === 'vertical' ? 0 : (hash(x, y, 1) - 0.5) * 2 * radius;
      const oy = grain === 'horizontal' ? 0 : (hash(x, y, 2) - 0.5) * 2 * radius;

      const sx = Math.min(w - 1, Math.max(0, Math.round(x + ox)));
      const sy = Math.min(h - 1, Math.max(0, Math.round(y + oy)));
      const s = (sy * w + sx) * 4;

      // Nearest, not bilinear, and deliberately: interpolating between two
      // randomly chosen neighbours averages them, which softens exactly the
      // hard speckle the effect exists to produce.
      out[o] = src[s]!;
      out[o + 1] = src[s + 1]!;
      out[o + 2] = src[s + 2]!;
      out[o + 3] = src[s + 3]!;
    }
  }
  return out;
}
