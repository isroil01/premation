/**
 * Warp effects — Wave Warp and Turbulent Displace (AE's Distort family).
 *
 * Both are backward-mapping pixel passes over the layer's native-size buffer:
 * for every destination pixel, sample the source at a displaced position with
 * bilinear filtering (clamped edges). Pure functions of (params, buffer) — no
 * wall clock; motion comes from keyframing `phase` / `evolution`, so they are
 * deterministic and scrub-stable like every other pixel pass.
 */

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Bilinear sample of RGBA `src` at fractional (x, y), edge-clamped. */
function bilinear(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  x: number,
  y: number,
  out: [number, number, number, number],
): void {
  const cx = clamp(x, 0, w - 1);
  const cy = clamp(y, 0, h - 1);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const i00 = (y0 * w + x0) * 4;
  const i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4;
  const i11 = (y1 * w + x1) * 4;
  for (let c = 0; c < 4; c++) {
    const top = src[i00 + c]! + (src[i10 + c]! - src[i00 + c]!) * fx;
    const bot = src[i01 + c]! + (src[i11 + c]! - src[i01 + c]!) * fx;
    out[c] = top + (bot - top) * fy;
  }
}

/**
 * Wave Warp: displace along `direction` by a sine running PERPENDICULAR to it.
 * `waveHeight` = amplitude px, `waveWidth` = wavelength px, `phaseDeg`
 * keyframes the travel. Backward mapping keeps it hole-free.
 */
export function waveWarpData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  waveHeight: number,
  waveWidth: number,
  directionDeg: number,
  phaseDeg: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  if (waveHeight === 0 || waveWidth <= 0) {
    out.set(src);
    return out;
  }
  const dir = (directionDeg * Math.PI) / 180;
  const dx = Math.cos(dir);
  const dy = Math.sin(dir);
  // The wave runs along the axis perpendicular to the displacement direction.
  const px = -dy;
  const py = dx;
  const k = (Math.PI * 2) / waveWidth;
  const phase = (phaseDeg * Math.PI) / 180;
  const sample: [number, number, number, number] = [0, 0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const along = x * px + y * py;
      const disp = Math.sin(along * k + phase) * waveHeight;
      bilinear(src, w, h, x - dx * disp, y - dy * disp, sample);
      const i = (y * w + x) * 4;
      out[i] = sample[0];
      out[i + 1] = sample[1];
      out[i + 2] = sample[2];
      out[i + 3] = sample[3];
    }
  }
  return out;
}

/** Integer hash → [0, 1). Deterministic. */
function hash01(x: number, y: number, seed: number): number {
  let n = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 2147483647;
  n = (n ^ (n >>> 13)) * 1274126177;
  n = n ^ (n >>> 16);
  return (n >>> 0) / 4294967296;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Smooth 2-D value noise in [-1, 1] at continuous (x, y). */
function valueNoise2(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = smooth(x - xi);
  const fy = smooth(y - yi);
  const a = hash01(xi, yi, seed);
  const b = hash01(xi + 1, yi, seed);
  const c = hash01(xi, yi + 1, seed);
  const d = hash01(xi + 1, yi + 1, seed);
  const top = a + (b - a) * fx;
  const bot = c + (d - c) * fx;
  return (top + (bot - top) * fy) * 2 - 1;
}

/** Fractal (fBm) noise in [-1, 1]: `octaves` layers at doubling frequency. */
function fbm(x: number, y: number, seed: number, octaves: number): number {
  let total = 0;
  let amp = 1;
  let freq = 1;
  let maxA = 0;
  const n = clamp(Math.floor(octaves), 1, 6);
  for (let i = 0; i < n; i++) {
    total += valueNoise2(x * freq, y * freq, seed + i * 101) * amp;
    maxA += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return total / maxA;
}

/**
 * Turbulent Displace: offset every pixel by a smooth fractal-noise vector
 * field. `amount` = max displacement px, `size` = noise feature size px,
 * `complexity` = octaves, `evolution` keyframes the churn (it shifts the
 * noise domain, so the field flows rather than pops).
 */
export function turbulentDisplaceData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  amount: number,
  size: number,
  complexity: number,
  evolution: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  if (amount === 0 || size <= 0) {
    out.set(src);
    return out;
  }
  const inv = 1 / size;
  // Evolution slides the sample domain diagonally — continuous churn without
  // reseeding (reseeding per frame would make the field pop).
  const ev = evolution * 0.01;
  const sample: [number, number, number, number] = [0, 0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = fbm(x * inv + ev, y * inv, 7, complexity) * amount;
      const ny = fbm(x * inv, y * inv + ev, 131, complexity) * amount;
      bilinear(src, w, h, x - nx, y - ny, sample);
      const i = (y * w + x) * 4;
      out[i] = sample[0];
      out[i + 1] = sample[1];
      out[i + 2] = sample[2];
      out[i + 3] = sample[3];
    }
  }
  return out;
}

