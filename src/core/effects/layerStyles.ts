/**
 * Layer styles (Prompt E8) — Photoshop-style, toggleable per-layer styling.
 *
 * Stored on the node's `fx` component (key 'layerStyles'), so History /
 * autosave / export capture them like the other fx data.
 *
 * ── These used to render nothing ─────────────────────────────────────
 * They compiled to a CSS `filter` string, which was correct when a Canvas2D
 * backend consumed it. That backend was deleted; the GPU pipeline takes
 * STRUCTURED effects (`RenderableEffect`) and never reads `RenderLayer.filter`.
 * So Drop Shadow and Outer Glow produced no pixels at all, and nine of the
 * sixteen style presets — Glass, Soft UI, Input Field, Gradient Card, Neon,
 * Sticker, Chrome, Glow Text, Long Shadow — shipped their fills and strokes
 * with none of their depth.
 *
 * `layerStylesToEffects` is the fix: it compiles a style set into the same
 * effect objects the effect stack produces, so they flow through the ordinary
 * GPU effect chain. `layerStylesToFilter` is retained ONLY because export and
 * older callers still reference the CSS form; nothing in the render path reads
 * it.
 *
 * ── What compiles to what ────────────────────────────────────────────
 * ALL nine styles render. Each maps onto an ordinary effect type, in
 * Photoshop's stacking order (shadow/glow behind, overlays recolour, stroke on
 * top):
 *
 *   dropShadow      → 'drop-shadow'    outerGlow  → 'glow'
 *   innerShadow     → 'inner-shadow'   innerGlow  → 'inner-glow'
 *   satin           → 'satin'          bevel      → 'bevel'
 *   colorOverlay    → 'fill'           stroke     → 'stroke'
 *   gradientOverlay → 'gradient-ramp'
 *
 * The interior four (inner shadow/glow, satin, bevel) have no GPU shader, so a
 * layer using any of them is CPU-baked — which drops that layer's GPU effect
 * list wholesale. Color Overlay and Stroke therefore have to be drawable by the
 * BAKE as well as by the GPU; see `hasCanvas2dImplementation`. They once were
 * not, and both styles silently vanished the moment an interior style was
 * switched on beside them.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getEventBus } from '@core/events/EventBus';
import { parseHex } from '@core/paint/fill';
import type { Effect, EffectType } from '@core/effects/effects';
import type { SceneNode } from '@core/types';
import { clamp01 } from '@utils/lang';

export interface DropShadowStyle {
  enabled: boolean;
  color: string;
  opacity: number;   // 0..1
  distance: number;  // px
  angle: number;     // degrees (0 = →, 90 = ↓)
  blur: number;      // px
  /**
   * Photoshop Spread — expand the shadow matte before blur, as a percent of
   * `blur`. 0 = soft Gaussian of radius `blur`; 100 = hard silhouette dilated
   * by `blur` px with no soft falloff. Footprint-preserving: dilate by
   * `blur×spread/100`, then blur by `blur×(1−spread/100)`.
   */
  spread?: number;   // 0..100
  /**
   * Take the angle from the composition's GLOBAL LIGHT instead of this style's
   * own `angle`.
   *
   * This is the thing a layer style has that the equivalent effect does not:
   * bound to the global light, every shadow and bevel in the comp agrees, and
   * the whole scene can be re-lit from one control (or that control keyframed,
   * sweeping every shadow together). An effect's angle is always its own.
   *
   * `angle` is still stored while this is on, so unbinding restores whatever
   * the user last set rather than snapping to the light's current direction.
   */
  useGlobalLight?: boolean;
}

export interface OuterGlowStyle {
  enabled: boolean;
  color: string;
  opacity: number; // 0..1
  size: number;    // px
  /** Same meaning as DropShadowStyle.spread, relative to `size`. */
  spread?: number; // 0..100
}

/**
 * A shadow cast INSIDE the silhouette — Photoshop's Inner Shadow.
 *
 * Interior styles darken/light the layer's own opaque pixels rather than
 * growing away from them, which needs the alpha inverted, offset and clipped
 * back inside (see `applyInterior`). That is the capability the effect chain
 * gained for these; without it the style had nowhere to render.
 */
export interface InnerShadowStyle {
  enabled: boolean;
  color: string;
  opacity: number;  // 0..1
  distance: number; // px
  angle: number;    // degrees
  size: number;     // px softness
  /** Take the angle from the composition's global light. */
  useGlobalLight?: boolean;
}

/** Light blooming inward from the contour — Photoshop's Inner Glow. */
export interface InnerGlowStyle {
  enabled: boolean;
  color: string;
  opacity: number; // 0..1
  size: number;    // px
}

/** Interior sheen — Photoshop's Satin. See `applySatin` for the set algebra. */
export interface SatinStyle {
  enabled: boolean;
  color: string;
  opacity: number;  // 0..1
  distance: number; // px
  angle: number;    // degrees
  size: number;     // px
  /** Sheen where the two offset copies AGREE rather than where they differ. */
  invert?: boolean;
}

