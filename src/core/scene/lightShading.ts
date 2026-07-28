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
import { lightFalloffAt, type Light } from './light';

/**
 * A light placed in the scene. The newer AE properties are OPTIONAL here even
 * though `Light` always resolves them: this type is also constructed by hand in
 * tests and by callers that only care about the classic five, and every one of
 * them has a defined no-op default (`falloff: 'none'`, no POI ⇒ the legacy 2D
 * aim), so requiring them would be ceremony rather than safety.
 */
export interface SceneLight
  extends Pick<Light, 'type' | 'color' | 'intensity' | 'radius' | 'angle' | 'cone' | 'shadows'>,
    Partial<Pick<Light, 'coneFeather' | 'falloff' | 'falloffDistance' | 'poi'>> {
  x: number;
  y: number;
  z: number;
}

/**
 * A light's unit aim direction from its Point of Interest, or null when it has
 * none.
 *
 * Null rather than a fallback on purpose: each light type has its OWN legacy
 * 2D-angle behaviour (parallel tilts 45° into the scene, spot tests a flat
 * comp-plane cone), and collapsing them into one shared default would silently
 * re-light every existing scene. A POI is opt-in, and opting in is what buys
 * real 3D aiming — the thing `angle` alone could never express, because it can
 * only swing a light within the comp plane and never toward a layer at a
 * different depth.
 */
export function lightAim3D(light: SceneLight): readonly [number, number, number] | null {
  if (!light.poi) return null;
  const dx = light.poi.x - light.x;
  const dy = light.poi.y - light.y;
  const dz = light.poi.z - light.z;
  const len = Math.hypot(dx, dy, dz);
  return len > 1e-9 ? [dx / len, dy / len, dz / len] : null;
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

/**
 * Per-layer material response (AE's Ambient / Diffuse). Optional so existing
 * callers are unchanged: absent ⇒ the AE defaults, which reproduce the previous
 * behaviour exactly (ambient 100 %, diffuse ×2 of the old implicit 50 %).
 */
export interface MaterialResponse {
  /** 0–100: how much of an ambient light the layer picks up. */
  ambient?: number;
  /** 0–100: how much of a directional light the layer picks up. */
  diffuse?: number;
}

export function shadeLayer(
  normal: readonly [number, number, number],
  pos: { x: number; y: number; z: number },
  lights: ReadonlyArray<SceneLight>,
  material?: MaterialResponse,
): Rgb | null {
  if (lights.length === 0) return null;
  // Defaults chosen so an omitted `material` is a no-op: ambient 100 % passes
  // through, and diffuse is normalised against AE's 50 % default so the classic
  // setting keeps the exact gain this function produced before it existed.
  const kAmbient = (material?.ambient ?? 100) / 100;
  const kDiffuse = (material?.diffuse ?? 50) / 50;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const light of lights) {
    const c = Color.fromHex(light.color);
    const gain = Math.max(0, light.intensity / 100);
    if (gain <= 0) continue;
    if (light.type === 'ambient') {
      r += c.r * gain * kAmbient;
      g += c.g * gain * kAmbient;
      b += c.b * gain * kAmbient;
      continue;
    }
    let lambert: number;
    let atten = 1;
    if (light.type === 'parallel') {
      // Directional. With a POI the light aims in real 3D; without one the
      // (2D) angle points it across the comp plane, tilted 45° into the scene
      // so flat layers still catch it.
      const dx = Math.cos(light.angle * DEG);
      const dy = Math.sin(light.angle * DEG);
      const L = lightAim3D(light) ?? ([dx * Math.SQRT1_2, dy * Math.SQRT1_2, -Math.SQRT1_2] as const);
      lambert = Math.abs(normal[0] * L[0] + normal[1] * L[1] + normal[2] * L[2]);
    } else {
      const lx = light.x - pos.x;
      const ly = light.y - pos.y;
      const lz = light.z - pos.z;
      const d = Math.hypot(lx, ly, lz);
      // `falloff: 'none'` (the default) keeps the legacy hard radius cutoff and
      // linear ramp. The curves extend reach past the radius, so the cutoff has
      // to move out with them or the curve would never be visible.
      const curve = light.falloff && light.falloff !== 'none' ? lightFalloffAt(d, light) : null;
      if (curve === null) {
        if (d >= light.radius && light.radius > 0) continue;
        atten = light.radius > 0 ? 1 - d / light.radius : 1;
      } else {
        if (curve <= 0.001) continue;
        atten = curve;
      }
      const inv = d < 1e-9 ? 0 : 1 / d;
      lambert = d < 1e-9
        ? 1 // light exactly on the layer: full contribution
        : Math.abs(normal[0] * lx * inv + normal[1] * ly * inv + normal[2] * lz * inv);
      if (light.type === 'spot' && d > 1e-9) {
        // Cone test. With a POI the aim is a real 3D direction; without one it
        // is the legacy comp-plane aim (z = 0), which is what every existing
        // spot was tested against.
        const aim = lightAim3D(light) ?? ([Math.cos(light.angle * DEG), Math.sin(light.angle * DEG), 0] as const);
        const toLayerX = -lx * inv;
        const toLayerY = -ly * inv;
        const toLayerZ = -lz * inv;
        const cos = aim[0] * toLayerX + aim[1] * toLayerY + aim[2] * toLayerZ;
        const half = Math.max(1e-3, (light.cone / 2) * DEG);
        const ang = Math.acos(Math.min(1, Math.max(-1, cos)));
        if (ang > half) continue;
        // Feather is a PERCENT of the half-cone (AE's Cone Feather), not the
        // old hardcoded 20%. Absent ⇒ 20%, so untouched lights keep their edge.
        const feather = half * (light.coneFeather === undefined ? 0.2 : Math.max(0, light.coneFeather) / 100);
        if (feather > 1e-6 && ang > half - feather) atten *= (half - ang) / feather;
      }
    }
    const k = gain * lambert * atten * kDiffuse;
    r += c.r * k;
    g += c.g * k;
    b += c.b * k;
  }
  return [clampGain(r), clampGain(g), clampGain(b)];
}
