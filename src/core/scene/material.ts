/**
 * Per-layer 3D material options (AE's Material Options).
 *   • **Casts Shadows** gates whether this layer throws a shadow. A 3D layer
 *     under a shadow-casting light gets a REAL projected copy landing on the
 *     nearest receiver plane behind it; a 2D layer keeps the screen-space
 *     drop-shadow, because it has no depth to project through.
 *   • **Accepts Lights** opts a 3D layer into the real shading pass: per-quad
 *     Lambert on the CPU-affine fallback, per-FRAGMENT Lambert + Blinn-Phong
 *     specular on the depth-tested GPU path (see lightShading.ts and the
 *     solid3d/textured3d shaders).
 *   • **Specular / Shininess** shape the Blinn-Phong highlight on that GPU
 *     path; specular 0 (the default) reduces to plain Lambert.
 *   • **Accepts Shadows** selects which planes a cast shadow can land on. An
 *     accepting 3D layer joins `shadowReceivers` in `buildSnapshot`, and each
 *     caster is projected onto the nearest receiver behind it.
 *
 * ★ That last line used to read "remains reserved … read/persisted for
 * AE-parity but UNCONSUMED", and it was true only while cast shadows were a
 * CSS drop-shadow attached to the caster — which never landed on another layer,
 * which is exactly why the flag had no consumer. Real projected shadows gave it
 * one; the sentence survived the change that falsified it, and went on to put
 * "shadow catcher" on a list of things still to build. It is recorded here
 * rather than quietly deleted because a stale comment is the most expensive
 * kind of wrong: it reads as evidence.
 */

import type { SceneNode } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';

/**
 * AE's tri-state shadow switches. `only` is not a cosmetic third option — it is
 * how shadow-catcher workflows are built:
 *   • Casts Shadows: Only   → the layer throws its shadow but is not drawn.
 *   • Accepts Shadows: Only → the layer catches shadows onto transparency and
 *     is not drawn, so a shadow can be comped over live footage.
 */
export type CastsShadowsMode = 'off' | 'on' | 'only';
export type AcceptsShadowsMode = 'off' | 'on' | 'only';

export interface MaterialOptions {
  /**
   * Whether this layer throws a 2.5D cast shadow. Default true.
   * Convenience mirror of `castsShadowsMode !== 'off'` — kept because every
   * existing reader is a boolean test and should not have to care about `only`.
   */
  castsShadows: boolean;
  castsShadowsMode: CastsShadowsMode;
  acceptsShadowsMode: AcceptsShadowsMode;
  /** True when the layer's own content must not be drawn (either `only` mode). */
  shadowOnly: boolean;
  /**
   * Fraction of light a layer lets through to its shadow, 0–100 (AE's Light
   * Transmission). 100 = the shadow takes the layer's own colour rather than
   * black — how stained glass and gels read.
   */
  lightTransmission: number;
  /** Ambient response, 0–100. How much of the ambient wash the layer picks up. */
  ambient: number;
  /** Diffuse (Lambert) response, 0–100. */
  diffuse: number;
  /** Metal, 0–100: blends the specular highlight toward the layer's own colour. */
  metal: number;
  /**
   * Whether this 3D layer responds to scene lights (per-quad Lambert shading
   * on the GPU 3D path). Default FALSE so every existing scene renders
   * byte-identically — lights keep behaving as screen-blended washes unless a
   * layer opts in.
   */
  acceptsLights: boolean;
  /**
   * Whether this 3D layer RECEIVES cast shadows from layers in front of it.
   *
   * No longer reserved: buildSnapshot now projects each shadow-casting layer
   * onto the plane of every accepting 3D layer behind it, so a shadow lands on
   * real geometry and moves with Z. Defaults TRUE — a receiver that silently
   * ignored shadows was the reason 3D scenes read as flat cut-outs.
   */
  acceptsShadows: boolean;
  /**
   * Blinn-Phong specular intensity, 0–100 (AE's Specular Intensity). Only
   * meaningful when acceptsLights is on and the layer renders through the
   * depth-tested GPU path. Default 0 = plain Lambert (no visual change).
   */
  specular: number;
  /** Blinn-Phong exponent (AE's Shininess, higher = tighter highlight). */
  shininess: number;
  /**
   * Which reflectance model the GPU 3D path shades with.
   *
   * `phong` is the original Blinn-Phong: specular intensity + exponent. `pbr`
   * is a Cook-Torrance microfacet model — GGX distribution, Smith-Schlick
   * geometry, Schlick Fresnel with F0 blended from dielectric 4 % toward the
   * surface colour by `metal`, and energy-conserving diffuse — the model AE's
   * Advanced 3D renderer and every current real-time engine use. Roughness
   * replaces shininess there. Default `phong` so no existing scene changes.
   */
  shading: 'phong' | 'pbr';
  /** PBR roughness, 0–100 (0 mirror, 100 matte). Read only when `shading` is `pbr`. */
  roughness: number;
}