/**
 * Bevel & Emboss — the only style that SHADES rather than composites.
 *
 * It is also the only consumer of the global light's ALTITUDE: the others need
 * to know which way the light comes from, a bevel also needs to know how
 * steeply, because that is what decides how much of the ramp catches light.
 */
export interface BevelStyle {
  enabled: boolean;
  size: number;   // px — the bevel's width
  depth: number;  // % — how pronounced the slope reads
  direction: 'up' | 'down';
  angle: number;
  altitude: number;
  highlightColor: string;
  highlightOpacity: number; // 0..1
  shadowColor: string;
  shadowOpacity: number;    // 0..1
  /** Take angle AND altitude from the composition's global light. */
  useGlobalLight?: boolean;
}

/** Recolour the layer's opaque pixels — Photoshop's Color Overlay. */
export interface ColorOverlayStyle {
  enabled: boolean;
  color: string;
  opacity: number; // 0..1
}

/** Ramp across the layer's opaque pixels — Photoshop's Gradient Overlay. */
export interface GradientOverlayStyle {
  enabled: boolean;
  from: string;
  to: string;
  opacity: number; // 0..1
  /** Degrees; 0 = left→right, 90 = top→bottom. */
  angle: number;
  /** Take the angle from the composition's global light (see DropShadowStyle). */
  useGlobalLight?: boolean;
}

/** Where the silhouette stroke sits relative to the layer edge. */
export type StrokeStylePosition = 'outside' | 'inside' | 'center';

/**
 * An outline hugging the layer's silhouette — Photoshop's Stroke style.
 *
 * Distinct from the shape STROKE in `core/paint/stroke.ts`: that one follows a
 * vector path and is part of the artwork, this one follows the rendered alpha
 * (so it works on text, images and anything else) and is a look applied over it.
 */
export interface StrokeStyle {
  enabled: boolean;
  color: string;
  opacity: number; // 0..1
  size: number;    // px
  /** Photoshop Position — default Outside (grows the silhouette outward). */
  position?: StrokeStylePosition;
}

/**
 * GLASS — frosted/refractive material, as ONE style rather than a stack.
 *
 * After Effects has no real glass feature: `CC Glass` is inadequate, and the
 * actual technique is a hand-assembled pile of Fast Box Blur on an adjustment
 * layer, a scaled Transform, a Displacement Map pointed at a hand-built source,
 * and CC Light Sweep duplicated and rotated for the second edge. Roughly a
 * dozen manual steps, and the reason for all of them is structural: an AE layer
 * cannot cheaply sample what is composited beneath it, so refraction must be
 * faked with a displacement map.
 *
 * Our compositor already has the backdrop as a texture, so it doesn't have to
 * fake anything — and that makes glass a single parameter set the user tunes,
 * not a recipe they assemble. See packages/renderer/src/shaders/glass.ts.
 *
 * Distances are in comp px and resolve to device px at render; angles are
 * degrees here and radians at the shader. Every field is keyframeable under
 * `glass.<field>`.
 */
export interface GlassStyle {
  enabled: boolean;
  // ── Blur ──
  /** Backdrop blur radius, px. 0 = clear glass (refracts without frosting). */
  blur: number;
  /** Backdrop saturation multiplier. >1 is the "vibrancy" look. */
  saturation: number;
  // ── Tint ──
  tintColor: string;
  tintOpacity: number; // 0..1
  // ── Refraction ──
  /** Edge displacement strength, px. */
  refraction: number;
  /** How far in from the border the displacement reaches, px. */
  edgeWidth: number;
  /** Per-channel offset inside the refraction band, px. Two pixels of this is
   *  the difference between "blurred rectangle" and "glass". */
  chromaticAberration: number;
  // ── Rim ──
  rimColor: string;
  rimOpacity: number; // 0..1
  rimWidth: number;
  rimAngle: number; // degrees
  /** Take the rim angle from the composition's global light, like the other
   *  styles, so one control re-lights every glass panel in the comp. */
  useGlobalLight?: boolean;
  // ── Specular ──
  specularAngle: number; // degrees
  specularIntensity: number; // 0..1
  specularFalloff: number;
  // ── Grain ──
  /** Low-opacity noise, 0..1. A blurred gradient bands on any real display;
   *  this removes it and reads as material rather than as a filter. */
  grain: number;
}

/** A glass panel that looks like glass out of the box — the point of shipping
 *  this as a style is that the default is already usable. */
