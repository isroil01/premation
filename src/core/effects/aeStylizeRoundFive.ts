/**
 * Stylize, round five — Glass, Texturize, Threads, Chromatic Aberration,
 * Hex Tile — plus Vector Blur (a blur, but its flow field is built from the
 * same luminance-gradient machinery Glass uses, so they live together).
 *
 * All pure `Uint8ClampedArray` transforms. The shading pair (Glass, Texturize)
 * derives light from a HEIGHT FIELD: Glass reads the layer's own blurred
 * luminance, Texturize a procedural pattern. Both light with the same
 * directional-derivative rule, so the two effects agree about where the light
 * sits — a mismatch there reads as two different suns in one composition.
 */

import { clamp01, clamp255, luma } from './colorSpace';
import { remap } from './distort';

const DEG = Math.PI / 180;

/** Deterministic 0..1 hash of two integers (same recipe as the other rounds). */
function hash2(a: number, b: number): number {
  let n = (a * 374761393 + b * 668265263) | 0;
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/** Luma plane of an RGBA buffer, optionally box-blurred (radius px, 2 passes). */
function lumaField(src: Uint8ClampedArray, w: number, h: number, blurRadius: number): Float32Array {
  let f = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    f[i] = luma(src[i * 4]!, src[i * 4 + 1]!, src[i * 4 + 2]!) * (src[i * 4 + 3]! / 255);
  }
  const r = Math.max(0, Math.round(blurRadius));
  if (r === 0) return f;
  // Two axis-separable box passes ≈ a soft blur; enough to steady a gradient.
  for (let pass = 0; pass < 2; pass++) {
    const g = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        let cnt = 0;
        for (let k = -r; k <= r; k++) {
          const xx = pass === 0 ? x + k : x;
          const yy = pass === 0 ? y : y + k;
          if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
          sum += f[yy * w + xx]!;
          cnt++;
        }
        g[y * w + x] = cnt > 0 ? sum / cnt : 0;
      }
    }
    f = g;
  }
  return f;
}

/** Central-difference gradient of a scalar field at (x, y), clamped at edges. */
function gradAt(f: Float32Array, w: number, h: number, x: number, y: number): [number, number] {
  const xm = Math.max(0, x - 1);
  const xp = Math.min(w - 1, x + 1);
  const ym = Math.max(0, y - 1);
  const yp = Math.min(h - 1, y + 1);
  return [
    (f[y * w + xp]! - f[y * w + xm]!) / (xp - xm || 1),
    (f[yp * w + x]! - f[ym * w + x]!) / (yp - ym || 1),
  ];
}

// ── Glass ───────────────────────────────────────────────────────────

/**
 * CC Glass — the layer's own luminance as relief: refract the picture through
 * it, then light it. Negative `height` flips bumps into dents, which is half
 * the use of the effect. Displacement is the refraction; light is Lambert plus
 * a Blinn-ish specular scaled by `shininess`.
 */
export function glassData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  bumpSoftness: number,
  height: number,
  displacement: number,
  lightAngle: number,
  lightIntensity: number,
  shininess: number,
): Uint8ClampedArray {
  const field = lumaField(src, w, h, bumpSoftness);
  const hgt = height / 100;
  const disp = displacement;
  // Refraction: sample where the surface slope bends the view ray.
  const out = remap(src, w, h, (dx, dy) => {
    const x = Math.min(w - 1, Math.max(0, Math.floor(dx)));
    const y = Math.min(h - 1, Math.max(0, Math.floor(dy)));
    const [gx, gy] = gradAt(field, w, h, x, y);
    return { x: dx + gx * hgt * disp, y: dy + gy * hgt * disp };
  });
  // Lighting on the refracted result, from the same height field.
  const la = lightAngle * DEG;
  const lx = Math.cos(la);
  const ly = -Math.sin(la); // screen y grows downward
  const gain = lightIntensity / 100;
  const shine = clamp01(shininess / 100);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (out[o + 3] === 0) continue;
      const [gx, gy] = gradAt(field, w, h, x, y);
      // Slope along the light: positive = facing the light.
      const facing = (-gx * lx - gy * ly) * hgt;
      const diffuse = 1 + gain * facing * 0.04;
      const spec = shine * gain * Math.pow(clamp01(facing * 0.02), 2) * 255;
      out[o] = clamp255(out[o]! * diffuse + spec);
      out[o + 1] = clamp255(out[o + 1]! * diffuse + spec);
      out[o + 2] = clamp255(out[o + 2]! * diffuse + spec);
    }
  }
  return out;
}

