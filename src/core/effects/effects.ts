/**
 * Visual effects engine (spec: Focus Mode edits "animation, masks, effects,
 * expressions…"). Each layer carries a stack of effects stored on an `fx`
 * component so History, autosave, and export capture them for free. Effects
 * compile to a CSS `filter` string the Canvas 2D backend applies per layer.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpSceneRevision } from '@stores/sceneStore';
import { getEventBus } from '@core/events/EventBus';
import { pluginEffectDef } from './pluginEffectDefs';
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
  | 'compound-blur'
  | 'motion-tile'
  | 'bend'
  | 'wide-time'
  | 'force-motion-blur'
  | 'bevel-alpha'
  | 'bevel-edges'
  | 'spotlight'
  | 'sphere'
  | 'cylinder'
  | 'arithmetic'
  | 'fill'
  | 'four-color-gradient'
  | 'stroke'
  | 'beam'
  | 'sharpen'
  | 'noise'
  | 'keylight'
  | 'wave-warp'
  | 'turbulent-displace'
  | 'curl-noise'
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
  | 'audio-spectrum'
  // ── Utility family ──
  // AE's Apply Color LUT. The one colour tool per-channel curves cannot stand
  // in for: a 3D LUT can rotate one hue while its neighbour holds still, which
  // is most of what a film emulation actually does.
  | 'apply-color-lut'
  // ── Round three: the AE families with the largest remaining gaps ──
  //
  // Filed by the PATH each one renders on, because that is the decision that
  // costs something if it is made wrong (see `colorLut.ts` and `aeColor.ts`):
  //
  //   LUT path      per-channel transfer, both backends, no bake
  //   pixel pass    reads neighbours or other channels, forces a CPU bake
  //
  // Colour — the two that are per-channel transfers, so they stay free.
  | 'color-balance'
  | 'gamma-pedestal-gain'
  // Colour — the four that read all three channels and cannot be tables.
  | 'photo-filter'
  | 'black-and-white'
  | 'tritone'
  | 'threshold'
  // Distort — inverse-map resamples, like the four already above.
  | 'polar-coordinates'
  | 'optics-compensation'
  | 'mesh-warp'
  | 'liquify'
  | 'mirror'
  | 'offset'
  // Stylize — a directional derivative and a randomised resample.
  | 'emboss'
  | 'scatter'
  // Transition — alpha-only reveals, like the three already above.
  | 'radial-wipe'
  | 'block-dissolve'
  // Keying / Matte — a luminance key, and the morphology every matte needs.
  | 'luma-key'
  | 'minimax'
  // Blur & Sharpen — per-channel radii, and a real scale-aware sharpen.
  | 'channel-blur'
  | 'unsharp-mask'
  // ── Round four ────────────────────────────────────────────────────
  //
  // Fifty effects, every one a Canvas2D pixel pass or generator. None is a
  // `LUT_BUILDERS` candidate: the colour eight either need the HISTOGRAM
  // (Equalize, the three Autos) or read all three channels to produce each one
  // (Change Color, Change To Color, Leave Color, Toner), and a per-channel
  // table can express neither. Filing one there would render silently wrong.
  //
  // Blur — none of these is separable, which is exactly why they are not in
  // `blurs.ts`: the kernel varies per pixel (Bilateral), gates on a threshold
  // (Smart Blur), or convolves with an iris shape in boosted intensity
  // (Camera Lens Blur).
  | 'bilateral-blur'
  | 'smart-blur'
  | 'camera-lens-blur'
  // Distort — inverse-map resamples, like every other member of the family.
  | 'ripple'
  | 'magnify'
  | 'warp'
  | 'page-turn'
  | 'split'
  | 'slant'
  | 'smear'
  | 'rolling-shutter'
  // Perspective — a shadow cast from a POINT light, so it projects and scales
  // with distance rather than offsetting uniformly like Drop Shadow.
  | 'radial-shadow'
  // Generate — these DRAW, like Beam and Lens Flare.
  | 'circle'
  | 'ellipse'
  | 'radio-waves'
  | 'lightning'
  | 'light-rays'
  | 'light-sweep'
  | 'audio-waveform'
  // Stylize. Strobe Light is the only new TIME_DEPENDENT member — see the note
  // on that map for why membership is kept rare.
  | 'cartoon'
  | 'brush-strokes'
  | 'strobe-light'
  | 'color-emboss'
  | 'halftone'
  | 'kaleidoscope'
  | 'vignette'
  | 'burn-film'
  // Colour Correction — the eight that need the pixels. See the note above.
  | 'equalize'
  | 'auto-levels'
  | 'auto-contrast'
  | 'auto-color'
  | 'change-color'
  | 'change-to-color'
  | 'leave-color'
  | 'toner'
  // Keying & Matte — three keys that select on different axes, a despill, and
  // the spread-then-choke every noisy matte needs.
  | 'color-key'
  | 'color-range'
  | 'extract'
  | 'spill-suppressor'
  | 'matte-choker'
  // Channel — these treat the four channels as data rather than as a picture.
  | 'alpha-levels'
  | 'solid-composite'
  | 'channel-combiner'
  | 'remove-color-matting'
  // Transition — alpha-only reveals, with Light Wipe the one exception that
  // also writes RGB (its leading edge glows, which is the effect).
  | 'iris-wipe'
  | 'light-wipe'
  | 'line-sweep'
  | 'grid-wipe'
  // Noise & Grain — a thresholded median, and noise in COVERAGE not colour.
  | 'dust-scratches'
  | 'noise-alpha'
  // ── Round five ────────────────────────────────────────────────────
  //
  // Twenty of the most-reached-for AE / Cycore effects still missing after
  // round four. Every one is a Canvas2D pixel pass or generator, and every
  // animated one moves through a KEYFRAMED phase/evolution/completion param
  // rather than the clock — none joins TIME_DEPENDENT (the Strobe Light rule).
  //
  // Generate — these DRAW, like Beam and Lens Flare. Weather and starfields
  // are deterministic hashes of (seed, evolution), so scrubbing is stable.
  | 'star-burst'
  | 'snowfall'
  | 'rainfall'
  | 'write-on'
  | 'light-burst'
  // Stylize — surface shading and per-cell resamples.
  | 'glass'
  | 'texturize'
  | 'threads'
  | 'chromatic-aberration'
  | 'hex-tile'
  // Blur — blur along the luminance-gradient flow field (CC Vector Blur).
  | 'vector-blur'
  // Distort — inverse-map resamples, like every other member of the family.
  | 'flo-motion'
  | 'lens'
  | 'griddler'
  | 'ball-action'
  | 'drizzle'
  // Transition — completion-driven reveals, matching the wipes' contract.
  | 'jaws'
  | 'pixel-polly'
  | 'twister'
  | 'card-dance'
  // ── Round six: iconic AE & CC effects ──
  | 'unmult'
  | 'cc-composite'
  | 'cc-repetile'
  | 'cc-scatterize'
  | 'radial-fast-blur'
  | 'cross-blur'
  | 'scale-wipe'
  | 'plastic';

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
   * Optional AE-style label colour on this effect instance (Effect Controls
   * header swatch). Hex from `LABEL_COLORS`; absent = default chrome.
   */
  labelColor?: string;
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
  /**
   * `'enum'` is a NAMED choice stored as a NUMBER — AE's "Echo Operator: Add",
   * "Bend Style: Marilyn". Deliberately numeric rather than a string so it
   * keyframes, reads through `effectNumber` and packs into a uniform exactly
   * like every other numeric param; only the CONTROL differs. Requires
   * `options`, which `effectRegistryComplete.test.ts` enforces.
   */
  type: 'number' | 'color' | 'checkbox' | 'curve' | 'layer' | 'resolved' | 'enum';
  /** The choices for an `'enum'` param, in menu order. Ignored for other types. */
  options?: ReadonlyArray<{ value: number; label: string }>;
  /**
   * The collapsible section this param belongs to — Colorama's "Output Cycle",
   * Bend's "Distortion". Absent = a top-level param, which is most of them.
   *
   * A flat list could not express AE's grouped effects at all: Colorama alone
   * has five sections, and drawing its controls as one undivided column is the
   * difference between a panel you can read and a wall. Consecutive params
   * sharing a name form ONE section — order in `params` is order on screen, so
   * a group is a contiguous run and needs no separate ordering field.
   */
  group?: string;
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
   * Renders only as a real shader pass (WGSL or GLSL), with no CSS-filter
   * equivalent — so the UI marks it rather than offering it as if it were free.
   *
   * This used to read "on Canvas2D — the DEFAULT backend — adding one of these
   * does nothing at all". That stopped being true in Phase 5, when
   * `Canvas2DBackend` was removed: the tiering is WebGPU → WebGL2 with no CPU
   * tier at all, and `'software'` means the viewport cannot paint rather than
   * "slower but working" (see `renderBackendStore.ts`). Corrected because a
   * comment pointing at a deleted backend is worse than none — anyone reasoning
   * about what a `gpuOnly` effect does on a weak machine would have reasoned
   * from a fallback that does not exist.
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
 * layer's clock; Wide Time emits copies in BOTH directions (Echo's mechanism,
 * a different step pattern — see temporalGhosts.ts); Force Motion Blur widens
 * the shutter the transform is sampled across.
 */