export function defaultGlassStyle(): GlassStyle {
  return {
    enabled: true,
    blur: 28,
    saturation: 1.9,
    tintColor: '#ffffff',
    tintOpacity: 0.1,
    refraction: 34,
    edgeWidth: 3.5,
    // Chromatic split at the rim is the whole difference between "frosted
    // rectangle" and glass — default was too shy to read on product shots.
    chromaticAberration: 10,
    rimColor: '#ffffff',
    rimOpacity: 0.42,
    rimWidth: 7,
    rimAngle: 315,
    useGlobalLight: true,
    specularAngle: 315,
    specularIntensity: 0.38,
    specularFalloff: 10,
    grain: 0.04,
  };
}

export interface LayerStyles {
  glass?: GlassStyle;
  dropShadow?: DropShadowStyle;
  innerShadow?: InnerShadowStyle;
  outerGlow?: OuterGlowStyle;
  innerGlow?: InnerGlowStyle;
  satin?: SatinStyle;
  bevel?: BevelStyle;
  colorOverlay?: ColorOverlayStyle;
  gradientOverlay?: GradientOverlayStyle;
  stroke?: StrokeStyle;
}

/**
 * Compile a style set into structured effects the renderer can actually draw.
 *
 * Emitted in Photoshop's stacking order — drop shadow first (furthest back),
 * then outer glow — and appended AFTER the layer's own effect stack, matching
 * After Effects, where layer styles evaluate after effects.
 *
 * Style `opacity` is folded into the colour's alpha rather than passed
 * separately, because the effect params carry colour but have no separate
 * opacity of their own for these two types.
 *
 * Ids are derived from the style name (`layerstyle:*`) rather than generated:
 * they must be STABLE across frames, since keyframe prop paths and the
 * renderer's per-effect caching are both keyed by effect id.
 */
/**
 * Which EFFECT parameter each style field compiles to, and the factor between
 * their units.
 *
 * The two names are often different — a Drop Shadow's `blur` is the effect's
 * `softness`, an Outer Glow's `size` is its `radius`, a Gradient Overlay's
 * `opacity` is `blend` — and the 0..1 opacities become 0..100 percentages. The
 * inspector needs this to put a keyframe on the path the RENDERER will sample;
 * guessing `effect.layerstyle:dropShadow.blur` would write a track nothing ever
 * reads.
 *
 * Co-located with `layerStylesToEffects` deliberately: this table and that
 * function are two halves of one mapping, and `layerStyles.test.ts` asserts
 * every entry here names a param the function actually emits, so they cannot
 * drift apart silently.
 */
export interface StyleParamBinding {
  /** Param key on the compiled effect. */
  param: string;
  /** Stored value × this = effect param value (100 for the 0..1 opacities). */
  scale: number;
}
const N = (param: string, scale = 1): StyleParamBinding => ({ param, scale });

export const LAYER_STYLE_NUMBER_PARAMS: Readonly<Record<string, Readonly<Record<string, StyleParamBinding>>>> = {
  dropShadow: {
    distance: N('distance'), angle: N('angle'), blur: N('softness'),
    spread: N('spread'), opacity: N('opacity', 100),
  },
  outerGlow: { size: N('radius'), spread: N('spread'), opacity: N('intensity', 100) },
  innerShadow: { distance: N('distance'), angle: N('angle'), size: N('softness'), opacity: N('opacity', 100) },
  innerGlow: { size: N('size'), opacity: N('opacity', 100) },
  satin: { distance: N('distance'), angle: N('angle'), size: N('size'), opacity: N('opacity', 100) },
  bevel: {
    size: N('size'), depth: N('depth'), angle: N('angle'), altitude: N('altitude'),
    highlightOpacity: N('highlightOpacity', 100), shadowOpacity: N('shadowOpacity', 100),
  },
  colorOverlay: { opacity: N('opacity', 100) },
  gradientOverlay: { angle: N('angle'), opacity: N('blend', 100) },
  stroke: { size: N('width'), opacity: N('opacity', 100) },
};

/** Colour fields → the compiled effect's colour param. Animated through the
 *  decomposed `_r/_g/_b/_a` channel tracks, same as an effect's colour. */
export const LAYER_STYLE_COLOR_PARAMS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  dropShadow: { color: 'color' },
  outerGlow: { color: 'color' },
  innerShadow: { color: 'color' },
  innerGlow: { color: 'color' },
  satin: { color: 'color' },
  bevel: { highlightColor: 'highlightColor', shadowColor: 'shadowColor' },
  colorOverlay: { color: 'color' },
  gradientOverlay: { from: 'colorA', to: 'colorB' },
  stroke: { color: 'color' },
};

/**
 * Which EFFECT TYPE each style compiles to.
 *
 * Lets a reader resolve `effect.layerstyle:<style>.<param>` back to a real
 * definition. The compiled styles are synthesised per frame and never stored on
 * the node, so `getNodeEffects` cannot find them — without this, the timeline
 * fell back to matching the bare param key across every effect definition and
 * would happily label a Bevel's `size` with Inner Glow's description.
 */
