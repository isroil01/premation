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
import { blurRgba, radialBlurData, blurDimensions, channelBlurData, unsharpMaskData } from './blurs';
import { mosaicData, findEdgesData, roughenEdgesData, embossData, scatterData } from './stylize';
import { vibranceData, coloramaData, COLORAMA_PALETTES } from './colorEffects';
import { selectiveColorData, selectiveRange, shadowHighlightData } from './toneEffects';
import {
  bulgeData, twirlData, spherizeData, cornerPinData, defaultCorners,
  polarCoordinatesData, polarConversion, opticsCompensationData, meshWarpData, MESH_WARP_N, liquifyData, mirrorData, offsetData,
} from './distort';
import { photoFilterData, blackAndWhiteData, tritoneData, thresholdData } from './aeColor';
import { drawCheckerboard, drawGrid, cellPatternData } from './generatePatterns';
import { drawVegas } from './vegas';
import { defaultWarpPoints, bezierWarpData, isRestWarp, type WarpPoints } from './bezierWarp';
import { turbulentNoiseData, addGrainData, medianData } from './noiseEffects';
import { applyLutToImageData, fromStoredLut } from './cubeLut';
import {
  simpleChokerData, linearColorKeyData, shiftChannelsData, colorMatchMode, channelSource,
  lumaKeyData, lumaKeyType, minimaxData, minimaxOp, minimaxChannel,
} from './keyingEffects';
import {
  venetianBlindsData, gradientWipeData, cardWipeData, cardWipeDirection, luminanceMapFrom,
  radialWipeData, radialWipeDirection, blockDissolveData,
} from './transitions';
import { drawLensFlare, formatNumber, formatTimecode, drawTextReadout, drawAudioSpectrum } from './generateText';
import { clamp01 } from '@utils/lang';
// ── Round four kernels ──
import { bilateralBlurData, smartBlurData, cameraLensBlurData } from './aeBlurAdvanced';
import {
  rippleData, magnifyData, warpData, pageTurnData, splitData, slantData, smearData,
  rollingShutterData, radialShadowData,
} from './aeDistortAdvanced';
import {
  drawCircle, drawEllipse, drawRadioWaves, drawLightning, drawLightRays, drawLightSweep,
  drawAudioWaveform,
} from './generateAdvanced';
import {
  cartoonData, brushStrokesData, strobeLightData, colorEmbossData, halftoneData,
  kaleidoscopeData, vignetteData, burnFilmData,
} from './aeStylizeAdvanced';
import {
  equalizeData, autoLevelsData, autoContrastData, autoColorData, changeColorData,
  changeToColorData, leaveColorData, tonerData,
} from './aeColorAdvanced';
import {
  colorKeyData, colorRangeData, extractData, spillSuppressorData, matteChokerData,
} from './aeKeyingAdvanced';
import {
  alphaLevelsData, solidCompositeData, channelCombinerData, removeColorMattingData,
} from './aeChannel';
import {
  irisWipeData, lightWipeData, lineSweepData, gridWipeData, dustAndScratchesData, noiseAlphaData,
} from './aeTransitionsAdvanced';
// ── Round five kernels ──
import {
  starBurstData, snowfallData, rainfallData, writeOnData, lightBurstData,
} from './generateRoundFive';
import {
  glassData, texturizeData, threadsData, chromaticAberrationData, hexTileData, vectorBlurData,
} from './aeStylizeRoundFive';
import {
  floMotionData, lensData, griddlerData, ballActionData, drizzleData,
} from './aeDistortRoundFive';
import {
  jawsData, pixelPollyData, twisterData, cardDanceData,
} from './aeTransitionsRoundFive';

/** Effects implemented only by the Canvas2D backend, with no GPU shader form.
 *  (Distinct from `isCanvas2dProcedural`, whose two members ALSO have GPU
 *  shaders — gradient-ramp / fractal-noise render on both backends.) */
