/**
 * Per-quad Lambert shading for 3D layers that opt in via Material Options →
 * Accepts Lights. Pure math, shared by buildSnapshot (which attaches the
 * resulting RGB multiplier to the layer) — the renderer then simply multiplies
 * the layer's tint, so the SAME shading applies on the 2D affine fallback and
 * the depth-tested GPU path.
 *
 * Model (pragmatic Classic-3D):
 *   • ambient lights add their colour·intensity flat;
 *   • point/spot lights add colour·intensity·|N·L|·falloff (linear falloff to
 *     the light radius, matching the wash's visual reach);
 *   • spot cones attenuate by the angle between the (2D) cone direction and
 *     the light→layer direction, feathered across the half-cone;
 *   • parallel lights add colour·intensity·|N·L| with no falloff.
 *   |N·L| (not max(N·L, 0)) lights both faces of a plane — AE layers are
 *   two-sided. With NO lights in the scene the multiplier is identity, so
 *   flipping a layer's flag in an unlit comp changes nothing.
 */

import { Color } from '@motion/renderer';
import type { Light } from './light';

export interface SceneLight extends Light {
  x: number;
  y: number;
  z: number;
}

export type Rgb = readonly [number, number, number];

const DEG = Math.PI / 180;

/** Cap on the accumulated multiplier — keeps stacked lights from blowing out
 *  to Infinity while still allowing over-brightening (>1). */
const MAX_GAIN = 4;

function clampGain(v: number): number {
  return Math.min(MAX_GAIN, Math.max(0, v));
}

/**
 * The layer plane's world-space unit normal: the world matrix's +Z axis
 * (column-major Matrix4 → column 2), normalised. Falls back to +Z when the
 * matrix is degenerate.
 */
export function planeNormalOf(world: ArrayLike<number>): readonly [number, number, number] {
  const x = world[8] ?? 0;
  const y = world[9] ?? 0;
  const z = world[10] ?? 1;
  const len = Math.hypot(x, y, z);
  if (len < 1e-9) return [0, 0, 1];
  return [x / len, y / len, z / len];
}

/**
 * Accumulate the scene lights into an RGB gain for a layer at `pos` with unit
 * `normal`. Returns null when there is nothing to apply (no lights → identity,
 * so callers can skip attaching anything).
 */
/** A scene light in the 3D shader's terms (matches the renderer's Shade3DLight
 *  and the RenderSnapshot `lights3d` DTO): linear RGB, gain = intensity/100,
 *  aim as cos/sin of the 2D angle, spot half-cone in radians. The conversion
 *  lives here so the per-quad CPU model above and the per-fragment GPU model
 *  read the SAME numbers. */
export interface ShaderLight {
  type: SceneLight['type'];
  color: { r: number; g: number; b: number };
  gain: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  aimX: number;
  aimY: number;
  halfConeRad: number;
}

export function toShaderLights(lights: ReadonlyArray<SceneLight>): ShaderLight[] {
  const out: ShaderLight[] = [];
  for (const light of lights) {
    const gain = Math.max(0, light.intensity / 100);
    if (gain <= 0) continue;
    const c = Color.fromHex(light.color);
    out.push({
      type: light.type,
      color: { r: c.r, g: c.g, b: c.b },
      gain,
      x: light.x,
      y: light.y,
      z: light.z,
      radius: light.radius,
      aimX: Math.cos(light.angle * DEG),
      aimY: Math.sin(light.angle * DEG),
      halfConeRad: Math.max(1e-3, (light.cone / 2) * DEG),
    });
  }
  return out;
}

export function shadeLayer(
  normal: readonly [number, number, number],
  pos: { x: number; y: number; z: number },
  lights: ReadonlyArray<SceneLight>,
): Rgb | null {
  if (lights.length === 0) return null;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const light of lights) {
    const c = Color.fromHex(light.color);
    const gain = Math.max(0, light.intensity / 100);
    if (gain <= 0) continue;
    if (light.type === 'ambient') {
      r += c.r * gain;
      g += c.g * gain;
      b += c.b * gain;
      continue;
    }
    let lambert: number;
    let atten = 1;
    if (light.type === 'parallel') {
      // Directional: the (2D) angle points the light across the comp plane,
      // tilted 45° into the scene so flat layers still catch it.
      const dx = Math.cos(light.angle * DEG);
      const dy = Math.sin(light.angle * DEG);
      const L: readonly [number, number, number] = [dx * Math.SQRT1_2, dy * Math.SQRT1_2, -Math.SQRT1_2];
      lambert = Math.abs(normal[0] * L[0] + normal[1] * L[1] + normal[2] * L[2]);
    } else {
      const lx = light.x - pos.x;
      const ly = light.y - pos.y;
      const lz = light.z - pos.z;
      const d = Math.hypot(lx, ly, lz);
      if (d >= light.radius && light.radius > 0) continue;
      atten = light.radius > 0 ? 1 - d / light.radius : 1;
      const inv = d < 1e-9 ? 0 : 1 / d;
      lambert = d < 1e-9
        ? 1 // light exactly on the layer: full contribution
        : Math.abs(normal[0] * lx * inv + normal[1] * ly * inv + normal[2] * lz * inv);
      if (light.type === 'spot' && d > 1e-9) {
        // Cone test against the light's 2D aim direction, feathered over the
        // outer 20% of the half-cone.
        const aimX = Math.cos(light.angle * DEG);
        const aimY = Math.sin(light.angle * DEG);
        const toLayerX = -lx * inv;
        const toLayerY = -ly * inv;
        const cos = aimX * toLayerX + aimY * toLayerY;
        const half = Math.max(1e-3, (light.cone / 2) * DEG);
        const ang = Math.acos(Math.min(1, Math.max(-1, cos)));
        if (ang > half) continue;
        const feather = half * 0.2;
        if (ang > half - feather) atten *= (half - ang) / feather;
      }
    }
    const k = gain * lambert * atten;
    r += c.r * k;
    g += c.g * k;
    b += c.b * k;
  }
  return [clampGain(r), clampGain(g), clampGain(b)];
}
