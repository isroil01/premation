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
  /** Cast 2.5D drop-shadows from this light onto content layers. */
  shadows: boolean;
}

const num = (v: unknown, fb: number): number => (typeof v === 'number' ? v : fb);

function lightType(v: unknown): LightType {
  return v === 'ambient' || v === 'spot' || v === 'parallel' ? v : 'point';
}

/** Read a light's config from its components (defaults when unset). Colour
 *  comes from the Style fill; intensity/radius/angle/cone are numeric props
 *  (so the inspector keyframes them); type is a string prop. */
export function readNodeLight(node: SceneNode): Light {
  let type: LightType = 'point';
  let color = '#fff3c0';
  let intensity = 100;
  let radius = 500;
  let angle = 0;
  let cone = 45;
  let shadows = false;
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
    if (typeof p.lightType === 'string') type = lightType(p.lightType);
    if (typeof p.fill === 'string') color = p.fill;
    intensity = num(p.intensity, intensity);
    radius = num(p.radius, radius);
    angle = num(p.lightAngle, angle);
    cone = num(p.lightCone, cone);
    if (p.castShadows === true || p.castShadows === 1) shadows = true;
  }
  return { type, color, intensity, radius, angle, cone, shadows };
}
