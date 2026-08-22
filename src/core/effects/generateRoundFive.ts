/**
 * Generate, round five — Star Burst, Snowfall, Rainfall, Write-on, Light Burst.
 *
 * All pure `Uint8ClampedArray` transforms, like the round-four generators. The
 * particle effects (stars, snow, rain) are deterministic hashes of
 * (seed, particle index): a particle's whole trajectory is a closed-form
 * function of the KEYFRAMED `phase`/`evolution` param, never of the clock, so
 * scrubbing to a frame always reproduces the same weather. That is also AE's
 * own contract for Evolution, and it is what keeps these out of
 * `TIME_DEPENDENT` (the Strobe Light rule — see aeStylizeAdvanced.ts).
 */

import { clamp01, clamp255, luma } from './colorSpace';

/** Deterministic 0..1 hash of two integers (same recipe as aeStylizeAdvanced). */
function hash2(a: number, b: number): number {
  let n = (a * 374761393 + b * 668265263) | 0;
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/** Positive-only fract that survives negative inputs (particle wrap). */
function fract(v: number): number {
  return v - Math.floor(v);
}

/** Source-over a disc of colour (r,g,b) at (cx,cy), radius rad, peak alpha a01. */
function stampDisc(
  out: Uint8ClampedArray,
  w: number,
  h: number,
  cx: number,
  cy: number,
  rad: number,
  r: number,
  g: number,
  b: number,
  a01: number,
): void {
  const x0 = Math.max(0, Math.floor(cx - rad));
  const x1 = Math.min(w - 1, Math.ceil(cx + rad));
  const y0 = Math.max(0, Math.floor(cy - rad));
  const y1 = Math.min(h - 1, Math.ceil(cy + rad));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d > rad) continue;
      // Soft-edged disc: full alpha to 60% of the radius, cosine falloff after.
      const t = d / Math.max(1e-6, rad);
      const cover = t < 0.6 ? 1 : 0.5 + 0.5 * Math.cos(((t - 0.6) / 0.4) * Math.PI);
      const sa = clamp01(a01 * cover);
      if (sa <= 0) continue;
      const o = (y * w + x) * 4;
      const da = out[o + 3]! / 255;
      const oa = sa + da * (1 - sa);
      if (oa <= 0) continue;
      out[o] = clamp255((r * sa + out[o]! * da * (1 - sa)) / oa);
      out[o + 1] = clamp255((g * sa + out[o + 1]! * da * (1 - sa)) / oa);
      out[o + 2] = clamp255((b * sa + out[o + 2]! * da * (1 - sa)) / oa);
      out[o + 3] = clamp255(oa * 255);
    }
  }
}

/**
 * Additive star glint: a hot gaussian core plus four diffraction spikes along
 * the axes and four fainter diagonal ones — the shape a bright point takes
 * through real lens iris blades, and what AE's Star Burst reads as. A plain
 * disc here reads as confetti, not stars.
 */
function stampStar(
  out: Uint8ClampedArray,
  w: number,
  h: number,
  cx: number,
  cy: number,
  size: number,
  r: number,
  g: number,
  b: number,
  a01: number,
): void {
  const core = Math.max(0.5, size * 0.5);
  const spikeLen = size * 4;
  const spikeW = Math.max(0.4, size * 0.22);
  const reach = Math.ceil(spikeLen);
  const x0 = Math.max(0, Math.floor(cx - reach));
  const x1 = Math.min(w - 1, Math.ceil(cx + reach));
  const y0 = Math.max(0, Math.floor(cy - reach));
  const y1 = Math.min(h - 1, Math.ceil(cy + reach));
  const INV_SQRT2 = Math.SQRT1_2;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d2 = dx * dx + dy * dy;
      // Core: gaussian hot spot.
      let i = Math.exp(-d2 / (core * core));
      // Axis spikes: tight across, long along, tapering to the tips.
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      i += 0.85 * Math.exp(-(ay * ay) / (spikeW * spikeW)) * Math.max(0, 1 - ax / spikeLen) ** 2;
      i += 0.85 * Math.exp(-(ax * ax) / (spikeW * spikeW)) * Math.max(0, 1 - ay / spikeLen) ** 2;
      // Diagonal spikes: half the length, fainter.
      const du = Math.abs(dx * INV_SQRT2 + dy * INV_SQRT2);
      const dv = Math.abs(-dx * INV_SQRT2 + dy * INV_SQRT2);
      i += 0.35 * Math.exp(-(dv * dv) / (spikeW * spikeW)) * Math.max(0, 1 - du / (spikeLen * 0.5)) ** 2;
      i += 0.35 * Math.exp(-(du * du) / (spikeW * spikeW)) * Math.max(0, 1 - dv / (spikeLen * 0.5)) ** 2;
      const s = clamp01(i * a01);
      if (s <= 0.003) continue;
      const o = (y * w + x) * 4;
      // Additive (screen-ish): stars are light sources, they never darken.
      out[o] = clamp255(out[o]! + r * s);
      out[o + 1] = clamp255(out[o + 1]! + g * s);
      out[o + 2] = clamp255(out[o + 2]! + b * s);
      out[o + 3] = clamp255(Math.max(out[o + 3]!, s * 255));
    }
  }
}