export const LAYER_STYLE_EFFECT_TYPE: Readonly<Record<string, EffectType>> = {
  dropShadow: 'drop-shadow',
  outerGlow: 'glow',
  innerShadow: 'inner-shadow',
  innerGlow: 'inner-glow',
  satin: 'satin',
  bevel: 'bevel',
  colorOverlay: 'fill',
  gradientOverlay: 'gradient-ramp',
  stroke: 'stroke',
};

/**
 * Display name per style — what the INSPECTOR calls it.
 *
 * A style track's timeline row used to be labelled from the effect it compiles
 * to, so Outer Glow's Size read "Glow Radius" and Gradient Overlay's Opacity
 * read "Gradient Ramp Blend". Naming a row after an implementation detail the
 * user never chose is exactly the disagreement propertyMeta exists to prevent.
 */
export const LAYER_STYLE_LABEL: Readonly<Record<string, string>> = {
  dropShadow: 'Drop Shadow',
  outerGlow: 'Outer Glow',
  innerShadow: 'Inner Shadow',
  innerGlow: 'Inner Glow',
  satin: 'Satin',
  bevel: 'Bevel & Emboss',
  colorOverlay: 'Color Overlay',
  gradientOverlay: 'Gradient Overlay',
  stroke: 'Stroke',
};

/**
 * Layer styles that do NOT compile to an effect, and their labels.
 *
 * Glass is a function of what is composited BEHIND the layer, so it resolves
 * straight onto the renderable and is drawn by the renderer's backdrop branch
 * (see glassResolve.ts). That is why it cannot appear in `LAYER_STYLE_LABEL`,
 * which is keyed by style → effect.
 *
 * It exists as a registry rather than living only in the counting script
 * because it WAS a hardcoded `+ 1` in `scripts/featureCounts.cjs` — a
 * hand-written number inside the script written to eliminate hand-written
 * numbers. A second backdrop-resolved style would have left the documented
 * count wrong while the guard test stayed green.
 *
 * The full set of layer styles is the two registries together.
 */
export const BACKDROP_STYLES: Readonly<Record<string, string>> = {
  glass: 'Glass',
};

/**
 * Effect param key → the STYLE field it was compiled from (`softness` → `blur`,
 * `radius` → `size`, `blend` → `opacity`). The inverse of the two param maps.
 *
 * Used for labelling only: the field name is the one on the control the user
 * actually edited, so the timeline row and the inspector agree.
 */
export function styleFieldForParam(styleKey: string, param: string): string | null {
  const nums = LAYER_STYLE_NUMBER_PARAMS[styleKey];
  if (nums) {
    for (const [field, b] of Object.entries(nums)) if (b.param === param) return field;
  }
  const cols = LAYER_STYLE_COLOR_PARAMS[styleKey];
  if (cols) {
    for (const [field, p] of Object.entries(cols)) if (p === param) return field;
  }
  return null;
}

/** `layerstyle:dropShadow` → `dropShadow`, or null for a non-style effect id. */
export function styleKeyFromEffectId(effectId: string): string | null {
  return effectId.startsWith('layerstyle:') ? effectId.slice('layerstyle:'.length) : null;
}

/** Stable effect id for a layer style — the key its keyframe tracks hang off
 *  (`effect.layerstyle:dropShadow.distance`). Stable across edits by
 *  construction, which is what makes styles keyframeable at all. */
export function layerStyleEffectId(style: keyof LayerStyles): string {
  return `layerstyle:${style}`;
}

/**
 * @param isAnimated true when the named style carries ANY keyframe track.
 *
 * Load-bearing for animation, not an optimisation. Each style below is emitted
 * only when it would draw something — a drop shadow with distance 0 and blur 0
 * contributes nothing, and emitting it anyway costs a pass on every styled
 * layer. But that test reads the STORED value, and a keyframed parameter's
 * stored value is not what renders. Keyframing shadow opacity 0 → 100 meant the
 * effect was never emitted at the frames where the stored value was 0, so there
 * was nothing for the sampler to raise and the shadow never appeared at all.
 *
 * An animated style therefore always emits and lets the sampled value decide.
 */
