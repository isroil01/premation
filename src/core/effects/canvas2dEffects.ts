/**
 * Canvas2D-only generator / pixel-pass effects — the AE "Generate" and
 * "Blur & Sharpen"/"Noise & Grain" families the GPU backend has no shader for.
 *
 * Every effect here is a PURE function of its params and the layer's native-size
 * offscreen buffer (`oc`, transform already reset to identity, 0..w × 0..h). No
 * wall-clock time: motion comes from keyframing a param (Beam `length`, Noise
 * `evolution`), exactly as in After Effects. That keeps them deterministic and
 * scrub-stable, and lets `bakeEffectChain` interleave them with CSS/LUT/matrix
 * passes in stack order.
 *
 * They have no CSS-filter form and no GPU shader, so `capabilities.ts` reports
 * them as Canvas2D-only — a WebGL2 export warns rather than silently dropping
 * them (see `canvas2dEffects` capability dimension).
 */

import type { Effect } from './effects';
import { effectNumber, paramsOf } from './effects';
import { applyKeyData, chokeAlpha, softenAlpha } from './keylight';
import { waveWarpData, turbulentDisplaceData } from './warp';

/** Effects implemented only by the Canvas2D backend, with no GPU shader form.
 *  (Distinct from `isCanvas2dProcedural`, whose two members ALSO have GPU
 *  shaders — gradient-ramp / fractal-noise render on both backends.) */
const CANVAS2D_ONLY = new Set<string>([
  'fill',
  'four-color-gradient',
  'stroke',
  'beam',
  'sharpen',
  'noise',
  'keylight',
  'wave-warp',
  'turbulent-displace',
]);

export function isCanvas2dOnlyEffect(type: string): boolean {
  return CANVAS2D_ONLY.has(type);
}

export function applyCanvas2dEffect(
  oc: CanvasRenderingContext2D,
  w: number,
  h: number,
  e: Effect,
): void {
  switch (e.type) {
    case 'fill':
      return applyFill(oc, w, h, e);
    case 'four-color-gradient':
      return applyFourColorGradient(oc, w, h, e);
    case 'stroke':
      return applyStroke(oc, w, h, e);
    case 'beam':
      return applyBeam(oc, w, h, e);
    case 'sharpen':
      return applySharpen(oc, w, h, e);
    case 'noise':
      return applyNoise(oc, w, h, e);
    case 'keylight':
      return applyKeylight(oc, w, h, e);
    case 'wave-warp':
      return applyWaveWarp(oc, w, h, e);
    case 'turbulent-displace':
      return applyTurbulentDisplace(oc, w, h, e);
  }
}

// ── Wave Warp / Turbulent Displace: backward-mapped distortions (warp.ts) ──

function applyWaveWarp(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const height = effectNumber(e, 'waveHeight');
  if (height === 0) return;
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  const out = waveWarpData(
    img.data, w, h,
    height,
    Math.max(2, effectNumber(e, 'waveWidth')),
    effectNumber(e, 'direction'),
    effectNumber(e, 'phase'),
  );
  img.data.set(out);
  oc.putImageData(img, 0, 0);
}

function applyTurbulentDisplace(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const amount = effectNumber(e, 'amount');
  if (amount === 0) return;
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  const out = turbulentDisplaceData(
    img.data, w, h,
    amount,
    Math.max(4, effectNumber(e, 'size')),
    effectNumber(e, 'complexity'),
    effectNumber(e, 'evolution'),
  );
  img.data.set(out);
  oc.putImageData(img, 0, 0);
}

// ── helpers ──────────────────────────────────────────────────────────

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);
const str = (e: Effect, k: string, fb: string): string => {
  const v = paramsOf(e)[k];
  return typeof v === 'string' ? v : fb;
};
const bool = (e: Effect, k: string, fb: boolean): boolean => {
  const v = paramsOf(e)[k];
  return typeof v === 'boolean' ? v : fb;
};

