/**
 * Canvas2D-only generator / pixel-pass effects — the AE "Generate" and style
 * families the GPU backend has no shader for.
 *
 * Every effect here is a PURE function of its params and the layer's native-size
 * offscreen buffer (`oc`, transform already reset to identity, 0..w × 0..h). No
 * wall-clock time: motion comes from keyframing a param (Beam `length`, Noise
 * `evolution`), exactly as in After Effects. That keeps them deterministic and
 * scrub-stable, and lets `bakeEffectChain` interleave them with CSS/LUT/matrix
 * passes in stack order.
 *
 * Two DIFFERENT questions get asked about this module, and conflating them cost
 * Fill / Stroke / Sharpen / Noise every pixel they were supposed to draw:
 *
 *   • "Does this effect FORCE a CPU bake?" — `isCanvas2dOnlyEffect`. True only
 *     when the GPU has no shader for it at all.
 *   • "Can the bake chain DRAW this effect?" — `hasCanvas2dImplementation`.
 *     True for everything with a `case` in `applyCanvas2dEffect` below.
 *
 * Fill / Stroke / Sharpen / Noise gained GPU materials in CompositionPass, so
 * they no longer answer YES to the first — a layer carrying only those stays on
 * the cheap GPU path instead of paying for a canvas round-trip. But they still
 * answer YES to the second, because a layer baked for some OTHER reason (an
 * interior style, a warp) has its GPU effect list dropped wholesale, and the
 * bake is then the only chance those four get to render.
 *
 * Collapsing the two into one predicate made them fall through both routes and
 * silently draw nothing on any layer that also had an interior style — which is
 * exactly how a Color Overlay or Stroke layer style disappeared the moment an
 * Inner Shadow was switched on.
 */

import type { Effect } from './effects';
import { effectNumber, paramsOf } from './effects';
import { applyKeyData, chokeAlpha, softenAlpha } from './keylight';
import { waveWarpData, turbulentDisplaceData } from './warp';
import { blurRgba, radialBlurData, blurDimensions } from './blurs';
import { mosaicData, findEdgesData, roughenEdgesData } from './stylize';
import { vibranceData, coloramaData, COLORAMA_PALETTES } from './colorEffects';

/** Effects implemented only by the Canvas2D backend, with no GPU shader form.
 *  (Distinct from `isCanvas2dProcedural`, whose two members ALSO have GPU
 *  shaders — gradient-ramp / fractal-noise render on both backends.) */
const CANVAS2D_ONLY = new Set<string>([
  'four-color-gradient',
  'beam',
  'keylight',
  'wave-warp',
  'turbulent-displace',
  'inner-shadow',
  'inner-glow',
  'satin',
  'bevel',
  'directional-blur',
  'linear-wipe',
  'transform',
  // Blur family. The generic `blur` is a CSS filter and stays OFF this list —
  // it needs no bake and should keep the cheap path. These three each express
  // something a CSS filter cannot (per-axis dimensions, an iteration count, a
  // centre of rotation), so they are real pixel passes and force the bake.
  'gaussian-blur',
  'fast-box-blur',
  'radial-blur',
  // Stylize family — all three are per-pixel passes with no shader form.
  'mosaic',
  'find-edges',
  'roughen-edges',
  // Colour family. `exposure` is deliberately ABSENT: it is a per-channel
  // transfer function, so it lives in LUT_EFFECTS and renders on both backends
  // with no bake. These two read all three channels per pixel, which no
  // per-channel table can express.
  'vibrance',
  'colorama',
]);

export function isCanvas2dOnlyEffect(type: string): boolean {
  return CANVAS2D_ONLY.has(type);
}

/**
 * Effects the bake chain can DRAW — the Canvas2D-only family plus the four that
 * also have GPU materials (Fill, Stroke, Sharpen, Noise).
 *
 * Never gate "does this layer need baking?" on this set: doing so would drag
 * every layer with a Fill back onto the CPU. It answers only "now that we ARE
 * baking, can this effect come along?", which for these four must be yes — the
 * GPU list is dropped for a baked layer, so the bake is their only route.
 */
const CANVAS2D_IMPLEMENTED: ReadonlySet<string> = new Set<string>([
  ...CANVAS2D_ONLY,
  'fill',
  'stroke',
  'sharpen',
  'noise',
]);

export function hasCanvas2dImplementation(type: string): boolean {
  return CANVAS2D_IMPLEMENTED.has(type);
}

/**
 * The alpha that STYLE GENERATORS shape themselves from, when it must differ from
 * the canvas they composite onto.
 *
 * Normally they are the same thing: a stroke outlines the pixels it is drawn over.
 * Fill opacity breaks that. Photoshop fades a layer's own fill while leaving its
 * effects at full strength, so at fill 0 the styles have to be generated from a
 * silhouette that is no longer on the canvas. Threading the two roles separately
 * is what makes that expressible — see `applyEffectChain`.
 *
 * Only style GENERATORS honour this (stroke, inner shadow/glow, satin, bevel).
 * Pixel transforms like directional blur and linear wipe legitimately read the
 * live contents and must not be redirected.
 */