export function layerStylesToEffects(
  styles: LayerStyles | undefined,
  globalLightAngle?: number,
  globalLightAltitude?: number,
  isAnimated?: (styleKey: string) => boolean,
): Effect[] {
  if (!styles) return [];
  const out: Effect[] = [];
  const anim = (k: keyof LayerStyles): boolean => isAnimated?.(k as string) ?? false;

  const ds = styles.dropShadow;
  if (ds?.enabled && (ds.blur > 0 || ds.distance > 0 || anim('dropShadow'))) {
    // Bound styles follow the comp light; unbound ones keep their own angle.
    // A missing global angle falls back to the style's own, so a caller that
    // has no composition context (a test, a thumbnail) still renders sensibly.
    const angle = ds.useGlobalLight && Number.isFinite(globalLightAngle)
      ? (globalLightAngle as number)
      : ds.angle;
    out.push({
      id: 'layerstyle:dropShadow',
      type: 'drop-shadow',
      params: {
        distance: Math.max(0, ds.distance),
        angle,
        softness: Math.max(0, ds.blur),
        spread: Math.max(0, Math.min(100, ds.spread ?? 0)),
        color: ds.color,
        // Opacity rides the effect's OWN param rather than being pre-multiplied
        // into an 8-digit colour. Identical output — `extractSpatialEffects`
        // applies `withAlpha(color, opacity/100)` either way — but keyframeable,
        // which the baked form was not: `withAlpha` only matches 6-digit hex, so
        // it returned the pre-alpha'd colour untouched and ignored the param.
        // Animating a shadow's opacity is the ordinary way to fade one in.
        opacity: Math.round(clamp01(ds.opacity) * 100),
      },
    });
  }

  const is = styles.innerShadow;
  if (is?.enabled && (is.size > 0 || is.distance > 0 || anim('innerShadow'))) {
    const angle = is.useGlobalLight && Number.isFinite(globalLightAngle)
      ? (globalLightAngle as number)
      : is.angle;
    out.push({
      id: 'layerstyle:innerShadow',
      type: 'inner-shadow',
      params: {
        distance: Math.max(0, is.distance),
        angle,
        softness: Math.max(0, is.size),
        color: is.color,
        opacity: Math.round(is.opacity * 100),
      },
    });
  }

  const og = styles.outerGlow;
  if (og?.enabled && (og.size > 0 || anim('outerGlow'))) {
    out.push({
      id: 'layerstyle:outerGlow',
      type: 'glow',
      params: {
        radius: Math.max(0, og.size),
        spread: Math.max(0, Math.min(100, og.spread ?? 0)),
        color: og.color,
        // Same as Drop Shadow: keep opacity on the param (here `intensity`, the
        // glow effect's name for it) so it can be keyframed.
        intensity: Math.round(clamp01(og.opacity) * 100),
      },
    });
  }

  const ig = styles.innerGlow;
  if (ig?.enabled && (ig.size > 0 || anim('innerGlow'))) {
    out.push({
      id: 'layerstyle:innerGlow',
      type: 'inner-glow',
      params: {
        size: Math.max(0, ig.size),
        color: ig.color,
        opacity: Math.round(ig.opacity * 100),
      },
    });
  }

  const sa = styles.satin;
  if (sa?.enabled && ((sa.opacity > 0 && (sa.size > 0 || sa.distance > 0)) || anim('satin'))) {
    out.push({
      id: 'layerstyle:satin',
      type: 'satin',
      params: {
        distance: Math.max(0, sa.distance),
        angle: sa.angle,
        size: Math.max(0, sa.size),
        color: sa.color,
        opacity: Math.round(sa.opacity * 100),
        invert: sa.invert === true,
      },
    });
  }

  const bv = styles.bevel;
  if (bv?.enabled && ((bv.depth > 0 && bv.size > 0) || anim('bevel'))) {
    const bound = bv.useGlobalLight && Number.isFinite(globalLightAngle);
    out.push({
      id: 'layerstyle:bevel',
      type: 'bevel',
      params: {
        size: Math.max(1, bv.size),
        depth: Math.max(0, bv.depth),
        direction: bv.direction,
        angle: bound ? (globalLightAngle as number) : bv.angle,
        // Altitude follows the same binding as the angle — they are one light,
        // and letting them diverge would produce shading that disagrees with
        // every other bound style in the composition.
        altitude: bound && Number.isFinite(globalLightAltitude)
          ? (globalLightAltitude as number)
          : bv.altitude,
        highlightColor: bv.highlightColor,
        highlightOpacity: Math.round(bv.highlightOpacity * 100),
        shadowColor: bv.shadowColor,
        shadowOpacity: Math.round(bv.shadowOpacity * 100),
      },
    });
  }

  // Photoshop's stacking order for the styles we can express: shadow and glow
  // sit BEHIND the layer, the overlays recolour it, and the stroke draws on
  // top. Recolouring after the shadow is cast is correct — the shadow comes
  // from the silhouette, which a recolour does not change.
  const co = styles.colorOverlay;
  if (co?.enabled && (co.opacity > 0 || anim('colorOverlay'))) {
    out.push({
      id: 'layerstyle:colorOverlay',
      type: 'fill',
      params: { color: co.color, opacity: Math.round(co.opacity * 100) },
    });
  }

  const go = styles.gradientOverlay;
  if (go?.enabled && (go.opacity > 0 || anim('gradientOverlay'))) {
    const angle = go.useGlobalLight && Number.isFinite(globalLightAngle)
      ? (globalLightAngle as number)
      : go.angle;
    out.push({
      id: 'layerstyle:gradientOverlay',
      type: 'gradient-ramp',
      params: {
        colorA: go.from,
        colorB: go.to,
        angle,
        blend: Math.round(go.opacity * 100),
      },
    });
  }

  const st = styles.stroke;
  if (st?.enabled && ((st.size > 0 && st.opacity > 0) || anim('stroke'))) {
    const position: StrokeStylePosition =
      st.position === 'inside' || st.position === 'center' ? st.position : 'outside';
    out.push({
      id: 'layerstyle:stroke',
      type: 'stroke',
      params: {
        width: Math.max(0, st.size),
        color: st.color,
        opacity: Math.round(st.opacity * 100),
        position,
      },
    });
  }

  return out;
}

