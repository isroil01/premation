/**
 * Resolving the Glass layer style for a frame.
 *
 * Kept out of layerStyles.ts because glass is the one style that does NOT
 * compile to an effect: the effect chain runs on a layer's own pixels, and
 * glass is a function of what is behind it. It resolves straight onto the
 * renderable and is composited by the renderer's backdrop branch.
 *
 * Pure and unit-testable: the sampled animation map goes in, a plain resolved
 * struct comes out.
 */

import type { GlassStyle } from './layerStyles';
import { defaultGlassStyle } from './layerStyles';

/** Prop-path a glass parameter animates under. */
export function glassPropPath(param: keyof GlassStyle): string {
  return `glass.${param}`;
}

/** Numeric glass parameters, in the order the inspector shows them. */
export const GLASS_PARAMS = [
  'blur', 'saturation', 'tintOpacity',
  'refraction', 'edgeWidth', 'chromaticAberration',
  'rimOpacity', 'rimWidth', 'rimAngle',
  'specularAngle', 'specularIntensity', 'specularFalloff',
  'grain',
] as const;
export type GlassParam = (typeof GLASS_PARAMS)[number];

/** Every field resolved to a concrete number, ready for the renderable. */
export interface ResolvedGlass {
  blur: number;
  saturation: number;
  tintColor: string;
  tintOpacity: number;
  refraction: number;
  edgeWidth: number;
  chromaticAberration: number;
  rimColor: string;
  rimOpacity: number;
  rimWidth: number;
  rimAngle: number;
  specularAngle: number;
  specularIntensity: number;
  specularFalloff: number;
  grain: number;
}

/**
 * Resolve a style for one frame, letting an animated track win over the static
 * value — so a panel can frost in, or its highlight sweep across, from ordinary
 * keyframes on ordinary prop paths.
 *
 * `globalLightAngle` binds the rim (and the specular that reads with it) to the
 * composition light when the style opts in, so every glass panel in the comp
 * agrees and can be re-lit from one control.
 */
export function resolveGlass(
  style: GlassStyle | undefined,
  av: Map<string, number> | undefined,
  globalLightAngle?: number,
): ResolvedGlass | undefined {
  if (!style || !style.enabled) return undefined;
  const d = defaultGlassStyle();
  const val = (param: GlassParam, fallback: number | undefined): number =>
    av?.get(glassPropPath(param)) ?? fallback ?? (d[param] as number);

  const bound = style.useGlobalLight && Number.isFinite(globalLightAngle);
  const rimAngle = bound ? (globalLightAngle as number) : val('rimAngle', style.rimAngle);

  return {
    blur: Math.max(0, val('blur', style.blur)),
    saturation: Math.max(0, val('saturation', style.saturation)),
    tintColor: style.tintColor ?? d.tintColor,
    tintOpacity: clamp01(val('tintOpacity', style.tintOpacity)),
    refraction: val('refraction', style.refraction),
    edgeWidth: Math.max(0, val('edgeWidth', style.edgeWidth)),
    chromaticAberration: val('chromaticAberration', style.chromaticAberration),
    rimColor: style.rimColor ?? d.rimColor,
    rimOpacity: clamp01(val('rimOpacity', style.rimOpacity)),
    rimWidth: Math.max(0, val('rimWidth', style.rimWidth)),
    rimAngle,
    // The specular follows the rim when the light is bound — they are one
    // light, and letting them diverge produces a highlight that disagrees with
    // the edge it is supposed to be catching on.
    specularAngle: bound ? rimAngle : val('specularAngle', style.specularAngle),
    specularIntensity: Math.max(0, val('specularIntensity', style.specularIntensity)),
    specularFalloff: Math.max(0.1, val('specularFalloff', style.specularFalloff)),
    grain: clamp01(val('grain', style.grain)),
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