let styleSilhouette: HTMLCanvasElement | null = null;

/** Run `fn` with a style silhouette in effect. Restores the previous one after. */
export function withStyleSilhouette<T>(src: HTMLCanvasElement | null, fn: () => T): T {
  const prev = styleSilhouette;
  styleSilhouette = src;
  try {
    return fn();
  } finally {
    styleSilhouette = prev;
  }
}

/** The alpha a style generator should shape itself from. */
function silhouetteOf(oc: CanvasRenderingContext2D): HTMLCanvasElement {
  return styleSilhouette ?? (oc.canvas as HTMLCanvasElement);
}

/**
 * Long-side cap for the bevel's shading buffer, in px.
 *
 * The bevel is the only per-pixel lighting pass in the styles and was the only
 * effect with a resolution-proportional cost — 101 ms/frame at 1080p, 386 ms at
 * 4K, against a sub-millisecond field for everything else. 640 is the value the
 * audit measured, and is comfortably above the ramp widths a bevel uses, so the
 * profile survives the round trip; see `applyBevel` for why the blur radius must
 * scale with it.
 */
let BEVEL_MAX_WORK = 640;

/**
 * Raise/lower the bevel working-buffer cap. TESTS ONLY.
 *
 * The claim the cap makes is "same look, constant cost", and the only way to
 * check it is to run the SAME input through both paths — comparing two different
 * scenes cannot do it, because this algorithm is not scale-invariant (the normal
 * is derived from a per-pixel slope, so doubling the geometry and the blur radius
 * together genuinely halves the shading). Pass Infinity to force the
 * full-resolution path, then restore.
 */
export function __setBevelMaxWorkForTests(px: number): () => void {
  const prev = BEVEL_MAX_WORK;
  BEVEL_MAX_WORK = px;
  return () => { BEVEL_MAX_WORK = prev; };
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
    case 'inner-shadow':
      return applyInnerShadow(oc, w, h, e);
    case 'inner-glow':
      return applyInnerGlow(oc, w, h, e);
    case 'satin':
      return applySatin(oc, w, h, e);
    case 'bevel':
      return applyBevel(oc, w, h, e);
    case 'directional-blur':
      return applyDirectionalBlur(oc, w, h, e);
    case 'linear-wipe':
      return applyLinearWipe(oc, w, h, e);
    case 'transform':
      return applyTransformEffect(oc, w, h, e);
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
    case 'gaussian-blur':
      return applyGaussianBlur(oc, w, h, e);
    case 'fast-box-blur':
      return applyFastBoxBlur(oc, w, h, e);
    case 'radial-blur':
      return applyRadialBlur(oc, w, h, e);
    case 'mosaic':
      return applyMosaic(oc, w, h, e);
    case 'find-edges':
      return applyFindEdges(oc, w, h, e);
    case 'roughen-edges':
      return applyRoughenEdges(oc, w, h, e);
    case 'vibrance':
      return applyVibrance(oc, w, h, e);
    case 'colorama':
      return applyColorama(oc, w, h, e);
  }
}

// ── Colour family (kernels in colorEffects.ts) ─────────────────────

function applyVibrance(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const vib = effectNumber(e, 'vibrance');
  const sat = effectNumber(e, 'saturation');
  if (vib === 0 && sat === 0) return;
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  vibranceData(img.data, vib, sat);
  oc.putImageData(img, 0, 0);
}

function applyColorama(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const idx = Math.max(0, Math.min(COLORAMA_PALETTES.length - 1, Math.round(effectNumber(e, 'palette'))));
  const palette = COLORAMA_PALETTES[idx]!;
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  coloramaData(
    img.data,
    palette.stops,
    effectNumber(e, 'phaseShift'),
    effectNumber(e, 'cycleRepetitions'),
    Math.max(0, Math.min(100, effectNumber(e, 'blendWithOriginal'))) / 100,
  );
  oc.putImageData(img, 0, 0);
}

// ── Stylize family (kernels in stylize.ts) ─────────────────────────

function applyMosaic(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  img.data.set(mosaicData(
    img.data, w, h,
    effectNumber(e, 'horizontalBlocks'),
    effectNumber(e, 'verticalBlocks'),
    bool(e, 'sharpColors', false),
  ));
  oc.putImageData(img, 0, 0);
}

function applyFindEdges(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  const edges = findEdgesData(img.data, w, h, bool(e, 'invert', true));

  // Blend With Original is AE's own mix-back control, and it is worth having
  // because Find Edges at full strength discards the layer entirely — the
  // useful looks are almost all partial.
  const blend = Math.max(0, Math.min(100, effectNumber(e, 'blendWithOriginal'))) / 100;
  if (blend > 0) {
    const src = img.data;
    for (let i = 0; i < src.length; i += 4) {
      edges[i] = edges[i]! * (1 - blend) + src[i]! * blend;
      edges[i + 1] = edges[i + 1]! * (1 - blend) + src[i + 1]! * blend;
      edges[i + 2] = edges[i + 2]! * (1 - blend) + src[i + 2]! * blend;
    }
  }
  img.data.set(edges);
  oc.putImageData(img, 0, 0);
}