/** The Material Options a keyframe track can drive. Mirrors the registry's
 *  `material` group in propertyMeta.ts; both must list the same names.
 *
 *  Switches are hold-friendly numbers on the track: acceptsLights 0/1;
 *  castsShadows / acceptsShadows 0=off, 1=on, 2=only (AE parity). */
export const MATERIAL_ANIMATABLE = [
  'ambient', 'diffuse', 'specular', 'shininess', 'metal', 'lightTransmission', 'roughness',
  'acceptsLights', 'castsShadows', 'acceptsShadows',
] as const;

function transformProps(node: SceneNode): Record<string, unknown> {
  return (node.components.find((c) => c.type === 'Transform')?.props ?? {}) as Record<string, unknown>;
}

const pct = (v: unknown, fallback: number): number =>
  typeof v === 'number' ? Math.max(0, Math.min(100, v)) : fallback;

/**
 * Legacy props stored the switches as booleans (`false` = off, absent = on).
 * Tracks store 0/1/2. Read both so old projects and hold keyframes share one path.
 */
function shadowMode(v: unknown): 'off' | 'on' | 'only' {
  if (v === 'only' || v === 2) return 'only';
  if (v === false || v === 'off' || v === 0) return 'off';
  if (typeof v === 'number') {
    if (v >= 1.5) return 'only';
    if (v >= 0.5) return 'on';
    return 'off';
  }
  return 'on';
}

function acceptsLightsFlag(v: unknown): boolean {
  if (typeof v === 'number') return v > 0.5;
  return v === true;
}

/**
 * Material Options, with the ANIMATED value of each option when one is keyframed.
 *
 * `av` is the node's evaluated animation map for the frame (the same one the
 * transform reads from). Absent, every option is its stored value — which is
 * what the inspector, the tests and any static reader want. Present, a track
 * on any `MATERIAL_ANIMATABLE` name beats the stored value, exactly as `x`
 * beats the stored position. Switches decode as holds (0/1 or 0/1/2).
 */
export function readNodeMaterial(node: SceneNode, av?: ReadonlyMap<string, number>): MaterialOptions {
  const stored = transformProps(node);
  const p: Record<string, unknown> = av
    ? {
        ...stored,
        ...Object.fromEntries(
          MATERIAL_ANIMATABLE.filter((k) => av.has(k)).map((k) => [k, av.get(k)]),
        ),
      }
    : stored;
  const castsShadowsMode = shadowMode(p.castsShadows);
  const acceptsShadowsMode = shadowMode(p.acceptsShadows);
  return {
    castsShadows: castsShadowsMode !== 'off',
    castsShadowsMode,
    acceptsShadowsMode,
    shadowOnly: castsShadowsMode === 'only' || acceptsShadowsMode === 'only',
    acceptsLights: acceptsLightsFlag(p.acceptsLights),
    acceptsShadows: acceptsShadowsMode !== 'off',
    lightTransmission: pct(p.lightTransmission, 0),
    ambient: pct(p.ambient, 100),
    diffuse: pct(p.diffuse, 50),
    metal: pct(p.metal, 0),
    specular: pct(p.specular, 0),
    shininess: typeof p.shininess === 'number' ? Math.max(1, p.shininess) : 32,
    shading: p.shadingModel === 'pbr' ? 'pbr' : 'phong',
    roughness: pct(p.roughness, 50),
  };
}

