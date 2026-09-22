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
import { renderComponentsOf } from '@core/scene/SceneGraph';

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
   * replaces shininess there. `toon` is cel shading: Blinn-Phong terms
   * quantized into `toonBands` hard steps — the cartoon look AE has no 3D
   * answer to at all. Default `phong` so no existing scene changes.
   */
  shading: 'phong' | 'pbr' | 'toon';
  /** PBR roughness, 0–100 (0 mirror, 100 matte). Read only when `shading` is `pbr`. */
  roughness: number;
  /** Cel bands, 2–8. Read only when `shading` is `toon`. */
  toonBands: number;
  /**
   * Height displacement (AE 26.2): an image asset whose luma pushes the mesh
   * along its normals by `displacement` px (50 % grey = flat), after
   * `displacementSubdivisions` rounds of midpoint subdivision. `heightMapSrc`
   * is the asset-free form (a data URI, or a primed procedural field's key)
   * the goldens and scripts use. See heightDisplacement.ts.
   */
  heightMapAssetId?: string;
  heightMapSrc?: string;
  displacement: number;
  displacementSubdivisions: number;
  /**
   * AE Advanced-3D reflection axes, scoped honestly: there is no layer-to-layer
   * reflection pass here, so all three act on the ENVIRONMENT-specular term
   * (the split-sum IBL in shade3d) and do nothing in a comp without an
   * environment light — exactly the scenes where they already do nothing.
   *
   *   • `reflectionIntensity` (0–100, default 100) scales the env-specular
   *     contribution. 100 reproduces today's IBL arithmetic to the byte.
   *   • `reflectionSharpness` (0–100, default 0) remaps the roughness the
   *     prefiltered atlas is sampled at: effective = roughness × (1 − s/100),
   *     so 100 always reflects the sharpest band. 0 is the exact identity.
   *   • `reflectionRolloff` (0–100, default 0) is a Fresnel-style view-angle
   *     weight (Schlick, F0 from `ior`): 0 = uniform as today, higher
   *     concentrates the reflection at grazing angles.
   *
   * AE's fourth axis, Appears in Reflections, is deliberately NOT modelled:
   * its only meaning is layer-to-layer reflections, which do not exist here,
   * and this codebase deletes dead controls rather than shipping switches that
   * change no pixel. When a reflection pass exists, the axis comes with it.
   */
  reflectionIntensity: number;
  reflectionSharpness: number;
  reflectionRolloff: number;
  /**
   * AE Advanced-3D Transparency (0–100, default 0): a view-dependent alpha
   * multiplier applied at the SHADING stage — like `specular` above it is only
   * meaningful when Accepts Lights is on and the layer renders through the
   * depth-tested GPU path. Distinct from layer Opacity because of the rolloff:
   * `transparencyRolloff` (0–100, default 0) Fresnel-weights it (Schlick, F0
   * from `ior`) so facing-the-camera areas turn more transparent than grazing
   * ones — the glass look. Both default to the exact identity. No refraction
   * is rendered (out of scope: no background-distortion pass for materials).
   */
  transparency: number;
  transparencyRolloff: number;
  /**
   * Index of refraction feeding the Schlick F0 for BOTH rolloffs above.
   * Default 1.52 (AE's default, window glass) rather than 1.0: with
   * `transparency` 0 and `reflectionRolloff` 0 the F0 is multiplied by an
   * exact 0 weight, so 1.52 is still a byte-exact identity for every existing
   * scene — and the moment a rolloff is raised, the glassy default is the
   * useful one.
   */
  ior: number;
}

/** The Material Options a keyframe track can drive. Mirrors the registry's
 *  `material` group in propertyMeta.ts; both must list the same names.
 *
 *  Switches are hold-friendly numbers on the track: acceptsLights 0/1;
 *  castsShadows / acceptsShadows 0=off, 1=on, 2=only (AE parity). */
export const MATERIAL_ANIMATABLE = [
  'ambient', 'diffuse', 'specular', 'shininess', 'metal', 'lightTransmission', 'roughness',
  'acceptsLights', 'castsShadows', 'acceptsShadows',
  // Height displacement amount — growing a relief is the whole use of it.
  'displacement',
  // Advanced-3D reflection / transparency axes (all keyframeable in AE).
  'reflectionIntensity', 'reflectionSharpness', 'reflectionRolloff',
  'transparency', 'transparencyRolloff', 'ior',
] as const;