function applyRoughenEdges(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const border = Math.max(0, effectNumber(e, 'border'));
  if (border <= 0) return;
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  const out = roughenEdgesData(
    img.data, w, h,
    border,
    effectNumber(e, 'scale'),
    effectNumber(e, 'complexity'),
    effectNumber(e, 'evolution'),
    effectNumber(e, 'seed'),
  );

  // Edge Sharpness hardens the chewed alpha toward a cut: 0 leaves the noise
  // soft, higher values push partial alpha to the extremes. Applied here rather
  // than in the kernel so the kernel stays a pure noise-bite.
  const sharp = Math.max(0, effectNumber(e, 'edgeSharpness'));
  if (sharp > 0) {
    for (let i = 3; i < out.length; i += 4) {
      const a = out[i]! / 255;
      out[i] = Math.round(255 * Math.min(1, Math.max(0, (a - 0.5) * (1 + sharp * 2) + 0.5)));
    }
  }
  img.data.set(out);
  oc.putImageData(img, 0, 0);
}

// ── Blur family (kernels in blurs.ts) ──────────────────────────────
//
// All three share the same shape: pull the pixels, transform, put them back.
// The arithmetic lives in `blurs.ts` so it can be asserted numerically without
// a DOM — these wrappers only marshal.

/** Gaussian Blur — three box passes, which converge on a true Gaussian. */
function applyGaussianBlur(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const radius = Math.max(0, effectNumber(e, 'blurriness'));
  if (radius <= 0) return;
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  blurRgba(img.data, w, h, radius, {
    dimensions: blurDimensions(effectNumber(e, 'dimensions')),
    // Fixed at 3, not exposed: this effect IS "the Gaussian one". Exposing the
    // count would make it Fast Box Blur with a different label.
    iterations: 3,
    repeatEdge: bool(e, 'repeatEdge', true),
  });
  oc.putImageData(img, 0, 0);
}

/** Fast Box Blur — the same kernel with the iteration count exposed. */
function applyFastBoxBlur(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const radius = Math.max(0, effectNumber(e, 'blurRadius'));
  if (radius <= 0) return;
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  blurRgba(img.data, w, h, radius, {
    dimensions: blurDimensions(effectNumber(e, 'dimensions')),
    iterations: effectNumber(e, 'iterations'),
    repeatEdge: bool(e, 'repeatEdge', true),
  });
  oc.putImageData(img, 0, 0);
}

