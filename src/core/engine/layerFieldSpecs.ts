/**
 * LAYER FIELDS (B3z) — the static, non-keyframed values a layer stores OUTSIDE
 * its Text component and its keyframe tracks, as engine-API properties
 * (ENGINE_API.md §3.4, §15.9). The G1 field mechanism (fields.ts) extended from
 * text to every layer: a Material's shading model, a light's type, a
 * primitive's shape, a cloner / physics / particle config,
 * a precomp's overrides…
 *
 * After Effects models these as properties too — enum properties of the
 * Material / Light / Geometry Options groups, checkbox properties, or
 * (for the structured plug-in configs premation has and AE does not) arbitrary
 * data params. Structured values are `json` fields (ENGINE_API.md §14.2): a
 * client computes the next config (a toggled switch, a moved pin) and sends it
 * WHOLE; the engine stores it verbatim (null = remove) and undo restores the
 * previous one exactly.
 *
 * This module is DATA shared by both engines: the TypeScript catalog
 * (`src/core/engine/fields.ts`) reads it directly, the C++ catalog
 * (`native/engine/src/core/fields.cpp`) reads the copy
 * `crossEngineCatalog.test.ts` generates into catalog_data.inc. Pure — no scene
 * graph, no stores. Row ORDER is the order both engines add the bindings in
 * (the property tree is compared across engines).
 */

import type { TextFieldSpec } from '@core/text/textFields';

/** Where a layer field is stored. */
export interface LayerFieldStore {
  /**
   * A prop of the layer's first component of this TYPE (`Transform`, `Primitive`,
   * `Style`…); a list = the first of these types the layer carries.
   */
  component?: string | readonly string[];
  /** Or a key of the layer's `fx` component. */
  fx?: string;
  /** The key inside that value: component prop key, or a key INSIDE the fx object (absent = the fx value itself). */
  key?: string;
}

/** When the layer HAS the property (absent parts = no constraint). */
export interface LayerFieldWhen {
  /** The layer carries a component of this type. */
  component?: string;
  /** Its kind is one of these (sceneDerive `readNodeKind`). */
  kinds?: readonly string[];
  /** Its kind is none of these. */
  notKinds?: readonly string[];
  /** 3D is on (`is3DEnabled`). */
  threeD?: boolean;
  /** Its `fx` component carries this key (any value). */
  fx?: string;
}

export interface LayerFieldSpec extends Omit<TextFieldSpec, 'kinds'> {
  /** The API path (`material/shading`). `key` (inherited) is the storage key. */
  path: string;
  store: LayerFieldStore;
  when?: LayerFieldWhen;
  /**
   * A choice / bool whose STORED form differs from its API value: pairs of
   * [API value, stored raw] — stored `null` = the prop is absent. Reading picks
   * the first pair whose raw equals the stored value (absent ↔ null); a stored
   * value no pair names reads as the spec default.
   */
  encode?: ReadonlyArray<readonly [string | boolean, unknown]>;
  /** A json field's shape: a write that is not null and not this shape is `invalidArgument`. */
  json?: 'object' | 'array';
  /** Also store the same raw value here (a legacy marker other code reads). */
  mirror?: LayerFieldStore;
}

const T = 'Transform';
const LIGHT = ['light'] as const;
const CAMERA = ['camera'] as const;
/** Layers that carry Geometry Options (propertyTree.ts `geometryRows`). */
const NO_GEOMETRY = ['camera', 'light', 'null', 'group', 'audio'] as const;
/** Layers that draw pixels a rig / cloner / physics body can act on. */
const VISUAL: LayerFieldWhen = { notKinds: ['camera', 'light', 'audio'] };
/** Layers that carry sound (the mixer's targets). */
const AUDIBLE: LayerFieldWhen = { kinds: ['audio', 'video', 'precomp'] };