/**
 * The colour a layer's SURFACE actually reads as once its overlay styles are
 * applied — what an extruded object's side walls and back cap must be tinted
 * from.
 *
 * An extruded layer is one object, but only its FRONT face is the layer's own
 * pixels; the walls, bevel rings and back cap are geometry the renderer
 * synthesizes, and they take a flat fill derived from `layer.fill`. That fill
 * is the layer's RAW colour, so a Colour Overlay repainted the front face and
 * left every other face the original colour — a red-fronted, blue-sided box.
 * Same for a Gradient Overlay.
 *
 * The overlays are the two styles that answer "what colour is this surface",
 * which is the only question a flat face fill can ask. The rest of the styles
 * (inner shadow, satin, bevel, stroke, glow) describe a 2D SILHOUETTE — an
 * inner shadow hugs the contour of the shape — and a solid's faces have no
 * shared silhouette to hug, so stamping them per-face would draw a seam around
 * every wall strip rather than one coherent object. Those stay on the front
 * face; per-face surface shading on a real solid is the material + lighting
 * system's job, not a layer style's.
 *
 * The gradient case is necessarily an approximation: a face gets ONE colour, so
 * it takes the ramp's midpoint. Reading as part of the same object beats
 * matching no part of it.
 */
export function styledSurfaceFill(styles: LayerStyles | undefined, baseFill: string): string {
  if (!styles) return baseFill;
  let out = baseFill;
  const co = styles.colorOverlay;
  if (co?.enabled && co.opacity > 0) out = mixHex(out, co.color, co.opacity);
  const go = styles.gradientOverlay;
  if (go?.enabled && go.opacity > 0) out = mixHex(out, mixHex(go.from, go.to, 0.5), go.opacity);
  return out;
}

/** Linear mix of two `#rrggbb[aa]` colours; `t` = 0 keeps `a`, 1 takes `b`. */
function mixHex(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  const k = Math.max(0, Math.min(1, t));
  const h = (v: number): string => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(ca.r + (cb.r - ca.r) * k)}${h(ca.g + (cb.g - ca.g) * k)}${h(ca.b + (cb.b - ca.b) * k)}`;
}

/** Styles store opacity 0..1; the effect params want 0..100. */

export const DEFAULT_DROP_SHADOW: DropShadowStyle = {
  enabled: true, color: '#000000', opacity: 0.5, distance: 8, angle: 90, blur: 8,
  spread: 0,
  // On by default, matching Photoshop/AE: a new shadow should agree with every
  // other shadow in the comp until the user deliberately breaks it out.
  useGlobalLight: true,
};
export const DEFAULT_OUTER_GLOW: OuterGlowStyle = {
  enabled: true, color: '#78b4ff', opacity: 0.9, size: 16, spread: 0,
};
export const DEFAULT_INNER_SHADOW: InnerShadowStyle = {
  enabled: true, color: '#000000', opacity: 0.55, distance: 6, angle: 135, size: 8, useGlobalLight: true,
};
export const DEFAULT_INNER_GLOW: InnerGlowStyle = {
  enabled: true, color: '#ffd070', opacity: 0.8, size: 14,
};
export const DEFAULT_SATIN: SatinStyle = {
  enabled: true, color: '#000000', opacity: 0.45, distance: 14, angle: 135, size: 16, invert: false,
};
export const DEFAULT_BEVEL: BevelStyle = {
  enabled: true, size: 10, depth: 100, direction: 'up', angle: 135, altitude: 45,
  highlightColor: '#ffffff', highlightOpacity: 0.75,
  shadowColor: '#000000', shadowOpacity: 0.75,
  useGlobalLight: true,
};
export const DEFAULT_COLOR_OVERLAY: ColorOverlayStyle = {
  enabled: true, color: '#ff2d55', opacity: 1,
};
export const DEFAULT_GRADIENT_OVERLAY: GradientOverlayStyle = {
  enabled: true, from: '#ffffff', to: '#2b7eff', opacity: 1, angle: 90, useGlobalLight: false,
};
export const DEFAULT_STROKE_STYLE: StrokeStyle = {
  enabled: true, color: '#ffffff', opacity: 1, size: 4, position: 'outside',
};

function rgba(hex: string, opacity: number): string {
  const c = parseHex(hex);
  const a = Math.max(0, Math.min(1, (c.a / 255) * opacity));
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${a.toFixed(3)})`;
}