/** `#rrggbb` (or `#rgb`) → [r,g,b] 0..255. Non-hex → mid-grey. */
export function parseHex(hex: string): [number, number, number] {
  const s = hex.trim();
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) {
    const n = parseInt(m[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) {
    const t = m[1]!;
    const r = parseInt(t[0]! + t[0]!, 16);
    const g = parseInt(t[1]! + t[1]!, 16);
    const b = parseInt(t[2]! + t[2]!, 16);
    return [r, g, b];
  }
  return [128, 128, 128];
}

/** A scratch canvas pool keyed by role, so playback doesn't allocate per frame. */
const pool: Record<string, HTMLCanvasElement | undefined> = {};
function scratch(role: string, w: number, h: number): HTMLCanvasElement | null {
  let c = pool[role];
  if (!c) {
    c = document.createElement('canvas');
    pool[role] = c;
  }
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  return c;
}

// ── Fill: recolor the layer's content to a solid colour (respects alpha) ──

function applyFill(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const color = str(e, 'color', '#ffffff');
  const opacity = clamp01(effectNumber(e, 'opacity') / 100);
  if (opacity <= 0) return;
  oc.save();
  oc.setTransform(1, 0, 0, 1, 0, 0);
  oc.globalCompositeOperation = 'source-atop';
  oc.globalAlpha = opacity;
  oc.fillStyle = color;
  oc.fillRect(0, 0, w, h);
  oc.restore();
}

// ── 4-Colour Gradient: bilinear blend of the four corner colours ──

function applyFourColorGradient(
  oc: CanvasRenderingContext2D,
  w: number,
  h: number,
  e: Effect,
): void {
  const blend = clamp01(effectNumber(e, 'blend') / 100);
  if (blend <= 0) return;
  const tl = parseHex(str(e, 'colorTL', '#ff0000'));
  const tr = parseHex(str(e, 'colorTR', '#00ff00'));
  const bl = parseHex(str(e, 'colorBL', '#0000ff'));
  const br = parseHex(str(e, 'colorBR', '#ffff00'));

  // A 2×2 image of the corners, upscaled with bilinear smoothing, IS the exact
  // bilinear interpolation of the four colours — cheaper and precise.
  const grad = scratch('4cg', 2, 2);
  if (!grad) return;
  const gc = grad.getContext('2d');
  if (!gc) return;
  const img = gc.createImageData(2, 2);
  const d = img.data;
  const put = (i: number, c: [number, number, number]) => {
    d[i] = c[0];
    d[i + 1] = c[1];
    d[i + 2] = c[2];
    d[i + 3] = 255;
  };
  put(0, tl);
  put(4, tr);
  put(8, bl);
  put(12, br);
  gc.putImageData(img, 0, 0);

  oc.save();
  oc.setTransform(1, 0, 0, 1, 0, 0);
  oc.globalCompositeOperation = 'source-atop';
  oc.globalAlpha = blend;
  oc.imageSmoothingEnabled = true;
  // Stretch the inner unit square (between the four texel centres at 0.5,0.5 →
  // 1.5,1.5) across the whole box: bilinear sampling then makes each output
  // corner read exactly one source corner colour, blending linearly between.
  oc.drawImage(grad, 0.5, 0.5, 1, 1, 0, 0, w, h);
  oc.restore();
}

// ── Stroke: a coloured outline around the layer content's alpha silhouette ──

function applyStroke(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const width = Math.max(0, effectNumber(e, 'width'));
  const opacity = clamp01(effectNumber(e, 'opacity') / 100);
  if (width <= 0 || opacity <= 0) return;
  const color = str(e, 'color', '#ffffff');

  // Snapshot current content (the silhouette we outline).
  const snap = scratch('stroke-snap', w, h);
  if (!snap) return;
  const sc = snap.getContext('2d');
  if (!sc) return;
  sc.setTransform(1, 0, 0, 1, 0, 0);
  sc.clearRect(0, 0, w, h);
  sc.drawImage(oc.canvas, 0, 0);

  // Dilate the silhouette by drawing the snapshot at ring offsets, then tint it
  // the stroke colour via source-in, then subtract the original interior — what
  // remains is a ring `width` px wide outside the content edge.
  const ring = scratch('stroke-ring', w, h);
  if (!ring) return;
  const rc = ring.getContext('2d');
  if (!rc) return;
  rc.setTransform(1, 0, 0, 1, 0, 0);
  rc.clearRect(0, 0, w, h);
  rc.globalCompositeOperation = 'source-over';
  const STEPS = 32;
  for (let i = 0; i < STEPS; i++) {
    const a = (i / STEPS) * Math.PI * 2;
    rc.drawImage(snap, Math.cos(a) * width, Math.sin(a) * width);
  }
  rc.globalCompositeOperation = 'source-in';
  rc.fillStyle = color;
  rc.fillRect(0, 0, w, h);
  rc.globalCompositeOperation = 'destination-out';
  rc.drawImage(snap, 0, 0);

  // Composite the ring BEHIND the content so the content stays crisp on top.
  oc.save();
  oc.setTransform(1, 0, 0, 1, 0, 0);
  oc.globalCompositeOperation = 'destination-over';
  oc.globalAlpha = opacity;
  oc.drawImage(ring, 0, 0);
  oc.restore();
}

// ── Beam: an animated light beam (keyframe `length` to fire it) ──

function applyBeam(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const sx = (effectNumber(e, 'startX') / 100) * w;
  const sy = (effectNumber(e, 'startY') / 100) * h;
  const ex = (effectNumber(e, 'endX') / 100) * w;
  const ey = (effectNumber(e, 'endY') / 100) * h;
  const length = clamp01(effectNumber(e, 'length') / 100);
  const thickness = Math.max(0.5, effectNumber(e, 'thickness'));
  const softness = clamp01(effectNumber(e, 'softness') / 100);
  const color = str(e, 'color', '#ffffff');
  if (length <= 0) return;

  // AE's Beam sweeps from start toward end as Time (here `length`) grows, with a
  // leading and trailing head so it reads as a travelling pulse.
  const hx = sx + (ex - sx) * length;
  const hy = sy + (ey - sy) * length;
  const tailLen = 0.35; // fraction of the full path the tail trails behind the head
  const t0 = Math.max(0, length - tailLen);
  const tx = sx + (ex - sx) * t0;
  const ty = sy + (ey - sy) * t0;

  oc.save();
  oc.setTransform(1, 0, 0, 1, 0, 0);
  oc.globalCompositeOperation = 'lighter'; // additive glow — a beam adds light
  const grad = oc.createLinearGradient(tx, ty, hx, hy);
  grad.addColorStop(0, withA(color, 0));
  grad.addColorStop(1, withA(color, 1));
  oc.strokeStyle = grad;
  oc.lineCap = 'round';
  // A soft outer pass + a bright core.
  oc.lineWidth = thickness * (1 + softness * 3);
  oc.globalAlpha = 0.35;
  oc.beginPath();
  oc.moveTo(tx, ty);
  oc.lineTo(hx, hy);
  oc.stroke();
  oc.lineWidth = thickness;
  oc.globalAlpha = 1;
  oc.beginPath();
  oc.moveTo(tx, ty);
  oc.lineTo(hx, hy);
  oc.stroke();
  oc.restore();
}

function withA(hex: string, a: number): string {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r},${g},${b},${clamp01(a)})`;
}

// ── Sharpen: a 3×3 unsharp convolution (RGB; alpha untouched) ──

function applySharpen(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const amount = effectNumber(e, 'amount') / 100;
  if (amount <= 0) return;
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  const out = sharpenData(img.data, w, h, amount);
  img.data.set(out);
  oc.putImageData(img, 0, 0);
}

/** Pure 3×3 sharpen kernel over RGBA (alpha preserved), clamped edges. Exported
 *  for unit tests (no canvas needed). Center `1+4k`, 4-neighbours `-k`. */
export function sharpenData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  amount: number,
): Uint8ClampedArray {
  const k = amount;
  const out = new Uint8ClampedArray(data);
  const at = (x: number, y: number, c: number): number => {
    const cx = x < 0 ? 0 : x >= w ? w - 1 : x;
    const cy = y < 0 ? 0 : y >= h ? h - 1 : y;
    return data[(cy * w + cx) * 4 + c]!;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] === 0) continue; // don't invent colour in transparent pixels
      for (let c = 0; c < 3; c++) {
        const v =
          (1 + 4 * k) * at(x, y, c) -
          k * (at(x - 1, y, c) + at(x + 1, y, c) + at(x, y - 1, c) + at(x, y + 1, c));
        out[i + c] = clamp255(v);
      }
    }
  }
  return out;
}

// ── Noise & Grain: per-pixel additive noise (deterministic; keyframe evolution) ──

function applyNoise(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const amount = effectNumber(e, 'amount') / 100;
  if (amount <= 0) return;
  const evolution = Math.round(effectNumber(e, 'evolution'));
  const mono = bool(e, 'monochrome', true);
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  addNoiseData(img.data, w, amount, evolution, mono);
  oc.putImageData(img, 0, 0);
}

/** Integer hash → [-1, 1). Deterministic per (x,y,seed,channel). */
function noiseHash(x: number, y: number, seed: number, ch: number): number {
  let n = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 2147483647 + ch * 40503;
  n = (n ^ (n >>> 13)) * 1274126177;
  n = n ^ (n >>> 16);
  return ((n >>> 0) / 4294967296) * 2 - 1;
}

// ── Keylight: chroma key (writes alpha + despills RGB) ──

function applyKeylight(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  applyKeyData(img.data, {
    screenColor: str(e, 'screenColor', '#00ff00'),
    balance: effectNumber(e, 'balance') / 100,
    gain: effectNumber(e, 'gain') / 100,
    clipBlack: effectNumber(e, 'clipBlack') / 100,
    clipWhite: effectNumber(e, 'clipWhite') / 100,
    despill: effectNumber(e, 'despill') / 100,
  });
  // Matte refinement, AE order: shrink/grow the matte, then feather it.
  chokeAlpha(img.data, w, h, effectNumber(e, 'choke'));
  softenAlpha(img.data, w, h, effectNumber(e, 'matteSoftness'));
  oc.putImageData(img, 0, 0);
}

/** Pure additive noise over RGBA in place (alpha preserved). Exported for tests.
 *  `amount` 0..1 scales to ±amount·255. Monochrome adds the same delta to RGB. */
export function addNoiseData(
  data: Uint8ClampedArray,
  w: number,
  amount: number,
  evolution: number,
  mono: boolean,
): void {
  const strength = amount * 255;
  const h = data.length / 4 / w;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] === 0) continue;
      if (mono) {
        const n = noiseHash(x, y, evolution, 0) * strength;
        data[i] = clamp255(data[i]! + n);
        data[i + 1] = clamp255(data[i + 1]! + n);
        data[i + 2] = clamp255(data[i + 2]! + n);
      } else {
        data[i] = clamp255(data[i]! + noiseHash(x, y, evolution, 0) * strength);
        data[i + 1] = clamp255(data[i + 1]! + noiseHash(x, y, evolution, 1) * strength);
        data[i + 2] = clamp255(data[i + 2]! + noiseHash(x, y, evolution, 2) * strength);
      }
    }
  }
}