const CANVAS2D_ONLY = new Set<string>([
  'four-color-gradient',
  // 'beam' PORTED 2026-08-12 — it has a shader (builtin.ts BEAM), so it no
  // longer forces a bake. Its Canvas2D pass stays below and stays in
  // CANVAS2D_IMPLEMENTED, for layers baked for other reasons: that is the
  // position `apply-color-lut` and Fill/Stroke/Sharpen/Noise are in, and it is
  // what keeps the CPU version as the reference the GPU one is diffed against.
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
  // 'mosaic' PORTED 2026-08-15 (round six waves 2-3) — GPU shader; Canvas2D retained below.
  // 'find-edges' PORTED 2026-08-15 (round six waves 2-3) — GPU shader; Canvas2D retained below.
  'roughen-edges',
  // Colour family. `exposure` is deliberately ABSENT: it is a per-channel
  // transfer function, so it lives in LUT_EFFECTS and renders on both backends
  // with no bake. `vibrance` PORTED 2026-08-14 (round six) — GPU shader, its
  // Canvas2D pass stays in CANVAS2D_IMPLEMENTED as the parity reference.
  'colorama',
  // Both for the same reason as the two above, one step further. `lumetri` is
  // deliberately ABSENT beside `exposure` — all eight of its controls are
  // channel-independent, so it is a LUT.
  'selective-color',
  // And this one is the strongest case of all: it reads the pixel's NEIGHBOURS,
  // so it is spatial and could not be a transfer function of any kind.
  'shadow-highlight',
  // Distort family — inverse-map resamples, no shader form. `transform` and
  // `wave-warp` above are the same class.
  // 'bulge' PORTED 2026-08-15 (round six waves 2-3) — GPU shader; Canvas2D retained below.
  // 'twirl' PORTED 2026-08-15 (round six waves 2-3) — GPU shader; Canvas2D retained below.
  // 'spherize' PORTED 2026-08-15 (round six waves 2-3) — GPU shader; Canvas2D retained below.
  'corner-pin',
  // Same class as the four above: an inverse-map resample with no shader form.
  'bezier-warp',
  // Generate family, round two — these DRAW, like `beam` and `lens-flare`.
  'checkerboard',
  'grid',
  'cell-pattern',
  // Vegas READS the layer's alpha per pixel to find its contour, so there is
  // no shader form for it any more than there is for Median. It also DRAWS,
  // like the three above.
  'vegas',
  // Noise family. Turbulent Noise generates a field, Add Grain disturbs the
  // pixels, Median is a rank filter over the neighbourhood — no shader form for
  // any of the three.
  'turbulent-noise',
  'add-grain',
  'median',
  // Keying family. `set-matte` is deliberately ABSENT: it reads another layer's
  // pixels, which this chain's per-layer signature cannot express, so it lives
  // on the GPU path beside displacement-map instead.
  'simple-choker',
  'linear-color-key',
  'shift-channels',
  // Transition family — alpha-only reveals, like the existing `linear-wipe`.
  'venetian-blinds',
  'gradient-wipe',
  'card-wipe',
  // Generate / Text — these DRAW rather than transform, like `beam` above.
  // 'lens-flare' PORTED 2026-08-14 — GPU shader; Canvas2D retained in IMPLEMENTED.
  'numbers',
  'timecode',
  'audio-spectrum',
  // ── Round three ──
  //
  // `color-balance` and `gamma-pedestal-gain` are deliberately ABSENT: both are
  // per-channel transfer functions, so they live in `LUT_BUILDERS` and render on
  // both backends with no bake, beside Exposure and Lumetri. Listing them here
  // would drag every layer carrying a grade onto the CPU to do something the GPU
  // already does — the exact mistake `colorLut.ts` documents at length.
  //
  // Colour — the four that read all three channels (so no LUT) were here;
  // ALL FOUR PORTED 2026-08-14 (round six): photo-filter, black-and-white,
  // tritone, threshold now have GPU shaders and no longer force a bake.
  // Their Canvas2D passes stay in CANVAS2D_IMPLEMENTED below.
  // Distort — inverse-map resamples, like the five above.
  'polar-coordinates',
  // Optics Compensation is one too. It has no GPU shader, so without this entry
  // it would not force a bake and `extractSpatialEffects` would drop it — the
  // effect would be addable, keyframeable and completely inert, which is the
  // failure `effectRegistryComplete.test.ts` was written after.
  'optics-compensation',
  // Mesh Warp is a resample too, and has no GPU form.
  'mesh-warp',
  'liquify',
  // 'mirror' PORTED 2026-08-15 (round six waves 2-3) — GPU shader; Canvas2D retained below.
  // 'offset' PORTED 2026-08-15 (round six waves 2-3) — GPU shader; Canvas2D retained below.
  // Stylize — a directional derivative and a randomised resample.
  // 'emboss' PORTED 2026-08-15 (round six waves 2-3) — GPU shader; Canvas2D retained below.
  'scatter',
  // Transition — alpha-only reveals, like the three above.
  'radial-wipe',
  'block-dissolve',
  // Keying / Matte. Minimax reads a whole neighbourhood per pixel, so it is
  // spatial in the same sense Median is.
  'luma-key',
  'minimax',
  // Blur family — per-channel radii and a scale-aware sharpen, neither of which
  // a CSS filter can express, exactly like the three blurs above.
  'channel-blur',
  'unsharp-mask',
  // ── Round four ──
  //
  // All fifty. None is a LUT candidate and none has a GPU material, so each one
  // forces a bake and each one needs a `case` below — the dispatch guard in
  // `canvas2dEffects.test.ts` reads this list from SOURCE and fails naming any
  // member that has no case, because the failure is otherwise silent: the layer
  // pays for the whole CPU round trip and nothing is drawn.
  //
  // Blur — non-separable, so no shader form. See `aeBlurAdvanced.ts`.
  'bilateral-blur',
  'smart-blur',
  'camera-lens-blur',
  // Distort — inverse-map resamples, like every other member of the family.
  // 'ripple' PORTED 2026-08-15 (round six waves 2-3) — GPU shader; Canvas2D retained below.
  // 'magnify' PORTED 2026-08-15 (round six waves 2-3) — GPU shader; Canvas2D retained below.
  'warp',
  'page-turn',
  'split',
  'slant',
  'smear',
  'rolling-shutter',
  // Perspective — projects a silhouette, then blurs and composites it.
  'radial-shadow',
  // Generate — these DRAW, like Beam, Lens Flare and Checkerboard.
  'circle',
  'ellipse',
  'radio-waves',
  'lightning',
  // 'light-rays' PORTED 2026-08-14 — GPU shader; Canvas2D retained below.
  // 'light-sweep' PORTED 2026-08-14 — GPU shader; Canvas2D retained below.
  'audio-waveform',
  // Stylize — neighbourhood and cell operations, none expressible as a filter.
  'cartoon',
  'brush-strokes',
  'strobe-light',
  // 'color-emboss' PORTED 2026-08-15 (round six waves 2-3) — GPU shader; Canvas2D retained below.
  // 'halftone' PORTED 2026-08-15 (round six waves 2-3) — GPU shader; Canvas2D retained below.
  // 'kaleidoscope' PORTED 2026-08-15 (round six waves 2-3) — GPU shader; Canvas2D retained below.
  // 'vignette' PORTED 2026-08-14 (round six) — GPU shader; Canvas2D retained below.
  'burn-film',
  // Colour — the eight that need the HISTOGRAM or read all three channels.
  // Deliberately NOT in `LUT_BUILDERS`: a table is built from params alone and
  // cannot see the image, so none of these could be expressed there.
  'equalize',
  'auto-levels',
  'auto-contrast',
  'auto-color',
  'change-color',
  'change-to-color',
  'leave-color',
  'toner',
  // Keying & Matte, and the four Channel effects that work on coverage.
  'color-key',
  'color-range',
  'extract',
  'spill-suppressor',
  'matte-choker',
  'alpha-levels',
  'solid-composite',
  'channel-combiner',
  'remove-color-matting',
  // Transition — alpha-only reveals, like the wipes above.
  'iris-wipe',
  'light-wipe',
  'line-sweep',
  'grid-wipe',
  // Noise — a thresholded median, and noise in coverage rather than colour.
  'dust-scratches',
  'noise-alpha',
  // ── Round five ──
  //
  // All twenty. None is a LUT candidate (every one is spatial) and none has a
  // GPU material, so each forces a bake and needs a `case` below.
  'star-burst',
  'snowfall',
  'rainfall',
  'write-on',
  'light-burst',
  'glass',
  'texturize',
  'threads',
  // 'chromatic-aberration' PORTED 2026-08-15 (round six waves 2-3) — GPU shader; Canvas2D retained below.
  'hex-tile',
  'vector-blur',
  'flo-motion',
  'lens',
  'griddler',
  'ball-action',
  'drizzle',
  'jaws',
  'pixel-polly',
  'twister',
  'card-dance',
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
  // Ported to a shader, so it left CANVAS2D_ONLY above — but a layer baked for
  // some OTHER reason still runs its whole chain through the bake, and dropping
  // beam from this list would make it vanish on exactly those layers. Named
  // here for the same reason the four above are.
  'beam',
  'light-sweep',
  'lens-flare',
  'light-rays',
  // Round six (2026-08-14): the six per-pixel colour ports. Same position as
  // every ported effect above — the GPU draws them on live layers, and these
  // Canvas2D passes remain the parity reference and the path for layers baked
  // for other reasons.
  'vignette',
  'black-and-white',
  'tritone',
  'photo-filter',
  'threshold',
  'vibrance',
  // Waves 2–3 (2026-08-15): warps + neighbourhood passes, same position.
  'mirror',
  'offset',
  'bulge',
  'twirl',
  'spherize',
  'kaleidoscope',
  'ripple',
  'chromatic-aberration',
  'magnify',
  'mosaic',
  'find-edges',
  'emboss',
  'color-emboss',
  'halftone',
  /*
    Apply Color LUT moved OFF the forces-a-bake list when it gained a GPU
    shader — a 3D LUT is a texture lookup, which is what the strip in
    `AppTextureProvider.setCubeLut` and the `apply-color-lut` material do now.

    It stays here, and that is the whole point of these being two lists. A layer
    baked for some OTHER reason has its GPU effect list dropped wholesale, so
    without this entry a creative LUT would vanish the moment someone added an
    inner shadow beside it. The same reasoning as Fill / Stroke / Sharpen /
    Noise above, and the same failure if it were collapsed to one predicate.
  */
  'apply-color-lut',
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
    case 'bulge':
      return applyBulge(oc, w, h, e);
    case 'twirl':
      return applyTwirl(oc, w, h, e);
    case 'spherize':
      return applySpherize(oc, w, h, e);
    case 'corner-pin':
      return applyCornerPin(oc, w, h, e);
    case 'bezier-warp':
      return applyBezierWarp(oc, w, h, e);
    case 'checkerboard':
      return drawCheckerboard(oc, w, h, e);
    case 'grid':
      return drawGrid(oc, w, h, e);
    case 'cell-pattern':
      return applyCellPattern(oc, w, h, e);
    case 'vegas':
      return drawVegas(oc, w, h, e);
    case 'turbulent-noise':
      return applyTurbulentNoise(oc, w, h, e);
    case 'add-grain':
      return applyAddGrain(oc, w, h, e);
    case 'median':
      return applyMedian(oc, w, h, e);
    case 'selective-color':
      return applySelectiveColor(oc, w, h, e);
    case 'apply-color-lut':
      return applyColorLut(oc, w, h, e);
    case 'shadow-highlight':
      return applyShadowHighlight(oc, w, h, e);
    case 'simple-choker':
      return applySimpleChoker(oc, w, h, e);
    case 'linear-color-key':
      return applyLinearColorKey(oc, w, h, e);
    case 'shift-channels':
      return applyShiftChannels(oc, w, h, e);
    case 'venetian-blinds':
      return applyVenetianBlinds(oc, w, h, e);
    case 'gradient-wipe':
      return applyGradientWipe(oc, w, h, e);
    case 'card-wipe':
      return applyCardWipe(oc, w, h, e);
    case 'lens-flare':
      return applyLensFlare(oc, w, h, e);
    case 'numbers':
      return applyNumbers(oc, w, h, e);
    case 'timecode':
      return applyTimecode(oc, w, h, e);
    case 'audio-spectrum':
      return applyAudioSpectrum(oc, w, h, e);
    // ── Round three ──
    case 'photo-filter':
      return applyPhotoFilter(oc, w, h, e);
    case 'black-and-white':
      return applyBlackAndWhite(oc, w, h, e);
    case 'tritone':
      return applyTritone(oc, w, h, e);
    case 'threshold':
      return applyThreshold(oc, w, h, e);
    case 'liquify':
      return applyLiquify(oc, w, h, e);
    case 'mesh-warp':
      return applyMeshWarp(oc, w, h, e);
    case 'optics-compensation':
      return applyOpticsCompensation(oc, w, h, e);
    case 'polar-coordinates':
      return applyPolarCoordinates(oc, w, h, e);
    case 'mirror':
      return applyMirror(oc, w, h, e);
    case 'offset':
      return applyOffset(oc, w, h, e);
    case 'emboss':
      return applyEmboss(oc, w, h, e);
    case 'scatter':
      return applyScatter(oc, w, h, e);
    case 'radial-wipe':
      return applyRadialWipe(oc, w, h, e);
    case 'block-dissolve':
      return applyBlockDissolve(oc, w, h, e);
    case 'luma-key':
      return applyLumaKey(oc, w, h, e);
    case 'minimax':
      return applyMinimax(oc, w, h, e);
    case 'channel-blur':
      return applyChannelBlur(oc, w, h, e);
    case 'unsharp-mask':
      return applyUnsharpMask(oc, w, h, e);

    // ── Round four ──
    case 'bilateral-blur':
      return applyBilateralBlur(oc, w, h, e);
    case 'smart-blur':
      return applySmartBlur(oc, w, h, e);
    case 'camera-lens-blur':
      return applyCameraLensBlur(oc, w, h, e);
    case 'ripple':
      return applyRipple(oc, w, h, e);
    case 'magnify':
      return applyMagnify(oc, w, h, e);
    case 'warp':
      return applyWarp(oc, w, h, e);
    case 'page-turn':
      return applyPageTurn(oc, w, h, e);
    case 'split':
      return applySplit(oc, w, h, e);
    case 'slant':
      return applySlant(oc, w, h, e);
    case 'smear':
      return applySmear(oc, w, h, e);
    case 'rolling-shutter':
      return applyRollingShutter(oc, w, h, e);
    case 'radial-shadow':
      return applyRadialShadow(oc, w, h, e);
    case 'circle':
      return applyCircle(oc, w, h, e);
    case 'ellipse':
      return applyEllipse(oc, w, h, e);
    case 'radio-waves':
      return applyRadioWaves(oc, w, h, e);
    case 'lightning':
      return applyLightning(oc, w, h, e);
    case 'light-rays':
      return applyLightRays(oc, w, h, e);
    case 'light-sweep':
      return applyLightSweep(oc, w, h, e);
    case 'audio-waveform':
      return applyAudioWaveform(oc, w, h, e);
    case 'cartoon':
      return applyCartoon(oc, w, h, e);
    case 'brush-strokes':
      return applyBrushStrokes(oc, w, h, e);
    case 'strobe-light':
      return applyStrobeLight(oc, w, h, e);
    case 'color-emboss':
      return applyColorEmboss(oc, w, h, e);
    case 'halftone':
      return applyHalftone(oc, w, h, e);
    case 'kaleidoscope':
      return applyKaleidoscope(oc, w, h, e);
    case 'vignette':
      return applyVignette(oc, w, h, e);
    case 'burn-film':
      return applyBurnFilm(oc, w, h, e);
    case 'equalize':
      return applyEqualize(oc, w, h, e);
    case 'auto-levels':
      return applyAutoLevels(oc, w, h, e);
    case 'auto-contrast':
      return applyAutoContrast(oc, w, h, e);
    case 'auto-color':
      return applyAutoColor(oc, w, h, e);
    case 'change-color':
      return applyChangeColor(oc, w, h, e);
    case 'change-to-color':
      return applyChangeToColor(oc, w, h, e);
    case 'leave-color':
      return applyLeaveColor(oc, w, h, e);
    case 'toner':
      return applyToner(oc, w, h, e);
    case 'color-key':
      return applyColorKey(oc, w, h, e);
    case 'color-range':
      return applyColorRange(oc, w, h, e);
    case 'extract':
      return applyExtract(oc, w, h, e);
    case 'spill-suppressor':
      return applySpillSuppressor(oc, w, h, e);
    case 'matte-choker':
      return applyMatteChoker(oc, w, h, e);
    case 'alpha-levels':
      return applyAlphaLevels(oc, w, h, e);
    case 'solid-composite':
      return applySolidComposite(oc, w, h, e);
    case 'channel-combiner':
      return applyChannelCombiner(oc, w, h, e);
    case 'remove-color-matting':
      return applyRemoveColorMatting(oc, w, h, e);
    case 'iris-wipe':
      return applyIrisWipe(oc, w, h, e);
    case 'light-wipe':
      return applyLightWipe(oc, w, h, e);
    case 'line-sweep':
      return applyLineSweep(oc, w, h, e);
    case 'grid-wipe':
      return applyGridWipe(oc, w, h, e);
    case 'dust-scratches':
      return applyDustAndScratches(oc, w, h, e);
    case 'noise-alpha':
      return applyNoiseAlpha(oc, w, h, e);
    // ── Round five ──
    case 'star-burst':
      return applyStarBurst(oc, w, h, e);
    case 'snowfall':
      return applySnowfall(oc, w, h, e);
    case 'rainfall':
      return applyRainfall(oc, w, h, e);
    case 'write-on':
      return applyWriteOn(oc, w, h, e);
    case 'light-burst':
      return applyLightBurst(oc, w, h, e);
    case 'glass':
      return applyGlass(oc, w, h, e);
    case 'texturize':
      return applyTexturize(oc, w, h, e);
    case 'threads':
      return applyThreads(oc, w, h, e);
    case 'chromatic-aberration':
      return applyChromaticAberration(oc, w, h, e);
    case 'hex-tile':
      return applyHexTile(oc, w, h, e);
    case 'vector-blur':
      return applyVectorBlur(oc, w, h, e);
    case 'flo-motion':
      return applyFloMotion(oc, w, h, e);
    case 'lens':
      return applyLens(oc, w, h, e);
    case 'griddler':
      return applyGriddler(oc, w, h, e);
    case 'ball-action':
      return applyBallAction(oc, w, h, e);
    case 'drizzle':
      return applyDrizzle(oc, w, h, e);
    case 'jaws':
      return applyJaws(oc, w, h, e);
    case 'pixel-polly':
      return applyPixelPolly(oc, w, h, e);
    case 'twister':
      return applyTwister(oc, w, h, e);
    case 'card-dance':
      return applyCardDance(oc, w, h, e);
  }
}

