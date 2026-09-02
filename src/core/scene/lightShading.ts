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
import { lightAttenuationAt, LIGHT_DEFAULTS, type Light } from './light';

/**
 * A light placed in the scene. The newer AE properties are OPTIONAL here even
 * though `Light` always resolves them: this type is also constructed by hand in
 * tests and by callers that only care about the classic five, and every one of
 * them has a defined no-op default (`falloff: 'none'`, no POI ⇒ the legacy 2D
 * aim), so requiring them would be ceremony rather than safety.
 */
export interface SceneLight
  extends Pick<Light, 'type' | 'color' | 'intensity' | 'radius' | 'angle' | 'cone' | 'shadows'>,
    Partial<Pick<Light,
      | 'coneFeather' | 'falloff' | 'falloffDistance' | 'poi'
      // The shadow-MAP switch and its three settings. Optional, because the
      // environment rig synthesises `SceneLight`s that were never a light layer
      // and have no shadow of their own.
      | 'shadowMap' | 'shadowMapSize' | 'shadowBias' | 'shadowSoftness' | 'shadowDarkness'
    >> {
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
/**
 * Lambert term, two-sided or one.
 *
 * `abs` is the app's default because its primitive is a 2D layer in space: a
 * layer has no inside, and one seen from behind should still light. A face that
 * BOUNDS A VOLUME is the exception, and clamping is the whole difference
 * between a box lit from one side and a box lit identically on both.
 */
function ndotl(d: number, oneSided: boolean): number {
  return oneSided ? Math.max(d, 0) : Math.abs(d);
}

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
 *  a RESOLVED 3D unit aim, spot half-cone and feather in radians. The conversion
 *  lives here so the per-quad CPU model above and the per-fragment GPU model
 *  read the SAME numbers.
 *
 *  Everything derived is resolved HERE rather than in the shader — the aim's
 *  per-type legacy fallback, the feather percentage, the falloff-distance
 *  default. Each is a place the two models could disagree, and a WGSL/GLSL pair
 *  is the worst place to keep a default in step with TypeScript. */
export interface ShaderLight {
  /** The four RENDERABLE types. 'environment' never reaches the shader — it
   *  is expanded into ambient+parallel entries before collection. */
  type: Exclude<SceneLight['type'], 'environment'>;
  color: { r: number; g: number; b: number };
  gain: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  /** Resolved 3D UNIT aim — the POI direction, or this type's legacy 2D-angle
   *  fallback. Was cos/sin of `angle`, which could not express a POI at all. */
  aimX: number;
  aimY: number;
  aimZ: number;
  /** Spot half-cone in radians. */
  halfConeRad: number;
  /** Spot cone feather as ABSOLUTE radians (half-cone × the percentage), not a
   *  percentage — the shader hardcoded 20 % because it never received this. */
  coneFeatherRad: number;
  /** 0 = none (legacy hard radius cutoff + linear ramp), 1 = smooth,
   *  2 = inverse-square. Mirrors `LightFalloff` for a numeric uniform. */
  falloffMode: number;
  /** Smooth-curve span in px, default already applied. */
  falloffDistance: number;
  /**
   * Render a GEOMETRY-AWARE shadow for this light (see `Light.shadowMap`).
   *
   * Carried HERE rather than restated in the snapshot DTO deliberately: the
   * comment on `RenderSnapshot.lights3d` explains why that DTO refers to this
   * type instead of copying it — `coneFeather`, `falloff` and `poi` were each
   * honoured on the CPU and silently dropped on the GPU because a field was
   * added to one of three structural copies. A fourth copy would be a fourth
   * chance at the same bug.
   *
   * The renderer reads these; `shadeLayer` (the CPU per-quad fallback) does
   * not, and cannot — a per-quad gain has no geometry to occlude.
   */
  shadowMap?: boolean;
  /** Map resolution, px per side; the renderer clamps to 512 / 1024 / 2048. */
  shadowMapSize?: number;
  /** Depth bias in comp px. */
  shadowBias?: number;
  /** PCF tap spacing in map texels. */
  shadowSoftness?: number;
  /**
   * AE's Shadow Darkness as a FRACTION (1 = the light is fully blocked).
   *
   * The same slider the projected copy already scales its opacity by, so the
   * two shadow paths answer to one control rather than to two that disagree.
   * It matters more here than there: a map is the only light in most test
   * scenes, and a term of exactly 0 renders the occluded surface pure black —
   * physically right, and indistinguishable from a hole in the floor.
   */
  shadowDarkness?: number;
}

const FALLOFF_ID: Record<string, number> = { none: 0, smooth: 1, 'inverse-square': 2 };

/**
 * The 3D unit aim a light actually shades with.
 *
 * A POI wins. Without one, each type keeps its OWN legacy 2D-angle behaviour —
 * parallel tilts 45° into the scene, spot tests a flat comp-plane cone — which
 * is why this cannot collapse to a single shared fallback without re-lighting
 * every existing scene. Identical to the two `??` fallbacks in `shadeLayer`.
 */
function resolvedAim(light: SceneLight): readonly [number, number, number] {
  const poi = lightAim3D(light);
  if (poi) return poi;
  const dx = Math.cos(light.angle * DEG);
  const dy = Math.sin(light.angle * DEG);
  return light.type === 'parallel'
    ? [dx * Math.SQRT1_2, dy * Math.SQRT1_2, -Math.SQRT1_2]
    : [dx, dy, 0];
}

export function toShaderLights(lights: ReadonlyArray<SceneLight>): ShaderLight[] {
  const out: ShaderLight[] = [];
  for (const light of lights) {
    // Environment lights are a PROBE, not a shader light: buildSnapshot
    // expands them into ambient+parallel entries before collection. One that
    // leaks through unexpanded must be dropped, not mis-shaded as a point.
    if (light.type === 'environment') continue;
    const gain = Math.max(0, light.intensity / 100);
    if (gain <= 0) continue;
    const c = Color.fromHex(light.color);
    const aim = resolvedAim(light);
    const halfConeRad = Math.max(1e-3, (light.cone / 2) * DEG);
    // Absent ⇒ 20 %, so untouched lights keep the edge they had. Same rule as
    // `shadeLayer`; expressed once, in absolute radians, for both consumers.
    const featherPct = light.coneFeather === undefined ? 0.2 : Math.max(0, light.coneFeather) / 100;
    out.push({
      type: light.type as Exclude<SceneLight['type'], 'environment'>,
      color: { r: c.r, g: c.g, b: c.b },
      gain,
      x: light.x,
      y: light.y,
      z: light.z,
      radius: light.radius,
      aimX: aim[0],
      aimY: aim[1],
      aimZ: aim[2],
      halfConeRad,
      coneFeatherRad: halfConeRad * featherPct,
      falloffMode: FALLOFF_ID[light.falloff ?? 'none'] ?? 0,
      falloffDistance: Math.max(1, light.falloffDistance ?? LIGHT_DEFAULTS.falloffDistance),
      // Spread through only when ON, so a scene that never opts in packs an
      // undefined the renderer's `=== true` test reads as off — and every
      // existing golden keeps the shade tail it had.
      ...(light.shadowMap === true
        ? {
          shadowMap: true,
          ...(light.shadowMapSize !== undefined ? { shadowMapSize: light.shadowMapSize } : {}),
          ...(light.shadowBias !== undefined ? { shadowBias: light.shadowBias } : {}),
          ...(light.shadowSoftness !== undefined ? { shadowSoftness: light.shadowSoftness } : {}),
          ...(light.shadowDarkness !== undefined ? { shadowDarkness: light.shadowDarkness / 100 } : {}),
        }
        : {}),
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
  /**
   * Light from ONE side: `max(dot(N, L), 0)` rather than `abs(dot(N, L))`.
   *
   * The GPU twin reads the same flag off `eyeLit.w`, and the two MUST agree —
   * this function is the per-quad fallback for the very same surface the shader
   * lights per fragment, so a disagreement is a layer that changes brightness
   * depending on which path it took.
   */
  oneSided = false,
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
      lambert = ndotl(normal[0] * L[0] + normal[1] * L[1] + normal[2] * L[2], oneSided);
    } else {
      const lx = light.x - pos.x;
      const ly = light.y - pos.y;
      const lz = light.z - pos.z;
      const d = Math.hypot(lx, ly, lz);
      // `falloff: 'none'` (the default) keeps the legacy hard radius cutoff and
      // linear ramp. The curves extend reach past the radius, so the cutoff has
      // to move out with them or the curve would never be visible.
      //
      // Both branches live in `lightAttenuationAt` now — the glow wash bakes its
      // profile from the same function, so a light cannot light one distance and
      // glow another.
      const curve = lightAttenuationAt(d, light);
      if (curve <= 0.001) continue;
      atten = curve;
      const inv = d < 1e-9 ? 0 : 1 / d;
      lambert = d < 1e-9
        ? 1 // light exactly on the layer: full contribution
        : ndotl(normal[0] * lx * inv + normal[1] * ly * inv + normal[2] * lz * inv, oneSided);
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
        // Smoothstep across the feather band, not the bare ratio: a linear ramp
        // corners at both ends, so a feathered cone showed a hard line where the
        // feather began and another where it cut off. Mirrored verbatim in both
        // shader dialects and in `spotConeFactor` (the wash) — a spot whose lit
        // pixels and whose glow disagree at the edge is worse than either.
        if (feather > 1e-6 && ang > half - feather) {
          const u = (half - ang) / feather;
          atten *= u * u * (3 - 2 * u);
        }
      }
    }
    const k = gain * lambert * atten * kDiffuse;
    r += c.r * k;
    g += c.g * k;
    b += c.b * k;
  }
  return [clampGain(r), clampGain(g), clampGain(b)];
}
