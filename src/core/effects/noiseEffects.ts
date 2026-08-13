/**
 * The Noise family — Turbulent Noise, Add Grain and Median.
 *
 * Three unrelated things that share a folder in After Effects and nothing else:
 * one generates a field, one adds a per-pixel disturbance, one is a rank filter
 * that REMOVES noise. Kept together anyway because that is where users look for
 * them.
 *
 * None reads a clock. Motion comes from keyframing `evolution` / `seed`, the
 * same rule the rest of the Canvas2D family follows — it is what keeps the
 * content hash meaningful and scrubbing reproducible.
 */

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Deterministic value hash → 0..1. */
function hash01(x: number, y: number, seed: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

/** Smooth (bilinear-interpolated, smoothstepped) value noise at one octave. */
function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash01(xi, yi, seed);
  const b = hash01(xi + 1, yi, seed);
  const c = hash01(xi, yi + 1, seed);
  const d = hash01(xi + 1, yi + 1, seed);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

/**
 * Turbulent Noise — fractal noise built from the ABSOLUTE value of each octave.
 *
 * ── How this differs from Fractal Noise, and why both exist ─────────────────
 *
 * Plain fBm sums signed octaves, giving a smooth cloud that crosses zero
 * gently. Turbulence sums |signed octave| instead. Folding each octave at zero
 * puts a CREASE wherever the noise changes sign, and those creases are what
 * give turbulence its wispy, smoke-like filaments — the look you cannot get out
 * of Fractal Noise at any setting.
 *
 * So the two are not presets of one another and shipping only `fractal-noise`
 * genuinely left a gap, even though the code differs by one `Math.abs`.
 *
 * Octaves are capped at 8: each doubles the work for a halving contribution,
 * and past 8 the added detail is below a pixel.
 */
export function turbulentNoiseData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  scale: number,
  complexity: number,
  evolution: number,
  contrast: number,
  brightness: number,
  invert: boolean,
): Uint8ClampedArray {
  const s = Math.max(1, scale);
  const octaves = Math.max(1, Math.min(8, Math.round(complexity)));
  const gain = contrast / 100;
  const lift = brightness / 100;

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const i = (py * w + px) * 4;
      if (data[i + 3] === 0) continue;
      let sum = 0;
      let amp = 1;
      let norm = 0;
      let freq = 1 / s;
      for (let o = 0; o < octaves; o++) {
        // The fold: centre the octave on zero, take |v|. Without the -0.5 the
        // absolute value is a no-op and this degenerates back into fBm.
        const signed = valueNoise(px * freq, py * freq, evolution + o * 13.7) - 0.5;
        sum += Math.abs(signed) * 2 * amp;
        norm += amp;
        amp *= 0.5;
        freq *= 2;
      }
      let v = sum / norm;
      v = (v - 0.5) * gain + 0.5 + lift;
      if (invert) v = 1 - v;
      const level = clamp255(Math.round(v * 255));
      data[i] = level; data[i + 1] = level; data[i + 2] = level;
    }
  }
  return data;
}

/**
 * Add Grain — film grain, which is NOT the same as the existing `noise` effect.
 *
 * Two differences, both of which matter to anyone reaching for this:
 *
 *   • Grain is LUMINANCE-DEPENDENT. Real film grain is most visible in the
 *     midtones and falls away in the deep shadows and blown highlights, because
 *     both ends are saturated. Uniform noise sprays the same amount everywhere,
 *     which is what makes a `noise` layer read as digital dirt rather than
 *     film.
 *   • Grain has SIZE. Sampling the noise field at a coarser pitch and letting
 *     it interpolate gives clumps rather than per-pixel salt.
 *
 * `intensity` is the amount at peak response; `saturation` blends between
 * monochrome grain (0, the film default) and independent per-channel grain
 * (100, which reads as colour speckle).
 */
export function addGrainData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  intensity: number,
  size: number,
  saturation: number,
  seed: number,
): Uint8ClampedArray {
  const amount = intensity / 100;
  if (amount === 0) return data;
  const pitch = Math.max(0.1, size);
  const sat = Math.max(0, Math.min(1, saturation / 100));

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const i = (py * w + px) * 4;
      if (data[i + 3] === 0) continue;
      const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;

      // Luminance response: a parabola peaking at mid-grey, zero at both ends.
      // 4·l·(1−l) rather than a Gaussian because it reaches exactly zero at
      // black and white instead of asymptotically — grain in a blown highlight
      // is the tell of a synthetic grain pass.
      const l = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      const response = 4 * l * (1 - l);
      if (response <= 0) continue;

      const nx = px / pitch;
      const ny = py / pitch;
      const mono = (valueNoise(nx, ny, seed) - 0.5) * 2;
      const kick = amount * response * 128;
      if (sat === 0) {
        data[i] = clamp255(r + mono * kick);
        data[i + 1] = clamp255(g + mono * kick);
        data[i + 2] = clamp255(b + mono * kick);
      } else {
        const nr = (valueNoise(nx, ny, seed + 1.7) - 0.5) * 2;
        const ng = (valueNoise(nx, ny, seed + 5.3) - 0.5) * 2;
        const nb = (valueNoise(nx, ny, seed + 9.1) - 0.5) * 2;
        data[i] = clamp255(r + (mono * (1 - sat) + nr * sat) * kick);
        data[i + 1] = clamp255(g + (mono * (1 - sat) + ng * sat) * kick);
        data[i + 2] = clamp255(b + (mono * (1 - sat) + nb * sat) * kick);
      }
    }
  }
  return data;
}

/**
 * Median — replace each pixel with the median of its neighbourhood.
 *
 * A RANK filter, not a convolution, and that is exactly why it is worth having
 * next to the blurs: a median removes speckle while leaving edges sharp,
 * because an outlier never survives a sort but a step edge does. No linear
 * filter can do both — blurring enough to kill the speckle also softens every
 * edge in the frame.
 *
 * Cost is the catch. The window is (2r+1)², sorted per pixel, so the radius is
 * capped at 8 (a 17×17 window, 289 samples). AE allows more; this trades that
 * tail for a filter that cannot lock up the bake on a large layer. Anything
 * needing a heavier denoise wants a different algorithm, not a bigger window.
 *
 * Alpha is passed through untouched rather than filtered: running a median on
 * alpha erodes soft edges and would make the effect quietly eat feathering.
 */
export function medianData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  radius: number,
): Uint8ClampedArray {
  const r = Math.max(0, Math.min(8, Math.round(radius)));
  if (r === 0) return data;
  const out = new Uint8ClampedArray(data.length);
  const win: number[] = [];

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const di = (py * w + px) * 4;
      out[di + 3] = data[di + 3]!;
      if (data[di + 3] === 0) continue;
      for (let c = 0; c < 3; c++) {
        win.length = 0;
        for (let oy = -r; oy <= r; oy++) {
          const sy = py + oy;
          if (sy < 0 || sy >= h) continue;
          for (let ox = -r; ox <= r; ox++) {
            const sx = px + ox;
            if (sx < 0 || sx >= w) continue;
            win.push(data[(sy * w + sx) * 4 + c]!);
          }
        }
        win.sort((a, b) => a - b);
        out[di + c] = win[win.length >> 1]!;
      }
    }
  }
  return out;
}
