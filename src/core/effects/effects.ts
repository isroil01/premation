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
  | 'echo';

/** Curve control points: `[inputX, outputY]` pairs in 0–255. */
export type CurvePoints = ReadonlyArray<readonly [number, number]>;
export type EffectParamValue = number | string | boolean | CurvePoints;
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
  type: 'number' | 'color' | 'checkbox' | 'curve' | 'layer';
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

/** The parameter legacy `amount` and legacy keyframe tracks refer to. */
export function primaryParamKey(type: EffectType): string | undefined {
  return DEF.get(type)?.params.find((p) => p.type === 'number')?.key;
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
    params: [{ key: 'points', label: 'Curve', type: 'curve', default: [[0, 0], [255, 255]] }],
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

/** Hex → [r,g,b (0..255), a (0..1)] — the channel convention the `_r/_g/_b/_a`
 *  keyframe tracks use (matches ColorKfRow / Color.fromHex). Shared with the
 *  particle-config resolver, which animates its colors the same way. */
export function parseColorChannels(hex: string): [number, number, number, number] {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length === 6) h += 'ff';
  if (h.length !== 8 || /[^0-9a-fA-F]/.test(h)) return [255, 255, 255, 1];
  const n = Number.parseInt(h, 16);
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, (n & 0xff) / 255];
}

/** [r,g,b (0..255), a (0..1)] → #rrggbb / #rrggbbaa. */
export function channelsToColor(r: number, g: number, b: number, a: number): string {
  const c = (v: number): string => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  const base = `#${c(r)}${c(g)}${c(b)}`;
  return a >= 1 ? base : `${base}${c(a * 255)}`;
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
): Effect[] {
  return effects.map((e) => {
    const def = DEF.get(e.type);
    if (!def) return e;
    const params: Record<string, EffectParamValue> = { ...paramsOf(e) };
    let touched = false;

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
        const r = sample(effectPropPath(e.id, `${p.key}_r`));
        const g = sample(effectPropPath(e.id, `${p.key}_g`));
        const b = sample(effectPropPath(e.id, `${p.key}_b`));
        const alpha = sample(effectPropPath(e.id, `${p.key}_a`));
        if (r !== undefined || g !== undefined || b !== undefined || alpha !== undefined) {
          const base = parseColorChannels(String(params[p.key] ?? p.default ?? '#ffffff'));
          params[p.key] = channelsToColor(
            r ?? base[0], g ?? base[1], b ?? base[2], alpha ?? base[3],
          );
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

function writeNodeEffects(nodeId: string, effects: Effect[]): void {
  // The `fx` component is a computed view over the engine node; store the stack
  // on the engine (surfaced back as `readNodeEffects`' fx component).
  defaultSceneGraph.setEffects(nodeId, effects);
  // Effects change the rendered frame → same signal as an animation edit
  // (invalidates the cache, marks dirty, records history, re-renders viewport).
  getEventBus().emit('AnimationChanged', { nodeId });
}

export function addEffect(nodeId: string, type: EffectType): void {
  const def = DEF.get(type);
  if (!def) return;
  const effects = getNodeEffects(nodeId);
  writeNodeEffects(nodeId, [...effects, { id: `fx_${(seq += 1)}`, type, params: defaultParams(def) }]);
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