function transformProps(node: SceneNode): Record<string, unknown> {
  return (renderComponentsOf(node).find((c) => c.type === 'Transform')?.props ?? {}) as Record<string, unknown>;
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
    shading: p.shadingModel === 'pbr' ? 'pbr' : p.shadingModel === 'toon' ? 'toon' : 'phong',
    roughness: pct(p.roughness, 50),
    toonBands: typeof p.toonBands === 'number' ? Math.max(2, Math.min(8, Math.round(p.toonBands))) : 3,
    ...(typeof p.heightMapAssetId === 'string' && p.heightMapAssetId ? { heightMapAssetId: p.heightMapAssetId } : {}),
    ...(typeof p.heightMapSrc === 'string' && p.heightMapSrc ? { heightMapSrc: p.heightMapSrc } : {}),
    displacement: typeof p.displacement === 'number' && Number.isFinite(p.displacement) ? Math.max(-2000, Math.min(2000, p.displacement)) : 0,
    displacementSubdivisions: typeof p.displacementSubdiv === 'number' ? Math.max(0, Math.min(3, Math.round(p.displacementSubdiv))) : 0,
    reflectionIntensity: pct(p.reflectionIntensity, 100),
    reflectionSharpness: pct(p.reflectionSharpness, 0),
    reflectionRolloff: pct(p.reflectionRolloff, 0),
    transparency: pct(p.transparency, 0),
    transparencyRolloff: pct(p.transparencyRolloff, 0),
    ior: iorOf(p.ior),
  };
}

/** IOR clamp shared by the reader and the normaliser: 1 (vacuum) to 4. */
function iorOf(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(1, Math.min(4, v)) : 1.52;
}

/** Assign (or clear) the height map asset a layer's material displaces by. */
export function setNodeHeightMap(nodeId: string, assetId: string | undefined): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const t = node?.components.find((c) => c.type === 'Transform');
  if (!t) return;
  defaultSceneGraph.writeProp(nodeId, t.id, 'heightMapAssetId', assetId || undefined);
  bumpScene();
}

/** Displacement amount, px along the normal (0 = off, unstored). */
export function setNodeDisplacement(nodeId: string, px: number): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const t = node?.components.find((c) => c.type === 'Transform');
  if (!t) return;
  const v = Math.max(-2000, Math.min(2000, px));
  defaultSceneGraph.writeProp(nodeId, t.id, 'displacement', v !== 0 ? v : undefined);
  bumpScene();
}

/** Midpoint subdivision rounds before displacing, 0–3. */
export function setNodeDisplacementSubdivisions(nodeId: string, rounds: number): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const t = node?.components.find((c) => c.type === 'Transform');
  if (!t) return;
  const v = Math.max(0, Math.min(3, Math.round(rounds)));
  defaultSceneGraph.writeProp(nodeId, t.id, 'displacementSubdiv', v !== 0 ? v : undefined);
  bumpScene();
}

/** Switch a layer's 3D reflectance model. */
export function setNodeShadingModel(nodeId: string, shading: 'phong' | 'pbr' | 'toon'): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const t = node?.components.find((c) => c.type === 'Transform');
  if (!node || !t) return;
  defaultSceneGraph.writeProp(nodeId, t.id, 'shadingModel', shading === 'phong' ? undefined : shading);
  bumpScene();
}

/** Cel band count for the toon model, 2–8 (3 is the unstored default). */
export function setNodeToonBands(nodeId: string, bands: number): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const t = node?.components.find((c) => c.type === 'Transform');
  if (!t) return;
  const v = Math.max(2, Math.min(8, Math.round(bands)));
  defaultSceneGraph.writeProp(nodeId, t.id, 'toonBands', v !== 3 ? v : undefined);
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
  prop: 'lightTransmission' | 'ambient' | 'diffuse' | 'metal' | 'roughness'
    | 'reflectionIntensity' | 'reflectionSharpness' | 'reflectionRolloff'
    | 'transparency' | 'transparencyRolloff',
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
  reflectionIntensity: 100,
  reflectionSharpness: 0,
  reflectionRolloff: 0,
  transparency: 0,
  transparencyRolloff: 0,
} as const;

