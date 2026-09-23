/**
 * EFFECT and LAYER-STYLE FIELDS (B3z) — the static, non-keyframed values an
 * applied effect or a layer style stores beside its numeric parameters, as
 * engine-API properties (ENGINE_API.md §3.4, §15.9). The G1 field mechanism
 * (fields.ts) extended to the Effects panel:
 *
 *   effects/<id>/compositing/mask    AE Compositing Options ▸ Effect Mask — one of
 *                                    the layer's mask ids, '' = the whole layer
 *                                    (stored `Effect.maskId`, absent when '')
 *   effects/<id>/compositing/label   the effect's label colour — a `#rrggbb` hex
 *                                    (LABEL_COLORS), '' = none (stored
 *                                    `Effect.labelColor`, absent when '')
 *   styles/<key>/<field>             a layer style's switches (Use Global Light,
 *                                    Satin Invert, Bevel Direction, Stroke
 *                                    Position), stored on the style object
 *
 * DATA shared by both engines: the TypeScript catalog reads it directly, the
 * C++ catalog reads the copy crossEngineCatalog.test.ts generates into
 * catalog_data.inc. Row ORDER is the order both engines add the bindings in.
 * Pure — no scene graph, no stores.
 */

import type { TextFieldSpec } from '@core/text/textFields';

/** A field of one applied effect: `effects/<id>/<path>`, stored under `key` on the Effect. */
export interface EffectFieldSpec extends Omit<TextFieldSpec, 'kinds'> {
  /** The path below `effects/<id>/`. */
  path: string;
}

export const EFFECT_FIELDS: readonly EffectFieldSpec[] = [
  { path: 'compositing/mask', key: 'maskId', label: 'Effect Mask', type: 'string', default: '' },
  { path: 'compositing/label', key: 'labelColor', label: 'Label', type: 'string', default: '' },
];

/** A layer-style switch: `styles/<style>/<key>`, stored under `key` on the style object. */
export interface StyleFieldSpec extends Omit<TextFieldSpec, 'kinds'> {
  style: string;
}

/**
 * Read as the RENDERER reads them (layerStyles.ts `layerStylesToEffects`,
 * glassResolve.ts): an absent Use Global Light is unbound, an absent Invert is
 * off, an absent Direction is Up, an absent Position is Outside. A write stores
 * the value explicitly (the panel always did).
 */
export const STYLE_FIELDS: readonly StyleFieldSpec[] = [
  { style: 'glass', key: 'useGlobalLight', label: 'Use Global Light', type: 'bool', default: false },
  { style: 'dropShadow', key: 'useGlobalLight', label: 'Use Global Light', type: 'bool', default: false },
  { style: 'innerShadow', key: 'useGlobalLight', label: 'Use Global Light', type: 'bool', default: false },
  { style: 'satin', key: 'invert', label: 'Invert', type: 'bool', default: false },
  { style: 'bevel', key: 'direction', label: 'Direction', type: 'choice', default: 'up', choices: ['up', 'down'] },
  { style: 'bevel', key: 'useGlobalLight', label: 'Use Global Light', type: 'bool', default: false },
  { style: 'gradientOverlay', key: 'useGlobalLight', label: 'Use Global Light', type: 'bool', default: false },
  { style: 'stroke', key: 'position', label: 'Position', type: 'choice', default: 'outside', choices: ['outside', 'inside', 'center'] },
];

/**
 * Glass (B3z: a first-class layer style) — `styles/glass/<param>`, keyed on the
 * existing `glass.<param>` tracks (glassResolve.ts) and valued in their STORED
 * units (opacities, grain and specular intensity 0..1; pixels; degrees). Numeric
 * params in GLASS_PARAMS order, then the two colours (`glass.<c>_r/_g/_b/_a`).
 */
export const GLASS_PROPERTIES: ReadonlyArray<{ key: string; label: string; type: 'scalar' | 'color' }> = [
  { key: 'blur', label: 'Blur', type: 'scalar' },
  { key: 'saturation', label: 'Saturation', type: 'scalar' },
  { key: 'tintOpacity', label: 'Tint Opacity', type: 'scalar' },
  { key: 'refraction', label: 'Refraction', type: 'scalar' },
  { key: 'edgeWidth', label: 'Edge Width', type: 'scalar' },
  { key: 'chromaticAberration', label: 'Chromatic Aberration', type: 'scalar' },
  { key: 'rimOpacity', label: 'Rim Opacity', type: 'scalar' },
  { key: 'rimWidth', label: 'Rim Width', type: 'scalar' },
  { key: 'rimAngle', label: 'Rim Angle', type: 'scalar' },
  { key: 'specularAngle', label: 'Specular Angle', type: 'scalar' },
  { key: 'specularIntensity', label: 'Specular Intensity', type: 'scalar' },
  { key: 'specularFalloff', label: 'Specular Falloff', type: 'scalar' },
  { key: 'grain', label: 'Grain', type: 'scalar' },
  { key: 'tintColor', label: 'Tint Color', type: 'color' },
  { key: 'rimColor', label: 'Rim Color', type: 'color' },
];