/**
 * Compile a layer's styles into a CSS `filter` string (empty when none apply).
 *
 * NOT part of the render path — no backend reads `RenderLayer.filter`. Retained
 * for export/interop callers that still want the CSS form. Use
 * `layerStylesToEffects` for anything that must appear on screen.
 */
export function layerStylesToFilter(styles: LayerStyles | undefined): string {
  if (!styles) return '';
  const parts: string[] = [];
  const ds = styles.dropShadow;
  if (ds?.enabled && (ds.blur > 0 || ds.distance > 0)) {
    const rad = (ds.angle * Math.PI) / 180;
    const dx = Math.round(ds.distance * Math.cos(rad) * 100) / 100;
    const dy = Math.round(ds.distance * Math.sin(rad) * 100) / 100;
    parts.push(`drop-shadow(${dx}px ${dy}px ${Math.max(0, ds.blur)}px ${rgba(ds.color, ds.opacity)})`);
  }
  const og = styles.outerGlow;
  if (og?.enabled && og.size > 0) {
    // A double pass reads as a fuller glow than a single soft shadow.
    parts.push(`drop-shadow(0 0 ${og.size}px ${rgba(og.color, og.opacity)})`);
    parts.push(`drop-shadow(0 0 ${Math.round(og.size / 2)}px ${rgba(og.color, og.opacity)})`);
  }
  return parts.join(' ');
}

// ── Read / write on the scene graph ──────────────────────────────────

export function readNodeLayerStyles(node: SceneNode): LayerStyles | undefined {
  const fx = node.components.find((c) => c.type === 'fx');
  const s = fx?.props.layerStyles as LayerStyles | undefined;
  if (!s || typeof s !== 'object') return undefined;
  // ANY enabled style, not just shadow and glow. This used to test those two
  // alone, so a layer carrying only a bevel, satin, overlay, stroke — or now
  // glass — resolved to `undefined` at the render seam and rendered none of it,
  // even though `layerStylesToEffects` knew how to compile every one of them.
  const has = Object.values(s).some(
    (v) => !!v && typeof v === 'object' && (v as { enabled?: boolean }).enabled,
  );
  return has ? s : undefined;
}

export function getNodeLayerStyles(nodeId: string): LayerStyles {
  const node = defaultSceneGraph.getNode(nodeId);
  const fx = node?.components.find((c) => c.type === 'fx');
  return (fx?.props.layerStyles as LayerStyles | undefined) ?? {};
}

function write(nodeId: string, styles: LayerStyles): void {
  // Every key, not just shadow and glow: this used to test those two alone, so
  // a layer carrying ONLY a bevel, satin, overlay or glass style was written as
  // `undefined` and silently lost it.
  const empty = Object.values(styles).every((v) => v === undefined);
  defaultSceneGraph.setLayerStyles(nodeId, empty ? undefined : styles);
  getEventBus().emit('AnimationChanged', { nodeId });
}

/**
 * Replace a layer's entire style set in one write.
 *
 * The toggles and patch helpers below are incremental; a style PRESET needs to
 * state the whole result at once, including clearing styles it does not use —
 * doing that by composing toggles would depend on the current state and emit a
 * write per style.
 */
export function setLayerStyles(nodeId: string, styles: LayerStyles): void {
  write(nodeId, styles);
}

/** Toggle a style on/off (creating it with defaults when first enabled). */
export function toggleDropShadow(nodeId: string): void {
  const cur = getNodeLayerStyles(nodeId);
  const next = cur.dropShadow
    ? { ...cur, dropShadow: undefined }
    : { ...cur, dropShadow: { ...DEFAULT_DROP_SHADOW } };
  write(nodeId, next);
}
export function toggleOuterGlow(nodeId: string): void {
  const cur = getNodeLayerStyles(nodeId);
  const next = cur.outerGlow
    ? { ...cur, outerGlow: undefined }
    : { ...cur, outerGlow: { ...DEFAULT_OUTER_GLOW } };
  write(nodeId, next);
}

/**
 * Glass has no `layerStylesToEffects` entry, unlike every other style here.
 *
 * That is deliberate rather than missing: the effect chain runs on the LAYER's
 * own pixels, and glass is a function of what is BEHIND the layer. It is
 * resolved in buildSnapshot straight onto the renderable and composited by the
 * backdrop branch — which is exactly the capability AE lacks and works around
 * with displacement maps.
 */
export function toggleGlass(nodeId: string): void {
  const cur = getNodeLayerStyles(nodeId);
  const next = cur.glass
    ? { ...cur, glass: undefined }
    : { ...cur, glass: defaultGlassStyle() };
  write(nodeId, next);
}
export function updateGlass(nodeId: string, patch: Partial<GlassStyle>): void {
  const cur = getNodeLayerStyles(nodeId);
  write(nodeId, { ...cur, glass: { ...defaultGlassStyle(), ...cur.glass, ...patch } });
}