/** Index of refraction, 1–4; 1.52 (AE's default) is the unstored default. */
export function setNodeIor(nodeId: string, ior: number): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const t = node?.components.find((c) => c.type === 'Transform');
  if (!t) return;
  const v = Math.max(1, Math.min(4, ior));
  defaultSceneGraph.writeProp(nodeId, t.id, 'ior', v !== 1.52 ? v : undefined);
  bumpScene();
}

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

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * REUSABLE MATERIALS
 *
 * `MaterialOptions` is what a NODE currently resolves to (defaults filled in,
 * animation applied). `MaterialParams` is the same surface description with no
 * node attached — the thing a named material in the library stores, and the
 * thing "apply this material" writes.
 *
 * The split matters because `MaterialOptions` carries DERIVED conveniences
 * (`castsShadows`, `acceptsShadows`, `shadowOnly`) that are mirrors of the
 * tri-states. Persisting those would put one fact in the file twice and let a
 * hand-edited document contradict itself.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** A complete, layer-independent description of a surface's light response. */
export interface MaterialParams {
  castsShadows: CastsShadowsMode;
  acceptsShadows: AcceptsShadowsMode;
  acceptsLights: boolean;
  lightTransmission: number;
  ambient: number;
  diffuse: number;
  metal: number;
  specular: number;
  shininess: number;
  shading: 'phong' | 'pbr' | 'toon';
  roughness: number;
  toonBands: number;
  reflectionIntensity: number;
  reflectionSharpness: number;
  reflectionRolloff: number;
  transparency: number;
  transparencyRolloff: number;
  ior: number;
}

/** Exactly what `readNodeMaterial` reports for a node with nothing stored. */
export const DEFAULT_MATERIAL_PARAMS: MaterialParams = {
  castsShadows: 'on',
  acceptsShadows: 'on',
  acceptsLights: false,
  lightTransmission: MATERIAL_PCT_DEFAULTS.lightTransmission,
  ambient: MATERIAL_PCT_DEFAULTS.ambient,
  diffuse: MATERIAL_PCT_DEFAULTS.diffuse,
  metal: MATERIAL_PCT_DEFAULTS.metal,
  specular: 0,
  shininess: 32,
  shading: 'phong',
  roughness: MATERIAL_PCT_DEFAULTS.roughness,
  toonBands: 3,
  reflectionIntensity: MATERIAL_PCT_DEFAULTS.reflectionIntensity,
  reflectionSharpness: MATERIAL_PCT_DEFAULTS.reflectionSharpness,
  reflectionRolloff: MATERIAL_PCT_DEFAULTS.reflectionRolloff,
  transparency: MATERIAL_PCT_DEFAULTS.transparency,
  transparencyRolloff: MATERIAL_PCT_DEFAULTS.transparencyRolloff,
  ior: 1.52,
};

/** Drop the derived mirrors: the storable half of a resolved material. */
export function materialParamsOf(m: MaterialOptions): MaterialParams {
  return {
    castsShadows: m.castsShadowsMode,
    acceptsShadows: m.acceptsShadowsMode,
    acceptsLights: m.acceptsLights,
    lightTransmission: m.lightTransmission,
    ambient: m.ambient,
    diffuse: m.diffuse,
    metal: m.metal,
    specular: m.specular,
    shininess: m.shininess,
    shading: m.shading,
    roughness: m.roughness,
    toonBands: m.toonBands,
    reflectionIntensity: m.reflectionIntensity,
    reflectionSharpness: m.reflectionSharpness,
    reflectionRolloff: m.reflectionRolloff,
    transparency: m.transparency,
    transparencyRolloff: m.transparencyRolloff,
    ior: m.ior,
  };
}

/** The named-material form of a layer's current surface, or null if unknown. */
export function readNodeMaterialParams(nodeId: string): MaterialParams | null {
  const node = defaultSceneGraph.getNode(nodeId);
  return node ? materialParamsOf(readNodeMaterial(node)) : null;
}

/**
 * Write a whole material onto a layer.
 *
 * EVERY axis is written, including the ones equal to the default — a material
 * states a COMPLETE surface, so applying "Plastic" after "Gold" must not leave
 * gold's roughness behind. (The individual setters still store only non-default
 * values, so a default axis clears its prop rather than writing a redundant
 * one; the file stays as small as it was.)
 *
 * Nothing outside Material Options is touched: fill, opacity, strokes, geometry
 * and transform are none of a material's business. That is the difference
 * between this and the Style panel's material PRESETS, which state a colour too
 * — and which silently replaced the layer's colour back when they lived in the
 * Transform panel.
 */