/** Radial Blur — spin or zoom about a centre offset from the layer's middle. */
function applyRadialBlur(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const amount = effectNumber(e, 'amount');
  if (amount === 0) return;
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  const out = radialBlurData(
    img.data, w, h,
    amount,
    w / 2 + effectNumber(e, 'centerX'),
    h / 2 + effectNumber(e, 'centerY'),
    effectNumber(e, 'blurType') === 1 ? 'zoom' : 'spin',
    effectNumber(e, 'quality'),
  );
  img.data.set(out);
  oc.putImageData(img, 0, 0);
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
  sc.drawImage(silhouetteOf(oc), 0, 0);

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

// ── Interior styles: inner shadow and inner glow ────────────────────
//
// Photoshop splits layer styles into EXTERIOR (drop shadow, outer glow — they
// grow away from the silhouette and never touch its opaque pixels) and INTERIOR
// (inner shadow, inner glow, satin — they live entirely inside it). The effect
// chain could already do exterior work: `stroke` dilates outward, `glow` blooms
// outward, `fill` recolours within alpha. It had no way to do interior work at
// all, which is why four of Photoshop's nine styles had nowhere to land.
//
// The primitive is one shape:
//
//   1. take the layer's silhouette,
//   2. INVERT it — everything the layer is not,
//   3. offset and blur that inverse,
//   4. clip the result back INSIDE the original silhouette,
//   5. composite it over the layer.
//
// Step 4 is what makes it interior: the blurred outside bleeds in past the edge
// and is then trimmed to the layer, so the darkening (or light) hugs the inside
// of the contour. Offset the inverse and it reads as a shadow cast from a
// direction; leave it centred and it reads as a glow from the edge inward.

interface InteriorOptions {
  /** Colour to tint the interior band. */
  color: string;
  /** 0..1 — applied on the final composite, not baked into the tint. */
  opacity: number;
  /** Blur radius in px; 0 gives a hard-edged band. */
  size: number;
  /** Offset of the inverse silhouette, in px. Zero for a glow. */
  dx: number;
  dy: number;
  /** How the band composites over the layer. */
  blend: GlobalCompositeOperation;
}

/**
 * Draw an interior band inside the layer's own alpha. Mutates `oc`.
 *
 * Needs three scratch buffers and they must be distinct: the inverse is built
 * from the silhouette, then clipped by the silhouette again, so reusing one
 * buffer would consume the mask it still needs.
 */
function applyInterior(oc: CanvasRenderingContext2D, w: number, h: number, opts: InteriorOptions): void {
  const { color, opacity, size, dx, dy, blend } = opts;
  if (opacity <= 0) return;

  // The working buffers are PADDED, and that padding is load-bearing.
  //
  // The band is a blur of the layer's INVERSE, so it needs real "outside" to cast
  // from. Building the inverse at layer size cannot provide any: an oversized
  // `fillRect(-w, -h, w*3, h*3)` is clipped to the canvas, so a layer whose alpha
  // reaches its own texture edge — which a plain rect shape always does — punched
  // out to nothing, blurred to nothing, and produced NO interior style at all.
  // The tell was that raising `size` made it worse rather than stronger.
  //
  // 3σ is where a Gaussian has effectively died, so padding by 3×size (plus the
  // offset, which slides the inverse) guarantees every pixel the blur can reach
  // is backed by real inverse rather than by the edge of a buffer.
  const pad = Math.ceil(size * 3 + Math.max(Math.abs(dx), Math.abs(dy))) + 2;
  const pw = w + pad * 2;
  const ph = h + pad * 2;

  const silhouette = scratch('interior-silhouette', pw, ph);
  const inverse = scratch('interior-inverse', pw, ph);
  const band = scratch('interior-band', pw, ph);
  if (!silhouette || !inverse || !band) return;
  const sc = silhouette.getContext('2d');
  const ic = inverse.getContext('2d');
  const bc = band.getContext('2d');
  if (!sc || !ic || !bc) return;

  for (const c of [sc, ic, bc]) {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    c.filter = 'none';
    c.clearRect(0, 0, pw, ph);
  }

  // 1. The silhouette, inset into the padded buffer and kept intact as the clip
  //    mask for step 4.
  sc.drawImage(silhouetteOf(oc), pad, pad);

  // 2. Invert it: fill the padded frame, then punch the silhouette out. The
  //    margin left over IS the "outside" the band is cast from.
  ic.fillStyle = '#000';
  ic.fillRect(0, 0, pw, ph);
  ic.globalCompositeOperation = 'destination-out';
  ic.drawImage(silhouette, 0, 0);

  // 3. Offset + blur the inverse into the band buffer.
  bc.filter = size > 0 ? `blur(${size}px)` : 'none';
  bc.drawImage(inverse, dx, dy);
  bc.filter = 'none';

  // 4. Tint it, then trim it to the layer's own alpha — the interior step.
  bc.globalCompositeOperation = 'source-in';
  bc.fillStyle = color;
  bc.fillRect(0, 0, pw, ph);
  bc.globalCompositeOperation = 'destination-in';
  bc.drawImage(silhouette, 0, 0);

  // 5. Composite the layer-sized window of the band back over the layer.
  oc.save();
  oc.setTransform(1, 0, 0, 1, 0, 0);
  oc.globalCompositeOperation = blend;
  oc.globalAlpha = opacity;
  oc.drawImage(band, pad, pad, w, h, 0, 0, w, h);
  oc.restore();
}

function applyInnerShadow(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const distance = Math.max(0, effectNumber(e, 'distance'));
  const angle = effectNumber(e, 'angle');
  const rad = (angle * Math.PI) / 180;
  applyInterior(oc, w, h, {
    color: str(e, 'color', '#000000'),
    opacity: clamp01(effectNumber(e, 'opacity') / 100),
    size: Math.max(0, effectNumber(e, 'softness')),
    // The shadow falls AWAY from the light, so the inverse is offset toward it.
    dx: Math.cos(rad) * distance,
    dy: Math.sin(rad) * distance,
    blend: 'source-over',
  });
}

function applyInnerGlow(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyInterior(oc, w, h, {
    color: str(e, 'color', '#ffd070'),
    opacity: clamp01(effectNumber(e, 'opacity') / 100),
    size: Math.max(0, effectNumber(e, 'size')),
    // No offset: a glow comes from the whole contour, not one direction.
    dx: 0,
    dy: 0,
    // Lighter, so a glow adds light instead of painting over the artwork.
    blend: 'lighter',
  });
}

/**
 * Satin — the interior sheen.
 *
 * Photoshop's satin is the SYMMETRIC DIFFERENCE of two copies of the silhouette
 * offset in opposite directions, blurred, and clipped inside the layer. Where
 * the two copies agree they cancel; where only one covers, the band survives.
 * On a rounded or irregular contour that leaves the soft folded shape satin is
 * named for; on a plain rectangle it is two opposing crescents, which is
 * correct and not very interesting — the effect is a function of the outline.
 *
 * Done entirely on the ALPHA channel. The obvious route — flatten both copies
 * to greyscale and `difference` them — would need a luminance→alpha conversion
 * Canvas2D has no primitive for, so the difference is taken as
 * `A minus B` plus `B minus A` instead, which is the same set operation and
 * needs only `destination-out`.
 *
 * `invert` swaps the symmetric difference for the INTERSECTION, which is what
 * Photoshop's Invert checkbox does visually: the sheen appears where the two
 * copies agree rather than where they disagree.
 */
function applySatin(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const opacity = clamp01(effectNumber(e, 'opacity') / 100);
  const size = Math.max(0, effectNumber(e, 'size'));
  const distance = Math.max(0, effectNumber(e, 'distance'));
  if (opacity <= 0 || (size <= 0 && distance <= 0)) return;
  const color = str(e, 'color', '#000000');
  const invert = paramsOf(e).invert === true;
  const rad = (effectNumber(e, 'angle') * Math.PI) / 180;
  const dx = Math.cos(rad) * distance;
  const dy = Math.sin(rad) * distance;

  const silhouette = scratch('satin-silhouette', w, h);
  const a = scratch('satin-a', w, h);
  const b = scratch('satin-b', w, h);
  // A pristine copy of A. `a` gets consumed by the first subtraction, and the
  // second one still needs the ORIGINAL A — subtracting a re-derived unblurred
  // silhouette instead is not the same set and leaves a hard-edged sliver.
  const a0 = scratch('satin-a0', w, h);
  const band = scratch('satin-band', w, h);
  if (!silhouette || !a || !b || !a0 || !band) return;
  const sc = silhouette.getContext('2d');
  const ac = a.getContext('2d');
  const bc = b.getContext('2d');
  const a0c = a0.getContext('2d');
  const nc = band.getContext('2d');
  if (!sc || !ac || !bc || !a0c || !nc) return;

  for (const c of [sc, ac, bc, a0c, nc]) {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    c.filter = 'none';
    c.clearRect(0, 0, w, h);
  }

  sc.drawImage(silhouetteOf(oc), 0, 0);

  // Two blurred copies, offset in opposite directions.
  ac.filter = size > 0 ? `blur(${size}px)` : 'none';
  ac.drawImage(silhouette, dx, dy);
  ac.filter = 'none';
  bc.filter = size > 0 ? `blur(${size}px)` : 'none';
  bc.drawImage(silhouette, -dx, -dy);
  bc.filter = 'none';
  a0c.drawImage(a, 0, 0);

  if (invert) {
    // Intersection: keep only where both copies cover.
    nc.drawImage(a, 0, 0);
    nc.globalCompositeOperation = 'destination-in';
    nc.drawImage(b, 0, 0);
  } else {
    // Symmetric difference: (A − B) ∪ (B − A). `a` and `b` are consumed here,
    // so nothing downstream may read them again.
    ac.globalCompositeOperation = 'destination-out';
    ac.drawImage(b, 0, 0); // a := A − B
    bc.globalCompositeOperation = 'destination-out';
    bc.drawImage(a0, 0, 0); // b := B − A, using the PRISTINE A
    nc.drawImage(a, 0, 0);
    nc.drawImage(b, 0, 0);
  }

  // Tint, then trim to the layer — the interior step.
  nc.globalCompositeOperation = 'source-in';
  nc.fillStyle = color;
  nc.fillRect(0, 0, w, h);
  nc.globalCompositeOperation = 'destination-in';
  nc.drawImage(silhouette, 0, 0);

  oc.save();
  oc.setTransform(1, 0, 0, 1, 0, 0);
  oc.globalAlpha = opacity;
  oc.drawImage(band, 0, 0);
  oc.restore();
}

/**
 * Bevel & Emboss — the only style that needs a lighting model rather than a
 * compositing trick.
 *
 * Every other style is set algebra on the alpha channel. A bevel is shading: it
 * treats the layer's alpha as a HEIGHT FIELD, derives a surface normal from its
 * slope, and lights that normal. Which is why it is the one style that consumes
 * the global light's ALTITUDE as well as its angle — the others only care which
 * way the light comes from, a bevel also cares how steeply.
 *
 *   1. blur the alpha by `size` — the blur IS the bevel profile, turning a hard
 *      edge into a ramp whose width is the bevel's width,
 *   2. take the ramp's gradient — the surface slope,
 *   3. N = normalize(-gx*depth, -gy*depth, 1),
 *   4. L = (cos0*cosP, sin0*cosP, sinP) for angle 0 and altitude P,
 *   5. lambert = N.L; positive lights the highlight, negative the shadow,
 *   6. clip both to the layer's own alpha and composite — highlight additively,
 *      shadow multiplicatively, matching Photoshop's default Screen/Multiply.
 *
 * Technique is SMOOTH only. Photoshop's Chisel needs a distance transform of
 * the alpha rather than a blur, which is a different algorithm — offering a
 * dropdown that silently produced the smooth result would be worse than not
 * offering it at all.
 */
function applyBevel(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const params = paramsOf(e);
  const size = Math.max(1, effectNumber(e, 'size'));
  const depth = Math.max(0, effectNumber(e, 'depth')) / 100;
  const hiOpacity = clamp01(effectNumber(e, 'highlightOpacity') / 100);
  const loOpacity = clamp01(effectNumber(e, 'shadowOpacity') / 100);
  if (depth <= 0 || (hiOpacity <= 0 && loOpacity <= 0)) return;
  // "Down" flips the light to the opposite side, turning a raised edge into a
  // carved one without the user having to rotate the composition's light.
  const down = params.direction === 'down';
  const angleDeg = effectNumber(e, 'angle') + (down ? 180 : 0);
  const altDeg = Math.max(0, Math.min(90, effectNumber(e, 'altitude')));
  const hiColor = parseRgbTriplet(str(e, 'highlightColor', '#ffffff'));
  const loColor = parseRgbTriplet(str(e, 'shadowColor', '#000000'));

  // ── Cost ──────────────────────────────────────────────────────
  //
  // The shading is computed on a REDUCED-RESOLUTION working buffer, capped at
  // BEVEL_MAX_WORK on the long side. The pass used to run at full resolution and
  // cost ~101 ms/frame at 1920×1080 and 386 ms at 4K, dominated not by the
  // arithmetic but by six passes over 8 MB buffers (two getImageData, two
  // createImageData, two putImageData).
  //
  // Capping makes the per-pixel shading cost constant. It does NOT make the whole
  // effect constant — reading the source down and blitting the two bands back up
  // through the full-resolution trim are still resolution-proportional. Measured
  // 3.9× faster at 1080p and 5.6× at 4K (bevelBench.test.ts), with 4K still ~2.8×
  // the cost of 1080p. Bounded, not free; the remaining cost is GPU-side
  // drawImage rather than JS pixel work.
  //
  // An earlier attempt at this shipped FLAT shading and was reverted. The reason,
  // and the thing to preserve here: the blur radius must be scaled WITH the
  // buffer. The blur IS the bevel profile, so blurring by an unscaled `size` on a
  // downscaled buffer widens the ramp by 1/s in full-resolution terms, and the
  // ramp then reads as nearly flat no matter what depth compensation is applied.
  //
  // With the radius scaled, the compensation is exact and is simply the scale:
  // the ramp spans s× as many working pixels, so the per-pixel gradient measures
  // 1/s times steeper, and multiplying depthScale by s cancels it. Verified by
  // rendering identical relative geometry at 640×360 (undownscaled) and 1280×720
  // (downscaled) and comparing the shading profiles — see the bevel-profile-*
  // scenes in packages/render-tests.
  const scaleCap = Math.min(1, BEVEL_MAX_WORK / Math.max(w, h));
  const ww = Math.max(1, Math.round(w * scaleCap));
  const wh = Math.max(1, Math.round(h * scaleCap));
  // The achieved scale, not the requested one — rounding to whole pixels moves it.
  const s = ww / w;

  const silhouette = scratch('bevel-silhouette', ww, wh);
  const ramp = scratch('bevel-ramp', ww, wh);
  const hiBand = scratch('bevel-hi', ww, wh);
  const loBand = scratch('bevel-lo', ww, wh);
  if (!silhouette || !ramp || !hiBand || !loBand) return;
  const sc = silhouette.getContext('2d');
  const rc = ramp.getContext('2d');
  const hc = hiBand.getContext('2d');
  const lc = loBand.getContext('2d');
  if (!sc || !rc || !hc || !lc) return;
  for (const c of [sc, rc, hc, lc]) {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    c.filter = 'none';
    c.clearRect(0, 0, ww, wh);
  }

  sc.drawImage(silhouetteOf(oc), 0, 0, w, h, 0, 0, ww, wh);
  // Scaled with the buffer — see above; this is the line the reverted attempt
  // got wrong. Floored at a radius that still produces a ramp rather than an
  // edge, or a thin bevel on a heavily downscaled layer would have nothing to
  // take a gradient from.
  rc.filter = `blur(${Math.max(0.5, size * s)}px)`;
  rc.drawImage(silhouette, 0, 0);
  rc.filter = 'none';

  const src = rc.getImageData(0, 0, ww, wh).data;
  const mask = sc.getImageData(0, 0, ww, wh).data;
  const hiImg = hc.createImageData(ww, wh);
  const loImg = lc.createImageData(ww, wh);

  const rad = (angleDeg * Math.PI) / 180;
  const altRad = (altDeg * Math.PI) / 180;
  const lx = Math.cos(rad) * Math.cos(altRad);
  const ly = Math.sin(rad) * Math.cos(altRad);
  const lz = Math.sin(altRad);

  // ── The inner loop ────────────────────────────────────────────
  //
  // This is the only per-pixel pass in the styles, and at 1920×1080 it visits
  // two million pixels — so the shape of this loop IS the effect's cost. The
  // first version called a clamping `heightAt` closure four times per pixel
  // (eight million calls) and ran at ~120 ms/frame, which is not a usable
  // effect. Three changes take it to a few milliseconds:
  //
  //   • the alpha ramp is lifted into a flat Float32Array once, so the inner
  //     loop indexes a typed array instead of striding an RGBA buffer,
  //   • the interior is walked without bounds checks — the edge rows/columns
  //     are the only ones that can read out of range, and they are handled by
  //     clamping the four neighbour indices ONCE per pixel rather than inside
  //     a helper,
  //   • rows are skipped wholesale when the mask is empty across them, which is
  //     most rows for a typical layer.
  const height = new Float32Array(ww * wh);
  for (let p = 0, q = 3; p < height.length; p++, q += 4) height[p] = src[q]! / 255;

  const hiData = hiImg.data;
  const loData = loImg.data;
  // The exact compensation for measuring the gradient in working pixels: the
  // ramp spans s× as many of them, so the central difference reads 1/s times
  // steeper, and this cancels it. s is 1 for any layer under the cap, which
  // leaves small layers bit-for-bit unchanged.
  const depthScale = depth * 8 * s;

  for (let y = 0; y < wh; y++) {
    const row = y * ww;
    const up = (y > 0 ? y - 1 : 0) * ww;
    const down = (y < wh - 1 ? y + 1 : wh - 1) * ww;
    for (let x = 0; x < ww; x++) {
      const p = row + x;
      const i = p * 4;
      const a = mask[i + 3]!;
      if (a === 0) continue; // outside the layer — a bevel is interior

      const left = x > 0 ? p - 1 : row;
      const right = x < ww - 1 ? p + 1 : row + ww - 1;
      const gx = (height[right]! - height[left]!) * 0.5;
      const gy = (height[down + x]! - height[up + x]!) * 0.5;

      const nx = -gx * depthScale;
      const ny = -gy * depthScale;
      const len = Math.sqrt(nx * nx + ny * ny + 1);
      // A FLAT interior has N = (0,0,1) and therefore lambert = sin(altitude).
      // That baseline must not shade the whole layer — only the deviation from
      // flat is the bevel — so it is subtracted out.
      const shade = (nx * lx + ny * ly + lz) / len - lz;
      if (shade === 0) continue;

      const alphaScale = a / 255;
      if (shade > 0) {
        if (hiOpacity === 0) continue;
        hiData[i] = hiColor[0];
        hiData[i + 1] = hiColor[1];
        hiData[i + 2] = hiColor[2];
        hiData[i + 3] = (shade < 1 ? shade : 1) * hiOpacity * alphaScale * 255;
      } else {
        if (loOpacity === 0) continue;
        const mag = -shade;
        loData[i] = loColor[0];
        loData[i + 1] = loColor[1];
        loData[i + 2] = loColor[2];
        loData[i + 3] = (mag < 1 ? mag : 1) * loOpacity * alphaScale * 255;
      }
    }
  }

  hc.putImageData(hiImg, 0, 0);
  lc.putImageData(loImg, 0, 0);

  oc.save();
  oc.setTransform(1, 0, 0, 1, 0, 0);
  if (s === 1) {
    oc.globalCompositeOperation = 'lighter';
    oc.drawImage(hiBand, 0, 0);
    oc.globalCompositeOperation = 'multiply';
    oc.drawImage(loBand, 0, 0);
  } else {
    // The bands are computed at working resolution, so they have to be scaled
    // back up. Upsampling interpolates across the silhouette edge and would
    // otherwise smear a few pixels of highlight OUTSIDE the layer — `lighter`
    // adds, so that shows as a rim on transparent background. Re-trim each band
    // to the layer's own alpha at full resolution before compositing; a bevel is
    // interior, and "adds nothing outside the silhouette" is the property the
    // interior-* scenes assert.
    const full = scratch('bevel-band-full', w, h);
    const fc = full?.getContext('2d');
    if (!full || !fc) {
      oc.restore();
      return;
    }
    const blit = (band: HTMLCanvasElement, op: GlobalCompositeOperation): void => {
      fc.setTransform(1, 0, 0, 1, 0, 0);
      fc.globalCompositeOperation = 'source-over';
      fc.globalAlpha = 1;
      fc.filter = 'none';
      fc.clearRect(0, 0, w, h);
      fc.drawImage(band, 0, 0, ww, wh, 0, 0, w, h);
      fc.globalCompositeOperation = 'destination-in';
      fc.drawImage(silhouetteOf(oc), 0, 0);
      oc.globalCompositeOperation = op;
      oc.drawImage(full, 0, 0);
    };
    blit(hiBand, 'lighter');
    blit(loBand, 'multiply');
  }
  oc.restore();
}

/** Hex colour to an [r, g, b] triplet. */
function parseRgbTriplet(hex: string): [number, number, number] {
  const s = hex.trim().replace('#', '');
  if (s.length === 3) {
    return [parseInt(s[0]! + s[0]!, 16), parseInt(s[1]! + s[1]!, 16), parseInt(s[2]! + s[2]!, 16)];
  }
  if (s.length >= 6) {
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  }
  return [255, 255, 255];
}

// ── Directional Blur ───────────────────────────────────────────────
//
// Blur along ONE axis. CSS `blur` is isotropic and there is no directional
// form, so this accumulates offset copies along the axis — a box blur, which is
// what a directional blur is. Weighted by a triangular kernel so the falloff is
// smooth rather than a visible stack of ghosts, and normalized so the layer
// keeps its brightness instead of washing out as length grows.

function applyDirectionalBlur(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const length = Math.max(0, effectNumber(e, 'length'));
  if (length < 1) return;
  const rad = (effectNumber(e, 'direction') * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);

  // One sample per pixel of length, capped — beyond ~64 the extra samples are
  // invisible and the cost is linear in them.
  const steps = Math.max(1, Math.min(64, Math.round(length)));
  const src = scratch('dirblur-src', w, h);
  const acc = scratch('dirblur-acc', w, h);
  if (!src || !acc) return;
  const sc = src.getContext('2d');
  const ac = acc.getContext('2d');
  if (!sc || !ac) return;
  for (const c of [sc, ac]) {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    c.filter = 'none';
    c.clearRect(0, 0, w, h);
  }
  sc.drawImage(oc.canvas, 0, 0);

  // Triangular weights, summed first so the composite is energy-preserving.
  const weights: number[] = [];
  let total = 0;
  for (let i = -steps; i <= steps; i++) {
    const t = 1 - Math.abs(i) / (steps + 1);
    weights.push(t);
    total += t;
  }

  ac.globalCompositeOperation = 'lighter';
  let k = 0;
  for (let i = -steps; i <= steps; i++) {
    const off = (i / steps) * (length / 2);
    ac.globalAlpha = weights[k++]! / total;
    ac.drawImage(src, dx * off, dy * off);
  }
  ac.globalAlpha = 1;

  oc.save();
  oc.setTransform(1, 0, 0, 1, 0, 0);
  oc.globalCompositeOperation = 'copy';
  oc.drawImage(acc, 0, 0);
  oc.restore();
}

// ── Linear Wipe ────────────────────────────────────────────────────
//
// Reveal or hide the layer behind a straight edge. The workhorse of transitions,
// and one keyframe on `completion` is the whole effect.

function applyLinearWipe(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const completion = Math.max(0, Math.min(100, effectNumber(e, 'completion'))) / 100;
  if (completion <= 0) return;
  if (completion >= 1) {
    // Fully wiped: clear rather than leaving a sliver from rounding.
    oc.save();
    oc.setTransform(1, 0, 0, 1, 0, 0);
    oc.globalCompositeOperation = 'destination-out';
    oc.fillStyle = '#000';
    oc.fillRect(0, 0, w, h);
    oc.restore();
    return;
  }
  const rad = (effectNumber(e, 'wipeAngle') * Math.PI) / 180;
  const feather = Math.max(0, effectNumber(e, 'feather'));

  // The wipe travels along the angle's axis; the span is the box projected onto
  // it, so completion 100% clears the layer at ANY angle rather than leaving a
  // corner behind.
  const cx = w / 2;
  const cy = h / 2;
  const span = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad));
  const half = span / 2;
  // Edge position, travelling from the leading side toward the trailing one.
  const pos = -half + completion * span;

  const gx = Math.cos(rad);
  const gy = Math.sin(rad);
  // A zero-feather gradient still needs two distinct stops, so clamp the soft
  // band to a sub-pixel minimum instead of special-casing a hard edge.
  const soft = Math.max(feather, 0.01);
  const g = oc.createLinearGradient(
    cx + gx * (pos - soft / 2),
    cy + gy * (pos - soft / 2),
    cx + gx * (pos + soft / 2),
    cy + gy * (pos + soft / 2),
  );
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(1, 'rgba(0,0,0,0)');

  oc.save();
  oc.setTransform(1, 0, 0, 1, 0, 0);
  oc.globalCompositeOperation = 'destination-out';
  oc.fillStyle = g;
  oc.fillRect(0, 0, w, h);
  oc.restore();
}

