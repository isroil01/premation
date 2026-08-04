/**
 * Visual effects engine (spec: Focus Mode edits "animation, masks, effects,
 * expressions…"). Each layer carries a stack of effects stored on an `fx`
 * component so History, autosave, and export capture them for free. Effects
 * compile to a CSS `filter` string the Canvas 2D backend applies per layer.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getEventBus } from '@core/events/EventBus';
import type { SceneNode } from '@core/types';

export type EffectType =
  | 'blur'
  | 'glow'
  | 'drop-shadow'
  | 'brightness'
  | 'contrast'
  | 'saturate'
  | 'grayscale'
  | 'sepia'
  | 'hue-rotate'
  | 'hue-saturation'
  | 'invert'
  | 'levels'
  | 'curves'
  | 'posterize'
  | 'tint'
  | 'channel-mixer'
  | 'gradient-ramp'
  | 'fractal-noise'
  | 'displacement-map'
  | 'motion-tile'
  | 'fill'
  | 'four-color-gradient'
  | 'stroke'
  | 'beam'
  | 'sharpen'
  | 'noise'
  | 'keylight'
  | 'wave-warp'
  | 'turbulent-displace'
  | 'echo'
  | 'inner-shadow'
  | 'inner-glow'
  | 'satin'
  | 'bevel'
  | 'directional-blur'
  | 'linear-wipe'
  | 'transform'
  | 'posterize-time'
  // ── Blur family ──
  | 'gaussian-blur'
  | 'fast-box-blur'
  | 'radial-blur'
  // ── Stylize family ──
  | 'mosaic'
  | 'find-edges'
  | 'roughen-edges'
  // ── Colour family ──
  | 'exposure'
  | 'vibrance'
  | 'colorama'
  | 'lumetri'
  | 'selective-color'
  | 'shadow-highlight'
  // ── Distort family ──
  | 'bulge'
  | 'twirl'
  | 'spherize'
  | 'corner-pin'
  // Corner Pin's generalisation: four edges as cubic Beziers, interior filled
  // by a Coons patch. See `bezierWarp.ts`.
  | 'bezier-warp'
  // ── Generate family, round two ──
  | 'checkerboard'
  | 'grid'
  | 'cell-pattern'
  // The one whose geometry comes from the LAYER rather than from a formula:
  // Vegas runs lights along the alpha contour. See `vegas.ts`.
  | 'vegas'
  // ── Noise family ──
  | 'turbulent-noise'
  | 'add-grain'
  | 'median'
  // ── Matte / keying family ──
  | 'set-matte'
  | 'simple-choker'
  | 'linear-color-key'
  | 'shift-channels'
  // ── Transition family ──
  | 'venetian-blinds'
  | 'gradient-wipe'
  | 'card-wipe'
  // ── Generate / Text families ──
  | 'lens-flare'
  | 'numbers'
  | 'timecode'
  | 'audio-spectrum';

/** Curve control points: `[inputX, outputY]` pairs in 0–255. */
export type CurvePoints = ReadonlyArray<readonly [number, number]>;
/**
 * `readonly number[]` is for params RESOLVED AT SNAPSHOT TIME rather than
 * authored — Audio Spectrum's band magnitudes, which `buildSnapshot` computes
 * from the referenced audio layer and writes here so the drawing kernel stays a
 * pure function of its params. Not something a user types.
 */
export type EffectParamValue = number | string | boolean | CurvePoints | readonly number[];
export type EffectParams = Readonly<Record<string, EffectParamValue>>;

export interface Effect {
  id: string;
  type: EffectType;
  /**
   * Every parameter, keyed by `EffectParamDef.key`.
   *
   * Optional because stored data may predate it (or omit a param added since).
   * Read it through `paramsOf`/`effectParam`, never directly — those fill in
   * declared defaults and migrate the legacy `amount`.
   */
  params?: EffectParams;
  /** When false the effect stays in the stack but contributes nothing. */
  enabled?: boolean;
  /**
   * Scope this effect to one of the layer's mask paths (M6).
   *
   * The mask's FEATHER drives the effect's edge falloff and its OPACITY drives
   * the effect's intensity, so a soft-edged mask gives a soft-edged effect
   * rather than a hard cut-out of a soft effect.
   *
   * An effect mask must NOT modify layer alpha — that is the invariant that
   * separates it from an ordinary mask. Outside the mask the layer is returned
   * BYTE-IDENTICAL to what it was before the effect ran, alpha included; the
   * mask decides where the effect applies, never where the layer exists.
   *
   * Reference a path whose own `mode` is `'none'`, or the path will also cut the
   * layer — mode `none` exists precisely so a path can be geometry without being
   * a cut (see mask.ts).
   */
  maskId?: string;
  /**
   * @deprecated The pre-multi-param single scalar. Still READ, so projects
   * saved before this change keep their look — `readNodeEffects` migrates it
   * into `params` under the effect's primary key. Never written.
   */
  amount?: number;
}

export interface EffectParamDef {
  key: string;
  label: string;
  /** 'layer' = a reference to another layer in the comp (stored as its node id,
   *  '' = unset). Rendered as a layer dropdown in the effect stack UI. */
  /**
   * `'resolved'` is a param the RENDER PIPELINE fills in, not the user — Audio
   * Spectrum's band magnitudes. It deliberately has no inspector control: the
   * value is derived from another layer every frame, so an editor for it would
   * be a field whose input is overwritten before it is ever read.
   */
  type: 'number' | 'color' | 'checkbox' | 'curve' | 'layer' | 'resolved';
  unit?: string;
  min?: number;
  max?: number;
  /** Decimal places for the number field. */
  precision?: number;
  default: EffectParamValue;
}

export interface EffectDef {
  type: EffectType;
  label: string;
  /**
   * The effect's parameters, in inspector order. The FIRST number param is the
   * effect's "primary" — legacy `amount` migrates into it, and legacy keyframe
   * tracks (`effect.<id>`) drive it.
   *
   * Effects used to carry exactly one scalar `amount`, which is why Glow had a
   * hardcoded colour, Drop Shadow had no angle or distance, and Levels/Curves/
   * Hue-Sat/Keylight could not be expressed at all.
   */
  params: EffectParamDef[];
  /** Build the CSS filter function. Empty for GPU-only effects. */
  css: (p: EffectParams) => string;
  /**
   * Renders only on the GPU backend (a real WGSL/GLSL shader pass), with no
   * CSS-filter equivalent. On Canvas2D — the DEFAULT backend — adding one of
   * these does nothing at all, so the UI must say so rather than offering it
   * as if it worked.
   */
  gpuOnly?: boolean;
}

// ── Param access helpers ──────────────────────────────────────────

