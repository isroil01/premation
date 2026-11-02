/**
 * Visual effects engine (spec: Focus Mode edits "animation, masks, effects,
 * expressions…"). Each layer carries a stack of effects stored on an `fx`
 * component so History, autosave, and export capture them for free. Effects
 * compile to a CSS `filter` string the Canvas 2D backend applies per layer.
 */

import type { SceneNode } from '@core/types';
import { renderComponentsOf } from '@core/scene/SceneGraph';

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
  | 'image-fill'
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
  | 'reshape'
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
  // AE parity 5.2.
  | 'advanced-spill-suppressor'
  | 'key-cleaner'
  | 'remove-grain'
  | 'matte-choker'
  // AE parity 3.2 — the matte follows the picture's own edges (hair), decontaminated.
  | 'refine-soft-matte'
  | 'refine-hard-matte'
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
  | 'beam-path'
  | 'plexus'
  // Stylize — surface shading and per-cell resamples.
  | 'deep-glow'
  | 'glass'
  | 'texturize'
  // Program F1–F3: the ink set (ink-bleed.wgsl, paper.wgsl, ink-splatter.wgsl).
  | 'ink-bleed'
  | 'paper'
  | 'ink-splatter'
  // fx60:b8:begin
  | 'brightness-contrast'
  | 'color-balance-hls'
  | 'calculations'
  | 'set-channels'
  | 'blend'
  | 'difference-matte'
  | 'color-neutralizer'
  | 'blobbylize'
  | 'cc-split-2'
  | 'eyedropper-fill'
  | 'noise-hls-auto'
  | 'caustics'
  | 'shatter'
  | 'wave-world'
  | 'warpomatic'
  | 'overbrights'
  | 'hdr-compander'
  | 'hdr-highlight-compression'
  | 'reduce-interlace-flicker'
  | 'basic-3d'
  | 'digital-glitch'
  | 'vr-rotate-sphere'
  | 'color-gradients'
  | 'vhs'
  | 'crt'
  | 'pixel-sort'
  | 'long-shadow'
  | 'halation'
  | 'light-leaks'
  | 'tilt-shift'
  | 'gradient-map'
  | 'duotone'
  | 'soft-glow'
  | 'neon'
  | 'hologram'
  | 'dither'
  | 'ascii'
  | 'led-screen'
  | 'pencil-sketch'
  | 'oil-paint'
  | 'camera-shake'
  | 'flicker'
  | 'prism'
  | 'frosted-glass'
  | 'bleach-bypass'
  | 'cross-process'
  | 'split-toning'
  | 'old-film'
  | 'anamorphic-streaks'
  | 'starglow'
  | 'sparkle'
  | 'white-balance'
  | 'clarity'
  | 'lens-distortion'
  | 'heat-haze'
  | 'color-halftone'
  | 'crystallize'
  | 'fog'
  | 'chrome'
  | 'night-vision'
  // fx60:b8:end
  // camera program D1: depth for compositing
  | 'depth-matte'
  | 'depth-fog'
  | 'depth-extract'
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
  | 'plastic'
  // ── Round seven: the AE families still thin after six rounds ──────────
  //
  // Eighteen effects. Fifteen are a shader plus a retained Canvas2D kernel,
  // like every port before them. Three (Color Offset, Threshold RGB, Cineon
  // Converter) are per-channel transfers and so join `LUT_BUILDERS` instead — free on
  // both backends, no bake, no shader. Particle Systems II is the one clock
  // driven member (see `TIME_DEPENDENT`): a point emitter indexes its births
  // by absolute time, and a keyframed phase would leave it static by default.
  //
  // Distort / Transition — inverse-map resamples and completion reveals.
  | 'cc-tiler'
  | 'ripple-pulse'
  | 'radial-scale-wipe'
  | 'glass-wipe'
  | 'image-wipe'
  // Keying / Colour — two keys, a legaliser, HLS grain, and the three LUTs.
  | 'color-difference-key'
  | 'wire-removal'
  | 'broadcast-colors'
  | 'noise-hls'
  | 'color-offset'
  | 'threshold-rgb'
  | 'cineon-converter'
  // Stylize / Perspective / Generate.
  | 'block-load'
  | 'kernel'
  | '3d-glasses'
  | 'fractal'
  // Simulation — an emitter on the clock, and bubbles on a keyframed evolution.
  | 'particle-systems'
  | 'cc-bubbles'
  // ── Stroke-like paint effects (2026-09-15) ──
  //
  // AE Generate paint effects that lay a round brush along MASKS rather than
  // along the layer alpha. `path-stroke` is AE Stroke, labelled Stroke, and the
  // older alpha-outline `stroke` above is relabelled Alpha Stroke with its id
  // unchanged. Both are Canvas2D-only, like Vegas. See `pathStroke.ts` and
  // `scribble.ts`.
  | 'path-stroke'
  // deepfx:union:begin
  | 'lens-bloom'
  | 'shine'
  | 'image-flares'
  | 'painterly'
  | 'watercolor'
  | 'ink-outline'
  | 'detail-upscale'
  | 'paint-bucket'
  | 'light-wrap'
  | 'refraction'
  | 'compound-arithmetic'
  | 'color-link'
  | 'inner-outer-key'
  | 'energy-saber'
  | 'ps-arbitrary-map'
  | 'edge-rays'
  | 'vr-blur'
  | 'vr-chromatic-aberrations'
  | 'vr-converter'
  | 'vr-denoise'
  | 'vr-fractal-noise'
  | 'vr-glow'
  | 'vr-plane-to-sphere'
  | 'vr-sharpen'
  | 'volumetric-lights'
  | 'relight'
  | 'volumetric-clouds'
  | 'starfield'
  | 'cc-environment'
  | 'ocean'
  | 'aurora'
  | 'stroke-3d'
  | 'timewarp'
  | 'pixel-motion-blur'
  | 'time-displacement'
  | 'time-difference'
  | 'time-blend'
  | 'light-trails'
  | 'datamosh'
  | 'temporal-denoise'
  | 'fluid-ink'
  | 'reaction-diffusion'
  | 'crystal-growth'
  | 'mr-mercury'
  | 'foam'
  | 'hair'
  | 'rain-on-glass'
  | 'particle-world'
  | 'warp-stabilizer'
  | 'match-grain'
  | 'color-stabilizer'
  | 'camera-shake-deblur'
  | 'burn-dissolve'
  | 'liquid-morph'
  | 'bend-it'
  | 'bender'
  | 'matte-stroke'
  | 'selective-color-ai'
  | 'object-matte'
  | 'goo'
  // deepfx:union:end
  | 'scribble';

/** Curve control points: `[inputX, outputY]` pairs in 0–255. */
export type CurvePoints = ReadonlyArray<readonly [number, number]>;
/**
 * `readonly number[]` is for params RESOLVED AT SNAPSHOT TIME rather than
 * authored — Audio Spectrum's band magnitudes, which `buildSnapshot` computes
 * from the referenced audio layer and writes here so the drawing kernel stays a
 * pure function of its params. Not something a user types.
 */
