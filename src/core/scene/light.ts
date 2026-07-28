/**
 * Lights (Prompt 12) — lights for the 2.5D compositor. A light layer brightens
 * the layers beneath it with a screen blend: point (radial glow), ambient
 * (whole-frame lift), spot (cone), or parallel (directional wash, like sun).
 * Position and intensity/radius are ordinary keyframeable props, so lights
 * animate like anything else. (True 3D material-response lighting is out of
 * scope for a 2D compositor.)
 */

import type { SceneNode } from '@core/types';

export type LightType = 'point' | 'ambient' | 'spot' | 'parallel';

/**
 * AE's falloff curve. `none` is the legacy behaviour (a plain radius ramp) and
 * stays the default so existing scenes are unchanged; the other two shape how
 * intensity decays between `radius` and `falloffDistance`.
 */
export type LightFalloff = 'none' | 'smooth' | 'inverse-square';

export interface Light {
  /** Light kind: point (radial glow), ambient (whole-frame lift), spot (cone). */
  type: LightType;
  /** Light colour (hex). */
  color: string;
  /** Brightness, percent (100 = full). */
  intensity: number;
  /** Falloff radius, comp px (point/spot reach). */
  radius: number;
  /** Spot only: direction of the cone, degrees (0 = →, 90 = ↓). */
  angle: number;
  /** Spot only: full cone width, degrees. */
  cone: number;
  /**
   * Spot only: soft edge as a PERCENT of the half-cone (AE's Cone Feather,
   * default 50). The gizmo draws it as a second, fainter cone so you can see
   * how wide the soft edge is without rendering.
   */
  coneFeather: number;
  /** Falloff curve between `radius` and `falloffDistance`. */
  falloff: LightFalloff;
  /** Distance over which the falloff completes, comp px. */
  falloffDistance: number;
  /** Cast 2.5D drop-shadows from this light onto content layers. */
  shadows: boolean;
  /** Shadow opacity, percent (AE's Shadow Darkness). */
  shadowDarkness: number;
  /** Shadow edge softness, comp px (AE's Shadow Diffusion). */
  shadowDiffusion: number;
  /**
   * Point of Interest — spot and parallel lights AIM at it, which is the only
   * way to point a light in 3D. Null means the light has no 3D target and falls
   * back to `angle`, the legacy comp-plane direction: a spot could previously
   * only be swung within the comp plane, so it could never be aimed at a layer
   * at a different depth.
   */
  poi: { x: number; y: number; z: number } | null;
}

/** The unstored defaults — anything equal to these adds nothing to file. */
export const LIGHT_DEFAULTS = {
  intensity: 100,
  radius: 500,
  angle: 0,
  cone: 45,
  coneFeather: 50,
  falloffDistance: 500,
  shadowDarkness: 100,
  shadowDiffusion: 0,
} as const;

const num = (v: unknown, fb: number): number => (typeof v === 'number' ? v : fb);

function lightType(v: unknown): LightType {
  return v === 'ambient' || v === 'spot' || v === 'parallel' ? v : 'point';
}

/** Read a light's config from its components (defaults when unset). Colour
 *  comes from the Style fill; intensity/radius/angle/cone are numeric props
 *  (so the inspector keyframes them); type is a string prop. */
function lightFalloff(v: unknown): LightFalloff {
  return v === 'smooth' || v === 'inverse-square' ? v : 'none';
}

export function readNodeLight(node: SceneNode): Light {
  let type: LightType = 'point';
  let color = '#fff3c0';
  let intensity: number = LIGHT_DEFAULTS.intensity;
  let radius: number = LIGHT_DEFAULTS.radius;
  let angle: number = LIGHT_DEFAULTS.angle;
  let cone: number = LIGHT_DEFAULTS.cone;
  let coneFeather: number = LIGHT_DEFAULTS.coneFeather;
  let falloff: LightFalloff = 'none';
  let falloffDistance: number = LIGHT_DEFAULTS.falloffDistance;
  let shadows = false;
  let shadowDarkness: number = LIGHT_DEFAULTS.shadowDarkness;
  let shadowDiffusion: number = LIGHT_DEFAULTS.shadowDiffusion;
  let poiX: number | undefined;
  let poiY: number | undefined;
  let poiZ: number | undefined;
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
    if (typeof p.lightType === 'string') type = lightType(p.lightType);
    if (typeof p.fill === 'string') color = p.fill;
    if (typeof p.falloff === 'string') falloff = lightFalloff(p.falloff);
    intensity = num(p.intensity, intensity);
    radius = num(p.radius, radius);
    angle = num(p.lightAngle, angle);
    cone = num(p.lightCone, cone);
    coneFeather = num(p.lightConeFeather, coneFeather);
    falloffDistance = num(p.falloffDistance, falloffDistance);
    shadowDarkness = num(p.shadowDarkness, shadowDarkness);
    shadowDiffusion = num(p.shadowDiffusion, shadowDiffusion);
    if (typeof p.poiX === 'number') poiX = p.poiX;
    if (typeof p.poiY === 'number') poiY = p.poiY;
    if (typeof p.poiZ === 'number') poiZ = p.poiZ;
    if (p.castShadows === true || p.castShadows === 1) shadows = true;
  }
  // Any ONE POI component present means the light is aimed in 3D; the others
  // default to 0 rather than the whole POI being discarded.
  const hasPOI = poiX !== undefined || poiY !== undefined || poiZ !== undefined;
  return {
    type, color, intensity, radius, angle, cone, coneFeather,
    falloff, falloffDistance, shadows, shadowDarkness, shadowDiffusion,
    poi: hasPOI ? { x: poiX ?? 0, y: poiY ?? 0, z: poiZ ?? 0 } : null,
  };
}

/**
 * Intensity multiplier at `distance` from the light, given its falloff.
 *
 * `none` returns 1 everywhere — the legacy behaviour, where `radius` alone set
 * the reach and there was no distance curve at all. `smooth` ramps linearly to
 * zero across the falloff distance; `inverse-square` is the physical curve,
 * clamped at the radius so it cannot blow up to infinity at distance 0 (AE's
 * "Inverse Square Clamped"). Pure and testable.
 */
export function lightFalloffAt(
  distance: number,
  // Only the three fields the curve needs, so callers holding a narrower light
  // (the shading pass's SceneLight) don't have to fabricate the rest.
  light: { falloff?: LightFalloff; radius: number; falloffDistance?: number },
): number {
  if (!light.falloff || light.falloff === 'none') return 1;
  const r = Math.max(1, light.radius);
  const d = Math.max(0, distance);
  if (d <= r) return 1;
  if (light.falloff === 'smooth') {
    const span = Math.max(1, light.falloffDistance ?? LIGHT_DEFAULTS.falloffDistance);
    return Math.max(0, 1 - (d - r) / span);
  }
  return (r * r) / (d * d);
}