/** Switch a layer's 3D reflectance model. */
export function setNodeShadingModel(nodeId: string, shading: 'phong' | 'pbr'): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const t = node?.components.find((c) => c.type === 'Transform');
  if (!node || !t) return;
  defaultSceneGraph.writeProp(nodeId, t.id, 'shadingModel', shading === 'pbr' ? 'pbr' : undefined);
  bumpScene();
}

/** Write one of the tri-state shadow switches; `on` is the unstored default. */
export function setNodeShadowMode(
  nodeId: string,
  which: 'castsShadows' | 'acceptsShadows',
  mode: 'off' | 'on' | 'only',
): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const t = node?.components.find((c) => c.type === 'Transform');
  if (!t) return;
  // `false` rather than `'off'` for the off case: that is what the boolean-era
  // readers persist and what old projects contain, so the two stay one value.
  const stored = mode === 'on' ? undefined : mode === 'off' ? false : 'only';
  defaultSceneGraph.writeProp(nodeId, t.id, which, stored);
  bumpScene();
}

/** Write a 0–100 material response. `fallback` is the unstored default. */
export function setNodeMaterialPct(
  nodeId: string,
  prop: 'lightTransmission' | 'ambient' | 'diffuse' | 'metal' | 'roughness',
  value: number,
  fallback: number,
): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const t = node?.components.find((c) => c.type === 'Transform');
  if (!t) return;
  const v = Math.max(0, Math.min(100, value));
  defaultSceneGraph.writeProp(nodeId, t.id, prop, v !== fallback ? v : undefined);
  bumpScene();
}

/** The unstored default for each 0–100 material response. */
export const MATERIAL_PCT_DEFAULTS = {
  lightTransmission: 0,
  ambient: 100,
  diffuse: 50,
  metal: 0,
  roughness: 50,
} as const;

export function setNodeSpecular(nodeId: string, specular: number): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const t = node?.components.find((c) => c.type === 'Transform');
  if (!t) return;
  const v = Math.max(0, Math.min(100, specular));
  // Store only non-default values so the common case adds nothing to file.
  defaultSceneGraph.writeProp(nodeId, t.id, 'specular', v > 0 ? v : undefined);
  bumpScene();
}

export function setNodeShininess(nodeId: string, shininess: number): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const t = node?.components.find((c) => c.type === 'Transform');
  if (!t) return;
  const v = Math.max(1, shininess);
  defaultSceneGraph.writeProp(nodeId, t.id, 'shininess', v !== 32 ? v : undefined);
  bumpScene();
}

export function setNodeAcceptsLights(nodeId: string, accepts: boolean): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const t = node?.components.find((c) => c.type === 'Transform');
  if (!t) return;
  // Store only the non-default 'true' so the common case adds nothing to file.
  defaultSceneGraph.writeProp(nodeId, t.id, 'acceptsLights', accepts ? true : undefined);
  bumpScene();
}

export function getNodeCastsShadows(nodeId: string): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  return node ? readNodeMaterial(node).castsShadows : true;
}

export function setNodeCastsShadows(nodeId: string, casts: boolean): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const t = node?.components.find((c) => c.type === 'Transform');
  if (!t) return;
  // Store only the non-default 'false' so the common case adds nothing to file.
  defaultSceneGraph.writeProp(nodeId, t.id, 'castsShadows', casts ? undefined : false);
  bumpScene();
}