/** `readonly (readonly number[])[]`: a native plugin GRADIENT param's stops (`[[position, r, g, b, a], …]`, SDK 1.1). */
export type EffectParamValue = number | string | boolean | CurvePoints | readonly number[] | readonly (readonly number[])[];
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
   * AE Compositing Options -> Effect Opacity, 0..100 percent.
   *
   * Blends this effect's OUTPUT against its INPUT: 100 is the effect as it has
   * always rendered, 0 is a no-op, 50 is half-strength. Keyframeable under
   * `effect.<id>.fx.opacity` (see `EFFECT_OPACITY_KEY`), which is what makes it
   * the one dial that gives ANY effect a time range.
   *
   * Why an instance field rather than a param: 19 effect definitions already
   * declare a param keyed `opacity` (Drop Shadow's, Glow's, Vegas'), and those
   * mean "how opaque is the thing this effect draws". This one means "how much
   * of this effect's result survives", and it exists for every effect in the
   * registry including the ones with no natural zero (Find Edges, Mosaic, a
   * LUT). Two different quantities cannot share a key.
   *
   * ── The absent/100 distinction is load-bearing ──
   * ABSENT means "never touched", and only then is the effect free to render on
   * the GPU's native path. PRESENT — even at exactly 100 — forces the CPU bake
   * (`effectsNeedCpuBake`), because that is the only path that can blend an
   * effect against its input. An ANIMATED opacity therefore keeps the field
   * present at every frame including the ones that sample 100, which is what
   * stops a 0->100->0 ramp from flipping between the GPU and CPU chains
   * mid-animation and popping as the two backends' rounding disagreed.
   *
   * `setEffectOpacity` deletes the field at 100 so an untouched effect adds
   * nothing to the saved file and costs nothing at render time.
   */
  opacity?: number;
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
  /**
   * `'data'` (AE parity 5.5) is a flat numeric array an on-canvas TOOL writes —
   * Mesh Warp's variable mesh offsets, Liquify's painted distortion field. No
   * inspector control (the tool is the editor); stored in the document as a
   * static param (a json value); a `px` unit scales it element-wise with the
   * raster like a `resolved` geometry array.
   */
  /**
   * `'maskPath'` is a reference to one of THIS layer's mask paths (stored as
   * the path id, '' = none) — the spine a path-following effect draws along.
   * Rendered as a dropdown of the layer's masks; the render pipeline resolves
   * the referenced path into the companion `resolved` polyline param at
   * snapshot time (buildSnapshot), the same hand-off Audio Spectrum uses, so
   * the drawing kernels stay pure functions of their params — and a TRACKED
   * mask (maskAnim) re-resolves per frame, which is what makes an effect
   * follow a tracked object for free.
   */
  /**
   * `'file'` holds a project item (its id, '' = none chosen): a picker over the
   * project's items of `fileTypes`. Static, as a plugin's FILE param is.
   */
  type: 'number' | 'color' | 'checkbox' | 'curve' | 'layer' | 'resolved' | 'enum' | 'maskPath' | 'data' | 'file';
  /** A `'file'` param: the extensions its picker offers, '|'-separated. */
  fileTypes?: string;
  /** The choices for an `'enum'` param, in menu order. Ignored for other types. */
  options?: ReadonlyArray<{ value: number; label: string }>;
  /**
   * What a `'maskPath'` picker calls its empty choice. Absent = "None". The
   * paint effects (Stroke, Scribble) read an empty pick as the FIRST mask, as
   * AE's Path menu does, and a control saying "None" would describe the
   * opposite of what renders.
   */
  noneLabel?: string;
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
  /**
   * Values a NEWLY ADDED instance starts with, over the declared `default`s.
   *
   * `default` answers two questions that usually agree: what a fresh effect
   * starts at, and what a STORED effect reads for a key it does not carry. When
   * an effect gains a mode, they stop agreeing — a document saved before the
   * mode existed must read the OLD behaviour, while a fresh instance should
   * start in the new one. `addEffect` stores every param explicitly, so a key
   * set here reaches new instances only and stored documents keep `default`.
   * Write-on (brush form) and Vegas (Bunched) are the users, and the reason no
   * document migration was needed for either.
   */
  newInstanceParams?: EffectParams;
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
    // A `resolved` param declared in px is GEOMETRY the pipeline filled in — a
    // mask path's flattened points, Write-on's dab positions — laid out in the
    // same layer px as a number param and wrong by exactly the raster scale if
    // left alone: a Vegas light on a mask drew at half its distance from the
    // centre on a 2x bake. Such arrays scale element-wise; resolved params that
    // are counts or flags simply do not declare a unit.
    const lengths = def.params.filter((p) => (p.type === 'number' || p.type === 'resolved' || p.type === 'data') && p.unit === 'px');
    if (lengths.length === 0) return e;
    // Resolve through paramsOf first: it folds in declared defaults and the
    // legacy `amount`, so a param the caller never set still scales.
    const params: Record<string, EffectParamValue> = { ...paramsOf(e) };
    for (const p of lengths) {
      const v = params[p.key];
      if (typeof v === 'number') params[p.key] = v * k;
      else if ((p.type === 'resolved' || p.type === 'data') && Array.isArray(v)) {
        params[p.key] = (v as readonly unknown[]).map((x) => (typeof x === 'number' ? x * k : x)) as number[];
      }
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
  /*
    CC Particle Systems II (round seven). Same test, passed the same way: a
    point emitter's picture differs every frame BECAUSE particles are born and
    die on the clock, and the alive set is indexed by absolute time
    (`floor(time·birthRate)`). CC Bubbles, added beside it, deliberately took
    the snowfall route — a keyframed `evolution` — because a wrapping field
    needs no absolute origin. An emitter does.
  */
  ['particle-systems', 'time'],
  // fx60:b10:begin
  ['noise-hls-auto', 'time'],
  ['caustics', 'time'],
  ['shatter', 'time'],
  ['wave-world', 'time'],
  ['digital-glitch', 'time'],
  ['vhs', 'time'],
  ['light-leaks', 'time'],
  ['hologram', 'time'],
  ['camera-shake', 'time'],
  ['flicker', 'time'],
  ['old-film', 'time'],
  ['sparkle', 'time'],
  ['heat-haze', 'time'],
  ['fog', 'time'],
  ['night-vision', 'time'],
  // fx60:b10:end
  // deepfx:time:begin
  ['energy-saber', 'time'],
  ['volumetric-clouds', 'time'],
  ['starfield', 'time'],
  ['ocean', 'time'],
  ['aurora', 'time'],
  ['timewarp', 'time'],
  ['datamosh', 'time'],
  ['fluid-ink', 'time'],
  ['reaction-diffusion', 'time'],
  ['crystal-growth', 'time'],
  ['mr-mercury', 'time'],
  ['foam', 'time'],
  ['rain-on-glass', 'time'],
  ['particle-world', 'time'],
  ['match-grain', 'time'],
  // deepfx:time:end
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

/** The params a NEW instance is created with — defaults, then `newInstanceParams`. */
export function newInstanceParamsOf(def: EffectDef): EffectParams {
  return def.newInstanceParams ? { ...defaultParams(def), ...def.newInstanceParams } : defaultParams(def);
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

/**
 * The top of Blur's range, px. The value IS the Gaussian sigma (CSS `blur()`
 * semantics), so 250 reaches ±625px — the same order as Gaussian Blur's 500
 * (whose sigma is r/√3 ≈ 289).
 *
 * It was 40, and that was a slider bound, not an engine limit: a large soft
 * glow built from a blurred shape stopped softening at 40 and kept a visibly
 * hard edge. Nothing downstream clamps — the GPU pass, the effect-margin
 * (`effectSpreadPx`) and the CSS fallback all take the number as given, and
 * Gaussian Blur / Fast Box Blur have always ridden the SAME pass at larger
 * sigmas than this.
 *
 * What the pass does NOT do is get more expensive with radius: it is a fixed
 * 61-tap separable kernel whose taps spread apart past sigma ≈ 12 (spacing =
 * sigma/12 texels, bilinear between them). So cost is flat, and the trade is
 * quality on DETAILED sources — at sigma 250 the taps are ~21 texels apart, and
 * fine texture under them can shimmer in motion. Smooth sources (shapes, glows,
 * gradients — what a radius this large is for) are unaffected. There is no
 * downsampled multi-pass path to fall back on, for this or for the other two
 * blurs, so the bound stops here rather than at AE's 1000+.
 */
export const BLUR_MAX_PX = 250;

/** Refine Soft / Hard Matte's controls (AE parity 3.2; catalog/effects.json is the source). */
function refineMatteParams(edgeRadius: number, smooth: number, contrast: number): EffectParamDef[] {
  return [
    { key: 'edgeRadius', label: 'Edge Radius', type: 'number', unit: 'px', min: 0, max: 100, precision: 0, default: edgeRadius },
    { key: 'smooth', label: 'Smooth', type: 'number', unit: 'px', min: 0, max: 100, precision: 1, default: smooth },
    { key: 'feather', label: 'Feather', type: 'number', unit: 'px', min: 0, max: 100, precision: 1, default: 0 },
    { key: 'contrast', label: 'Contrast', type: 'number', unit: '%', min: 0, max: 100, precision: 0, default: contrast },
    { key: 'shiftEdge', label: 'Shift Edge', type: 'number', unit: '%', min: -100, max: 100, precision: 0, default: 0 },
    { key: 'decontaminateEdges', label: 'Decontaminate Edge Colors', type: 'checkbox', default: true },
    { key: 'decontaminationAmount', label: 'Decontamination Amount', type: 'number', unit: '%', min: 0, max: 100, precision: 0, default: 100 },
  ];
}

/** Displacement Map's channel menu (AE's order; stream D L5): the map channel a
 *  texel is moved by, 0.5 = no move. Full / Half are constants, Off moves nothing. */
const DISPLACEMENT_CHANNELS = ['Red', 'Green', 'Blue', 'Alpha', 'Luminance', 'Hue', 'Lightness', 'Saturation', 'Full', 'Half', 'Off']
  .map((label, value) => ({ value, label }));

export const EFFECT_DEFS: EffectDef[] = [
  scalar('blur', 'Blur', 'px', 0, BLUR_MAX_PX, 6, (a) => `blur(${a}px)`),

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
      { key: 'angle', label: 'Angle', type: 'number', unit: '°', min: -360, max: 360, default: 135 },
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
      // Per-layer shutter phase (AE's is comp-wide): −90 centres the exposure
      // on the frame, 0 trails it, −180 leads it — the streak's direction.
      { key: 'shutterPhase', label: 'Shutter Phase', type: 'number', unit: '°', min: -360, max: 360, default: -90 },
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
      // Camera program D2: linked to a 3D light, the centre follows the light through the active camera and the flare dims when the scene hides it.
      { key: 'linkLight', label: 'Link to Light', type: 'layer', default: '' },
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
      /*
        ── Layout ──────────────────────────────────────────────────────
        The spectrum no longer has to run left-to-right across the layer.

        POLAR is the one that matters: a spectrum wrapped around a circle,
        radiating outward, is the single most-asked-for audio visual in motion
        design — the ring around a logo — and until now it could not be made
        here at all. `usePolarPath` is deliberately independent of `pathMaskId`
        so the circle needs no mask drawn first; with a path assigned as well,
        the path wins and polar reduces to "radiate from the path's centroid".
      */
      { key: 'usePolarPath', label: 'Use Polar Path', type: 'checkbox', default: false },
      { key: 'polarRadius', label: 'Polar Radius', type: 'number', unit: 'px', min: 0, max: 4000, default: 200 },
      { key: 'startAngle', label: 'Start Angle', type: 'number', unit: '°', min: -360, max: 360, default: -90 },
      // The mask path to run along, resolved into `pathPoints` by buildSnapshot
      // — the same hand-off Vegas and Write-on use.
      { key: 'pathMaskId', label: 'Path', type: 'maskPath', default: '' },
      { key: 'pathPoints', label: 'Path (resolved)', type: 'resolved', default: [] },
      // Start / End Point place the line when there is no path (AE's own
      // fallback). Offsets from the layer centre, as every other generate
      // effect here measures — absolute coordinates would default to the
      // top-left and put the spectrum half off its own layer on the first add.
      { key: 'startX', label: 'Start Point X', type: 'number', unit: 'px', min: -4000, max: 4000, default: -400 },
      { key: 'startY', label: 'Start Point Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'endX', label: 'End Point X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 400 },
      { key: 'endY', label: 'End Point Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      /*
        ── Look ────────────────────────────────────────────────────────
        Side Options is AE's A / B / both: which side of the path the bars
        stand on. It subsumes the old `displayMode: 2` (mirrored), which is
        kept working — see the kernel.
      */
      { key: 'side', label: 'Side Options', type: 'enum', default: 2,
        options: [
          { value: 0, label: 'Side A' },
          { value: 1, label: 'Side B' },
          { value: 2, label: 'Both Sides' },
        ] },
      { key: 'softness', label: 'Softness', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      // Rotate the hue across the displayed range. At 0 the two colours are
      // interpolated as before, so an existing project is untouched.
      { key: 'hueInterpolation', label: 'Hue Interpolation', type: 'number', unit: '°', min: 0, max: 360, default: 0 },
      /*
        ── Analysis window ─────────────────────────────────────────────
        Duration is how much audio each frame looks at; a longer window is
        steadier and less responsive. Offset shifts WHICH audio, which is how
        you make the bars lead the picture slightly — the trick that stops a
        visualiser feeling a frame behind the beat.
      */
      { key: 'audioDuration', label: 'Audio Duration', type: 'number', unit: 'ms', min: 1, max: 500, default: 43 },
      { key: 'audioOffset', label: 'Audio Offset', type: 'number', unit: 'ms', min: -2000, max: 2000, default: 0 },
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
      { key: 'hue', label: 'Master Hue', type: 'number', group: 'Master', unit: '°', min: -180, max: 180, default: 0 },
      { key: 'saturation', label: 'Master Saturation', type: 'number', group: 'Master', min: -100, max: 100, default: 0 },
      { key: 'lightness', label: 'Master Lightness', type: 'number', group: 'Master', min: -100, max: 100, default: 0 },
      { key: 'redsHue', label: 'Reds Hue', type: 'number', group: 'Reds', unit: '°', min: -180, max: 180, default: 0 },
      { key: 'redsSaturation', label: 'Reds Saturation', type: 'number', group: 'Reds', min: -100, max: 100, default: 0 },
      { key: 'redsLightness', label: 'Reds Lightness', type: 'number', group: 'Reds', min: -100, max: 100, default: 0 },
      { key: 'yellowsHue', label: 'Yellows Hue', type: 'number', group: 'Yellows', unit: '°', min: -180, max: 180, default: 0 },
      { key: 'yellowsSaturation', label: 'Yellows Saturation', type: 'number', group: 'Yellows', min: -100, max: 100, default: 0 },
      { key: 'yellowsLightness', label: 'Yellows Lightness', type: 'number', group: 'Yellows', min: -100, max: 100, default: 0 },
      { key: 'greensHue', label: 'Greens Hue', type: 'number', group: 'Greens', unit: '°', min: -180, max: 180, default: 0 },
      { key: 'greensSaturation', label: 'Greens Saturation', type: 'number', group: 'Greens', min: -100, max: 100, default: 0 },
      { key: 'greensLightness', label: 'Greens Lightness', type: 'number', group: 'Greens', min: -100, max: 100, default: 0 },
      { key: 'cyansHue', label: 'Cyans Hue', type: 'number', group: 'Cyans', unit: '°', min: -180, max: 180, default: 0 },
      { key: 'cyansSaturation', label: 'Cyans Saturation', type: 'number', group: 'Cyans', min: -100, max: 100, default: 0 },
      { key: 'cyansLightness', label: 'Cyans Lightness', type: 'number', group: 'Cyans', min: -100, max: 100, default: 0 },
      { key: 'bluesHue', label: 'Blues Hue', type: 'number', group: 'Blues', unit: '°', min: -180, max: 180, default: 0 },
      { key: 'bluesSaturation', label: 'Blues Saturation', type: 'number', group: 'Blues', min: -100, max: 100, default: 0 },
      { key: 'bluesLightness', label: 'Blues Lightness', type: 'number', group: 'Blues', min: -100, max: 100, default: 0 },
      { key: 'magentasHue', label: 'Magentas Hue', type: 'number', group: 'Magentas', unit: '°', min: -180, max: 180, default: 0 },
      { key: 'magentasSaturation', label: 'Magentas Saturation', type: 'number', group: 'Magentas', min: -100, max: 100, default: 0 },
      { key: 'magentasLightness', label: 'Magentas Lightness', type: 'number', group: 'Magentas', min: -100, max: 100, default: 0 },
      { key: 'colorize', label: 'Colorize', type: 'checkbox', group: 'Colorize', default: false },
      { key: 'colorizeHue', label: 'Colorize Hue', type: 'number', group: 'Colorize', unit: '°', min: 0, max: 360, default: 0 },
      { key: 'colorizeSaturation', label: 'Colorize Saturation', type: 'number', group: 'Colorize', min: 0, max: 100, default: 25 },
      { key: 'colorizeLightness', label: 'Colorize Lightness', type: 'number', group: 'Colorize', min: -100, max: 100, default: 0 },
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
      { key: 'inputBlack', label: 'Input Black', type: 'number', group: 'RGB', min: 0, max: 255, default: 0 },
      { key: 'inputWhite', label: 'Input White', type: 'number', group: 'RGB', min: 0, max: 255, default: 255 },
      { key: 'gamma', label: 'Gamma', type: 'number', group: 'RGB', min: 0.1, max: 10, precision: 2, default: 1 },
      { key: 'outputBlack', label: 'Output Black', type: 'number', group: 'RGB', min: 0, max: 255, default: 0 },
      { key: 'outputWhite', label: 'Output White', type: 'number', group: 'RGB', min: 0, max: 255, default: 255 },
      { key: 'redInputBlack', label: 'Red Input Black', type: 'number', group: 'Red', min: 0, max: 255, default: 0 },
      { key: 'redInputWhite', label: 'Red Input White', type: 'number', group: 'Red', min: 0, max: 255, default: 255 },
      { key: 'redGamma', label: 'Red Gamma', type: 'number', group: 'Red', min: 0.1, max: 10, precision: 2, default: 1 },
      { key: 'redOutputBlack', label: 'Red Output Black', type: 'number', group: 'Red', min: 0, max: 255, default: 0 },
      { key: 'redOutputWhite', label: 'Red Output White', type: 'number', group: 'Red', min: 0, max: 255, default: 255 },
      { key: 'greenInputBlack', label: 'Green Input Black', type: 'number', group: 'Green', min: 0, max: 255, default: 0 },
      { key: 'greenInputWhite', label: 'Green Input White', type: 'number', group: 'Green', min: 0, max: 255, default: 255 },
      { key: 'greenGamma', label: 'Green Gamma', type: 'number', group: 'Green', min: 0.1, max: 10, precision: 2, default: 1 },
      { key: 'greenOutputBlack', label: 'Green Output Black', type: 'number', group: 'Green', min: 0, max: 255, default: 0 },
      { key: 'greenOutputWhite', label: 'Green Output White', type: 'number', group: 'Green', min: 0, max: 255, default: 255 },
      { key: 'blueInputBlack', label: 'Blue Input Black', type: 'number', group: 'Blue', min: 0, max: 255, default: 0 },
      { key: 'blueInputWhite', label: 'Blue Input White', type: 'number', group: 'Blue', min: 0, max: 255, default: 255 },
      { key: 'blueGamma', label: 'Blue Gamma', type: 'number', group: 'Blue', min: 0.1, max: 10, precision: 2, default: 1 },
      { key: 'blueOutputBlack', label: 'Blue Output Black', type: 'number', group: 'Blue', min: 0, max: 255, default: 0 },
      { key: 'blueOutputWhite', label: 'Blue Output White', type: 'number', group: 'Blue', min: 0, max: 255, default: 255 },
      { key: 'alphaInputBlack', label: 'Alpha Input Black', type: 'number', group: 'Alpha', min: 0, max: 255, default: 0 },
      { key: 'alphaInputWhite', label: 'Alpha Input White', type: 'number', group: 'Alpha', min: 0, max: 255, default: 255 },
      { key: 'alphaGamma', label: 'Alpha Gamma', type: 'number', group: 'Alpha', min: 0.1, max: 10, precision: 2, default: 1 },
      { key: 'alphaOutputBlack', label: 'Alpha Output Black', type: 'number', group: 'Alpha', min: 0, max: 255, default: 0 },
      { key: 'alphaOutputWhite', label: 'Alpha Output White', type: 'number', group: 'Alpha', min: 0, max: 255, default: 255 },
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
      { key: 'exposure', label: 'Exposure', type: 'number', group: 'Basic Correction', unit: 'stops', min: -5, max: 5, precision: 2, default: 0 },
      { key: 'contrast', label: 'Contrast', type: 'number', group: 'Basic Correction', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'highlights', label: 'Highlights', type: 'number', group: 'Basic Correction', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'shadows', label: 'Shadows', type: 'number', group: 'Basic Correction', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'whites', label: 'Whites', type: 'number', group: 'Basic Correction', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'blacks', label: 'Blacks', type: 'number', group: 'Basic Correction', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'temperature', label: 'Temperature', type: 'number', group: 'Basic Correction', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'tint', label: 'Tint', type: 'number', group: 'Basic Correction', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'saturation', label: 'Saturation', type: 'number', group: 'Basic Correction', unit: '%', min: 0, max: 200, default: 100 },
      { key: 'fadedFilm', label: 'Faded Film', type: 'number', group: 'Creative', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'vibrance', label: 'Vibrance', type: 'number', group: 'Creative', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'creativeSaturation', label: 'Saturation', type: 'number', group: 'Creative', unit: '%', min: 0, max: 200, default: 100 },
      { key: 'shadowTintHue', label: 'Shadow Tint Hue', type: 'number', group: 'Creative', unit: '°', min: 0, max: 360, default: 0 },
      { key: 'shadowTintAmount', label: 'Shadow Tint Amount', type: 'number', group: 'Creative', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'highlightTintHue', label: 'Highlight Tint Hue', type: 'number', group: 'Creative', unit: '°', min: 0, max: 360, default: 0 },
      { key: 'highlightTintAmount', label: 'Highlight Tint Amount', type: 'number', group: 'Creative', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'tintBalance', label: 'Tint Balance', type: 'number', group: 'Creative', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'rgbCurve', label: 'RGB Curve', type: 'curve', group: 'Curves', default: [[0,  0],  [255,  255]] },
      { key: 'redCurve', label: 'Red Curve', type: 'curve', group: 'Curves', default: [[0,  0],  [255,  255]] },
      { key: 'greenCurve', label: 'Green Curve', type: 'curve', group: 'Curves', default: [[0,  0],  [255,  255]] },
      { key: 'blueCurve', label: 'Blue Curve', type: 'curve', group: 'Curves', default: [[0,  0],  [255,  255]] },
      { key: 'hueVsSat', label: 'Hue vs Saturation', type: 'curve', group: 'Hue Saturation Curves', default: [[0,  128],  [255,  128]] },
      { key: 'hueVsHue', label: 'Hue vs Hue', type: 'curve', group: 'Hue Saturation Curves', default: [[0,  128],  [255,  128]] },
      { key: 'hueVsLuma', label: 'Hue vs Luma', type: 'curve', group: 'Hue Saturation Curves', default: [[0,  128],  [255,  128]] },
      { key: 'lumaVsSat', label: 'Luma vs Saturation', type: 'curve', group: 'Hue Saturation Curves', default: [[0,  128],  [255,  128]] },
      { key: 'shadowsHue', label: 'Shadows Hue', type: 'number', group: 'Color Wheels', unit: '°', min: 0, max: 360, default: 0 },
      { key: 'shadowsAmount', label: 'Shadows Amount', type: 'number', group: 'Color Wheels', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'shadowsLuma', label: 'Shadows Luma', type: 'number', group: 'Color Wheels', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'midtonesHue', label: 'Midtones Hue', type: 'number', group: 'Color Wheels', unit: '°', min: 0, max: 360, default: 0 },
      { key: 'midtonesAmount', label: 'Midtones Amount', type: 'number', group: 'Color Wheels', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'midtonesLuma', label: 'Midtones Luma', type: 'number', group: 'Color Wheels', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'highlightsHue', label: 'Highlights Hue', type: 'number', group: 'Color Wheels', unit: '°', min: 0, max: 360, default: 0 },
      { key: 'highlightsAmount', label: 'Highlights Amount', type: 'number', group: 'Color Wheels', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'highlightsLuma', label: 'Highlights Luma', type: 'number', group: 'Color Wheels', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'hslEnable', label: 'Enable', type: 'checkbox', group: 'HSL Secondary', default: false },
      { key: 'hslHue', label: 'Hue Center', type: 'number', group: 'HSL Secondary', unit: '°', min: 0, max: 360, default: 0 },
      { key: 'hslHueRange', label: 'Hue Range', type: 'number', group: 'HSL Secondary', unit: '°', min: 0, max: 180, default: 30 },
      { key: 'hslHueSoftness', label: 'Hue Softness', type: 'number', group: 'HSL Secondary', unit: '°', min: 0, max: 180, default: 20 },
      { key: 'hslSatMin', label: 'Saturation Min', type: 'number', group: 'HSL Secondary', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'hslSatMax', label: 'Saturation Max', type: 'number', group: 'HSL Secondary', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'hslLumMin', label: 'Luma Min', type: 'number', group: 'HSL Secondary', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'hslLumMax', label: 'Luma Max', type: 'number', group: 'HSL Secondary', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'hslSoftness', label: 'Range Softness', type: 'number', group: 'HSL Secondary', unit: '%', min: 0, max: 100, default: 10 },
      { key: 'hslShowMask', label: 'Show Mask', type: 'checkbox', group: 'HSL Secondary', default: false },
      { key: 'hslTemperature', label: 'Temperature', type: 'number', group: 'HSL Secondary', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'hslTint', label: 'Tint', type: 'number', group: 'HSL Secondary', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'hslContrast', label: 'Contrast', type: 'number', group: 'HSL Secondary', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'hslSaturation', label: 'Saturation', type: 'number', group: 'HSL Secondary', unit: '%', min: 0, max: 200, default: 100 },
      { key: 'vignetteAmount', label: 'Amount', type: 'number', group: 'Vignette', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'vignetteMidpoint', label: 'Midpoint', type: 'number', group: 'Vignette', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'vignetteRoundness', label: 'Roundness', type: 'number', group: 'Vignette', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'vignetteFeather', label: 'Feather', type: 'number', group: 'Vignette', unit: '%', min: 0, max: 100, default: 50 },
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
  //
  // The AE controls added 2026-09-15 (All Masks, Stroke Sequentially, Segment
  // Distribution, Random Phase, Blend Mode, the three-point opacity profile)
  // all DEFAULT to the look Vegas had before them — Even spacing, Over, flat
  // 100 % — so a stored document renders identically. A new instance starts
  // Bunched, as AE's does (`newInstanceParams`).
  {
    type: 'vegas',
    label: 'Vegas',
    params: [
      // A mask path as the contour instead of the alpha silhouette — the AE
      // "Stroke: Mask/Path" reading of this effect. With a TRACKED mask the
      // lights chase around a moving object. None = Image Contours.
      { key: 'pathMaskId', label: 'Path', type: 'maskPath', default: '', noneLabel: 'None (Image Contours)' },
      // Every mask on the layer, in mask order, instead of the one picked.
      { key: 'allMasks', label: 'All Masks', type: 'checkbox', default: false },
      // With All Masks: one sequence of lights running through the masks in
      // order, rather than a full set of lights on each.
      { key: 'strokeSequentially', label: 'Stroke Sequentially', type: 'checkbox', default: false },
      { key: 'segments', label: 'Segments', type: 'number', unit: '', min: 1, max: 200, default: 3 },
      // Percent of each light's own SLOT, not of the whole perimeter, so
      // changing the count does not also change how long each light is.
      { key: 'length', label: 'Length', type: 'number', unit: '%', min: 0, max: 100, default: 40 },
      {
        key: 'segmentDistribution', label: 'Segment Distribution', type: 'enum', default: 1,
        options: [{ value: 0, label: 'Bunched' }, { value: 1, label: 'Even' }],
      },
      // The animated one. A full lap per 360 degrees.
      { key: 'rotation', label: 'Rotation', type: 'number', unit: '°', min: -3600, max: 3600, default: 0 },
      // Each contour / mask starts its lights at a random point of its own lap.
      { key: 'randomPhase', label: 'Random Phase', type: 'checkbox', default: false },
      { key: 'randomSeed', label: 'Random Seed', type: 'number', min: 0, max: 100000, precision: 0, default: 0 },
      {
        key: 'blendMode', label: 'Blend Mode', type: 'enum', default: 1,
        options: [
          { value: 0, label: 'Transparent' },
          { value: 1, label: 'Over' },
          { value: 2, label: 'Under' },
          { value: 3, label: 'Stencil' },
        ],
      },
      { key: 'color', label: 'Color', type: 'color', default: '#ffffff' },
      { key: 'width', label: 'Width', type: 'number', unit: 'px', min: 0.1, max: 200, default: 6 },
      { key: 'hardness', label: 'Hardness', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      // Opacity ALONG each light: Start → Mid-point (at Mid-point Position) → End.
      { key: 'startOpacity', label: 'Start Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'midOpacity', label: 'Mid-point Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'midPosition', label: 'Mid-point Position', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'endOpacity', label: 'End Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      // The whole effect's opacity, on top of the profile above.
      { key: 'opacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      // Where the contour is cut. Clamped away from both ends in `drawVegas`:
      // at 0 every pixel counts as inside and there is no edge to trace, at 255
      // an antialiased shape contours along its own interior.
      { key: 'threshold', label: 'Threshold', type: 'number', unit: '', min: 1, max: 254, default: 128, group: 'Image Contours' },
      { key: 'pathPoints', label: 'Path (resolved)', type: 'resolved', unit: 'px', default: [] },
      { key: 'maskPathsMeta', label: 'Masks (resolved)', type: 'resolved', default: [] },
      { key: 'maskPathsXY', label: 'Mask points (resolved)', type: 'resolved', unit: 'px', default: [] },
    ],
    newInstanceParams: { segmentDistribution: 0 },
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
    // Stream D L5 (2026-11-02): After Effects' Displacement Map controls
    // (native/engine/catalog/effects.json is the source). `amount` IS Max
    // Horizontal; a document without Max Vertical moves both axes by it, so
    // every older document renders as before.
    params: [
      // The layer whose pixels drive the displacement (AE's Displacement Map
      // Layer). '' = unset → the layer displaces by its own content.
      { key: 'mapLayerId', label: 'Displacement Map Layer', type: 'layer', noneLabel: 'None (this layer)', default: '' },
      { key: 'source', label: 'Displace', type: 'enum', default: 0, options: [{ value: 0, label: 'This Layer' }, { value: 1, label: 'Backdrop (the scene below)' }] },
      { key: 'hChannel', label: 'Use For Horizontal Displacement', type: 'enum', default: 0, options: DISPLACEMENT_CHANNELS },
      { key: 'amount', label: 'Max Horizontal Displacement', type: 'number', unit: 'px', min: -32000, max: 32000, default: 20 },
      { key: 'vChannel', label: 'Use For Vertical Displacement', type: 'enum', default: 1, options: DISPLACEMENT_CHANNELS },
      // On (the default, and every older document): Max Vertical = Max Horizontal, the original ±amount on both axes.
      { key: 'linkVertical', label: 'Vertical = Horizontal', type: 'checkbox', default: true },
      { key: 'maxVertical', label: 'Max Vertical Displacement', type: 'number', unit: 'px', min: -32000, max: 32000, default: 20 },
      { key: 'mapBehavior', label: 'Displacement Map Behavior', type: 'enum', default: 0, options: [{ value: 0, label: 'As Placed in Comp' }, { value: 1, label: 'Center Map' }, { value: 2, label: 'Stretch Map to Fit' }, { value: 3, label: 'Tile Map' }] },
      { key: 'edgeBehavior', label: 'Edge Behavior', type: 'enum', default: 0, options: [{ value: 0, label: 'Clamp Edge Pixels' }, { value: 1, label: 'Wrap Pixels Around' }, { value: 2, label: 'Transparent' }] },
      { key: 'expandOutput', label: 'Expand Output', type: 'checkbox', default: true },
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

  // Image Fill: a project image over the layer's content, respecting its alpha.
  // Applied To the Background it replaces what is behind a subject (subject styles).
  {
    type: 'image-fill',
    label: 'Image Fill',
    gpuOnly: true,
    params: [
      { key: 'image', label: 'Image', type: 'file', fileTypes: 'png|jpg|jpeg|webp|bmp|tif|tiff|tga|exr|hdr|gif|avif', default: '' },
      { key: 'fit', label: 'Fit', type: 'enum', options: [{ value: 0, label: 'Fill Frame' }, { value: 1, label: 'Fit Inside' }, { value: 2, label: 'Stretch' }], default: 0 },
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

  // Alpha Stroke: a coloured outline around the content's alpha silhouette.
  // Id `stroke` for every stored document and layer style; relabelled
  // 2026-09-15 when AE's own Stroke (brush along a mask) arrived as
  // `path-stroke` below and took the name.
  {
    type: 'stroke',
    label: 'Alpha Stroke',
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

  // Stroke (AE Generate ▸ Stroke): round brush dabs along a mask path, or all
  // of them. Defaults are AE's. Start/End are percent of arc length; Spacing is
  // percent of the brush size. The masks arrive resolved per frame from
  // buildSnapshot (`maskPathsMeta` / `maskPathsXY` / `pathMaskIndex`), so a
  // tracked or keyframed mask moves the stroke. Kernel: `pathStroke.ts`.
  {
    type: 'path-stroke',
    label: 'Stroke',
    params: [
      { key: 'pathMaskId', label: 'Path', type: 'maskPath', default: '', noneLabel: 'Mask 1 (first mask)' },
      { key: 'allMasks', label: 'All Masks', type: 'checkbox', default: false },
      { key: 'strokeSequentially', label: 'Stroke Sequentially', type: 'checkbox', default: false },
      { key: 'color', label: 'Color', type: 'color', default: '#ffffff' },
      { key: 'brushSize', label: 'Brush Size', type: 'number', unit: 'px', min: 0, max: 50, precision: 1, default: 2 },
      { key: 'brushHardness', label: 'Brush Hardness', type: 'number', unit: '%', min: 0, max: 100, default: 75 },
      { key: 'opacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, precision: 1, default: 100 },
      { key: 'start', label: 'Start', type: 'number', unit: '%', min: 0, max: 100, precision: 1, default: 0 },
      { key: 'end', label: 'End', type: 'number', unit: '%', min: 0, max: 100, precision: 1, default: 100 },
      { key: 'spacing', label: 'Spacing', type: 'number', unit: '%', min: 0, max: 100, precision: 1, default: 15 },
      {
        key: 'paintStyle', label: 'Paint Style', type: 'enum', default: 0,
        options: [
          { value: 0, label: 'On Original Image' },
          { value: 1, label: 'On Transparent' },
          { value: 2, label: 'Reveal Original Image' },
        ],
      },
      { key: 'maskPathsMeta', label: 'Masks (resolved)', type: 'resolved', default: [] },
      { key: 'maskPathsXY', label: 'Mask points (resolved)', type: 'resolved', unit: 'px', default: [] },
      { key: 'pathMaskIndex', label: 'Path index (resolved)', type: 'resolved', default: -1 },
    ],
    css: () => '',
  },

  // Scribble (AE Generate ▸ Scribble): a mask filled or edged with one
  // continuous zig-zag pen line. The wiggle is a keyframe-free animation: the
  // resolved `wiggleState` is quantised from the layer clock in buildSnapshot,
  // so the kernel stays a pure function and Static / Jumpy scribbles cache.
  // Kernel and model: `scribble.ts`.
  {
    type: 'scribble',
    label: 'Scribble',
    params: [
      {
        key: 'scribbleMode', label: 'Scribble', type: 'enum', default: 0,
        options: [
          { value: 0, label: 'Single Mask' },
          { value: 1, label: 'All Masks' },
          { value: 2, label: 'All Masks Using Modes' },
        ],
      },
      { key: 'pathMaskId', label: 'Mask', type: 'maskPath', default: '', noneLabel: 'Mask 1 (first mask)' },
      {
        key: 'fillType', label: 'Fill Type', type: 'enum', default: 0,
        options: [
          { value: 0, label: 'Inside' },
          { value: 1, label: 'Centered Edge' },
          { value: 2, label: 'Inside Edge' },
          { value: 3, label: 'Outside Edge' },
          { value: 4, label: 'Left Edge' },
          { value: 5, label: 'Right Edge' },
        ],
      },
      { key: 'edgeWidth', label: 'Edge Width', type: 'number', unit: 'px', min: 0, max: 1000, precision: 1, default: 10, group: 'Edge Options' },
      {
        key: 'endCap', label: 'End Cap', type: 'enum', default: 1, group: 'Edge Options',
        options: [{ value: 0, label: 'Butt' }, { value: 1, label: 'Round' }, { value: 2, label: 'Projecting' }],
      },
      {
        key: 'join', label: 'Join', type: 'enum', default: 1, group: 'Edge Options',
        options: [{ value: 0, label: 'Miter' }, { value: 1, label: 'Round' }, { value: 2, label: 'Bevel' }],
      },
      { key: 'miterLimit', label: 'Miter Limit', type: 'number', min: 1, max: 500, precision: 1, default: 4, group: 'Edge Options' },
      { key: 'color', label: 'Color', type: 'color', default: '#ffffff' },
      { key: 'opacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, precision: 1, default: 100 },
      { key: 'angle', label: 'Angle', type: 'number', unit: '°', min: -3600, max: 3600, default: 45 },
      { key: 'strokeWidth', label: 'Stroke Width', type: 'number', unit: 'px', min: 0.1, max: 50, precision: 1, default: 5 },
      { key: 'curviness', label: 'Curviness', type: 'number', unit: '%', min: 0, max: 100, default: 5, group: 'Stroke Options' },
      { key: 'curvinessVariation', label: 'Curviness Variation', type: 'number', unit: '%', min: 0, max: 100, default: 1, group: 'Stroke Options' },
      { key: 'spacing', label: 'Spacing', type: 'number', unit: 'px', min: 0.1, max: 1000, precision: 1, default: 5, group: 'Stroke Options' },
      { key: 'spacingVariation', label: 'Spacing Variation', type: 'number', unit: 'px', min: 0, max: 1000, precision: 1, default: 1, group: 'Stroke Options' },
      { key: 'pathOverlap', label: 'Path Overlap', type: 'number', unit: '%', min: -100, max: 100, default: 0, group: 'Stroke Options' },
      { key: 'pathOverlapVariation', label: 'Path Overlap Variation', type: 'number', unit: '%', min: 0, max: 100, default: 5, group: 'Stroke Options' },
      { key: 'start', label: 'Start', type: 'number', unit: '%', min: 0, max: 100, precision: 1, default: 0 },
      { key: 'end', label: 'End', type: 'number', unit: '%', min: 0, max: 100, precision: 1, default: 100 },
      { key: 'fillPathsSequentially', label: 'Fill Paths Sequentially', type: 'checkbox', default: true },
      {
        key: 'wiggleType', label: 'Wiggle Type', type: 'enum', default: 2, group: 'Wiggle',
        options: [{ value: 0, label: 'Static' }, { value: 1, label: 'Jumpy' }, { value: 2, label: 'Smooth' }],
      },
      { key: 'wigglesPerSecond', label: 'Wiggles/Second', type: 'number', min: 0, max: 100, precision: 2, default: 5, group: 'Wiggle' },
      { key: 'randomSeed', label: 'Random Seed', type: 'number', min: 0, max: 100000, precision: 0, default: 0, group: 'Wiggle' },
      {
        key: 'composite', label: 'Composite', type: 'enum', default: 1,
        options: [
          { value: 0, label: 'On Original Image' },
          { value: 1, label: 'On Transparent' },
          { value: 2, label: 'Reveal Original Image' },
        ],
      },
      { key: 'maskPathsMeta', label: 'Masks (resolved)', type: 'resolved', default: [] },
      { key: 'maskPathsXY', label: 'Mask points (resolved)', type: 'resolved', unit: 'px', default: [] },
      { key: 'pathMaskIndex', label: 'Mask index (resolved)', type: 'resolved', default: -1 },
      { key: 'wiggleState', label: 'Wiggle state (resolved)', type: 'resolved', default: 0 },
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
      { key: 'evolution', label: 'Evolution', type: 'number', min: -1000, max: 1000, default: 0 },
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
      { key: 'view', label: 'View', type: 'enum', options: [{ value: 0, label: 'Final Result' }, { value: 1, label: 'Source' }, { value: 2, label: 'Screen Matte' }, { value: 3, label: 'Status' }, { value: 4, label: 'Intermediate Result' }], default: 0 },
      { key: 'screenPreBlur', label: 'Screen Pre-blur', type: 'number', unit: 'px', min: 0, max: 20, precision: 1, default: 0 },
      { key: 'clipRollback', label: 'Clip Rollback', type: 'number', group: 'Screen Matte', unit: 'px', min: 0, max: 50, precision: 0, default: 0 },
      { key: 'insideMaskId', label: 'Inside Mask', type: 'maskPath', group: 'Inside Mask', default: '' },
      { key: 'outsideMaskId', label: 'Outside Mask', type: 'maskPath', group: 'Outside Mask', default: '' },
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
      { key: 'distortionPercentage', label: 'Distortion Percentage', type: 'number', unit: '%', min: 0, max: 200, default: 100 },
      { key: 'fieldGrid', label: 'Distortion Mesh Size', type: 'data', default: [] },
      { key: 'field', label: 'Distortion Mesh', type: 'data', unit: 'px', default: [] },
    ],
    css: () => '',
  },
  // AE parity 5.5 — Reshape: the picture inside the Source mask morphs to the Destination mask (a thin-plate spline
  // over their outlines; the Boundary mask, when set, holds everything outside it).
  {
    type: 'reshape',
    label: 'Reshape',
    params: [
      { key: 'sourceMaskId', label: 'Source Mask', type: 'maskPath', default: '' },
      { key: 'destinationMaskId', label: 'Destination Mask', type: 'maskPath', default: '' },
      { key: 'boundaryMaskId', label: 'Boundary Mask', type: 'maskPath', default: '' },
      { key: 'percent', label: 'Percent', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'elasticity', label: 'Elasticity', type: 'enum', options: [{ value: 0, label: 'Stiff' }, { value: 1, label: 'Less Stiff' }, { value: 2, label: 'Below Normal' }, { value: 3, label: 'Normal' }, { value: 4, label: 'Above Normal' }, { value: 5, label: 'Loose' }, { value: 6, label: 'Liquid' }, { value: 7, label: 'Super Fluid' }], default: 3 },
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
      { key: 'rows', label: 'Rows', type: 'number', min: 1, max: 31, precision: 0, default: 3 },
      { key: 'columns', label: 'Columns', type: 'number', min: 1, max: 31, precision: 0, default: 3 },
      { key: 'meshOffsets', label: 'Distortion Mesh', type: 'data', unit: 'px', default: [] },
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
      { key: 'evolution', label: 'Evolution', type: 'number', min: -10000, max: 10000, default: 0 },
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
      // Camera program D1: Blur Map = Scene Depth — the 3D layers' depth sets
      // the blur per pixel (a thin-lens circle of confusion about the focus).
      { key: 'blurMap', label: 'Blur Map', type: 'enum', default: 0, options: [{ value: 0, label: 'None' }, { value: 1, label: 'Scene Depth' }] },
      { key: 'focusFromCamera', label: 'Focus From Camera', type: 'checkbox', default: true },
      { key: 'focusDistance', label: 'Blur Focal Distance', type: 'number', unit: 'px', min: 1, max: 100000, default: 1500 },
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
      // Path-guided bolt: the mask path is the baseline the midpoint
      // displacement forks around instead of the Start→End segment, so a
      // tracked mask makes the lightning crawl around the object.
      { key: 'pathMaskId', label: 'Path', type: 'maskPath', default: '' },
      { key: 'pathPoints', label: 'Path (resolved)', type: 'resolved', default: [] },
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
      // The same layout set as Audio Spectrum, and deliberately the same KEYS:
      // the two effects answer one question ("where does this run and how does
      // it look"), and a user who learns it on one should not have to relearn
      // it on the other.
      { key: 'usePolarPath', label: 'Use Polar Path', type: 'checkbox', default: false },
      { key: 'polarRadius', label: 'Polar Radius', type: 'number', unit: 'px', min: 0, max: 4000, default: 200 },
      { key: 'startAngle', label: 'Start Angle', type: 'number', unit: '°', min: -360, max: 360, default: -90 },
      { key: 'pathMaskId', label: 'Path', type: 'maskPath', default: '' },
      { key: 'pathPoints', label: 'Path (resolved)', type: 'resolved', default: [] },
      { key: 'startX', label: 'Start Point X', type: 'number', unit: 'px', min: -4000, max: 4000, default: -400 },
      { key: 'startY', label: 'Start Point Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'endX', label: 'End Point X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 400 },
      { key: 'endY', label: 'End Point Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'side', label: 'Side Options', type: 'enum', default: 2,
        options: [
          { value: 0, label: 'Side A' },
          { value: 1, label: 'Side B' },
          { value: 2, label: 'Both Sides' },
        ] },
      { key: 'softness', label: 'Softness', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'hueInterpolation', label: 'Hue Interpolation', type: 'number', unit: '°', min: 0, max: 360, default: 0 },
      // How many points are drawn. AE calls it Displayed Samples; fewer reads
      // as a chunky digital meter, more as a continuous trace.
      { key: 'displayedSamples', label: 'Displayed Samples', type: 'number', min: 2, max: 512, precision: 0, default: 128 },
      // Which channel is drawn. Mono sums the pair, as AE's Waveform Options do.
      { key: 'channel', label: 'Waveform Options', type: 'enum', default: 0,
        options: [
          { value: 0, label: 'Mono' },
          { value: 1, label: 'Left' },
          { value: 2, label: 'Right' },
        ] },
      { key: 'audioDuration', label: 'Audio Duration', type: 'number', unit: 'ms', min: 1, max: 500, default: 43 },
      { key: 'audioOffset', label: 'Audio Offset', type: 'number', unit: 'ms', min: -2000, max: 2000, default: 0 },
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
  // AE parity 5.2 — spill, matte edge and grain cleanup (CPU pixel passes, keying_more_kernels.cpp).
  {
    type: 'advanced-spill-suppressor',
    label: 'Advanced Spill Suppressor',
    params: [
      { key: 'method', label: 'Method', type: 'enum', options: [{ value: 0, label: 'Standard' }, { value: 1, label: 'Ultra' }], default: 0 },
      { key: 'suppression', label: 'Suppression', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'keyColor', label: 'Key Color', type: 'color', group: 'Ultra Settings', default: '#00ff00' },
      { key: 'tolerance', label: 'Tolerance', type: 'number', group: 'Ultra Settings', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'desaturate', label: 'Desaturate', type: 'number', group: 'Ultra Settings', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'spillRange', label: 'Spill Range', type: 'number', group: 'Ultra Settings', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'spillColorCorrection', label: 'Spill Color Correction', type: 'number', group: 'Ultra Settings', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'lumaCorrection', label: 'Luma Correction', type: 'number', group: 'Ultra Settings', unit: '%', min: 0, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    type: 'key-cleaner',
    label: 'Key Cleaner',
    params: [
      { key: 'edgeRadius', label: 'Additional Edge Radius', type: 'number', unit: 'px', min: 0, max: 50, precision: 0, default: 4 },
      { key: 'reduceChatter', label: 'Reduce Chatter', type: 'checkbox', default: false },
      { key: 'alphaContrast', label: 'Alpha Contrast', type: 'number', unit: '%', min: 0, max: 200, default: 100 },
      { key: 'strength', label: 'Strength', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
    ],
    css: () => '',
  },
  {
    type: 'remove-grain',
    label: 'Remove Grain',
    params: [
      { key: 'viewingMode', label: 'Viewing Mode', type: 'enum', options: [{ value: 0, label: 'Final Output' }, { value: 1, label: 'Noise Samples' }], default: 0 },
      { key: 'noiseReduction', label: 'Noise Reduction', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'radius', label: 'Reduction Radius', type: 'number', unit: 'px', min: 1, max: 8, precision: 0, default: 2 },
      { key: 'passes', label: 'Passes', type: 'number', min: 1, max: 4, precision: 0, default: 1 },
      { key: 'detail', label: 'Fine Detail', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'chroma', label: 'Chroma Suppression', type: 'number', unit: '%', min: 0, max: 100, default: 60 },
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

  {
    type: 'refine-soft-matte',
    label: 'Refine Soft Matte',
    params: refineMatteParams(10, 4, 0),
    css: () => '',
  },
  {
    type: 'refine-hard-matte',
    label: 'Refine Hard Matte',
    params: refineMatteParams(3, 1, 50),
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
      { key: 'noisePhase', label: 'Noise Phase', type: 'number', min: -100000, max: 100000, precision: 0, default: 0 },
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
      { key: 'phase', label: 'Phase', type: 'number', min: -36000, max: 36000, default: 0 },
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
      { key: 'evolution', label: 'Evolution', type: 'number', min: -36000, max: 36000, default: 0 },
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
      { key: 'evolution', label: 'Evolution', type: 'number', min: -36000, max: 36000, default: 0 },
      { key: 'opacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 55 },
      { key: 'rainColor', label: 'Rain Color', type: 'color', default: '#cfe6ff' },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 100000, precision: 0, default: 1 },
    ],
    css: () => '',
  },
  {
    /*
      Write-on. Two forms behind Mode:

      Brush Position (AE's Write-on, 2026-09-15) records a brush: a dab at
      Brush Position every Brush Spacing seconds from the first keyframe to
      now, so keyframing the position draws its motion path. Stroke Length
      keeps the last N seconds (0 = all). Paint / Brush Time Properties keep
      each dab's colour / opacity / size / hardness from the moment it was laid.
      The dab history is sampled by buildSnapshot (`brushTrail*`); kernel in
      `writeOnBrush.ts`. CPU-baked.

      Classic Line / Path is the form this effect shipped with — a stroke drawn
      progressively from Start toward End (or along a mask path), revealed by
      Completion, with Wobble and Taper. It keeps its GPU shader.

      Mode DEFAULTS to Classic, because every document saved before the brush
      form existed stores no `writeOnMode` and must keep its look; a new
      instance starts on the brush (`newInstanceParams`).
    */
    type: 'write-on',
    label: 'Write-on',
    params: [
      {
        key: 'writeOnMode', label: 'Mode', type: 'enum', default: 1,
        options: [{ value: 0, label: 'Brush Position' }, { value: 1, label: 'Classic Line / Path' }],
      },
      { key: 'brushPositionX', label: 'Brush Position X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'brushPositionY', label: 'Brush Position Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'brushColor', label: 'Color', type: 'color', default: '#ffffff' },
      { key: 'brushSize', label: 'Brush Size', type: 'number', unit: 'px', min: 1, max: 100, default: 8 },
      { key: 'brushHardness', label: 'Brush Hardness', type: 'number', unit: '%', min: 0, max: 100, default: 75 },
      { key: 'brushOpacity', label: 'Brush Opacity', type: 'number', unit: '%', min: 0, max: 100, precision: 1, default: 100 },
      { key: 'strokeLength', label: 'Stroke Length (secs)', type: 'number', unit: 's', min: 0, max: 3600, precision: 2, default: 0 },
      { key: 'brushSpacing', label: 'Brush Spacing (secs)', type: 'number', unit: 's', min: 0.001, max: 10, precision: 3, default: 0.001 },
      {
        key: 'paintTimeProps', label: 'Paint Time Properties', type: 'enum', default: 0,
        options: [{ value: 0, label: 'None' }, { value: 1, label: 'Opacity' }, { value: 2, label: 'Color' }],
      },
      {
        key: 'brushTimeProps', label: 'Brush Time Properties', type: 'enum', default: 0,
        options: [
          { value: 0, label: 'None' },
          { value: 1, label: 'Size' },
          { value: 2, label: 'Hardness' },
          { value: 3, label: 'Size & Hardness' },
        ],
      },
      {
        key: 'paintStyle', label: 'Paint Style', type: 'enum', default: 0,
        options: [
          { value: 0, label: 'On Original Image' },
          { value: 1, label: 'On Transparent' },
          { value: 2, label: 'Reveal Original Image' },
        ],
      },
      { key: 'startX', label: 'Start X', type: 'number', unit: 'px', min: -4000, max: 4000, default: -120, group: 'Classic Line / Path' },
      { key: 'startY', label: 'Start Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0, group: 'Classic Line / Path' },
      { key: 'endX', label: 'End X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 120, group: 'Classic Line / Path' },
      { key: 'endY', label: 'End Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0, group: 'Classic Line / Path' },
      { key: 'completion', label: 'Completion', type: 'number', unit: '%', min: 0, max: 100, default: 100, group: 'Classic Line / Path' },
      { key: 'wobble', label: 'Wobble', type: 'number', unit: '%', min: 0, max: 100, default: 25, group: 'Classic Line / Path' },
      { key: 'taper', label: 'Taper', type: 'number', unit: '%', min: 0, max: 100, default: 40, group: 'Classic Line / Path' },
      // Draw along a mask path instead of the Start→End line (Start/End/Wobble
      // are ignored then — the path IS the shape). Keyframe `completion` to
      // reveal the stroke along it; with a tracked mask, along the OBJECT.
      { key: 'pathMaskId', label: 'Path', type: 'maskPath', default: '', group: 'Classic Line / Path' },
      { key: 'pathPoints', label: 'Path (resolved)', type: 'resolved', unit: 'px', default: [] },
      { key: 'brushTrailXY', label: 'Brush trail (resolved)', type: 'resolved', unit: 'px', default: [] },
      { key: 'brushTrailSize', label: 'Brush trail sizes (resolved)', type: 'resolved', unit: 'px', default: [] },
      { key: 'brushTrailAttr', label: 'Brush trail attributes (resolved)', type: 'resolved', default: [] },
      { key: 'brushTrailFilled', label: 'Brush trail thinned (resolved)', type: 'resolved', default: 0 },
    ],
    newInstanceParams: { writeOnMode: 0 },
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

  {
    /*
      Energy Beam — the Saber class. A lit core stroke with an inverse-power
      glow along a MASK PATH (a tracked mask makes it follow the object), the
      layer's own text outline, or a Start→End line; Start/End reveal it,
      Start/End Size taper it, Distortion bends it with curl noise, Flicker
      breathes it. Evolution and Flicker Phase are KEYFRAMED phases (an
      expression such as `time * 10` animates them) rather than the wall
      clock — the rule every generator here follows, see TIME_DEPENDENT.
      See beamPath.ts for the model; fxBeamPath.ts is its GPU twin.
    */
    type: 'beam-path',
    label: 'Energy Beam',
    params: [
      { key: 'source', label: 'Path', type: 'enum', default: 0, options: [{ value: 0, label: 'Mask path (or line)' }, { value: 1, label: 'Start → End line' }, { value: 2, label: 'Text outline' }] },
      { key: 'pathMaskId', label: 'Mask Path', type: 'maskPath', default: '' },
      { key: 'pathPoints', label: 'Path (resolved)', type: 'resolved', default: [] },
      { key: 'startX', label: 'Start X', type: 'number', unit: 'px', min: -4000, max: 4000, default: -200 },
      { key: 'startY', label: 'Start Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'endX', label: 'End X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 200 },
      { key: 'endY', label: 'End Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'start', label: 'Start', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'end', label: 'End', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'coreWidth', label: 'Core Size', type: 'number', unit: 'px', min: 0, max: 200, default: 6 },
      { key: 'coreSoftness', label: 'Core Softness', type: 'number', unit: '%', min: 0, max: 100, default: 30 },
      { key: 'coreColor', label: 'Core Color', type: 'color', default: '#ffffff' },
      { key: 'startSize', label: 'Start Size', type: 'number', unit: '%', min: 0, max: 400, default: 100 },
      { key: 'endSize', label: 'End Size', type: 'number', unit: '%', min: 0, max: 400, default: 100 },
      { key: 'glowColor', label: 'Glow Color', type: 'color', default: '#3fa8ff' },
      { key: 'glowIntensity', label: 'Glow Intensity', type: 'number', unit: '%', min: 0, max: 400, default: 100 },
      { key: 'glowSpread', label: 'Glow Spread', type: 'number', unit: 'px', min: 1, max: 400, default: 30 },
      { key: 'glowBias', label: 'Glow Bias', type: 'number', unit: '%', min: 0, max: 100, default: 33 },
      { key: 'distortion', label: 'Distortion', type: 'number', unit: 'px', min: 0, max: 200, default: 0 },
      { key: 'distortionScale', label: 'Distortion Scale', type: 'number', unit: 'px', min: 4, max: 800, default: 80 },
      { key: 'evolution', label: 'Evolution', type: 'number', min: -100000, max: 100000, default: 0 },
      { key: 'flicker', label: 'Flicker', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'flickerRate', label: 'Flicker Rate', type: 'number', unit: 'Hz', min: 0, max: 120, default: 12 },
      { key: 'flickerPhase', label: 'Flicker Phase', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
      { key: 'seed', label: 'Seed', type: 'number', min: 0, max: 100000, precision: 0, default: 1 },
      { key: 'composite', label: 'Composite', type: 'enum', default: 0, options: [{ value: 0, label: 'Add over layer' }, { value: 1, label: 'Beam only' }] },
    ],
    css: () => '',
  },
  {
    /*
      Plexus — the point/line network (the Rowbyte class). A deterministic
      point cloud drifting on value noise as Evolution advances — or, with a
      mask path assigned, the path's vertices (a tracked mask makes the
      network follow the object) — with every pair closer than Max Distance
      linked by a line whose opacity falls with distance, and optional
      triangles between mutually-close triples. Canvas2D-only like Lightning:
      it DRAWS, with no per-pixel form. The particle system has the same
      network over its live particles (Plexus Distance in the Particle
      section). See plexus.ts.
    */
    type: 'plexus',
    label: 'Plexus',
    params: [
      { key: 'pathMaskId', label: 'Points From Path', type: 'maskPath', default: '' },
      { key: 'pathPoints', label: 'Path (resolved)', type: 'resolved', default: [] },
      { key: 'pathStep', label: 'Path Step', type: 'number', min: 1, max: 32, precision: 0, default: 4 },
      { key: 'pointCount', label: 'Points', type: 'number', min: 0, max: 700, precision: 0, default: 80 },
      { key: 'spread', label: 'Spread', type: 'number', unit: '%', min: 0, max: 100, default: 90 },
      { key: 'drift', label: 'Drift', type: 'number', unit: 'px', min: 0, max: 1000, default: 40 },
      { key: 'evolution', label: 'Evolution', type: 'number', min: -100000, max: 100000, default: 0 },
      { key: 'maxDistance', label: 'Max Distance', type: 'number', unit: 'px', min: 0, max: 2000, default: 140 },
      { key: 'lineWidth', label: 'Line Width', type: 'number', unit: 'px', min: 0, max: 20, precision: 1, default: 1 },
      { key: 'lineOpacity', label: 'Line Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 60 },
      { key: 'lineColor', label: 'Line Color', type: 'color', default: '#9fd0ff' },
      { key: 'triangles', label: 'Triangles', type: 'checkbox', default: false },
      { key: 'triangleOpacity', label: 'Triangle Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 15 },
      { key: 'pointSize', label: 'Point Size', type: 'number', unit: 'px', min: 0, max: 60, default: 3 },
      { key: 'pointColor', label: 'Point Color', type: 'color', default: '#ffffff' },
      { key: 'opacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'seed', label: 'Seed', type: 'number', min: 0, max: 100000, precision: 0, default: 1 },
      { key: 'composite', label: 'Composite', type: 'number', min: 0, max: 4, precision: 0, default: 0 },
    ],
    css: () => '',
  },

  // ── Round five · Stylize ──────────────────────────────────────────
  {
    /*
      Deep Glow — the physically based glow (the Plugin Everything class):
      an octave pyramid of Gaussians summed with equal weight, which IS an
      inverse-square falloff, in linear light. The built-in `glow` above is a
      single Gaussian ring and stays as it is — documents depend on it.
      Exposure is in stops so it composes like a light; Aspect stretches the
      glow (positive = wider than tall, the anamorphic-streak convention);
      Chromatic Aberration widens red and narrows blue. See deepGlow.ts.
    */
    type: 'deep-glow',
    label: 'Deep Glow',
    params: [
      { key: 'radius', label: 'Radius', type: 'number', unit: 'px', min: 0, max: 500, default: 60 },
      { key: 'exposure', label: 'Exposure', type: 'number', unit: 'EV', min: -4, max: 4, default: 0 },
      { key: 'threshold', label: 'Threshold', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'aspect', label: 'Aspect Ratio', type: 'number', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'chromatic', label: 'Chromatic Aberration', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'tint', label: 'Tint', type: 'color', default: '#ffffff' },
      { key: 'tintAmount', label: 'Tint Amount', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'glowOnly', label: 'Glow Only', type: 'checkbox', default: false },
      // One output code of per-pixel noise on the glow: a 1/r² tail crosses the
      // 8-bit floor over a wide band, and without this that band is a visible disc.
      { key: 'dither', label: 'Dither', type: 'checkbox', default: true },
      {
        key: 'quality', label: 'Quality', type: 'enum', default: 1,
        options: [{ value: 0, label: 'Low (4 octaves)' }, { value: 1, label: 'Medium (6 octaves)' }, { value: 2, label: 'High (8 octaves)' }],
      },
    ],
    css: () => '',
  },
  {
    /*
      CC Glass — the layer's own luminance as a bump map: refract, then a
      light. `height` may be negative (bumps become dents), which is half the
      use of the effect in the wild.
    */
    type: 'glass',
    label: 'Glass',
    params: [
      // Stream D: the bump may displace the scene under the layer instead of the layer itself.
      { key: 'source', label: 'Refract', type: 'enum', default: 0, options: [{ value: 0, label: 'This Layer' }, { value: 1, label: 'Backdrop (the scene below)' }] },
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
    /* Ink soaking into paper: the layer's ink spreads by a noise-varied reach,
       pools darker inside its edge and granulates (sumi-e wash). GPU only. */
    type: 'ink-bleed',
    label: 'Ink Bleed',
    gpuOnly: true,
    params: [
      { key: 'spread', label: 'Spread', type: 'number', unit: 'px', min: 0, max: 200, default: 10 },
      { key: 'roughness', label: 'Roughness', type: 'number', unit: '%', min: 0, max: 100, default: 60 },
      { key: 'pool', label: 'Edge Pooling', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'granulation', label: 'Granulation', type: 'number', unit: '%', min: 0, max: 100, default: 35 },
      { key: 'scale', label: 'Paper Scale', type: 'number', unit: 'px', min: 1, max: 400, default: 24 },
      { key: 'evolution', label: 'Evolution', type: 'number', unit: '°', min: -36000, max: 36000, default: 0 },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 9999, precision: 0, default: 1 },
    ],
    css: () => '',
  },
  {
    /* A paper surface over the layer's shape: tone, mottling, fibres, grain.
       Replaces the layer's colour (its alpha kept) — washi / rice paper. GPU only. */
    type: 'paper',
    label: 'Paper',
    gpuOnly: true,
    params: [
      { key: 'color', label: 'Paper Color', type: 'color', default: '#ece4d2' },
      { key: 'fibre', label: 'Fibres', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'grain', label: 'Grain', type: 'number', unit: '%', min: 0, max: 100, default: 40 },
      { key: 'mottle', label: 'Mottling', type: 'number', unit: '%', min: 0, max: 100, default: 45 },
      { key: 'scale', label: 'Scale', type: 'number', unit: '%', min: 10, max: 400, default: 100 },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 9999, precision: 0, default: 1 },
    ],
    css: () => '',
  },
  {
    /* Seeded ink splats with satellite droplets — the flick of a loaded brush.
       Reveal grows them in (keyframe it for the splash landing). GPU only. */
    type: 'ink-splatter',
    label: 'Ink Splatter',
    gpuOnly: true,
    params: [
      { key: 'amount', label: 'Splats', type: 'number', min: 0, max: 48, precision: 0, default: 12 },
      { key: 'size', label: 'Size', type: 'number', unit: 'px', min: 1, max: 400, default: 18 },
      { key: 'spread', label: 'Spread', type: 'number', unit: 'px', min: 0, max: 2000, default: 220 },
      { key: 'centerX', label: 'Center X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'centerY', label: 'Center Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'reveal', label: 'Reveal', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'opacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'color', label: 'Ink Color', type: 'color', default: '#111111' },
      {
        key: 'composite', label: 'Composite', type: 'enum', default: 0,
        options: [{ value: 0, label: 'Over Original' }, { value: 1, label: 'On Transparent' }],
      },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 9999, precision: 0, default: 1 },
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
      { key: 'evolution', label: 'Evolution', type: 'number', min: -36000, max: 36000, default: 0 },
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
      { key: 'spin', label: 'Spin', type: 'number', unit: '°', min: -720, max: 720, default: 180 },
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
      { key: 'phase', label: 'Phase', type: 'number', min: -36000, max: 36000, default: 0 },
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
      { key: 'direction', label: 'Direction', type: 'number', unit: '°', min: -360, max: 360, default: 0 },
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
  // -- Round seven --
  {
    /*
      CC Tiler. `scale` is a PERCENTAGE and 100 is the identity, which is why
      the default is 100 rather than something that shows the effect: adding an
      effect must never change the picture on its own. Every round-seven def
      below holds to that, and the Canvas2D and GPU paths both return early at
      the neutral setting so the identity is exact rather than a resample.
    */
    type: 'cc-tiler',
    label: 'CC Tiler',
    params: [
      { key: 'scale', label: 'Scale', type: 'number', unit: '%', min: 1, max: 100, default: 100 },
      { key: 'centerX', label: 'Center X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'centerY', label: 'Center Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'blendWithOriginal', label: 'Blend With Original', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    /*
      CC Ripple Pulse. `pulseRadius` is the KEYFRAMED property -- the ring does
      not travel on its own. See the TIME_DEPENDENT note: a keyframed phase
      keeps the effect cacheable and under the animator's control, and only an
      effect that cannot be expressed that way earns a place on the clock.
    */
    type: 'ripple-pulse',
    label: 'CC Ripple Pulse',
    params: [
      { key: 'centerX', label: 'Center X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'centerY', label: 'Center Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'pulseRadius', label: 'Pulse Radius', type: 'number', unit: 'px', min: 0, max: 4000, default: 0 },
      { key: 'amplitude', label: 'Amplitude', type: 'number', unit: 'px', min: -200, max: 200, default: 40 },
      { key: 'width', label: 'Width', type: 'number', unit: 'px', min: 1, max: 500, default: 60 },
      { key: 'renderBump', label: 'Render Bump Map', type: 'checkbox', default: true },
    ],
    css: () => '',
  },
  {
    type: 'radial-scale-wipe',
    label: 'CC Radial ScaleWipe',
    params: [
      { key: 'completion', label: 'Completion', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'centerX', label: 'Center X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'centerY', label: 'Center Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'reverse', label: 'Reverse Transition', type: 'checkbox', default: false },
    ],
    css: () => '',
  },
  {
    type: 'glass-wipe',
    label: 'CC Glass Wipe',
    params: [
      { key: 'completion', label: 'Completion', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'displacement', label: 'Displacement', type: 'number', unit: 'px', min: 0, max: 200, default: 40 },
      { key: 'softness', label: 'Softness', type: 'number', unit: '%', min: 0, max: 100, default: 30 },
    ],
    css: () => '',
  },
  {
    type: 'image-wipe',
    label: 'CC Image Wipe',
    params: [
      { key: 'completion', label: 'Completion', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'borderSoftness', label: 'Border Softness', type: 'number', unit: '%', min: 0, max: 100, default: 20 },
      {
        key: 'gradientChannel',
        label: 'Gradient Channel',
        type: 'enum',
        default: 0,
        options: [
          { value: 0, label: 'Luminance' },
          { value: 1, label: 'Alpha' },
          { value: 2, label: 'Red' },
          { value: 3, label: 'Green' },
          { value: 4, label: 'Blue' },
        ],
      },
      { key: 'invertGradient', label: 'Invert Gradient', type: 'checkbox', default: false },
    ],
    css: () => '',
  },
  {
    type: 'color-difference-key',
    label: 'Color Difference Key',
    params: [
      { key: 'keyColor', label: 'Key Color', type: 'color', default: '#00ff00' },
      { key: 'matteInBlack', label: 'Matte In Black', type: 'number', min: 0, max: 255, default: 0, group: 'Matte' },
      { key: 'matteInWhite', label: 'Matte In White', type: 'number', min: 0, max: 255, default: 255, group: 'Matte' },
      { key: 'matteGamma', label: 'Matte Gamma', type: 'number', min: 0.1, max: 10, precision: 2, default: 1, group: 'Matte' },
      {
        key: 'viewMode',
        label: 'View',
        type: 'enum',
        default: 0,
        options: [
          { value: 0, label: 'Final Output' },
          { value: 1, label: 'Matte Only' },
        ],
      },
    ],
    css: () => '',
  },
  {
    type: 'wire-removal',
    label: 'CC Simple Wire Removal',
    params: [
      { key: 'pointAX', label: 'Point A X', type: 'number', unit: 'px', min: -4000, max: 4000, default: -100 },
      { key: 'pointAY', label: 'Point A Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'pointBX', label: 'Point B X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 100 },
      { key: 'pointBY', label: 'Point B Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0 },
      { key: 'thickness', label: 'Thickness', type: 'number', unit: 'px', min: 1, max: 50, default: 4 },
      { key: 'slope', label: 'Slope', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
    ],
    css: () => '',
  },
  {
    type: 'broadcast-colors',
    label: 'Broadcast Colors',
    params: [
      {
        key: 'standard',
        label: 'Broadcast Locale',
        type: 'enum',
        default: 0,
        options: [
          { value: 0, label: 'NTSC' },
          { value: 1, label: 'PAL' },
        ],
      },
      {
        key: 'howToMakeColorSafe',
        label: 'How To Make Color Safe',
        type: 'enum',
        default: 0,
        options: [
          { value: 0, label: 'Reduce Luminance' },
          { value: 1, label: 'Reduce Saturation' },
          { value: 2, label: 'Key Out Unsafe' },
          { value: 3, label: 'Key Out Safe' },
        ],
      },
      { key: 'maxSignalAmplitude', label: 'Maximum Signal Amplitude', type: 'number', unit: 'IRE', min: 90, max: 120, default: 110 },
    ],
    css: () => '',
  },
  {
    /*
      Noise HLS. Three independent amounts because that IS the effect: shifting
      only hue leaves every pixel as bright as it was, which RGB noise cannot
      express. `noisePhase` is an ordinary keyframed parameter, not the clock.
    */
    type: 'noise-hls',
    label: 'Noise HLS',
    params: [
      {
        key: 'noiseType',
        label: 'Noise',
        type: 'enum',
        default: 0,
        options: [
          { value: 0, label: 'Uniform' },
          { value: 1, label: 'Squared' },
        ],
      },
      { key: 'hue', label: 'Hue', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'lightness', label: 'Lightness', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'saturation', label: 'Saturation', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'grainSize', label: 'Grain Size', type: 'number', unit: 'px', min: 0.5, max: 50, precision: 1, default: 1 },
      { key: 'noisePhase', label: 'Noise Phase', type: 'number', min: -36000, max: 36000, default: 0 },
    ],
    css: () => '',
  },
  /*
    The three per-channel transfers. Each is in `LUT_BUILDERS` rather than in
    `CANVAS2D_ONLY`, so it renders on both backends with no bake -- see
    `aeRoundSevenLuts.ts` for the shape rule that decides which side an effect
    lands on. None has a shader of its own; the LUT strip IS the shader.
  */
  {
    type: 'color-offset',
    label: 'CC Color Offset',
    params: [
      { key: 'redPhase', label: 'Red Phase', type: 'number', unit: '°', min: -360, max: 360, default: 0 },
      { key: 'greenPhase', label: 'Green Phase', type: 'number', unit: '°', min: -360, max: 360, default: 0 },
      { key: 'bluePhase', label: 'Blue Phase', type: 'number', unit: '°', min: -360, max: 360, default: 0 },
      {
        key: 'overflow',
        label: 'Overflow',
        type: 'enum',
        default: 0,
        options: [
          { value: 0, label: 'Wrap' },
          { value: 1, label: 'Solarize' },
          { value: 2, label: 'Polarize' },
        ],
      },
    ],
    css: () => '',
  },
  {
    type: 'threshold-rgb',
    label: 'CC Threshold RGB',
    params: [
      { key: 'redLevel', label: 'Red Level', type: 'number', min: 0, max: 255, default: 128 },
      { key: 'greenLevel', label: 'Green Level', type: 'number', min: 0, max: 255, default: 128 },
      { key: 'blueLevel', label: 'Blue Level', type: 'number', min: 0, max: 255, default: 128 },
    ],
    css: () => '',
  },
  {
    type: 'cineon-converter',
    label: 'Cineon Converter',
    params: [
      {
        key: 'conversionType',
        label: 'Conversion Type',
        type: 'enum',
        default: 0,
        options: [
          { value: 0, label: 'Log to Linear' },
          { value: 1, label: 'Linear to Log' },
          { value: 2, label: 'Log to Log' },
        ],
      },
      { key: 'tenBitBlackPoint', label: '10 Bit Black Point', type: 'number', min: 0, max: 1023, default: 95 },
      { key: 'internalBlackPoint', label: 'Internal Black Point', type: 'number', min: 0, max: 255, default: 0 },
      { key: 'tenBitWhitePoint', label: '10 Bit White Point', type: 'number', min: 0, max: 1023, default: 685 },
      { key: 'internalWhitePoint', label: 'Internal White Point', type: 'number', min: 0, max: 255, default: 255 },
      { key: 'gamma', label: 'Gamma', type: 'number', min: 0.1, max: 5, precision: 2, default: 1.7 },
      { key: 'highlightRolloff', label: 'Highlight Rolloff', type: 'number', min: 0, max: 100, default: 20 },
    ],
    css: () => '',
  },
  {
    /* CC Block Load. Completion 100 is the FINISHED load, the opposite polarity
       from the wipes in this round, and the polarity AE's own control uses. */
    type: 'block-load',
    label: 'CC Block Load',
    params: [
      { key: 'completion', label: 'Completion', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'scans', label: 'Scans', type: 'number', min: 1, max: 8, precision: 0, default: 4 },
      { key: 'blockSize', label: 'Start Block Size', type: 'number', unit: 'px', min: 8, max: 512, precision: 0, default: 64 },
    ],
    css: () => '',
  },
  {
    /* CC Kernel -- the identity kernel is the default, so adding it is inert. */
    type: 'kernel',
    label: 'CC Kernel',
    params: [
      { key: 'k00', label: 'Kernel 00', type: 'number', min: -10, max: 10, precision: 2, default: 0, group: 'Kernel' },
      { key: 'k01', label: 'Kernel 01', type: 'number', min: -10, max: 10, precision: 2, default: 0, group: 'Kernel' },
      { key: 'k02', label: 'Kernel 02', type: 'number', min: -10, max: 10, precision: 2, default: 0, group: 'Kernel' },
      { key: 'k10', label: 'Kernel 10', type: 'number', min: -10, max: 10, precision: 2, default: 0, group: 'Kernel' },
      { key: 'k11', label: 'Kernel 11', type: 'number', min: -10, max: 10, precision: 2, default: 1, group: 'Kernel' },
      { key: 'k12', label: 'Kernel 12', type: 'number', min: -10, max: 10, precision: 2, default: 0, group: 'Kernel' },
      { key: 'k20', label: 'Kernel 20', type: 'number', min: -10, max: 10, precision: 2, default: 0, group: 'Kernel' },
      { key: 'k21', label: 'Kernel 21', type: 'number', min: -10, max: 10, precision: 2, default: 0, group: 'Kernel' },
      { key: 'k22', label: 'Kernel 22', type: 'number', min: -10, max: 10, precision: 2, default: 0, group: 'Kernel' },
      { key: 'divisor', label: 'Divisor', type: 'number', min: 0.01, max: 100, precision: 2, default: 1 },
      { key: 'offset', label: 'Offset', type: 'number', min: -255, max: 255, default: 0 },
    ],
    css: () => '',
  },
  {
    /*
      3D Glasses. AE's takes TWO source layers; this one synthesises the second
      eye by shifting the layer, which is what makes it usable on the ordinary
      footage people actually have. `swapLeftRight` therefore flips the sign of
      the convergence rather than exchanging two inputs.
    */
    type: '3d-glasses',
    label: '3D Glasses',
    params: [
      // Camera program D7 (AE parity): a Right View layer makes a true stereo
      // pair with this layer as the left eye; unset, the layer is shifted.
      { key: 'rightView', label: 'Right View', type: 'layer', default: '' },
      { key: 'convergenceOffset', label: 'Convergence Offset', type: 'number', unit: 'px', min: -100, max: 100, default: 8 },
      {
        key: 'view',
        label: '3D View',
        type: 'enum',
        default: 0,
        options: [
          { value: 0, label: 'Red Cyan LR' },
          { value: 1, label: 'Red Green LR' },
          { value: 2, label: 'Red Blue LR' },
          { value: 3, label: 'Balanced Colored Red Blue' },
          { value: 4, label: 'Stereo Pair' },
          { value: 5, label: 'Interlace Upper L Lower R' },
          { value: 6, label: 'Over Under' },
        ],
      },
      { key: 'balance', label: 'Balance', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'swapLeftRight', label: 'Swap Left-Right', type: 'checkbox', default: false },
    ],
    css: () => '',
  },
  {
    /* Fractal -- a GENERATOR: it replaces the pixels in the layer box rather
       than filtering them, the same contract Checkerboard holds. */
    type: 'fractal',
    label: 'Fractal',
    params: [
      {
        key: 'setType',
        label: 'Set Type',
        type: 'enum',
        default: 0,
        options: [
          { value: 0, label: 'Mandelbrot' },
          { value: 1, label: 'Julia' },
        ],
      },
      { key: 'centerX', label: 'Center X', type: 'number', min: -2, max: 2, precision: 4, default: -0.5 },
      { key: 'centerY', label: 'Center Y', type: 'number', min: -2, max: 2, precision: 4, default: 0 },
      { key: 'magnification', label: 'Magnification', type: 'number', min: 0.1, max: 100000, precision: 2, default: 1 },
      { key: 'iterations', label: 'Iterations', type: 'number', min: 1, max: 256, precision: 0, default: 64 },
      { key: 'juliaX', label: 'Julia Center X', type: 'number', min: -2, max: 2, precision: 4, default: -0.7, group: 'Julia' },
      { key: 'juliaY', label: 'Julia Center Y', type: 'number', min: -2, max: 2, precision: 4, default: 0.27, group: 'Julia' },
      { key: 'colorPhase', label: 'Color Phase', type: 'number', unit: '°', min: 0, max: 360, default: 0, group: 'Color' },
      { key: 'colorCycles', label: 'Color Cycles', type: 'number', min: 0.1, max: 20, precision: 1, default: 2, group: 'Color' },
      { key: 'insideColor', label: 'Inside Color', type: 'color', default: '#000000', group: 'Color' },
    ],
    css: () => '',
  },
  {
    /*
      CC Particle Systems II. The one round-seven member on the clock -- see
      `TIME_DEPENDENT`, and the module note in `aeRoundSevenSimulation.ts` for
      why the model is CLOSED FORM rather than integrated: a simulator would
      scrub differently from how it plays, and could not start an export at
      frame 400. `time` is resolved, not a control.
    */
    type: 'particle-systems',
    label: 'CC Particle Systems II',
    params: [
      { key: 'birthRate', label: 'Birth Rate', type: 'number', min: 0, max: 200, precision: 1, default: 20 },
      { key: 'longevity', label: 'Longevity', type: 'number', unit: 's', min: 0.1, max: 10, precision: 2, default: 1.5 },
      { key: 'producerX', label: 'Producer X', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0, group: 'Producer' },
      { key: 'producerY', label: 'Producer Y', type: 'number', unit: 'px', min: -4000, max: 4000, default: 0, group: 'Producer' },
      { key: 'producerRadiusX', label: 'Radius X', type: 'number', unit: 'px', min: 0, max: 2000, default: 0, group: 'Producer' },
      { key: 'producerRadiusY', label: 'Radius Y', type: 'number', unit: 'px', min: 0, max: 2000, default: 0, group: 'Producer' },
      {
        key: 'animation',
        label: 'Animation',
        type: 'enum',
        default: 0,
        options: [
          { value: 0, label: 'Explosive' },
          { value: 1, label: 'Direction Axis' },
          { value: 2, label: 'Fountain' },
        ],
        group: 'Physics',
      },
      { key: 'direction', label: 'Direction', type: 'number', unit: '°', min: -360, max: 360, default: 0, group: 'Physics' },
      { key: 'spread', label: 'Spread', type: 'number', unit: '°', min: 0, max: 360, default: 60, group: 'Physics' },
      { key: 'velocity', label: 'Velocity', type: 'number', unit: 'px/s', min: 0, max: 2000, default: 300, group: 'Physics' },
      { key: 'velocityVariation', label: 'Velocity Variation', type: 'number', unit: '%', min: 0, max: 100, default: 30, group: 'Physics' },
      { key: 'gravity', label: 'Gravity', type: 'number', min: -2000, max: 2000, default: 200, group: 'Physics' },
      { key: 'resistance', label: 'Resistance', type: 'number', min: 0, max: 10, precision: 2, default: 0, group: 'Physics' },
      { key: 'birthSize', label: 'Birth Size', type: 'number', unit: 'px', min: 0.5, max: 200, precision: 1, default: 8, group: 'Particle' },
      { key: 'deathSize', label: 'Death Size', type: 'number', unit: 'px', min: 0, max: 200, precision: 1, default: 2, group: 'Particle' },
      { key: 'sizeVariation', label: 'Size Variation', type: 'number', unit: '%', min: 0, max: 100, default: 25, group: 'Particle' },
      { key: 'birthColor', label: 'Birth Color', type: 'color', default: '#ffe27a', group: 'Particle' },
      { key: 'deathColor', label: 'Death Color', type: 'color', default: '#ff3b00', group: 'Particle' },
      { key: 'opacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 100, group: 'Particle' },
      {
        key: 'blend',
        label: 'Transfer Mode',
        type: 'enum',
        default: 0,
        options: [
          { value: 0, label: 'Add' },
          { value: 1, label: 'Normal' },
        ],
        group: 'Particle',
      },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 1, max: 10000, precision: 0, default: 1 },
      // RESOLVED from the clock -- see `TIME_DEPENDENT`. This is what makes the
      // emitter emit; it is not a control.
      { key: 'time', label: 'Time (resolved)', type: 'resolved', default: 0 },
    ],
    css: () => '',
  },
  {
    /* CC Bubbles -- keyframed on `evolution` like Snowfall, deliberately NOT on
       the clock: a wrapping field has no birth event to index. */
    type: 'cc-bubbles',
    label: 'CC Bubbles',
    params: [
      { key: 'bubbleAmount', label: 'Bubble Amount', type: 'number', min: 0, max: 500, precision: 0, default: 100 },
      { key: 'bubbleSpeed', label: 'Bubble Speed', type: 'number', unit: 'px', min: 0, max: 2000, default: 300 },
      { key: 'wobbleAmplitude', label: 'Wobble Amplitude', type: 'number', unit: 'px', min: 0, max: 100, default: 10 },
      { key: 'wobbleFrequency', label: 'Wobble Frequency', type: 'number', min: 0, max: 20, precision: 1, default: 2 },
      { key: 'bubbleSize', label: 'Bubble Size', type: 'number', unit: 'px', min: 1, max: 100, default: 12 },
      { key: 'sizeVariation', label: 'Size Variation', type: 'number', unit: '%', min: 0, max: 100, default: 40 },
      {
        key: 'shading',
        label: 'Shading Type',
        type: 'enum',
        default: 0,
        options: [
          { value: 0, label: 'Fade Inwards' },
          { value: 1, label: 'Fade Outwards' },
          { value: 2, label: 'Sphere' },
        ],
      },
      { key: 'color', label: 'Bubble Color', type: 'color', default: '#ffffff' },
      { key: 'opacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 80 },
      { key: 'evolution', label: 'Evolution', type: 'number', min: -36000, max: 36000, default: 0 },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 1, max: 10000, precision: 0, default: 1 },
    ],
    css: () => '',
  },
  // fx60:b9:begin
  {
    /* AE's Brightness & Contrast: a brightness curve through black and white and an S-curve contrast; Use Legacy is the old linear shift and scale. GPU only. */
    type: 'brightness-contrast',
    label: 'Brightness & Contrast',
    gpuOnly: true,
    params: [
      { key: 'brightness', label: 'Brightness', type: 'number', min: -150, max: 150, default: 0 },
      { key: 'contrast', label: 'Contrast', type: 'number', min: -100, max: 100, default: 0 },
      { key: 'useLegacy', label: 'Use Legacy', type: 'checkbox', default: false },
    ],
    css: () => '',
  },
  {
    /* AE's Color Balance (HLS): rotate the hue, lift or lower the lightness, scale the saturation. GPU only. */
    type: 'color-balance-hls',
    label: 'Color Balance (HLS)',
    gpuOnly: true,
    params: [
      { key: 'hue', label: 'Hue', type: 'number', unit: '°', min: -3600, max: 3600, default: 0 },
      { key: 'lightness', label: 'Lightness', type: 'number', min: -100, max: 100, default: 0 },
      { key: 'saturation', label: 'Saturation', type: 'number', min: -100, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    /* AE's Calculations: one channel of this layer (or all of it) blended with a channel of a second layer by a blending mode. GPU only. */
    type: 'calculations',
    label: 'Calculations',
    gpuOnly: true,
    params: [
      { key: 'inputChannel', label: 'Input Channel', type: 'enum', default: 0, options: [{ value: 0, label: 'RGBA' }, { value: 1, label: 'Gray' }, { value: 2, label: 'Red' }, { value: 3, label: 'Green' }, { value: 4, label: 'Blue' }, { value: 5, label: 'Alpha' }] },
      { key: 'invertInput', label: 'Invert Input', type: 'checkbox', default: false },
      { key: 'secondLayer', label: 'Second Layer', type: 'layer', default: '' },
      { key: 'secondChannel', label: 'Second Layer Channel', type: 'enum', default: 0, options: [{ value: 0, label: 'RGBA' }, { value: 1, label: 'Gray' }, { value: 2, label: 'Red' }, { value: 3, label: 'Green' }, { value: 4, label: 'Blue' }, { value: 5, label: 'Alpha' }] },
      { key: 'secondOpacity', label: 'Second Layer Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'invertSecond', label: 'Invert Second Layer', type: 'checkbox', default: false },
      { key: 'blendingMode', label: 'Blending Mode', type: 'enum', default: 0, options: [{ value: 0, label: 'Copy' }, { value: 1, label: 'Multiply' }, { value: 2, label: 'Screen' }, { value: 3, label: 'Overlay' }, { value: 4, label: 'Soft Light' }, { value: 5, label: 'Hard Light' }, { value: 6, label: 'Add' }, { value: 7, label: 'Subtract' }, { value: 8, label: 'Difference' }, { value: 9, label: 'Darken' }, { value: 10, label: 'Lighten' }, { value: 11, label: 'Color Dodge' }, { value: 12, label: 'Color Burn' }, { value: 13, label: 'Exclusion' }] },
      { key: 'preserveTransparency', label: 'Preserve Transparency', type: 'checkbox', default: false },
    ],
    css: () => '',
  },
  {
    /* AE's Set Channels: each output channel taken from a channel (or luminance, hue, lightness, saturation) of the source layer. GPU only. */
    type: 'set-channels',
    label: 'Set Channels',
    gpuOnly: true,
    params: [
      { key: 'sourceLayer', label: 'Source Layer', type: 'layer', default: '' },
      { key: 'setRed', label: 'Set Red To', type: 'enum', default: 0, options: [{ value: 0, label: 'Red' }, { value: 1, label: 'Green' }, { value: 2, label: 'Blue' }, { value: 3, label: 'Alpha' }, { value: 4, label: 'Luminance' }, { value: 5, label: 'Hue' }, { value: 6, label: 'Lightness' }, { value: 7, label: 'Saturation' }, { value: 8, label: 'Full' }, { value: 9, label: 'Off' }] },
      { key: 'setGreen', label: 'Set Green To', type: 'enum', default: 1, options: [{ value: 0, label: 'Red' }, { value: 1, label: 'Green' }, { value: 2, label: 'Blue' }, { value: 3, label: 'Alpha' }, { value: 4, label: 'Luminance' }, { value: 5, label: 'Hue' }, { value: 6, label: 'Lightness' }, { value: 7, label: 'Saturation' }, { value: 8, label: 'Full' }, { value: 9, label: 'Off' }] },
      { key: 'setBlue', label: 'Set Blue To', type: 'enum', default: 2, options: [{ value: 0, label: 'Red' }, { value: 1, label: 'Green' }, { value: 2, label: 'Blue' }, { value: 3, label: 'Alpha' }, { value: 4, label: 'Luminance' }, { value: 5, label: 'Hue' }, { value: 6, label: 'Lightness' }, { value: 7, label: 'Saturation' }, { value: 8, label: 'Full' }, { value: 9, label: 'Off' }] },
      { key: 'setAlpha', label: 'Set Alpha To', type: 'enum', default: 3, options: [{ value: 0, label: 'Red' }, { value: 1, label: 'Green' }, { value: 2, label: 'Blue' }, { value: 3, label: 'Alpha' }, { value: 4, label: 'Luminance' }, { value: 5, label: 'Hue' }, { value: 6, label: 'Lightness' }, { value: 7, label: 'Saturation' }, { value: 8, label: 'Full' }, { value: 9, label: 'Off' }] },
    ],
    css: () => '',
  },
  {
    /* AE's Blend: crossfade with another layer, or take only its colour, its tint, or its darker / lighter pixels. GPU only. */
    type: 'blend',
    label: 'Blend',
    gpuOnly: true,
    params: [
      { key: 'blendLayer', label: 'Blend With Layer', type: 'layer', default: '' },
      { key: 'mode', label: 'Mode', type: 'enum', default: 0, options: [{ value: 0, label: 'Crossfade' }, { value: 1, label: 'Color Only' }, { value: 2, label: 'Tint Only' }, { value: 3, label: 'Darken Only' }, { value: 4, label: 'Lighten Only' }] },
      { key: 'blendWithOriginal', label: 'Blend With Original', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    /* AE's Difference Matte: pixels that match the difference layer (a clean plate) become transparent. GPU only. */
    type: 'difference-matte',
    label: 'Difference Matte',
    gpuOnly: true,
    params: [
      { key: 'view', label: 'View', type: 'enum', default: 0, options: [{ value: 0, label: 'Final Output' }, { value: 1, label: 'Matte Only' }] },
      { key: 'differenceLayer', label: 'Difference Layer', type: 'layer', default: '' },
      { key: 'tolerance', label: 'Matching Tolerance', type: 'number', unit: '%', min: 0, max: 100, default: 15 },
      { key: 'softness', label: 'Matching Softness', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    /* CC Color Neutralizer: the colour casts picked for the shadows, midtones and highlights are taken out of their tonal ranges. GPU only. */
    type: 'color-neutralizer',
    label: 'CC Color Neutralizer',
    gpuOnly: true,
    params: [
      { key: 'shadowsUnbalance', label: 'Shadows Unbalance', type: 'color', default: '#000000' },
      { key: 'midtonesUnbalance', label: 'Midtones Unbalance', type: 'color', default: '#808080' },
      { key: 'highlightsUnbalance', label: 'Highlights Unbalance', type: 'color', default: '#ffffff' },
      { key: 'blend', label: 'Blend w. Original', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    /* CC Blobbylize: the softened layer becomes a lit, glossy blob surface, cut away below a height. GPU only. */
    type: 'blobbylize',
    label: 'CC Blobbylize',
    gpuOnly: true,
    params: [
      // Stream D L6: AE's Blob Layer — another layer's softened alpha is the blob surface.
      { key: 'blobLayerId', label: 'Blob Layer', type: 'layer', noneLabel: 'None (this layer)', default: '' },
      { key: 'softness', label: 'Softness', type: 'number', unit: 'px', min: 0, max: 400, default: 20 },
      { key: 'cutAway', label: 'Cut Away', type: 'number', unit: '%', min: 0, max: 100, default: 40 },
      { key: 'lightIntensity', label: 'Light Intensity', type: 'number', unit: '%', min: 0, max: 400, default: 100 },
      { key: 'lightColor', label: 'Light Color', type: 'color', default: '#ffffff' },
      { key: 'lightDirection', label: 'Light Direction', type: 'number', unit: '°', min: -3600, max: 3600, default: 315 },
      { key: 'ambient', label: 'Ambient', type: 'number', unit: '%', min: 0, max: 100, default: 40 },
      { key: 'specular', label: 'Specular', type: 'number', unit: '%', min: 0, max: 300, default: 60 },
    ],
    css: () => '',
  },
  {
    /* CC Split 2: the layer splits open along the line from Point A to Point B, each side by its own amount. GPU only. */
    type: 'cc-split-2',
    label: 'CC Split 2',
    gpuOnly: true,
    params: [
      { key: 'pointAX', label: 'Point A X', type: 'number', unit: 'px', min: -10000, max: 10000, default: -200 },
      { key: 'pointAY', label: 'Point A Y', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'pointBX', label: 'Point B X', type: 'number', unit: 'px', min: -10000, max: 10000, default: 200 },
      { key: 'pointBY', label: 'Point B Y', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'split1', label: 'Split 1', type: 'number', unit: 'px', min: 0, max: 4000, default: 50 },
      { key: 'split2', label: 'Split 2', type: 'number', unit: 'px', min: 0, max: 4000, default: 50 },
    ],
    css: () => '',
  },
  {
    /* AE's Eyedropper Fill: the layer filled with the colour sampled (and averaged) around a point. GPU only. */
    type: 'eyedropper-fill',
    label: 'Eyedropper Fill',
    gpuOnly: true,
    params: [
      { key: 'sampleX', label: 'Sample Point X', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'sampleY', label: 'Sample Point Y', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'sampleRadius', label: 'Sample Radius', type: 'number', unit: 'px', min: 0, max: 1000, default: 0 },
      { key: 'average', label: 'Average Pixel Colors', type: 'enum', default: 0, options: [{ value: 0, label: 'Skip Empty' }, { value: 1, label: 'All' }, { value: 2, label: 'All Premultiplied' }] },
      { key: 'maintainAlpha', label: 'Maintain Original Alpha', type: 'checkbox', default: true },
      { key: 'blend', label: 'Blend With Original', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    /* AE's Noise HLS Auto: hue, lightness and saturation noise that animates by itself at the Noise Animation Speed. GPU only. */
    type: 'noise-hls-auto',
    label: 'Noise HLS Auto',
    gpuOnly: true,
    params: [
      { key: 'noise', label: 'Noise', type: 'enum', default: 0, options: [{ value: 0, label: 'Uniform' }, { value: 1, label: 'Squared' }, { value: 2, label: 'Grain' }] },
      { key: 'hue', label: 'Hue', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'lightness', label: 'Lightness', type: 'number', unit: '%', min: 0, max: 100, default: 20 },
      { key: 'saturation', label: 'Saturation', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'grainSize', label: 'Grain Size', type: 'number', unit: 'px', min: 1, max: 100, default: 1 },
      { key: 'speed', label: 'Noise Animation Speed', type: 'number', min: 0, max: 100, default: 10 },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 9999, precision: 0, default: 1 },
      { key: 'followCompTime', label: 'Animate With Time', type: 'checkbox', default: true },
      { key: 'time', label: 'Time', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
    ],
    css: () => '',
  },
  {
    /* AE's Caustics: the layer seen as the bottom of moving water, refracted, under a bright caustic light web. GPU only. */
    type: 'caustics',
    label: 'Caustics',
    gpuOnly: true,
    params: [
      // Stream D L6: AE's Bottom and Water layers (the layer itself when unset).
      { key: 'bottomLayerId', label: 'Bottom', type: 'layer', group: 'Bottom', noneLabel: 'None (this layer)', default: '' },
      { key: 'waterLayerId', label: 'Water Surface', type: 'layer', group: 'Water', noneLabel: 'None (waves only)', default: '' },
      { key: 'waterGain', label: 'Surface Height', type: 'number', group: 'Water', unit: '%', min: 0, max: 400, default: 100 },
      { key: 'scale', label: 'Wave Scale', type: 'number', unit: 'px', min: 10, max: 4000, default: 160 },
      { key: 'distortion', label: 'Surface Distortion', type: 'number', unit: '%', min: 0, max: 300, default: 30 },
      { key: 'intensity', label: 'Light Intensity', type: 'number', unit: '%', min: 0, max: 400, default: 100 },
      { key: 'lightColor', label: 'Light Color', type: 'color', default: '#e2f6ff' },
      { key: 'strength', label: 'Caustics Strength', type: 'number', unit: '%', min: 0, max: 300, default: 60 },
      { key: 'ambient', label: 'Ambient Light', type: 'number', unit: '%', min: 0, max: 200, default: 70 },
      { key: 'speed', label: 'Wave Speed', type: 'number', min: 0, max: 20, default: 0.5 },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 9999, precision: 0, default: 1 },
      { key: 'followCompTime', label: 'Animate With Time', type: 'checkbox', default: true },
      { key: 'time', label: 'Time', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
    ],
    css: () => '',
  },
  {
    /* AE's Shatter: the layer breaks into glass shards, bricks or squares that a force throws outward and gravity pulls down, from the Shatter Time on. GPU only. */
    type: 'shatter',
    label: 'Shatter',
    gpuOnly: true,
    params: [
      { key: 'pattern', label: 'Pattern', type: 'enum', default: 0, options: [{ value: 0, label: 'Glass' }, { value: 1, label: 'Bricks' }, { value: 2, label: 'Squares' }] },
      { key: 'pieceSize', label: 'Piece Size', type: 'number', unit: 'px', min: 4, max: 2000, default: 48 },
      { key: 'forceX', label: 'Force Position X', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'forceY', label: 'Force Position Y', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'forceRadius', label: 'Force Radius', type: 'number', unit: 'px', min: 1, max: 20000, default: 400 },
      { key: 'forceStrength', label: 'Force Strength', type: 'number', min: 0, max: 60, default: 6 },
      { key: 'gravity', label: 'Gravity', type: 'number', min: 0, max: 60, default: 4 },
      { key: 'gravityDirection', label: 'Gravity Direction', type: 'number', unit: '°', min: -3600, max: 3600, default: 180 },
      { key: 'rotationSpeed', label: 'Rotation Speed', type: 'number', min: 0, max: 20, default: 1 },
      { key: 'randomness', label: 'Randomness', type: 'number', unit: '%', min: 0, max: 100, default: 30 },
      { key: 'startTime', label: 'Shatter Time', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 9999, precision: 0, default: 1 },
      { key: 'followCompTime', label: 'Animate With Time', type: 'checkbox', default: true },
      { key: 'time', label: 'Time', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
    ],
    css: () => '',
  },
  {
    /* AE's Wave World: rings of waves spreading from one or two producers, rendered as a height map (for Displacement Map, Caustics) or shaded. GPU only. */
    type: 'wave-world',
    label: 'Wave World',
    gpuOnly: true,
    params: [
      { key: 'view', label: 'View', type: 'enum', default: 0, options: [{ value: 0, label: 'Height Map' }, { value: 1, label: 'Shaded' }] },
      { key: 'producer1X', label: 'Producer 1 X', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'producer1Y', label: 'Producer 1 Y', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'producer2', label: 'Producer 2', type: 'checkbox', default: false },
      { key: 'producer2X', label: 'Producer 2 X', type: 'number', unit: 'px', min: -10000, max: 10000, default: 200 },
      { key: 'producer2Y', label: 'Producer 2 Y', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'speed', label: 'Wave Speed', type: 'number', unit: 'px/s', min: 0, max: 10000, default: 300 },
      { key: 'wavelength', label: 'Wavelength', type: 'number', unit: 'px', min: 4, max: 4000, default: 80 },
      { key: 'amplitude', label: 'Amplitude', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'damping', label: 'Damping', type: 'number', unit: '%', min: 0, max: 100, default: 30 },
      { key: 'followCompTime', label: 'Animate With Time', type: 'checkbox', default: true },
      { key: 'time', label: 'Time', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
    ],
    css: () => '',
  },
  {
    /* CC WarpoMatic: the layer warps along its own (smoothed) brightness and dissolves bright parts first as Completion rises. GPU only. */
    type: 'warpomatic',
    label: 'CC WarpoMatic',
    gpuOnly: true,
    params: [
      { key: 'completion', label: 'Completion', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'smoothness', label: 'Smoothness', type: 'number', unit: 'px', min: 0, max: 400, default: 10 },
      { key: 'warpAmount', label: 'Warp Amount', type: 'number', unit: 'px', min: 0, max: 4000, default: 150 },
      { key: 'warpDirection', label: 'Warp Direction', type: 'enum', default: 0, options: [{ value: 0, label: 'Joint' }, { value: 1, label: 'Opposing' }, { value: 2, label: 'Twisting' }] },
      { key: 'blendSpan', label: 'Blend Span', type: 'number', unit: '%', min: 0, max: 100, default: 20 },
    ],
    css: () => '',
  },
  {
    /* CC Overbrights: shows the pixels whose values lie above 1 (or below 0) in a clip colour, to find out-of-range light in float work. GPU only. */
    type: 'overbrights',
    label: 'CC Overbrights',
    gpuOnly: true,
    params: [
      { key: 'channel', label: 'Channel', type: 'enum', default: 0, options: [{ value: 0, label: 'RGB' }, { value: 1, label: 'Red' }, { value: 2, label: 'Green' }, { value: 3, label: 'Blue' }, { value: 4, label: 'Alpha' }, { value: 5, label: 'Luminance' }] },
      { key: 'show', label: 'Show', type: 'enum', default: 0, options: [{ value: 0, label: 'Overbrights' }, { value: 1, label: 'Underdarks' }, { value: 2, label: 'Both' }] },
      { key: 'clipColor', label: 'Clip Color', type: 'color', default: '#ff00ff' },
      { key: 'dim', label: 'Dim Other Pixels', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    /* AE's HDR Compander: compress a float image's range by a gain and gamma (to run an 8-bit effect on it), or expand it back. GPU only. */
    type: 'hdr-compander',
    label: 'HDR Compander',
    gpuOnly: true,
    params: [
      { key: 'mode', label: 'Compander', type: 'enum', default: 0, options: [{ value: 0, label: 'Compress Range' }, { value: 1, label: 'Expand Range' }] },
      { key: 'gain', label: 'Gain', type: 'number', min: 1, max: 100, default: 1 },
      { key: 'gamma', label: 'Gamma', type: 'number', min: 0.1, max: 10, default: 1 },
    ],
    css: () => '',
  },
  {
    /* AE's HDR Highlight Compression: values above the knee roll off smoothly toward 1, keeping their hue. GPU only. */
    type: 'hdr-highlight-compression',
    label: 'HDR Highlight Compression',
    gpuOnly: true,
    params: [
      { key: 'amount', label: 'Amount', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
    ],
    css: () => '',
  },
  {
    /* AE's Reduce Interlace Flicker: a vertical soften that calms thin horizontal lines on interlaced displays. GPU only. */
    type: 'reduce-interlace-flicker',
    label: 'Reduce Interlace Flicker',
    gpuOnly: true,
    params: [
      { key: 'softness', label: 'Softness', type: 'number', unit: 'px', min: 0, max: 20, default: 1 },
    ],
    css: () => '',
  },
  {
    /* AE's Basic 3D: swivel and tilt the layer in perspective about its centre and push it back, with an optional specular highlight. GPU only. */
    type: 'basic-3d',
    label: 'Basic 3D',
    gpuOnly: true,
    params: [
      { key: 'swivel', label: 'Swivel', type: 'number', unit: '°', min: -3600, max: 3600, default: 0 },
      { key: 'tilt', label: 'Tilt', type: 'number', unit: '°', min: -3600, max: 3600, default: 0 },
      { key: 'distance', label: 'Distance to Image', type: 'number', unit: 'px', min: -5000, max: 20000, default: 0 },
      { key: 'specular', label: 'Specular Highlight', type: 'checkbox', default: false },
    ],
    css: () => '',
  },
  {
    /* AE's VR Digital Glitch, for any layer: torn bands, jumping blocks, RGB split, colour corruption, scan lines and noise, re-rolled at the Glitch Rate. GPU only. */
    type: 'digital-glitch',
    label: 'Digital Glitch',
    gpuOnly: true,
    params: [
      { key: 'amount', label: 'Master Amplitude', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'blockSize', label: 'Block Size', type: 'number', unit: 'px', min: 2, max: 2000, default: 40 },
      { key: 'rgbSplit', label: 'RGB Split', type: 'number', unit: 'px', min: 0, max: 1000, default: 12 },
      { key: 'scanlines', label: 'Scan Lines', type: 'number', unit: '%', min: 0, max: 100, default: 20 },
      { key: 'noise', label: 'Noise', type: 'number', unit: '%', min: 0, max: 100, default: 15 },
      { key: 'corruption', label: 'Color Corruption', type: 'number', unit: '%', min: 0, max: 100, default: 20 },
      { key: 'speed', label: 'Glitch Rate', type: 'number', unit: 'Hz', min: 0, max: 60, default: 12 },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 9999, precision: 0, default: 1 },
      { key: 'followCompTime', label: 'Animate With Time', type: 'checkbox', default: true },
      { key: 'time', label: 'Time', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
    ],
    css: () => '',
  },
  {
    /* AE's VR Rotate Sphere: turn an equirectangular (360) image about its tilt, pan and roll axes. GPU only. */
    type: 'vr-rotate-sphere',
    label: 'VR Rotate Sphere',
    gpuOnly: true,
    params: [
      { key: 'tilt', label: 'Tilt (X Axis)', type: 'number', unit: '°', min: -3600, max: 3600, default: 0 },
      { key: 'pan', label: 'Pan (Y Axis)', type: 'number', unit: '°', min: -3600, max: 3600, default: 0 },
      { key: 'roll', label: 'Roll (Z Axis)', type: 'number', unit: '°', min: -3600, max: 3600, default: 0 },
    ],
    css: () => '',
  },
  {
    /* AE's VR Color Gradients, for any layer: a smooth field blended between up to five coloured points (a mesh-gradient look). GPU only. */
    type: 'color-gradients',
    label: 'Color Gradients',
    gpuOnly: true,
    params: [
      { key: 'points', label: 'Points', type: 'number', min: 2, max: 5, precision: 0, default: 4 },
      { key: 'falloff', label: 'Falloff', type: 'number', min: 0.5, max: 10, default: 2 },
      { key: 'blend', label: 'Blend With Original', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'point1X', label: 'Point 1 X', type: 'number', unit: 'px', min: -10000, max: 10000, default: -400 },
      { key: 'point1Y', label: 'Point 1 Y', type: 'number', unit: 'px', min: -10000, max: 10000, default: -250 },
      { key: 'color1', label: 'Color 1', type: 'color', default: '#ff4d6d' },
      { key: 'point2X', label: 'Point 2 X', type: 'number', unit: 'px', min: -10000, max: 10000, default: 400 },
      { key: 'point2Y', label: 'Point 2 Y', type: 'number', unit: 'px', min: -10000, max: 10000, default: -250 },
      { key: 'color2', label: 'Color 2', type: 'color', default: '#ffd166' },
      { key: 'point3X', label: 'Point 3 X', type: 'number', unit: 'px', min: -10000, max: 10000, default: -400 },
      { key: 'point3Y', label: 'Point 3 Y', type: 'number', unit: 'px', min: -10000, max: 10000, default: 250 },
      { key: 'color3', label: 'Color 3', type: 'color', default: '#06d6a0' },
      { key: 'point4X', label: 'Point 4 X', type: 'number', unit: 'px', min: -10000, max: 10000, default: 400 },
      { key: 'point4Y', label: 'Point 4 Y', type: 'number', unit: 'px', min: -10000, max: 10000, default: 250 },
      { key: 'color4', label: 'Color 4', type: 'color', default: '#118ab2' },
      { key: 'point5X', label: 'Point 5 X', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'point5Y', label: 'Point 5 Y', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'color5', label: 'Color 5', type: 'color', default: '#9b5de5' },
    ],
    css: () => '',
  },
  {
    /* A worn VHS tape: chroma smeared sideways, line jitter, a rolling tracking band with white streaks, noise and scan lines. GPU only. */
    type: 'vhs',
    label: 'VHS',
    gpuOnly: true,
    params: [
      { key: 'amount', label: 'Amount', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'chromaBleed', label: 'Chroma Bleed', type: 'number', unit: 'px', min: 0, max: 200, default: 6 },
      { key: 'tracking', label: 'Tracking Noise', type: 'number', unit: '%', min: 0, max: 100, default: 35 },
      { key: 'jitter', label: 'Line Jitter', type: 'number', unit: 'px', min: 0, max: 80, default: 1.5 },
      { key: 'noise', label: 'Noise', type: 'number', unit: '%', min: 0, max: 100, default: 25 },
      { key: 'scanlines', label: 'Scan Lines', type: 'number', unit: '%', min: 0, max: 100, default: 20 },
      { key: 'saturation', label: 'Saturation', type: 'number', unit: '%', min: 0, max: 200, default: 85 },
      { key: 'softness', label: 'Softness', type: 'number', unit: 'px', min: 0, max: 40, default: 1.5 },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 9999, precision: 0, default: 1 },
      { key: 'followCompTime', label: 'Animate With Time', type: 'checkbox', default: true },
      { key: 'time', label: 'Time', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
    ],
    css: () => '',
  },
  {
    /* An old tube monitor: a curved screen, scan lines, an aperture-grille or shadow-mask phosphor pattern, glow and vignette. GPU only. */
    type: 'crt',
    label: 'CRT',
    gpuOnly: true,
    params: [
      { key: 'curvature', label: 'Curvature', type: 'number', unit: '%', min: 0, max: 100, default: 25 },
      { key: 'scanlines', label: 'Scan Lines', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'lineSize', label: 'Scan Line Size', type: 'number', unit: 'px', min: 1, max: 80, default: 3 },
      { key: 'mask', label: 'Phosphor Mask', type: 'enum', default: 0, options: [{ value: 0, label: 'Aperture Grille' }, { value: 1, label: 'Shadow Mask' }, { value: 2, label: 'None' }] },
      { key: 'maskStrength', label: 'Mask Strength', type: 'number', unit: '%', min: 0, max: 100, default: 35 },
      { key: 'glow', label: 'Glow', type: 'number', unit: '%', min: 0, max: 200, default: 25 },
      { key: 'vignette', label: 'Vignette', type: 'number', unit: '%', min: 0, max: 100, default: 40 },
      { key: 'brightness', label: 'Brightness', type: 'number', unit: '%', min: 50, max: 300, default: 120 },
      { key: 'convergence', label: 'Convergence', type: 'number', unit: 'px', min: 0, max: 40, default: 1 },
    ],
    css: () => '',
  },
  {
    /* Pixel sorting: runs of pixels whose brightness lies in the threshold range are sorted along a direction into streaks. GPU only. */
    type: 'pixel-sort',
    label: 'Pixel Sort',
    gpuOnly: true,
    params: [
      { key: 'direction', label: 'Direction', type: 'number', unit: '°', min: -3600, max: 3600, default: 90 },
      { key: 'thresholdLow', label: 'Threshold Low', type: 'number', unit: '%', min: 0, max: 100, default: 25 },
      { key: 'thresholdHigh', label: 'Threshold High', type: 'number', unit: '%', min: 0, max: 100, default: 80 },
      { key: 'maxLength', label: 'Max Length', type: 'number', unit: 'px', min: 4, max: 8000, default: 400 },
      { key: 'order', label: 'Order', type: 'enum', default: 0, options: [{ value: 0, label: 'Ascending' }, { value: 1, label: 'Descending' }] },
      { key: 'sortBy', label: 'Sort By', type: 'enum', default: 0, options: [{ value: 0, label: 'Brightness' }, { value: 1, label: 'Hue' }, { value: 2, label: 'Saturation' }] },
      { key: 'invertRange', label: 'Invert Range', type: 'checkbox', default: false },
    ],
    css: () => '',
  },
  {
    /* The flat-design long shadow: the layer's silhouette cast far in one direction, fading along its length. GPU only. */
    type: 'long-shadow',
    label: 'Long Shadow',
    gpuOnly: true,
    params: [
      { key: 'angle', label: 'Direction', type: 'number', unit: '°', min: -3600, max: 3600, default: 45 },
      { key: 'length', label: 'Length', type: 'number', unit: 'px', min: 0, max: 10000, default: 300 },
      { key: 'color', label: 'Color', type: 'color', default: '#000000' },
      { key: 'shadowOpacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 60 },
      { key: 'fade', label: 'Fade', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'shadowOnly', label: 'Shadow Only', type: 'checkbox', default: false },
    ],
    css: () => '',
  },
  {
    /* Film halation: a warm red-orange halo bleeding out from the bright parts of the picture. GPU only. */
    type: 'halation',
    label: 'Halation',
    gpuOnly: true,
    params: [
      { key: 'threshold', label: 'Threshold', type: 'number', unit: '%', min: 0, max: 100, default: 55 },
      { key: 'radius', label: 'Radius', type: 'number', unit: 'px', min: 0, max: 800, default: 18 },
      { key: 'amount', label: 'Amount', type: 'number', unit: '%', min: 0, max: 500, default: 100 },
      { key: 'tint', label: 'Halation Color', type: 'color', default: '#ff3b1f' },
    ],
    css: () => '',
  },
  {
    /* Drifting film light leaks: soft warm blooms pouring in from the frame's edges, screened (or added) over the layer. GPU only. */
    type: 'light-leaks',
    label: 'Light Leaks',
    gpuOnly: true,
    params: [
      { key: 'intensity', label: 'Intensity', type: 'number', unit: '%', min: 0, max: 300, default: 80 },
      { key: 'color1', label: 'Color 1', type: 'color', default: '#ff6a00' },
      { key: 'color2', label: 'Color 2', type: 'color', default: '#ff2d7a' },
      { key: 'color3', label: 'Color 3', type: 'color', default: '#ffd36b' },
      { key: 'scale', label: 'Scale', type: 'number', unit: '%', min: 10, max: 500, default: 100 },
      { key: 'speed', label: 'Speed', type: 'number', min: 0, max: 10, default: 1 },
      { key: 'mode', label: 'Blend Mode', type: 'enum', default: 0, options: [{ value: 0, label: 'Screen' }, { value: 1, label: 'Add' }, { value: 2, label: 'Overlay' }, { value: 3, label: 'Leak Only' }] },
      { key: 'evolution', label: 'Evolution', type: 'number', unit: '°', min: -3600, max: 3600, default: 0 },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 9999, precision: 0, default: 1 },
      { key: 'followCompTime', label: 'Animate With Time', type: 'checkbox', default: true },
      { key: 'time', label: 'Time', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
    ],
    css: () => '',
  },
  {
    /* The miniature look: a sharp band of focus with lens blur growing above and below it, and a saturation lift. GPU only. */
    type: 'tilt-shift',
    label: 'Tilt-Shift',
    gpuOnly: true,
    params: [
      { key: 'focusPosition', label: 'Focus Position', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'focusAngle', label: 'Focus Angle', type: 'number', unit: '°', min: -3600, max: 3600, default: 0 },
      { key: 'focusWidth', label: 'Focus Width', type: 'number', unit: 'px', min: 0, max: 20000, default: 120 },
      { key: 'transition', label: 'Transition', type: 'number', unit: 'px', min: 1, max: 20000, default: 300 },
      { key: 'blurRadius', label: 'Blur Radius', type: 'number', unit: 'px', min: 0, max: 400, default: 16 },
      { key: 'saturation', label: 'Saturation', type: 'number', unit: '%', min: 0, max: 200, default: 115 },
    ],
    css: () => '',
  },
  {
    /* Photoshop's Gradient Map: the picture's brightness mapped onto a four-colour gradient. GPU only. */
    type: 'gradient-map',
    label: 'Gradient Map',
    gpuOnly: true,
    params: [
      { key: 'color1', label: 'Shadows', type: 'color', default: '#1a1033' },
      { key: 'color2', label: 'Color 2', type: 'color', default: '#7b2cbf' },
      { key: 'position2', label: 'Color 2 Position', type: 'number', unit: '%', min: 0, max: 100, default: 35 },
      { key: 'color3', label: 'Color 3', type: 'color', default: '#ff7a59' },
      { key: 'position3', label: 'Color 3 Position', type: 'number', unit: '%', min: 0, max: 100, default: 70 },
      { key: 'color4', label: 'Highlights', type: 'color', default: '#ffe8b0' },
      { key: 'reverse', label: 'Reverse', type: 'checkbox', default: false },
      { key: 'blend', label: 'Blend With Original', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    /* Duotone: the picture rebuilt from two inks, one for the shadows and one for the highlights. GPU only. */
    type: 'duotone',
    label: 'Duotone',
    gpuOnly: true,
    params: [
      { key: 'shadows', label: 'Shadows', type: 'color', default: '#1b1464' },
      { key: 'highlights', label: 'Highlights', type: 'color', default: '#ff5f6d' },
      { key: 'contrast', label: 'Contrast', type: 'number', unit: '%', min: 0, max: 300, default: 100 },
      { key: 'blend', label: 'Blend With Original', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    /* The Orton / dreamy glow: a blurred, brightened copy of the picture screened or soft-lit over it. GPU only. */
    type: 'soft-glow',
    label: 'Soft Glow',
    gpuOnly: true,
    params: [
      { key: 'radius', label: 'Radius', type: 'number', unit: 'px', min: 0, max: 800, default: 30 },
      { key: 'amount', label: 'Glow Amount', type: 'number', unit: '%', min: 0, max: 200, default: 60 },
      { key: 'brightness', label: 'Brightness', type: 'number', unit: '%', min: -100, max: 100, default: 10 },
      { key: 'saturation', label: 'Saturation', type: 'number', unit: '%', min: 0, max: 200, default: 100 },
      { key: 'mode', label: 'Blend Mode', type: 'enum', default: 0, options: [{ value: 0, label: 'Screen' }, { value: 1, label: 'Soft Light' }, { value: 2, label: 'Overlay' }, { value: 3, label: 'Lighten' }] },
    ],
    css: () => '',
  },
  {
    /* A neon tube traced along the layer's edges: a hot core line inside a coloured glow. GPU only. */
    type: 'neon',
    label: 'Neon Glow',
    gpuOnly: true,
    params: [
      { key: 'color', label: 'Glow Color', type: 'color', default: '#29e3ff' },
      { key: 'coreColor', label: 'Core Color', type: 'color', default: '#ffffff' },
      { key: 'tubeWidth', label: 'Tube Width', type: 'number', unit: 'px', min: 0.5, max: 120, default: 3 },
      { key: 'glowRadius', label: 'Glow Radius', type: 'number', unit: 'px', min: 0, max: 800, default: 18 },
      { key: 'intensity', label: 'Intensity', type: 'number', unit: '%', min: 0, max: 500, default: 150 },
      { key: 'fill', label: 'Original Fill', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    /* A sci-fi hologram: the layer tinted to one colour, moving scan lines, flicker, band glitches, colour fringes and an edge glow. GPU only. */
    type: 'hologram',
    label: 'Hologram',
    gpuOnly: true,
    params: [
      { key: 'color', label: 'Color', type: 'color', default: '#3df2ff' },
      { key: 'lines', label: 'Scan Lines', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'lineSize', label: 'Line Size', type: 'number', unit: 'px', min: 1, max: 200, default: 4 },
      { key: 'flicker', label: 'Flicker', type: 'number', unit: '%', min: 0, max: 100, default: 25 },
      { key: 'glitch', label: 'Glitch', type: 'number', unit: '%', min: 0, max: 100, default: 20 },
      { key: 'chromatic', label: 'Chromatic Offset', type: 'number', unit: 'px', min: 0, max: 200, default: 4 },
      { key: 'hologramOpacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 85 },
      { key: 'edge', label: 'Edge Glow', type: 'number', unit: '%', min: 0, max: 300, default: 60 },
      { key: 'speed', label: 'Speed', type: 'number', min: 0, max: 20, default: 1 },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 9999, precision: 0, default: 1 },
      { key: 'followCompTime', label: 'Animate With Time', type: 'checkbox', default: true },
      { key: 'time', label: 'Time', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
    ],
    css: () => '',
  },
  {
    /* Retro ordered dithering: the picture quantised to a few levels through a Bayer or noise threshold, optionally in two colours. GPU only. */
    type: 'dither',
    label: 'Dither',
    gpuOnly: true,
    params: [
      { key: 'method', label: 'Method', type: 'enum', default: 0, options: [{ value: 0, label: 'Bayer 4x4' }, { value: 1, label: 'Bayer 8x8' }, { value: 2, label: 'Noise' }] },
      { key: 'levels', label: 'Levels', type: 'number', min: 2, max: 32, precision: 0, default: 2 },
      { key: 'pixelSize', label: 'Pixel Size', type: 'number', unit: 'px', min: 1, max: 128, default: 2 },
      { key: 'palette', label: 'Palette', type: 'enum', default: 0, options: [{ value: 0, label: 'Original Colors' }, { value: 1, label: 'Monochrome' }, { value: 2, label: 'Two Colors' }] },
      { key: 'color1', label: 'Dark Color', type: 'color', default: '#0d1117' },
      { key: 'color2', label: 'Light Color', type: 'color', default: '#e6edf3' },
    ],
    css: () => '',
  },
  {
    /* ASCII art: each cell of the picture drawn as a character whose density follows its brightness. GPU only. */
    type: 'ascii',
    label: 'ASCII',
    gpuOnly: true,
    params: [
      { key: 'cellSize', label: 'Character Size', type: 'number', unit: 'px', min: 4, max: 256, default: 10 },
      { key: 'colorMode', label: 'Color', type: 'enum', default: 0, options: [{ value: 0, label: 'Original Colors' }, { value: 1, label: 'Text Color' }, { value: 2, label: 'Green Terminal' }] },
      { key: 'textColor', label: 'Text Color', type: 'color', default: '#ffffff' },
      { key: 'background', label: 'Background', type: 'color', default: '#000000' },
      { key: 'backgroundOpacity', label: 'Background Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'brightness', label: 'Brightness', type: 'number', unit: '%', min: 10, max: 300, default: 100 },
    ],
    css: () => '',
  },
  {
    /* A dot-matrix LED board: each cell of the picture lit as one round or square LED with a soft glow. GPU only. */
    type: 'led-screen',
    label: 'LED Screen',
    gpuOnly: true,
    params: [
      { key: 'pitch', label: 'Dot Pitch', type: 'number', unit: 'px', min: 3, max: 256, default: 10 },
      { key: 'shape', label: 'Dot Shape', type: 'enum', default: 0, options: [{ value: 0, label: 'Round' }, { value: 1, label: 'Square' }] },
      { key: 'gap', label: 'Gap', type: 'number', unit: '%', min: 0, max: 90, default: 25 },
      { key: 'glow', label: 'Glow', type: 'number', unit: '%', min: 0, max: 200, default: 50 },
      { key: 'brightness', label: 'Brightness', type: 'number', unit: '%', min: 50, max: 400, default: 110 },
      { key: 'background', label: 'Background', type: 'color', default: '#050505' },
    ],
    css: () => '',
  },
  {
    /* A pencil drawing: the picture's edges traced and its tones cross-hatched on paper. GPU only. */
    type: 'pencil-sketch',
    label: 'Pencil Sketch',
    gpuOnly: true,
    params: [
      { key: 'edges', label: 'Edge Strength', type: 'number', unit: '%', min: 0, max: 400, default: 100 },
      { key: 'hatching', label: 'Hatching', type: 'number', unit: '%', min: 0, max: 100, default: 60 },
      { key: 'hatchSpacing', label: 'Hatch Spacing', type: 'number', unit: 'px', min: 2, max: 120, default: 6 },
      { key: 'paper', label: 'Paper Color', type: 'color', default: '#f4f1ea' },
      { key: 'pencil', label: 'Pencil Color', type: 'color', default: '#2b2b2b' },
      { key: 'colorize', label: 'Color', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'blend', label: 'Blend With Original', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    /* Oil paint (a Kuwahara filter): each pixel takes the calmest of its four neighbouring quadrants, flattening the picture into brush strokes. GPU only. */
    type: 'oil-paint',
    label: 'Oil Paint',
    gpuOnly: true,
    params: [
      { key: 'brushSize', label: 'Brush Size', type: 'number', unit: 'px', min: 1, max: 60, default: 5 },
      { key: 'saturation', label: 'Saturation', type: 'number', unit: '%', min: 0, max: 200, default: 110 },
    ],
    css: () => '',
  },
  {
    /* Handheld camera shake: the layer wanders, rolls and breathes on smooth noise, with motion blur and edge handling. GPU only. */
    type: 'camera-shake',
    label: 'Camera Shake',
    gpuOnly: true,
    params: [
      { key: 'amount', label: 'Amplitude', type: 'number', unit: 'px', min: 0, max: 4000, default: 20 },
      { key: 'rotation', label: 'Rotation', type: 'number', unit: '°', min: -180, max: 180, default: 1 },
      { key: 'zoom', label: 'Zoom', type: 'number', unit: '%', min: 0, max: 50, default: 0 },
      { key: 'frequency', label: 'Frequency', type: 'number', unit: 'Hz', min: 0.1, max: 60, default: 4 },
      { key: 'octaves', label: 'Octaves', type: 'number', min: 1, max: 4, precision: 0, default: 2 },
      { key: 'roughness', label: 'Roughness', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'motionBlur', label: 'Motion Blur', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'edges', label: 'Edges', type: 'enum', default: 3, options: [{ value: 0, label: 'Transparent' }, { value: 1, label: 'Mirror' }, { value: 2, label: 'Repeat' }, { value: 3, label: 'Scale to Fill' }] },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 9999, precision: 0, default: 1 },
      { key: 'followCompTime', label: 'Animate With Time', type: 'checkbox', default: true },
      { key: 'time', label: 'Time', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
    ],
    css: () => '',
  },
  {
    /* Light flicker: the layer's brightness (or opacity) dips on a mix of stepped and smooth noise at the given rate. GPU only. */
    type: 'flicker',
    label: 'Flicker',
    gpuOnly: true,
    params: [
      { key: 'amount', label: 'Amount', type: 'number', unit: '%', min: 0, max: 100, default: 30 },
      { key: 'speed', label: 'Speed', type: 'number', unit: 'Hz', min: 0.1, max: 60, default: 12 },
      { key: 'smoothness', label: 'Smoothness', type: 'number', unit: '%', min: 0, max: 100, default: 30 },
      { key: 'mode', label: 'Flicker', type: 'enum', default: 0, options: [{ value: 0, label: 'Brightness' }, { value: 1, label: 'Opacity' }] },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 9999, precision: 0, default: 1 },
      { key: 'followCompTime', label: 'Animate With Time', type: 'checkbox', default: true },
      { key: 'time', label: 'Time', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
    ],
    css: () => '',
  },
  {
    /* A prism split: spectral copies of the layer fanned out along a direction (or from a centre), red to blue. GPU only. */
    type: 'prism',
    label: 'Prism',
    gpuOnly: true,
    params: [
      { key: 'amount', label: 'Separation', type: 'number', unit: 'px', min: 0, max: 2000, default: 20 },
      { key: 'angle', label: 'Direction', type: 'number', unit: '°', min: -3600, max: 3600, default: 0 },
      { key: 'copies', label: 'Copies', type: 'number', min: 2, max: 12, precision: 0, default: 3 },
      { key: 'mode', label: 'Mode', type: 'enum', default: 0, options: [{ value: 0, label: 'Directional' }, { value: 1, label: 'Radial' }] },
      { key: 'centerX', label: 'Center X', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'centerY', label: 'Center Y', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
    ],
    css: () => '',
  },
  {
    /* Frosted glass: the picture seen through a rough pane, each pixel scattered within the frost radius. GPU only. */
    type: 'frosted-glass',
    label: 'Frosted Glass',
    gpuOnly: true,
    params: [
      // Stream D: frost the scene under the layer instead of the layer itself.
      { key: 'source', label: 'Frost', type: 'enum', default: 0, options: [{ value: 0, label: 'This Layer' }, { value: 1, label: 'Backdrop (the scene below)' }] },
      { key: 'amount', label: 'Frost', type: 'number', unit: 'px', min: 0, max: 400, default: 8 },
      { key: 'smoothness', label: 'Smoothness', type: 'number', unit: '%', min: 0, max: 100, default: 40 },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 9999, precision: 0, default: 1 },
    ],
    css: () => '',
  },
  {
    /* Bleach bypass: the film look of skipping the bleach bath — a silver-retaining overlay of luminance, desaturated and contrasty. GPU only. */
    type: 'bleach-bypass',
    label: 'Bleach Bypass',
    gpuOnly: true,
    params: [
      { key: 'amount', label: 'Amount', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
    ],
    css: () => '',
  },
  {
    /* Cross processing: slide film developed as negative — punchy reds, curved greens, blues lifted in the shadows and crushed in the highlights. GPU only. */
    type: 'cross-process',
    label: 'Cross Process',
    gpuOnly: true,
    params: [
      { key: 'amount', label: 'Amount', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
    ],
    css: () => '',
  },
  {
    /* Split toning: one hue laid into the highlights and another into the shadows, with a balance between them. GPU only. */
    type: 'split-toning',
    label: 'Split Toning',
    gpuOnly: true,
    params: [
      { key: 'highlightHue', label: 'Highlights Hue', type: 'number', unit: '°', min: 0, max: 360, default: 45 },
      { key: 'highlightSaturation', label: 'Highlights Saturation', type: 'number', unit: '%', min: 0, max: 100, default: 30 },
      { key: 'shadowHue', label: 'Shadows Hue', type: 'number', unit: '°', min: 0, max: 360, default: 210 },
      { key: 'shadowSaturation', label: 'Shadows Saturation', type: 'number', unit: '%', min: 0, max: 100, default: 30 },
      { key: 'balance', label: 'Balance', type: 'number', min: -100, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    /* Old film: sepia, grain, flicker, gate weave, vertical scratches and dust, re-rolled per film frame, with a vignette. GPU only. */
    type: 'old-film',
    label: 'Old Film',
    gpuOnly: true,
    params: [
      { key: 'sepia', label: 'Sepia', type: 'number', unit: '%', min: 0, max: 100, default: 70 },
      { key: 'grain', label: 'Grain', type: 'number', unit: '%', min: 0, max: 100, default: 40 },
      { key: 'scratches', label: 'Scratches', type: 'number', unit: '%', min: 0, max: 100, default: 40 },
      { key: 'dust', label: 'Dust', type: 'number', unit: '%', min: 0, max: 100, default: 40 },
      { key: 'flicker', label: 'Flicker', type: 'number', unit: '%', min: 0, max: 100, default: 30 },
      { key: 'weave', label: 'Gate Weave', type: 'number', unit: 'px', min: 0, max: 80, default: 2 },
      { key: 'vignette', label: 'Vignette', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'fps', label: 'Film Frame Rate', type: 'number', unit: 'fps', min: 1, max: 60, default: 18 },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 9999, precision: 0, default: 1 },
      { key: 'followCompTime', label: 'Animate With Time', type: 'checkbox', default: true },
      { key: 'time', label: 'Time', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
    ],
    css: () => '',
  },
  {
    /* Anamorphic lens streaks: long horizontal (or angled) blue flares drawn out of the brightest highlights. GPU only. */
    type: 'anamorphic-streaks',
    label: 'Anamorphic Streaks',
    gpuOnly: true,
    params: [
      { key: 'threshold', label: 'Threshold', type: 'number', unit: '%', min: 0, max: 100, default: 75 },
      { key: 'length', label: 'Length', type: 'number', unit: 'px', min: 0, max: 10000, default: 400 },
      { key: 'intensity', label: 'Intensity', type: 'number', unit: '%', min: 0, max: 500, default: 100 },
      { key: 'tint', label: 'Tint', type: 'color', default: '#4fa8ff' },
      { key: 'angle', label: 'Angle', type: 'number', unit: '°', min: -3600, max: 3600, default: 0 },
    ],
    css: () => '',
  },
  {
    /* Starglow: star-shaped streaks of light (4, 6 or 8 points) radiating from the highlights, in their own colours or a tint. GPU only. */
    type: 'starglow',
    label: 'Starglow',
    gpuOnly: true,
    params: [
      { key: 'threshold', label: 'Threshold', type: 'number', unit: '%', min: 0, max: 100, default: 70 },
      { key: 'length', label: 'Streak Length', type: 'number', unit: 'px', min: 0, max: 4000, default: 120 },
      { key: 'points', label: 'Streaks', type: 'enum', default: 2, options: [{ value: 0, label: '4' }, { value: 1, label: '6' }, { value: 2, label: '8' }] },
      { key: 'angle', label: 'Angle', type: 'number', unit: '°', min: -3600, max: 3600, default: 0 },
      { key: 'intensity', label: 'Boost Light', type: 'number', unit: '%', min: 0, max: 500, default: 100 },
      { key: 'colorMode', label: 'Colors', type: 'enum', default: 0, options: [{ value: 0, label: 'Source Colors' }, { value: 1, label: 'Tint' }] },
      { key: 'tint', label: 'Tint', type: 'color', default: '#fff1d6' },
    ],
    css: () => '',
  },
  {
    /* Twinkling glints: four-point star sparkles born on the layer's bright pixels, each on its own twinkle cycle. GPU only. */
    type: 'sparkle',
    label: 'Sparkle',
    gpuOnly: true,
    params: [
      { key: 'density', label: 'Density', type: 'number', unit: '%', min: 0, max: 100, default: 30 },
      { key: 'size', label: 'Size', type: 'number', unit: 'px', min: 1, max: 800, default: 18 },
      { key: 'threshold', label: 'Threshold', type: 'number', unit: '%', min: 0, max: 100, default: 55 },
      { key: 'speed', label: 'Twinkle Speed', type: 'number', min: 0, max: 20, default: 1 },
      { key: 'color', label: 'Color', type: 'color', default: '#ffffff' },
      { key: 'sourceColor', label: 'Use Source Color', type: 'checkbox', default: true },
      { key: 'intensity', label: 'Intensity', type: 'number', unit: '%', min: 0, max: 400, default: 100 },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 9999, precision: 0, default: 1 },
      { key: 'followCompTime', label: 'Animate With Time', type: 'checkbox', default: true },
      { key: 'time', label: 'Time', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
    ],
    css: () => '',
  },
  {
    /* Temperature and Tint: warm or cool the picture and shift it toward green or magenta, keeping its brightness. GPU only. */
    type: 'white-balance',
    label: 'White Balance',
    gpuOnly: true,
    params: [
      { key: 'temperature', label: 'Temperature', type: 'number', min: -100, max: 100, default: 0 },
      { key: 'tint', label: 'Tint', type: 'number', min: -100, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    /* Clarity: local contrast in the midtones (the picture against its own large-radius blur), for punch without crushing. GPU only. */
    type: 'clarity',
    label: 'Clarity',
    gpuOnly: true,
    params: [
      { key: 'amount', label: 'Amount', type: 'number', unit: '%', min: -100, max: 200, default: 25 },
      { key: 'radius', label: 'Radius', type: 'number', unit: 'px', min: 1, max: 800, default: 30 },
    ],
    css: () => '',
  },
  {
    /* Lens distortion: barrel or pincushion curvature with colour fringing and vignetting, scaled to fill the frame. GPU only. */
    type: 'lens-distortion',
    label: 'Lens Distortion',
    gpuOnly: true,
    params: [
      { key: 'curvature', label: 'Curvature', type: 'number', min: -100, max: 100, default: 30 },
      { key: 'chromatic', label: 'Chromatic Aberration', type: 'number', unit: '%', min: 0, max: 100, default: 10 },
      { key: 'vignette', label: 'Vignette', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'fill', label: 'Scale to Fill', type: 'checkbox', default: true },
      { key: 'centerX', label: 'Center X', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
      { key: 'centerY', label: 'Center Y', type: 'number', unit: 'px', min: -10000, max: 10000, default: 0 },
    ],
    css: () => '',
  },
  {
    /* Heat haze: the picture shimmers through rising, turbulent air. GPU only. */
    type: 'heat-haze',
    label: 'Heat Haze',
    gpuOnly: true,
    params: [
      { key: 'amount', label: 'Amount', type: 'number', unit: 'px', min: 0, max: 400, default: 6 },
      { key: 'scale', label: 'Scale', type: 'number', unit: 'px', min: 2, max: 4000, default: 60 },
      { key: 'speed', label: 'Speed', type: 'number', min: 0, max: 20, default: 1.5 },
      { key: 'direction', label: 'Rise Direction', type: 'number', unit: '°', min: -3600, max: 3600, default: 270 },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 9999, precision: 0, default: 1 },
      { key: 'followCompTime', label: 'Animate With Time', type: 'checkbox', default: true },
      { key: 'time', label: 'Time', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
    ],
    css: () => '',
  },
  {
    /* Photoshop's Color Halftone: four rotated CMYK dot screens printed on paper. GPU only. */
    type: 'color-halftone',
    label: 'Color Halftone',
    gpuOnly: true,
    params: [
      { key: 'radius', label: 'Max Radius', type: 'number', unit: 'px', min: 1, max: 200, default: 6 },
      { key: 'angleC', label: 'Cyan Angle', type: 'number', unit: '°', min: -3600, max: 3600, default: 108 },
      { key: 'angleM', label: 'Magenta Angle', type: 'number', unit: '°', min: -3600, max: 3600, default: 162 },
      { key: 'angleY', label: 'Yellow Angle', type: 'number', unit: '°', min: -3600, max: 3600, default: 90 },
      { key: 'angleK', label: 'Black Angle', type: 'number', unit: '°', min: -3600, max: 3600, default: 45 },
      { key: 'paper', label: 'Paper', type: 'color', default: '#ffffff' },
    ],
    css: () => '',
  },
  {
    /* Photoshop's Crystallize, with stained-glass borders: the picture flattened into random polygonal cells. GPU only. */
    type: 'crystallize',
    label: 'Crystallize',
    gpuOnly: true,
    params: [
      { key: 'cellSize', label: 'Cell Size', type: 'number', unit: 'px', min: 2, max: 800, default: 24 },
      { key: 'borders', label: 'Borders', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'borderColor', label: 'Border Color', type: 'color', default: '#111111' },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 9999, precision: 0, default: 1 },
    ],
    css: () => '',
  },
  {
    /* Drifting fog: layered noise in the fog colour, thicker toward the bottom, drifting with time. GPU only. */
    type: 'fog',
    label: 'Fog',
    gpuOnly: true,
    params: [
      { key: 'density', label: 'Density', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'color', label: 'Fog Color', type: 'color', default: '#c9d3dc' },
      { key: 'scale', label: 'Scale', type: 'number', unit: 'px', min: 20, max: 20000, default: 500 },
      { key: 'speed', label: 'Drift Speed', type: 'number', min: 0, max: 20, default: 0.5 },
      { key: 'direction', label: 'Drift Direction', type: 'number', unit: '°', min: -3600, max: 3600, default: 0 },
      { key: 'falloff', label: 'Height Falloff', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 9999, precision: 0, default: 1 },
      { key: 'followCompTime', label: 'Animate With Time', type: 'checkbox', default: true },
      { key: 'time', label: 'Time', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
    ],
    css: () => '',
  },
  {
    /* Chrome: the layer as polished metal — its brightness and edges bent into a sky-and-horizon reflection. GPU only. */
    type: 'chrome',
    label: 'Chrome',
    gpuOnly: true,
    params: [
      { key: 'bands', label: 'Reflections', type: 'number', min: 1, max: 10, default: 3 },
      { key: 'depth', label: 'Depth', type: 'number', unit: '%', min: 0, max: 400, default: 100 },
      { key: 'tint', label: 'Tint', type: 'color', default: '#ffffff' },
      { key: 'contrast', label: 'Contrast', type: 'number', unit: '%', min: 0, max: 300, default: 100 },
      { key: 'blend', label: 'Blend With Original', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    /* Night vision: amplified green phosphor with noise, scan lines, vignette and an optional scope or binocular mask. GPU only. */
    type: 'night-vision',
    label: 'Night Vision',
    gpuOnly: true,
    params: [
      { key: 'gain', label: 'Gain', type: 'number', unit: '%', min: 100, max: 800, default: 150 },
      { key: 'noise', label: 'Noise', type: 'number', unit: '%', min: 0, max: 100, default: 35 },
      { key: 'scanlines', label: 'Scan Lines', type: 'number', unit: '%', min: 0, max: 100, default: 15 },
      { key: 'vignette', label: 'Vignette', type: 'number', unit: '%', min: 0, max: 100, default: 70 },
      { key: 'color', label: 'Phosphor Color', type: 'color', default: '#3dff6e' },
      { key: 'mask', label: 'Mask', type: 'enum', default: 0, options: [{ value: 0, label: 'None' }, { value: 1, label: 'Circle' }, { value: 2, label: 'Binoculars' }] },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 9999, precision: 0, default: 1 },
      { key: 'followCompTime', label: 'Animate With Time', type: 'checkbox', default: true },
      { key: 'time', label: 'Time', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
    ],
    css: () => '',
  },
  // fx60:b9:end
  // Camera program D1: depth for compositing — on an adjustment layer above 3D
  // layers these read the composition's scene depth (comp px from the active
  // camera; no 3D surface = infinitely far). GPU only.
  {
    /* Depth Matte: keeps what lies between Near and Far scene depth, feathered. GPU only. */
    type: 'depth-matte',
    label: 'Depth Matte',
    gpuOnly: true,
    params: [
      { key: 'near', label: 'Near', type: 'number', unit: 'px', min: 0, max: 100000, default: 0 },
      { key: 'far', label: 'Far', type: 'number', unit: 'px', min: 0, max: 100000, default: 2000 },
      { key: 'feather', label: 'Feather', type: 'number', unit: 'px', min: 0, max: 10000, default: 50 },
      { key: 'invert', label: 'Invert', type: 'checkbox', default: false },
    ],
    css: () => '',
  },
  {
    /* Depth Fog: fog that thickens from Fog Start to Fog End scene depth. GPU only. */
    type: 'depth-fog',
    label: 'Depth Fog',
    gpuOnly: true,
    params: [
      { key: 'color', label: 'Fog Color', type: 'color', default: '#c9d3dc' },
      { key: 'start', label: 'Fog Start', type: 'number', unit: 'px', min: 0, max: 100000, default: 1000 },
      { key: 'end', label: 'Fog End', type: 'number', unit: 'px', min: 0, max: 100000, default: 5000 },
      { key: 'density', label: 'Density', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'fogBackground', label: 'Fog Background', type: 'checkbox', default: true },
      { key: 'gradient', label: 'Gradient', type: 'checkbox', default: false },
      { key: 'farColor', label: 'Far Color', type: 'color', default: '#8fa3b8' },
    ],
    css: () => '',
  },
  {
    /* Depth Extract: the scene depth as greyscale, near black to far white. GPU only. */
    type: 'depth-extract',
    label: 'Depth Extract',
    gpuOnly: true,
    params: [
      { key: 'near', label: 'Black Point (Near)', type: 'number', unit: 'px', min: 0, max: 100000, default: 0 },
      { key: 'far', label: 'White Point (Far)', type: 'number', unit: 'px', min: 0, max: 100000, default: 5000 },
      { key: 'invert', label: 'Invert', type: 'checkbox', default: false },
    ],
    css: () => '',
  },
  // deepfx:defs:begin
  {
    /* Physically based bloom: the picture's highlights (soft-knee threshold in linear light) spread through a six-level pyramid, with per-level tint, anamorphic squeeze and lens dirt from another layer. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'lens-bloom',
    label: 'Lens Bloom',
    gpuOnly: true,
    params: [
      { key: 'threshold', label: 'Threshold', type: 'number', unit: '%', min: 0, max: 400, default: 80 },
      { key: 'knee', label: 'Soft Knee', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'intensity', label: 'Intensity', type: 'number', unit: '%', min: 0, max: 2000, default: 100 },
      { key: 'radius', label: 'Radius', type: 'number', unit: 'px', min: 1, max: 4000, default: 220 },
      { key: 'spread', label: 'Size Bias', type: 'number', min: -100, max: 100, default: 0 },
      { key: 'tint', label: 'Tint', type: 'color', default: '#ffffff' },
      { key: 'saturation', label: 'Bloom Saturation', type: 'number', unit: '%', min: 0, max: 200, default: 100 },
      { key: 'anamorphic', label: 'Anamorphic', type: 'number', min: -100, max: 100, default: 0 },
      { key: 'clamp', label: 'Highlight Clamp', type: 'number', unit: '%', min: 100, max: 10000, default: 2000 },
      { key: 'dirtLayer', label: 'Lens Dirt Layer', type: 'layer', group: 'Lens Dirt', default: '' },
      { key: 'dirtAmount', label: 'Dirt Intensity', type: 'number', group: 'Lens Dirt', unit: '%', min: 0, max: 1000, default: 150 },
      { key: 'mode', label: 'Composite', type: 'enum', default: 0, options: [{ value: 0, label: 'Add' }, { value: 1, label: 'Screen' }, { value: 2, label: 'Lighten' }, { value: 3, label: 'Light Only' }] },
    ],
    css: () => '',
  },
  {
    /* Volumetric light rays streaming from the bright parts of the layer away from a source point (Trapcode Shine class): log-step radial accumulation, shimmer (keyframe its phase), colorize by ray brightness, boost light. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'shine',
    label: 'Shine',
    gpuOnly: true,
    params: [
      { key: 'sourceX', label: 'Source Point X', type: 'number', unit: 'px', min: -100000, max: 100000, default: 0 },
      { key: 'sourceY', label: 'Source Point Y', type: 'number', unit: 'px', min: -100000, max: 100000, default: 0 },
      { key: 'rayLength', label: 'Ray Length', type: 'number', unit: '%', min: 0, max: 100, default: 40 },
      { key: 'threshold', label: 'Threshold', type: 'number', group: 'Pre-Process', unit: '%', min: 0, max: 100, default: 30 },
      { key: 'thresholdSoftness', label: 'Threshold Softness', type: 'number', group: 'Pre-Process', unit: '%', min: 0, max: 100, default: 20 },
      { key: 'shimmerAmount', label: 'Shimmer Amount', type: 'number', group: 'Shimmer', unit: '%', min: 0, max: 100, default: 40 },
      { key: 'shimmerDetail', label: 'Shimmer Detail', type: 'number', group: 'Shimmer', min: 1, max: 100, default: 12 },
      { key: 'shimmerPhase', label: 'Shimmer Phase', type: 'number', group: 'Shimmer', unit: '°', min: -36000, max: 36000, default: 0 },
      { key: 'boostLight', label: 'Boost Light', type: 'number', min: 0, max: 50, default: 1 },
      { key: 'decay', label: 'Falloff', type: 'number', unit: '%', min: 0, max: 100, default: 30 },
      { key: 'colorize', label: 'Colorize', type: 'enum', group: 'Colorize', default: 2, options: [{ value: 0, label: 'None' }, { value: 1, label: 'One Color' }, { value: 2, label: '3-Color Gradient' }, { value: 3, label: '5-Color Gradient' }, { value: 4, label: 'Fire' }, { value: 5, label: 'Electric' }, { value: 6, label: 'Spirit' }] },
      { key: 'baseOn', label: 'Base On', type: 'enum', group: 'Colorize', default: 0, options: [{ value: 0, label: 'Lightness' }, { value: 1, label: 'Luminance' }, { value: 2, label: 'Alpha' }, { value: 3, label: 'Red' }, { value: 4, label: 'Green' }, { value: 5, label: 'Blue' }] },
      { key: 'highlights', label: 'Highlights', type: 'color', group: 'Colorize', default: '#ffffff' },
      { key: 'midHigh', label: 'Mid High', type: 'color', group: 'Colorize', default: '#ffe9a0' },
      { key: 'midtones', label: 'Midtones', type: 'color', group: 'Colorize', default: '#ffb341' },
      { key: 'midLow', label: 'Mid Low', type: 'color', group: 'Colorize', default: '#d0461c' },
      { key: 'shadows', label: 'Shadows', type: 'color', group: 'Colorize', default: '#3a0a26' },
      { key: 'edgeThickness', label: 'Edge Thickness', type: 'number', group: 'Colorize', unit: '%', min: 1, max: 100, default: 50 },
      { key: 'sourceOpacity', label: 'Source Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'shineOpacity', label: 'Shine Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'mode', label: 'Transfer Mode', type: 'enum', default: 0, options: [{ value: 0, label: 'Add' }, { value: 1, label: 'Screen' }, { value: 2, label: 'Lighten' }, { value: 3, label: 'Light Only' }] },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 99999, precision: 0, default: 1 },
    ],
    css: () => '',
  },
  {
    /* A lens system driven by the picture itself: its highlights become a chain of mirrored ghosts with chromatic dispersion, a halo ring, a starburst and lens dirt — no light position needed. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'image-flares',
    label: 'Image Flares',
    gpuOnly: true,
    params: [
      { key: 'threshold', label: 'Threshold', type: 'number', unit: '%', min: 0, max: 400, default: 75 },
      { key: 'intensity', label: 'Intensity', type: 'number', unit: '%', min: 0, max: 2000, default: 100 },
      { key: 'ghosts', label: 'Ghosts', type: 'number', min: 0, max: 12, precision: 0, default: 5 },
      { key: 'dispersal', label: 'Ghost Spacing', type: 'number', unit: '%', min: 1, max: 100, default: 35 },
      { key: 'ghostSize', label: 'Ghost Size', type: 'number', unit: '%', min: 1, max: 300, default: 60 },
      { key: 'chroma', label: 'Chromatic Dispersion', type: 'number', unit: '%', min: 0, max: 200, default: 40 },
      { key: 'halo', label: 'Halo Intensity', type: 'number', unit: '%', min: 0, max: 500, default: 60 },
      { key: 'haloWidth', label: 'Halo Radius', type: 'number', unit: '%', min: 1, max: 100, default: 45 },
      { key: 'starburst', label: 'Starburst', type: 'number', unit: '%', min: 0, max: 200, default: 40 },
      { key: 'starPoints', label: 'Starburst Rays', type: 'number', min: 2, max: 64, precision: 0, default: 14 },
      { key: 'softness', label: 'Softness', type: 'number', unit: 'px', min: 0, max: 200, default: 6 },
      { key: 'rainbow', label: 'Lens Coating Color', type: 'number', unit: '%', min: 0, max: 100, default: 70 },
      { key: 'dirtLayer', label: 'Lens Dirt Layer', type: 'layer', group: 'Lens Dirt', default: '' },
      { key: 'dirtAmount', label: 'Dirt Intensity', type: 'number', group: 'Lens Dirt', unit: '%', min: 0, max: 1000, default: 120 },
      { key: 'centerX', label: 'Optical Center Offset X', type: 'number', unit: 'px', min: -100000, max: 100000, default: 0 },
      { key: 'centerY', label: 'Optical Center Offset Y', type: 'number', unit: 'px', min: -100000, max: 100000, default: 0 },
      { key: 'mode', label: 'Composite', type: 'enum', default: 0, options: [{ value: 0, label: 'Add' }, { value: 1, label: 'Screen' }, { value: 2, label: 'Lighten' }, { value: 3, label: 'Light Only' }] },
    ],
    css: () => '',
  },
  {
    /* An anisotropic Kuwahara painting: brush strokes follow the image's structure tensor (smoothed), eight weighted sectors per ellipse, optional colour quantisation. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'painterly',
    label: 'Painterly',
    gpuOnly: true,
    params: [
      { key: 'brushSize', label: 'Brush Size', type: 'number', unit: 'px', min: 1, max: 40, default: 6 },
      { key: 'anisotropy', label: 'Stroke Length', type: 'number', unit: '%', min: 0, max: 400, default: 100 },
      { key: 'sharpness', label: 'Sharpness', type: 'number', min: 1, max: 18, default: 8 },
      { key: 'flowSmoothing', label: 'Flow Smoothing', type: 'number', unit: 'px', min: 0, max: 20, default: 2 },
      { key: 'levels', label: 'Color Levels', type: 'number', min: 0, max: 32, precision: 0, default: 0 },
      { key: 'saturation', label: 'Saturation', type: 'number', unit: '%', min: 0, max: 300, default: 110 },
      { key: 'detail', label: 'Fine Detail', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'blend', label: 'Blend With Original', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    /* Watercolour simulation: an edge-preserving abstraction, colour bleeding through wet areas, pigment density turbulence, darkened wet edges, granulation, hand tremor and paper texture. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'watercolor',
    label: 'Watercolor',
    gpuOnly: true,
    params: [
      { key: 'abstraction', label: 'Abstraction', type: 'number', unit: 'px', min: 0, max: 30, default: 5 },
      { key: 'bleed', label: 'Color Bleed', type: 'number', unit: 'px', min: 0, max: 200, default: 10 },
      { key: 'wetness', label: 'Wet Areas', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'edgeDarkening', label: 'Wet Edge Darkening', type: 'number', unit: '%', min: 0, max: 300, default: 60 },
      { key: 'pigment', label: 'Pigment Density', type: 'number', unit: '%', min: 0, max: 200, default: 45 },
      { key: 'pigmentScale', label: 'Pigment Scale', type: 'number', unit: 'px', min: 2, max: 1000, default: 60 },
      { key: 'granulation', label: 'Granulation', type: 'number', unit: '%', min: 0, max: 200, default: 35 },
      { key: 'tremor', label: 'Hand Tremor', type: 'number', unit: 'px', min: 0, max: 40, default: 2 },
      { key: 'paper', label: 'Paper Texture', type: 'number', unit: '%', min: 0, max: 200, default: 40 },
      { key: 'paperScale', label: 'Paper Scale', type: 'number', unit: 'px', min: 0.5, max: 50, default: 3 },
      { key: 'paperColor', label: 'Paper Color', type: 'color', default: '#f6f1e6' },
      { key: 'onPaper', label: 'Composite On Paper', type: 'checkbox', default: false },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 99999, precision: 0, default: 1 },
    ],
    css: () => '',
  },
  {
    /* Comic / toon rendering: XDoG ink lines (difference of two Gaussians, soft threshold) over a cel-quantised, edge-preserving smoothed fill, with optional halftone shading. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'ink-outline',
    label: 'Ink & Toon',
    gpuOnly: true,
    params: [
      { key: 'lineWeight', label: 'Line Weight', type: 'number', unit: 'px', min: 0.3, max: 20, default: 1.6 },
      { key: 'lineSharpness', label: 'Line Sharpness', type: 'number', min: 1, max: 200, default: 30 },
      { key: 'lineThreshold', label: 'Line Threshold', type: 'number', unit: '%', min: -100, max: 100, default: 10 },
      { key: 'detail', label: 'Line Detail', type: 'number', unit: '%', min: 50, max: 100, default: 98 },
      { key: 'lineColor', label: 'Line Color', type: 'color', default: '#141414' },
      { key: 'lineOpacity', label: 'Line Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'levels', label: 'Shading Levels', type: 'number', min: 2, max: 16, precision: 0, default: 4 },
      { key: 'smoothing', label: 'Fill Smoothing', type: 'number', unit: 'px', min: 0, max: 20, default: 4 },
      { key: 'saturation', label: 'Fill Saturation', type: 'number', unit: '%', min: 0, max: 300, default: 120 },
      { key: 'halftone', label: 'Halftone Shading', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'halftoneSize', label: 'Halftone Size', type: 'number', unit: 'px', min: 2, max: 60, default: 6 },
      { key: 'halftoneAngle', label: 'Halftone Angle', type: 'number', unit: '°', min: -3600, max: 3600, default: 45 },
      { key: 'fillOpacity', label: 'Fill Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
    ],
    css: () => '',
  },
  {
    /* After Effects' Detail-preserving Upscale: an edge-directed resample about the layer centre that keeps edges crisp, a halo-limited detail pass and noise reduction. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'detail-upscale',
    label: 'Detail-preserving Upscale',
    gpuOnly: true,
    params: [
      { key: 'scale', label: 'Scale', type: 'number', unit: '%', min: 100, max: 1000, default: 200 },
      { key: 'detail', label: 'Detail', type: 'number', unit: '%', min: 0, max: 100, default: 40 },
      { key: 'reduceNoise', label: 'Reduce Noise', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'alpha', label: 'Alpha', type: 'enum', default: 0, options: [{ value: 0, label: 'Detail-preserving' }, { value: 1, label: 'Bicubic' }] },
    ],
    css: () => '',
  },
  {
    /* After Effects' Paint Bucket: a flood fill from a point through the connected region within tolerance (colour, straight colour, transparency, opacity or alpha), with antialias, feather, spread, choke or stroke. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'paint-bucket',
    label: 'Paint Bucket',
    gpuOnly: true,
    params: [
      { key: 'fillPointX', label: 'Fill Point X', type: 'number', unit: 'px', min: -100000, max: 100000, default: 0 },
      { key: 'fillPointY', label: 'Fill Point Y', type: 'number', unit: 'px', min: -100000, max: 100000, default: 0 },
      { key: 'selector', label: 'Fill Selector', type: 'enum', default: 0, options: [{ value: 0, label: 'Color & Alpha' }, { value: 1, label: 'Straight Color' }, { value: 2, label: 'Transparency' }, { value: 3, label: 'Opacity' }, { value: 4, label: 'Alpha Channel' }] },
      { key: 'tolerance', label: 'Tolerance', type: 'number', unit: '%', min: 0, max: 100, default: 10 },
      { key: 'viewThreshold', label: 'View Threshold', type: 'checkbox', default: false },
      { key: 'strokeMode', label: 'Stroke', type: 'enum', default: 0, options: [{ value: 0, label: 'Antialias' }, { value: 1, label: 'Feather' }, { value: 2, label: 'Spread' }, { value: 3, label: 'Choke' }, { value: 4, label: 'Stroke' }] },
      { key: 'strokeWidth', label: 'Spread Radius / Stroke Width', type: 'number', unit: 'px', min: 0, max: 200, default: 3 },
      { key: 'feather', label: 'Feather Softness', type: 'number', unit: 'px', min: 0, max: 200, default: 4 },
      { key: 'invert', label: 'Invert Fill', type: 'checkbox', default: false },
      { key: 'color', label: 'Color', type: 'color', default: '#e8352a' },
      { key: 'opacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'blending', label: 'Blending Mode', type: 'enum', default: 0, options: [{ value: 0, label: 'Normal' }, { value: 1, label: 'Behind' }, { value: 2, label: 'Fill Only' }, { value: 3, label: 'Multiply' }, { value: 4, label: 'Screen' }, { value: 5, label: 'Color' }] },
    ],
    css: () => '',
  },
  {
    /* Wraps a blurred background layer's light around the layer's edges so a keyed or cut-out subject sits in its plate: wrap width from the alpha falloff, background blur, luminance bias. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'light-wrap',
    label: 'Light Wrap',
    gpuOnly: true,
    params: [
      { key: 'backgroundLayer', label: 'Background Layer', type: 'layer', default: '' },
      { key: 'wrapWidth', label: 'Wrap Width', type: 'number', unit: 'px', min: 1, max: 500, default: 24 },
      { key: 'intensity', label: 'Intensity', type: 'number', unit: '%', min: 0, max: 500, default: 100 },
      { key: 'backgroundBlur', label: 'Background Blur', type: 'number', unit: 'px', min: 0, max: 500, default: 16 },
      { key: 'lumaBias', label: 'Luminance Bias', type: 'number', min: -100, max: 100, default: 0 },
      { key: 'mode', label: 'Wrap Mode', type: 'enum', default: 0, options: [{ value: 0, label: 'Screen' }, { value: 1, label: 'Add' }, { value: 2, label: 'Normal' }, { value: 3, label: 'Lighten' }] },
      { key: 'wrapOnly', label: 'Wrap Only', type: 'checkbox', default: false },
    ],
    css: () => '',
  },
  {
    /* Glass refraction from a height map (another layer, or this one): normals from the smoothed height, Snell refraction per wavelength (six-sample dispersion), frosting, and a specular highlight. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'refraction',
    label: 'Refraction',
    gpuOnly: true,
    params: [
      { key: 'heightLayer', label: 'Height Layer', type: 'layer', noneLabel: 'None (this layer)', default: '' },
      { key: 'heightSource', label: 'Height From', type: 'enum', default: 0, options: [{ value: 0, label: 'Luminance' }, { value: 1, label: 'Alpha' }, { value: 2, label: 'Red' }, { value: 3, label: 'Green' }, { value: 4, label: 'Blue' }] },
      { key: 'source', label: 'Refract', type: 'enum', default: 0, options: [{ value: 0, label: 'This Layer' }, { value: 1, label: 'Backdrop (the scene below)' }] },
      { key: 'invertHeight', label: 'Invert Height', type: 'checkbox', default: false },
      { key: 'depth', label: 'Depth', type: 'number', unit: 'px', min: 0, max: 500, default: 30 },
      { key: 'smoothness', label: 'Smoothness', type: 'number', unit: 'px', min: 0, max: 100, default: 4 },
      { key: 'ior', label: 'Refractive Index', type: 'number', min: 1, max: 3, precision: 2, default: 1.33 },
      { key: 'dispersion', label: 'Dispersion', type: 'number', unit: '%', min: 0, max: 300, default: 30 },
      { key: 'frost', label: 'Frost', type: 'number', unit: 'px', min: 0, max: 100, default: 0 },
      { key: 'specular', label: 'Specular', type: 'number', unit: '%', min: 0, max: 300, default: 40 },
      { key: 'shininess', label: 'Shininess', type: 'number', min: 1, max: 400, default: 40 },
      { key: 'lightAngle', label: 'Light Direction', type: 'number', unit: '°', min: -3600, max: 3600, default: -45 },
      { key: 'lightElevation', label: 'Light Elevation', type: 'number', unit: '°', min: 0, max: 90, default: 45 },
    ],
    css: () => '',
  },
  {
    /* After Effects' Compound Arithmetic: the layer combined with a second layer by one of fifteen operators (bitwise And / Or / Xor included) on RGB, ARGB or alpha, with clip, wrap or scale overflow. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'compound-arithmetic',
    label: 'Compound Arithmetic',
    gpuOnly: true,
    params: [
      { key: 'secondLayer', label: 'Second Source Layer', type: 'layer', default: '' },
      { key: 'operator', label: 'Operator', type: 'enum', default: 1, options: [{ value: 0, label: 'Copy' }, { value: 1, label: 'Add' }, { value: 2, label: 'Subtract' }, { value: 3, label: 'Multiply' }, { value: 4, label: 'Difference' }, { value: 5, label: 'And' }, { value: 6, label: 'Or' }, { value: 7, label: 'Xor' }, { value: 8, label: 'Lighten' }, { value: 9, label: 'Darken' }, { value: 10, label: 'Minimum' }, { value: 11, label: 'Maximum' }, { value: 12, label: 'Screen' }, { value: 13, label: 'Overlay' }, { value: 14, label: 'Hard Light' }] },
      { key: 'channels', label: 'Operate On Channels', type: 'enum', default: 0, options: [{ value: 0, label: 'RGB' }, { value: 1, label: 'ARGB' }, { value: 2, label: 'Alpha' }] },
      { key: 'overflow', label: 'Overflow Behavior', type: 'enum', default: 0, options: [{ value: 0, label: 'Clip' }, { value: 1, label: 'Wrap' }, { value: 2, label: 'Scale' }] },
      { key: 'blend', label: 'Blend With Original', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    /* After Effects' Color Link: a colour statistic of a source layer (average, brightest, darkest, max / min RGB, alpha statistics), measured by a GPU reduction every frame, blended over the layer. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'color-link',
    label: 'Color Link',
    gpuOnly: true,
    params: [
      { key: 'sourceLayer', label: 'Source Layer', type: 'layer', noneLabel: 'None (this layer)', default: '' },
      { key: 'sample', label: 'Sample', type: 'enum', default: 0, options: [{ value: 0, label: 'Average' }, { value: 1, label: 'Brightest Values' }, { value: 2, label: 'Darkest Values' }, { value: 3, label: 'Maximum RGB' }, { value: 4, label: 'Minimum RGB' }, { value: 5, label: 'Average Alpha' }, { value: 6, label: 'Maximum Alpha' }, { value: 7, label: 'Minimum Alpha' }] },
      { key: 'stencilAlpha', label: 'Stencil Original Alpha', type: 'checkbox', default: false },
      { key: 'opacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'blending', label: 'Blending Mode', type: 'enum', default: 0, options: [{ value: 0, label: 'Normal' }, { value: 1, label: 'Add' }, { value: 2, label: 'Multiply' }, { value: 3, label: 'Screen' }, { value: 4, label: 'Overlay' }, { value: 5, label: 'Soft Light' }, { value: 6, label: 'Hard Light' }, { value: 7, label: 'Difference' }, { value: 8, label: 'Color' }, { value: 9, label: 'Hue' }, { value: 10, label: 'Saturation' }, { value: 11, label: 'Luminosity' }] },
    ],
    css: () => '',
  },
  {
    /* After Effects' Inner/Outer Key: a matte pulled from a foreground (inside) and background (outside) mask: local foreground and background colours by normalized convolution, alpha by projection, colour unmixed from the background. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'inner-outer-key',
    label: 'Inner/Outer Key',
    gpuOnly: true,
    params: [
      { key: 'foregroundMask', label: 'Foreground (Inside)', type: 'maskPath', default: '' },
      { key: 'backgroundMask', label: 'Background (Outside)', type: 'maskPath', noneLabel: 'None (single mask)', default: '' },
      { key: 'highlightRadius', label: 'Single Mask Highlight Radius', type: 'number', unit: 'px', min: 1, max: 500, default: 20 },
      { key: 'colorReach', label: 'Color Sample Radius', type: 'number', unit: 'px', min: 2, max: 500, default: 24 },
      { key: 'edgeThreshold', label: 'Edge Threshold', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'edgeFeather', label: 'Edge Feather', type: 'number', unit: 'px', min: 0, max: 100, default: 0 },
      { key: 'invert', label: 'Invert Extraction', type: 'checkbox', default: false },
      { key: 'blend', label: 'Blend With Original', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    /* An energy beam (Saber class): a hot core along a mask path or the layer's alpha, trimmed by start / end / offset, distorted by animated noise, flickering, inside a multi-octave glow. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'energy-saber',
    label: 'Energy Saber',
    gpuOnly: true,
    params: [
      { key: 'coreType', label: 'Core Type', type: 'enum', default: 0, options: [{ value: 0, label: 'Mask Path' }, { value: 1, label: 'Layer Alpha' }] },
      { key: 'pathMask', label: 'Mask', type: 'maskPath', noneLabel: 'Mask 1 (first mask)', default: '' },
      { key: 'coreColor', label: 'Core Color', type: 'color', group: 'Core', default: '#ffffff' },
      { key: 'coreSize', label: 'Core Size', type: 'number', group: 'Core', unit: 'px', min: 0, max: 200, default: 5 },
      { key: 'coreSoftness', label: 'Core Softness', type: 'number', group: 'Core', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'startOffset', label: 'Start Offset', type: 'number', group: 'Core', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'endOffset', label: 'End Offset', type: 'number', group: 'Core', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'offset', label: 'Offset', type: 'number', group: 'Core', unit: '%', min: -10000, max: 10000, default: 0 },
      { key: 'glowColor', label: 'Glow Color', type: 'color', group: 'Glow', default: '#2f8cff' },
      { key: 'glowIntensity', label: 'Glow Intensity', type: 'number', group: 'Glow', unit: '%', min: 0, max: 1000, default: 100 },
      { key: 'glowSpread', label: 'Glow Spread', type: 'number', group: 'Glow', unit: '%', min: 0, max: 300, default: 40 },
      { key: 'glowBias', label: 'Glow Bias', type: 'number', group: 'Glow', min: -100, max: 100, default: 0 },
      { key: 'flicker', label: 'Flicker Intensity', type: 'number', group: 'Flicker', unit: '%', min: 0, max: 100, default: 15 },
      { key: 'flickerSpeed', label: 'Flicker Speed', type: 'number', group: 'Flicker', min: 0, max: 60, default: 8 },
      { key: 'distortion', label: 'Distortion Amount', type: 'number', group: 'Distortion', unit: 'px', min: 0, max: 200, default: 4 },
      { key: 'distortionScale', label: 'Distortion Scale', type: 'number', group: 'Distortion', unit: 'px', min: 1, max: 2000, default: 40 },
      { key: 'distortionSpeed', label: 'Distortion Speed', type: 'number', group: 'Distortion', min: 0, max: 30, default: 1 },
      { key: 'composite', label: 'Composite', type: 'enum', default: 0, options: [{ value: 0, label: 'Add' }, { value: 1, label: 'Screen' }, { value: 2, label: 'Black Background' }, { value: 3, label: 'Transparent' }] },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 99999, precision: 0, default: 1 },
      { key: 'followCompTime', label: 'Animate With Time', type: 'checkbox', default: true },
      { key: 'time', label: 'Time', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
    ],
    css: () => '',
  },
  {
    /* After Effects' PS Arbitrary Map: an arbitrary (non-monotonic) map of each channel through 256-entry tables (a master map then per-channel maps), cycled by Phase, optionally applied to alpha. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'ps-arbitrary-map',
    label: 'PS Arbitrary Map',
    gpuOnly: true,
    params: [
      { key: 'masterMap', label: 'Map', type: 'curve', default: [[0,0],[255,255]] },
      { key: 'redMap', label: 'Red Map', type: 'curve', default: [[0,0],[255,255]] },
      { key: 'greenMap', label: 'Green Map', type: 'curve', default: [[0,0],[255,255]] },
      { key: 'blueMap', label: 'Blue Map', type: 'curve', default: [[0,0],[255,255]] },
      { key: 'interpolation', label: 'Interpolation', type: 'enum', default: 0, options: [{ value: 0, label: 'Linear' }, { value: 1, label: 'Smooth' }] },
      { key: 'phase', label: 'Phase', type: 'number', unit: '°', min: -36000, max: 36000, default: 0 },
      { key: 'applyToAlpha', label: 'Apply Phase Map to Alpha', type: 'checkbox', default: false },
    ],
    css: () => '',
  },
  {
    /* Light rays cast from the layer's edges (alpha or luminance edges) away from a centre point, shimmering, in the source colours or a tint. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'edge-rays',
    label: 'Edge Rays',
    gpuOnly: true,
    params: [
      { key: 'centerX', label: 'Center X', type: 'number', unit: 'px', min: -100000, max: 100000, default: 0 },
      { key: 'centerY', label: 'Center Y', type: 'number', unit: 'px', min: -100000, max: 100000, default: 0 },
      { key: 'rayLength', label: 'Ray Length', type: 'number', unit: '%', min: 0, max: 100, default: 35 },
      { key: 'edgeSource', label: 'Edges From', type: 'enum', default: 0, options: [{ value: 0, label: 'Alpha' }, { value: 1, label: 'Luminance' }, { value: 2, label: 'Both' }] },
      { key: 'edgeWidth', label: 'Edge Width', type: 'number', unit: 'px', min: 0.5, max: 50, default: 3 },
      { key: 'threshold', label: 'Edge Threshold', type: 'number', unit: '%', min: 0, max: 100, default: 10 },
      { key: 'intensity', label: 'Intensity', type: 'number', min: 0, max: 50, default: 2 },
      { key: 'falloff', label: 'Falloff', type: 'number', unit: '%', min: 0, max: 100, default: 20 },
      { key: 'colorMode', label: 'Colors', type: 'enum', default: 0, options: [{ value: 0, label: 'Source Colors' }, { value: 1, label: 'Tint' }] },
      { key: 'tint', label: 'Tint', type: 'color', default: '#ffd27a' },
      { key: 'shimmerAmount', label: 'Shimmer Amount', type: 'number', group: 'Shimmer', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'shimmerDetail', label: 'Shimmer Detail', type: 'number', group: 'Shimmer', min: 1, max: 100, default: 20 },
      { key: 'shimmerPhase', label: 'Shimmer Phase', type: 'number', group: 'Shimmer', unit: '°', min: -36000, max: 36000, default: 0 },
      { key: 'mode', label: 'Composite', type: 'enum', default: 0, options: [{ value: 0, label: 'Add' }, { value: 1, label: 'Screen' }, { value: 2, label: 'Lighten' }, { value: 3, label: 'Light Only' }] },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 99999, precision: 0, default: 1 },
    ],
    css: () => '',
  },
  {
    /* After Effects' VR Blur: a Gaussian on the sphere — the kernel widens toward the poles (1 / cos latitude) and wraps across the seam, so a 360 frame blurs without a seam or polar pinch. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'vr-blur',
    label: 'VR Blur',
    gpuOnly: true,
    params: [
      { key: 'frameLayout', label: 'Frame Layout', type: 'enum', default: 0, options: [{ value: 0, label: 'Monoscopic' }, { value: 1, label: 'Stereo - Over/Under' }, { value: 2, label: 'Stereo - Side by Side' }] },
      { key: 'blurriness', label: 'Blurriness', type: 'number', unit: 'px', min: 0, max: 1000, default: 10 },
      { key: 'repeatEdges', label: 'Repeat Edge Pixels', type: 'checkbox', default: true },
    ],
    css: () => '',
  },
  {
    /* After Effects' VR Chromatic Aberrations: red, green and blue pulled toward or away from a centre direction on the sphere, falling off with angle, seam-correct. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'vr-chromatic-aberrations',
    label: 'VR Chromatic Aberrations',
    gpuOnly: true,
    params: [
      { key: 'frameLayout', label: 'Frame Layout', type: 'enum', default: 0, options: [{ value: 0, label: 'Monoscopic' }, { value: 1, label: 'Stereo - Over/Under' }, { value: 2, label: 'Stereo - Side by Side' }] },
      { key: 'red', label: 'Aberration (Red)', type: 'number', min: -100, max: 100, default: 4 },
      { key: 'green', label: 'Aberration (Green)', type: 'number', min: -100, max: 100, default: 0 },
      { key: 'blue', label: 'Aberration (Blue)', type: 'number', min: -100, max: 100, default: -4 },
      { key: 'centerPan', label: 'Center Pan', type: 'number', unit: '°', min: -180, max: 180, default: 0 },
      { key: 'centerTilt', label: 'Center Tilt', type: 'number', unit: '°', min: -90, max: 90, default: 0 },
      { key: 'falloff', label: 'Falloff', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'reverseFalloff', label: 'Reverse Falloff', type: 'checkbox', default: false },
    ],
    css: () => '',
  },
  {
    /* After Effects' VR Converter: re-projects the layer between equirectangular, cube maps (3 x 2, 6 x 1, 4 x 3 cross) and a rectilinear view (field of view, pan, tilt, roll), rotating the sphere on the way. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'vr-converter',
    label: 'VR Converter',
    gpuOnly: true,
    params: [
      { key: 'sourceLayout', label: 'Source Layout', type: 'enum', default: 0, options: [{ value: 0, label: 'Equirectangular' }, { value: 1, label: 'Cube Map 3 x 2' }, { value: 2, label: 'Cube Map 6 x 1' }, { value: 3, label: 'Cube Map 4 x 3 (Cross)' }, { value: 4, label: 'Rectilinear View' }] },
      { key: 'outputLayout', label: 'Output Layout', type: 'enum', default: 0, options: [{ value: 0, label: 'Equirectangular' }, { value: 1, label: 'Cube Map 3 x 2' }, { value: 2, label: 'Cube Map 6 x 1' }, { value: 3, label: 'Cube Map 4 x 3 (Cross)' }, { value: 4, label: 'Rectilinear View' }] },
      { key: 'pan', label: 'Pan', type: 'number', unit: '°', min: -360, max: 360, default: 0 },
      { key: 'tilt', label: 'Tilt', type: 'number', unit: '°', min: -180, max: 180, default: 0 },
      { key: 'roll', label: 'Roll', type: 'number', unit: '°', min: -360, max: 360, default: 0 },
      { key: 'fov', label: 'Field of View (Rectilinear)', type: 'number', unit: '°', min: 10, max: 170, default: 90 },
      { key: 'seamless', label: 'Seam Blend', type: 'checkbox', default: true },
    ],
    css: () => '',
  },
  {
    /* After Effects' VR De-Noise: non-local means (3 x 3 patches over a 7 x 7 search, widened with latitude) that wraps across the seam, preserving detail. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'vr-denoise',
    label: 'VR De-Noise',
    gpuOnly: true,
    params: [
      { key: 'frameLayout', label: 'Frame Layout', type: 'enum', default: 0, options: [{ value: 0, label: 'Monoscopic' }, { value: 1, label: 'Stereo - Over/Under' }, { value: 2, label: 'Stereo - Side by Side' }] },
      { key: 'noiseLevel', label: 'Noise Level', type: 'number', unit: '%', min: 0, max: 100, default: 30 },
      { key: 'searchRadius', label: 'Search Radius', type: 'number', unit: 'px', min: 1, max: 20, default: 3 },
      { key: 'detail', label: 'Detail Preservation', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
    ],
    css: () => '',
  },
  {
    /* After Effects' VR Fractal Noise: fractal noise evaluated in 3-D on the unit sphere, so it is seamless at the edges and undistorted at the poles; evolves without repeating. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'vr-fractal-noise',
    label: 'VR Fractal Noise',
    gpuOnly: true,
    params: [
      { key: 'frameLayout', label: 'Frame Layout', type: 'enum', default: 0, options: [{ value: 0, label: 'Monoscopic' }, { value: 1, label: 'Stereo - Over/Under' }, { value: 2, label: 'Stereo - Side by Side' }] },
      { key: 'fractalType', label: 'Fractal Type', type: 'enum', default: 0, options: [{ value: 0, label: 'Basic' }, { value: 1, label: 'Turbulent Smooth' }, { value: 2, label: 'Turbulent Sharp' }, { value: 3, label: 'Max' }, { value: 4, label: 'Rocky' }] },
      { key: 'invert', label: 'Invert', type: 'checkbox', default: false },
      { key: 'contrast', label: 'Contrast', type: 'number', unit: '%', min: 0, max: 1000, default: 100 },
      { key: 'brightness', label: 'Brightness', type: 'number', min: -200, max: 200, default: 0 },
      { key: 'scale', label: 'Scale', type: 'number', unit: '%', min: 1, max: 2000, default: 100 },
      { key: 'pan', label: 'Rotate Pan', type: 'number', unit: '°', min: -3600, max: 3600, default: 0 },
      { key: 'tilt', label: 'Rotate Tilt', type: 'number', unit: '°', min: -3600, max: 3600, default: 0 },
      { key: 'complexity', label: 'Complexity', type: 'number', min: 1, max: 10, precision: 1, default: 6 },
      { key: 'evolution', label: 'Evolution', type: 'number', unit: '°', min: -360000, max: 360000, default: 0 },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 99999, precision: 0, default: 1 },
      { key: 'opacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'blending', label: 'Blending Mode', type: 'enum', default: 0, options: [{ value: 0, label: 'None' }, { value: 1, label: 'Normal' }, { value: 2, label: 'Multiply' }, { value: 3, label: 'Screen' }, { value: 4, label: 'Overlay' }, { value: 5, label: 'Soft Light' }, { value: 6, label: 'Add' }] },
    ],
    css: () => '',
  },
  {
    /* After Effects' VR Glow: highlights spread through three spherical blurs (seam-wrapping, latitude-correct) and added back, tinted. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'vr-glow',
    label: 'VR Glow',
    gpuOnly: true,
    params: [
      { key: 'frameLayout', label: 'Frame Layout', type: 'enum', default: 0, options: [{ value: 0, label: 'Monoscopic' }, { value: 1, label: 'Stereo - Over/Under' }, { value: 2, label: 'Stereo - Side by Side' }] },
      { key: 'threshold', label: 'Luminance Threshold', type: 'number', unit: '%', min: 0, max: 100, default: 70 },
      { key: 'radius', label: 'Glow Radius', type: 'number', unit: 'px', min: 1, max: 1000, default: 40 },
      { key: 'brightness', label: 'Glow Brightness', type: 'number', unit: '%', min: 0, max: 1000, default: 100 },
      { key: 'saturation', label: 'Glow Saturation', type: 'number', unit: '%', min: 0, max: 200, default: 100 },
      { key: 'tint', label: 'Tint Color', type: 'color', default: '#ffffff' },
      { key: 'tintEnable', label: 'Use Tint', type: 'checkbox', default: false },
    ],
    css: () => '',
  },
  {
    /* After Effects' VR Plane to Sphere: the layer's flat picture projected onto the 360 sphere at a pan, tilt, roll and size, with a feathered edge — the layer becomes the equirectangular frame (use a 2 : 1 precomp of the graphic). GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'vr-plane-to-sphere',
    label: 'VR Plane to Sphere',
    gpuOnly: true,
    params: [
      { key: 'pan', label: 'Pan', type: 'number', unit: '°', min: -360, max: 360, default: 0 },
      { key: 'tilt', label: 'Tilt', type: 'number', unit: '°', min: -90, max: 90, default: 0 },
      { key: 'roll', label: 'Roll', type: 'number', unit: '°', min: -360, max: 360, default: 0 },
      { key: 'fov', label: 'Size (Field of View)', type: 'number', unit: '°', min: 1, max: 179, default: 60 },
      { key: 'aspect', label: 'Aspect', type: 'number', unit: '%', min: 1, max: 1000, default: 100 },
      { key: 'feather', label: 'Edge Feather', type: 'number', unit: '%', min: 0, max: 50, default: 2 },
    ],
    css: () => '',
  },
  {
    /* After Effects' VR Sharpen: unsharp masking against a spherical blur, seam- and latitude-correct. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'vr-sharpen',
    label: 'VR Sharpen',
    gpuOnly: true,
    params: [
      { key: 'frameLayout', label: 'Frame Layout', type: 'enum', default: 0, options: [{ value: 0, label: 'Monoscopic' }, { value: 1, label: 'Stereo - Over/Under' }, { value: 2, label: 'Stereo - Side by Side' }] },
      { key: 'amount', label: 'Sharpen Amount', type: 'number', unit: '%', min: 0, max: 500, default: 50 },
      { key: 'radius', label: 'Radius', type: 'number', unit: 'px', min: 0.3, max: 100, default: 2 },
      { key: 'threshold', label: 'Threshold', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    /* God rays from the comp's own 3D point and spot lights: each view ray is marched through a participating medium (density noise, Henyey-Greenstein scattering) up to the scene depth, the light shafts occluded by the 3D layers in front of each light. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'volumetric-lights',
    label: 'Volumetric Lights',
    gpuOnly: true,
    params: [
      { key: 'intensity', label: 'Intensity', type: 'number', unit: '%', min: 0, max: 2000, default: 100 },
      { key: 'density', label: 'Density', type: 'number', unit: '%', min: 0, max: 400, default: 30 },
      { key: 'scattering', label: 'Forward Scattering', type: 'number', unit: '%', min: -95, max: 95, default: 40 },
      { key: 'maxDistance', label: 'Max Distance', type: 'number', unit: 'px', min: 100, max: 100000, default: 6000 },
      { key: 'noise', label: 'Density Noise', type: 'number', unit: '%', min: 0, max: 100, default: 40 },
      { key: 'noiseScale', label: 'Noise Scale', type: 'number', unit: 'px', min: 10, max: 20000, default: 400 },
      { key: 'evolution', label: 'Evolution', type: 'number', unit: '°', min: -360000, max: 360000, default: 0 },
      { key: 'shadows', label: 'Occlusion From Depth', type: 'checkbox', default: true },
      { key: 'quality', label: 'Quality (Steps)', type: 'number', min: 8, max: 96, precision: 0, default: 32 },
      { key: 'tint', label: 'Tint', type: 'color', default: '#ffffff' },
      { key: 'mode', label: 'Composite', type: 'enum', default: 0, options: [{ value: 0, label: 'Add' }, { value: 1, label: 'Screen' }, { value: 2, label: 'Lighten' }, { value: 3, label: 'Light Only' }] },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 99999, precision: 0, default: 1 },
    ],
    css: () => '',
  },
  {
    /* Relights a flat layer with the comp's 3D lights: surface normals from its luminance or alpha (bevelled) or a normal-map layer, Lambert diffuse with wrap, Blinn-Phong specular seen from the camera, ambient from ambient lights. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'relight',
    label: 'Relight',
    gpuOnly: true,
    params: [
      { key: 'normalsFrom', label: 'Normals From', type: 'enum', default: 0, options: [{ value: 0, label: 'Luminance' }, { value: 1, label: 'Alpha (Bevel)' }, { value: 2, label: 'Normal Map Layer' }] },
      { key: 'normalLayer', label: 'Normal Map Layer', type: 'layer', default: '' },
      { key: 'depth', label: 'Bump Depth', type: 'number', unit: 'px', min: 0, max: 400, default: 12 },
      { key: 'smoothness', label: 'Smoothness', type: 'number', unit: 'px', min: 0, max: 100, default: 2 },
      { key: 'diffuse', label: 'Diffuse', type: 'number', unit: '%', min: 0, max: 300, default: 100 },
      { key: 'wrap', label: 'Light Wrap', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'specular', label: 'Specular', type: 'number', unit: '%', min: 0, max: 400, default: 40 },
      { key: 'shininess', label: 'Shininess', type: 'number', min: 1, max: 400, default: 30 },
      { key: 'ambient', label: 'Ambient (No Ambient Light)', type: 'number', unit: '%', min: 0, max: 100, default: 25 },
      { key: 'fallbackType', label: 'Without Comp Lights', type: 'enum', default: 0, options: [{ value: 0, label: 'Built-in Key Light' }, { value: 1, label: 'Unlit' }] },
      { key: 'lightAngle', label: 'Key Light Direction', type: 'number', unit: '°', min: -3600, max: 3600, default: -45 },
      { key: 'lightElevation', label: 'Key Light Elevation', type: 'number', unit: '°', min: 0, max: 90, default: 40 },
      { key: 'lightColor', label: 'Key Light Color', type: 'color', default: '#ffffff' },
    ],
    css: () => '',
  },
  {
    /* Ray-marched 3-D clouds seen through the comp camera (they move with it): a slab of fractal density shaped by coverage, lit by a sun (Beer-Lambert with powder, a light march toward the sun), drifting with the wind. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'volumetric-clouds',
    label: 'Volumetric Clouds',
    gpuOnly: true,
    params: [
      { key: 'coverage', label: 'Coverage', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'density', label: 'Density', type: 'number', unit: '%', min: 0, max: 300, default: 60 },
      { key: 'altitude', label: 'Cloud Base Altitude', type: 'number', unit: 'px', min: -100000, max: 100000, default: 1500 },
      { key: 'thickness', label: 'Thickness', type: 'number', unit: 'px', min: 10, max: 50000, default: 1500 },
      { key: 'scale', label: 'Scale', type: 'number', unit: 'px', min: 10, max: 100000, default: 2500 },
      { key: 'detail', label: 'Detail', type: 'number', min: 1, max: 8, precision: 0, default: 5 },
      { key: 'windDirection', label: 'Wind Direction', type: 'number', unit: '°', min: -3600, max: 3600, default: 30 },
      { key: 'windSpeed', label: 'Wind Speed (px/s)', type: 'number', unit: 'px', min: 0, max: 10000, default: 120 },
      { key: 'sunAzimuth', label: 'Sun Azimuth', type: 'number', unit: '°', min: -3600, max: 3600, default: 40 },
      { key: 'sunElevation', label: 'Sun Elevation', type: 'number', unit: '°', min: -10, max: 90, default: 25 },
      { key: 'sunColor', label: 'Sun Color', type: 'color', default: '#fff2dc' },
      { key: 'skyColor', label: 'Ambient Sky', type: 'color', default: '#8fb6e8' },
      { key: 'useLight', label: 'Sun From First Parallel Light', type: 'checkbox', default: true },
      { key: 'quality', label: 'Quality (Steps)', type: 'number', min: 12, max: 128, precision: 0, default: 48 },
      { key: 'composite', label: 'Composite', type: 'enum', default: 0, options: [{ value: 0, label: 'Over Layer' }, { value: 1, label: 'Behind Layer' }, { value: 2, label: 'Clouds Only' }] },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 99999, precision: 0, default: 1 },
      { key: 'followCompTime', label: 'Animate With Time', type: 'checkbox', default: true },
      { key: 'time', label: 'Time', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
    ],
    css: () => '',
  },
  {
    /* A 3-D star field in world space, seen through the comp camera with true parallax and depth fade (several shells of hashed stars), twinkling, with an optional fractal nebula. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'starfield',
    label: 'Starfield',
    gpuOnly: true,
    params: [
      { key: 'density', label: 'Star Density', type: 'number', unit: '%', min: 0, max: 300, default: 50 },
      { key: 'starSize', label: 'Star Size', type: 'number', unit: 'px', min: 0.2, max: 20, default: 1.6 },
      { key: 'brightness', label: 'Brightness', type: 'number', unit: '%', min: 0, max: 1000, default: 100 },
      { key: 'colorVariation', label: 'Color Temperature Spread', type: 'number', unit: '%', min: 0, max: 100, default: 40 },
      { key: 'twinkle', label: 'Twinkle', type: 'number', unit: '%', min: 0, max: 100, default: 30 },
      { key: 'depthRange', label: 'Depth Range', type: 'number', unit: 'px', min: 500, max: 1000000, default: 20000 },
      { key: 'nebula', label: 'Nebula', type: 'number', unit: '%', min: 0, max: 200, default: 30 },
      { key: 'nebulaColor1', label: 'Nebula Color 1', type: 'color', default: '#5b2a86' },
      { key: 'nebulaColor2', label: 'Nebula Color 2', type: 'color', default: '#1d6fa3' },
      { key: 'nebulaScale', label: 'Nebula Scale', type: 'number', unit: 'px', min: 100, max: 200000, default: 8000 },
      { key: 'composite', label: 'Composite', type: 'enum', default: 1, options: [{ value: 0, label: 'Behind Layer' }, { value: 1, label: 'Over Layer' }, { value: 2, label: 'Stars Only' }] },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 99999, precision: 0, default: 1 },
      { key: 'followCompTime', label: 'Animate With Time', type: 'checkbox', default: true },
      { key: 'time', label: 'Time', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
    ],
    css: () => '',
  },
  {
    /* After Effects' CC Environment: an environment layer reflected in the layer — the camera's view ray reflected off the layer's (bumped) surface and looked up in the environment as a sphere map, mirror-ball probe or vertical cross. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'cc-environment',
    label: 'CC Environment',
    gpuOnly: true,
    params: [
      { key: 'environment', label: 'Environment', type: 'layer', default: '' },
      { key: 'mapping', label: 'Mapping', type: 'enum', default: 0, options: [{ value: 0, label: 'Spherical' }, { value: 1, label: 'Probe' }, { value: 2, label: 'Vertical Cross' }] },
      { key: 'horizontalOffset', label: 'Horizontal Offset', type: 'number', unit: '°', min: -3600, max: 3600, default: 0 },
      { key: 'bump', label: 'Surface Bump', type: 'number', unit: 'px', min: 0, max: 200, default: 0 },
      { key: 'reflectivity', label: 'Reflectivity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'fresnel', label: 'Fresnel', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'filter', label: 'Filter Environment', type: 'number', unit: 'px', min: 0, max: 100, default: 0 },
    ],
    css: () => '',
  },
  {
    /* An ocean surface seen through the comp camera: a spectrum of Gerstner waves (height, length, choppiness, wind), Fresnel reflection of a sky gradient and the sun, deep / shallow water colour, foam on the crests, haze to the horizon. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'ocean',
    label: 'Ocean',
    gpuOnly: true,
    params: [
      { key: 'seaLevel', label: 'Sea Level (World Y)', type: 'number', unit: 'px', min: -100000, max: 100000, default: 600 },
      { key: 'waveHeight', label: 'Wave Height', type: 'number', unit: 'px', min: 0, max: 1000, default: 30 },
      { key: 'waveLength', label: 'Wavelength', type: 'number', unit: 'px', min: 10, max: 20000, default: 600 },
      { key: 'choppiness', label: 'Choppiness', type: 'number', unit: '%', min: 0, max: 100, default: 60 },
      { key: 'windDirection', label: 'Wind Direction', type: 'number', unit: '°', min: -3600, max: 3600, default: 0 },
      { key: 'speed', label: 'Speed', type: 'number', min: 0, max: 10, default: 1 },
      { key: 'deepColor', label: 'Deep Color', type: 'color', default: '#08263f' },
      { key: 'shallowColor', label: 'Shallow Color', type: 'color', default: '#1f6e7a' },
      { key: 'skyTop', label: 'Sky Top', type: 'color', default: '#2c5c9c' },
      { key: 'skyHorizon', label: 'Sky Horizon', type: 'color', default: '#c9dcec' },
      { key: 'sunAzimuth', label: 'Sun Azimuth', type: 'number', unit: '°', min: -3600, max: 3600, default: 20 },
      { key: 'sunElevation', label: 'Sun Elevation', type: 'number', unit: '°', min: -10, max: 90, default: 12 },
      { key: 'sunColor', label: 'Sun Color', type: 'color', default: '#fff0d0' },
      { key: 'foam', label: 'Foam', type: 'number', unit: '%', min: 0, max: 200, default: 40 },
      { key: 'fogDistance', label: 'Haze Distance', type: 'number', unit: 'px', min: 100, max: 1000000, default: 40000 },
      { key: 'showSky', label: 'Draw Sky', type: 'checkbox', default: true },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 99999, precision: 0, default: 1 },
      { key: 'followCompTime', label: 'Animate With Time', type: 'checkbox', default: true },
      { key: 'time', label: 'Time', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
    ],
    css: () => '',
  },
  {
    /* Aurora borealis seen through the comp camera: ray-marched curtains whose folds flow with fractal noise, coloured by altitude (green to magenta), with stars behind. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'aurora',
    label: 'Aurora',
    gpuOnly: true,
    params: [
      { key: 'intensity', label: 'Intensity', type: 'number', unit: '%', min: 0, max: 1000, default: 100 },
      { key: 'altitude', label: 'Altitude', type: 'number', unit: 'px', min: -100000, max: 100000, default: 3000 },
      { key: 'height', label: 'Curtain Height', type: 'number', unit: 'px', min: 100, max: 50000, default: 2500 },
      { key: 'scale', label: 'Fold Scale', type: 'number', unit: 'px', min: 50, max: 100000, default: 3000 },
      { key: 'speed', label: 'Flow Speed', type: 'number', min: 0, max: 10, default: 1 },
      { key: 'lowColor', label: 'Lower Color', type: 'color', default: '#3cff9e' },
      { key: 'highColor', label: 'Upper Color', type: 'color', default: '#b44dff' },
      { key: 'stars', label: 'Stars', type: 'number', unit: '%', min: 0, max: 200, default: 50 },
      { key: 'quality', label: 'Quality (Steps)', type: 'number', min: 12, max: 96, precision: 0, default: 40 },
      { key: 'composite', label: 'Composite', type: 'enum', default: 1, options: [{ value: 0, label: 'Behind Layer' }, { value: 1, label: 'Over Layer' }, { value: 2, label: 'Aurora Only' }] },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 99999, precision: 0, default: 1 },
      { key: 'followCompTime', label: 'Animate With Time', type: 'checkbox', default: true },
      { key: 'time', label: 'Time', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
    ],
    css: () => '',
  },
  {
    /* A mask path stroked in 3-D (Trapcode 3D Stroke class) through the comp camera: thickness with taper, start / end / offset trimming with loop, and a repeater of copies stepped in z, scale and rotation, each shaded by depth. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'stroke-3d',
    label: '3D Stroke',
    gpuOnly: true,
    params: [
      { key: 'pathMask', label: 'Path', type: 'maskPath', noneLabel: 'Mask 1 (first mask)', default: '' },
      { key: 'color', label: 'Color', type: 'color', default: '#7fd4ff' },
      { key: 'thickness', label: 'Thickness', type: 'number', unit: 'px', min: 0.1, max: 400, default: 8 },
      { key: 'feather', label: 'Feather', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'start', label: 'Start', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'end', label: 'End', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'offset', label: 'Offset', type: 'number', unit: '%', min: -10000, max: 10000, default: 0 },
      { key: 'loop', label: 'Loop', type: 'checkbox', default: false },
      { key: 'taperStart', label: 'Taper Start', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'taperEnd', label: 'Taper End', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'repeater', label: 'Repeater', type: 'checkbox', group: 'Repeater', default: false },
      { key: 'instances', label: 'Instances', type: 'number', group: 'Repeater', min: 1, max: 16, precision: 0, default: 4 },
      { key: 'opacityFade', label: 'Opacity Fade', type: 'number', group: 'Repeater', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'zDisplace', label: 'Z Displace', type: 'number', group: 'Repeater', unit: 'px', min: -10000, max: 10000, default: 120 },
      { key: 'scaleStep', label: 'Scale', type: 'number', group: 'Repeater', unit: '%', min: 1, max: 400, default: 100 },
      { key: 'rotateX', label: 'X Rotation', type: 'number', group: 'Repeater', unit: '°', min: -360, max: 360, default: 0 },
      { key: 'rotateY', label: 'Y Rotation', type: 'number', group: 'Repeater', unit: '°', min: -360, max: 360, default: 0 },
      { key: 'rotateZ', label: 'Z Rotation', type: 'number', group: 'Repeater', unit: '°', min: -360, max: 360, default: 15 },
      { key: 'depthFade', label: 'Depth Fade', type: 'checkbox', default: true },
      { key: 'composite', label: 'Composite', type: 'enum', default: 0, options: [{ value: 0, label: 'Over Layer' }, { value: 1, label: 'On Transparent' }] },
    ],
    css: () => '',
  },
  {
    /* After Effects' Timewarp: the layer retimed by a speed or a source frame, its in-between frames made by whole frames, frame mix, or pixel motion (GPU pyramidal Lucas-Kanade optical flow, both frames warped to the instant and blended), with motion blur along the flow. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'timewarp',
    label: 'Timewarp',
    gpuOnly: true,
    params: [
      { key: 'method', label: 'Method', type: 'enum', default: 2, options: [{ value: 0, label: 'Whole Frames' }, { value: 1, label: 'Frame Mix' }, { value: 2, label: 'Pixel Motion' }] },
      { key: 'adjustBy', label: 'Adjust Time By', type: 'enum', default: 0, options: [{ value: 0, label: 'Speed' }, { value: 1, label: 'Source Frame' }] },
      { key: 'speed', label: 'Speed', type: 'number', unit: '%', min: -1000, max: 1000, default: 50 },
      { key: 'sourceFrame', label: 'Source Frame', type: 'number', min: -100000, max: 100000, default: 0 },
      { key: 'vectorDetail', label: 'Vector Detail', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'motionBlur', label: 'Enable Motion Blur', type: 'checkbox', default: false },
      { key: 'shutterAngle', label: 'Shutter Angle', type: 'number', unit: '°', min: 0, max: 720, default: 180 },
      { key: 'shutterSamples', label: 'Shutter Samples', type: 'number', min: 2, max: 32, precision: 0, default: 8 },
      { key: 'followCompTime', label: 'Animate With Time', type: 'checkbox', default: true },
      { key: 'time', label: 'Time', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
    ],
    css: () => '',
  },
  {
    /* After Effects' Pixel Motion Blur: the motion of every pixel (optical flow between the frames before and after) blurs the layer along its path, by a shutter angle. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'pixel-motion-blur',
    label: 'Pixel Motion Blur',
    gpuOnly: true,
    params: [
      { key: 'shutterAngle', label: 'Shutter Angle', type: 'number', unit: '°', min: 0, max: 720, default: 180 },
      { key: 'shutterSamples', label: 'Shutter Samples', type: 'number', min: 2, max: 64, precision: 0, default: 12 },
      { key: 'vectorDetail', label: 'Vector Detail', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
    ],
    css: () => '',
  },
  {
    /* After Effects' Time Displacement: each pixel shows the layer at a time offset read from a map layer's luminance (white = later, black = earlier, by the maximum), blended between five sampled instants, quantised by a time resolution. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'time-displacement',
    label: 'Time Displacement',
    gpuOnly: true,
    params: [
      { key: 'mapLayer', label: 'Time Displacement Layer', type: 'layer', noneLabel: 'None (this layer)', default: '' },
      { key: 'maxDisplacement', label: 'Max Displacement Time (sec)', type: 'number', min: -60, max: 60, precision: 2, default: 1 },
      { key: 'timeResolution', label: 'Time Resolution (fps)', type: 'number', min: 1, max: 120, default: 60 },
      { key: 'smooth', label: 'Blend Between Frames', type: 'checkbox', default: true },
    ],
    css: () => '',
  },
  {
    /* After Effects' Time Difference: the difference between the layer and itself at a time offset, absolute or signed, with contrast and its alpha modes. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'time-difference',
    label: 'Time Difference',
    gpuOnly: true,
    params: [
      { key: 'timeOffset', label: 'Time Offset (sec)', type: 'number', min: -60, max: 60, precision: 3, default: -0.1 },
      { key: 'contrast', label: 'Contrast', type: 'number', unit: '%', min: 0, max: 1000, default: 100 },
      { key: 'absolute', label: 'Absolute Difference', type: 'checkbox', default: true },
      { key: 'alphaChannel', label: 'Alpha Channel', type: 'enum', default: 0, options: [{ value: 0, label: 'Original' }, { value: 1, label: 'Target' }, { value: 2, label: 'Blend' }, { value: 3, label: 'Max' }, { value: 4, label: 'Full On' }, { value: 5, label: 'Lightness of Result' }, { value: 6, label: 'Max of Result' }, { value: 7, label: 'Alpha Difference' }] },
    ],
    css: () => '',
  },
  {
    /* CC Time Blend: the layer accumulated with its last four sampled frames (spaced by a frame step), each folded in by the transfer mode and the accumulation persistence. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'time-blend',
    label: 'CC Time Blend',
    gpuOnly: true,
    params: [
      { key: 'transfer', label: 'Transfer', type: 'enum', default: 0, options: [{ value: 0, label: 'Add' }, { value: 1, label: 'Screen' }, { value: 2, label: 'Lighten' }, { value: 3, label: 'Darken' }, { value: 4, label: 'Difference' }, { value: 5, label: 'Blend' }] },
      { key: 'accumulation', label: 'Accumulation', type: 'number', unit: '%', min: 0, max: 100, default: 70 },
      { key: 'frameStep', label: 'Frame Step', type: 'number', min: 1, max: 30, precision: 0, default: 2 },
    ],
    css: () => '',
  },
  {
    /* Light trails: the layer's highlights in its last four sampled frames (over a trail length) streaming behind it, coloured from head to tail and fading. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'light-trails',
    label: 'Light Trails',
    gpuOnly: true,
    params: [
      { key: 'threshold', label: 'Threshold', type: 'number', unit: '%', min: 0, max: 100, default: 60 },
      { key: 'trailLength', label: 'Trail Length (frames)', type: 'number', min: 4, max: 120, precision: 0, default: 12 },
      { key: 'decay', label: 'Decay', type: 'number', unit: '%', min: 0, max: 100, default: 60 },
      { key: 'headColor', label: 'Head Color', type: 'color', default: '#fff3c4' },
      { key: 'tailColor', label: 'Tail Color', type: 'color', default: '#ff3d7f' },
      { key: 'intensity', label: 'Intensity', type: 'number', unit: '%', min: 0, max: 1000, default: 120 },
      { key: 'mode', label: 'Composite', type: 'enum', default: 0, options: [{ value: 0, label: 'Add' }, { value: 1, label: 'Screen' }, { value: 2, label: 'Lighten' }, { value: 3, label: 'Light Only' }] },
    ],
    css: () => '',
  },
  {
    /* The compression-glitch look: a held frame's pixels dragged by the live footage's block motion (optical flow quantised to macroblocks), bleeding where motion is strong. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'datamosh',
    label: 'Datamosh',
    gpuOnly: true,
    params: [
      { key: 'holdTime', label: 'Hold Frame Time (sec)', type: 'number', min: -100000, max: 100000, precision: 3, default: 0 },
      { key: 'intensity', label: 'Mosh Intensity', type: 'number', unit: '%', min: 0, max: 1000, default: 100 },
      { key: 'blockSize', label: 'Block Size', type: 'number', unit: 'px', min: 2, max: 128, default: 16 },
      { key: 'bleed', label: 'Bleed', type: 'number', unit: '%', min: 0, max: 100, default: 15 },
      { key: 'threshold', label: 'Motion Threshold', type: 'number', unit: '%', min: 0, max: 100, default: 5 },
      { key: 'followCompTime', label: 'Animate With Time', type: 'checkbox', default: true },
      { key: 'time', label: 'Time', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
    ],
    css: () => '',
  },
  {
    /* A temporal denoiser: the frames before and after, motion-compensated by optical flow, averaged into this one where they agree (occlusions rejected by colour distance), then an edge-preserving spatial pass, with detail kept. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'temporal-denoise',
    label: 'Denoiser',
    gpuOnly: true,
    params: [
      { key: 'strength', label: 'Temporal Strength', type: 'number', unit: '%', min: 0, max: 100, default: 70 },
      { key: 'spatial', label: 'Spatial Strength', type: 'number', unit: '%', min: 0, max: 100, default: 30 },
      { key: 'detail', label: 'Detail Preservation', type: 'number', unit: '%', min: 0, max: 100, default: 40 },
    ],
    css: () => '',
  },
  {
    /* A stable-fluids simulation (semi-Lagrangian advection, vorticity confinement, a Jacobi pressure projection) seeded with the layer as dye at the start time and driven by its emission, a push and curl-noise turbulence; any frame is reproducible (checkpointed state). GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'fluid-ink',
    label: 'Fluid Ink',
    gpuOnly: true,
    params: [
      { key: 'resolution', label: 'Simulation Resolution', type: 'enum', default: 1, options: [{ value: 0, label: 'Draft (192)' }, { value: 1, label: 'Medium (320)' }, { value: 2, label: 'High (448)' }, { value: 3, label: 'Ultra (640)' }] },
      { key: 'startTime', label: 'Start Time (sec)', type: 'number', min: -100000, max: 100000, precision: 2, default: 0 },
      { key: 'dye', label: 'Initial Dye', type: 'number', unit: '%', min: 0, max: 200, default: 100 },
      { key: 'emission', label: 'Continuous Emission', type: 'number', unit: '%', min: 0, max: 200, default: 20 },
      { key: 'pushAngle', label: 'Push Direction', type: 'number', unit: '°', min: -3600, max: 3600, default: -90 },
      { key: 'pushSpeed', label: 'Push Speed (px/s)', type: 'number', unit: 'px', min: 0, max: 5000, default: 120 },
      { key: 'turbulence', label: 'Turbulence', type: 'number', unit: '%', min: 0, max: 400, default: 50 },
      { key: 'turbulenceScale', label: 'Turbulence Scale', type: 'number', unit: 'px', min: 5, max: 5000, default: 160 },
      { key: 'vorticity', label: 'Curl (Vorticity)', type: 'number', unit: '%', min: 0, max: 400, default: 40 },
      { key: 'viscosity', label: 'Velocity Damping', type: 'number', unit: '%', min: 0, max: 100, default: 10 },
      { key: 'dissipation', label: 'Dye Fade', type: 'number', unit: '%', min: 0, max: 100, default: 5 },
      { key: 'pressureIterations', label: 'Pressure Iterations', type: 'number', min: 8, max: 80, precision: 0, default: 24 },
      { key: 'speed', label: 'Simulation Speed', type: 'number', min: 0.1, max: 8, default: 1 },
      { key: 'colorMode', label: 'Ink Colors', type: 'enum', default: 0, options: [{ value: 0, label: 'Layer Colors' }, { value: 1, label: 'Tint' }] },
      { key: 'tint', label: 'Tint', type: 'color', default: '#2a6cff' },
      { key: 'composite', label: 'Composite', type: 'enum', default: 0, options: [{ value: 0, label: 'Ink Over Layer' }, { value: 1, label: 'Ink Only' }, { value: 2, label: 'Ink Behind Layer' }] },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 99999, precision: 0, default: 1 },
      { key: 'followCompTime', label: 'Animate With Time', type: 'checkbox', default: true },
      { key: 'time', label: 'Time', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
    ],
    css: () => '',
  },
  {
    /* A Gray-Scott reaction-diffusion simulation seeded from the layer at the start time (or random spots), its feed modulated by the layer's luminance, grown frame by frame into coral, spots or labyrinths; reproducible at any frame (checkpointed state). GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'reaction-diffusion',
    label: 'Reaction-Diffusion',
    gpuOnly: true,
    params: [
      { key: 'resolution', label: 'Simulation Resolution', type: 'enum', default: 1, options: [{ value: 0, label: 'Draft (256)' }, { value: 1, label: 'Medium (384)' }, { value: 2, label: 'High (512)' }, { value: 3, label: 'Ultra (768)' }] },
      { key: 'startTime', label: 'Start Time (sec)', type: 'number', min: -100000, max: 100000, precision: 2, default: 0 },
      { key: 'preset', label: 'Pattern', type: 'enum', default: 1, options: [{ value: 0, label: 'Custom' }, { value: 1, label: 'Coral' }, { value: 2, label: 'Mitosis' }, { value: 3, label: 'Labyrinth' }, { value: 4, label: 'Spots' }, { value: 5, label: 'Worms' }] },
      { key: 'feed', label: 'Feed Rate', type: 'number', min: 0.001, max: 0.12, precision: 4, default: 0.0545 },
      { key: 'kill', label: 'Kill Rate', type: 'number', min: 0.001, max: 0.12, precision: 4, default: 0.062 },
      { key: 'diffusionA', label: 'Diffusion A', type: 'number', min: 0.1, max: 2, precision: 2, default: 1 },
      { key: 'diffusionB', label: 'Diffusion B', type: 'number', min: 0.05, max: 1.5, precision: 2, default: 0.5 },
      { key: 'speed', label: 'Steps per Frame', type: 'number', min: 1, max: 200, precision: 0, default: 24 },
      { key: 'seedFrom', label: 'Seed From', type: 'enum', default: 0, options: [{ value: 0, label: 'Layer Alpha' }, { value: 1, label: 'Layer Luminance' }, { value: 2, label: 'Random Spots' }] },
      { key: 'feedMap', label: 'Feed From Layer Luminance', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'colorA', label: 'Background Color', type: 'color', default: '#0d1b2a' },
      { key: 'colorB', label: 'Pattern Color', type: 'color', default: '#f2e8cf' },
      { key: 'sharpness', label: 'Sharpness', type: 'number', unit: '%', min: 0, max: 100, default: 60 },
      { key: 'composite', label: 'Composite', type: 'enum', default: 0, options: [{ value: 0, label: 'Replace Layer' }, { value: 1, label: 'Over Layer' }, { value: 2, label: 'Inside Layer Alpha' }] },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 99999, precision: 0, default: 1 },
      { key: 'followCompTime', label: 'Animate With Time', type: 'checkbox', default: true },
      { key: 'time', label: 'Time', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
    ],
    css: () => '',
  },
  {
    /* Dendritic crystal (snowflake / frost) growth by Kobayashi's anisotropic phase-field model — phase and temperature fields with latent heat — nucleated from the layer at the start time; reproducible at any frame (checkpointed state). GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'crystal-growth',
    label: 'Crystal Growth',
    gpuOnly: true,
    params: [
      { key: 'resolution', label: 'Simulation Resolution', type: 'enum', default: 1, options: [{ value: 0, label: 'Draft (256)' }, { value: 1, label: 'Medium (384)' }, { value: 2, label: 'High (512)' }, { value: 3, label: 'Ultra (768)' }] },
      { key: 'startTime', label: 'Start Time (sec)', type: 'number', min: -100000, max: 100000, precision: 2, default: 0 },
      { key: 'symmetry', label: 'Symmetry (Arms)', type: 'number', min: 2, max: 12, precision: 0, default: 6 },
      { key: 'anisotropy', label: 'Anisotropy', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'angle', label: 'Orientation', type: 'number', unit: '°', min: -3600, max: 3600, default: 0 },
      { key: 'latentHeat', label: 'Latent Heat', type: 'number', min: 0.8, max: 3, precision: 2, default: 1.8 },
      { key: 'noise', label: 'Irregularity', type: 'number', unit: '%', min: 0, max: 100, default: 20 },
      { key: 'speed', label: 'Growth Speed', type: 'number', min: 1, max: 200, precision: 0, default: 30 },
      { key: 'color', label: 'Crystal Color', type: 'color', default: '#cfe8ff' },
      { key: 'glow', label: 'Edge Glow', type: 'number', unit: '%', min: 0, max: 400, default: 60 },
      { key: 'composite', label: 'Composite', type: 'enum', default: 0, options: [{ value: 0, label: 'Crystal Over Layer' }, { value: 1, label: 'Crystal Only' }, { value: 2, label: 'Frost (Inside Layer)' }] },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 99999, precision: 0, default: 1 },
      { key: 'followCompTime', label: 'Animate With Time', type: 'checkbox', default: true },
      { key: 'time', label: 'Time', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
    ],
    css: () => '',
  },
  {
    /* CC Mr. Mercury: liquid blobs emitted from a producer that fly under velocity, gravity and resistance (closed-form physics per blob, any frame in any order), merging as metaballs with lit, reflective mercury shading and the layer's colours. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'mr-mercury',
    label: 'CC Mr. Mercury',
    gpuOnly: true,
    params: [
      { key: 'producerX', label: 'Producer X', type: 'number', unit: 'px', min: -100000, max: 100000, default: 0 },
      { key: 'producerY', label: 'Producer Y', type: 'number', unit: 'px', min: -100000, max: 100000, default: 0 },
      { key: 'radiusX', label: 'Radius X', type: 'number', unit: 'px', min: 0, max: 4000, default: 40 },
      { key: 'radiusY', label: 'Radius Y', type: 'number', unit: 'px', min: 0, max: 4000, default: 10 },
      { key: 'direction', label: 'Direction', type: 'number', unit: '°', min: -3600, max: 3600, default: 0 },
      { key: 'spread', label: 'Direction Spread', type: 'number', unit: '%', min: 0, max: 100, default: 25 },
      { key: 'velocity', label: 'Velocity (px/s)', type: 'number', unit: 'px', min: 0, max: 10000, default: 260 },
      { key: 'birthRate', label: 'Birth Rate (/s)', type: 'number', min: 0.5, max: 400, default: 30 },
      { key: 'longevity', label: 'Longevity (sec)', type: 'number', min: 0.1, max: 30, default: 2.5 },
      { key: 'gravity', label: 'Gravity (px/s²)', type: 'number', unit: 'px', min: -10000, max: 10000, default: 400 },
      { key: 'resistance', label: 'Resistance', type: 'number', unit: '%', min: 0, max: 400, default: 20 },
      { key: 'turbulence', label: 'Extra (Turbulence)', type: 'number', unit: '%', min: 0, max: 400, default: 20 },
      { key: 'birthSize', label: 'Blob Birth Size', type: 'number', unit: 'px', min: 1, max: 400, default: 22 },
      { key: 'deathSize', label: 'Blob Death Size', type: 'number', unit: 'px', min: 0, max: 400, default: 8 },
      { key: 'influence', label: 'Blob Influence', type: 'number', unit: '%', min: 1, max: 400, default: 100 },
      { key: 'colorFrom', label: 'Color', type: 'enum', default: 1, options: [{ value: 0, label: 'Layer at Producer' }, { value: 1, label: 'Mercury' }, { value: 2, label: 'Custom' }] },
      { key: 'color', label: 'Custom Color', type: 'color', default: '#c0c8d0' },
      { key: 'lightAngle', label: 'Light Direction', type: 'number', unit: '°', min: -3600, max: 3600, default: -45 },
      { key: 'specular', label: 'Specular', type: 'number', unit: '%', min: 0, max: 400, default: 120 },
      { key: 'reflection', label: 'Reflection', type: 'number', unit: '%', min: 0, max: 100, default: 60 },
      { key: 'composite', label: 'Composite', type: 'enum', default: 0, options: [{ value: 0, label: 'Over Layer' }, { value: 1, label: 'Blobs Only' }] },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 99999, precision: 0, default: 1 },
      { key: 'followCompTime', label: 'Animate With Time', type: 'checkbox', default: true },
      { key: 'time', label: 'Time', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
    ],
    css: () => '',
  },
  {
    /* After Effects' Foam: soap bubbles born from a producer, growing, wobbling, carried by wind, popping at the end of their life — each a thin film with iridescent interference colour, a rim and a highlight; closed-form, any frame in any order. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'foam',
    label: 'Foam',
    gpuOnly: true,
    params: [
      { key: 'producerX', label: 'Producer Point X', type: 'number', unit: 'px', min: -100000, max: 100000, default: 0 },
      { key: 'producerY', label: 'Producer Point Y', type: 'number', unit: 'px', min: -100000, max: 100000, default: 200 },
      { key: 'producerWidth', label: 'Producer X Size', type: 'number', unit: 'px', min: 0, max: 4000, default: 200 },
      { key: 'producerHeight', label: 'Producer Y Size', type: 'number', unit: 'px', min: 0, max: 4000, default: 20 },
      { key: 'birthRate', label: 'Production Rate (/s)', type: 'number', min: 0.5, max: 200, default: 12 },
      { key: 'bubbleSize', label: 'Size', type: 'number', unit: 'px', min: 2, max: 400, default: 26 },
      { key: 'sizeVariance', label: 'Size Variance', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'lifespan', label: 'Lifespan (sec)', type: 'number', min: 0.2, max: 30, default: 4 },
      { key: 'growth', label: 'Bubble Growth Speed', type: 'number', unit: '%', min: 0, max: 300, default: 30 },
      { key: 'riseSpeed', label: 'Initial Speed (px/s)', type: 'number', unit: 'px', min: 0, max: 3000, default: 70 },
      { key: 'windDirection', label: 'Wind Direction', type: 'number', unit: '°', min: -3600, max: 3600, default: -90 },
      { key: 'windSpeed', label: 'Wind Speed (px/s)', type: 'number', unit: 'px', min: 0, max: 2000, default: 20 },
      { key: 'wobble', label: 'Wobble Amount', type: 'number', unit: '%', min: 0, max: 200, default: 40 },
      { key: 'iridescence', label: 'Iridescence', type: 'number', unit: '%', min: 0, max: 200, default: 80 },
      { key: 'reflection', label: 'Reflection Strength', type: 'number', unit: '%', min: 0, max: 200, default: 60 },
      { key: 'opacity', label: 'Bubble Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 85 },
      { key: 'composite', label: 'Composite', type: 'enum', default: 0, options: [{ value: 0, label: 'Over Layer' }, { value: 1, label: 'Bubbles Only' }] },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 99999, precision: 0, default: 1 },
      { key: 'followCompTime', label: 'Animate With Time', type: 'checkbox', default: true },
      { key: 'time', label: 'Time', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
    ],
    css: () => '',
  },
  {
    /* CC Hair: strands grown from the layer's alpha on a jittered grid — length, thickness, density, weight (droop), wind and noise curl — coloured from the layer and shaded as fibres (Kajiya-Kay highlights). GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'hair',
    label: 'CC Hair',
    gpuOnly: true,
    params: [
      { key: 'length', label: 'Length', type: 'number', unit: 'px', min: 1, max: 1000, default: 30 },
      { key: 'lengthVariance', label: 'Length Variance', type: 'number', unit: '%', min: 0, max: 100, default: 40 },
      { key: 'thickness', label: 'Thickness', type: 'number', unit: 'px', min: 0.2, max: 20, default: 1.2 },
      { key: 'density', label: 'Density (spacing)', type: 'number', unit: 'px', min: 1.5, max: 60, default: 5 },
      { key: 'weight', label: 'Weight', type: 'number', unit: '%', min: -400, max: 400, default: 40 },
      { key: 'hairAngle', label: 'Direction', type: 'number', unit: '°', min: -3600, max: 3600, default: -90 },
      { key: 'directionVariance', label: 'Direction Variance', type: 'number', unit: '%', min: 0, max: 100, default: 25 },
      { key: 'curl', label: 'Curl', type: 'number', unit: '%', min: 0, max: 300, default: 20 },
      { key: 'wind', label: 'Wind', type: 'number', unit: '%', min: -400, max: 400, default: 0 },
      { key: 'windPhase', label: 'Wind Phase', type: 'number', unit: '°', min: -360000, max: 360000, default: 0 },
      { key: 'colorFrom', label: 'Color', type: 'enum', default: 0, options: [{ value: 0, label: 'Layer at Root' }, { value: 1, label: 'Custom' }] },
      { key: 'color', label: 'Hair Color', type: 'color', default: '#3b2412' },
      { key: 'lightAngle', label: 'Light Direction', type: 'number', unit: '°', min: -3600, max: 3600, default: -60 },
      { key: 'specular', label: 'Specular', type: 'number', unit: '%', min: 0, max: 300, default: 60 },
      { key: 'keepLayer', label: 'Composite on Original', type: 'checkbox', default: true },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 99999, precision: 0, default: 1 },
    ],
    css: () => '',
  },
  {
    /* Rain on a window over the layer: static droplets at several sizes and running drops that slide and wiggle down leaving trails, each refracting the picture behind as a lens, over fogged (blurred) glass that the trails wipe clear. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'rain-on-glass',
    label: 'Rain on Glass',
    gpuOnly: true,
    params: [
      { key: 'amount', label: 'Rain Amount', type: 'number', unit: '%', min: 0, max: 200, default: 60 },
      { key: 'dropSize', label: 'Drop Size', type: 'number', unit: 'px', min: 2, max: 200, default: 22 },
      { key: 'speed', label: 'Fall Speed', type: 'number', min: 0, max: 10, default: 1 },
      { key: 'trails', label: 'Trails', type: 'number', unit: '%', min: 0, max: 100, default: 70 },
      { key: 'fog', label: 'Fog', type: 'number', unit: '%', min: 0, max: 100, default: 60 },
      { key: 'fogBlur', label: 'Fog Blur', type: 'number', unit: 'px', min: 0, max: 100, default: 10 },
      { key: 'refraction', label: 'Refraction', type: 'number', unit: '%', min: 0, max: 300, default: 100 },
      { key: 'highlight', label: 'Highlights', type: 'number', unit: '%', min: 0, max: 200, default: 40 },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 99999, precision: 0, default: 1 },
      { key: 'followCompTime', label: 'Animate With Time', type: 'checkbox', default: true },
      { key: 'time', label: 'Time', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
    ],
    css: () => '',
  },
  {
    /* CC Particle World: 3-D particles from a producer box seen through the comp camera — birth rate, longevity, velocity, gravity, resistance and turbulence in closed form — rendered as lines, faded or shaded spheres, stars or bubbles, sized and coloured from birth to death, depth sorted in screen tiles. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'particle-world',
    label: 'CC Particle World',
    gpuOnly: true,
    params: [
      { key: 'producerX', label: 'Producer Position X', type: 'number', group: 'Producer', unit: 'px', min: -100000, max: 100000, default: 0 },
      { key: 'producerY', label: 'Producer Position Y', type: 'number', group: 'Producer', unit: 'px', min: -100000, max: 100000, default: 0 },
      { key: 'producerZ', label: 'Producer Position Z', type: 'number', group: 'Producer', unit: 'px', min: -100000, max: 100000, default: 0 },
      { key: 'radiusX', label: 'Radius X', type: 'number', group: 'Producer', unit: 'px', min: 0, max: 10000, default: 20 },
      { key: 'radiusY', label: 'Radius Y', type: 'number', group: 'Producer', unit: 'px', min: 0, max: 10000, default: 20 },
      { key: 'radiusZ', label: 'Radius Z', type: 'number', group: 'Producer', unit: 'px', min: 0, max: 10000, default: 20 },
      { key: 'birthRate', label: 'Birth Rate (/s)', type: 'number', group: 'Physics', min: 1, max: 2000, default: 120 },
      { key: 'longevity', label: 'Longevity (sec)', type: 'number', group: 'Physics', min: 0.1, max: 30, default: 2 },
      { key: 'animation', label: 'Animation', type: 'enum', group: 'Physics', default: 0, options: [{ value: 0, label: 'Explosive' }, { value: 1, label: 'Direction Axis' }, { value: 2, label: 'Cone Axis' }, { value: 3, label: 'Fractal Omni' }] },
      { key: 'velocity', label: 'Velocity (px/s)', type: 'number', group: 'Physics', unit: 'px', min: 0, max: 20000, default: 300 },
      { key: 'gravity', label: 'Gravity (px/s²)', type: 'number', group: 'Physics', unit: 'px', min: -20000, max: 20000, default: 200 },
      { key: 'resistance', label: 'Resistance', type: 'number', group: 'Physics', unit: '%', min: 0, max: 400, default: 0 },
      { key: 'extra', label: 'Extra (Turbulence)', type: 'number', group: 'Physics', unit: '%', min: 0, max: 400, default: 20 },
      { key: 'axisX', label: 'Direction Axis X', type: 'number', group: 'Physics', unit: '°', min: -360, max: 360, default: 0 },
      { key: 'axisY', label: 'Direction Axis Y', type: 'number', group: 'Physics', unit: '°', min: -360, max: 360, default: -90 },
      { key: 'particleType', label: 'Particle Type', type: 'enum', group: 'Particle', default: 1, options: [{ value: 0, label: 'Line' }, { value: 1, label: 'Faded Sphere' }, { value: 2, label: 'Shaded Sphere' }, { value: 3, label: 'Star' }, { value: 4, label: 'Bubble' }] },
      { key: 'birthSize', label: 'Birth Size', type: 'number', group: 'Particle', unit: 'px', min: 0.1, max: 400, default: 6 },
      { key: 'deathSize', label: 'Death Size', type: 'number', group: 'Particle', unit: 'px', min: 0, max: 400, default: 1 },
      { key: 'sizeVariation', label: 'Size Variation', type: 'number', group: 'Particle', unit: '%', min: 0, max: 100, default: 30 },
      { key: 'maxOpacity', label: 'Max Opacity', type: 'number', group: 'Particle', unit: '%', min: 0, max: 100, default: 90 },
      { key: 'birthColor', label: 'Birth Color', type: 'color', group: 'Particle', default: '#fff2a8' },
      { key: 'deathColor', label: 'Death Color', type: 'color', group: 'Particle', default: '#ff3b1f' },
      { key: 'composite', label: 'Transfer Mode', type: 'enum', group: 'Particle', default: 0, options: [{ value: 0, label: 'Add' }, { value: 1, label: 'Over' }] },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 99999, precision: 0, default: 1 },
      { key: 'followCompTime', label: 'Animate With Time', type: 'checkbox', default: true },
      { key: 'time', label: 'Time', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
    ],
    css: () => '',
  },
  {
    /* After Effects' Warp Stabilizer, windowed: the camera's motion to the frames around this one (optical flow reduced to a similarity transform per frame on the GPU) smoothed over the window; the frame warped by the difference, auto-scaled to hide the edges. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'warp-stabilizer',
    label: 'Warp Stabilizer',
    gpuOnly: true,
    params: [
      { key: 'method', label: 'Method', type: 'enum', default: 0, options: [{ value: 0, label: 'Position' }, { value: 1, label: 'Position, Scale, Rotation' }] },
      { key: 'window', label: 'Smoothness (frames)', type: 'number', min: 1, max: 30, precision: 0, default: 6 },
      { key: 'strength', label: 'Stabilization', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'framing', label: 'Framing', type: 'enum', default: 0, options: [{ value: 0, label: 'Stabilize, Crop, Auto-scale' }, { value: 1, label: 'Stabilize Only' }] },
      { key: 'maxScale', label: 'Maximum Scale', type: 'number', unit: '%', min: 100, max: 200, default: 115 },
      { key: 'vectorDetail', label: 'Detail Analysis', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
    ],
    css: () => '',
  },
  {
    /* After Effects' Match Grain: the grain of a source layer measured on the GPU (high-pass deviation per channel and its colour correlation), synthesised as filtered noise of the matching size and strength over the layer, compensating its own noise. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'match-grain',
    label: 'Match Grain',
    gpuOnly: true,
    params: [
      { key: 'sourceLayer', label: 'Noise Source Layer', type: 'layer', noneLabel: 'None (this layer)', default: '' },
      { key: 'intensity', label: 'Intensity', type: 'number', unit: '%', min: 0, max: 400, default: 100 },
      { key: 'size', label: 'Grain Size', type: 'number', unit: 'px', min: 0.3, max: 10, default: 1.2 },
      { key: 'softness', label: 'Softness', type: 'number', unit: '%', min: 0, max: 100, default: 30 },
      { key: 'aspect', label: 'Aspect Ratio', type: 'number', min: 0.25, max: 4, precision: 2, default: 1 },
      { key: 'compensate', label: 'Compensate Existing Noise', type: 'checkbox', default: true },
      { key: 'monochrome', label: 'Monochromatic', type: 'checkbox', default: false },
      { key: 'saturation', label: 'Saturation', type: 'number', unit: '%', min: 0, max: 200, default: 100 },
      { key: 'shadows', label: 'Shadows', type: 'number', unit: '%', min: 0, max: 200, default: 100 },
      { key: 'midtones', label: 'Midtones', type: 'number', unit: '%', min: 0, max: 200, default: 100 },
      { key: 'highlights', label: 'Highlights', type: 'number', unit: '%', min: 0, max: 200, default: 100 },
      { key: 'animate', label: 'Animate Grain', type: 'checkbox', default: true },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 99999, precision: 0, default: 1 },
      { key: 'followCompTime', label: 'Animate With Time', type: 'checkbox', default: true },
      { key: 'time', label: 'Time', type: 'number', unit: 's', min: -86400, max: 86400, precision: 3, default: 0 },
    ],
    css: () => '',
  },
  {
    /* After Effects' Color Stabilizer: the black, mid and white sample points measured at a reference frame (a time tap) and now; brightness, levels or a three-point curve brings this frame back to the reference. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'color-stabilizer',
    label: 'Color Stabilizer',
    gpuOnly: true,
    params: [
      { key: 'stabilize', label: 'Stabilize', type: 'enum', default: 2, options: [{ value: 0, label: 'Brightness' }, { value: 1, label: 'Levels' }, { value: 2, label: 'Curves' }] },
      { key: 'referenceTime', label: 'Reference Frame Time (sec)', type: 'number', min: -100000, max: 100000, precision: 3, default: 0 },
      { key: 'blackPointX', label: 'Black Point X', type: 'number', unit: 'px', min: -100000, max: 100000, default: -200 },
      { key: 'blackPointY', label: 'Black Point Y', type: 'number', unit: 'px', min: -100000, max: 100000, default: 0 },
      { key: 'midPointX', label: 'Mid Point X', type: 'number', unit: 'px', min: -100000, max: 100000, default: 0 },
      { key: 'midPointY', label: 'Mid Point Y', type: 'number', unit: 'px', min: -100000, max: 100000, default: 0 },
      { key: 'whitePointX', label: 'White Point X', type: 'number', unit: 'px', min: -100000, max: 100000, default: 200 },
      { key: 'whitePointY', label: 'White Point Y', type: 'number', unit: 'px', min: -100000, max: 100000, default: 0 },
      { key: 'sampleSize', label: 'Sample Size', type: 'number', unit: 'px', min: 1, max: 200, default: 10 },
    ],
    css: () => '',
  },
  {
    /* After Effects' Camera Shake Deblur: where this frame is blurrier than its neighbours (local Laplacian energy), their sharp detail, aligned by optical flow, replaces it. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'camera-shake-deblur',
    label: 'Camera Shake Deblur',
    gpuOnly: true,
    params: [
      { key: 'blurriness', label: 'Blurriness', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'neighbors', label: 'Neighbor Frames', type: 'number', min: 1, max: 3, precision: 0, default: 1 },
      { key: 'sampleSize', label: 'Sample Size', type: 'number', unit: 'px', min: 2, max: 64, default: 8 },
      { key: 'detail', label: 'Detail Analysis', type: 'number', unit: '%', min: 0, max: 100, default: 50 },
    ],
    css: () => '',
  },
  {
    /* A burning transition: the layer eaten by a domain-warped fractal front (optionally travelling in a direction), its edge glowing with embers, a band of char behind it, a halo of heat glow around. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'burn-dissolve',
    label: 'Burn Dissolve',
    gpuOnly: true,
    params: [
      { key: 'completion', label: 'Transition Completion', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'scale', label: 'Noise Scale', type: 'number', unit: 'px', min: 4, max: 4000, default: 180 },
      { key: 'warp', label: 'Warp', type: 'number', unit: '%', min: 0, max: 300, default: 60 },
      { key: 'direction', label: 'Direction', type: 'number', unit: '°', min: -3600, max: 3600, default: 90 },
      { key: 'directionality', label: 'Directionality', type: 'number', unit: '%', min: 0, max: 100, default: 40 },
      { key: 'edgeWidth', label: 'Ember Width', type: 'number', unit: 'px', min: 0.5, max: 200, default: 10 },
      { key: 'charWidth', label: 'Char Width', type: 'number', unit: 'px', min: 0, max: 400, default: 22 },
      { key: 'emberColor', label: 'Ember Color', type: 'color', default: '#ffb347' },
      { key: 'hotColor', label: 'Hot Color', type: 'color', default: '#fff4c2' },
      { key: 'charColor', label: 'Char Color', type: 'color', default: '#1a0e08' },
      { key: 'glow', label: 'Glow', type: 'number', unit: '%', min: 0, max: 1000, default: 120 },
      { key: 'glowRadius', label: 'Glow Radius', type: 'number', unit: 'px', min: 1, max: 400, default: 14 },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 99999, precision: 0, default: 1 },
    ],
    css: () => '',
  },
  {
    /* A liquid transition: the layer pushed along a flowing noise field that grows with completion, splitting into colour fringes and melting away by a noise threshold — or morphing into a target layer that flows in the other way. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'liquid-morph',
    label: 'Liquid Morph Wipe',
    gpuOnly: true,
    params: [
      { key: 'completion', label: 'Transition Completion', type: 'number', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'targetLayer', label: 'Morph Into Layer', type: 'layer', noneLabel: 'None (dissolve)', default: '' },
      { key: 'distortion', label: 'Distortion', type: 'number', unit: 'px', min: 0, max: 4000, default: 160 },
      { key: 'scale', label: 'Flow Scale', type: 'number', unit: 'px', min: 4, max: 4000, default: 220 },
      { key: 'chroma', label: 'Chromatic Split', type: 'number', unit: '%', min: 0, max: 300, default: 40 },
      { key: 'softness', label: 'Edge Softness', type: 'number', unit: '%', min: 0, max: 100, default: 30 },
      { key: 'flowAngle', label: 'Flow Direction', type: 'number', unit: '°', min: -3600, max: 3600, default: -90 },
      { key: 'seed', label: 'Random Seed', type: 'number', min: 0, max: 99999, precision: 0, default: 1 },
    ],
    css: () => '',
  },
  {
    /* CC Bend It: the layer bent between a start and an end point along an arc of the given angle (exact inverse mapping, the part beyond the end carried on the tangent), the part before the start left, kept static or removed. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'bend-it',
    label: 'CC Bend It',
    gpuOnly: true,
    params: [
      { key: 'bend', label: 'Bend', type: 'number', unit: '°', min: -3600, max: 3600, default: 45 },
      { key: 'startX', label: 'Start X', type: 'number', unit: 'px', min: -100000, max: 100000, default: 0 },
      { key: 'startY', label: 'Start Y', type: 'number', unit: 'px', min: -100000, max: 100000, default: -100 },
      { key: 'endX', label: 'End X', type: 'number', unit: 'px', min: -100000, max: 100000, default: 0 },
      { key: 'endY', label: 'End Y', type: 'number', unit: 'px', min: -100000, max: 100000, default: 100 },
      { key: 'prestart', label: 'Render Prestart', type: 'enum', default: 0, options: [{ value: 0, label: 'None' }, { value: 1, label: 'Static' }, { value: 2, label: 'Bend' }] },
    ],
    css: () => '',
  },
  {
    /* CC Bender: the layer bent from its base toward its top — Bend, Marilyn (a wave), Sharp (a kink) or Boxer (a rounded box) — by an inverse mapping refined by fixed-point iteration, optionally scaled to the distance. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'bender',
    label: 'CC Bender',
    gpuOnly: true,
    params: [
      { key: 'amount', label: 'Amount', type: 'number', unit: 'px', min: -10000, max: 10000, default: 40 },
      { key: 'style', label: 'Style', type: 'enum', default: 0, options: [{ value: 0, label: 'Bend' }, { value: 1, label: 'Marilyn' }, { value: 2, label: 'Sharp' }, { value: 3, label: 'Boxer' }] },
      { key: 'adjustToDistance', label: 'Adjust To Distance', type: 'checkbox', default: true },
      { key: 'topX', label: 'Top X', type: 'number', unit: 'px', min: -100000, max: 100000, default: 0 },
      { key: 'topY', label: 'Top Y', type: 'number', unit: 'px', min: -100000, max: 100000, default: -150 },
      { key: 'baseX', label: 'Base X', type: 'number', unit: 'px', min: -100000, max: 100000, default: 0 },
      { key: 'baseY', label: 'Base Y', type: 'number', unit: 'px', min: -100000, max: 100000, default: 150 },
    ],
    css: () => '',
  },
  {
    /* An outline around a matte — the layer's own alpha or another layer's (an Object Matte cut-out) — from the matte's jump-flood distance field, so soft per-frame mattes with no contour stroke cleanly: outside / center / inside, softness, glow, marching dashes. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'matte-stroke',
    label: 'Matte Stroke',
    gpuOnly: true,
    params: [
      { key: 'matteLayerId', label: 'Matte Layer', type: 'layer', noneLabel: 'This Layer\'s Alpha', default: '' },
      { key: 'color', label: 'Color', type: 'color', default: '#ffffff' },
      { key: 'width', label: 'Width', type: 'number', unit: 'px', min: 0, max: 500, default: 6 },
      { key: 'position', label: 'Position', type: 'enum', default: 0, options: [{ value: 0, label: 'Outside' }, { value: 1, label: 'Center' }, { value: 2, label: 'Inside' }] },
      { key: 'softness', label: 'Softness', type: 'number', unit: 'px', min: 0, max: 200, default: 0 },
      { key: 'opacity', label: 'Opacity', type: 'number', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'glowAmount', label: 'Glow Amount', type: 'number', group: 'Glow', unit: '%', min: 0, max: 1000, default: 0 },
      { key: 'glowRadius', label: 'Glow Radius', type: 'number', group: 'Glow', unit: 'px', min: 0, max: 1000, default: 20 },
      { key: 'dashed', label: 'Dashed', type: 'checkbox', group: 'Dashes', default: false },
      { key: 'dashLength', label: 'Dash Length', type: 'number', group: 'Dashes', unit: 'px', min: 0, max: 10000, default: 20 },
      { key: 'gapLength', label: 'Gap Length', type: 'number', group: 'Dashes', unit: 'px', min: 0, max: 10000, default: 12 },
      { key: 'dashOffset', label: 'Offset', type: 'number', group: 'Dashes', unit: 'px', min: -100000, max: 100000, default: 0 },
      { key: 'composite', label: 'Composite', type: 'enum', default: 0, options: [{ value: 0, label: 'On Original' }, { value: 1, label: 'On Transparent' }] },
    ],
    css: () => '',
  },
  {
    /* Hue / saturation / lightness and colorize confined to a matte — another layer's alpha, or the layer's own Object Matte (read as a matte: the layer is not cut out) — or to everything outside it, in linear light; the matte feathered and choked by its distance field. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'selective-color-ai',
    label: 'Selective Color (AI)',
    gpuOnly: true,
    params: [
      { key: 'matteLayerId', label: 'Matte Layer', type: 'layer', noneLabel: 'Object Matte (This Layer)', default: '' },
      { key: 'applyTo', label: 'Apply To', type: 'enum', default: 0, options: [{ value: 0, label: 'Inside Matte' }, { value: 1, label: 'Outside Matte' }] },
      { key: 'hue', label: 'Hue Shift', type: 'number', unit: '°', min: -180, max: 180, default: 0 },
      { key: 'saturation', label: 'Saturation', type: 'number', min: -100, max: 100, default: 0 },
      { key: 'lightness', label: 'Lightness', type: 'number', min: -100, max: 100, default: 0 },
      { key: 'colorize', label: 'Colorize', type: 'checkbox', group: 'Colorize', default: false },
      { key: 'colorizeColor', label: 'Colorize Color', type: 'color', group: 'Colorize', default: '#ff6a1a' },
      { key: 'colorizeAmount', label: 'Colorize Amount', type: 'number', group: 'Colorize', unit: '%', min: 0, max: 100, default: 100 },
      { key: 'matteFeather', label: 'Matte Feather', type: 'number', group: 'Matte', unit: 'px', min: 0, max: 500, default: 0 },
      { key: 'matteChoke', label: 'Matte Choke', type: 'number', group: 'Matte', unit: 'px', min: -200, max: 200, default: 0 },
    ],
    css: () => '',
  },
  {
    /* After Effects' Object Matte card: the layer's stored per-frame Object Matte (setLayerMatte) cuts the layer through this effect — Invert, Fine-tune (Feather, Contrast, Shift Edge) live in the shader; Quality, Edge Radius, Decontaminate, Motion Blur, Reduce Chatter and Render Refine Edge are the propagation's, used by the next propagation. Disabled or removed: the layer shows uncut. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'object-matte',
    label: 'Object Matte',
    gpuOnly: true,
    params: [
      { key: 'version', label: 'Version', type: 'enum', default: 0, options: [{ value: 0, label: '4.0' }] },
      { key: 'quality', label: 'Quality', type: 'enum', group: 'Propagation', default: 0, options: [{ value: 0, label: 'Standard' }, { value: 1, label: 'Best' }] },
      { key: 'edgeRadius', label: 'Edge Radius', type: 'number', group: 'Propagation', unit: 'px', min: 0, max: 64, precision: 0, default: 6 },
      { key: 'decontaminate', label: 'Decontaminate Edge Colors', type: 'checkbox', group: 'Propagation', default: true },
      { key: 'decontaminationAmount', label: 'Decontamination Amount', type: 'number', group: 'Propagation', unit: '%', min: 0, max: 100, default: 50 },
      { key: 'motionBlur', label: 'Use Motion Blur', type: 'checkbox', group: 'Propagation', default: false },
      { key: 'reduceChatter', label: 'Reduce Chatter', type: 'checkbox', group: 'Propagation', default: true },
      { key: 'invert', label: 'Invert Foreground/Background', type: 'checkbox', default: false },
      { key: 'fineTune', label: 'Fine-tune Roto Brush Matte', type: 'checkbox', default: false },
      { key: 'feather', label: 'Feather', type: 'number', group: 'Roto Brush Matte', unit: 'px', min: 0, max: 500, default: 0 },
      { key: 'contrast', label: 'Contrast', type: 'number', group: 'Roto Brush Matte', unit: '%', min: 0, max: 100, default: 0 },
      { key: 'shiftEdge', label: 'Shift Edge', type: 'number', group: 'Roto Brush Matte', unit: '%', min: -100, max: 100, default: 0 },
      { key: 'chatterAmount', label: 'Reduce Chatter', type: 'number', group: 'Roto Brush Matte', unit: '%', min: 0, max: 100, default: 30 },
      { key: 'renderRefineEdge', label: 'Render Refine Edge', type: 'checkbox', default: true },
    ],
    css: () => '',
  },
  {
    /* Liquid merge (the metaball / "gooey" filter): the layer's alpha blurred and thresholded so nearby shapes fuse into one blob with a soft meniscus, then shaded from the blob's distance field — a dome normal with a light, specular highlight and Fresnel rim, tinted. Works on a precomp of many blobs, or on a masked adjustment layer over the whole scene. GPU only (docs/PROGRAM_DEEP_EFFECTS.md). */
    type: 'goo',
    label: 'Goo',
    gpuOnly: true,
    params: [
      { key: 'blur', label: 'Blur', type: 'number', unit: 'px', min: 0, max: 200, default: 12 },
      { key: 'threshold', label: 'Threshold', type: 'number', unit: '%', min: 1, max: 100, default: 50 },
      { key: 'softness', label: 'Softness', type: 'number', unit: '%', min: 0, max: 100, default: 10 },
      { key: 'color', label: 'Color', type: 'enum', group: 'Shading', default: 0, options: [{ value: 0, label: 'Layer' }, { value: 1, label: 'Tint' }] },
      { key: 'tint', label: 'Tint', type: 'color', group: 'Shading', default: '#36c6ff' },
      { key: 'shine', label: 'Shine', type: 'number', group: 'Shading', unit: '%', min: 0, max: 400, default: 50 },
      { key: 'highlight', label: 'Highlight Color', type: 'color', group: 'Shading', default: '#ffffff' },
      { key: 'shininess', label: 'Shininess', type: 'number', group: 'Shading', min: 1, max: 400, default: 40 },
      { key: 'lightAngle', label: 'Light Direction', type: 'number', group: 'Shading', unit: '°', min: -3600, max: 3600, default: -45 },
      { key: 'lightElevation', label: 'Light Elevation', type: 'number', group: 'Shading', unit: '°', min: 0, max: 90, default: 50 },
      { key: 'rim', label: 'Fresnel Rim', type: 'number', group: 'Shading', unit: '%', min: 0, max: 200, default: 20 },
      { key: 'ambient', label: 'Ambient', type: 'number', group: 'Shading', unit: '%', min: 0, max: 200, default: 85 },
      { key: 'dome', label: 'Dome Radius', type: 'number', group: 'Shading', unit: 'px', min: 0, max: 500, default: 0 },
    ],
    css: () => '',
  },
  // deepfx:defs:end
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
  return BUILTIN_DEF.get(type as EffectType);
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
 * The reserved param key for AE's Compositing Options -> Effect Opacity.
 *
 * It carries a DOT on purpose. Every declared `EffectParamDef.key` in the
 * registry (and in every plugin def) is a plain identifier, so a key containing
 * `.` cannot collide with one — which matters because nineteen effects already
 * declare a param keyed plainly `opacity` and this is emphatically not that
 * (see `Effect.opacity`). `effectOpacityKeyIsReserved` pins the invariant.
 *
 * The path parses: `resolveEffectParam`'s `/^effect\.([^.]+)(?:\.(.+))?$/`
 * takes the id from the first segment and the whole remainder as the key, so
 * `effect.fx_3.fx.opacity` resolves to effect `fx_3`, key `fx.opacity`.
 */
export const EFFECT_OPACITY_KEY = 'fx.opacity';

/** The animation path for an effect's Compositing Options opacity. */
export function effectOpacityPath(effectId: string): string {
  return effectPropPath(effectId, EFFECT_OPACITY_KEY);
}

/**
 * Guard for the registry: no effect definition may declare `fx.opacity` as a
 * param key, or its param and its compositing opacity would share one track.
 * Exported for the test that pins it rather than asserted at module load —
 * plugin defs register after this module and a throw here would take the app
 * down over a bad plugin.
 */
export function effectOpacityKeyIsReserved(defs: ReadonlyArray<EffectDef>): boolean {
  return !defs.some((d) => d.params.some((p) => p.key === EFFECT_OPACITY_KEY));
}

/**
 * This effect's Compositing Options opacity as a 0..1 BLEND FACTOR.
 *
 * Absent reads as 1 — an effect nobody has touched applies in full, which is
 * what every project saved before this field expects.
 */
export function effectOpacityOf(e: Effect): number {
  const pct = e.opacity;
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return 1;
  return Math.max(0, Math.min(1, pct / 100));
}

/**
 * Does this effect need the blend-against-input composite at all?
 *
 * PRESENCE of the field, not `< 100` — see `Effect.opacity` for why an animated
 * opacity must keep forcing the composite on the frames it samples 100.
 */
export function effectHasOpacity(e: Effect): boolean {
  return typeof e.opacity === 'number' && Number.isFinite(e.opacity);
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
    // Compositing-Options opacity FIRST, and above the `!def` return: it is an
    // instance field rather than a declared param, so it is the one animatable
    // quantity a plugin effect (whose def may not be in `DEF`) still carries.
    //
    // Stamped whenever the TRACK EXISTS, including on frames that sample
    // exactly 100 — the field's presence is what keeps the layer on the CPU
    // bake for the whole animation instead of flipping paths at the top of the
    // ramp. See `Effect.opacity`.
    const fxOp = sample(effectOpacityPath(e.id));
    const withOp = fxOp !== undefined ? { ...e, opacity: Math.max(0, Math.min(100, fxOp)) } : e;

    const def = DEF.get(e.type);
    if (!def) return withOp;
    e = withOp;
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
  const fx = renderComponentsOf(node).find((c) => c.type === 'fx');
  const list = fx?.props.effects;
  return Array.isArray(list) ? (list as Effect[]).map(migrateEffect) : [];
}

/**
 * After Effects' `fx` switch: is this layer's effect stack live?
 *
 * Absent means enabled, so existing projects keep rendering their effects.
 */
export function readNodeFxEnabled(node: SceneNode): boolean {
  const fx = renderComponentsOf(node).find((c) => c.type === 'fx');
  return fx?.props.fxEnabled !== false;
}

/**
 * The effects the RENDERER should apply — empty when the layer's `fx` switch is
 * off. Distinct from `readNodeEffects`, which the inspector uses to list the
 * stack: a disabled stack must still be visible and editable in the UI.
 */
export function readNodeRenderEffects(node: SceneNode): Effect[] {
  return readNodeFxEnabled(node) ? readNodeEffects(node) : [];
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