export function updateDropShadow(nodeId: string, patch: Partial<DropShadowStyle>): void {
  const cur = getNodeLayerStyles(nodeId);
  write(nodeId, { ...cur, dropShadow: { ...DEFAULT_DROP_SHADOW, ...cur.dropShadow, ...patch } });
}
export function updateOuterGlow(nodeId: string, patch: Partial<OuterGlowStyle>): void {
  const cur = getNodeLayerStyles(nodeId);
  write(nodeId, { ...cur, outerGlow: { ...DEFAULT_OUTER_GLOW, ...cur.outerGlow, ...patch } });
}

// ── The three styles added alongside shadow + glow ──────────────────
// Same toggle/patch shape as the originals, so the panel treats them all
// identically and a new style is a registry entry rather than a new pattern.

export function toggleColorOverlay(nodeId: string): void {
  const cur = getNodeLayerStyles(nodeId);
  write(nodeId, { ...cur, colorOverlay: cur.colorOverlay ? undefined : { ...DEFAULT_COLOR_OVERLAY } });
}
export function updateColorOverlay(nodeId: string, patch: Partial<ColorOverlayStyle>): void {
  const cur = getNodeLayerStyles(nodeId);
  write(nodeId, { ...cur, colorOverlay: { ...DEFAULT_COLOR_OVERLAY, ...cur.colorOverlay, ...patch } });
}

export function toggleGradientOverlay(nodeId: string): void {
  const cur = getNodeLayerStyles(nodeId);
  write(nodeId, { ...cur, gradientOverlay: cur.gradientOverlay ? undefined : { ...DEFAULT_GRADIENT_OVERLAY } });
}
export function updateGradientOverlay(nodeId: string, patch: Partial<GradientOverlayStyle>): void {
  const cur = getNodeLayerStyles(nodeId);
  write(nodeId, { ...cur, gradientOverlay: { ...DEFAULT_GRADIENT_OVERLAY, ...cur.gradientOverlay, ...patch } });
}

export function toggleStrokeStyle(nodeId: string): void {
  const cur = getNodeLayerStyles(nodeId);
  write(nodeId, { ...cur, stroke: cur.stroke ? undefined : { ...DEFAULT_STROKE_STYLE } });
}
export function updateStrokeStyle(nodeId: string, patch: Partial<StrokeStyle>): void {
  const cur = getNodeLayerStyles(nodeId);
  write(nodeId, { ...cur, stroke: { ...DEFAULT_STROKE_STYLE, ...cur.stroke, ...patch } });
}

export function toggleInnerShadow(nodeId: string): void {
  const cur = getNodeLayerStyles(nodeId);
  write(nodeId, { ...cur, innerShadow: cur.innerShadow ? undefined : { ...DEFAULT_INNER_SHADOW } });
}
export function updateInnerShadow(nodeId: string, patch: Partial<InnerShadowStyle>): void {
  const cur = getNodeLayerStyles(nodeId);
  write(nodeId, { ...cur, innerShadow: { ...DEFAULT_INNER_SHADOW, ...cur.innerShadow, ...patch } });
}

export function toggleInnerGlow(nodeId: string): void {
  const cur = getNodeLayerStyles(nodeId);
  write(nodeId, { ...cur, innerGlow: cur.innerGlow ? undefined : { ...DEFAULT_INNER_GLOW } });
}
export function updateInnerGlow(nodeId: string, patch: Partial<InnerGlowStyle>): void {
  const cur = getNodeLayerStyles(nodeId);
  write(nodeId, { ...cur, innerGlow: { ...DEFAULT_INNER_GLOW, ...cur.innerGlow, ...patch } });
}

export function toggleSatin(nodeId: string): void {
  const cur = getNodeLayerStyles(nodeId);
  write(nodeId, { ...cur, satin: cur.satin ? undefined : { ...DEFAULT_SATIN } });
}
export function updateSatin(nodeId: string, patch: Partial<SatinStyle>): void {
  const cur = getNodeLayerStyles(nodeId);
  write(nodeId, { ...cur, satin: { ...DEFAULT_SATIN, ...cur.satin, ...patch } });
}

export function toggleBevel(nodeId: string): void {
  const cur = getNodeLayerStyles(nodeId);
  write(nodeId, { ...cur, bevel: cur.bevel ? undefined : { ...DEFAULT_BEVEL } });
}
export function updateBevel(nodeId: string, patch: Partial<BevelStyle>): void {
  const cur = getNodeLayerStyles(nodeId);
  write(nodeId, { ...cur, bevel: { ...DEFAULT_BEVEL, ...cur.bevel, ...patch } });
}