export function applyMaterialParams(nodeId: string, params: MaterialParams): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node?.components.some((c) => c.type === 'Transform')) return;
  setNodeShadowMode(nodeId, 'castsShadows', params.castsShadows);
  setNodeShadowMode(nodeId, 'acceptsShadows', params.acceptsShadows);
  setNodeAcceptsLights(nodeId, params.acceptsLights);
  setNodeMaterialPct(nodeId, 'lightTransmission', params.lightTransmission, MATERIAL_PCT_DEFAULTS.lightTransmission);
  setNodeMaterialPct(nodeId, 'ambient', params.ambient, MATERIAL_PCT_DEFAULTS.ambient);
  setNodeMaterialPct(nodeId, 'diffuse', params.diffuse, MATERIAL_PCT_DEFAULTS.diffuse);
  setNodeMaterialPct(nodeId, 'metal', params.metal, MATERIAL_PCT_DEFAULTS.metal);
  setNodeMaterialPct(nodeId, 'roughness', params.roughness, MATERIAL_PCT_DEFAULTS.roughness);
  setNodeSpecular(nodeId, params.specular);
  setNodeShininess(nodeId, params.shininess);
  setNodeShadingModel(nodeId, params.shading);
  setNodeToonBands(nodeId, params.toonBands);
  setNodeMaterialPct(nodeId, 'reflectionIntensity', params.reflectionIntensity, MATERIAL_PCT_DEFAULTS.reflectionIntensity);
  setNodeMaterialPct(nodeId, 'reflectionSharpness', params.reflectionSharpness, MATERIAL_PCT_DEFAULTS.reflectionSharpness);
  setNodeMaterialPct(nodeId, 'reflectionRolloff', params.reflectionRolloff, MATERIAL_PCT_DEFAULTS.reflectionRolloff);
  setNodeMaterialPct(nodeId, 'transparency', params.transparency, MATERIAL_PCT_DEFAULTS.transparency);
  setNodeMaterialPct(nodeId, 'transparencyRolloff', params.transparencyRolloff, MATERIAL_PCT_DEFAULTS.transparencyRolloff);
  setNodeIor(nodeId, params.ior);
}

/**
 * Coerce whatever a document (or a hand edit, or an older build) carried into a
 * valid material. Unreadable axes fall back to the default rather than to zero:
 * a material that silently became fully matte black is worse than one that
 * reads as the default surface.
 */
export function normalizeMaterialParams(raw: unknown): MaterialParams {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number, lo: number, hi: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
  const shading = p.shading === 'pbr' ? 'pbr' : p.shading === 'toon' ? 'toon' : 'phong';
  return {
    castsShadows: shadowMode(p.castsShadows),
    acceptsShadows: shadowMode(p.acceptsShadows),
    acceptsLights: acceptsLightsFlag(p.acceptsLights),
    lightTransmission: num(p.lightTransmission, DEFAULT_MATERIAL_PARAMS.lightTransmission, 0, 100),
    ambient: num(p.ambient, DEFAULT_MATERIAL_PARAMS.ambient, 0, 100),
    diffuse: num(p.diffuse, DEFAULT_MATERIAL_PARAMS.diffuse, 0, 100),
    metal: num(p.metal, DEFAULT_MATERIAL_PARAMS.metal, 0, 100),
    specular: num(p.specular, DEFAULT_MATERIAL_PARAMS.specular, 0, 100),
    shininess: num(p.shininess, DEFAULT_MATERIAL_PARAMS.shininess, 1, 512),
    shading,
    roughness: num(p.roughness, DEFAULT_MATERIAL_PARAMS.roughness, 0, 100),
    toonBands: Math.round(num(p.toonBands, DEFAULT_MATERIAL_PARAMS.toonBands, 2, 8)),
    reflectionIntensity: num(p.reflectionIntensity, DEFAULT_MATERIAL_PARAMS.reflectionIntensity, 0, 100),
    reflectionSharpness: num(p.reflectionSharpness, DEFAULT_MATERIAL_PARAMS.reflectionSharpness, 0, 100),
    reflectionRolloff: num(p.reflectionRolloff, DEFAULT_MATERIAL_PARAMS.reflectionRolloff, 0, 100),
    transparency: num(p.transparency, DEFAULT_MATERIAL_PARAMS.transparency, 0, 100),
    transparencyRolloff: num(p.transparencyRolloff, DEFAULT_MATERIAL_PARAMS.transparencyRolloff, 0, 100),
    ior: num(p.ior, DEFAULT_MATERIAL_PARAMS.ior, 1, 4),
  };
}