// ── Star Burst ──────────────────────────────────────────────────────

/**
 * CC Star Burst — the layer scattered into a starfield being flown through.
 *
 * Each star's colour is SAMPLED from the layer at the star's home position, so
 * a red frame yields a red field — that sampling is what makes this Star Burst
 * rather than a random starfield, and it is the behaviour CC ships. `blend`
 * mixes the original picture back (blend 100 = untouched layer).
 */
export function starBurstData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  phase: number,
  amount: number,
  size: number,
  starRgb: [number, number, number],
  blend: number,
  seed: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  const n = Math.round(clamp01(amount / 100) * 400);
  const cx = w / 2;
  const cy = h / 2;
  const maxR = Math.hypot(cx, cy);
  const s = Math.floor(seed);
  for (let i = 0; i < n; i++) {
    const ang = hash2(i, s) * Math.PI * 2;
    const speed = 0.25 + 0.75 * hash2(i, s + 101);
    const z0 = hash2(i, s + 202);
    // Flight: t grows with phase, accelerating outward as a real fly-through
    // does (constant world speed reads as acceleration in the picture plane).
    const t = fract(phase / 1000 * speed + z0);
    const rad = t * t * maxR;
    const px = cx + Math.cos(ang) * rad;
    const py = cy + Math.sin(ang) * rad;
    if (px < -4 || px > w + 4 || py < -4 || py > h + 4) continue;
    // Star colour: the layer's pixel at the star's HOME (angle) position,
    // pulled toward the tint. Transparent source pixels still yield a star.
    const hx = Math.min(w - 1, Math.max(0, Math.round(cx + Math.cos(ang) * maxR * 0.5)));
    const hy = Math.min(h - 1, Math.max(0, Math.round(cy + Math.sin(ang) * maxR * 0.5)));
    const ho = (hy * w + hx) * 4;
    const mixT = src[ho + 3]! > 8 ? 0.5 : 1;
    const r = src[ho]! * (1 - mixT) + starRgb[0] * mixT;
    const g = src[ho + 1]! * (1 - mixT) + starRgb[1] * mixT;
    const b = src[ho + 2]! * (1 - mixT) + starRgb[2] * mixT;
    stampStar(out, w, h, px, py, Math.max(0.5, size) * (0.4 + 0.6 * t), r, g, b, 0.25 + 0.75 * t);
  }
  // Blend the original back over/under: out = lerp(stars, src, blend).
  const k = clamp01(blend / 100);
  if (k > 0) {
    for (let i = 0; i < out.length; i += 4) {
      const sa = src[i + 3]! / 255;
      const da = out[i + 3]! / 255;
      const a = sa * k + da * (1 - k);
      if (a > 0) {
        out[i] = clamp255((src[i]! * sa * k + out[i]! * da * (1 - k)) / a);
        out[i + 1] = clamp255((src[i + 1]! * sa * k + out[i + 1]! * da * (1 - k)) / a);
        out[i + 2] = clamp255((src[i + 2]! * sa * k + out[i + 2]! * da * (1 - k)) / a);
      }
      out[i + 3] = clamp255(a * 255);
    }
  }
  return out;
}