// ── Texturize ───────────────────────────────────────────────────────

/** Procedural height patterns for Texturize. 0 noise · 1 canvas · 2 weave · 3 brick. */
function texturePattern(pattern: number, x: number, y: number, scale: number): number {
  const s = 100 / Math.max(10, scale); // larger scale = coarser texture
  const u = x * s;
  const v = y * s;
  switch (Math.round(pattern)) {
    case 0: { // value noise
      const xi = Math.floor(u / 4);
      const yi = Math.floor(v / 4);
      const fx = (u / 4) - xi;
      const fy = (v / 4) - yi;
      const a = hash2(xi, yi * 733);
      const b = hash2(xi + 1, yi * 733);
      const c = hash2(xi, (yi + 1) * 733);
      const d = hash2(xi + 1, (yi + 1) * 733);
      return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
    }
    case 2: // weave — perpendicular cords
      return 0.5 + 0.25 * Math.sin(u * 0.9) + 0.25 * Math.sin(v * 0.9);
    case 3: { // brick — offset courses with mortar lines
      const row = Math.floor(v / 8);
      const uu = u + (row % 2 === 0 ? 0 : 8);
      const inBrickX = ((uu % 16) + 16) % 16;
      const inBrickY = ((v % 8) + 8) % 8;
      return inBrickX < 1 || inBrickY < 1 ? 0 : 0.7;
    }
    default: {
      // Canvas — a fine orthogonal weave plus per-cell grit. The pure
      // low-frequency sine product read as diagonal stripes on the contact
      // sheet; real canvas is high-frequency warp/weft with tooth.
      const weave = 0.30 * Math.sin(u * 3.7) * Math.sin(v * 3.9);
      const grit = 0.18 * (hash2(Math.floor(u * 2), Math.floor(v * 2) * 977) - 0.5);
      return 0.5 + weave + grit;
    }
  }
}

/** AE Texturize — shade the layer by the directional slope of a procedural texture. */
export function texturizeData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  pattern: number,
  contrast: number,
  scale: number,
  lightAngle: number,
): Uint8ClampedArray {
  const out = Uint8ClampedArray.from(src);
  const gain = contrast / 100;
  if (gain <= 0) return out;
  const la = lightAngle * DEG;
  const lx = Math.cos(la);
  const ly = -Math.sin(la);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (out[o + 3] === 0) continue;
      // Directional derivative of the texture along the light.
      const t0 = texturePattern(pattern, x - lx, y - ly, scale);
      const t1 = texturePattern(pattern, x + lx, y + ly, scale);
      const shade = 1 + gain * (t1 - t0);
      out[o] = clamp255(out[o]! * shade);
      out[o + 1] = clamp255(out[o + 1]! * shade);
      out[o + 2] = clamp255(out[o + 2]! * shade);
    }
  }
  return out;
}

// ── Threads ─────────────────────────────────────────────────────────

/**
 * CC Threads — the layer rewoven as an over-under fabric. Horizontal and
 * vertical strips alternate which passes on top per crossing (the checker
 * parity IS the weave); `spacing` opens transparent gaps between threads and
 * `depth` darkens the strand passing underneath.
 */
