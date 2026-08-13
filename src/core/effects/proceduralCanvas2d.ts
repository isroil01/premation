/**
 * Canvas2D fallbacks for the two most-used "GPU-only" generators — Gradient
 * Ramp and Fractal Noise. Until now these rendered as silent no-ops on the
 * default Canvas2D backend (the bread-and-butter AE looks, dead on arrival).
 *
 * Both composite with 'source-atop', so the generated pixels replace the
 * layer's content while respecting its alpha (masks, text glyphs, shapes).
 * Fractal noise renders octaved value-noise at reduced resolution and lets
 * the canvas upscale it — visually equivalent for noise, ~50× cheaper than
 * per-pixel work at comp size.
 */

import type { Effect } from './effects';
import { effectNumber, paramsOf } from './effects';

/**
 * The procedural generators, mapped to their draw functions.
 *
 * One table rather than a membership predicate beside a dispatch chain. These
 * used to be two separate `if` chains both hardcoding the same two type names,
 * the second with no `else`: a third generator added to the predicate but not
 * the dispatch would force every layer carrying it through the CPU bake and
 * then draw nothing — the same silent-fallthrough shape as
 * `COLOR_EFFECTS`/`effectToMatrix` and `LUT_EFFECTS`/`tableFor`.
 *
 * Low risk at two entries ten lines apart, which is exactly why it was cheap to
 * fix now rather than after it grew.
 *
 * Declared AFTER the functions it names — `function` declarations hoist, so the
 * initialiser sees them; an arrow-function refactor here would not.
 */
const PROCEDURAL: ReadonlyMap<
  string,
  (oc: CanvasRenderingContext2D, w: number, h: number, e: Effect) => void
> = new Map([
  ['gradient-ramp', applyGradientRamp],
  ['fractal-noise', applyFractalNoise],
]);

export function isCanvas2dProcedural(type: string): boolean {
  return PROCEDURAL.has(type);
}

export function applyProceduralEffect(
  oc: CanvasRenderingContext2D,
  w: number,
  h: number,
  e: Effect,
): void {
  PROCEDURAL.get(e.type)?.(oc, w, h, e);
}

function applyGradientRamp(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const params = paramsOf(e);
  const blend = effectNumber(e, 'blend');
  const colorA = typeof params.colorA === 'string' ? params.colorA : '#ff0000';
  const colorB = typeof params.colorB === 'string' ? params.colorB : '#0000ff';
  // Angle in degrees, 0 = left→right, 90 = top→bottom (the previous fixed
  // behaviour, so an existing ramp with no angle renders identically).
  const angle = typeof params.angle === 'number' ? params.angle : 90;
  const rad = (angle * Math.PI) / 180;
  // Project the box onto the axis so the ramp spans it fully at any angle,
  // rather than being clipped at the corners.
  const cx = w / 2;
  const cy = h / 2;
  const half = (Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad))) / 2;
  const grad = oc.createLinearGradient(
    cx - Math.cos(rad) * half,
    cy - Math.sin(rad) * half,
    cx + Math.cos(rad) * half,
    cy + Math.sin(rad) * half,
  );
  grad.addColorStop(0, colorA);
  grad.addColorStop(1, colorB);
  oc.save();
  oc.setTransform(1, 0, 0, 1, 0, 0);
  oc.globalCompositeOperation = 'source-atop';
  oc.globalAlpha = Math.max(0, Math.min(1, blend / 100));
  oc.fillStyle = grad;
  oc.fillRect(0, 0, w, h);
  oc.restore();
}

// ── Value noise (deterministic, seed-free) ───────────────────────────

/** Integer lattice hash → [0, 1). Deterministic, so frames don't flicker. */
function hash2(x: number, y: number): number {
  let n = (x | 0) * 374761393 + (y | 0) * 668265263;
  n = (n ^ (n >>> 13)) * 1274126177;
  n = n ^ (n >>> 16);
  return (n >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Bilinear-interpolated value noise at (x, y) for one octave. */
function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = smooth(x - xi);
  const fy = smooth(y - yi);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** 4-octave fractal (fBm) value noise in [0, 1]. */
function fbm(x: number, y: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let o = 0; o < 4; o++) {
    sum += valueNoise(x * freq, y * freq) * amp;
    freq *= 2;
    amp *= 0.5;
  }
  return sum / 0.9375; // normalize (0.5+0.25+0.125+0.0625)
}

/** Reusable low-res noise canvas so playback doesn't allocate per frame. */
let noiseCanvas: HTMLCanvasElement | null = null;

function applyFractalNoise(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const scale = Math.max(1, effectNumber(e, 'scale'));
  // Noise has no high-frequency edges worth full resolution — render small,
  // let drawImage's bilinear upscale smooth it.
  const LONG = 256;
  const nw = w >= h ? LONG : Math.max(8, Math.round((w / h) * LONG));
  const nh = w >= h ? Math.max(8, Math.round((h / w) * LONG)) : LONG;

  if (!noiseCanvas) noiseCanvas = document.createElement('canvas');
  if (noiseCanvas.width !== nw || noiseCanvas.height !== nh) {
    noiseCanvas.width = nw;
    noiseCanvas.height = nh;
  }
  const nc = noiseCanvas.getContext('2d');
  if (!nc) return;

  const img = nc.createImageData(nw, nh);
  const data = img.data;
  // `scale` = feature count across the long edge (matches the GPU look).
  const freq = scale / LONG;
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const v = Math.round(fbm(x * freq, y * freq) * 255);
      const i = (y * nw + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  nc.putImageData(img, 0, 0);

  oc.save();
  oc.setTransform(1, 0, 0, 1, 0, 0);
  oc.globalCompositeOperation = 'source-atop';
  oc.imageSmoothingEnabled = true;
  oc.drawImage(noiseCanvas, 0, 0, nw, nh, 0, 0, w, h);
  oc.restore();
}