// ── Snowfall ────────────────────────────────────────────────────────

/** CC Snowfall — flakes composited OVER the layer; motion = keyframe `evolution`. */
export function snowfallData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  amount: number,
  size: number,
  evolution: number,
  wind: number,
  opacity: number,
  flakeRgb: [number, number, number],
  seed: number,
): Uint8ClampedArray {
  const out = Uint8ClampedArray.from(src);
  const n = Math.round(clamp01(amount / 100) * Math.max(1, (w * h) / 1200));
  const s = Math.floor(seed);
  const a01 = clamp01(opacity / 100);
  for (let i = 0; i < n; i++) {
    const fx0 = hash2(i, s) * w;
    const fy0 = hash2(i, s + 11) * h;
    const speed = 0.4 + 0.8 * hash2(i, s + 23);
    const swayAmp = 2 + 8 * hash2(i, s + 37);
    // evolution 100 ≈ one full screen height for an average flake.
    const drop = (evolution / 100) * h * speed;
    const sway = Math.sin(evolution / 40 + i * 1.7) * swayAmp;
    const drift = (wind / 100) * drop * 0.4;
    const px = ((fx0 + sway + drift) % w + w) % w;
    const py = (fy0 + drop) % (h + 8) - 4;
    const rad = Math.max(0.5, size) * (0.55 + 0.45 * hash2(i, s + 51));
    stampDisc(out, w, h, px, py, rad, flakeRgb[0], flakeRgb[1], flakeRgb[2], a01 * (0.6 + 0.4 * speed));
  }
  return out;
}

// ── Rainfall ────────────────────────────────────────────────────────

/** CC Rainfall — streaks at `angle`, advanced by `evolution`, over the layer. */
export function rainfallData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  amount: number,
  length: number,
  angle: number,
  evolution: number,
  opacity: number,
  rainRgb: [number, number, number],
  seed: number,
): Uint8ClampedArray {
  const out = Uint8ClampedArray.from(src);
  const n = Math.round(clamp01(amount / 100) * Math.max(1, (w * h) / 2500));
  const s = Math.floor(seed);
  const rad = (angle * Math.PI) / 180;
  const dirX = Math.sin(rad);
  const dirY = Math.cos(rad); // 0° = straight down
  const a01 = clamp01(opacity / 100);
  const len = Math.max(2, length);
  for (let i = 0; i < n; i++) {
    const fx0 = hash2(i, s) * w;
    const fy0 = hash2(i, s + 11) * h;
    const speed = 0.8 + 0.6 * hash2(i, s + 23);
    // Rain is fast: evolution 100 ≈ three screen heights.
    const travel = (evolution / 100) * h * 3 * speed;
    const px0 = ((fx0 + dirX * travel) % w + w) % w;
    const py0 = (fy0 + dirY * travel) % (h + len) - len / 2;
    // The streak: alpha ramps toward the head so drops read as falling, not
    // as static scratches.
    const steps = Math.ceil(len);
    for (let k = 0; k < steps; k++) {
      const x = Math.round(px0 - dirX * k);
      const y = Math.round(py0 - dirY * k);
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      const sa = a01 * (1 - k / steps) * 0.9;
      const o = (y * w + x) * 4;
      const da = out[o + 3]! / 255;
      const oa = sa + da * (1 - sa);
      if (oa <= 0) continue;
      out[o] = clamp255((rainRgb[0] * sa + out[o]! * da * (1 - sa)) / oa);
      out[o + 1] = clamp255((rainRgb[1] * sa + out[o + 1]! * da * (1 - sa)) / oa);
      out[o + 2] = clamp255((rainRgb[2] * sa + out[o + 2]! * da * (1 - sa)) / oa);
      out[o + 3] = clamp255(oa * 255);
    }
  }
  return out;
}

// ── Write-on ────────────────────────────────────────────────────────

/**
 * Write-on — a stroke revealed from Start toward End by `completion`.
 *
 * The wobble is a fixed pair of sine harmonics of arc position — deterministic,
 * so the path never changes shape as completion animates; the reveal only ever
 * extends it. Taper thins the leading tip so the growing end reads as a pen
 * lift rather than a blunt bar.
 */