export function threadsData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  thickness: number,
  spacing: number,
  depth: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  const th = Math.max(2, Math.round(thickness));
  const gap = Math.max(0, Math.round(spacing));
  const period = th + gap;
  const dk = clamp01(depth / 100);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inH = (y % period) < th; // inside a horizontal thread band
      const inV = (x % period) < th;
      if (!inH && !inV) continue; // the gap — transparent
      const cellX = Math.floor(x / period);
      const cellY = Math.floor(y / period);
      const vOnTop = (cellX + cellY) % 2 === 0;
      // Which strand is visible here?
      const showV = inV && (vOnTop || !inH);
      const o = (y * w + x) * 4;
      out[o] = src[o]!;
      out[o + 1] = src[o + 1]!;
      out[o + 2] = src[o + 2]!;
      out[o + 3] = src[o + 3]!;
      // Cylindrical shading across the visible strand's width…
      const across = showV ? (x % period) : (y % period);
      const profile = Math.sin(((across + 0.5) / th) * Math.PI);
      let shade = 0.55 + 0.45 * profile;
      // …and depth: at a crossing the top strand casts a contact shadow where
      // the under strand's edges dive beneath it.
      if (inH && inV && dk > 0) {
        const underAcross = showV ? (y % period) : (x % period);
        const edge = Math.min(underAcross, th - 1 - underAcross);
        if (edge < 1.5) shade *= 1 - dk * 0.6;
      }
      out[o] = clamp255(out[o]! * shade);
      out[o + 1] = clamp255(out[o + 1]! * shade);
      out[o + 2] = clamp255(out[o + 2]! * shade);
    }
  }
  return out;
}

// ── Chromatic Aberration ────────────────────────────────────────────

/** Bilinear sample of ONE channel (0..3) with edge clamp. */
function sampleChannel(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  x: number,
  y: number,
  ch: number,
): number {
  const cx = Math.min(w - 1.001, Math.max(0, x));
  const cy = Math.min(h - 1.001, Math.max(0, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const fx = cx - x0;
  const fy = cy - y0;
  const o00 = (y0 * w + x0) * 4 + ch;
  const o10 = (y0 * w + Math.min(w - 1, x0 + 1)) * 4 + ch;
  const o01 = (Math.min(h - 1, y0 + 1) * w + x0) * 4 + ch;
  const o11 = (Math.min(h - 1, y0 + 1) * w + Math.min(w - 1, x0 + 1)) * 4 + ch;
  return (
    src[o00]! * (1 - fx) * (1 - fy) +
    src[o10]! * fx * (1 - fy) +
    src[o01]! * (1 - fx) * fy +
    src[o11]! * fx * fy
  );
}

/**
 * Chromatic Aberration — red and blue sampled from opposite displacements,
 * green (and alpha) untouched. Radial mode scales the shift with distance from
 * the centre, with `falloff` raising the exponent so the middle stays clean —
 * a lens fringes at its edges, not on the subject's nose.
 */
export function chromaticAberrationData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  amount: number,
  aberrationMode: number,
  angle: number,
  falloff: number,
  centerX: number,
  centerY: number,
): Uint8ClampedArray {
  const out = Uint8ClampedArray.from(src);
  if (amount <= 0) return out;
  const cx = w / 2 + centerX;
  const cy = h / 2 + centerY;
  const maxR = Math.max(1, Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy)));
  const linear = Math.round(aberrationMode) === 1;
  const la = angle * DEG;
  const lvx = Math.cos(la) * amount;
  const lvy = Math.sin(la) * amount;
  const exp = 1 + (falloff / 100) * 3;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let vx: number;
      let vy: number;
      if (linear) {
        vx = lvx;
        vy = lvy;
      } else {
        const dx = x - cx;
        const dy = y - cy;
        const r = Math.hypot(dx, dy);
        if (r < 1e-3) continue;
        const scale = (amount * Math.pow(r / maxR, exp)) / r;
        vx = dx * scale;
        vy = dy * scale;
      }
      const o = (y * w + x) * 4;
      out[o] = clamp255(sampleChannel(src, w, h, x - vx, y - vy, 0));
      out[o + 2] = clamp255(sampleChannel(src, w, h, x + vx, y + vy, 2));
      // Alpha widens to the union of the shifted channels so fringes at the
      // silhouette are not cut off by the original matte.
      const aShift = Math.max(
        sampleChannel(src, w, h, x - vx, y - vy, 3),
        sampleChannel(src, w, h, x + vx, y + vy, 3),
      );
      out[o + 3] = clamp255(Math.max(out[o + 3]!, aShift));
    }
  }
  return out;
}

// ── Hex Tile ────────────────────────────────────────────────────────

/**
 * CC HexTile — hexagonal mosaic: every pixel takes the colour of its hex
 * cell's centre. `border` darkens seams into a honeycomb.
 */