// ── Transform (effect) ─────────────────────────────────────────────
//
// AE's Transform effect: a second transform applied to the layer's CONTENT,
// inside the effect stack, so effects above it see the untransformed layer and
// effects below it see the transformed one. That ordering is the entire point —
// it is how you blur a layer and THEN scale the blur, which the layer's own
// Transform properties cannot express because they always apply last.
//
// Operates in the layer's local space (this is a CPU-baked pass), so the anchor
// is the layer centre and the result is re-clipped to the layer's own box.

function applyTransformEffect(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const scale = Math.max(0, effectNumber(e, 'scale')) / 100;
  const rot = (effectNumber(e, 'rotation') * Math.PI) / 180;
  const px = effectNumber(e, 'positionX');
  const py = effectNumber(e, 'positionY');
  const opacity = clamp01(effectNumber(e, 'opacity') / 100);
  const identity = scale === 1 && rot === 0 && px === 0 && py === 0 && opacity === 1;
  if (identity) return;

  const src = scratch('xform-src', w, h);
  if (!src) return;
  const sc = src.getContext('2d');
  if (!sc) return;
  sc.setTransform(1, 0, 0, 1, 0, 0);
  sc.globalCompositeOperation = 'source-over';
  sc.globalAlpha = 1;
  sc.filter = 'none';
  sc.clearRect(0, 0, w, h);
  sc.drawImage(oc.canvas, 0, 0);

  oc.save();
  oc.setTransform(1, 0, 0, 1, 0, 0);
  // `copy` so the untransformed original does not remain underneath the
  // transformed copy — the difference only shows once something moves.
  oc.globalCompositeOperation = 'copy';
  oc.clearRect(0, 0, w, h);
  oc.globalCompositeOperation = 'source-over';
  oc.globalAlpha = opacity;
  oc.translate(w / 2 + px, h / 2 + py);
  oc.rotate(rot);
  oc.scale(scale, scale);
  oc.drawImage(src, -w / 2, -h / 2);
  oc.restore();
}