export function writeOnData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  completion: number,
  brushSize: number,
  brushRgb: [number, number, number],
  wobble: number,
  taper: number,
): Uint8ClampedArray {
  const out = Uint8ClampedArray.from(src);
  const t1 = clamp01(completion / 100);
  if (t1 <= 0) return out;
  const sx = w / 2 + startX;
  const sy = h / 2 + startY;
  const ex = w / 2 + endX;
  const ey = h / 2 + endY;
  const dx = ex - sx;
  const dy = ey - sy;
  const len = Math.hypot(dx, dy);
  if (len < 1e-3) return out;
  const nx = -dy / len;
  const ny = dx / len;
  const amp = (wobble / 100) * len * 0.12;
  const radius = Math.max(0.5, brushSize / 2);
  const steps = Math.max(2, Math.ceil((len * t1) / Math.max(1, radius * 0.5)));
  for (let k = 0; k <= steps; k++) {
    const t = (k / steps) * t1;
    const bend = amp * (Math.sin(t * Math.PI * 3.1) * 0.7 + Math.sin(t * Math.PI * 7.3) * 0.3);
    const px = sx + dx * t + nx * bend;
    const py = sy + dy * t + ny * bend;
    // Taper: thin the leading `taper`% of the DRAWN length toward a point.
    const tipSpan = Math.max(1e-6, (taper / 100) * t1);
    const fromTip = (t1 - t) / tipSpan;
    const thin = taper > 0 && fromTip < 1 ? 0.25 + 0.75 * fromTip : 1;
    stampDisc(out, w, h, px, py, radius * thin, brushRgb[0], brushRgb[1], brushRgb[2], 1);
  }
  return out;
}

// ── Light Burst ─────────────────────────────────────────────────────

/**
 * CC Light Burst 2.5 — radial zoom rays. Every pixel accumulates samples taken
 * FROM ITSELF TOWARD THE CENTRE, which streaks bright content outward, and the
 * streaks are screened over the source. Intensity scales only the streaks, so
 * 0 is exactly the untouched layer.
 */
export function lightBurstData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  centerX: number,
  centerY: number,
  intensity: number,
  rayLength: number,
): Uint8ClampedArray {
  const out = Uint8ClampedArray.from(src);
  const gain = Math.max(0, intensity / 100);
  const reach = clamp01(rayLength / 100);
  if (gain <= 0 || reach <= 0) return out;
  const cx = w / 2 + centerX;
  const cy = h / 2 + centerY;
  const SAMPLES = 24;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      let ar = 0;
      let ag = 0;
      let ab = 0;
      let aa = 0;
      let wsum = 0;
      for (let k = 1; k <= SAMPLES; k++) {
        const t = (k / SAMPLES) * reach;
        const sx = Math.round(x + (cx - x) * t);
        const sy = Math.round(y + (cy - y) * t);
        if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
        const so = (sy * w + sx) * 4;
        const wk = 1 - k / (SAMPLES + 1); // near samples dominate
        const a = src[so + 3]! / 255;
        ar += src[so]! * a * wk;
        ag += src[so + 1]! * a * wk;
        ab += src[so + 2]! * a * wk;
        aa += a * wk;
        wsum += wk;
      }
      if (wsum <= 0) continue;
      // Only genuinely bright content should streak — weight by the ray's luma.
      const rr = ar / wsum;
      const rg = ag / wsum;
      const rb = ab / wsum;
      const boost = gain * clamp01(luma(rr, rg, rb) / 255);
      if (boost <= 0) continue;
      // Screen: out = 1 - (1-out)(1-ray·boost).
      out[o] = clamp255(255 - (255 - out[o]!) * (255 - clamp255(rr * boost)) / 255);
      out[o + 1] = clamp255(255 - (255 - out[o + 1]!) * (255 - clamp255(rg * boost)) / 255);
      out[o + 2] = clamp255(255 - (255 - out[o + 2]!) * (255 - clamp255(rb * boost)) / 255);
      // Streaks can extend the silhouette: alpha grows to carry them, never shrinks.
      out[o + 3] = clamp255(Math.max(out[o + 3]!, clamp01((aa / wsum) * boost) * 255));
    }
  }
  return out;
}