export function hexTileData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  radius: number,
  border: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  const R = Math.max(2, radius);
  const hexW = R * 1.5; // axial spacing (pointy-top hexes)
  const hexH = R * Math.sqrt(3);
  const bd = clamp01(border / 100);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Candidate centres of the two staggered columns around this pixel; the
      // nearest is the cell. Exact for a regular hex lattice.
      const col = Math.round(x / hexW);
      let best = Infinity;
      let bcx = 0;
      let bcy = 0;
      for (let dc = -1; dc <= 1; dc++) {
        const c = col + dc;
        const ccx = c * hexW;
        const off = (c % 2 === 0 ? 0 : hexH / 2);
        const row = Math.round((y - off) / hexH);
        for (let dr = -1; dr <= 1; dr++) {
          const ccy = (row + dr) * hexH + off;
          const d = (x - ccx) * (x - ccx) + (y - ccy) * (y - ccy);
          if (d < best) {
            best = d;
            bcx = ccx;
            bcy = ccy;
          }
        }
      }
      const sx = Math.min(w - 1, Math.max(0, Math.round(bcx)));
      const sy = Math.min(h - 1, Math.max(0, Math.round(bcy)));
      const so = (sy * w + sx) * 4;
      const o = (y * w + x) * 4;
      out[o] = src[so]!;
      out[o + 1] = src[so + 1]!;
      out[o + 2] = src[so + 2]!;
      out[o + 3] = src[so + 3]!;
      if (bd > 0) {
        // Seam shading: near the cell boundary (distance approaching R·√3/2).
        const d = Math.sqrt(best);
        const edge = clamp01((d - (hexH / 2 - Math.max(1, R * 0.12) - bd * R * 0.3)) / Math.max(1, R * 0.12));
        const shade = 1 - bd * edge;
        out[o] = clamp255(out[o]! * shade);
        out[o + 1] = clamp255(out[o + 1]! * shade);
        out[o + 2] = clamp255(out[o + 2]! * shade);
      }
    }
  }
  return out;
}

// ── Vector Blur ─────────────────────────────────────────────────────

/**
 * CC Vector Blur — smear each pixel ALONG the isophote (perpendicular to the
 * luminance gradient), which turns noise into combed streaks that follow form.
 * `angleOffset` rotates the flow (90° = across the edges = an edge-melting
 * blur); `smoothness` steadies the field first so streaks follow shapes rather
 * than grain.
 */
export function vectorBlurData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  amount: number,
  angleOffset: number,
  smoothness: number,
): Uint8ClampedArray {
  if (amount <= 0) return Uint8ClampedArray.from(src);
  const field = lumaField(src, w, h, smoothness);
  const out = new Uint8ClampedArray(src.length);
  const rot = angleOffset * DEG;
  const cosR = Math.cos(rot);
  const sinR = Math.sin(rot);
  const K = Math.max(2, Math.min(24, Math.round(amount)));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [gx, gy] = gradAt(field, w, h, x, y);
      const mag = Math.hypot(gx, gy);
      // Flow = gradient rotated 90°, then by the user's offset. In flat areas
      // there is no direction — leave the pixel untouched rather than smear it
      // in a fabricated one.
      let fx = 0;
      let fy = 0;
      if (mag > 1e-4) {
        const tx = -gy / mag;
        const ty = gx / mag;
        fx = tx * cosR - ty * sinR;
        fy = tx * sinR + ty * cosR;
      }
      const o = (y * w + x) * 4;
      if (fx === 0 && fy === 0) {
        out[o] = src[o]!;
        out[o + 1] = src[o + 1]!;
        out[o + 2] = src[o + 2]!;
        out[o + 3] = src[o + 3]!;
        continue;
      }
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let cnt = 0;
      const step = amount / K;
      for (let k = -K; k <= K; k++) {
        const sx = Math.round(x + fx * k * step);
        const sy = Math.round(y + fy * k * step);
        if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
        const so = (sy * w + sx) * 4;
        r += src[so]!;
        g += src[so + 1]!;
        b += src[so + 2]!;
        a += src[so + 3]!;
        cnt++;
      }
      if (cnt === 0) continue;
      out[o] = clamp255(r / cnt);
      out[o + 1] = clamp255(g / cnt);
      out[o + 2] = clamp255(b / cnt);
      out[o + 3] = clamp255(a / cnt);
    }
  }
  return out;
}