/**
 * Audio Spectrum.
 *
 * The magnitudes are RESOLVED by buildSnapshot from the referenced audio layer
 * (core/audio/audioSpectrum.ts). This kernel never touches the scene or the
 * audio engine, which is what keeps it a pure function of its params — and what
 * makes preview and export produce identical pixels.
 */
function applyAudioSpectrum(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const raw = paramsOf(e).magnitudes;
  const magnitudes = Array.isArray(raw) ? (raw as number[]) : [];
  if (magnitudes.length === 0) return;

  const modeN = effectNumber(e, 'displayMode');
  drawAudioSpectrum(oc, w, h, magnitudes, {
    maxHeight: effectNumber(e, 'maxHeight'),
    thickness: effectNumber(e, 'thickness'),
    mode: modeN === 1 ? 'line' : modeN === 2 ? 'mirrored' : 'bars',
    insideColor: str(e, 'insideColor', '#00e5ff'),
    outsideColor: str(e, 'outsideColor', '#0066ff'),
  });
}

// ── Generate / Text (kernels in generateText.ts) ───────────────────
//
// Positions are OFFSETS from the layer centre, as with radial blur: absolute
// coordinates would default to the top-left corner and put every readout
// half off its own layer on the first add.

function applyLensFlare(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  drawLensFlare(
    oc, w, h,
    w / 2 + effectNumber(e, 'centerX'),
    h / 2 + effectNumber(e, 'centerY'),
    effectNumber(e, 'brightness') / 100,
    effectNumber(e, 'scale'),
    str(e, 'color', '#ffd9a0'),
  );
}

function applyNumbers(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const text = formatNumber(
    effectNumber(e, 'value'),
    effectNumber(e, 'decimals'),
    bool(e, 'useCommas', false),
    effectNumber(e, 'padTo'),
  );
  drawTextReadout(oc, w, h, text, {
    x: w / 2 + effectNumber(e, 'positionX'),
    y: h / 2 + effectNumber(e, 'positionY'),
    size: effectNumber(e, 'size'),
    color: str(e, 'color', '#ffffff'),
    align: 'center',
    showBox: bool(e, 'showBox', false),
    boxColor: str(e, 'boxColor', '#000000'),
  });
}

function applyTimecode(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const text = formatTimecode(
    effectNumber(e, 'time'),
    effectNumber(e, 'fps'),
    bool(e, 'dropFrame', false),
  );
  drawTextReadout(oc, w, h, text, {
    x: w / 2 + effectNumber(e, 'positionX'),
    y: h / 2 + effectNumber(e, 'positionY'),
    size: effectNumber(e, 'size'),
    color: str(e, 'color', '#ffffff'),
    align: 'center',
    showBox: bool(e, 'showBox', true),
    boxColor: str(e, 'boxColor', '#000000'),
  });
}

// ── Transition family (kernels in transitions.ts) ──────────────────

function applyVenetianBlinds(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const completion = effectNumber(e, 'completion');
  if (completion <= 0) return;
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  venetianBlindsData(
    img.data, w, h,
    completion / 100,
    effectNumber(e, 'direction'),
    effectNumber(e, 'width'),
    effectNumber(e, 'feather'),
  );
  oc.putImageData(img, 0, 0);
}

function applyGradientWipe(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const completion = effectNumber(e, 'completion');
  if (completion <= 0) return;
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  // The map is the layer's OWN luminance — see the effect def for why there is
  // no map-layer picker on this path.
  gradientWipeData(
    img.data,
    luminanceMapFrom(img.data),
    completion / 100,
    effectNumber(e, 'softness') / 100,
    bool(e, 'invertGradient', false),
  );
  oc.putImageData(img, 0, 0);
}

function applyCardWipe(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const completion = effectNumber(e, 'completion');
  if (completion <= 0) return;
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  cardWipeData(
    img.data, w, h,
    completion / 100,
    effectNumber(e, 'rows'),
    effectNumber(e, 'columns'),
    cardWipeDirection(effectNumber(e, 'flipOrder')),
  );
  oc.putImageData(img, 0, 0);
}

// ── Keying family (kernels in keyingEffects.ts) ────────────────────
//
// `set-matte` has no case here on purpose — it is a GPU effect, and the
// dispatch-coverage test only requires a case for CANVAS2D_ONLY members.

function applySimpleChoker(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const choke = effectNumber(e, 'chokeAmount');
  if (choke === 0) return;
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  simpleChokerData(img.data, w, h, choke);
  oc.putImageData(img, 0, 0);
}