/**
 * Curl Noise (AE 26.3): displace along the CURL of a noise field.
 *
 * Turbulent Displace pushes each pixel by two independent noise values — a
 * field with sources and sinks, which is why at high amounts it tears and
 * bunches. The curl of a scalar field has zero divergence by construction, so
 * pixels swirl around each other and the picture never piles up or voids:
 * the organic "ink in water" motion the effect is for.
 *
 *   v = ∇ × (0, 0, ψ) = (∂ψ/∂y, −∂ψ/∂x)
 *
 * ψ is the same fBm the other warps use; its partials are taken by central
 * differences at one source-pixel step, which is both the cheapest estimate
 * and the one whose scale matches the buffer. Backward-mapped, bilinear,
 * edge-clamped like its siblings, so a curled layer stays hole-free.
 */
/**
 * The curl-noise displacement field, two floats (vx, vy) per pixel.
 *
 * Exported separately from the pixel pass so the field's defining property —
 * zero divergence — can be asserted directly. With the same central-difference
 * stencil for the curl and for the test's divergence, the discrete divergence
 * of the discrete curl is identically zero (the mixed partials cancel term by
 * term), so the test is exact to float error, not a tolerance picked by eye.
 */
export function curlNoiseField(
  w: number,
  h: number,
  amount: number,
  size: number,
  complexity: number,
  evolution: number,
): Float32Array {
  const field = new Float32Array(w * h * 2);
  if (amount === 0 || size <= 0) return field;
  const inv = 1 / size;
  const ev = evolution * 0.01;
  // ψ sampled one source pixel apart; the derivative is in noise units per
  // pixel, scaled back by `size` so the swirl amplitude is `amount` px
  // regardless of feature size — otherwise doubling `size` halves the motion
  // and the two sliders fight.
  const psi = (x: number, y: number): number => fbm(x * inv + ev, y * inv - ev, 53, complexity);
  const k = amount * size * 0.5;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dpdx = psi(x + 1, y) - psi(x - 1, y);
      const dpdy = psi(x, y + 1) - psi(x, y - 1);
      const i = (y * w + x) * 2;
      // Curl of (0,0,ψ): (∂ψ/∂y, −∂ψ/∂x).
      field[i] = dpdy * k;
      field[i + 1] = -dpdx * k;
    }
  }
  return field;
}

export function curlNoiseData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  amount: number,
  size: number,
  complexity: number,
  evolution: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  if (amount === 0 || size <= 0) {
    out.set(src);
    return out;
  }
  const field = curlNoiseField(w, h, amount, size, complexity, evolution);
  const sample: [number, number, number, number] = [0, 0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const f = (y * w + x) * 2;
      bilinear(src, w, h, x - field[f]!, y - field[f + 1]!, sample);
      const i = (y * w + x) * 4;
      out[i] = sample[0];
      out[i + 1] = sample[1];
      out[i + 2] = sample[2];
      out[i + 3] = sample[3];
    }
  }
  return out;
}