export const LAYER_FIELDS: readonly LayerFieldSpec[] = [
  // ── Material Options (3D layers) ──
  {
    path: 'material/shading', key: 'shadingModel', label: 'Shading', type: 'choice', default: 'phong',
    choices: ['phong', 'pbr', 'toon'], store: { component: T, key: 'shadingModel' }, when: { threeD: true },
    encode: [['phong', null], ['pbr', 'pbr'], ['toon', 'toon']],
  },
  {
    path: 'material/toonBands', key: 'toonBands', label: 'Toon Bands', type: 'scalar', default: 3, min: 2, max: 8,
    clearAtDefault: true, store: { component: T, key: 'toonBands' }, when: { threeD: true },
  },
  {
    path: 'material/heightMap', key: 'heightMapAssetId', label: 'Height Map', type: 'string', default: '',
    clearAtDefault: true, store: { component: T, key: 'heightMapAssetId' }, when: { threeD: true },
  },
  {
    path: 'material/displacementSubdivisions', key: 'displacementSubdiv', label: 'Displacement Subdivisions', type: 'scalar',
    default: 0, min: 0, max: 3, clearAtDefault: true, store: { component: T, key: 'displacementSubdiv' }, when: { threeD: true },
  },
  {
    // Per-face overrides {side?, bevel?, back?: {fill?: hex, gain?: number}} (faceMaterials.ts).
    path: 'material/faceMaterials', key: 'faceMaterials', label: 'Face Materials', type: 'json', default: null,
    json: 'object', store: { component: T, key: 'faceMaterials' }, when: { threeD: true },
  },
  // ── Geometry Options ──
  {
    path: 'geometry/bevelStyle', key: 'bevelStyle', label: 'Bevel Style', type: 'choice', default: 'angular',
    choices: ['angular', 'concave', 'convex'], store: { component: T, key: 'bevelStyle' },
    when: { threeD: true, notKinds: NO_GEOMETRY }, encode: [['angular', null], ['concave', 'concave'], ['convex', 'convex']],
  },
  {
    // AE's Enable Per-character 3D (a text layer switch; stored on the Transform).
    path: 'text/perCharacter3D', key: 'perChar3D', label: 'Per-character 3D', type: 'bool', default: false,
    store: { component: T, key: 'perChar3D' }, when: { component: 'Text' }, encode: [[false, null], [true, true]],
  },
  // ── Light Options ──
  {
    path: 'light/lightType', key: 'lightType', label: 'Light Type', type: 'choice', default: 'point',
    choices: ['point', 'ambient', 'spot', 'parallel', 'environment'], store: { component: T, key: 'lightType' }, when: { kinds: LIGHT },
  },
  {
    path: 'light/falloff', key: 'falloff', label: 'Falloff', type: 'choice', default: 'none',
    choices: ['none', 'legacy', 'smooth', 'inverse-square'], store: { component: T, key: 'falloff' }, when: { kinds: LIGHT },
  },
  {
    // studio | sky | sunset | asset:<itemId> (environmentLight.ts EnvironmentSky).
    path: 'light/environment', key: 'envPreset', label: 'Environment', type: 'string', default: 'studio',
    store: { component: T, key: 'envPreset' }, when: { kinds: LIGHT },
  },
  {
    path: 'light/castsShadows', key: 'castShadows', label: 'Casts Shadows', type: 'bool', default: false,
    store: { component: T, key: 'castShadows' }, when: { kinds: LIGHT }, encode: [[false, null], [true, true], [false, false]],
  },
  {
    path: 'light/glow', key: 'lightGlow', label: 'Visible Glow', type: 'bool', default: false,
    store: { component: T, key: 'lightGlow' }, when: { kinds: LIGHT }, encode: [[false, null], [true, true], [false, false]],
  },
  {
    path: 'light/shadowMap', key: 'shadowMap', label: 'Shadow Map', type: 'bool', default: false,
    store: { component: T, key: 'shadowMap' }, when: { kinds: LIGHT }, encode: [[false, null], [true, true], [false, false]],
  },
  {
    path: 'light/shadowMapSize', key: 'shadowMapSize', label: 'Shadow Map Size', type: 'scalar', default: 1024, min: 64, max: 8192,
    clearAtDefault: true, store: { component: T, key: 'shadowMapSize' }, when: { kinds: LIGHT },
  },
  // ── Camera Options ──
  {
    path: 'camera/filmSize', key: 'filmSize', label: 'Film Size', type: 'scalar', default: 36, min: 1,
    clearAtDefault: true, store: { component: T, key: 'filmSize' }, when: { kinds: CAMERA },
  },
  // ── 3D primitives (the Primitive component) ──
  {
    path: 'primitive/type', key: 'type', label: 'Shape', type: 'choice', default: 'box',
    choices: ['sphere', 'cylinder', 'cone', 'torus', 'capsule', 'box'], store: { component: 'Primitive', key: 'type' },
    when: { component: 'Primitive' }, mirror: { component: T, key: 'primitiveType' },
  },
  ...(['radius', 'radiusTop', 'height', 'width', 'depth', 'tube'] as const).map((k): LayerFieldSpec => ({
    path: `primitive/${k}`, key: k, label: k, type: 'scalar', default: 100, min: 1,
    store: { component: 'Primitive', key: k }, when: { component: 'Primitive' },
  })),
  ...(['radialSegments', 'heightSegments'] as const).map((k): LayerFieldSpec => ({
    path: `primitive/${k}`, key: k, label: k, type: 'scalar', default: 32, min: 3, max: 256,
    store: { component: 'Primitive', key: k }, when: { component: 'Primitive' },
  })),
  {
    path: 'primitive/capped', key: 'capped', label: 'End Caps', type: 'bool', default: true,
    store: { component: 'Primitive', key: 'capped' }, when: { component: 'Primitive' },
  },
  // ── Structured layer configs (json) ──
  {
    path: 'layer/particle', key: 'particle', label: 'Particle Emitter', type: 'json', default: null, json: 'object',
    store: { fx: 'particle' }, when: { kinds: ['particle'] },
  },
  { path: 'layer/cloner', key: '__cloner', label: 'Cloner', type: 'json', default: null, json: 'object', store: { fx: '__cloner' }, when: VISUAL },
  { path: 'layer/physics', key: '__physics', label: 'Physics', type: 'json', default: null, json: 'object', store: { fx: '__physics' }, when: VISUAL },
  {
    path: 'layer/audioWaveform', key: 'audioWaveform', label: 'Audio Waveform', type: 'json', default: null, json: 'object',
    store: { fx: 'audioWaveform' }, when: VISUAL,
  },
  {
    // Record<prop, {modifiers, previous}> — the modifier stacks behind a property's expression (modifierStack.ts).
    path: 'layer/modifiers', key: '__modifiers', label: 'Modifier Stacks', type: 'json', default: null, json: 'object',
    store: { component: T, key: '__modifiers' },
  },
  {
    // A group layer composited as one unit (Precompose switch; not a new composition).
    path: 'layer/precompose', key: 'precomp', label: 'Precompose', type: 'bool', default: false,
    store: { fx: 'precomp' }, when: { kinds: ['group'] }, encode: [[false, null], [true, true]],
  },
  {
    // Per-instance overrides of a nested composition's essential properties: Record<`${origId}/${prop}`, number | string>.
    path: 'layer/compOverrides', key: '__compOverrides', label: 'Essential Properties', type: 'json', default: null, json: 'object',
    store: { fx: '__compOverrides' }, when: { kinds: ['precomp'] },
  },
  {
    path: 'layer/sequenceLoop', key: 'loop', label: 'Loop Sequence', type: 'bool', default: false,
    store: { fx: 'imageSequence', key: 'loop' }, when: { fx: 'imageSequence' }, encode: [[false, null], [true, true], [false, false]],
  },
  // ── Audio ──
  {
    // The declared WebAudio effect chain: AudioEffect[] (audioEffects.ts).
    path: 'audio/effects', key: 'audioEffects', label: 'Audio Effects', type: 'json', default: null, json: 'array',
    store: { fx: 'audioEffects' }, when: AUDIBLE,
  },
  {
    // The audio driver records (analysis parameters by driven property) — the keys/expression they produce are ordinary properties.
    // Every layer (B3z-E2): the Audio Driver section offers any numeric property — a camera's zoom, a light's intensity, an audio layer's level.
    path: 'audio/drivers', key: '__audioDriver', label: 'Audio Drivers', type: 'json', default: null, json: 'object',
    store: { component: T, key: '__audioDriver' },
  },
  {
    path: 'audio/ducking', key: '__ducking', label: 'Ducking', type: 'json', default: null, json: 'object',
    store: { component: T, key: '__ducking' }, when: AUDIBLE,
  },
  {
    path: 'audio/gate', key: '__gate', label: 'Noise Gate', type: 'json', default: null, json: 'object',
    store: { component: ['Audio', T], key: '__gate' }, when: AUDIBLE,
  },
  // ── B3z-E2 (audio timing without a bar, tracker camera tag) ──
  // An audio layer with NO timeline bar (nested in a plain group, a headless
  // scene) plays from its Audio component's own Start / In / Out (source
  // seconds; audioScene `propTiming`) — the inspector's Timing fields edit these
  // when there is no bar. A layer WITH a bar is timed by its bar (setLayerTiming).
  ...([['audio/clipStart', '__start', 'Start'], ['audio/clipIn', '__in', 'In Point'], ['audio/clipOut', '__out', 'Out Point']] as const)
    .map(([path, key, label]): LayerFieldSpec => ({
      path, key, label, type: 'scalar', default: 0, min: 0, store: { component: 'Audio', key }, when: { component: 'Audio' },
    })),
  {
    // The camera a Track Motion camera solve owns (re-running the solve re-keys it): applyTrack.ts PLANAR_SOLVE_CAMERA_PROP.
    path: 'camera/trackerSolve', key: '__planarSolveCamera', label: 'Tracker Solve Camera', type: 'bool', default: false,
    store: { component: T, key: '__planarSolveCamera' }, when: { kinds: CAMERA }, encode: [[false, null], [true, true]],
  },
  // ── B3z-a worker C: the Corners group's link switch (Style.cornersLinked;
  //    absent = linked — a legacy document with only `cornerRadius`). The radii
  //    themselves are latent numbers (latentPropSpecs.ts). ──
  {
    path: 'layer/cornersLinked', key: 'cornersLinked', label: 'Link Corners', type: 'bool', default: true,
    store: { component: 'Style', key: 'cornersLinked' }, when: { component: 'Style' },
  },
];
