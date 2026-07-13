/**
 * Lights (Prompt 12) — point lights for the 2D compositor. A light layer casts a
 * soft radial glow (colour, radius, intensity) composited with a screen blend,
 * so it brightens the layers beneath it. Position and intensity/radius are
 * ordinary keyframeable props, so lights animate like anything else. (True 3D
 * material-response lighting is out of scope for a 2D compositor.)
 */

import type { SceneNode } from '@core/types';

export interface Light {
  /** Light colour (hex). */
  color: string;
  /** Brightness, percent (100 = full). */
  intensity: number;
  /** Falloff radius, comp px. */
  radius: number;
}

const num = (v: unknown, fb: number): number => (typeof v === 'number' ? v : fb);

/** Read a light's colour/intensity/radius from its components (defaults when
 *  unset). Colour comes from the Style fill; intensity/radius are numeric
 *  props (so the inspector keyframes them). */
export function readNodeLight(node: SceneNode): Light {
  let color = '#fff3c0';
  let intensity = 100;
  let radius = 500;
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
    if (typeof p.fill === 'string') color = p.fill;
    intensity = num(p.intensity, intensity);
    radius = num(p.radius, radius);
  }
  return { color, intensity, radius };
}