const TEMPORAL = new Set<string>(['echo', 'posterize-time', 'wide-time', 'force-motion-blur']);

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
  /*
    Strobe Light. Earns its place by the test above: its output genuinely
    differs frame to frame, because differing frame to frame IS the effect —
    a strobe that cached would simply not strobe.

    Note what is NOT here. Every other time-varying effect in round four —
    Ripple's phase, Radio Waves' phase, Noise Alpha's phase, the wipes'
    completion — is driven by an ordinary KEYFRAMED parameter instead. That
    keeps them cacheable (the hash varies only when the keyframed value does)
    and, more importantly, keeps them under the animator's control rather than
    bound to the wall clock. Reach for a keyframed phase first; this set is for
    effects that cannot be expressed that way.
  */
  ['strobe-light', 'time'],
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
      { key: 'spread', label: 'Spread', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'color', label: 'Color', type: 'color', default: '#78b4ff' },
      { key: 'intensity', label: 'Intensity', type: 'number', unit: '%', min: 0, max: 100, default: 90 },
    ],
    css: (p) => {
      // CSS cannot dilate; remap radius so Spread still hardens the halo.
      const s = Math.max(0, Math.min(100, num(p, 'spread', 0))) / 100;
      const r = Math.max(0, num(p, 'radius', 16) * (1 - s));
      return `drop-shadow(0 0 ${r}px ${withAlpha(str(p, 'color', '#78b4ff'), num(p, 'intensity', 90) / 100)})`;
    },
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
      { key: 'spread', label: 'Spread', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'color', label: 'Color', type: 'color', default: '#000000' },
      { key: 'opacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 55 },
    ],
    css: (p) => {
      const d = num(p, 'distance', 6);
      const rad = (num(p, 'angle', 135) * Math.PI) / 180;
      const dx = (Math.cos(rad) * d).toFixed(1);
      const dy = (Math.sin(rad) * d).toFixed(1);
      const color = withAlpha(str(p, 'color', '#000000'), num(p, 'opacity', 55) / 100);
      // CSS drop-shadow has no Spread; harden by shrinking the blur radius.
      const s = Math.max(0, Math.min(100, num(p, 'spread', 0))) / 100;
      const soft = Math.max(0, num(p, 'softness', 12) * (1 - s));
      return `drop-shadow(${dx}px ${dy}px ${soft}px ${color})`;
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
  {
    /*
      Wide Time — AE's CC Wide Time. Copies from BOTH directions, evenly
      weighted, which reads as a temporal smear rather than as Echo's trailing
      wake. Shares Echo's ghost emission entirely (see temporalGhosts.ts); only
      the step pattern differs.

      No `css` and no Canvas2D case, like Echo, because it is not a pixel pass
      at all — it resolves in buildSnapshot into ordinary render layers, so it
      works on both backends and needs no shader.
    */
    type: 'wide-time',
    label: 'Wide Time',
    params: [
      { key: 'forwardSteps', label: 'Forward Steps', type: 'number', min: 0, max: 64, default: 2 },
      { key: 'backwardSteps', label: 'Backward Steps', type: 'number', min: 0, max: 64, default: 2 },
    ],
    css: () => '',
  },
  {
    /*
      Force Motion Blur — AE's CC Force Motion Blur. Overrides the composition
      and layer motion-blur SWITCHES for this layer, with its own shutter.

      The sampling itself is the comp's existing `sampleMotion`; this only
      decides whether it runs and how wide the shutter is, so there is no second
      motion-blur implementation to drift. See forceMotionBlur.ts for why it
      does not also override "does the layer actually move".
    */
    type: 'force-motion-blur',
    label: 'Force Motion Blur',
    params: [
      { key: 'shutterAngle', label: 'Shutter Angle', type: 'number', unit: '°', min: 0, max: 720, default: 180 },
      { key: 'samples', label: 'Samples', type: 'number', min: 2, max: 32, default: 12 },
    ],
    css: () => '',
  },

  // ── Perspective family (GPU shaders, packages/renderer builtin.ts) ──
  //
  // Flat layers made to look like lit surfaces. All `gpuOnly`: each is a
  // per-pixel shader with no Canvas2D twin, so on a layer baked for another
  // reason `extractSpatialEffects(layer, true)` carries them to the GPU.
  {
    /*
      Bevel Alpha — chisels the ALPHA boundary, so the bevel follows the
      artwork's silhouette. AE's default light comes from the upper left, which
      is why the angle defaults where it does rather than to 0.
    */
    type: 'bevel-alpha',
    label: 'Bevel Alpha',
    gpuOnly: true,
    params: [
      { key: 'thickness', label: 'Edge Thickness', type: 'number', min: 0, max: 40, default: 4, precision: 1 },
      { key: 'lightAngle', label: 'Light Angle', type: 'number', unit: '°', min: -180, max: 180, default: -135 },
      { key: 'lightColor', label: 'Light Color', type: 'color', default: '#ffffff' },
      { key: 'intensity', label: 'Light Intensity', type: 'number', unit: '%', min: 0, max: 200, default: 50 },
    ],
    css: () => '',
  },
  {
    /* Bevel Edges — the same chisel on the layer's rectangular FRAME. */
    type: 'bevel-edges',
    label: 'Bevel Edges',
    gpuOnly: true,
    params: [
      { key: 'thickness', label: 'Edge Thickness', type: 'number', min: 0, max: 40, default: 4, precision: 1 },
      { key: 'lightAngle', label: 'Light Angle', type: 'number', unit: '°', min: -180, max: 180, default: -135 },
      { key: 'lightColor', label: 'Light Color', type: 'color', default: '#ffffff' },
      { key: 'intensity', label: 'Light Intensity', type: 'number', unit: '%', min: 0, max: 200, default: 50 },
    ],
    css: () => '',
  },
  {
    /*
      Spotlight — a cone thrown across the layer. MULTIPLIES rather than adds,
      so outside the cone the picture goes dark: a spotlight reveals what is
      already there. `ambient` is how much survives outside it, which is the
      control that stops the effect being an on/off mask.
    */
    type: 'spotlight',
    label: 'Spotlight',
    gpuOnly: true,
    params: [
      /*
        From and To are AE's point controls, and they carry the light's
        position, its aim AND its reach between them — the beam dims out at To.
        A centre-plus-angle-plus-radius form (which this effect shipped with
        first) cannot express "shine in from off-frame at that corner" without
        the user solving for the angle themselves.

        Offsets from rest, per effectHandles.ts. Rest puts the lamp at the top
        edge aiming at the layer's middle.
      */
      { key: 'fromX', label: 'From X', type: 'number', unit: 'px', min: -8000, max: 8000, default: 0, group: 'From' },
      { key: 'fromY', label: 'From Y', type: 'number', unit: 'px', min: -8000, max: 8000, default: 0, group: 'From' },
      { key: 'toX', label: 'To X', type: 'number', unit: 'px', min: -8000, max: 8000, default: 0, group: 'To' },
      { key: 'toY', label: 'To Y', type: 'number', unit: 'px', min: -8000, max: 8000, default: 0, group: 'To' },
      { key: 'coneAngle', label: 'Cone Angle', type: 'number', unit: '°', min: 1, max: 180, default: 100, group: 'Cone' },
      { key: 'edgeSoftness', label: 'Edge Softness', type: 'number', unit: '%', min: 0, max: 100, default: 45, group: 'Cone' },
      /*
        How far the beam reaches, as a percentage of the layer's HEIGHT — AE's
        Height, and its own control rather than the From→To distance.

        Welding reach to the handles is what made this effect look like it
        deleted the layer: at rest the points sit half a layer-height apart, so
        everything beyond that fell to Ambient, and a layer at low ambient on a
        dark composition is indistinguishable from one that is not there. The
        default covers the whole layer generously.
      */
      { key: 'reach', label: 'Reach', type: 'number', unit: '%', min: 1, max: 400, default: 250, group: 'Cone' },
      { key: 'lightColor', label: 'Light Color', type: 'color', default: '#ffffff' },
      { key: 'intensity', label: 'Intensity', type: 'number', unit: '%', min: 0, max: 400, default: 100 },
      /*
        Ambient is what survives OUTSIDE the cone. Default 100% = the layer is
        unchanged outside the beam — a Spotlight that darkens the whole plate
        by default (15% / 55%) reads as "the scene disappeared" on a dark
        composition, especially on fullscreen images and solids.
      */
      { key: 'ambient', label: 'Ambient', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      {
        // AE's Render menu. Light Only drops the layer's colour and keeps the
        // beam, which is how the effect is used to build a visible light cone
        // over other footage.
        key: 'render',
        label: 'Render',
        type: 'enum',
        default: 0,
        options: [
          { value: 0, label: 'Layer + Light' },
          { value: 1, label: 'Light Only' },
        ],
      },
    ],
    css: () => '',
  },
  {
    /*
      Sphere — wrap the layer around a sphere. Radius is a fraction of the
      layer's SHORT side, so 100% touches the nearer pair of edges whatever the
      aspect ratio; above that the sphere is cropped, which is a legitimate
      look and not a clamp.

      Shading is separate from the light colour because they answer different
      questions: shading is how spherical it reads, colour is what it is lit
      by. Folding them together makes an unlit sphere impossible to tint.
    */
    type: 'sphere',
    label: 'Sphere',
    gpuOnly: true,
    params: [
      { key: 'radius', label: 'Radius', type: 'number', unit: '%', min: 1, max: 200, default: 100 },
      // All three axes, as AE has. Z spins the map in the plane of the screen
      // and was simply missing; without it a globe cannot be tilted off its
      // pole, which is most of what the effect is used for.
      { key: 'rotateX', label: 'Rotate X', type: 'number', unit: '°', min: -3600, max: 3600, default: 0, group: 'Rotation' },
      { key: 'rotateY', label: 'Rotate Y', type: 'number', unit: '°', min: -3600, max: 3600, default: 0, group: 'Rotation' },
      { key: 'rotateZ', label: 'Rotate Z', type: 'number', unit: '°', min: -3600, max: 3600, default: 0, group: 'Rotation' },
      { key: 'shading', label: 'Shading', type: 'number', unit: '%', min: 0, max: 100, default: 70, group: 'Light' },
      { key: 'lightColor', label: 'Light Color', type: 'color', default: '#ffffff', group: 'Light' },
    ],
    css: () => '',
  },
  {
    /*
      Cylinder — the same cast with one axis left flat, so the layer wraps
      horizontally and passes straight through vertically. Rotation spins the
      texture past the viewer; the full image maps across the visible front
      half, which is what makes a 360° rotation a complete loop.
    */
    type: 'cylinder',
    label: 'Cylinder',
    gpuOnly: true,
    params: [
      { key: 'radius', label: 'Radius', type: 'number', unit: '%', min: 1, max: 200, default: 100 },
      { key: 'rotation', label: 'Rotation', type: 'number', unit: '°', min: -3600, max: 3600, default: 0 },
      { key: 'shading', label: 'Shading', type: 'number', unit: '%', min: 0, max: 100, default: 70, group: 'Light' },
      { key: 'lightColor', label: 'Light Color', type: 'color', default: '#ffffff', group: 'Light' },
    ],
    css: () => '',
  },

  // ── Channel family ────────────────────────────────────────────────
  {
    /*
      Arithmetic — AE's Channel ▸ Arithmetic. One operator applied per channel
      against a constant.

      Values are authored 0..255 rather than as percentages because three of the
      operators are BITWISE: And/Or/Xor on a normalised float means nothing, and
      AE's own controls are 8-bit for exactly that reason.
    */
    type: 'arithmetic',
    label: 'Arithmetic',
    gpuOnly: true,
    params: [
      {
        key: 'operator',
        label: 'Operator',
        type: 'enum',
        default: 0,
        options: [
          { value: 0, label: 'Add' },
          { value: 1, label: 'Subtract' },
          { value: 2, label: 'Multiply' },
          { value: 3, label: 'Difference' },
          { value: 4, label: 'Max' },
          { value: 5, label: 'Min' },
          { value: 6, label: 'Block Above' },
          { value: 7, label: 'Block Below' },
          { value: 8, label: 'And' },
          { value: 9, label: 'Or' },
          { value: 10, label: 'Xor' },
        ],
      },
      { key: 'red', label: 'Red Value', type: 'number', min: 0, max: 255, precision: 0, default: 0 },
      { key: 'green', label: 'Green Value', type: 'number', min: 0, max: 255, precision: 0, default: 0 },
      { key: 'blue', label: 'Blue Value', type: 'number', min: 0, max: 255, precision: 0, default: 0 },
      // AE's "Clip Result Values". Off keeps out-of-range results, which is
      // what lets an Add and a Subtract round-trip losslessly.
      { key: 'clip', label: 'Clip Result Values', type: 'checkbox', default: true },
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
      /*
        Grouped the way AE groups Colorama — Input Phase, then Output Cycle,
        with Blend With Original loose at the bottom. AE has three further
        sections (Modify, Pixel Selection, Masking); they are absent here
        because their PARAMETERS are, and an empty section is a twisty that
        opens onto nothing.

        `palette` was labelled "Output Cycle", which in AE names the section
        this param sits INSIDE, not the param itself — so the panel put a
        group's name on a single slider. The `key` is deliberately untouched:
        renaming it would reset the palette on every saved project.
      */
      // The signature control: one keyframe here cycles the palette through the
      // image. The cycle wraps, so the animation loops seamlessly.
      { key: 'phaseShift', label: 'Phase Shift', type: 'number', unit: '°', min: -36000, max: 36000, default: 0, group: 'Input Phase' },
      // Index into COLORAMA_PALETTES. A number so it can be keyframed, and the
      // indices are STABLE — new palettes go on the end, because inserting into
      // the middle would silently re-map every saved project.
      { key: 'palette', label: 'Use Preset Palette', type: 'number', min: 0, max: 4, precision: 0, default: 0, group: 'Output Cycle' },
      { key: 'cycleRepetitions', label: 'Cycle Repetitions', type: 'number', min: 0.1, max: 20, precision: 2, default: 1, group: 'Output Cycle' },
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
    // AE's Apply Color LUT (Utility). See core/effects/cubeLut.ts.
    type: 'apply-color-lut',
    label: 'Apply Color LUT',
    params: [
      /**
       * The parsed `.cube` file, stored as a plain object (see `StoredLut`) so
       * it survives the JSON round-trip a `.motion` document makes. `resolved`
       * rather than a number type because there is no inspector control that
       * edits a LUT — you load a file; the panel renders a file picker for this
       * key specifically.
       */
      { key: 'lut', label: 'LUT file', type: 'resolved', default: [] },
      /**
       * Blends against the ORIGINAL, so 0 is exactly a no-op and 50 is the
       * halfway look — matching AE and every grading tool. A number, so it
       * keyframes: fading a look in is the common request.
       */
      { key: 'intensity', label: 'Intensity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
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
    type: 'compound-blur',
    label: 'Compound Blur',
    // GPU-only for the same reason Displace is: it reads a SECOND layer's
    // pixels, which the Canvas2D bake chain has no way to resolve.
    gpuOnly: true,
    params: [
      { key: 'maxBlur', label: 'Max Blur', type: 'number', unit: 'px', min: 0, max: 200, default: 20 },
      // The layer whose LUMINANCE scales the radius (AE's Blur Layer). '' =
      // unset → the layer blurs by its own luminance, which is visibly wrong
      // and debuggable rather than a silent no-op.
      { key: 'blurLayerId', label: 'Blur Layer', type: 'layer', default: '' },
      { key: 'invert', label: 'Invert Blur', type: 'checkbox', default: 0 },
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
  {
    /*
      Bend — AE's CC Bender, curling the layer around an axis.

      `gpuOnly` like Motion Tile and Displace: it is a warp with a closed-form
      inverse (see the BEND shader) and no Canvas2D twin, so on a layer baked
      for some other reason `extractSpatialEffects(layer, true)` carries it
      through to the GPU rather than dropping it.

      Style is the first `'enum'` param outside Echo — the three profiles differ
      in how the bend RAMPS IN across the span, and each has an exact analytic
      inverse, which is what keeps this one texture sample per pixel.
    */
    type: 'bend',
    label: 'Bend',
    gpuOnly: true,
    params: [
      { key: 'amount', label: 'Amount', type: 'number', unit: '°', min: -3600, max: 3600, default: 60 },
      {
        key: 'style',
        label: 'Style',
        type: 'enum',
        default: 0,
        options: [
          { value: 0, label: 'Marilyn' },
          { value: 1, label: 'Sharp' },
          { value: 2, label: 'Circular' },
        ],
      },
      /*
        Top and Base are AE's two POINT controls, and between them they carry
        everything about the bend line: where it starts, which way it runs, and
        how far the bend takes to complete. An earlier version of this effect
        reduced them to an angle plus two percentages along it — which cannot
        place the line off-centre at all, and silently ties the axis to the
        layer's middle. Points are strictly more expressive AND fewer controls.

        Stored as OFFSETS from a rest position, the convention every handled
        effect here uses (see effectHandles.ts): it makes the defaults zero,
        the identity state expressible, and the controls survive a resize.
        Rest is the top-centre and bottom-centre of the layer, as in AE.
      */
      { key: 'topX', label: 'Top X', type: 'number', unit: 'px', min: -8000, max: 8000, default: 0, group: 'Top' },
      { key: 'topY', label: 'Top Y', type: 'number', unit: 'px', min: -8000, max: 8000, default: 0, group: 'Top' },
      { key: 'baseX', label: 'Base X', type: 'number', unit: 'px', min: -8000, max: 8000, default: 0, group: 'Base' },
      { key: 'baseY', label: 'Base Y', type: 'number', unit: 'px', min: -8000, max: 8000, default: 0, group: 'Base' },
      {
        /*
          What happens to the part of the layer PAST Base — the control that
          decides whether this bends a region or the whole object.

          Carry is AE's CC Bender: the object hinges at the bend and everything
          below the hinge swings with it. That is right for bending a whole
          arm, and wrong when you wanted to put a kink in the middle of
          something and leave the rest alone — with Carry there is no way to do
          the latter, because the remainder always moves.

          Hold confines the deformation to the Top→Base band. Both are useful
          and they are not derivable from each other, so it is a control.
        */
        key: 'outside',
        label: 'Past Base',
        type: 'enum',
        default: 0,
        options: [
          { value: 0, label: 'Carry (hinge)' },
          { value: 1, label: 'Hold (bend band only)' },
        ],
      },
    ],
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
      {
        key: 'position',
        label: 'Position',
        type: 'enum',
        default: 0,
        options: [
          { value: 0, label: 'Outside' },
          { value: 1, label: 'Inside' },
          { value: 2, label: 'Center' },
        ],
      },
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

  // Curl Noise (AE 26.3) — swirling, divergence-free displacement: the curl of
  // a noise field, so the picture rotates around itself instead of piling up
  // the way Turbulent Displace does at high amounts. Keyframe `evolution`.
  {
    type: 'curl-noise',
    label: 'Curl Noise',
    params: [
      { key: 'amount', label: 'Amount', type: 'number', unit: 'px', min: 0, max: 500, default: 40 },
      { key: 'size', label: 'Size', type: 'number', unit: 'px', min: 4, max: 1000, default: 160 },
      { key: 'complexity', label: 'Complexity', type: 'number', min: 1, max: 6, default: 3 },
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
      /*
        AE's Echo Operator. The ghosts are ordinary render layers (see echo.ts),
        so "how do the echoes combine" is exactly their BLEND MODE — this maps
        onto compositing that already exists rather than adding a second one.

        Add is AE's default and the one that reads as a light trail. Composite
        In Front / In Back are `normal` differing only in z-order, which is why
        they are two entries against one mode.
      */
      {
        key: 'echoOperator',
        label: 'Echo Operator',
        type: 'enum',
        default: 0,
        options: [
          { value: 0, label: 'Add' },
          { value: 1, label: 'Maximum' },
          { value: 2, label: 'Minimum' },
          { value: 3, label: 'Screen' },
          { value: 4, label: 'Composite In Back' },
          { value: 5, label: 'Composite In Front' },
        ],
      },
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

  // ── Round three ───────────────────────────────────────────────────
  //
  // Every `css` below is empty, which is the norm for everything past the first
  // dozen effects: a CSS filter can express a handful of colour adjustments and
  // nothing else, so anything spatial, per-channel or generative renders through
  // the LUT path or the Canvas2D pixel chain instead. See `colorLut.ts` and
  // `aeColor.ts` for which, and why the choice is load-bearing.

  {
    // LUT path — nine per-channel pushes, free on both backends.
    type: 'color-balance',
    label: 'Color Balance',
    params: [
      { key: 'shadowRed', label: 'Shadow Red', type: 'number', min: -100, max: 100, default: 0 },
      { key: 'shadowGreen', label: 'Shadow Green', type: 'number', min: -100, max: 100, default: 0 },
      { key: 'shadowBlue', label: 'Shadow Blue', type: 'number', min: -100, max: 100, default: 0 },
      { key: 'midtoneRed', label: 'Midtone Red', type: 'number', min: -100, max: 100, default: 0 },
      { key: 'midtoneGreen', label: 'Midtone Green', type: 'number', min: -100, max: 100, default: 0 },
      { key: 'midtoneBlue', label: 'Midtone Blue', type: 'number', min: -100, max: 100, default: 0 },
      { key: 'highlightRed', label: 'Highlight Red', type: 'number', min: -100, max: 100, default: 0 },
      { key: 'highlightGreen', label: 'Highlight Green', type: 'number', min: -100, max: 100, default: 0 },
      { key: 'highlightBlue', label: 'Highlight Blue', type: 'number', min: -100, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    // LUT path. Gamma defaults to 1 and gain to 1 so an added effect is exactly
    // the identity — a grading control that changes the picture the moment it
    // is dropped on a layer is one people stop trusting.
    type: 'gamma-pedestal-gain',
    label: 'Gamma / Pedestal / Gain',
    params: [
      { key: 'gamma', label: 'Master Gamma', type: 'number', min: 0.1, max: 10, precision: 2, default: 1 },
      { key: 'pedestal', label: 'Master Pedestal', type: 'number', min: -1, max: 1, precision: 3, default: 0 },
      { key: 'gain', label: 'Master Gain', type: 'number', min: 0, max: 10, precision: 2, default: 1 },
      { key: 'redGamma', label: 'Red Gamma', type: 'number', min: 0.1, max: 10, precision: 2, default: 1 },
      { key: 'redPedestal', label: 'Red Pedestal', type: 'number', min: -1, max: 1, precision: 3, default: 0 },
      { key: 'redGain', label: 'Red Gain', type: 'number', min: 0, max: 10, precision: 2, default: 1 },
      { key: 'greenGamma', label: 'Green Gamma', type: 'number', min: 0.1, max: 10, precision: 2, default: 1 },
      { key: 'greenPedestal', label: 'Green Pedestal', type: 'number', min: -1, max: 1, precision: 3, default: 0 },
      { key: 'greenGain', label: 'Green Gain', type: 'number', min: 0, max: 10, precision: 2, default: 1 },
      { key: 'blueGamma', label: 'Blue Gamma', type: 'number', min: 0.1, max: 10, precision: 2, default: 1 },
      { key: 'bluePedestal', label: 'Blue Pedestal', type: 'number', min: -1, max: 1, precision: 3, default: 0 },
      { key: 'blueGain', label: 'Blue Gain', type: 'number', min: 0, max: 10, precision: 2, default: 1 },
    ],
    css: () => '',
  },
  {
    type: 'photo-filter',
    label: 'Photo Filter',
    params: [
      // AE's Warming Filter (85) as the default, because a photo filter set to
      // white is a no-op and gives no clue what the effect does.
      { key: 'color', label: 'Filter Color', type: 'color', default: '#ec8a00' },
      { key: 'density', label: 'Density', type: 'number', unit: '%', min: 0, max: 100, default: 25 },
      // On by default, matching AE — and it is the whole reason this is a pixel
      // pass rather than a colour matrix. See `photoFilterData`.
      { key: 'preserveLuminosity', label: 'Preserve Luminosity', type: 'checkbox', default: true },
    ],
    css: () => '',
  },
  {
    type: 'black-and-white',
    label: 'Black & White',
    params: [
      // Photoshop/AE's default mix, which is a neutral-looking starting point
      // rather than a flat luma conversion.
      { key: 'reds', label: 'Reds', type: 'number', unit: '%', min: -200, max: 300, default: 40 },
      { key: 'yellows', label: 'Yellows', type: 'number', unit: '%', min: -200, max: 300, default: 60 },
      { key: 'greens', label: 'Greens', type: 'number', unit: '%', min: -200, max: 300, default: 40 },
      { key: 'cyans', label: 'Cyans', type: 'number', unit: '%', min: -200, max: 300, default: 60 },
      { key: 'blues', label: 'Blues', type: 'number', unit: '%', min: -200, max: 300, default: 20 },
      { key: 'magentas', label: 'Magentas', type: 'number', unit: '%', min: -200, max: 300, default: 80 },
      { key: 'tint', label: 'Tint', type: 'checkbox', default: false },
      { key: 'tintColor', label: 'Tint Color', type: 'color', default: '#d8b48a' },
    ],
    css: () => '',
  },
  {
    type: 'tritone',
    label: 'Tritone',
    params: [
      { key: 'highlights', label: 'Highlights', type: 'color', default: '#ffffff' },
      { key: 'midtones', label: 'Midtones', type: 'color', default: '#808080' },
      { key: 'shadows', label: 'Shadows', type: 'color', default: '#000000' },
      { key: 'blend', label: 'Blend With Original', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    type: 'threshold',
    label: 'Threshold',
    params: [
      { key: 'level', label: 'Level', type: 'number', min: 0, max: 255, default: 128 },
    ],
    css: () => '',
  },
  {
    type: 'polar-coordinates',
    label: 'Polar Coordinates',
    params: [
      { key: 'interpolation', label: 'Interpolation', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      // A number rather than a checkbox so it keyframes, matching how the other
      // menu-style params in this file (blur dimensions, card wipe direction)
      // are stored. 0 = Rect to Polar, 1 = Polar to Rect.
      { key: 'conversion', label: 'Type of Conversion', type: 'number', min: 0, max: 1, default: 0 },
    ],
    css: () => '',
  },
  {
    type: 'liquify',
    label: 'Liquify',
    /*
      One brush, not a stroke history. See `liquifyData` — AE's Liquify stores
      an opaque distortion MESH built from freehand strokes, and a mesh cannot
      travel through a parameter system whose values are numbers. Numbers are
      what ride the keyframe path, so a stored-mesh version would be a Liquify
      that cannot animate. Stack several of these for several strokes.
    */
    params: [
      { key: 'centerX', label: 'Brush Center X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'centerY', label: 'Brush Center Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'brushSize', label: 'Brush Size', type: 'number', unit: 'px', min: 0, max: 2000, default: 120 },
      // The Warp tool, and the only one of the three with no equivalent
      // elsewhere in this registry.
      { key: 'pushX', label: 'Push X', type: 'number', unit: 'px', min: -1000, max: 1000, default: 0 },
      { key: 'pushY', label: 'Push Y', type: 'number', unit: 'px', min: -1000, max: 1000, default: 0 },
      { key: 'twirl', label: 'Twirl', type: 'number', unit: '°', min: -720, max: 720, default: 0 },
      // Negative bloats, which is why the range is signed rather than two
      // controls that would have to be kept mutually exclusive.
      { key: 'pinch', label: 'Pinch', type: 'number', unit: '%', min: -100, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    type: 'mesh-warp',
    label: 'Mesh Warp',
    /*
      A FIXED 4×4 lattice — 16 vertices, 32 offsets.

      AE exposes Rows and Columns; this cannot, and the reason is the
      parameter system rather than the maths. Effect parameters here are
      NUMBERS because that is what rides the keyframe path, and the distortion
      mesh is the thing users animate. A variable-size mesh would have to be
      stored as an opaque blob, which cannot keyframe at all — so an
      adjustable row count would be bought by freezing the whole mesh, which
      is the wrong trade for what this effect is for.

      Sixteen is also where a parameter list stops being navigable: Bezier
      Warp's twelve already fill a panel.
    */
    params: [
      { key: 'v0X', label: 'Vertex 1,1 X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'v0Y', label: 'Vertex 1,1 Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'v1X', label: 'Vertex 2,1 X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'v1Y', label: 'Vertex 2,1 Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'v2X', label: 'Vertex 3,1 X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'v2Y', label: 'Vertex 3,1 Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'v3X', label: 'Vertex 4,1 X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'v3Y', label: 'Vertex 4,1 Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'v4X', label: 'Vertex 1,2 X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'v4Y', label: 'Vertex 1,2 Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'v5X', label: 'Vertex 2,2 X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'v5Y', label: 'Vertex 2,2 Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'v6X', label: 'Vertex 3,2 X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'v6Y', label: 'Vertex 3,2 Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'v7X', label: 'Vertex 4,2 X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'v7Y', label: 'Vertex 4,2 Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'v8X', label: 'Vertex 1,3 X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'v8Y', label: 'Vertex 1,3 Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'v9X', label: 'Vertex 2,3 X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'v9Y', label: 'Vertex 2,3 Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'v10X', label: 'Vertex 3,3 X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'v10Y', label: 'Vertex 3,3 Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'v11X', label: 'Vertex 4,3 X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'v11Y', label: 'Vertex 4,3 Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'v12X', label: 'Vertex 1,4 X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'v12Y', label: 'Vertex 1,4 Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'v13X', label: 'Vertex 2,4 X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'v13Y', label: 'Vertex 2,4 Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'v14X', label: 'Vertex 3,4 X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'v14Y', label: 'Vertex 3,4 Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'v15X', label: 'Vertex 4,4 X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'v15Y', label: 'Vertex 4,4 Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
    ],
    css: () => '',
  },
  {
    type: 'optics-compensation',
    label: 'Optics Compensation',
    params: [
      // Defaults to 0 — the IDENTITY. An effect that warps the moment it is
      // added would have to be undone before it could be dialled in, and this
      // one is normally matched to a measured lens rather than eyeballed.
      { key: 'fieldOfView', label: 'Field of View', type: 'number', unit: '°', min: 0, max: 180, default: 0 },
      // A checkbox rather than a signed field of view: the two directions are a
      // MODE, and the workflow is a matched pair — remove on the plate,
      // re-apply on the comp — so the value must stay identical while only this
      // flips. A signed control would invite two different magnitudes.
      { key: 'reverse', label: 'Reverse Lens Distortion', type: 'checkbox', default: 0 },
      // Offsets from the layer's middle, for the reason Bulge's are: an
      // EffectDef cannot see the layer, so an absolute default would be 0,0.
      { key: 'centerX', label: 'Center X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'centerY', label: 'Center Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
    ],
    css: () => '',
  },
  {
    // Centre as an OFFSET from the layer's middle, for the reason Bulge's is —
    // an EffectDef cannot see the layer, so an absolute default would be 0,0.
    type: 'mirror',
    label: 'Mirror',
    params: [
      { key: 'centerX', label: 'Reflection Centre X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'centerY', label: 'Reflection Centre Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      // The full 360°: the angle names the normal's direction, so 0 and 180 keep
      // opposite halves. Clamping to 180 would make half the mirrors unreachable.
      { key: 'angle', label: 'Reflection Angle', type: 'number', unit: '°', min: -360, max: 360, default: 0 },
    ],
    css: () => '',
  },
  {
    type: 'offset',
    label: 'Offset',
    params: [
      { key: 'shiftX', label: 'Shift Centre To X', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'shiftY', label: 'Shift Centre To Y', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'blend', label: 'Blend With Original', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    type: 'emboss',
    label: 'Emboss',
    params: [
      { key: 'angle', label: 'Direction', type: 'number', unit: '°', min: -360, max: 360, default: 135 },
      { key: 'relief', label: 'Relief', type: 'number', unit: 'px', min: 0, max: 50, precision: 1, default: 1 },
      { key: 'contrast', label: 'Contrast', type: 'number', unit: '%', min: 0, max: 1000, default: 100 },
      { key: 'blend', label: 'Blend With Original', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    type: 'scatter',
    label: 'Scatter',
    params: [
      { key: 'amount', label: 'Scatter Amount', type: 'number', unit: 'px', min: 0, max: 200, default: 10 },
      // 0 = both, 1 = horizontal, 2 = vertical — the same encoding blur
      // dimensions uses, so the two menus read the same way.
      { key: 'grain', label: 'Grain', type: 'number', min: 0, max: 2, default: 0 },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 10000, default: 1 },
      // Separate from the seed on purpose: the seed picks WHICH pattern, and
      // evolution animates within it. Keyframing the seed jump-cuts.
      { key: 'evolution', label: 'Evolution', type: 'number', min: 0, max: 10000, default: 0 },
    ],
    css: () => '',
  },
  {
    type: 'radial-wipe',
    label: 'Radial Wipe',
    params: [
      { key: 'completion', label: 'Transition Completion', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'startAngle', label: 'Start Angle', type: 'number', unit: '°', min: -360, max: 360, default: 0 },
      // 0 = clockwise, 1 = counterclockwise, 2 = both.
      { key: 'wipe', label: 'Wipe', type: 'number', min: 0, max: 2, default: 0 },
      { key: 'centerX', label: 'Centre X Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'centerY', label: 'Centre Y Offset', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      // In DEGREES, not pixels — see `radialWipeData` for why a pixel feather
      // would be wide at the pivot and invisible at the rim.
      { key: 'feather', label: 'Feather', type: 'number', unit: '°', min: 0, max: 90, precision: 1, default: 0 },
    ],
    css: () => '',
  },
  {
    type: 'block-dissolve',
    label: 'Block Dissolve',
    params: [
      { key: 'completion', label: 'Transition Completion', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'blockWidth', label: 'Block Width', type: 'number', unit: 'px', min: 1, max: 500, default: 20 },
      { key: 'blockHeight', label: 'Block Height', type: 'number', unit: 'px', min: 1, max: 500, default: 20 },
      { key: 'feather', label: 'Feather', type: 'number', unit: 'px', min: 0, max: 100, default: 0 },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 10000, default: 1 },
    ],
    css: () => '',
  },
  {
    type: 'luma-key',
    label: 'Luma Key',
    params: [
      // 0 = brighter, 1 = darker, 2 = similar, 3 = dissimilar.
      { key: 'keyType', label: 'Key Type', type: 'number', min: 0, max: 3, default: 0 },
      { key: 'threshold', label: 'Threshold', type: 'number', min: 0, max: 255, default: 128 },
      { key: 'tolerance', label: 'Tolerance', type: 'number', min: 0, max: 255, default: 10 },
      { key: 'softness', label: 'Edge Softness', type: 'number', min: 0, max: 255, default: 10 },
    ],
    css: () => '',
  },
  {
    type: 'minimax',
    label: 'Minimax',
    params: [
      // 0 = maximum, 1 = minimum, 2 = max then min, 3 = min then max.
      { key: 'operation', label: 'Operation', type: 'number', min: 0, max: 3, default: 0 },
      { key: 'radius', label: 'Radius', type: 'number', unit: 'px', min: 0, max: 100, default: 2 },
      // 0 = alpha, 1 = colour, 2 = red, 3 = green, 4 = blue. Alpha leads because
      // matte repair is what the effect is for.
      { key: 'channel', label: 'Channel', type: 'number', min: 0, max: 4, default: 0 },
      { key: 'direction', label: 'Direction', type: 'number', min: 0, max: 2, default: 0 },
    ],
    css: () => '',
  },
  {
    type: 'channel-blur',
    label: 'Channel Blur',
    params: [
      { key: 'redBlurriness', label: 'Red Blurriness', type: 'number', unit: 'px', min: 0, max: 200, default: 0 },
      { key: 'greenBlurriness', label: 'Green Blurriness', type: 'number', unit: 'px', min: 0, max: 200, default: 0 },
      { key: 'blueBlurriness', label: 'Blue Blurriness', type: 'number', unit: 'px', min: 0, max: 200, default: 0 },
      { key: 'alphaBlurriness', label: 'Alpha Blurriness', type: 'number', unit: 'px', min: 0, max: 200, default: 0 },
      { key: 'dimensions', label: 'Blur Dimensions', type: 'number', min: 0, max: 2, default: 0 },
      { key: 'repeatEdge', label: 'Repeat Edge Pixels', type: 'checkbox', default: false },
    ],
    css: () => '',
  },
  {
    type: 'unsharp-mask',
    label: 'Unsharp Mask',
    params: [
      { key: 'amount', label: 'Amount', type: 'number', unit: '%', min: 0, max: 500, default: 50 },
      { key: 'radius', label: 'Radius', type: 'number', unit: 'px', min: 0, max: 100, precision: 1, default: 2 },
      // 0 = sharpen everything. Raising it is how grain is protected; see
      // `unsharpMaskData`.
      { key: 'threshold', label: 'Threshold', type: 'number', min: 0, max: 255, default: 0 },
    ],
    css: () => '',
  },

  // ══ Round four ═════════════════════════════════════════════════════
  //
  // Every def below is `css: () => ''` and every one is in `CANVAS2D_ONLY`.
  // That pairing is asserted by `canvas2dEffects.test.ts` and is not decoration:
  // a non-empty `css` would make the effect ALSO apply as a CSS filter, so it
  // would render twice on any layer that did not bake.

  // ── Blur & Sharpen ────────────────────────────────────────────────
  {
    type: 'bilateral-blur',
    label: 'Bilateral Blur',
    params: [
      // Capped at 24 in the kernel too — this is O(r²) per pixel and an
      // unclamped radius is a hang, not a slow frame.
      { key: 'radius', label: 'Radius', type: 'number', unit: 'px', min: 0, max: 24, default: 6 },
      { key: 'colorSigma', label: 'Threshold', type: 'number', min: 1, max: 255, default: 40 },
      { key: 'preserveAlpha', label: 'Preserve Alpha', type: 'checkbox', default: true },
    ],
    css: () => '',
  },
  {
    type: 'smart-blur',
    label: 'Smart Blur',
    params: [
      { key: 'radius', label: 'Radius', type: 'number', unit: 'px', min: 0, max: 24, default: 8 },
      { key: 'threshold', label: 'Threshold', type: 'number', min: 0, max: 255, default: 24 },
      // 0 normal · 1 edge only · 2 overlay edge.
      { key: 'mode', label: 'Mode', type: 'number', min: 0, max: 2, precision: 0, default: 0 },
    ],
    css: () => '',
  },
  {
    type: 'camera-lens-blur',
    label: 'Camera Lens Blur',
    params: [
      { key: 'radius', label: 'Blur Radius', type: 'number', unit: 'px', min: 0, max: 24, default: 8 },
      // < 3 = circular iris. The polygon is what makes bokeh read as a lens.
      { key: 'blades', label: 'Iris Blades', type: 'number', min: 0, max: 12, precision: 0, default: 6 },
      { key: 'irisRotation', label: 'Iris Rotation', type: 'number', unit: '°', min: -180, max: 180, default: 0 },
      { key: 'gain', label: 'Highlight Gain', type: 'number', min: 1, max: 12, precision: 1, default: 3 },
      { key: 'highlightThreshold', label: 'Highlight Threshold', type: 'number', unit: '%', min: 0, max: 100, default: 70 },
    ],
    css: () => '',
  },

  // ── Distort ───────────────────────────────────────────────────────
  {
    type: 'ripple',
    label: 'Ripple',
    params: [
      { key: 'centerX', label: 'Center X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'centerY', label: 'Center Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'radius', label: 'Radius', type: 'number', unit: 'px', min: 0, max: 4000, default: 0 },
      { key: 'amplitude', label: 'Amplitude', type: 'number', unit: 'px', min: -200, max: 200, default: 12 },
      { key: 'frequency', label: 'Frequency', type: 'number', min: 0, max: 40, precision: 1, default: 6 },
      // Keyframe this linearly to send rings travelling outward.
      { key: 'phase', label: 'Phase', type: 'number', unit: '°', min: -3600, max: 3600, default: 0 },
      { key: 'decay', label: 'Decay', type: 'number', min: 0, max: 8, precision: 1, default: 0 },
    ],
    css: () => '',
  },
  {
    type: 'magnify',
    label: 'Magnify',
    params: [
      { key: 'centerX', label: 'Center X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'centerY', label: 'Center Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'magnification', label: 'Magnification', type: 'number', unit: '%', min: 1, max: 800, default: 200 },
      { key: 'radius', label: 'Size', type: 'number', unit: 'px', min: 0, max: 4000, default: 150 },
      { key: 'shape', label: 'Shape', type: 'number', min: 0, max: 1, precision: 0, default: 0 },
      { key: 'feather', label: 'Feather', type: 'number', unit: 'px', min: 0, max: 500, default: 20 },
    ],
    css: () => '',
  },
  {
    type: 'warp',
    label: 'Warp',
    params: [
      // 0 Arc · 1 Arch · 2 Flag · 3 Wave · 4 Fisheye · 5 Rise · 6 Bulge.
      { key: 'style', label: 'Warp Style', type: 'number', min: 0, max: 6, precision: 0, default: 0 },
      { key: 'bend', label: 'Bend', type: 'number', unit: '%', min: -200, max: 200, default: 50 },
      { key: 'horizontalDistortion', label: 'Horizontal Distortion', type: 'number', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'verticalDistortion', label: 'Vertical Distortion', type: 'number', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'warpAxis', label: 'Warp Axis', type: 'number', min: 0, max: 1, precision: 0, default: 0 },
    ],
    css: () => '',
  },
  {
    type: 'page-turn',
    label: 'Page Turn',
    params: [
      { key: 'amount', label: 'Turn Amount', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'angle', label: 'Fold Angle', type: 'number', unit: '°', min: -180, max: 180, default: 45 },
      { key: 'curlRadius', label: 'Curl Radius', type: 'number', unit: 'px', min: 1, max: 500, default: 60 },
      { key: 'backOpacity', label: 'Back Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 60 },
      { key: 'shading', label: 'Shading', type: 'number', unit: '%', min: 0, max: 100, default: 55 },
    ],
    css: () => '',
  },
  {
    type: 'split',
    label: 'Split',
    params: [
      { key: 'splitOffset', label: 'Split', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'angle', label: 'Angle', type: 'number', unit: '°', min: -180, max: 180, default: 0 },
      { key: 'centerX', label: 'Center X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'centerY', label: 'Center Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
    ],
    css: () => '',
  },
  {
    type: 'slant',
    label: 'Slant',
    params: [
      { key: 'slant', label: 'Slant', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'slantAxis', label: 'Axis', type: 'number', min: 0, max: 1, precision: 0, default: 0 },
      // Where the shear hinges: 0 top/left, 1 bottom/right, 0.5 centre.
      { key: 'floor', label: 'Floor', type: 'number', min: 0, max: 1, precision: 2, default: 1 },
    ],
    css: () => '',
  },
  {
    type: 'smear',
    label: 'Smear',
    params: [
      { key: 'fromX', label: 'From X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'fromY', label: 'From Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'toX', label: 'To X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 40 },
      { key: 'toY', label: 'To Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'radius', label: 'Radius', type: 'number', unit: 'px', min: 0, max: 2000, default: 120 },
      { key: 'elasticity', label: 'Elasticity', type: 'number', unit: '%', min: 10, max: 400, default: 100 },
    ],
    css: () => '',
  },
  {
    type: 'rolling-shutter',
    label: 'Rolling Shutter',
    params: [
      { key: 'sweep', label: 'Sweep', type: 'number', unit: 'px', min: -1000, max: 1000, default: 30 },
      // The non-linear part. Without it this is just a shear.
      { key: 'wobble', label: 'Wobble', type: 'number', unit: 'px', min: -500, max: 500, default: 0 },
      { key: 'scanDirection', label: 'Scan Direction', type: 'number', min: 0, max: 1, precision: 0, default: 0 },
      { key: 'verticalScan', label: 'Vertical Scan', type: 'checkbox', default: false },
    ],
    css: () => '',
  },

  // ── Perspective ───────────────────────────────────────────────────
  {
    type: 'radial-shadow',
    label: 'Radial Shadow',
    params: [
      { key: 'lightX', label: 'Light Source X', type: 'number', unit: 'px', min: -4000, max: 4000, default: -120 },
      { key: 'lightY', label: 'Light Source Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: -120 },
      { key: 'projection', label: 'Projection Distance', type: 'number', unit: '%', min: 0, max: 400, default: 30 },
      { key: 'shadowColor', label: 'Shadow Color', type: 'color', default: '#000000' },
      { key: 'shadowOpacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 60 },
      { key: 'softness', label: 'Softness', type: 'number', unit: 'px', min: 0, max: 100, default: 8 },
      { key: 'renderMode', label: 'Render', type: 'number', min: 0, max: 1, precision: 0, default: 0 },
    ],
    css: () => '',
  },

  // ── Generate ──────────────────────────────────────────────────────
  {
    type: 'circle',
    label: 'Circle',
    params: [
      { key: 'centerX', label: 'Center X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'centerY', label: 'Center Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'radius', label: 'Radius', type: 'number', unit: 'px', min: 0, max: 4000, default: 120 },
      { key: 'color', label: 'Color', type: 'color', default: '#ffffff' },
      { key: 'opacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'feather', label: 'Feather', type: 'number', unit: 'px', min: 0, max: 1000, default: 0 },
      // 0 = filled disc; > 0 = a ring of this thickness.
      { key: 'thickness', label: 'Edge Thickness', type: 'number', unit: 'px', min: 0, max: 1000, default: 0 },
      { key: 'invertCircle', label: 'Invert Circle', type: 'checkbox', default: false },
      { key: 'composite', label: 'Composite', type: 'number', min: 0, max: 4, precision: 0, default: 0 },
    ],
    css: () => '',
  },
  {
    type: 'ellipse',
    label: 'Ellipse',
    params: [
      { key: 'centerX', label: 'Center X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'centerY', label: 'Center Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'ellipseWidth', label: 'Width', type: 'number', unit: 'px', min: 0, max: 8000, default: 320 },
      { key: 'ellipseHeight', label: 'Height', type: 'number', unit: 'px', min: 0, max: 8000, default: 200 },
      { key: 'rotation', label: 'Rotation', type: 'number', unit: '°', min: -360, max: 360, default: 0 },
      { key: 'thickness', label: 'Thickness', type: 'number', unit: 'px', min: 0, max: 500, default: 6 },
      { key: 'softness', label: 'Softness', type: 'number', unit: 'px', min: 0, max: 200, default: 0 },
      { key: 'color', label: 'Color', type: 'color', default: '#ffffff' },
      { key: 'opacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'composite', label: 'Composite', type: 'number', min: 0, max: 4, precision: 0, default: 0 },
    ],
    css: () => '',
  },
  {
    type: 'radio-waves',
    label: 'Radio Waves',
    params: [
      { key: 'centerX', label: 'Center X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'centerY', label: 'Center Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'waveCount', label: 'Wave Count', type: 'number', min: 1, max: 64, precision: 0, default: 5 },
      { key: 'maxRadius', label: 'Max Radius', type: 'number', unit: 'px', min: 0, max: 4000, default: 0 },
      // Keyframe linearly for a steady pulse; the ring set wraps seamlessly.
      { key: 'phase', label: 'Phase', type: 'number', unit: '°', min: -3600, max: 3600, default: 0 },
      { key: 'thickness', label: 'Thickness', type: 'number', unit: 'px', min: 0, max: 200, default: 3 },
      { key: 'color', label: 'Color', type: 'color', default: '#7dd3fc' },
      { key: 'opacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'fadeOut', label: 'Fade Out', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'composite', label: 'Composite', type: 'number', min: 0, max: 4, precision: 0, default: 0 },
    ],
    css: () => '',
  },
  {
    type: 'lightning',
    label: 'Lightning',
    params: [
      { key: 'startX', label: 'Start X', type: 'number', unit: 'px', min: -4000, max: 4000, default: -200 },
      { key: 'startY', label: 'Start Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: -150 },
      { key: 'endX', label: 'End X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 200 },
      { key: 'endY', label: 'End Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 150 },
      { key: 'detail', label: 'Detail', type: 'number', min: 1, max: 9, precision: 0, default: 6 },
      { key: 'amplitude', label: 'Amplitude', type: 'number', unit: 'px', min: 0, max: 1000, default: 120 },
      { key: 'branches', label: 'Branches', type: 'number', min: 0, max: 12, precision: 0, default: 3 },
      { key: 'thickness', label: 'Thickness', type: 'number', unit: 'px', min: 0, max: 100, precision: 1, default: 2.5 },
      { key: 'color', label: 'Color', type: 'color', default: '#cfe8ff' },
      { key: 'glow', label: 'Glow', type: 'number', unit: 'px', min: 0, max: 200, default: 8 },
      { key: 'opacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      // Deterministic: re-rendering a frame must give the same bolt, or the
      // content hash is useless and the export flickers. Keyframe to re-strike.
      { key: 'seed', label: 'Seed', type: 'number', min: 0, max: 100000, precision: 0, default: 1 },
      { key: 'composite', label: 'Composite', type: 'number', min: 0, max: 4, precision: 0, default: 1 },
    ],
    css: () => '',
  },
  {
    type: 'light-rays',
    label: 'Light Rays',
    params: [
      { key: 'centerX', label: 'Center X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'centerY', label: 'Center Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'rayCount', label: 'Ray Count', type: 'number', min: 1, max: 256, precision: 0, default: 48 },
      { key: 'rayLength', label: 'Length', type: 'number', unit: 'px', min: 0, max: 6000, default: 600 },
      { key: 'spread', label: 'Spread', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'rotation', label: 'Rotation', type: 'number', unit: '°', min: -360, max: 360, default: 0 },
      { key: 'color', label: 'Color', type: 'color', default: '#fff3c4' },
      { key: 'opacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 70 },
      { key: 'falloff', label: 'Falloff', type: 'number', unit: '%', min: 0, max: 100, default: 40 },
      { key: 'seed', label: 'Seed', type: 'number', min: 0, max: 100000, precision: 0, default: 1 },
      { key: 'composite', label: 'Composite', type: 'number', min: 0, max: 4, precision: 0, default: 1 },
    ],
    css: () => '',
  },
  {
    type: 'light-sweep',
    label: 'Light Sweep',
    params: [
      // −100..200 so the band starts and ends fully off-frame. See the kernel.
      { key: 'position', label: 'Position', type: 'number', unit: '%', min: -100, max: 200, default: 50 },
      { key: 'sweepWidth', label: 'Width', type: 'number', unit: 'px', min: 0, max: 4000, default: 200 },
      { key: 'angle', label: 'Angle', type: 'number', unit: '°', min: -180, max: 180, default: 0 },
      { key: 'color', label: 'Color', type: 'color', default: '#ffffff' },
      { key: 'intensity', label: 'Intensity', type: 'number', unit: '%', min: 0, max: 100, default: 70 },
      { key: 'softness', label: 'Softness', type: 'number', unit: '%', min: 0, max: 100, default: 60 },
      // Defaults to source-atop so the shine is clipped to the layer.
      { key: 'composite', label: 'Composite', type: 'number', min: 0, max: 4, precision: 0, default: 4 },
    ],
    css: () => '',
  },
  {
    type: 'audio-waveform',
    label: 'Audio Waveform',
    params: [
      { key: 'audioLayerId', label: 'Audio Layer', type: 'layer', default: '' },
      { key: 'displayMode', label: 'Display Mode', type: 'number', min: 0, max: 2, precision: 0, default: 0 },
      { key: 'maxHeight', label: 'Maximum Height', type: 'number', unit: 'px', min: 1, max: 4000, default: 200 },
      { key: 'thickness', label: 'Thickness', type: 'number', unit: 'px', min: 1, max: 200, default: 3 },
      { key: 'insideColor', label: 'Inside Colour', type: 'color', default: '#7dd3fc' },
      { key: 'outsideColor', label: 'Outside Colour', type: 'color', default: '#1d4ed8' },
      { key: 'opacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'composite', label: 'Composite', type: 'number', min: 0, max: 4, precision: 0, default: 0 },
      // RESOLVED, like Audio Spectrum's `magnitudes`: written by `buildSnapshot`
      // from the referenced layer every frame, so no inspector control could
      // meaningfully edit it.
      { key: 'samples', label: 'Samples (resolved)', type: 'resolved', default: [] },
    ],
    css: () => '',
  },

  // ── Stylize ───────────────────────────────────────────────────────
  {
    type: 'cartoon',
    label: 'Cartoon',
    params: [
      { key: 'smoothness', label: 'Smoothness', type: 'number', unit: 'px', min: 0, max: 12, precision: 0, default: 3 },
      { key: 'levels', label: 'Shading Steps', type: 'number', min: 2, max: 64, precision: 0, default: 6 },
      { key: 'edgeThreshold', label: 'Edge Threshold', type: 'number', min: 0, max: 255, default: 25 },
      { key: 'edgeWidth', label: 'Edge Width', type: 'number', unit: 'px', min: 1, max: 10, precision: 0, default: 1 },
      { key: 'edgeOpacity', label: 'Edge Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
    ],
    css: () => '',
  },
  {
    type: 'brush-strokes',
    label: 'Brush Strokes',
    params: [
      { key: 'strokeAngle', label: 'Stroke Angle', type: 'number', unit: '°', min: -360, max: 360, default: 45 },
      { key: 'strokeLength', label: 'Stroke Length', type: 'number', unit: 'px', min: 1, max: 32, precision: 0, default: 8 },
      { key: 'randomness', label: 'Randomness', type: 'number', unit: '%', min: 0, max: 100, default: 25 },
      { key: 'cellSize', label: 'Brush Size', type: 'number', unit: 'px', min: 1, max: 200, precision: 0, default: 12 },
      { key: 'density', label: 'Density', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
    ],
    css: () => '',
  },
  {
    type: 'strobe-light',
    label: 'Strobe Light',
    params: [
      { key: 'strobePeriod', label: 'Strobe Period', type: 'number', unit: 's', min: 0.01, max: 30, precision: 2, default: 0.5 },
      { key: 'strobeDuty', label: 'Strobe Duration', type: 'number', unit: '%', min: 1, max: 100, default: 20 },
      // 0 colour · 1 invert · 2 opacity.
      { key: 'strobeOperation', label: 'Operation', type: 'number', min: 0, max: 2, precision: 0, default: 0 },
      { key: 'strobeColor', label: 'Strobe Color', type: 'color', default: '#ffffff' },
      { key: 'intensity', label: 'Intensity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      // RESOLVED from the clock — see `TIME_DEPENDENT`. This is what makes the
      // strobe fire; it is not a control.
      { key: 'time', label: 'Time (resolved)', type: 'resolved', default: 0 },
    ],
    css: () => '',
  },
  {
    type: 'color-emboss',
    label: 'Color Emboss',
    params: [
      { key: 'direction', label: 'Direction', type: 'number', unit: '°', min: -360, max: 360, default: 45 },
      { key: 'relief', label: 'Relief', type: 'number', unit: 'px', min: 1, max: 50, precision: 0, default: 1 },
      { key: 'contrast', label: 'Contrast', type: 'number', unit: '%', min: 0, max: 500, default: 100 },
      { key: 'blendWithOriginal', label: 'Blend With Original', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    type: 'halftone',
    label: 'Halftone',
    params: [
      { key: 'cellSize', label: 'Cell Size', type: 'number', unit: 'px', min: 2, max: 200, precision: 0, default: 8 },
      // 45° by default: an unrotated screen moirés against any detail.
      { key: 'screenAngle', label: 'Screen Angle', type: 'number', unit: '°', min: -180, max: 180, default: 45 },
      { key: 'contrast', label: 'Contrast', type: 'number', unit: '%', min: 1, max: 400, default: 100 },
      { key: 'inkColor', label: 'Ink', type: 'color', default: '#000000' },
      { key: 'paperColor', label: 'Paper', type: 'color', default: '#ffffff' },
      { key: 'colorize', label: 'Use Source Colour', type: 'checkbox', default: false },
      { key: 'blendWithOriginal', label: 'Blend With Original', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    type: 'kaleidoscope',
    label: 'Kaleidoscope',
    params: [
      { key: 'segments', label: 'Segments', type: 'number', min: 1, max: 64, precision: 0, default: 6 },
      { key: 'centerX', label: 'Center X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'centerY', label: 'Center Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'rotation', label: 'Rotation', type: 'number', unit: '°', min: -3600, max: 3600, default: 0 },
      { key: 'sourceAngle', label: 'Source Angle', type: 'number', unit: '°', min: -360, max: 360, default: 0 },
      { key: 'zoom', label: 'Zoom', type: 'number', unit: '%', min: 1, max: 800, default: 100 },
    ],
    css: () => '',
  },
  {
    type: 'vignette',
    label: 'Vignette',
    params: [
      { key: 'amount', label: 'Amount', type: 'number', unit: '%', min: -100, max: 100, default: 55 },
      { key: 'size', label: 'Size', type: 'number', unit: '%', min: 0, max: 200, default: 55 },
      { key: 'feather', label: 'Feather', type: 'number', unit: '%', min: 1, max: 200, default: 60 },
      // 0 = follows the frame's aspect, 100 = circular.
      { key: 'roundness', label: 'Roundness', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'centerX', label: 'Center X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'centerY', label: 'Center Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
    ],
    css: () => '',
  },
  {
    type: 'burn-film',
    label: 'Burn Film',
    params: [
      { key: 'burn', label: 'Burn', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'centerX', label: 'Center X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'centerY', label: 'Center Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'burnColor', label: 'Burn Color', type: 'color', default: '#fff6e0' },
      { key: 'charColor', label: 'Char Color', type: 'color', default: '#3d1f0a' },
      { key: 'randomness', label: 'Randomness', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'seed', label: 'Seed', type: 'number', min: 0, max: 100000, precision: 0, default: 1 },
    ],
    css: () => '',
  },

  // ── Colour Correction ─────────────────────────────────────────────
  {
    type: 'equalize',
    label: 'Equalize',
    params: [
      // 0 RGB (shifts hue — that is the look) · 1 Brightness (hue-preserving).
      { key: 'equalizeMode', label: 'Equalize', type: 'number', min: 0, max: 1, precision: 0, default: 1 },
      { key: 'amount', label: 'Amount To Equalize', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'blend', label: 'Blend With Original', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    type: 'auto-levels',
    label: 'Auto Levels',
    params: [
      { key: 'blackClip', label: 'Black Clip', type: 'number', unit: '%', min: 0, max: 20, precision: 2, default: 0.1 },
      { key: 'whiteClip', label: 'White Clip', type: 'number', unit: '%', min: 0, max: 20, precision: 2, default: 0.1 },
      // The control that stops an auto grade breathing frame to frame.
      { key: 'blend', label: 'Blend With Original', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    type: 'auto-contrast',
    label: 'Auto Contrast',
    params: [
      { key: 'blackClip', label: 'Black Clip', type: 'number', unit: '%', min: 0, max: 20, precision: 2, default: 0.1 },
      { key: 'whiteClip', label: 'White Clip', type: 'number', unit: '%', min: 0, max: 20, precision: 2, default: 0.1 },
      { key: 'blend', label: 'Blend With Original', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    type: 'auto-color',
    label: 'Auto Color',
    params: [
      { key: 'blackClip', label: 'Black Clip', type: 'number', unit: '%', min: 0, max: 20, precision: 2, default: 0.1 },
      { key: 'whiteClip', label: 'White Clip', type: 'number', unit: '%', min: 0, max: 20, precision: 2, default: 0.1 },
      // The midtone pull — what a stretch alone cannot fix.
      { key: 'snapNeutral', label: 'Snap Neutral Midtones', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'blend', label: 'Blend With Original', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    type: 'change-color',
    label: 'Change Color',
    params: [
      { key: 'targetColor', label: 'Color To Change', type: 'color', default: '#ff0000' },
      { key: 'hueTolerance', label: 'Hue Tolerance', type: 'number', unit: '%', min: 0, max: 100, default: 12 },
      { key: 'satTolerance', label: 'Saturation Tolerance', type: 'number', unit: '%', min: 0, max: 100, default: 60 },
      { key: 'lightTolerance', label: 'Lightness Tolerance', type: 'number', unit: '%', min: 0, max: 100, default: 60 },
      { key: 'softness', label: 'Softness', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'hueShift', label: 'Hue Transform', type: 'number', unit: '°', min: -360, max: 360, default: 60 },
      { key: 'satScale', label: 'Lightness Transform', type: 'number', unit: '%', min: -100, max: 200, default: 0 },
      { key: 'lightScale', label: 'Saturation Transform', type: 'number', unit: '%', min: -100, max: 200, default: 0 },
      { key: 'invertSelection', label: 'Invert Selection', type: 'checkbox', default: false },
    ],
    css: () => '',
  },
  {
    type: 'change-to-color',
    label: 'Change To Color',
    params: [
      { key: 'fromColor', label: 'From', type: 'color', default: '#ff0000' },
      { key: 'toColor', label: 'To', type: 'color', default: '#0055ff' },
      { key: 'hueTolerance', label: 'Hue Tolerance', type: 'number', unit: '%', min: 0, max: 100, default: 12 },
      { key: 'satTolerance', label: 'Saturation Tolerance', type: 'number', unit: '%', min: 0, max: 100, default: 60 },
      { key: 'lightTolerance', label: 'Lightness Tolerance', type: 'number', unit: '%', min: 0, max: 100, default: 60 },
      { key: 'softness', label: 'Softness', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      // Off, this flattens the shading to the destination's own lightness.
      { key: 'preserveLightness', label: 'Preserve Lightness', type: 'checkbox', default: true },
    ],
    css: () => '',
  },
  {
    type: 'leave-color',
    label: 'Leave Color',
    params: [
      { key: 'targetColor', label: 'Color To Leave', type: 'color', default: '#ff0000' },
      { key: 'tolerance', label: 'Tolerance', type: 'number', unit: '%', min: 0, max: 100, default: 15 },
      { key: 'softness', label: 'Softness', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'amount', label: 'Amount To Decolor', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
    ],
    css: () => '',
  },
  {
    type: 'toner',
    label: 'Toner',
    params: [
      { key: 'blackTone', label: 'Black', type: 'color', default: '#000000' },
      { key: 'shadowTone', label: 'Shadows', type: 'color', default: '#2a2a45' },
      { key: 'midTone', label: 'Midtones', type: 'color', default: '#8a7a63' },
      { key: 'highlightTone', label: 'Highlights', type: 'color', default: '#e8d9b8' },
      { key: 'whiteTone', label: 'White', type: 'color', default: '#ffffff' },
      { key: 'blend', label: 'Blend With Original', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
    ],
    css: () => '',
  },

  // ── Keying & Matte ────────────────────────────────────────────────
  {
    type: 'color-key',
    label: 'Color Key',
    params: [
      { key: 'keyColor', label: 'Key Color', type: 'color', default: '#00ff00' },
      { key: 'tolerance', label: 'Color Tolerance', type: 'number', unit: '%', min: 0, max: 100, default: 15 },
      { key: 'edgeSoftness', label: 'Edge Feather', type: 'number', unit: '%', min: 0, max: 100, default: 5 },
    ],
    css: () => '',
  },
  {
    type: 'color-range',
    label: 'Color Range',
    params: [
      { key: 'keyColor', label: 'Key Color', type: 'color', default: '#00ff00' },
      // 0 Lab · 1 YUV · 2 RGB. The space choice IS the effect — see the kernel.
      { key: 'colorSpace', label: 'Color Space', type: 'number', min: 0, max: 2, precision: 0, default: 0 },
      { key: 'minTolerance', label: 'Min', type: 'number', unit: '%', min: 0, max: 100, default: 10 },
      { key: 'maxTolerance', label: 'Max', type: 'number', unit: '%', min: 0, max: 100, default: 30 },
      // Low by default: chroma separates a lit cyclorama, luminance does not.
      { key: 'lumaWeight', label: 'Luma Weight', type: 'number', unit: '%', min: 0, max: 100, default: 20 },
    ],
    css: () => '',
  },
  {
    type: 'extract',
    label: 'Extract',
    params: [
      // 0 luminance · 1 red · 2 green · 3 blue · 4 alpha.
      { key: 'extractChannel', label: 'Channel', type: 'number', min: 0, max: 4, precision: 0, default: 0 },
      { key: 'blackPoint', label: 'Black Point', type: 'number', min: 0, max: 255, default: 0 },
      { key: 'whitePoint', label: 'White Point', type: 'number', min: 0, max: 255, default: 255 },
      { key: 'blackSoftness', label: 'Black Softness', type: 'number', min: 0, max: 255, default: 10 },
      { key: 'whiteSoftness', label: 'White Softness', type: 'number', min: 0, max: 255, default: 10 },
      { key: 'invertExtract', label: 'Invert', type: 'checkbox', default: false },
    ],
    css: () => '',
  },
  {
    type: 'spill-suppressor',
    label: 'Spill Suppressor',
    params: [
      { key: 'keyColor', label: 'Color To Suppress', type: 'color', default: '#00ff00' },
      { key: 'amount', label: 'Suppression', type: 'number', unit: '%', min: 0, max: 100, default: 60 },
      // Without this the despilled edge reads as a dark outline.
      { key: 'preserveLuma', label: 'Preserve Luminosity', type: 'checkbox', default: true },
    ],
    css: () => '',
  },
  {
    type: 'matte-choker',
    label: 'Matte Choker',
    params: [
      { key: 'spread', label: 'Geometric Softness 1', type: 'number', unit: 'px', min: 0, max: 50, precision: 0, default: 4 },
      { key: 'choke', label: 'Choke', type: 'number', unit: 'px', min: 0, max: 50, precision: 0, default: 4 },
      { key: 'softness', label: 'Gray Level Softness', type: 'number', unit: 'px', min: 0, max: 50, precision: 0, default: 2 },
      { key: 'iterations', label: 'Iterations', type: 'number', min: 1, max: 5, precision: 0, default: 1 },
    ],
    css: () => '',
  },

  // ── Channel ───────────────────────────────────────────────────────
  {
    type: 'alpha-levels',
    label: 'Alpha Levels',
    params: [
      { key: 'inBlack', label: 'Input Black', type: 'number', min: 0, max: 255, default: 0 },
      { key: 'inWhite', label: 'Input White', type: 'number', min: 0, max: 255, default: 255 },
      // The control that fattens a soft edge WITHOUT hardening it.
      { key: 'gamma', label: 'Gamma', type: 'number', min: 0.1, max: 10, precision: 2, default: 1 },
      { key: 'outBlack', label: 'Output Black', type: 'number', min: 0, max: 255, default: 0 },
      { key: 'outWhite', label: 'Output White', type: 'number', min: 0, max: 255, default: 255 },
    ],
    css: () => '',
  },
  {
    type: 'solid-composite',
    label: 'Solid Composite',
    params: [
      { key: 'solidColor', label: 'Color', type: 'color', default: '#000000' },
      // Fades the LAYER toward the solid — the solid sits under it.
      { key: 'sourceOpacity', label: 'Source Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'solidOpacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'compositeMode', label: 'Blending Mode', type: 'number', min: 0, max: 3, precision: 0, default: 0 },
    ],
    css: () => '',
  },
  {
    type: 'channel-combiner',
    label: 'Channel Combiner',
    params: [
      // 0 RGB→HSL · 1 HSL→RGB · 2 RGB→YUV · 3 YUV→RGB · 4 Lightness→Alpha ·
      // 5 Alpha→Luminance · 6 Max RGB · 7 Min RGB. The round-trip pairs are the
      // point: convert, grade the channel with Curves, convert back.
      { key: 'combinerMode', label: 'From', type: 'number', min: 0, max: 7, precision: 0, default: 0 },
    ],
    css: () => '',
  },
  {
    type: 'remove-color-matting',
    label: 'Remove Color Matting',
    params: [
      { key: 'backgroundColor', label: 'Background Color', type: 'color', default: '#000000' },
      // Low alpha amplifies the unmultiply's error — this is the floor below
      // which pixels are left alone. See the kernel.
      { key: 'threshold', label: 'Coverage Floor', type: 'number', unit: '%', min: 0, max: 100, default: 2 },
      { key: 'amount', label: 'Amount', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
    ],
    css: () => '',
  },

  // ── Transition ────────────────────────────────────────────────────
  {
    type: 'iris-wipe',
    label: 'Iris Wipe',
    params: [
      { key: 'completion', label: 'Transition Completion', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'centerX', label: 'Center X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'centerY', label: 'Center Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      // < 3 = circular.
      { key: 'irisPoints', label: 'Points', type: 'number', min: 0, max: 32, precision: 0, default: 0 },
      { key: 'rotation', label: 'Rotation', type: 'number', unit: '°', min: -360, max: 360, default: 0 },
      { key: 'innerRadius', label: 'Inner Radius', type: 'number', unit: 'px', min: 0, max: 4000, default: 0 },
      { key: 'useInnerRadius', label: 'Use Inner Radius', type: 'checkbox', default: false },
      { key: 'feather', label: 'Feather', type: 'number', unit: 'px', min: 0, max: 500, default: 2 },
      { key: 'invertIris', label: 'Invert', type: 'checkbox', default: false },
    ],
    css: () => '',
  },
  {
    type: 'light-wipe',
    label: 'Light Wipe',
    params: [
      { key: 'completion', label: 'Transition Completion', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'wipeShape', label: 'Shape', type: 'number', min: 0, max: 1, precision: 0, default: 0 },
      { key: 'angle', label: 'Direction', type: 'number', unit: '°', min: -180, max: 180, default: 90 },
      { key: 'centerX', label: 'Center X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'centerY', label: 'Center Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'lightWidth', label: 'Width', type: 'number', unit: 'px', min: 0, max: 2000, default: 60 },
      { key: 'lightColor', label: 'Color', type: 'color', default: '#ffffff' },
      { key: 'intensity', label: 'Intensity', type: 'number', unit: '%', min: 0, max: 100, default: 80 },
      { key: 'feather', label: 'Feather', type: 'number', unit: 'px', min: 0, max: 500, default: 2 },
    ],
    css: () => '',
  },
  {
    type: 'line-sweep',
    label: 'Line Sweep',
    params: [
      { key: 'completion', label: 'Transition Completion', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'lineCount', label: 'Lines', type: 'number', min: 1, max: 512, precision: 0, default: 24 },
      { key: 'angle', label: 'Direction', type: 'number', unit: '°', min: -180, max: 180, default: 0 },
      // 0 = every line clears together (a plain wipe); 100 = fully sequential.
      { key: 'stagger', label: 'Stagger', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'feather', label: 'Feather', type: 'number', unit: '%', min: 0, max: 100, default: 2 },
      { key: 'invertSweep', label: 'Invert', type: 'checkbox', default: false },
    ],
    css: () => '',
  },
  {
    type: 'grid-wipe',
    label: 'Grid Wipe',
    params: [
      { key: 'completion', label: 'Transition Completion', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'columns', label: 'Columns', type: 'number', min: 1, max: 256, precision: 0, default: 12 },
      { key: 'rows', label: 'Rows', type: 'number', min: 1, max: 256, precision: 0, default: 8 },
      // 0 rectangle · 1 diamond · 2 circle.
      { key: 'tileShape', label: 'Shape', type: 'number', min: 0, max: 2, precision: 0, default: 0 },
      { key: 'randomSeed', label: 'Randomness', type: 'number', unit: '%', min: 0, max: 100, default: 40 },
      { key: 'feather', label: 'Feather', type: 'number', unit: '%', min: 0, max: 100, default: 5 },
      { key: 'invertGrid', label: 'Invert', type: 'checkbox', default: false },
    ],
    css: () => '',
  },

  // ── Noise & Grain ─────────────────────────────────────────────────
  {
    type: 'dust-scratches',
    label: 'Dust & Scratches',
    params: [
      { key: 'radius', label: 'Radius', type: 'number', unit: 'px', min: 1, max: 8, precision: 0, default: 2 },
      // 0 degrades to a plain Median. Raising it is what preserves texture.
      { key: 'threshold', label: 'Threshold', type: 'number', min: 0, max: 255, default: 20 },
    ],
    css: () => '',
  },
  {
    type: 'noise-alpha',
    label: 'Noise Alpha',
    params: [
      { key: 'amount', label: 'Amount', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'uniformNoise', label: 'Uniform Noise', type: 'checkbox', default: true },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 100000, precision: 0, default: 1 },
      // Keyframe to boil the grain; leave static for a fixed texture.
      { key: 'noisePhase', label: 'Noise Phase', type: 'number', min: 0, max: 100000, precision: 0, default: 0 },
      { key: 'clipResult', label: 'Clip Result', type: 'checkbox', default: true },
    ],
    css: () => '',
  },

  // ── Round five · Generate ─────────────────────────────────────────
  {
    /*
      CC Star Burst — a starfield flown through. Stars are a deterministic
      hash of (seed, index); `phase` is the flight, so motion is a KEYFRAME on
      phase, exactly how Evolution works everywhere else. Scrub-stable.
    */
    type: 'star-burst',
    label: 'Star Burst',
    params: [
      { key: 'phase', label: 'Phase', type: 'number', min: 0, max: 36000, default: 0 },
      { key: 'amount', label: 'Amount', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'size', label: 'Size', type: 'number', unit: 'px', min: 0.5, max: 12, precision: 1, default: 2 },
      { key: 'starColor', label: 'Star Color', type: 'color', default: '#ffffff' },
      { key: 'blend', label: 'Blend With Original', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 100000, precision: 0, default: 1 },
    ],
    css: () => '',
  },
  {
    /*
      CC Snowfall. Flakes fall by `evolution` (keyframe it for motion), drift
      by `wind`. Deterministic per (seed, flake index) — same frame, same snow.
    */
    type: 'snowfall',
    label: 'Snowfall',
    params: [
      { key: 'amount', label: 'Amount', type: 'number', unit: '%', min: 0, max: 100, default: 40 },
      { key: 'size', label: 'Size', type: 'number', unit: 'px', min: 0.5, max: 12, precision: 1, default: 3 },
      { key: 'evolution', label: 'Evolution', type: 'number', min: 0, max: 36000, default: 0 },
      { key: 'wind', label: 'Wind', type: 'number', unit: '%', min: -100, max: 100, default: 10 },
      { key: 'opacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 85 },
      { key: 'flakeColor', label: 'Flake Color', type: 'color', default: '#ffffff' },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 100000, precision: 0, default: 1 },
    ],
    css: () => '',
  },
  {
    /* CC Rainfall — streaks at `angle`, advanced by `evolution`. */
    type: 'rainfall',
    label: 'Rainfall',
    params: [
      { key: 'amount', label: 'Amount', type: 'number', unit: '%', min: 0, max: 100, default: 40 },
      { key: 'length', label: 'Length', type: 'number', unit: 'px', min: 2, max: 200, default: 30 },
      { key: 'angle', label: 'Angle', type: 'number', unit: '°', min: -60, max: 60, default: 10 },
      { key: 'evolution', label: 'Evolution', type: 'number', min: 0, max: 36000, default: 0 },
      { key: 'opacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 55 },
      { key: 'rainColor', label: 'Rain Color', type: 'color', default: '#cfe6ff' },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 100000, precision: 0, default: 1 },
    ],
    css: () => '',
  },
  {
    /*
      Write-on — a stroke drawn progressively from Start toward End; keyframe
      `completion` for the reveal. Wobble bends the path deterministically so
      the line reads hand-drawn rather than ruled.
    */
    type: 'write-on',
    label: 'Write-on',
    params: [
      { key: 'startX', label: 'Start X', type: 'number', unit: 'px', min: -4000, max: 4000, default: -120 },
      { key: 'startY', label: 'Start Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'endX', label: 'End X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 120 },
      { key: 'endY', label: 'End Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'completion', label: 'Completion', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'brushSize', label: 'Brush Size', type: 'number', unit: 'px', min: 1, max: 100, default: 8 },
      { key: 'brushColor', label: 'Color', type: 'color', default: '#ffffff' },
      { key: 'wobble', label: 'Wobble', type: 'number', unit: '%', min: 0, max: 100, default: 25 },
      { key: 'taper', label: 'Taper', type: 'number', unit: '%', min: 0, max: 100, default: 40 },
    ],
    css: () => '',
  },
  {
    /*
      CC Light Burst 2.5 — radial zoom rays: the picture streaked outward from
      a centre and screened back over itself. Intensity multiplies the streaks,
      not the source, so 0 is exactly the untouched layer.
    */
    type: 'light-burst',
    label: 'Light Burst',
    params: [
      { key: 'centerX', label: 'Center X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'centerY', label: 'Center Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'intensity', label: 'Intensity', type: 'number', unit: '%', min: 0, max: 300, default: 100 },
      { key: 'rayLength', label: 'Ray Length', type: 'number', unit: '%', min: 0, max: 100, default: 30 },
    ],
    css: () => '',
  },

  // ── Round five · Stylize ──────────────────────────────────────────
  {
    /*
      CC Glass — the layer's own luminance as a bump map: refract, then a
      light. `height` may be negative (bumps become dents), which is half the
      use of the effect in the wild.
    */
    type: 'glass',
    label: 'Glass',
    params: [
      { key: 'bumpSoftness', label: 'Softness', type: 'number', unit: 'px', min: 0, max: 20, default: 4 },
      { key: 'height', label: 'Height', type: 'number', min: -100, max: 100, default: 30 },
      { key: 'displacement', label: 'Displacement', type: 'number', unit: 'px', min: 0, max: 100, default: 12 },
      { key: 'lightAngle', label: 'Light Angle', type: 'number', unit: '°', min: -360, max: 360, default: 135 },
      { key: 'lightIntensity', label: 'Light Intensity', type: 'number', unit: '%', min: 0, max: 200, default: 60 },
      { key: 'shininess', label: 'Shininess', type: 'number', unit: '%', min: 0, max: 100, default: 40 },
    ],
    css: () => '',
  },
  {
    /* AE Texturize — emboss the layer with a procedural texture. */
    type: 'texturize',
    label: 'Texturize',
    params: [
      // 0 Noise · 1 Canvas · 2 Weave · 3 Brick.
      { key: 'pattern', label: 'Texture', type: 'number', min: 0, max: 3, precision: 0, default: 1 },
      { key: 'contrast', label: 'Texture Contrast', type: 'number', unit: '%', min: 0, max: 200, default: 80 },
      { key: 'scale', label: 'Texture Scale', type: 'number', unit: '%', min: 10, max: 400, default: 100 },
      { key: 'lightAngle', label: 'Light Direction', type: 'number', unit: '°', min: -360, max: 360, default: 135 },
    ],
    css: () => '',
  },
  {
    /* CC Threads — the layer rewoven as an over-under fabric of strips. */
    type: 'threads',
    label: 'Threads',
    params: [
      { key: 'thickness', label: 'Thickness', type: 'number', unit: 'px', min: 2, max: 64, precision: 0, default: 10 },
      { key: 'spacing', label: 'Spacing', type: 'number', unit: 'px', min: 0, max: 32, precision: 0, default: 2 },
      { key: 'depth', label: 'Shadow Depth', type: 'number', unit: '%', min: 0, max: 100, default: 45 },
    ],
    css: () => '',
  },
  {
    /*
      Chromatic Aberration — per-channel displacement. Radial mode scales red
      out and blue in from the centre (a lens); linear mode shifts along an
      angle (the music-video split). Falloff protects the centre in radial mode.
    */
    type: 'chromatic-aberration',
    label: 'Chromatic Aberration',
    params: [
      { key: 'amount', label: 'Amount', type: 'number', unit: 'px', min: 0, max: 60, precision: 1, default: 6 },
      // 0 radial (lens) · 1 linear (split along Angle).
      { key: 'aberrationMode', label: 'Mode', type: 'number', min: 0, max: 1, precision: 0, default: 0 },
      { key: 'angle', label: 'Angle', type: 'number', unit: '°', min: -360, max: 360, default: 0 },
      { key: 'falloff', label: 'Center Protection', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'centerX', label: 'Center X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'centerY', label: 'Center Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
    ],
    css: () => '',
  },
  {
    /* CC HexTile — hexagonal mosaic; border darkens the seams into a comb. */
    type: 'hex-tile',
    label: 'Hex Tile',
    params: [
      { key: 'radius', label: 'Radius', type: 'number', unit: 'px', min: 2, max: 200, default: 24 },
      { key: 'border', label: 'Border', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
    ],
    css: () => '',
  },

  // ── Round five · Blur ─────────────────────────────────────────────
  {
    /*
      CC Vector Blur — blur ALONG the luminance flow: each pixel smears down
      the isophote (perpendicular to the gradient), which is what turns noise
      into hair/water streaks. Smoothness steadies the field first so the
      streaks follow form, not grain.
    */
    type: 'vector-blur',
    label: 'Vector Blur',
    params: [
      { key: 'amount', label: 'Amount', type: 'number', unit: 'px', min: 0, max: 60, default: 12 },
      { key: 'angleOffset', label: 'Angle Offset', type: 'number', unit: '°', min: -360, max: 360, default: 0 },
      { key: 'smoothness', label: 'Ridge Smoothness', type: 'number', unit: 'px', min: 0, max: 12, default: 2 },
    ],
    css: () => '',
  },

  // ── Round five · Distort ──────────────────────────────────────────
  {
    /*
      CC Flo Motion — two knots that suck the picture in (negative) or shove
      it out (positive). The classic infinite-zoom/backdrop-warp tool.
    */
    type: 'flo-motion',
    label: 'Flo Motion',
    params: [
      { key: 'knot1X', label: 'Knot 1 X', type: 'number', unit: 'px', min: -4000, max: 4000, default: -100 },
      { key: 'knot1Y', label: 'Knot 1 Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'knot1Amount', label: 'Knot 1 Amount', type: 'number', unit: '%', min: -100, max: 100, default: 30 },
      { key: 'knot2X', label: 'Knot 2 X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 100 },
      { key: 'knot2Y', label: 'Knot 2 Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'knot2Amount', label: 'Knot 2 Amount', type: 'number', unit: '%', min: -100, max: 100, default: 30 },
      { key: 'falloff', label: 'Falloff', type: 'number', unit: '%', min: 1, max: 100, default: 40 },
    ],
    css: () => '',
  },
  {
    /*
      CC Lens — the layer wrapped into a fisheye ball. Convergence 0 is flat;
      100 closes the picture into a sphere with transparency outside it, which
      is what separates it from Spherize (a bulge inside the frame).
    */
    type: 'lens',
    label: 'Lens',
    params: [
      { key: 'centerX', label: 'Center X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'centerY', label: 'Center Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'size', label: 'Size', type: 'number', unit: '%', min: 5, max: 200, default: 80 },
      { key: 'convergence', label: 'Convergence', type: 'number', unit: '%', min: 0, max: 100, default: 60 },
    ],
    css: () => '',
  },
  {
    /* CC Griddler — the layer cut into a grid, every tile scaled/rotated. */
    type: 'griddler',
    label: 'Griddler',
    params: [
      { key: 'tileSize', label: 'Tile Size', type: 'number', unit: 'px', min: 4, max: 400, default: 60 },
      { key: 'horizontalScale', label: 'Horizontal Scale', type: 'number', unit: '%', min: 1, max: 200, default: 90 },
      { key: 'verticalScale', label: 'Vertical Scale', type: 'number', unit: '%', min: 1, max: 200, default: 90 },
      { key: 'rotation', label: 'Tile Rotation', type: 'number', unit: '°', min: -180, max: 180, default: 10 },
    ],
    css: () => '',
  },
  {
    /*
      CC Ball Action — the layer sampled into a grid of shaded balls. Scatter
      jitters each ball off its cell deterministically by (seed, cell).
    */
    type: 'ball-action',
    label: 'Ball Action',
    params: [
      { key: 'grid', label: 'Grid Spacing', type: 'number', unit: 'px', min: 4, max: 200, default: 24 },
      { key: 'ballSize', label: 'Ball Size', type: 'number', unit: '%', min: 10, max: 100, default: 90 },
      { key: 'scatter', label: 'Scatter', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 100000, precision: 0, default: 1 },
    ],
    css: () => '',
  },
  {
    /*
      CC Drizzle — raindrop rings rippling the picture. Each drop is a hash of
      (seed, index); `evolution` advances its ring outward and fades it, so the
      rain animates by keyframing evolution alone.
    */
    type: 'drizzle',
    label: 'Drizzle',
    params: [
      { key: 'dripRate', label: 'Drip Rate', type: 'number', unit: '%', min: 0, max: 100, default: 40 },
      { key: 'rippleHeight', label: 'Ripple Height', type: 'number', unit: 'px', min: 0, max: 60, default: 10 },
      { key: 'spreading', label: 'Spreading', type: 'number', unit: 'px', min: 8, max: 400, default: 120 },
      { key: 'evolution', label: 'Evolution', type: 'number', min: 0, max: 36000, default: 0 },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 100000, precision: 0, default: 1 },
    ],
    css: () => '',
  },

  // ── Round five · Transition ───────────────────────────────────────
  {
    /* CC Jaws — the frame bitten in two along a toothed seam. */
    type: 'jaws',
    label: 'Jaws',
    params: [
      { key: 'completion', label: 'Completion', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'direction', label: 'Direction', type: 'number', unit: '°', min: -360, max: 360, default: 0 },
      { key: 'teethHeight', label: 'Tooth Height', type: 'number', unit: 'px', min: 1, max: 200, default: 40 },
      { key: 'teethWidth', label: 'Tooth Width', type: 'number', unit: 'px', min: 2, max: 200, default: 40 },
    ],
    css: () => '',
  },
  {
    /*
      CC Pixel Polly — the frame shattered into cells that fly and spin away.
      Completion drives distance, tumble and fade together, so two keyframes on
      it are the whole transition.
    */
    type: 'pixel-polly',
    label: 'Pixel Polly',
    params: [
      { key: 'completion', label: 'Completion', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'cellSize', label: 'Cell Size', type: 'number', unit: 'px', min: 4, max: 200, default: 30 },
      { key: 'gravity', label: 'Gravity', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'spin', label: 'Spin', type: 'number', unit: '°', min: 0, max: 720, default: 180 },
      { key: 'centerX', label: 'Force Center X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'centerY', label: 'Force Center Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 100000, precision: 0, default: 1 },
    ],
    css: () => '',
  },
  {
    /* CC Twister — rows fold and wring out around a horizontal axis. */
    type: 'twister',
    label: 'Twister',
    params: [
      { key: 'completion', label: 'Completion', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'centerY', label: 'Axis Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'twist', label: 'Twist', type: 'number', unit: '°', min: 0, max: 360, default: 120 },
    ],
    css: () => '',
  },
  {
    /*
      Card Dance — the frame cut into cards, each displaced/rotated by its own
      LUMINANCE (the layer stands in for AE's gradient layer) and a travelling
      wave in `phase`. Amount 0 is exactly the untouched picture.
    */
    type: 'card-dance',
    label: 'Card Dance',
    params: [
      { key: 'rows', label: 'Rows', type: 'number', min: 1, max: 64, precision: 0, default: 10 },
      { key: 'columns', label: 'Columns', type: 'number', min: 1, max: 64, precision: 0, default: 16 },
      { key: 'amount', label: 'Amount', type: 'number', unit: '%', min: 0, max: 100, default: 30 },
      { key: 'cardRotation', label: 'Rotation', type: 'number', unit: '°', min: -180, max: 180, default: 20 },
      { key: 'phase', label: 'Phase', type: 'number', min: 0, max: 36000, default: 0 },
    ],
    css: () => '',
  },
  // ── Round six: iconic AE & CC effects ──
  {
    type: 'unmult',
    label: 'Unmult',
    params: [
      { key: 'threshold', label: 'Threshold', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'boost', label: 'Boost', type: 'number', unit: '%', min: 50, max: 200, default: 100 },
    ],
    css: () => '',
  },
  {
    type: 'cc-composite',
    label: 'CC Composite',
    params: [
      { key: 'opacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      {
        key: 'blendMode',
        label: 'Composite Original',
        type: 'enum',
        default: 0,
        options: [
          { value: 0, label: 'In Front' },
          { value: 1, label: 'Behind' },
          { value: 2, label: 'Add' },
          { value: 3, label: 'Multiply' },
          { value: 4, label: 'Screen' },
          { value: 5, label: 'Overlay' },
          { value: 6, label: 'Hard Light' },
          { value: 7, label: 'Soft Light' },
          { value: 8, label: 'Difference' },
          { value: 9, label: 'Stencil Alpha' },
          { value: 10, label: 'Silhouette Alpha' },
        ],
      },
      { key: 'rgbOnly', label: 'RGB Only', type: 'checkbox', default: false },
    ],
    css: () => '',
  },
  {
    type: 'cc-repetile',
    label: 'CC RepeTile',
    params: [
      { key: 'expandLeft', label: 'Expand Left', type: 'number', unit: 'px', min: 0, max: 2000, default: 0 },
      { key: 'expandRight', label: 'Expand Right', type: 'number', unit: 'px', min: 0, max: 2000, default: 0 },
      { key: 'expandUp', label: 'Expand Up', type: 'number', unit: 'px', min: 0, max: 2000, default: 0 },
      { key: 'expandDown', label: 'Expand Down', type: 'number', unit: 'px', min: 0, max: 2000, default: 0 },
      {
        key: 'tiling',
        label: 'Tiling',
        type: 'enum',
        default: 0,
        options: [
          { value: 0, label: 'Unfold' },
          { value: 1, label: 'Repeat' },
          { value: 2, label: 'Flip H' },
          { value: 3, label: 'Flip V' },
        ],
      },
    ],
    css: () => '',
  },
  {
    type: 'cc-scatterize',
    label: 'CC Scatterize',
    params: [
      { key: 'amount', label: 'Scatter Amount', type: 'number', min: 0, max: 1000, default: 0 },
      { key: 'windX', label: 'Right Wind', type: 'number', min: -100, max: 100, default: 0 },
      { key: 'windY', label: 'Down Wind', type: 'number', min: -100, max: 100, default: 0 },
      { key: 'twist', label: 'Twist', type: 'number', unit: '°', min: 0, max: 360, default: 0 },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 1, max: 10000, default: 1 },
    ],
    css: () => '',
  },
  {
    type: 'radial-fast-blur',
    label: 'CC Radial Fast Blur',
    params: [
      { key: 'amount', label: 'Amount', type: 'number', unit: '%', min: 0, max: 100, default: 20 },
      { key: 'centerX', label: 'Center X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'centerY', label: 'Center Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      {
        key: 'zoomMode',
        label: 'Zoom Mode',
        type: 'enum',
        default: 0,
        options: [
          { value: 0, label: 'Standard' },
          { value: 1, label: 'Brightest' },
          { value: 2, label: 'Darkest' },
        ],
      },
    ],
    css: () => '',
  },
  {
    type: 'cross-blur',
    label: 'CC Cross Blur',
    params: [
      { key: 'radiusX', label: 'Radius X', type: 'number', unit: 'px', min: 0, max: 200, default: 15 },
      { key: 'radiusY', label: 'Radius Y', type: 'number', unit: 'px', min: 0, max: 200, default: 15 },
      { key: 'repeatEdges', label: 'Repeat Edge Pixels', type: 'checkbox', default: true },
    ],
    css: () => '',
  },
  {
    type: 'scale-wipe',
    label: 'CC Scale Wipe',
    params: [
      { key: 'completion', label: 'Completion', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'stretch', label: 'Stretch', type: 'number', min: 1, max: 50, default: 10 },
      { key: 'direction', label: 'Direction', type: 'number', unit: '°', min: 0, max: 360, default: 0 },
      { key: 'centerX', label: 'Center X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'centerY', label: 'Center Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
    ],
    css: () => '',
  },
  {
    type: 'plastic',
    label: 'CC Plastic',
    params: [
      { key: 'surfaceBump', label: 'Surface Bump', type: 'number', unit: '%', min: 0, max: 100, default: 25 },
      { key: 'softness', label: 'Softness', type: 'number', unit: 'px', min: 0, max: 50, default: 5 },
      { key: 'lightAngle', label: 'Light Angle', type: 'number', unit: '°', min: 0, max: 360, default: 45 },
      { key: 'lightIntensity', label: 'Light Intensity', type: 'number', unit: '%', min: 0, max: 200, default: 100 },
      { key: 'specular', label: 'Specular', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
    ],
    css: () => '',
  },
];

const BUILTIN_DEF = new Map(EFFECT_DEFS.map((d) => [d.type, d]));

/**
 * One effect's definition, built-in or from a plugin.
 *
 * ★ Every reader goes through here rather than through the map.
 *
 * The map is built at module load from a fixed array, which is correct for
 * built-ins and cannot describe a plugin's effect — that set is whatever is
 * installed and changes while the app runs. A reader that consulted only the
 * map would return `undefined` for a plugin effect, and every call site treats
 * `undefined` as "unknown effect": no parameters, no CSS, no label, silently
 * skipped. A document with a plugin effect on a layer would open with the
 * effect present in the data and absent from every surface.
 *
 * Resolved lazily rather than by adding plugin effects to `EFFECT_DEFS`,
 * because that array is a module-level constant several things capture at load.
 */
export function effectDefFor(type: EffectType | string): EffectDef | undefined {
  return BUILTIN_DEF.get(type as EffectType)
    // Only consulted on a miss, so the common path is one map lookup.
    ?? (typeof type === 'string' && type.includes('.') ? pluginEffectDef(type) : undefined);
}

/**
 * Kept for the call sites below, which now all read through `effectDefFor`.
 * Shaped as a `get` so the diff is a rename rather than a rewrite of each.
 */
const DEF = {
  get: (type: EffectType | string) => effectDefFor(type),
  has: (type: EffectType | string) => effectDefFor(type) !== undefined,
};

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

/** Replace a layer's effect stack (bumps the scene revision + notifies). */
export function writeNodeEffects(nodeId: string, effects: Effect[]): void {
  // The `fx` component is a computed view over the engine node; store the stack
  // on the engine (surfaced back as `readNodeEffects`' fx component).
  defaultSceneGraph.setEffects(nodeId, effects);
  // Effects change the rendered frame → same signal as an animation edit
  // (invalidates the cache, marks dirty, records history, re-renders viewport).
  getEventBus().emit('AnimationChanged', { nodeId });
  // ...and the scene REVISION, which is what wakes the views that rebuild by
  // reading the scene during render. `AnimationChanged` reaches the viewport,
  // the autosave and history — but nothing that draws the timeline, which lists
  // one row per numeric effect parameter (`propertyTree.effectRows`) and reads
  // each one's value at render time. Without this an effect scrub moved the
  // picture while its own timeline row sat at the number it last drew: the same
  // defect, and the same remedy, as the transform props in `InspectorAPI`.
  //
  // Revision only — an effect edit is not a structural scene change, and
  // announcing one would split a single scrub into two undo steps (the
  // AnimationChanged above already schedules this edit under the 'anim' key).
  bumpSceneRevision();
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

/**
 * Restore every parameter of one effect to its declared default — AE's `Reset`
 * link in the Effect Controls header.
 *
 * ONE write, not one per parameter. Looping `updateEffectParam` over a def would
 * emit an `AnimationChanged` per key, and history records per edit — resetting
 * Bevel (nine params) would cost nine undo steps to walk back.
 *
 * Deliberately does NOT touch keyframes. A reset in AE restores the value the
 * property rests at; removing the user's animation as a side effect of a control
 * labelled "Reset" is the kind of surprise that costs work. The stopwatch is
 * still the one thing that deletes tracks.
 */
export function resetEffectParams(nodeId: string, effectId: string): void {
  const effects = getNodeEffects(nodeId);
  const target = effects.find((e) => e.id === effectId);
  const def = target ? DEF.get(target.type) : undefined;
  if (!target || !def) return;
  writeNodeEffects(
    nodeId,
    // `amount` goes too: it is the legacy scalar `paramsOf` folds in ahead of
    // the defaults, so leaving it would make a reset effect keep its old look.
    effects.map((e) =>
      e.id === effectId
        ? { id: e.id, type: e.type, params: defaultParams(def), enabled: e.enabled, maskId: e.maskId, labelColor: e.labelColor }
        : e,
    ),
  );
}

/** Set or clear the Effect Controls label colour on one applied effect. */
export function setEffectLabelColor(
  nodeId: string,
  effectId: string,
  color: string | undefined,
): void {
  writeNodeEffects(
    nodeId,
    getNodeEffects(nodeId).map((e) => {
      if (e.id !== effectId) return e;
      if (color === undefined) {
        const { labelColor: _drop, ...rest } = e;
        return rest;
      }
      return { ...e, labelColor: color };
    }),
  );
}

/**
 * Display names for a stack, AE-style: the second Gaussian Blur on a layer is
 * "Gaussian Blur 2", the third "Gaussian Blur 3".
 *
 * Four identically-labelled rows is not a list, it is a guess — the AE
 * screenshot users compare against reads "CC Smear / CC Smear 2 / CC Smear 3 /
 * CC Smear 4", and stacking two blurs is ordinary practice, not a corner case.
 *
 * Numbering follows STACK ORDER and only starts at the second instance, so the
 * first of a kind keeps its plain name whatever else is on the layer.
 */
export function effectDisplayNames(effects: ReadonlyArray<Effect>): Map<string, string> {
  const seen = new Map<string, number>();
  const out = new Map<string, string>();
  for (const e of effects) {
    const label = DEF.get(e.type)?.label ?? e.type;
    const n = (seen.get(e.type) ?? 0) + 1;
    seen.set(e.type, n);
    out.set(e.id, n === 1 ? label : `${label} ${n}`);
  }
  return out;
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

/**
 * AE Compositing Options → Effect Mask: scope where this effect applies.
 *
 * `maskId` undefined / omitted = whole layer. Empty string is treated as unset
 * so a half-written edit cannot force a CPU bake for nothing (see
 * effectScopedMask.test.ts). The referenced path should usually be mode
 * `'none'` so it is geometry without also cutting the layer.
 */
export function setEffectMaskId(
  nodeId: string,
  effectId: string,
  maskId: string | undefined,
): void {
  const nextId = maskId && maskId.length > 0 ? maskId : undefined;
  writeNodeEffects(
    nodeId,
    getNodeEffects(nodeId).map((e) => {
      if (e.id !== effectId) return e;
      if (nextId === undefined) {
        const { maskId: _drop, ...rest } = e;
        return rest;
      }
      return { ...e, maskId: nextId };
    }),
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