function applyLinearColorKey(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  linearColorKeyData(
    img.data,
    parseHex(str(e, 'keyColor', '#00ff00')),
    colorMatchMode(effectNumber(e, 'matchOn')),
    effectNumber(e, 'tolerance'),
    effectNumber(e, 'softness'),
    bool(e, 'keepMatched', false),
  );
  oc.putImageData(img, 0, 0);
}

function applyShiftChannels(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  shiftChannelsData(
    img.data,
    channelSource(effectNumber(e, 'takeAlphaFrom')),
    channelSource(effectNumber(e, 'takeRedFrom')),
    channelSource(effectNumber(e, 'takeGreenFrom')),
    channelSource(effectNumber(e, 'takeBlueFrom')),
  );
  oc.putImageData(img, 0, 0);
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

// ── Distort family (kernels in distort.ts) ─────────────────────────
//
// Every one of these resolves its centre as an OFFSET from the layer centre —
// see the note on the Bulge definition in effects.ts for why the params are
// offsets rather than absolute points. Resolved HERE, in one place, because
// this is the only layer that knows `w` and `h`.

function applyRemapEffect(
  oc: CanvasRenderingContext2D,
  w: number,
  h: number,
  kernel: (data: Uint8ClampedArray) => Uint8ClampedArray,
): void {
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  const out = kernel(img.data);
  // The kernels return a NEW buffer — a resample cannot be done in place, since
  // a destination pixel may read a source pixel that an earlier destination has
  // already overwritten. Copy it back into the ImageData we already own rather
  // than constructing a second one: `new ImageData(buf, w, h)` needs the buffer
  // to be ArrayBuffer-backed, which `Uint8ClampedArray` does not guarantee.
  img.data.set(out);
  oc.putImageData(img, 0, 0);
}

function applyBulge(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const height = effectNumber(e, 'height');
  const radius = effectNumber(e, 'radius');
  if (height === 0 || radius <= 0) return;
  applyRemapEffect(oc, w, h, (d) => bulgeData(
    d, w, h,
    w / 2 + effectNumber(e, 'centerX'),
    h / 2 + effectNumber(e, 'centerY'),
    radius, height,
  ));
}

function applyTwirl(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const angle = effectNumber(e, 'angle');
  const radius = effectNumber(e, 'radius');
  if (angle === 0 || radius <= 0) return;
  applyRemapEffect(oc, w, h, (d) => twirlData(
    d, w, h,
    w / 2 + effectNumber(e, 'centerX'),
    h / 2 + effectNumber(e, 'centerY'),
    radius, angle,
  ));
}

function applySpherize(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const amount = effectNumber(e, 'amount');
  const radius = effectNumber(e, 'radius');
  if (amount === 0 || radius <= 0) return;
  applyRemapEffect(oc, w, h, (d) => spherizeData(
    d, w, h,
    w / 2 + effectNumber(e, 'centerX'),
    h / 2 + effectNumber(e, 'centerY'),
    radius, amount,
  ));
}

function applyCornerPin(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const base = defaultCorners(w, h);
  const offsets = [
    effectNumber(e, 'topLeftX'), effectNumber(e, 'topLeftY'),
    effectNumber(e, 'topRightX'), effectNumber(e, 'topRightY'),
    effectNumber(e, 'bottomRightX'), effectNumber(e, 'bottomRightY'),
    effectNumber(e, 'bottomLeftX'), effectNumber(e, 'bottomLeftY'),
  ];
  // All eight at rest is the identity map. Skipping it is not just an
  // optimisation — running the resample anyway would cost a full bilinear pass
  // and lose a fraction of a pixel of sharpness for no visible change.
  if (offsets.every((v) => v === 0)) return;
  const corners = base.map((v, i) => v + offsets[i]!) as unknown as
    readonly [number, number, number, number, number, number, number, number];
  applyRemapEffect(oc, w, h, (d) => cornerPinData(d, w, h, corners));
}

/**
 * Bezier Warp — the twelve offsets, applied to the rest patch.
 *
 * Identical shape to `applyCornerPin`: params are offsets, so all-zero is the
 * identity and is skipped rather than resampled. Skipping is not just an
 * optimisation here — a bilinear pass that reproduces its own input still
 * costs a fraction of a pixel of sharpness, which compounds if two warps stack.
 */
function applyBezierWarp(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const rest = defaultWarpPoints(w, h);
  const pts = [
    { x: rest[0]!.x + effectNumber(e, 'topLeftX'), y: rest[0]!.y + effectNumber(e, 'topLeftY') },
    { x: rest[1]!.x + effectNumber(e, 'top1X'), y: rest[1]!.y + effectNumber(e, 'top1Y') },
    { x: rest[2]!.x + effectNumber(e, 'top2X'), y: rest[2]!.y + effectNumber(e, 'top2Y') },
    { x: rest[3]!.x + effectNumber(e, 'topRightX'), y: rest[3]!.y + effectNumber(e, 'topRightY') },
    { x: rest[4]!.x + effectNumber(e, 'right1X'), y: rest[4]!.y + effectNumber(e, 'right1Y') },
    { x: rest[5]!.x + effectNumber(e, 'right2X'), y: rest[5]!.y + effectNumber(e, 'right2Y') },
    { x: rest[6]!.x + effectNumber(e, 'bottomRightX'), y: rest[6]!.y + effectNumber(e, 'bottomRightY') },
    { x: rest[7]!.x + effectNumber(e, 'bottom1X'), y: rest[7]!.y + effectNumber(e, 'bottom1Y') },
    { x: rest[8]!.x + effectNumber(e, 'bottom2X'), y: rest[8]!.y + effectNumber(e, 'bottom2Y') },
    { x: rest[9]!.x + effectNumber(e, 'bottomLeftX'), y: rest[9]!.y + effectNumber(e, 'bottomLeftY') },
    { x: rest[10]!.x + effectNumber(e, 'left1X'), y: rest[10]!.y + effectNumber(e, 'left1Y') },
    { x: rest[11]!.x + effectNumber(e, 'left2X'), y: rest[11]!.y + effectNumber(e, 'left2Y') },
  ] as unknown as WarpPoints;
  if (isRestWarp(pts, w, h)) return;
  applyRemapEffect(oc, w, h, (d) => bezierWarpData(d, w, h, pts));
}

// ── Generate / Noise, round two (kernels in generatePatterns.ts, noiseEffects.ts) ──

function applyCellPattern(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const p = paramsOf(e);
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  cellPatternData(
    img.data, w, h,
    effectNumber(e, 'size'),
    effectNumber(e, 'evolution'),
    effectNumber(e, 'contrast'),
    p.invert === true,
    p.membrane === true,
  );
  oc.putImageData(img, 0, 0);
}

function applyTurbulentNoise(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  turbulentNoiseData(
    img.data, w, h,
    effectNumber(e, 'scale'),
    effectNumber(e, 'complexity'),
    effectNumber(e, 'evolution'),
    effectNumber(e, 'contrast'),
    effectNumber(e, 'brightness'),
    paramsOf(e).invert === true,
  );
  oc.putImageData(img, 0, 0);
}

function applyAddGrain(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  if (effectNumber(e, 'intensity') === 0) return;
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  addGrainData(
    img.data, w, h,
    effectNumber(e, 'intensity'),
    effectNumber(e, 'size'),
    effectNumber(e, 'saturation'),
    effectNumber(e, 'seed'),
  );
  oc.putImageData(img, 0, 0);
}

function applyMedian(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const radius = Math.round(effectNumber(e, 'radius'));
  if (radius <= 0) return;
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  // A rank filter cannot run in place — a sorted window must see the ORIGINAL
  // neighbours, not ones this pass already replaced.
  img.data.set(medianData(img.data, w, h, radius));
  oc.putImageData(img, 0, 0);
}

function applySelectiveColor(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const cyan = effectNumber(e, 'cyan');
  const magenta = effectNumber(e, 'magenta');
  const yellow = effectNumber(e, 'yellow');
  const black = effectNumber(e, 'black');
  if (cyan === 0 && magenta === 0 && yellow === 0 && black === 0) return;
  const range = selectiveRange(effectNumber(e, 'range'));
  const absolute = paramsOf(e).absolute === true;
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  selectiveColorData(img.data, range, cyan, magenta, yellow, black, !absolute);
  oc.putImageData(img, 0, 0);
}

/**
 * Apply Color LUT.
 *
 * The LUT is rehydrated per call rather than cached: `fromStoredLut` validates
 * as it goes, and a cache keyed on anything less than the whole payload is how
 * you grade frame 200 with frame 1's file. If this ever shows on a profile, key
 * it on the effect id AND the stored object's identity, not on the id alone.
 *
 * NOTE the pipeline caveat in `cubeLut.ts`: this samples in whatever space the
 * pixels arrive in, and the renderer is not linear-light, so a log-space LUT
 * will not match its author's intent until that work lands.
 */
function applyColorLut(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const intensity = effectNumber(e, 'intensity') / 100;
  if (!(intensity > 0)) return;
  const lut = fromStoredLut(paramsOf(e).lut);
  if (!lut) return; // no file loaded, or an unreadable one — render unchanged
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  applyLutToImageData(img.data, lut, intensity);
  oc.putImageData(img, 0, 0);
}

function applyShadowHighlight(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const shadowAmount = effectNumber(e, 'shadowAmount');
  const highlightAmount = effectNumber(e, 'highlightAmount');
  if (shadowAmount === 0 && highlightAmount === 0) return;
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  shadowHighlightData(
    img.data, w, h,
    shadowAmount, highlightAmount,
    effectNumber(e, 'radius'), effectNumber(e, 'tonalWidth'),
  );
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

// ── Round three ───────────────────────────────────────────────────
//
// Wrappers only: every kernel lives in its family's file (`aeColor.ts`,
// `distort.ts`, `stylize.ts`, `transitions.ts`, `keyingEffects.ts`, `blurs.ts`)
// so the arithmetic stays testable without a DOM. What happens here is reading
// params, converting units, and choosing between `putImageData` and
// `applyRemapEffect` — the latter for the ones that RESAMPLE and so must return
// a new buffer rather than mutate in place.

function applyPhotoFilter(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const density = effectNumber(e, 'density');
  if (density <= 0) return;
  const [r, g, b] = parseHex(str(e, 'color', '#ec8a00'));
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  photoFilterData(img.data, r, g, b, density, bool(e, 'preserveLuminosity', true));
  oc.putImageData(img, 0, 0);
}

function applyBlackAndWhite(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  blackAndWhiteData(
    img.data,
    {
      // Percentages at the boundary, fractions in the kernel — the same split
      // the rest of this file uses, so the inspector shows AE's own numbers.
      reds: effectNumber(e, 'reds') / 100,
      yellows: effectNumber(e, 'yellows') / 100,
      greens: effectNumber(e, 'greens') / 100,
      cyans: effectNumber(e, 'cyans') / 100,
      blues: effectNumber(e, 'blues') / 100,
      magentas: effectNumber(e, 'magentas') / 100,
    },
    bool(e, 'tint', false) ? parseHex(str(e, 'tintColor', '#d8b48a')) : null,
  );
  oc.putImageData(img, 0, 0);
}

function applyTritone(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const blend = effectNumber(e, 'blend');
  if (blend >= 100) return;
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  tritoneData(
    img.data,
    parseHex(str(e, 'shadows', '#000000')),
    parseHex(str(e, 'midtones', '#808080')),
    parseHex(str(e, 'highlights', '#ffffff')),
    blend,
  );
  oc.putImageData(img, 0, 0);
}

function applyThreshold(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  thresholdData(img.data, effectNumber(e, 'level'));
  oc.putImageData(img, 0, 0);
}

function applyPolarCoordinates(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const interpolation = effectNumber(e, 'interpolation');
  if (interpolation <= 0) return;
  applyRemapEffect(oc, w, h, (d) => polarCoordinatesData(
    d, w, h, interpolation, polarConversion(effectNumber(e, 'conversion')),
  ));
}

function applyLiquify(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyRemapEffect(oc, w, h, (d) => liquifyData(
    d, w, h,
    // Centre as an OFFSET from the layer's middle, matching Bulge and Twirl —
    // an EffectDef cannot see the layer, so an absolute default would be 0,0.
    w / 2 + effectNumber(e, 'centerX'),
    h / 2 + effectNumber(e, 'centerY'),
    effectNumber(e, 'brushSize'),
    effectNumber(e, 'pushX'),
    effectNumber(e, 'pushY'),
    effectNumber(e, 'twirl'),
    effectNumber(e, 'pinch'),
  ));
}

function applyMeshWarp(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  // Read the whole lattice, in the row-major order `meshWarpData` expects.
  // Built by index rather than spelled out: 32 hand-written `effectNumber`
  // calls is 32 chances to transpose a row and a column, and the resulting warp
  // would look like a plausible mesh with the wrong vertex moving.
  const offsets: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < MESH_WARP_N * MESH_WARP_N; i++) {
    offsets.push({ x: effectNumber(e, `v${i}X`), y: effectNumber(e, `v${i}Y`) });
  }
  if (offsets.every((o) => o.x === 0 && o.y === 0)) return;
  applyRemapEffect(oc, w, h, (d) => meshWarpData(d, w, h, offsets));
}

function applyOpticsCompensation(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const fov = effectNumber(e, 'fieldOfView');
  // Zero is the identity, and skipping keeps it EXACTLY so — a resample at
  // k = 0 still costs a bilinear tap of softening for a control left off.
  if (fov <= 0) return;
  applyRemapEffect(oc, w, h, (d) => opticsCompensationData(
    d, w, h, fov,
    // Read as a BOOLEAN, not through `effectNumber`: that returns 0 for a
    // checkbox param, so `n('reverse') > 0.5` would be unconditionally false
    // and the control would persist, keyframe and do nothing.
    paramsOf(e).reverse === true,
    effectNumber(e, 'centerX'),
    effectNumber(e, 'centerY'),
  ));
}

function applyMirror(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyRemapEffect(oc, w, h, (d) => mirrorData(
    d, w, h,
    w / 2 + effectNumber(e, 'centerX'),
    h / 2 + effectNumber(e, 'centerY'),
    effectNumber(e, 'angle'),
  ));
}

function applyOffset(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const blend = effectNumber(e, 'blend');
  if (blend >= 100) return;
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  // `offsetData` writes back into the buffer it was handed (its wrapping
  // sampler owns its own scratch), so this is a putImageData case rather than
  // an applyRemapEffect one.
  offsetData(
    img.data, w, h,
    w / 2 + effectNumber(e, 'shiftX'),
    h / 2 + effectNumber(e, 'shiftY'),
    blend,
  );
  oc.putImageData(img, 0, 0);
}

function applyEmboss(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const blend = effectNumber(e, 'blend');
  if (blend >= 100) return;
  applyRemapEffect(oc, w, h, (d) => embossData(
    d, w, h,
    effectNumber(e, 'angle'),
    effectNumber(e, 'relief'),
    effectNumber(e, 'contrast'),
    blend,
  ));
}

function applyScatter(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const amount = effectNumber(e, 'amount');
  if (amount <= 0) return;
  const grain = effectNumber(e, 'grain');
  applyRemapEffect(oc, w, h, (d) => scatterData(
    d, w, h, amount,
    // The same 0/1/2 encoding as Blur Dimensions, deliberately.
    grain >= 2 ? 'vertical' : grain >= 1 ? 'horizontal' : 'both',
    effectNumber(e, 'seed'),
    effectNumber(e, 'evolution'),
  ));
}

function applyRadialWipe(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const completion = effectNumber(e, 'completion');
  if (completion <= 0) return;
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  radialWipeData(
    img.data, w, h,
    completion / 100,
    effectNumber(e, 'startAngle'),
    radialWipeDirection(effectNumber(e, 'wipe')),
    w / 2 + effectNumber(e, 'centerX'),
    h / 2 + effectNumber(e, 'centerY'),
    effectNumber(e, 'feather'),
  );
  oc.putImageData(img, 0, 0);
}

function applyBlockDissolve(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const completion = effectNumber(e, 'completion');
  if (completion <= 0) return;
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  blockDissolveData(
    img.data, w, h,
    completion / 100,
    effectNumber(e, 'blockWidth'),
    effectNumber(e, 'blockHeight'),
    effectNumber(e, 'feather'),
    effectNumber(e, 'seed'),
  );
  oc.putImageData(img, 0, 0);
}

function applyLumaKey(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  lumaKeyData(
    img.data,
    lumaKeyType(effectNumber(e, 'keyType')),
    effectNumber(e, 'threshold'),
    effectNumber(e, 'tolerance'),
    effectNumber(e, 'softness'),
  );
  oc.putImageData(img, 0, 0);
}

function applyMinimax(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const radius = effectNumber(e, 'radius');
  if (radius <= 0) return;
  const direction = effectNumber(e, 'direction');
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  minimaxData(
    img.data, w, h,
    minimaxOp(effectNumber(e, 'operation')),
    radius,
    minimaxChannel(effectNumber(e, 'channel')),
    direction >= 2 ? 'vertical' : direction >= 1 ? 'horizontal' : 'both',
  );
  oc.putImageData(img, 0, 0);
}

function applyChannelBlur(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const radii = {
    red: effectNumber(e, 'redBlurriness'),
    green: effectNumber(e, 'greenBlurriness'),
    blue: effectNumber(e, 'blueBlurriness'),
    alpha: effectNumber(e, 'alphaBlurriness'),
  };
  // All four at zero is the state of a freshly added effect, and each pass
  // would be a no-op anyway — skip the getImageData round trip entirely.
  if (radii.red <= 0 && radii.green <= 0 && radii.blue <= 0 && radii.alpha <= 0) return;
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  channelBlurData(
    img.data, w, h, radii,
    blurDimensions(effectNumber(e, 'dimensions')),
    bool(e, 'repeatEdge', false),
  );
  oc.putImageData(img, 0, 0);
}

function applyUnsharpMask(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const amount = effectNumber(e, 'amount');
  const radius = effectNumber(e, 'radius');
  if (amount <= 0 || radius <= 0) return;
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  unsharpMaskData(img.data, w, h, amount, radius, effectNumber(e, 'threshold'));
  oc.putImageData(img, 0, 0);
}

// ══ Round four ═══════════════════════════════════════════════════════
//
// Marshalling only, as everywhere above: read the params, call the kernel.
//
// Two shapes appear here and the difference matters. Kernels that MUTATE take
// `img.data` and are followed by `putImageData`. Kernels that RESAMPLE return a
// new buffer and go through `applyRemapEffect`, because a resample cannot be
// done in place — a destination pixel may read a source pixel that an earlier
// destination has already overwritten.
//
// Every param key below appears in quoted form, which is what the dead-control
// scanner looks for. A param declared in `EFFECT_DEFS` and never read here is a
// control the user can set, keyframe and save while nothing consumes it.

/** Read an in-place kernel's ImageData, run it, write it back. */
function applyInPlace(
  oc: CanvasRenderingContext2D,
  w: number,
  h: number,
  kernel: (data: Uint8ClampedArray) => void,
): void {
  oc.setTransform(1, 0, 0, 1, 0, 0);
  const img = oc.getImageData(0, 0, w, h);
  kernel(img.data);
  oc.putImageData(img, 0, 0);
}

// ── Blur ──
function applyBilateralBlur(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const radius = effectNumber(e, 'radius');
  if (radius <= 0) return;
  applyRemapEffect(oc, w, h, (d) => bilateralBlurData(
    d, w, h, radius, effectNumber(e, 'colorSigma'), bool(e, 'preserveAlpha', true),
  ));
}

function applySmartBlur(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const radius = effectNumber(e, 'radius');
  if (radius <= 0) return;
  applyRemapEffect(oc, w, h, (d) => smartBlurData(
    d, w, h, radius, effectNumber(e, 'threshold'), effectNumber(e, 'mode'),
  ));
}

function applyCameraLensBlur(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const radius = effectNumber(e, 'radius');
  if (radius <= 0) return;
  applyRemapEffect(oc, w, h, (d) => cameraLensBlurData(
    d, w, h, radius,
    effectNumber(e, 'blades'), effectNumber(e, 'irisRotation'),
    effectNumber(e, 'gain'), effectNumber(e, 'highlightThreshold'),
  ));
}

// ── Distort ──
function applyRipple(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  if (effectNumber(e, 'amplitude') === 0) return;
  applyRemapEffect(oc, w, h, (d) => rippleData(
    d, w, h,
    effectNumber(e, 'centerX'), effectNumber(e, 'centerY'),
    effectNumber(e, 'radius'), effectNumber(e, 'amplitude'),
    effectNumber(e, 'frequency'), effectNumber(e, 'phase'), effectNumber(e, 'decay'),
  ));
}

function applyMagnify(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyRemapEffect(oc, w, h, (d) => magnifyData(
    d, w, h,
    effectNumber(e, 'centerX'), effectNumber(e, 'centerY'),
    effectNumber(e, 'magnification'), effectNumber(e, 'radius'),
    effectNumber(e, 'shape'), effectNumber(e, 'feather'),
  ));
}

function applyWarp(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyRemapEffect(oc, w, h, (d) => warpData(
    d, w, h,
    effectNumber(e, 'style'), effectNumber(e, 'bend'),
    effectNumber(e, 'horizontalDistortion'), effectNumber(e, 'verticalDistortion'),
    effectNumber(e, 'warpAxis'),
  ));
}

function applyPageTurn(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const amount = effectNumber(e, 'amount');
  if (amount <= 0) return;
  applyRemapEffect(oc, w, h, (d) => pageTurnData(
    d, w, h, amount,
    effectNumber(e, 'angle'), effectNumber(e, 'curlRadius'),
    effectNumber(e, 'backOpacity'), effectNumber(e, 'shading'),
  ));
}

function applySplit(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  if (effectNumber(e, 'splitOffset') === 0) return;
  applyRemapEffect(oc, w, h, (d) => splitData(
    d, w, h,
    effectNumber(e, 'splitOffset'), effectNumber(e, 'angle'),
    effectNumber(e, 'centerX'), effectNumber(e, 'centerY'),
  ));
}

function applySlant(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  if (effectNumber(e, 'slant') === 0) return;
  applyRemapEffect(oc, w, h, (d) => slantData(
    d, w, h, effectNumber(e, 'slant'), effectNumber(e, 'slantAxis'), effectNumber(e, 'floor'),
  ));
}

function applySmear(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyRemapEffect(oc, w, h, (d) => smearData(
    d, w, h,
    effectNumber(e, 'fromX'), effectNumber(e, 'fromY'),
    effectNumber(e, 'toX'), effectNumber(e, 'toY'),
    effectNumber(e, 'radius'), effectNumber(e, 'elasticity'),
  ));
}

function applyRollingShutter(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  if (effectNumber(e, 'sweep') === 0 && effectNumber(e, 'wobble') === 0) return;
  applyRemapEffect(oc, w, h, (d) => rollingShutterData(
    d, w, h,
    effectNumber(e, 'sweep'), effectNumber(e, 'wobble'),
    effectNumber(e, 'scanDirection'), bool(e, 'verticalScan', false),
  ));
}

function applyRadialShadow(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  if (effectNumber(e, 'shadowOpacity') <= 0) return;
  applyRemapEffect(oc, w, h, (d) => radialShadowData(
    d, w, h,
    effectNumber(e, 'lightX'), effectNumber(e, 'lightY'),
    effectNumber(e, 'projection'),
    parseHex(str(e, 'shadowColor', '#000000')),
    effectNumber(e, 'shadowOpacity'), effectNumber(e, 'softness'),
    effectNumber(e, 'renderMode'),
  ));
}

// ── Generate ──
function applyCircle(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  drawCircle(
    oc, w, h,
    effectNumber(e, 'centerX'), effectNumber(e, 'centerY'), effectNumber(e, 'radius'),
    str(e, 'color', '#ffffff'), effectNumber(e, 'opacity'), effectNumber(e, 'feather'),
    effectNumber(e, 'thickness'), bool(e, 'invertCircle', false), effectNumber(e, 'composite'),
  );
}

function applyEllipse(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  drawEllipse(
    oc, w, h,
    effectNumber(e, 'centerX'), effectNumber(e, 'centerY'),
    effectNumber(e, 'ellipseWidth'), effectNumber(e, 'ellipseHeight'),
    effectNumber(e, 'rotation'), effectNumber(e, 'thickness'), effectNumber(e, 'softness'),
    str(e, 'color', '#ffffff'), effectNumber(e, 'opacity'), effectNumber(e, 'composite'),
  );
}

function applyRadioWaves(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  drawRadioWaves(
    oc, w, h,
    effectNumber(e, 'centerX'), effectNumber(e, 'centerY'),
    effectNumber(e, 'waveCount'), effectNumber(e, 'maxRadius'), effectNumber(e, 'phase'),
    effectNumber(e, 'thickness'), str(e, 'color', '#7dd3fc'), effectNumber(e, 'opacity'),
    effectNumber(e, 'fadeOut'), effectNumber(e, 'composite'),
  );
}

function applyLightning(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  drawLightning(
    oc, w, h,
    effectNumber(e, 'startX'), effectNumber(e, 'startY'),
    effectNumber(e, 'endX'), effectNumber(e, 'endY'),
    effectNumber(e, 'detail'), effectNumber(e, 'amplitude'), effectNumber(e, 'branches'),
    effectNumber(e, 'thickness'), str(e, 'color', '#cfe8ff'), effectNumber(e, 'glow'),
    effectNumber(e, 'opacity'), effectNumber(e, 'seed'), effectNumber(e, 'composite'),
  );
}

function applyLightRays(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  drawLightRays(
    oc, w, h,
    effectNumber(e, 'centerX'), effectNumber(e, 'centerY'),
    effectNumber(e, 'rayCount'), effectNumber(e, 'rayLength'), effectNumber(e, 'spread'),
    effectNumber(e, 'rotation'), str(e, 'color', '#fff3c4'), effectNumber(e, 'opacity'),
    effectNumber(e, 'falloff'), effectNumber(e, 'seed'), effectNumber(e, 'composite'),
  );
}

function applyLightSweep(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  drawLightSweep(
    oc, w, h,
    effectNumber(e, 'position'), effectNumber(e, 'sweepWidth'), effectNumber(e, 'angle'),
    str(e, 'color', '#ffffff'), effectNumber(e, 'intensity'), effectNumber(e, 'softness'),
    effectNumber(e, 'composite'),
  );
}

function applyAudioWaveform(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  // `samples` is RESOLVED — written by `buildSnapshot` from `audioLayerId`. An
  // unwired or silent source leaves it empty and the kernel draws nothing,
  // which is deliberately distinguishable from a flat line.
  const raw = paramsOf(e).samples;
  const samples = Array.isArray(raw) ? (raw as number[]) : [];
  drawAudioWaveform(
    oc, w, h, samples,
    effectNumber(e, 'displayMode'), effectNumber(e, 'maxHeight'), effectNumber(e, 'thickness'),
    str(e, 'insideColor', '#7dd3fc'), str(e, 'outsideColor', '#1d4ed8'),
    effectNumber(e, 'opacity'), effectNumber(e, 'composite'),
  );
}

// ── Stylize ──
function applyCartoon(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyRemapEffect(oc, w, h, (d) => cartoonData(
    d, w, h,
    effectNumber(e, 'smoothness'), effectNumber(e, 'levels'),
    effectNumber(e, 'edgeThreshold'), effectNumber(e, 'edgeWidth'), effectNumber(e, 'edgeOpacity'),
  ));
}

function applyBrushStrokes(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  if (effectNumber(e, 'density') <= 0) return;
  applyRemapEffect(oc, w, h, (d) => brushStrokesData(
    d, w, h,
    effectNumber(e, 'strokeAngle'), effectNumber(e, 'strokeLength'),
    effectNumber(e, 'randomness'), effectNumber(e, 'cellSize'), effectNumber(e, 'density'),
  ));
}

function applyStrobeLight(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyInPlace(oc, w, h, (d) => strobeLightData(
    d,
    // Resolved from the clock — see `TIME_DEPENDENT`.
    effectNumber(e, 'time'),
    effectNumber(e, 'strobePeriod'), effectNumber(e, 'strobeDuty'),
    effectNumber(e, 'strobeOperation'), parseHex(str(e, 'strobeColor', '#ffffff')),
    effectNumber(e, 'intensity'),
  ));
}

function applyColorEmboss(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyRemapEffect(oc, w, h, (d) => colorEmbossData(
    d, w, h,
    effectNumber(e, 'direction'), effectNumber(e, 'relief'),
    effectNumber(e, 'contrast'), effectNumber(e, 'blendWithOriginal'),
  ));
}

function applyHalftone(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyRemapEffect(oc, w, h, (d) => halftoneData(
    d, w, h,
    effectNumber(e, 'cellSize'), effectNumber(e, 'screenAngle'), effectNumber(e, 'contrast'),
    parseHex(str(e, 'inkColor', '#000000')), parseHex(str(e, 'paperColor', '#ffffff')),
    bool(e, 'colorize', false), effectNumber(e, 'blendWithOriginal'),
  ));
}

function applyKaleidoscope(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyRemapEffect(oc, w, h, (d) => kaleidoscopeData(
    d, w, h,
    effectNumber(e, 'segments'), effectNumber(e, 'centerX'), effectNumber(e, 'centerY'),
    effectNumber(e, 'rotation'), effectNumber(e, 'sourceAngle'), effectNumber(e, 'zoom'),
  ));
}

function applyVignette(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  if (effectNumber(e, 'amount') === 0) return;
  applyInPlace(oc, w, h, (d) => vignetteData(
    d, w, h,
    effectNumber(e, 'amount'), effectNumber(e, 'size'), effectNumber(e, 'feather'),
    effectNumber(e, 'roundness'), effectNumber(e, 'centerX'), effectNumber(e, 'centerY'),
  ));
}

function applyBurnFilm(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  if (effectNumber(e, 'burn') <= 0) return;
  applyInPlace(oc, w, h, (d) => burnFilmData(
    d, w, h,
    effectNumber(e, 'burn'), effectNumber(e, 'centerX'), effectNumber(e, 'centerY'),
    parseHex(str(e, 'burnColor', '#fff6e0')), parseHex(str(e, 'charColor', '#3d1f0a')),
    effectNumber(e, 'randomness'), effectNumber(e, 'seed'),
  ));
}

// ── Round five ──

function applyStarBurst(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyRemapEffect(oc, w, h, (d) => starBurstData(
    d, w, h,
    effectNumber(e, 'phase'), effectNumber(e, 'amount'), effectNumber(e, 'size'),
    parseHex(str(e, 'starColor', '#ffffff')),
    effectNumber(e, 'blend'), effectNumber(e, 'seed'),
  ));
}

function applySnowfall(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  if (effectNumber(e, 'amount') <= 0) return;
  applyRemapEffect(oc, w, h, (d) => snowfallData(
    d, w, h,
    effectNumber(e, 'amount'), effectNumber(e, 'size'), effectNumber(e, 'evolution'),
    effectNumber(e, 'wind'), effectNumber(e, 'opacity'),
    parseHex(str(e, 'flakeColor', '#ffffff')), effectNumber(e, 'seed'),
  ));
}

function applyRainfall(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  if (effectNumber(e, 'amount') <= 0) return;
  applyRemapEffect(oc, w, h, (d) => rainfallData(
    d, w, h,
    effectNumber(e, 'amount'), effectNumber(e, 'length'), effectNumber(e, 'angle'),
    effectNumber(e, 'evolution'), effectNumber(e, 'opacity'),
    parseHex(str(e, 'rainColor', '#cfe6ff')), effectNumber(e, 'seed'),
  ));
}

function applyWriteOn(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyRemapEffect(oc, w, h, (d) => writeOnData(
    d, w, h,
    effectNumber(e, 'startX'), effectNumber(e, 'startY'),
    effectNumber(e, 'endX'), effectNumber(e, 'endY'),
    effectNumber(e, 'completion'), effectNumber(e, 'brushSize'),
    parseHex(str(e, 'brushColor', '#ffffff')),
    effectNumber(e, 'wobble'), effectNumber(e, 'taper'),
  ));
}

function applyLightBurst(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  if (effectNumber(e, 'intensity') <= 0) return;
  applyRemapEffect(oc, w, h, (d) => lightBurstData(
    d, w, h,
    effectNumber(e, 'centerX'), effectNumber(e, 'centerY'),
    effectNumber(e, 'intensity'), effectNumber(e, 'rayLength'),
  ));
}

function applyGlass(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyRemapEffect(oc, w, h, (d) => glassData(
    d, w, h,
    effectNumber(e, 'bumpSoftness'), effectNumber(e, 'height'), effectNumber(e, 'displacement'),
    effectNumber(e, 'lightAngle'), effectNumber(e, 'lightIntensity'), effectNumber(e, 'shininess'),
  ));
}

function applyTexturize(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  if (effectNumber(e, 'contrast') <= 0) return;
  applyRemapEffect(oc, w, h, (d) => texturizeData(
    d, w, h,
    effectNumber(e, 'pattern'), effectNumber(e, 'contrast'),
    effectNumber(e, 'scale'), effectNumber(e, 'lightAngle'),
  ));
}

function applyThreads(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyRemapEffect(oc, w, h, (d) => threadsData(
    d, w, h,
    effectNumber(e, 'thickness'), effectNumber(e, 'spacing'), effectNumber(e, 'depth'),
  ));
}

function applyChromaticAberration(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  if (effectNumber(e, 'amount') <= 0) return;
  applyRemapEffect(oc, w, h, (d) => chromaticAberrationData(
    d, w, h,
    effectNumber(e, 'amount'), effectNumber(e, 'aberrationMode'), effectNumber(e, 'angle'),
    effectNumber(e, 'falloff'), effectNumber(e, 'centerX'), effectNumber(e, 'centerY'),
  ));
}

function applyHexTile(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyRemapEffect(oc, w, h, (d) => hexTileData(
    d, w, h, effectNumber(e, 'radius'), effectNumber(e, 'border'),
  ));
}

function applyVectorBlur(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  if (effectNumber(e, 'amount') <= 0) return;
  applyRemapEffect(oc, w, h, (d) => vectorBlurData(
    d, w, h,
    effectNumber(e, 'amount'), effectNumber(e, 'angleOffset'), effectNumber(e, 'smoothness'),
  ));
}

function applyFloMotion(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyRemapEffect(oc, w, h, (d) => floMotionData(
    d, w, h,
    effectNumber(e, 'knot1X'), effectNumber(e, 'knot1Y'), effectNumber(e, 'knot1Amount'),
    effectNumber(e, 'knot2X'), effectNumber(e, 'knot2Y'), effectNumber(e, 'knot2Amount'),
    effectNumber(e, 'falloff'),
  ));
}

function applyLens(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyRemapEffect(oc, w, h, (d) => lensData(
    d, w, h,
    effectNumber(e, 'centerX'), effectNumber(e, 'centerY'),
    effectNumber(e, 'size'), effectNumber(e, 'convergence'),
  ));
}

function applyGriddler(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyRemapEffect(oc, w, h, (d) => griddlerData(
    d, w, h,
    effectNumber(e, 'tileSize'), effectNumber(e, 'horizontalScale'),
    effectNumber(e, 'verticalScale'), effectNumber(e, 'rotation'),
  ));
}

function applyBallAction(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyRemapEffect(oc, w, h, (d) => ballActionData(
    d, w, h,
    effectNumber(e, 'grid'), effectNumber(e, 'ballSize'),
    effectNumber(e, 'scatter'), effectNumber(e, 'seed'),
  ));
}

function applyDrizzle(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  if (effectNumber(e, 'dripRate') <= 0) return;
  applyRemapEffect(oc, w, h, (d) => drizzleData(
    d, w, h,
    effectNumber(e, 'dripRate'), effectNumber(e, 'rippleHeight'), effectNumber(e, 'spreading'),
    effectNumber(e, 'evolution'), effectNumber(e, 'seed'),
  ));
}

function applyJaws(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  if (effectNumber(e, 'completion') <= 0) return;
  applyRemapEffect(oc, w, h, (d) => jawsData(
    d, w, h,
    effectNumber(e, 'completion'), effectNumber(e, 'direction'),
    effectNumber(e, 'teethHeight'), effectNumber(e, 'teethWidth'),
  ));
}

function applyPixelPolly(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  if (effectNumber(e, 'completion') <= 0) return;
  applyRemapEffect(oc, w, h, (d) => pixelPollyData(
    d, w, h,
    effectNumber(e, 'completion'), effectNumber(e, 'cellSize'), effectNumber(e, 'gravity'),
    effectNumber(e, 'spin'), effectNumber(e, 'centerX'), effectNumber(e, 'centerY'),
    effectNumber(e, 'seed'),
  ));
}

function applyTwister(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  if (effectNumber(e, 'completion') <= 0) return;
  applyRemapEffect(oc, w, h, (d) => twisterData(
    d, w, h,
    effectNumber(e, 'completion'), effectNumber(e, 'centerY'), effectNumber(e, 'twist'),
  ));
}

function applyCardDance(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  if (effectNumber(e, 'amount') <= 0) return;
  applyRemapEffect(oc, w, h, (d) => cardDanceData(
    d, w, h,
    effectNumber(e, 'rows'), effectNumber(e, 'columns'), effectNumber(e, 'amount'),
    effectNumber(e, 'cardRotation'), effectNumber(e, 'phase'),
  ));
}

// ── Colour ──
function applyEqualize(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  if (effectNumber(e, 'amount') <= 0) return;
  applyInPlace(oc, w, h, (d) => equalizeData(
    d, effectNumber(e, 'equalizeMode'), effectNumber(e, 'amount'), effectNumber(e, 'blend'),
  ));
}

function applyAutoLevels(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyInPlace(oc, w, h, (d) => autoLevelsData(
    d, effectNumber(e, 'blackClip'), effectNumber(e, 'whiteClip'), effectNumber(e, 'blend'),
  ));
}

function applyAutoContrast(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyInPlace(oc, w, h, (d) => autoContrastData(
    d, effectNumber(e, 'blackClip'), effectNumber(e, 'whiteClip'), effectNumber(e, 'blend'),
  ));
}

function applyAutoColor(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyInPlace(oc, w, h, (d) => autoColorData(
    d, effectNumber(e, 'blackClip'), effectNumber(e, 'whiteClip'),
    effectNumber(e, 'snapNeutral'), effectNumber(e, 'blend'),
  ));
}

function applyChangeColor(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyInPlace(oc, w, h, (d) => changeColorData(
    d, parseHex(str(e, 'targetColor', '#ff0000')),
    effectNumber(e, 'hueTolerance'), effectNumber(e, 'satTolerance'), effectNumber(e, 'lightTolerance'),
    effectNumber(e, 'softness'), effectNumber(e, 'hueShift'),
    effectNumber(e, 'satScale'), effectNumber(e, 'lightScale'),
    bool(e, 'invertSelection', false),
  ));
}

function applyChangeToColor(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyInPlace(oc, w, h, (d) => changeToColorData(
    d, parseHex(str(e, 'fromColor', '#ff0000')), parseHex(str(e, 'toColor', '#0055ff')),
    effectNumber(e, 'hueTolerance'), effectNumber(e, 'satTolerance'), effectNumber(e, 'lightTolerance'),
    effectNumber(e, 'softness'), bool(e, 'preserveLightness', true),
  ));
}

function applyLeaveColor(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  if (effectNumber(e, 'amount') <= 0) return;
  applyInPlace(oc, w, h, (d) => leaveColorData(
    d, parseHex(str(e, 'targetColor', '#ff0000')),
    effectNumber(e, 'tolerance'), effectNumber(e, 'softness'), effectNumber(e, 'amount'),
  ));
}

function applyToner(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyInPlace(oc, w, h, (d) => tonerData(
    d,
    parseHex(str(e, 'blackTone', '#000000')),
    parseHex(str(e, 'shadowTone', '#2a2a45')),
    parseHex(str(e, 'midTone', '#8a7a63')),
    parseHex(str(e, 'highlightTone', '#e8d9b8')),
    parseHex(str(e, 'whiteTone', '#ffffff')),
    effectNumber(e, 'blend'),
  ));
}

// ── Keying & Channel ──
function applyColorKey(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyInPlace(oc, w, h, (d) => colorKeyData(
    d, parseHex(str(e, 'keyColor', '#00ff00')),
    effectNumber(e, 'tolerance'), effectNumber(e, 'edgeSoftness'),
  ));
}

function applyColorRange(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyInPlace(oc, w, h, (d) => colorRangeData(
    d, parseHex(str(e, 'keyColor', '#00ff00')), effectNumber(e, 'colorSpace'),
    effectNumber(e, 'minTolerance'), effectNumber(e, 'maxTolerance'), effectNumber(e, 'lumaWeight'),
  ));
}

function applyExtract(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyInPlace(oc, w, h, (d) => extractData(
    d, effectNumber(e, 'extractChannel'),
    effectNumber(e, 'blackPoint'), effectNumber(e, 'whitePoint'),
    effectNumber(e, 'blackSoftness'), effectNumber(e, 'whiteSoftness'),
    bool(e, 'invertExtract', false),
  ));
}

function applySpillSuppressor(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  if (effectNumber(e, 'amount') <= 0) return;
  applyInPlace(oc, w, h, (d) => spillSuppressorData(
    d, parseHex(str(e, 'keyColor', '#00ff00')),
    effectNumber(e, 'amount'), bool(e, 'preserveLuma', true),
  ));
}

function applyMatteChoker(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyRemapEffect(oc, w, h, (d) => matteChokerData(
    d, w, h,
    effectNumber(e, 'spread'), effectNumber(e, 'choke'),
    effectNumber(e, 'softness'), effectNumber(e, 'iterations'),
  ));
}

function applyAlphaLevels(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyInPlace(oc, w, h, (d) => alphaLevelsData(
    d, effectNumber(e, 'inBlack'), effectNumber(e, 'inWhite'), effectNumber(e, 'gamma'),
    effectNumber(e, 'outBlack'), effectNumber(e, 'outWhite'),
  ));
}

function applySolidComposite(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyInPlace(oc, w, h, (d) => solidCompositeData(
    d, parseHex(str(e, 'solidColor', '#000000')),
    effectNumber(e, 'sourceOpacity'), effectNumber(e, 'solidOpacity'),
    effectNumber(e, 'compositeMode'),
  ));
}

function applyChannelCombiner(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyInPlace(oc, w, h, (d) => channelCombinerData(d, effectNumber(e, 'combinerMode')));
}

function applyRemoveColorMatting(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  if (effectNumber(e, 'amount') <= 0) return;
  applyInPlace(oc, w, h, (d) => removeColorMattingData(
    d, parseHex(str(e, 'backgroundColor', '#000000')),
    effectNumber(e, 'threshold'), effectNumber(e, 'amount'),
  ));
}

// ── Transition & Noise ──
function applyIrisWipe(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const completion = effectNumber(e, 'completion');
  if (completion <= 0 && !bool(e, 'invertIris', false)) return;
  applyInPlace(oc, w, h, (d) => irisWipeData(
    d, w, h, completion,
    effectNumber(e, 'centerX'), effectNumber(e, 'centerY'),
    effectNumber(e, 'irisPoints'), effectNumber(e, 'rotation'),
    effectNumber(e, 'innerRadius'), bool(e, 'useInnerRadius', false),
    effectNumber(e, 'feather'), bool(e, 'invertIris', false),
  ));
}

function applyLightWipe(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const completion = effectNumber(e, 'completion');
  if (completion <= 0) return;
  applyInPlace(oc, w, h, (d) => lightWipeData(
    d, w, h, completion,
    effectNumber(e, 'wipeShape'), effectNumber(e, 'angle'),
    effectNumber(e, 'centerX'), effectNumber(e, 'centerY'),
    effectNumber(e, 'lightWidth'), parseHex(str(e, 'lightColor', '#ffffff')),
    effectNumber(e, 'intensity'), effectNumber(e, 'feather'),
  ));
}

function applyLineSweep(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const completion = effectNumber(e, 'completion');
  if (completion <= 0 && !bool(e, 'invertSweep', false)) return;
  applyInPlace(oc, w, h, (d) => lineSweepData(
    d, w, h, completion,
    effectNumber(e, 'lineCount'), effectNumber(e, 'angle'), effectNumber(e, 'stagger'),
    effectNumber(e, 'feather'), bool(e, 'invertSweep', false),
  ));
}

function applyGridWipe(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const completion = effectNumber(e, 'completion');
  if (completion <= 0 && !bool(e, 'invertGrid', false)) return;
  applyInPlace(oc, w, h, (d) => gridWipeData(
    d, w, h, completion,
    effectNumber(e, 'columns'), effectNumber(e, 'rows'), effectNumber(e, 'tileShape'),
    effectNumber(e, 'randomSeed'), effectNumber(e, 'feather'), bool(e, 'invertGrid', false),
  ));
}

function applyDustAndScratches(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  applyRemapEffect(oc, w, h, (d) => dustAndScratchesData(
    d, w, h, effectNumber(e, 'radius'), effectNumber(e, 'threshold'),
  ));
}

function applyNoiseAlpha(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  if (effectNumber(e, 'amount') <= 0) return;
  applyInPlace(oc, w, h, (d) => noiseAlphaData(
    d, w, effectNumber(e, 'amount'), bool(e, 'uniformNoise', true),
    effectNumber(e, 'seed'), effectNumber(e, 'noisePhase'), bool(e, 'clipResult', true),
  ));
}