const num = (p: EffectParams, k: string, fb = 0): number => {
  const v = p[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : fb;
};
const str = (p: EffectParams, k: string, fb: string): string => {
  const v = p[k];
  return typeof v === 'string' ? v : fb;
};
/**
 * An effect's full parameter set: declared defaults ← legacy `amount` ← stored
 * params.
 *
 * Everything that reads params goes through here, so a legacy effect resolves
 * correctly no matter where it entered — not only when it came via
 * `readNodeEffects`. Relying on one migration point is how a stale shape ends
 * up rendering silently wrong somewhere else.
 */
export function paramsOf(effect: Effect): EffectParams {
  const def = DEF.get(effect.type);
  if (!def) return effect.params ?? {};
  const out: Record<string, EffectParamValue> = { ...defaultParams(def) };
  if (typeof effect.amount === 'number') {
    const key = def.params.find((p) => p.type === 'number')?.key;
    if (key) out[key] = effect.amount;
  }
  return { ...out, ...(effect.params ?? {}) };
}

/** Read one of an effect's parameters, falling back to its declared default. */
export function effectParam(effect: Effect, key: string): EffectParamValue {
  return paramsOf(effect)[key] ?? 0;
}

export function effectNumber(effect: Effect, key: string): number {
  const v = effectParam(effect, key);
  return typeof v === 'number' ? v : 0;
}

/**
 * The same effects with every LENGTH parameter multiplied by `k`.
 *
 * For the CPU bake path, whose canvas is the layer's box × a raster scale. The
 * glyphs and paths are drawn through `ctx.scale(ss, ss)`, but the effect chain
 * runs at identity on the device-pixel canvas and reads its parameters raw — so
 * a 5px stroke was 5 DEVICE px however large the layer was drawn, and the
 * style's size relative to the content it decorates moved with the raster
 * scale instead of staying put.
 *
 * That is invisible while the raster is rebuilt every frame, and very visible
 * when it is not: the raster cache is keyed on a QUANTIZED resolution tier
 * while the draw uses the raw scale, so during a scale animation one texture is
 * reused across a whole tier and stretched. Measured on text growing 0.25×→4×,
 * a 5px stroke's thickness relative to the glyphs ramped up and then halved at
 * each tier boundary — a black edge that visibly thickened and snapped back,
 * over and over, for the length of the animation.
 *
 * Scaling the lengths with the raster makes the baked result depend only on the
 * RATIO of style to content, which no amount of magnification can disturb. The
 * tier cache then costs sharpness — as it always did — and nothing else.
 *
 * Driven off each parameter's declared `unit`, so a new px parameter is covered
 * the day it is added and angles, percentages and counts are left alone.
 */
export function scaleEffectLengths(
  effects: ReadonlyArray<Effect> | undefined,
  k: number,
): ReadonlyArray<Effect> | undefined {
  if (!effects || effects.length === 0 || k === 1 || !(k > 0)) return effects;
  return effects.map((e) => {
    const def = DEF.get(e.type);
    if (!def) return e;
    const lengths = def.params.filter((p) => p.type === 'number' && p.unit === 'px');
    if (lengths.length === 0) return e;
    // Resolve through paramsOf first: it folds in declared defaults and the
    // legacy `amount`, so a param the caller never set still scales.
    const params: Record<string, EffectParamValue> = { ...paramsOf(e) };
    for (const p of lengths) {
      const v = params[p.key];
      if (typeof v === 'number') params[p.key] = v * k;
    }
    return { ...e, params };
  });
}

/** The parameter legacy `amount` and legacy keyframe tracks refer to. */
export function primaryParamKey(type: EffectType): string | undefined {
  return DEF.get(type)?.params.find((p) => p.type === 'number')?.key;
}

/**
 * TEMPORAL effects: resolved in `buildSnapshot`'s time plumbing rather than as
 * a per-layer pixel pass.
 *
 * They change WHEN a layer is sampled, not what its pixels look like, so they
 * have no CSS form and no shader — and, unlike the Canvas2D-only family, must
 * NOT be routed through the pixel chain, where they would do nothing at all.
 * Echo emits ghost copies at past/future times; Posterize Time quantizes the
 * layer's clock.
 */
const TEMPORAL = new Set<string>(['echo', 'posterize-time']);

export function isTemporalEffect(type: string): boolean {
  return TEMPORAL.has(type);
}

/**
 * TIME-DEPENDENT effects: their DRAWN OUTPUT depends on the clock.
 *
 * A different thing from `TEMPORAL` above, and the distinction is the whole
 * reason both sets exist. A temporal effect changes WHEN the layer is sampled;
 * these draw something that differs frame to frame at a fixed sample. Echo is
 * the first kind, Timecode the second.
 *
 * ── Why this needs its own set, and why it is small ─────────────────────────
 *
 * The Canvas2D bake is cached by CONTENT HASH, which digests the effect stack.
 * That is what makes this workable without touching the cache: the resolved
 * time is written INTO the effect's params at snapshot time (see
 * `resolveEffectParams`), so the hash varies per frame for exactly the layers
 * carrying one of these — and for nothing else.
 *
 * Which is also why membership is expensive and the set must stay small. Adding
 * a type here opts every layer using it out of raster caching entirely: it
 * re-bakes every frame, by construction. That is correct for a timecode
 * burn-in, whose pixels genuinely differ each frame, and would be ruinous for
 * anything whose output is usually static.
 */
const TIME_DEPENDENT: ReadonlyMap<string, string> = new Map<string, string>([
  // type → the param the resolved layer time is written into.
  ['timecode', 'time'],
]);

export function isTimeDependentEffect(type: string): boolean {
  return TIME_DEPENDENT.has(type);
}

/** The param a time-dependent effect receives the clock through, if any. */
export function timeParamFor(type: string): string | undefined {
  return TIME_DEPENDENT.get(type);
}

/** An effect's params filled in from its definition's defaults. */
export function defaultParams(def: EffectDef): EffectParams {
  const out: Record<string, EffectParamValue> = {};
  for (const p of def.params) out[p.key] = p.default;
  return out;
}

/**
 * `#rrggbb` + 0..1 alpha → `rgba(r,g,b,a)`, for CSS filter functions.
 * Passes through anything already in a functional form.
 */
export function withAlpha(hex: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** A single-scalar effect — the common case (one amount, one CSS function). */
function scalar(
  type: EffectType,
  label: string,
  unit: string,
  min: number,
  max: number,
  def: number,
  css: (a: number) => string,
  extra: Partial<EffectDef> = {},
): EffectDef {
  return {
    type,
    label,
    params: [{ key: 'amount', label, type: 'number', unit, min, max, default: def }],
    css: (p) => css(num(p, 'amount', def)),
    ...extra,
  };
}

export const EFFECT_DEFS: EffectDef[] = [
  scalar('blur', 'Blur', 'px', 0, 40, 6, (a) => `blur(${a}px)`),

  // Glow: a colored halo at zero offset. The color used to be hardcoded
  // rgba(120,180,255,0.9) — a blue glow was the only glow this app could make.
  {
    type: 'glow',
    label: 'Glow',
    params: [
      { key: 'radius', label: 'Radius', type: 'number', unit: 'px', min: 0, max: 60, default: 16 },
      { key: 'color', label: 'Color', type: 'color', default: '#78b4ff' },
      { key: 'intensity', label: 'Intensity', type: 'number', unit: '%', min: 0, max: 100, default: 90 },
    ],
    css: (p) =>
      `drop-shadow(0 0 ${num(p, 'radius', 16)}px ${withAlpha(str(p, 'color', '#78b4ff'), num(p, 'intensity', 90) / 100)})`,
  },

  // Drop Shadow: a cast shadow. Distance and angle used to be derived from the
  // single amount (`a * 0.45` on both axes), so it could only ever fall at 45°.
  {
    type: 'drop-shadow',
    label: 'Drop Shadow',
    params: [
      { key: 'distance', label: 'Distance', type: 'number', unit: 'px', min: 0, max: 200, default: 6 },
      { key: 'angle', label: 'Angle', type: 'number', unit: '°', min: 0, max: 360, default: 135 },
      { key: 'softness', label: 'Softness', type: 'number', unit: 'px', min: 0, max: 100, default: 12 },
      { key: 'color', label: 'Color', type: 'color', default: '#000000' },
      { key: 'opacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 55 },
    ],
    css: (p) => {
      const d = num(p, 'distance', 6);
      const rad = (num(p, 'angle', 135) * Math.PI) / 180;
      const dx = (Math.cos(rad) * d).toFixed(1);
      const dy = (Math.sin(rad) * d).toFixed(1);
      const color = withAlpha(str(p, 'color', '#000000'), num(p, 'opacity', 55) / 100);
      return `drop-shadow(${dx}px ${dy}px ${num(p, 'softness', 12)}px ${color})`;
    },
  },

  scalar('brightness', 'Brightness', '%', 0, 300, 130, (a) => `brightness(${a / 100})`),
  scalar('contrast', 'Contrast', '%', 0, 300, 130, (a) => `contrast(${a / 100})`),
  scalar('saturate', 'Saturate', '%', 0, 300, 160, (a) => `saturate(${a / 100})`),
  scalar('grayscale', 'Grayscale', '%', 0, 100, 100, (a) => `grayscale(${a / 100})`),
  scalar('sepia', 'Sepia', '%', 0, 100, 80, (a) => `sepia(${a / 100})`),
  scalar('hue-rotate', 'Hue', '°', 0, 360, 90, (a) => `hue-rotate(${a}deg)`),

  // Hue/Saturation — AE's master H/S/L. On Canvas2D it composes CSS filters; on
  // the GPU path it composes the same transforms in effectColorMatrix, so both
  // backends match. Saturation/Lightness are −100..+100 (0 = no change).
  {
    type: 'inner-shadow',
    label: 'Inner Shadow',
    params: [
      { key: 'distance', label: 'Distance', type: 'number', unit: 'px', min: 0, max: 200, default: 6 },
      { key: 'angle', label: 'Angle', type: 'number', unit: '°', default: 135 },
      { key: 'softness', label: 'Softness', type: 'number', unit: 'px', min: 0, max: 100, default: 8 },
      { key: 'color', label: 'Color', type: 'color', default: '#000000' },
      { key: 'opacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 55 },
    ],
    css: () => '',
  },
  {
    type: 'inner-glow',
    label: 'Inner Glow',
    params: [
      { key: 'size', label: 'Size', type: 'number', unit: 'px', min: 0, max: 200, default: 14 },
      { key: 'color', label: 'Color', type: 'color', default: '#ffd070' },
      { key: 'opacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 80 },
    ],
    css: () => '',
  },
  {
    type: 'satin',
    label: 'Satin',
    params: [
      { key: 'distance', label: 'Distance', type: 'number', unit: 'px', min: 0, max: 200, default: 14 },
      { key: 'angle', label: 'Angle', type: 'number', unit: '°', default: 135 },
      { key: 'size', label: 'Size', type: 'number', unit: 'px', min: 0, max: 200, default: 16 },
      { key: 'color', label: 'Color', type: 'color', default: '#000000' },
      { key: 'opacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 45 },
      { key: 'invert', label: 'Invert', type: 'checkbox', default: false },
    ],
    css: () => '',
  },
  {
    type: 'bevel',
    label: 'Bevel & Emboss',
    params: [
      { key: 'size', label: 'Size', type: 'number', unit: 'px', min: 1, max: 100, default: 10 },
      { key: 'depth', label: 'Depth', type: 'number', unit: '%', min: 0, max: 500, default: 100 },
      { key: 'angle', label: 'Angle', type: 'number', unit: '°', default: 135 },
      { key: 'altitude', label: 'Altitude', type: 'number', unit: '°', min: 0, max: 90, default: 45 },
      { key: 'highlightColor', label: 'Highlight', type: 'color', default: '#ffffff' },
      { key: 'highlightOpacity', label: 'Highlight Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 75 },
      { key: 'shadowColor', label: 'Shadow', type: 'color', default: '#000000' },
      { key: 'shadowOpacity', label: 'Shadow Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 75 },
    ],
    css: () => '',
  },
  {
    type: 'directional-blur',
    label: 'Directional Blur',
    params: [
      { key: 'direction', label: 'Direction', type: 'number', unit: '°', default: 0 },
      { key: 'length', label: 'Length', type: 'number', unit: 'px', min: 0, max: 200, default: 20 },
    ],
    css: () => '',
  },
  {
    type: 'linear-wipe',
    label: 'Linear Wipe',
    params: [
      { key: 'completion', label: 'Transition Completion', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'wipeAngle', label: 'Wipe Angle', type: 'number', unit: '°', default: 90 },
      { key: 'feather', label: 'Feather', type: 'number', unit: 'px', min: 0, max: 200, default: 0 },
    ],
    css: () => '',
  },
  {
    type: 'transform',
    label: 'Transform',
    params: [
      { key: 'positionX', label: 'Position X', type: 'number', unit: 'px', default: 0 },
      { key: 'positionY', label: 'Position Y', type: 'number', unit: 'px', default: 0 },
      { key: 'scale', label: 'Scale', type: 'number', unit: '%', min: 0, max: 1000, default: 100 },
      { key: 'rotation', label: 'Rotation', type: 'number', unit: '°', default: 0 },
      { key: 'opacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
    ],
    css: () => '',
  },
  {
    type: 'posterize-time',
    label: 'Posterize Time',
    params: [
      { key: 'frameRate', label: 'Frame Rate', type: 'number', unit: 'fps', min: 1, max: 120, default: 12 },
    ],
    css: () => '',
  },

  // ── Blur family ────────────────────────────────────────────────────
  //
  // The generic `blur` above stays: it is the CSS-filter one, it renders on
  // every backend without a bake, and it is what the simple case should use.
  // These three are the AE effects by name, and each does something `blur`
  // cannot — per-axis dimensions, an iteration count, or a centre.
  {
    type: 'gaussian-blur',
    label: 'Gaussian Blur',
    params: [
      { key: 'blurriness', label: 'Blurriness', type: 'number', unit: 'px', min: 0, max: 500, default: 10 },
      // Stored as a number so it can be keyframed like everything else — 0 both,
      // 1 horizontal, 2 vertical. A string would not animate.
      { key: 'dimensions', label: 'Blur Dimensions', type: 'number', min: 0, max: 2, precision: 0, default: 0 },
      { key: 'repeatEdge', label: 'Repeat Edge Pixels', type: 'checkbox', default: true },
    ],
    css: () => '',
  },
  {
    type: 'fast-box-blur',
    label: 'Fast Box Blur',
    params: [
      { key: 'blurRadius', label: 'Blur Radius', type: 'number', unit: 'px', min: 0, max: 500, default: 10 },
      { key: 'iterations', label: 'Iterations', type: 'number', min: 1, max: 10, precision: 0, default: 1 },
      { key: 'dimensions', label: 'Blur Dimensions', type: 'number', min: 0, max: 2, precision: 0, default: 0 },
      { key: 'repeatEdge', label: 'Repeat Edge Pixels', type: 'checkbox', default: true },
    ],
    css: () => '',
  },
  {
    type: 'radial-blur',
    label: 'Radial Blur',
    params: [
      { key: 'amount', label: 'Amount', type: 'number', min: -360, max: 360, default: 10 },
      // 0 spin, 1 zoom. Same reasoning as Blur Dimensions above.
      { key: 'blurType', label: 'Type', type: 'number', min: 0, max: 1, precision: 0, default: 0 },
      // OFFSETS from the layer centre, not absolute coordinates. AE's default
      // centre is the middle of the layer, and an absolute pair would default to
      // (0,0) — the top-left corner — which spins the layer around a point off
      // its own edge and looks broken out of the box.
      { key: 'centerX', label: 'Centre X offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'centerY', label: 'Centre Y offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'quality', label: 'Quality', type: 'number', min: 2, max: 64, precision: 0, default: 16 },
    ],
    css: () => '',
  },

  // ── Stylize family ─────────────────────────────────────────────────
  {
    type: 'mosaic',
    label: 'Mosaic',
    params: [
      // COUNTS across the layer, as in AE — not a cell size in px. That is what
      // makes the effect resolution-independent: the same numbers give the same
      // look at 1080p and 4K.
      { key: 'horizontalBlocks', label: 'Horizontal Blocks', type: 'number', min: 1, max: 500, precision: 0, default: 20 },
      { key: 'verticalBlocks', label: 'Vertical Blocks', type: 'number', min: 1, max: 500, precision: 0, default: 20 },
      { key: 'sharpColors', label: 'Sharp Colors', type: 'checkbox', default: false },
    ],
    css: () => '',
  },
  {
    type: 'find-edges',
    label: 'Find Edges',
    params: [
      // Default TRUE: AE's default output is dark edges on white, and that is
      // the look the effect's name means to people. The un-inverted form reads
      // as a different effect.
      { key: 'invert', label: 'Invert', type: 'checkbox', default: true },
      { key: 'blendWithOriginal', label: 'Blend With Original', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    type: 'roughen-edges',
    label: 'Roughen Edges',
    params: [
      { key: 'border', label: 'Border', type: 'number', unit: 'px', min: 0, max: 200, default: 12 },
      { key: 'edgeSharpness', label: 'Edge Sharpness', type: 'number', min: 0, max: 10, default: 1 },
      { key: 'scale', label: 'Scale', type: 'number', unit: '%', min: 1, max: 1000, default: 100 },
      { key: 'complexity', label: 'Complexity', type: 'number', min: 1, max: 6, precision: 0, default: 2 },
      // Keyframe this to churn the noise. Wall-clock time is deliberately never
      // read by any effect in this module — motion comes from a keyframe, which
      // is what keeps them deterministic and scrub-stable.
      { key: 'evolution', label: 'Evolution', type: 'number', unit: '°', min: -36000, max: 36000, default: 0 },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 9999, precision: 0, default: 1 },
    ],
    css: () => '',
  },

  // ── Colour family ──────────────────────────────────────────────────
  //
  // Exposure is a LUT effect (see colorLut.ts), NOT a Canvas2D pixel pass: it is
  // a per-channel transfer function, so it renders on both backends with no
  // bake. Vibrance and Colorama read all three channels to decide what to do
  // with a pixel, which no per-channel table can express, so those two are
  // pixel passes.
  {
    type: 'exposure',
    label: 'Exposure',
    params: [
      // STOPS, like a camera — +1 doubles the light. That multiplicative
      // behaviour is the whole reason to reach for this over Brightness, which
      // is additive and washes the blacks up off zero.
      { key: 'exposure', label: 'Exposure', type: 'number', unit: 'stops', min: -20, max: 20, precision: 2, default: 0 },
      { key: 'offset', label: 'Offset', type: 'number', min: -1, max: 1, precision: 3, default: 0 },
      { key: 'gammaCorrection', label: 'Gamma Correction', type: 'number', min: 0.01, max: 10, precision: 2, default: 1 },
    ],
    css: () => '',
  },
  {
    type: 'vibrance',
    label: 'Vibrance',
    params: [
      // Weighted by how far the pixel already is from grey, which is what makes
      // it different from Saturation and what protects skin tones.
      { key: 'vibrance', label: 'Vibrance', type: 'number', min: -100, max: 100, default: 30 },
      { key: 'saturation', label: 'Saturation', type: 'number', min: -100, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    type: 'colorama',
    label: 'Colorama',
    params: [
      // Index into COLORAMA_PALETTES. A number so it can be keyframed, and the
      // indices are STABLE — new palettes go on the end, because inserting into
      // the middle would silently re-map every saved project.
      { key: 'palette', label: 'Output Cycle', type: 'number', min: 0, max: 4, precision: 0, default: 0 },
      // The signature control: one keyframe here cycles the palette through the
      // image. The cycle wraps, so the animation loops seamlessly.
      { key: 'phaseShift', label: 'Phase Shift', type: 'number', unit: '°', min: -36000, max: 36000, default: 0 },
      { key: 'cycleRepetitions', label: 'Cycle Repetitions', type: 'number', min: 0.1, max: 20, precision: 2, default: 1 },
      { key: 'blendWithOriginal', label: 'Blend With Original', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
    ],
    css: () => '',
  },

  // ── Matte / keying family ──────────────────────────────────────────
  //
  // Set Matte is the one with structural reach, and is NOT a Canvas2D pass: it
  // reads ANOTHER LAYER's pixels, which the bake chain's `(oc, w, h, effect)`
  // signature cannot express at all. It follows the `displacement-map`
  // precedent — a GPU material with the source layer bound as a second texture.
  {
    type: 'set-matte',
    label: 'Set Matte',
    params: [
      { key: 'matteLayerId', label: 'Take Matte From Layer', type: 'layer', default: '' },
      // Checkboxes, and they MUST be read as booleans — `effectNumber` returns 0
      // for one, so reading these through it gives a control that persists,
      // keyframes, and does nothing. See snapshotToFrameScene.
      { key: 'useLuminance', label: 'Use Luminance', type: 'checkbox', default: false },
      { key: 'invert', label: 'Invert Matte', type: 'checkbox', default: false },
    ],
    css: () => '',
    // A real shader pass with no CSS or Canvas2D equivalent — the bake chain is
    // handed one layer's buffer and could not reach the matte layer even in
    // principle. Marking it means the UI SAYS it does nothing on the Canvas2D
    // backend rather than offering it as though it worked, which is the whole
    // reason this flag exists. It also satisfies the EFFECT_DEFS classification
    // test, which is what caught the omission.
    gpuOnly: true,
  },
  {
    type: 'simple-choker',
    label: 'Simple Choker',
    params: [
      // Positive chokes the matte inward, negative spreads it outward. The
      // control people reach for immediately after any key, to eat the fringe.
      { key: 'chokeAmount', label: 'Choke Matte', type: 'number', unit: 'px', min: -50, max: 50, precision: 1, default: 1 },
    ],
    css: () => '',
  },
  {
    type: 'linear-color-key',
    label: 'Linear Color Key',
    params: [
      { key: 'keyColor', label: 'Key Color', type: 'color', default: '#00ff00' },
      // 0 = RGB distance, 1 = hue, 2 = chroma. A number so it can be keyframed.
      { key: 'matchOn', label: 'Match Colors', type: 'number', min: 0, max: 2, precision: 0, default: 0 },
      { key: 'tolerance', label: 'Matching Tolerance', type: 'number', unit: '%', min: 0, max: 100, default: 20 },
      { key: 'softness', label: 'Matching Softness', type: 'number', unit: '%', min: 0, max: 100, default: 10 },
      // AE's Key Colors / Keep Colors. Keeping only what matched is how this
      // effect gets used as a selective colour isolator.
      { key: 'keepMatched', label: 'Keep Matched Instead', type: 'checkbox', default: false },
    ],
    css: () => '',
  },
  {
    type: 'shift-channels',
    label: 'Shift Channels',
    params: [
      // Each output channel picks a SOURCE: 0 alpha, 1 red, 2 green, 3 blue,
      // 4 luminance, 5 full-on, 6 full-off. The defaults are the identity.
      { key: 'takeAlphaFrom', label: 'Take Alpha From', type: 'number', min: 0, max: 6, precision: 0, default: 0 },
      { key: 'takeRedFrom', label: 'Take Red From', type: 'number', min: 0, max: 6, precision: 0, default: 1 },
      { key: 'takeGreenFrom', label: 'Take Green From', type: 'number', min: 0, max: 6, precision: 0, default: 2 },
      { key: 'takeBlueFrom', label: 'Take Blue From', type: 'number', min: 0, max: 6, precision: 0, default: 3 },
    ],
    css: () => '',
  },

  // ── Transition family ──────────────────────────────────────────────
  //
  // All three are alpha-only reveals driven by `completion`, matching the
  // existing `linear-wipe`: one keyframe 0 → 100 is the whole effect, and every
  // other parameter is a static look choice. They ERASE rather than composite —
  // what shows through underneath is the compositor's business.
  {
    type: 'venetian-blinds',
    label: 'Venetian Blinds',
    params: [
      { key: 'completion', label: 'Transition Completion', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'direction', label: 'Direction', type: 'number', unit: '°', min: -360, max: 360, default: 0 },
      { key: 'width', label: 'Width', type: 'number', unit: 'px', min: 1, max: 500, default: 30 },
      { key: 'feather', label: 'Feather', type: 'number', unit: 'px', min: 0, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    type: 'gradient-wipe',
    label: 'Gradient Wipe',
    params: [
      { key: 'completion', label: 'Transition Completion', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      // NO "Gradient Layer" control, deliberately. AE lets you nominate another
      // layer as the map; this runs on the Canvas2D bake path, which is handed
      // one layer's buffer and cannot reach a sibling — the same wall Set Matte
      // hit. Shipping the control anyway would give a picker that persists,
      // keyframes and does nothing, which is precisely the failure this codebase
      // keeps finding. The wipe is driven by the LAYER'S OWN luminance, which is
      // also AE's behaviour when no map is chosen, so pairing it with a Ramp or
      // Fractal Noise below it in the stack gives the full effect.
      { key: 'softness', label: 'Transition Softness', type: 'number', unit: '%', min: 0, max: 100, default: 20 },
      { key: 'invertGradient', label: 'Invert Gradient', type: 'checkbox', default: false },
    ],
    css: () => '',
  },
  {
    type: 'card-wipe',
    label: 'Card Wipe',
    params: [
      { key: 'completion', label: 'Transition Completion', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'rows', label: 'Rows', type: 'number', min: 1, max: 100, precision: 0, default: 6 },
      { key: 'columns', label: 'Columns', type: 'number', min: 1, max: 100, precision: 0, default: 8 },
      // 0 right, 1 left, 2 down, 3 up, 4 radial. A number so it keyframes.
      { key: 'flipOrder', label: 'Flip Order', type: 'number', min: 0, max: 4, precision: 0, default: 0 },
    ],
    css: () => '',
  },

  // ── Generate / Text families ───────────────────────────────────────
  {
    type: 'lens-flare',
    label: 'Lens Flare',
    params: [
      { key: 'centerX', label: 'Flare Centre X', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'centerY', label: 'Flare Centre Y', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'brightness', label: 'Flare Brightness', type: 'number', unit: '%', min: 0, max: 100, default: 60 },
      { key: 'scale', label: 'Scale', type: 'number', min: 0.05, max: 5, precision: 2, default: 1 },
      { key: 'color', label: 'Flare Colour', type: 'color', default: '#ffd9a0' },
    ],
    css: () => '',
  },
  {
    type: 'numbers',
    label: 'Numbers',
    params: [
      // The VALUE is a keyframeable parameter, which is what makes this a real
      // counter: two keyframes and it counts. It deliberately does not read the
      // composition clock — see `timecode` below for why that is a much larger
      // change than it looks.
      { key: 'value', label: 'Value', type: 'number', min: -1e9, max: 1e9, precision: 3, default: 0 },
      { key: 'decimals', label: 'Decimal Places', type: 'number', min: 0, max: 10, precision: 0, default: 0 },
      { key: 'padTo', label: 'Pad To Digits', type: 'number', min: 0, max: 20, precision: 0, default: 0 },
      { key: 'useCommas', label: 'Thousands Separator', type: 'checkbox', default: false },
      { key: 'positionX', label: 'Position X', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'positionY', label: 'Position Y', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'size', label: 'Size', type: 'number', unit: 'px', min: 1, max: 800, default: 48 },
      { key: 'color', label: 'Fill Colour', type: 'color', default: '#ffffff' },
      { key: 'showBox', label: 'Composite On Box', type: 'checkbox', default: false },
      { key: 'boxColor', label: 'Box Colour', type: 'color', default: '#000000' },
    ],
    css: () => '',
  },
  {
    type: 'timecode',
    label: 'Timecode',
    params: [
      /**
       * Follows the layer's own clock by default — the burn-in case, and what
       * anyone adding a Timecode expects.
       *
       * The mechanism is worth knowing because it constrains what else can join
       * it: the resolved time is written into `time` at SNAPSHOT time
       * (`resolveEffectParams`), so everything below stays a pure function of
       * params. That keeps preview and export identical, and it makes the
       * content hash vary per frame for this layer — which is correct here, and
       * is also why `TIME_DEPENDENT` must stay a very short list: membership
       * opts a layer out of raster caching by construction.
       *
       * Turn the follow off and `time` becomes an ordinary keyframeable value,
       * for an offset readout or a countdown.
       */
      { key: 'followCompTime', label: 'Follow Timeline', type: 'checkbox', default: true },
      { key: 'time', label: 'Time', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
      { key: 'fps', label: 'Frame Rate', type: 'number', unit: 'fps', min: 1, max: 240, precision: 0, default: 24 },
      { key: 'dropFrame', label: 'Drop Frame', type: 'checkbox', default: false },
      { key: 'positionX', label: 'Position X', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'positionY', label: 'Position Y', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'size', label: 'Size', type: 'number', unit: 'px', min: 1, max: 800, default: 40 },
      { key: 'color', label: 'Fill Colour', type: 'color', default: '#ffffff' },
      { key: 'showBox', label: 'Composite On Box', type: 'checkbox', default: true },
      { key: 'boxColor', label: 'Box Colour', type: 'color', default: '#000000' },
    ],
    css: () => '',
  },
  {
    type: 'audio-spectrum',
    label: 'Audio Spectrum',
    params: [
      // The referenced audio layer. Unset → a silent (all-zero) spectrum rather
      // than an error, so the effect is inert while the user is still choosing.
      { key: 'audioLayerId', label: 'Audio Layer', type: 'layer', default: '' },
      { key: 'bands', label: 'Frequency Bands', type: 'number', min: 1, max: 128, precision: 0, default: 32 },
      { key: 'startFreq', label: 'Start Frequency', type: 'number', unit: 'Hz', min: 20, max: 20000, precision: 0, default: 40 },
      { key: 'endFreq', label: 'End Frequency', type: 'number', unit: 'Hz', min: 20, max: 20000, precision: 0, default: 16000 },
      { key: 'maxHeight', label: 'Maximum Height', type: 'number', unit: 'px', min: 1, max: 4000, default: 200 },
      { key: 'thickness', label: 'Thickness', type: 'number', unit: 'px', min: 1, max: 200, default: 8 },
      // 0 bars, 1 line, 2 mirrored bars.
      { key: 'displayMode', label: 'Display Mode', type: 'number', min: 0, max: 2, precision: 0, default: 0 },
      { key: 'insideColor', label: 'Inside Colour', type: 'color', default: '#00e5ff' },
      { key: 'outsideColor', label: 'Outside Colour', type: 'color', default: '#0066ff' },
      /**
       * RESOLVED, not authored. `buildSnapshot` writes the analysed band
       * magnitudes here (see core/audio/audioSpectrum.ts) so the drawing kernel
       * stays a pure function of its params — which is what keeps preview and
       * export identical and makes the content hash meaningful.
       *
       * Hidden from the inspector by `type: 'number'` being absent: it has no
       * declared control, so nothing renders an editor for it.
       */
      { key: 'magnitudes', label: 'Magnitudes (resolved)', type: 'resolved', default: [] },
    ],
    css: () => '',
  },
  {
    type: 'hue-saturation',
    label: 'Hue/Saturation',
    params: [
      { key: 'hue', label: 'Master Hue', type: 'number', unit: '°', min: -180, max: 180, default: 0 },
      { key: 'saturation', label: 'Master Saturation', type: 'number', min: -100, max: 100, default: 0 },
      { key: 'lightness', label: 'Master Lightness', type: 'number', min: -100, max: 100, default: 0 },
    ],
    css: (p) => {
      const parts: string[] = [];
      const hue = num(p, 'hue', 0);
      if (hue) parts.push(`hue-rotate(${hue}deg)`);
      // −100..+100 → CSS saturate 0..2 and brightness 0..2.
      parts.push(`saturate(${(100 + num(p, 'saturation', 0)) / 100})`);
      parts.push(`brightness(${(100 + num(p, 'lightness', 0)) / 100})`);
      return parts.join(' ');
    },
  },

  scalar('invert', 'Invert', '%', 0, 100, 100, (a) => `invert(${a / 100})`),

  // Levels: black/white input points, gamma (midtones), and output range.
  // Non-affine per-channel remap, so it renders through a LUT pass, not CSS —
  // css:'' means the Canvas2D backend applies it per-pixel (see Canvas2DBackend).
  {
    type: 'levels',
    label: 'Levels',
    params: [
      { key: 'inputBlack', label: 'Input Black', type: 'number', min: 0, max: 255, default: 0 },
      { key: 'inputWhite', label: 'Input White', type: 'number', min: 0, max: 255, default: 255 },
      { key: 'gamma', label: 'Gamma', type: 'number', min: 0.1, max: 10, precision: 2, default: 1 },
      { key: 'outputBlack', label: 'Output Black', type: 'number', min: 0, max: 255, default: 0 },
      { key: 'outputWhite', label: 'Output White', type: 'number', min: 0, max: 255, default: 255 },
    ],
    css: () => '',
  },

  // Curves: a tone curve through draggable control points. Per-channel LUT, so
  // it renders through the same Canvas2D pixel pass as Levels (css is empty).
  {
    type: 'curves',
    label: 'Curves',
    // Composite first, then the three channels — the order `curvesTables`
    // composes them in, and the order the inspector should read top to bottom.
    // A channel left at its identity ramp is skipped, so the common case (an
    // RGB curve and nothing else) costs exactly what it did before.
    params: [
      { key: 'points', label: 'RGB', type: 'curve', default: [[0, 0], [255, 255]] },
      { key: 'redPoints', label: 'Red', type: 'curve', default: [[0, 0], [255, 255]] },
      { key: 'greenPoints', label: 'Green', type: 'curve', default: [[0, 0], [255, 255]] },
      { key: 'bluePoints', label: 'Blue', type: 'curve', default: [[0, 0], [255, 255]] },
    ],
    css: () => '',
  },

  // Lumetri Basic Correction: the eight controls a colourist reaches for first,
  // in one effect. A per-channel LUT (see colorLut.ts for why all eight qualify),
  // so it costs no bake on either backend — which matters for this one more than
  // most, because it is switched on for the whole comp and left there.
  {
    type: 'lumetri',
    label: 'Lumetri Color',
    params: [
      { key: 'exposure', label: 'Exposure', type: 'number', unit: 'stops', min: -5, max: 5, precision: 2, default: 0 },
      { key: 'contrast', label: 'Contrast', type: 'number', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'highlights', label: 'Highlights', type: 'number', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'shadows', label: 'Shadows', type: 'number', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'whites', label: 'Whites', type: 'number', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'blacks', label: 'Blacks', type: 'number', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'temperature', label: 'Temperature', type: 'number', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'tint', label: 'Tint', type: 'number', unit: '%', min: -100, max: 100, default: 0 },
    ],
    css: () => '',
  },

  // Selective Colour: shift the CMYK make-up of ONE colour range per instance.
  //
  // AE keeps all nine ranges inside one effect behind a dropdown that swaps the
  // visible sliders. This param model is flat and the inspector generates rows
  // straight from `params`, so nine ranges in one effect would mean 36 sliders
  // stacked in a column — every one of them live, only four of them meaningful.
  // One range per instance instead: stack two copies to grade two ranges, which
  // is also what makes each range's four values independently keyframeable.
  {
    type: 'selective-color',
    label: 'Selective Color',
    params: [
      // 0 reds, 1 yellows, 2 greens, 3 cyans, 4 blues, 5 magentas,
      // 6 whites, 7 neutrals, 8 blacks. A number so it keyframes.
      { key: 'range', label: 'Colors', type: 'number', min: 0, max: 8, precision: 0, default: 0 },
      { key: 'cyan', label: 'Cyan', type: 'number', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'magenta', label: 'Magenta', type: 'number', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'yellow', label: 'Yellow', type: 'number', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'black', label: 'Black', type: 'number', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'absolute', label: 'Absolute', type: 'checkbox', default: false },
    ],
    css: () => '',
  },

  // Shadow/Highlight: a LOCAL tone correction — how far a pixel moves depends
  // on its neighbourhood's brightness, not its own. Spatial, so it can never be
  // a LUT and always forces the bake.
  {
    type: 'shadow-highlight',
    label: 'Shadow/Highlight',
    params: [
      { key: 'shadowAmount', label: 'Shadow Amount', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'highlightAmount', label: 'Highlight Amount', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'radius', label: 'Radius', type: 'number', unit: 'px', min: 0, max: 200, default: 30 },
      { key: 'tonalWidth', label: 'Tonal Width', type: 'number', unit: '%', min: 1, max: 100, default: 50 },
    ],
    css: () => '',
  },

  // ── Distort family ─────────────────────────────────────────────────
  //
  // Radii are in LAYER pixels, not percentages, and are declared `px` so
  // `scaleEffectLengths` carries them through the raster-scale bake. A
  // percentage radius would resize with the layer, which is wrong for a control
  // meant to sit over a fixed feature of the image.
  //
  // Centres are OFFSETS FROM THE LAYER CENTRE, for the same reason Corner Pin's
  // corners are offsets — see the long note there. The static default table
  // cannot see the layer, so an absolute centre would default to 0,0, putting
  // every new Bulge in the top-left corner with most of its disc off the layer.
  // Offsetting from the centre makes the default the useful one.
  {
    type: 'bulge',
    label: 'Bulge',
    params: [
      { key: 'centerX', label: 'Centre X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'centerY', label: 'Centre Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'radius', label: 'Radius', type: 'number', unit: 'px', min: 0, max: 4000, default: 120 },
      // Negative pinches. The pair in one control is how AE presents it, and it
      // keyframes through zero cleanly — which two separate controls would not.
      { key: 'height', label: 'Bulge Height', type: 'number', unit: '%', min: -100, max: 100, default: 50 },
    ],
    css: () => '',
  },
  {
    type: 'twirl',
    label: 'Twirl',
    params: [
      { key: 'centerX', label: 'Centre X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'centerY', label: 'Centre Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'radius', label: 'Radius', type: 'number', unit: 'px', min: 0, max: 4000, default: 120 },
      // Beyond ±360 deliberately: a multi-turn twirl is a real look, and
      // clamping at one turn would make the keyframed spin stop dead.
      { key: 'angle', label: 'Angle', type: 'number', unit: '°', min: -1440, max: 1440, default: 90 },
    ],
    css: () => '',
  },
  {
    type: 'spherize',
    label: 'Spherize',
    params: [
      { key: 'centerX', label: 'Centre X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'centerY', label: 'Centre Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'radius', label: 'Radius', type: 'number', unit: 'px', min: 0, max: 4000, default: 120 },
      { key: 'amount', label: 'Amount', type: 'number', unit: '%', min: -100, max: 100, default: 60 },
    ],
    css: () => '',
  },
  // Corner Pin: a PROJECTIVE map, which is what separates it from the Transform
  // effect — that one is affine and can never produce perspective.
  //
  // ── Why these are OFFSETS and not absolute positions ──────────────────────
  //
  // AE states corner pins as absolute points, which it can do because it seeds
  // them from the layer's size when you apply the effect. This param model has
  // a STATIC default table that cannot see the layer, so absolute positions
  // would all have to default to 0 — a quad collapsed to a point, i.e. a layer
  // that vanishes the instant the effect is added.
  //
  // The obvious patch is a sentinel ("all eight zero means untouched"), and it
  // is a trap: the moment the user drags ONE corner off zero the other seven
  // are still zero, the sentinel stops applying, and the layer collapses
  // anyway. Worse, it makes 0 mean two different things depending on its
  // neighbours.
  //
  // Offsets from the natural rectangle remove the problem rather than manage
  // it. Zero is genuinely the identity, every value means exactly one thing,
  // and each corner is independently keyframeable from a resting state — which
  // absolute positions seeded at apply time never would be.
  {
    type: 'corner-pin',
    label: 'Corner Pin',
    params: [
      { key: 'topLeftX', label: 'Top Left X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'topLeftY', label: 'Top Left Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'topRightX', label: 'Top Right X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'topRightY', label: 'Top Right Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'bottomRightX', label: 'Bottom Right X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'bottomRightY', label: 'Bottom Right Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'bottomLeftX', label: 'Bottom Left X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'bottomLeftY', label: 'Bottom Left Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
    ],
    css: () => '',
  },

  // Bezier Warp — Corner Pin with curved edges.
  //
  // Twelve control points: the four vertices plus two tangent handles per edge,
  // named around the perimeter clockwise from the top-left so the inspector
  // rows read in the order you would drag them.
  //
  // OFFSETS from the rest rectangle, all defaulting to 0, exactly as Corner Pin
  // does — which makes the default effect the identity and lets the dispatch
  // skip the resample entirely rather than paying a bilinear pass to reproduce
  // its own input.
  {
    type: 'bezier-warp',
    label: 'Bezier Warp',
    params: [
      { key: 'topLeftX', label: 'Top Left Vertex X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'topLeftY', label: 'Top Left Vertex Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'top1X', label: 'Top Tangent 1 X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'top1Y', label: 'Top Tangent 1 Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'top2X', label: 'Top Tangent 2 X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'top2Y', label: 'Top Tangent 2 Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'topRightX', label: 'Top Right Vertex X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'topRightY', label: 'Top Right Vertex Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'right1X', label: 'Right Tangent 1 X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'right1Y', label: 'Right Tangent 1 Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'right2X', label: 'Right Tangent 2 X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'right2Y', label: 'Right Tangent 2 Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'bottomRightX', label: 'Bottom Right Vertex X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'bottomRightY', label: 'Bottom Right Vertex Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'bottom1X', label: 'Bottom Tangent 1 X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'bottom1Y', label: 'Bottom Tangent 1 Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'bottom2X', label: 'Bottom Tangent 2 X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'bottom2Y', label: 'Bottom Tangent 2 Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'bottomLeftX', label: 'Bottom Left Vertex X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'bottomLeftY', label: 'Bottom Left Vertex Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'left1X', label: 'Left Tangent 1 X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'left1Y', label: 'Left Tangent 1 Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'left2X', label: 'Left Tangent 2 X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'left2Y', label: 'Left Tangent 2 Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
    ],
    css: () => '',
  },
  // ── Generate family, round two ──────────────────────────────────────
  //
  // All three composite with 'source-atop', so the pattern fills the layer's
  // own alpha rather than covering it with a rectangle — a checkerboard inside
  // your text, not over it. Same choice `proceduralCanvas2d` made for Gradient
  // Ramp, matched deliberately so the family behaves alike.
  {
    type: 'checkerboard',
    label: 'Checkerboard',
    params: [
      { key: 'width', label: 'Width', type: 'number', unit: 'px', min: 1, max: 2000, default: 32 },
      { key: 'height', label: 'Height', type: 'number', unit: 'px', min: 1, max: 2000, default: 32 },
      // Shifts the lattice, not the layer — keyframe it to slide the pattern
      // underneath static content.
      { key: 'anchorX', label: 'Anchor X', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'anchorY', label: 'Anchor Y', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'colorA', label: 'Color A', type: 'color', default: '#000000' },
      { key: 'colorB', label: 'Color B', type: 'color', default: '#ffffff' },
      { key: 'opacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
    ],
    css: () => '',
  },
  {
    type: 'grid',
    label: 'Grid',
    params: [
      { key: 'width', label: 'Width', type: 'number', unit: 'px', min: 1, max: 2000, default: 48 },
      { key: 'height', label: 'Height', type: 'number', unit: 'px', min: 1, max: 2000, default: 48 },
      { key: 'anchorX', label: 'Anchor X', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'anchorY', label: 'Anchor Y', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'thickness', label: 'Border', type: 'number', unit: 'px', min: 0, max: 200, default: 2 },
      { key: 'color', label: 'Color', type: 'color', default: '#ffffff' },
      { key: 'opacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
    ],
    css: () => '',
  },
  // Vegas — the one generator whose geometry comes from the LAYER. Its params
  // are all defined in ARC LENGTH around the alpha contour, which is why
  // `rotation` is a full lap per 360 degrees regardless of the shape: a linear
  // keyframe on it is a constant-speed chase around anything.
  {
    type: 'vegas',
    label: 'Vegas',
    params: [
      { key: 'segments', label: 'Segments', type: 'number', unit: '', min: 1, max: 200, default: 3 },
      // Percent of each light's own SLOT, not of the whole perimeter, so
      // changing the count does not also change how long each light is.
      { key: 'length', label: 'Length', type: 'number', unit: '%', min: 0, max: 100, default: 40 },
      // The animated one. A full lap per 360 degrees.
      { key: 'rotation', label: 'Rotation', type: 'number', unit: '°', min: -3600, max: 3600, default: 0 },
      { key: 'width', label: 'Width', type: 'number', unit: 'px', min: 0.1, max: 200, default: 6 },
      { key: 'hardness', label: 'Hardness', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      // Where the contour is cut. Clamped away from both ends in `drawVegas`:
      // at 0 every pixel counts as inside and there is no edge to trace, at 255
      // an antialiased shape contours along its own interior.
      { key: 'threshold', label: 'Threshold', type: 'number', unit: '', min: 1, max: 254, default: 128 },
      { key: 'color', label: 'Color', type: 'color', default: '#ffffff' },
      { key: 'opacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
    ],
    css: () => '',
  },
  // Cell Pattern: Worley (cellular) noise. `membrane` switches between the two
  // readings of the same field — F1 gives blobs, F2−F1 gives the crystalline
  // look. They look nothing alike, so exposing one without the other would ship
  // half the effect.
  {
    type: 'cell-pattern',
    label: 'Cell Pattern',
    params: [
      { key: 'size', label: 'Size', type: 'number', unit: 'px', min: 2, max: 500, default: 40 },
      { key: 'evolution', label: 'Evolution', type: 'number', min: -1000, max: 1000, precision: 2, default: 0 },
      { key: 'contrast', label: 'Contrast', type: 'number', unit: '%', min: 1, max: 500, default: 100 },
      { key: 'membrane', label: 'Crystalline', type: 'checkbox', default: false },
      { key: 'invert', label: 'Invert', type: 'checkbox', default: false },
    ],
    css: () => '',
  },

  // ── Noise family ─────────────────────────────────────────────────────
  //
  // Turbulent Noise is NOT a preset of Fractal Noise: it sums the ABSOLUTE
  // value of each octave, and folding at zero creases the field wherever it
  // changes sign. Those creases are the wispy filaments, and no Fractal Noise
  // setting produces them.
  {
    type: 'turbulent-noise',
    label: 'Turbulent Noise',
    params: [
      { key: 'scale', label: 'Scale', type: 'number', unit: 'px', min: 1, max: 2000, default: 80 },
      { key: 'complexity', label: 'Complexity', type: 'number', min: 1, max: 8, precision: 0, default: 4 },
      { key: 'evolution', label: 'Evolution', type: 'number', min: -1000, max: 1000, precision: 2, default: 0 },
      { key: 'contrast', label: 'Contrast', type: 'number', unit: '%', min: 1, max: 500, default: 120 },
      { key: 'brightness', label: 'Brightness', type: 'number', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'invert', label: 'Invert', type: 'checkbox', default: false },
    ],
    css: () => '',
  },
  // Add Grain is not the existing `noise` effect with a new label: grain is
  // luminance-dependent (peaking in the midtones, vanishing at both ends) and
  // has a SIZE. Uniform noise has neither, which is why it reads as digital
  // dirt rather than film.
  {
    type: 'add-grain',
    label: 'Add Grain',
    params: [
      { key: 'intensity', label: 'Intensity', type: 'number', unit: '%', min: 0, max: 100, default: 30 },
      { key: 'size', label: 'Size', type: 'number', unit: 'px', min: 0.1, max: 20, precision: 2, default: 1 },
      // 0 = monochrome grain (the film default); 100 = independent per channel.
      { key: 'saturation', label: 'Saturation', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'seed', label: 'Seed', type: 'number', min: 0, max: 10000, precision: 0, default: 0 },
    ],
    css: () => '',
  },
  // Median is a RANK filter, which is why it sits beside the blurs rather than
  // among them: it removes speckle while leaving edges sharp, and no linear
  // filter can do both. Radius capped at 8 (17×17, 289 samples/pixel) so it
  // cannot lock up the bake.
  {
    type: 'median',
    label: 'Median',
    params: [
      { key: 'radius', label: 'Radius', type: 'number', unit: 'px', min: 0, max: 8, precision: 0, default: 2 },
    ],
    css: () => '',
  },

  // Posterize: quantise each channel to N output levels (per-channel LUT, so it
  // renders through the Canvas2D pixel pass like Levels/Curves; css:'').
  {
    type: 'posterize',
    label: 'Posterize',
    params: [{ key: 'levels', label: 'Levels', type: 'number', min: 2, max: 255, default: 6 }],
    css: () => '',
  },

  // Tint: remap black→mapBlack and white→mapWhite along luminance, blended by
  // Amount. It's an affine colour transform (a 3×3 matrix + offset), so it
  // renders on BOTH backends — GPU via effectColorMatrix, Canvas2D via the
  // per-pixel matrix pass (css:'' routes it there, not to a CSS filter).
  {
    type: 'tint',
    label: 'Tint',
    params: [
      { key: 'mapBlack', label: 'Map Black To', type: 'color', default: '#000000' },
      { key: 'mapWhite', label: 'Map White To', type: 'color', default: '#ffffff' },
      { key: 'amount', label: 'Amount to Tint', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
    ],
    css: () => '',
  },

  // Channel Mixer: each output channel is a weighted sum of the input channels
  // (percentages) plus a constant — an affine transform, so both backends
  // render it (matrix pass on Canvas2D, effectColorMatrix on GPU).
  {
    type: 'channel-mixer',
    label: 'Channel Mixer',
    params: [
      { key: 'redRed', label: 'Red → Red', type: 'number', unit: '%', min: -200, max: 200, default: 100 },
      { key: 'redGreen', label: 'Green → Red', type: 'number', unit: '%', min: -200, max: 200, default: 0 },
      { key: 'redBlue', label: 'Blue → Red', type: 'number', unit: '%', min: -200, max: 200, default: 0 },
      { key: 'redConst', label: 'Red Const', type: 'number', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'greenRed', label: 'Red → Green', type: 'number', unit: '%', min: -200, max: 200, default: 0 },
      { key: 'greenGreen', label: 'Green → Green', type: 'number', unit: '%', min: -200, max: 200, default: 100 },
      { key: 'greenBlue', label: 'Blue → Green', type: 'number', unit: '%', min: -200, max: 200, default: 0 },
      { key: 'greenConst', label: 'Green Const', type: 'number', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'blueRed', label: 'Red → Blue', type: 'number', unit: '%', min: -200, max: 200, default: 0 },
      { key: 'blueGreen', label: 'Green → Blue', type: 'number', unit: '%', min: -200, max: 200, default: 0 },
      { key: 'blueBlue', label: 'Blue → Blue', type: 'number', unit: '%', min: -200, max: 200, default: 100 },
      { key: 'blueConst', label: 'Blue Const', type: 'number', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'monochrome', label: 'Monochrome', type: 'checkbox', default: false },
    ],
    css: () => '',
  },

  // Gradient Ramp's colors were hardcoded red→blue in snapshotToFrameScene and
  // completely unreachable from the UI.
  {
    type: 'gradient-ramp',
    label: 'Gradient Ramp',
    // Canvas2D fallback in proceduralCanvas2d.ts — no longer GPU-only.
    params: [
      { key: 'blend', label: 'Blend', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'colorA', label: 'Start', type: 'color', default: '#ff0000' },
      { key: 'colorB', label: 'End', type: 'color', default: '#0000ff' },
      { key: 'angle', label: 'Angle', type: 'number', unit: '°', default: 90 },
    ],
    css: () => '',
  },
  {
    type: 'fractal-noise',
    label: 'Fractal Noise',
    // Canvas2D fallback in proceduralCanvas2d.ts — no longer GPU-only.
    params: [{ key: 'scale', label: 'Scale', type: 'number', unit: 'x', min: 1, max: 50, default: 10 }],
    css: () => '',
  },
  {
    type: 'displacement-map',
    label: 'Displace',
    gpuOnly: true,
    params: [
      { key: 'amount', label: 'Amount', type: 'number', unit: 'px', min: -100, max: 100, default: 20 },
      // The layer whose pixels drive the displacement (AE's Displacement Map
      // Layer). '' = unset → the layer displaces by its own content (legacy).
      { key: 'mapLayerId', label: 'Map Layer', type: 'layer', default: '' },
    ],
    css: () => '',
  },
  {
    type: 'motion-tile',
    label: 'Motion Tile',
    gpuOnly: true,
    params: [{ key: 'scale', label: 'Scale', type: 'number', unit: 'x', min: 0.1, max: 10, default: 2, precision: 1 }],
    css: () => '',
  },

  // ── Canvas2D-only generators / pixel passes (canvas2dEffects.ts) ──
  // These have no CSS-filter form and no GPU shader, so css:'' routes them to
  // the Canvas2D pixel-pass in bakeEffectChain; capabilities.ts marks them
  // Canvas2D-only so a GPU export warns instead of dropping them silently.

  // Fill: recolour the layer's content to a solid colour, respecting its alpha.
  {
    type: 'fill',
    label: 'Fill',
    params: [
      { key: 'color', label: 'Color', type: 'color', default: '#ff2d55' },
      { key: 'opacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
    ],
    css: () => '',
  },

  // 4-Colour Gradient: bilinear blend of the four corner colours over the box.
  {
    type: 'four-color-gradient',
    label: '4-Color Gradient',
    params: [
      { key: 'colorTL', label: 'Top Left', type: 'color', default: '#ff0055' },
      { key: 'colorTR', label: 'Top Right', type: 'color', default: '#ffcc00' },
      { key: 'colorBL', label: 'Bottom Left', type: 'color', default: '#00d0ff' },
      { key: 'colorBR', label: 'Bottom Right', type: 'color', default: '#7b61ff' },
      { key: 'blend', label: 'Blend', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
    ],
    css: () => '',
  },

  // Stroke: a coloured outline around the content's alpha silhouette.
  {
    type: 'stroke',
    label: 'Stroke',
    params: [
      { key: 'width', label: 'Width', type: 'number', unit: 'px', min: 0, max: 50, default: 3 },
      { key: 'color', label: 'Color', type: 'color', default: '#ffffff' },
      { key: 'opacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
    ],
    css: () => '',
  },

  // Beam: an animated light beam. Keyframe `length` (0→100%) to fire it across.
  {
    type: 'beam',
    label: 'Beam',
    params: [
      { key: 'length', label: 'Length', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'startX', label: 'Start X', type: 'number', unit: '%', min: -50, max: 150, default: 10 },
      { key: 'startY', label: 'Start Y', type: 'number', unit: '%', min: -50, max: 150, default: 50 },
      { key: 'endX', label: 'End X', type: 'number', unit: '%', min: -50, max: 150, default: 90 },
      { key: 'endY', label: 'End Y', type: 'number', unit: '%', min: -50, max: 150, default: 50 },
      { key: 'thickness', label: 'Thickness', type: 'number', unit: 'px', min: 1, max: 100, default: 8 },
      { key: 'softness', label: 'Softness', type: 'number', unit: '%', min: 0, max: 100, default: 30 },
      { key: 'color', label: 'Color', type: 'color', default: '#8fd0ff' },
    ],
    css: () => '',
  },

  // Sharpen: a 3×3 unsharp convolution (reads neighbours, so it's a pixel pass).
  {
    type: 'sharpen',
    label: 'Sharpen',
    params: [{ key: 'amount', label: 'Amount', type: 'number', unit: '%', min: 0, max: 100, default: 40 }],
    css: () => '',
  },

  // Noise & Grain: per-pixel additive noise. Keyframe `evolution` to animate.
  {
    type: 'noise',
    label: 'Noise & Grain',
    params: [
      { key: 'amount', label: 'Amount', type: 'number', unit: '%', min: 0, max: 100, default: 25 },
      { key: 'evolution', label: 'Evolution', type: 'number', min: 0, max: 1000, default: 0 },
      { key: 'monochrome', label: 'Monochrome', type: 'checkbox', default: true },
    ],
    css: () => '',
  },

  // Wave Warp — sinusoidal distortion of the layer buffer. Keyframe `phase`
  // to make the wave travel (AE convention).
  {
    type: 'wave-warp',
    label: 'Wave Warp',
    params: [
      { key: 'waveHeight', label: 'Wave Height', type: 'number', unit: 'px', min: 0, max: 500, default: 20 },
      { key: 'waveWidth', label: 'Wave Width', type: 'number', unit: 'px', min: 2, max: 2000, default: 120 },
      { key: 'direction', label: 'Direction', type: 'number', unit: '°', min: -360, max: 360, default: 90 },
      { key: 'phase', label: 'Phase', type: 'number', unit: '°', min: -36000, max: 36000, default: 0 },
    ],
    css: () => '',
  },

  // Turbulent Displace — smooth-noise distortion. Keyframe `evolution` to
  // churn it.
  {
    type: 'turbulent-displace',
    label: 'Turbulent Displace',
    params: [
      { key: 'amount', label: 'Amount', type: 'number', unit: 'px', min: 0, max: 500, default: 30 },
      { key: 'size', label: 'Size', type: 'number', unit: 'px', min: 4, max: 1000, default: 120 },
      { key: 'complexity', label: 'Complexity', type: 'number', min: 1, max: 6, default: 2 },
      { key: 'evolution', label: 'Evolution', type: 'number', min: -10000, max: 10000, default: 0 },
    ],
    css: () => '',
  },

  // Echo — temporal: composite the layer at several points in time. NOT a
  // pixel pass; buildSnapshot emits decaying ghost copies at past/future
  // transforms (echo.ts). Renders on both backends (ghosts are normal layers).
  {
    type: 'echo',
    label: 'Echo',
    params: [
      { key: 'echoTime', label: 'Echo Time', type: 'number', unit: 's', min: -2, max: 2, precision: 3, default: -0.05 },
      { key: 'numEchoes', label: 'Number of Echoes', type: 'number', min: 0, max: 64, default: 6 },
      { key: 'startIntensity', label: 'Starting Intensity', type: 'number', unit: '%', min: 0, max: 100, default: 80 },
      { key: 'decay', label: 'Decay', type: 'number', unit: '%', min: 0, max: 100, default: 70 },
    ],
    css: () => '',
  },

  // Keylight: colour-difference chroma keyer (keylight.ts). Writes the matte
  // (alpha) and suppresses spill; Canvas2D pixel pass, so css:'' routes it there.
  {
    type: 'keylight',
    label: 'Keylight (Chroma Key)',
    params: [
      { key: 'screenColor', label: 'Screen Color', type: 'color', default: '#00ff00' },
      { key: 'balance', label: 'Screen Balance', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'gain', label: 'Screen Gain', type: 'number', unit: '%', min: 0, max: 200, default: 100 },
      { key: 'clipBlack', label: 'Clip Black', type: 'number', unit: '%', min: 0, max: 100, default: 8 },
      { key: 'clipWhite', label: 'Clip White', type: 'number', unit: '%', min: 0, max: 100, default: 65 },
      { key: 'despill', label: 'Despill', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      // Matte refinement (AE Screen Shrink/Grow + Screen Softness): choke
      // erodes (+) or grows (−) the keyed alpha to kill the screen-coloured
      // halo; softness feathers the matte edge without blurring colour.
      { key: 'choke', label: 'Choke (Shrink/Grow)', type: 'number', unit: 'px', min: -10, max: 10, default: 0 },
      { key: 'matteSoftness', label: 'Matte Softness', type: 'number', unit: 'px', min: 0, max: 25, default: 0 },
    ],
    css: () => '',
  },
];

const DEF = new Map(EFFECT_DEFS.map((d) => [d.type, d]));

/** Effects that need the GPU backend to render at all. */
export const GPU_ONLY_EFFECTS: ReadonlySet<EffectType> = new Set(
  EFFECT_DEFS.filter((d) => d.gpuOnly).map((d) => d.type),
);

export function isGpuOnlyEffect(type: EffectType): boolean {
  return GPU_ONLY_EFFECTS.has(type);
}

/**
 * Animation prop-path for a keyframeable effect parameter (`effect.fx_3.radius`).
 * buildSnapshot samples this per frame so effect parameters animate through the
 * same reversible keyframe path as transforms (AE Effect Controls stopwatches).
 *
 * Omitting `paramKey` yields the LEGACY path (`effect.fx_3`), which is what
 * projects saved before the multi-param model keyframed. Those tracks still
 * drive the effect's primary parameter — see `resolveEffectParams`.
 */
export function effectPropPath(effectId: string, paramKey?: string): string {
  return paramKey === undefined ? `effect.${effectId}` : `effect.${effectId}.${paramKey}`;
}

/**
 * Hex → [r, g, b, a], each 0..1 — the channel convention the `_r/_g/_b/_a`
 * keyframe tracks actually store.
 *
 * It used to return r/g/b in 0..255 while claiming in this very comment to
 * "match ColorKfRow / Color.fromHex". It did not: `Color.fromHex` is 0..1, and
 * EVERY writer of these tracks goes through it — ColorKfRow for fill/stroke,
 * EffectStack for an effect's colour, LayerStylesControls for a layer style's,
 * and the particle and Glass colour rows. So the picker stored 1.0 for full red
 * and this function's twin, `channelsToColor`, read that 1.0 as one 255th of
 * red and emitted `#010000`.
 *
 * The visible bug: every ANIMATED colour on an effect, a layer style, a particle
 * config or Glass rendered near-black at every frame, whatever colour you
 * picked — and near-black on a drop shadow reads as "the colour keyframes do
 * nothing", which is how it was reported. The fill/stroke/text tracks were never
 * affected, because buildSnapshot reads those through `Color.toHex` (0..1) and
 * never came through here. Two readers, one track format, different units.
 *
 * 0..1 is the direction to converge on because it is what every writer already
 * emits and what the other reader already assumes; the alternative would have
 * meant changing four writers instead of one reader.
 */
export function parseColorChannels(hex: string): [number, number, number, number] {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length === 6) h += 'ff';
  if (h.length !== 8 || /[^0-9a-fA-F]/.test(h)) return [1, 1, 1, 1];
  const n = Number.parseInt(h, 16);
  return [((n >>> 24) & 0xff) / 255, ((n >>> 16) & 0xff) / 255, ((n >>> 8) & 0xff) / 255, (n & 0xff) / 255];
}

/**
 * Recompose a colour from its `_r/_g/_b/_a` channel tracks, over the STORED
 * colour — the single rule for "what colour is this at time t".
 *
 * The fallback per channel is the stored colour's own channel, never a constant.
 * A channel with no track means "unanimated", which means "whatever was
 * authored"; defaulting it to 255 invents a colour nobody chose. The inspector
 * did exactly that — a shadow whose red channel alone carried keyframes showed
 * as near-white in the swatch while it rendered near-black, and editing the
 * swatch then wrote those invented channels back as real keyframes.
 *
 * Exported so the Inspector's colour rows and `resolveEffectParams` share one
 * implementation rather than two that agree until they don't.
 */
export function resolveChannelColor(
  storedHex: string,
  sample: (suffix: '_r' | '_g' | '_b' | '_a') => number | undefined,
): string {
  const base = parseColorChannels(storedHex);
  return channelsToColor(
    sample('_r') ?? base[0],
    sample('_g') ?? base[1],
    sample('_b') ?? base[2],
    sample('_a') ?? base[3],
  );
}

/** [r,g,b,a] each 0..1 → #rrggbb / #rrggbbaa. The exact inverse of
 *  {@link parseColorChannels}, and the same scale as `Color.toHex`. */
export function channelsToColor(r: number, g: number, b: number, a: number): string {
  const c = (v: number): string =>
    Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  const base = `#${c(r)}${c(g)}${c(b)}`;
  return a >= 1 ? base : `${base}${c(a)}`;
}

/**
 * Resolve each effect's amount at the current time: `sample(id)` returns the
 * animated value (or undefined when the amount isn't keyframed), falling back to
 * the stored static amount. Pure — the render/snapshot layer supplies `sample`.
 */
export function resolveEffectParams(
  effects: ReadonlyArray<Effect>,
  /** Sample an animated value by prop path, or undefined when not keyframed. */
  sample: (propPath: string) => number | undefined,
  /**
   * The layer's own time, in seconds, for TIME-DEPENDENT effects (Timecode).
   *
   * Resolved into the effect's params HERE rather than read from a clock deeper
   * down, and that placement is the design. Everything below this point — the
   * bake chain, the Canvas2D kernels, the content hash — stays a pure function
   * of the effect's params, which is what keeps preview and export identical and
   * keeps scrubbing back to a frame reproducible. A kernel that read the clock
   * itself would break all three at once.
   *
   * It is the LAYER's time (post time-remap), not comp time, so a timecode
   * burn-in on a remapped or stretched layer reads the frame the layer is
   * actually showing — the same axis Roughen's wiggle rides.
   *
   * Optional so the many callers that have no clock (tests, the effect
   * clipboard, presets) are unaffected.
   */
  layerTimeSec?: number,
): Effect[] {
  return effects.map((e) => {
    const def = DEF.get(e.type);
    if (!def) return e;
    const params: Record<string, EffectParamValue> = { ...paramsOf(e) };
    let touched = false;

    // Time first, so an explicit keyframe on the same param still wins below.
    // A user who keyframes the readout has overridden the clock on purpose.
    const timeParam = timeParamFor(e.type);
    if (timeParam !== undefined && layerTimeSec !== undefined && params.followCompTime !== false) {
      params[timeParam] = layerTimeSec;
      touched = true;
    }

    for (const p of def.params) {
      if (p.type === 'number') {
        const v = sample(effectPropPath(e.id, p.key));
        if (v !== undefined) {
          params[p.key] = v;
          touched = true;
        }
        continue;
      }
      // Color params animate through decomposed channel tracks — the same
      // pattern fill/stroke colors use (`fill_r`…): `effect.<id>.<key>_r/g/b/a`.
      // Any sampled channel overrides that channel of the stored color.
      if (p.type === 'color') {
        const ch = (suffix: '_r' | '_g' | '_b' | '_a'): number | undefined =>
          sample(effectPropPath(e.id, `${p.key}${suffix}`));
        if (ch('_r') !== undefined || ch('_g') !== undefined || ch('_b') !== undefined || ch('_a') !== undefined) {
          params[p.key] = resolveChannelColor(String(params[p.key] ?? p.default ?? '#ffffff'), ch);
          touched = true;
        }
      }
    }

    // Legacy: a pre-multi-param project keyframed `effect.<id>` with no param
    // key. Those tracks drive the primary param, so old animations still run.
    const primary = def.params.find((p) => p.type === 'number')?.key;
    if (primary !== undefined && !touched) {
      const legacy = sample(effectPropPath(e.id));
      if (legacy !== undefined) {
        params[primary] = legacy;
        touched = true;
      }
    }

    return touched ? { ...e, params } : e;
  });
}

/** Compile an effect stack to a CSS filter string (empty when none). Disabled
 *  effects (enabled === false) are skipped; stack order is preserved. */
export function effectsToFilter(effects: ReadonlyArray<Effect>): string {
  return effects
    .filter((e) => e.enabled !== false)
    .map((e) => effectCss(e))
    .filter(Boolean)
    .join(' ');
}

/** The CSS filter function for a single effect ('' when it has no CSS form —
 *  GPU-only effects and per-pixel LUT effects like Levels). Lets the backend
 *  interleave CSS filters with non-CSS passes in stack order. */
export function effectCss(e: Effect): string {
  return DEF.get(e.type)?.css(paramsOf(e)) ?? '';
}

/**
 * Normalise one stored effect: fill in declared defaults, and migrate a legacy
 * single `amount` into the primary param so projects saved before the
 * multi-param model keep looking the same.
 */
export function migrateEffect(raw: Effect): Effect {
  if (!DEF.has(raw.type)) return raw;
  const { amount: _legacy, ...rest } = raw;
  return { ...rest, params: paramsOf(raw) };
}

/** Read the effect stack off a node (from its `fx` component). */
export function readNodeEffects(node: SceneNode): Effect[] {
  const fx = node.components.find((c) => c.type === 'fx');
  const list = fx?.props.effects;
  return Array.isArray(list) ? (list as Effect[]).map(migrateEffect) : [];
}

/**
 * After Effects' `fx` switch: is this layer's effect stack live?
 *
 * Absent means enabled, so existing projects keep rendering their effects.
 */
export function readNodeFxEnabled(node: SceneNode): boolean {
  const fx = node.components.find((c) => c.type === 'fx');
  return fx?.props.fxEnabled !== false;
}

export function getNodeFxEnabled(nodeId: string): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  return node ? readNodeFxEnabled(node) : true;
}

export function setNodeFxEnabled(nodeId: string, enabled: boolean): void {
  // Store only the OFF state, so the common case adds nothing to the file.
  defaultSceneGraph.setFxEnabled(nodeId, enabled ? undefined : false);
  getEventBus().emit('AnimationChanged', { nodeId });
}

/**
 * The effects the RENDERER should apply — empty when the layer's `fx` switch is
 * off. Distinct from `readNodeEffects`, which the inspector uses to list the
 * stack: a disabled stack must still be visible and editable in the UI.
 */
export function readNodeRenderEffects(node: SceneNode): Effect[] {
  return readNodeFxEnabled(node) ? readNodeEffects(node) : [];
}

export function getNodeEffects(nodeId: string): Effect[] {
  const node = defaultSceneGraph.getNode(nodeId);
  return node ? readNodeEffects(node) : [];
}

let seq = 0;

/** Replace a layer's effect stack (bumps the scene + notifies). */
export function writeNodeEffects(nodeId: string, effects: Effect[]): void {
  // The `fx` component is a computed view over the engine node; store the stack
  // on the engine (surfaced back as `readNodeEffects`' fx component).
  defaultSceneGraph.setEffects(nodeId, effects);
  // Effects change the rendered frame → same signal as an animation edit
  // (invalidates the cache, marks dirty, records history, re-renders viewport).
  getEventBus().emit('AnimationChanged', { nodeId });
}

/**
 * `id` lets a caller NAME the effect instead of discovering its generated id.
 *
 * The generated `fx_<n>` is only knowable by reading the return value, and a
 * deterministic emitter cannot read one: `@motion/technique-library` builds a
 * flat `ToolCall[]` with no execution and no feedback, so a technique that wants
 * to keyframe `effect.<id>.<param>` must know the id before the effect exists.
 * Two techniques solved that by inventing one — and because `isAnimatableProp`
 * accepts any `effect.*` path, both wrote tracks onto effects that never
 * existed. The calls succeeded, the keyframes were stored, and nothing rendered.
 *
 * A supplied id already taken on the node falls back to a generated one, so this
 * can never produce two effects sharing an id.
 */
export function addEffect(nodeId: string, type: EffectType, id?: string): void {
  const def = DEF.get(type);
  if (!def) return;
  const effects = getNodeEffects(nodeId);
  const taken = new Set(effects.map((e) => e.id));
  const useId = id && !taken.has(id) ? id : `fx_${(seq += 1)}`;
  writeNodeEffects(nodeId, [...effects, { id: useId, type, params: defaultParams(def) }]);
}

/** Set one of an effect's parameters. */
export function updateEffectParam(
  nodeId: string,
  effectId: string,
  key: string,
  value: EffectParamValue,
): void {
  writeNodeEffects(
    nodeId,
    getNodeEffects(nodeId).map((e) =>
      e.id === effectId ? { ...e, params: { ...e.params, [key]: value } } : e,
    ),
  );
}

/** Set an effect's primary parameter (what the old single-scalar API meant). */
export function updateEffect(nodeId: string, effectId: string, amount: number): void {
  const effect = getNodeEffects(nodeId).find((e) => e.id === effectId);
  const key = effect ? primaryParamKey(effect.type) : undefined;
  if (!effect || !key) return;
  updateEffectParam(nodeId, effectId, key, amount);
}

export function removeEffect(nodeId: string, effectId: string): void {
  writeNodeEffects(nodeId, getNodeEffects(nodeId).filter((e) => e.id !== effectId));
}

/** Toggle an effect's enabled state (keeps it in the stack). */
export function toggleEffect(nodeId: string, effectId: string): void {
  writeNodeEffects(
    nodeId,
    getNodeEffects(nodeId).map((e) => (e.id === effectId ? { ...e, enabled: e.enabled === false } : e)),
  );
}

/** Move an effect up (-1) or down (+1) in the stack — order changes the look
 *  because filters compose left-to-right. Pure reorder helper is exported too. */
export function moveEffect(nodeId: string, effectId: string, dir: -1 | 1): void {
  writeNodeEffects(nodeId, reorderEffects(getNodeEffects(nodeId), effectId, dir));
}

/** Pure: return a new stack with `effectId` moved by `dir`, clamped at the ends. */
export function reorderEffects(effects: ReadonlyArray<Effect>, effectId: string, dir: -1 | 1): Effect[] {
  const list = [...effects];
  const i = list.findIndex((e) => e.id === effectId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return list;
  [list[i], list[j]] = [list[j]!, list[i]!];
  return list;
}

/**
 * Pure: move `effectId` to index `to` (a drag-and-drop reorder, as opposed to
 * `reorderEffects`' single-step nudge).
 *
 * `to` is the index in the ORIGINAL list that the effect should end up before —
 * the convention a drop indicator drawn between rows implies. Removing the
 * dragged item first would shift every later index by one, so the removal is
 * compensated rather than the caller having to think about it.
 */
export function moveEffectTo(effects: ReadonlyArray<Effect>, effectId: string, to: number): Effect[] {
  const list = [...effects];
  const from = list.findIndex((e) => e.id === effectId);
  if (from < 0) return list;
  const clamped = Math.max(0, Math.min(to, list.length));
  if (clamped === from || clamped === from + 1) return list; // no-op drops
  const [moved] = list.splice(from, 1);
  list.splice(clamped > from ? clamped - 1 : clamped, 0, moved!);
  return list;
}

/** Move an effect to an absolute index on a node's stack (drag reorder). */
export function dragEffectTo(nodeId: string, effectId: string, to: number): void {
  writeNodeEffects(nodeId, moveEffectTo(getNodeEffects(nodeId), effectId, to));
}
