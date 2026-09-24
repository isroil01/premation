/**
 * Property metadata registry — one description of every animatable property,
 * keyed by the ANIMATION PROP PATH (`x`, `opacity`, `trim.start`,
 * `effect.<id>.<key>`, `fill_r`, `ctrl_speed`, …).
 *
 * Why this exists: the same property used to be described independently by the
 * inspector row, the timeline row, the effect row and a 17-deep nested ternary
 * in App.tsx. Four descriptions of one fact is four chances to disagree, and
 * they did — an effect parameter showed as `effect.fx_3.radius` in the timeline
 * and as "Radius" in the panel, and Scale scrubbed at 1× per pixel because no
 * surface owned its step.
 *
 * NOT to be confused with `PropertyRegistry.ts` in this same folder. That maps
 * `componentType::propName` → a React editor component, for the generic
 * NodeInspector. This maps an animation prop path → metadata. Different key
 * space, different consumers, deliberately separate: an editor is a rendering
 * decision, metadata is a fact about the property.
 *
 * This registry does NOT own values. `AnimationEngine` remains the value
 * authority and is untouched; a track still shadows the base value exactly as
 * before. Everything here is metadata beside the engine.
 *
 * ── Adding a property ────────────────────────────────────────────────
 * Static path  → add an entry to `STATIC`.
 * Family       → add a resolver to `RESOLVERS` (see the effect-param one).
 * Never        → add a local label/unit/range table in a component. That is
 *                the thing this file replaced; `resolvePropertyMeta` always
 *                returns something, so there is no reason to.
 */

import {
  EFFECT_DEFS, EFFECT_OPACITY_KEY, effectDefFor, getNodeEffects, type EffectParamDef,
} from '@core/effects/effects';
import { pluginEffectDefs } from '@core/effects/pluginEffectDefs';
import { humaniseParamName } from '@core/plugins/uiParams';
import { findPluginParamByPath, readPluginParam } from '@core/plugins/uiParamValues';
import {
  LAYER_STYLE_EFFECT_TYPE,
  LAYER_STYLE_LABEL,
  styleKeyFromEffectId,
  styleFieldForParam,
} from '@core/effects/layerStyles';
import { POSITION_PSEUDO_PROP } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { readAnimatorData } from '@core/text/textAnimators';
import { parseStrokeTrackPath, strokeTrackPath } from '@core/rendering/strokeTracks';
import {
  PAINT_KEY_LABEL,
  PAINT_KEY_UNIT,
  PAINT_PERCENT_KEYS,
  parsePaintColorPath,
  parsePaintPropPath,
  strokeDisplayNames,
} from '@core/paint/paintProps';

// ── Types ───────────────────────────────────────────────────────────

/**
 * What a few resolvers need to know about the LAYER a path is on (its effect
 * types, mask names, animators…). Given a node id, these are read from the
 * scene graph (`graphFacts`); the UI passes facts built from the document
 * mirror instead (src/core/mirror/metaFacts.ts, B4), so labels and ranges are
 * the same whichever engine owns the document.
 */
export interface MetaNodeFacts {
  /** The layer id — only the legacy JS plugin params read through it. */
  nodeId?: string;
  kind?: string;
  effectType?(effectId: string): string | undefined;
  pathOpType?(opId: string): string | undefined;
  paintStrokeName?(strokeId: string): string | undefined;
  maskName?(pathId: string): string | undefined;
  animators?(): Array<{ name?: string; selectors?: Array<{ kind?: string }> }>;
  strokeAt?(index: number): { taper?: { lengthUnits?: string }; wave?: { units?: string } } | undefined;
}

/** A node id (read from the scene graph) or ready-made facts. */
export type MetaNode = string | MetaNodeFacts;

function graphFacts(nodeId: string): MetaNodeFacts {
  const fxOf = (): Record<string, unknown> | undefined =>
    defaultSceneGraph.getNode(nodeId)?.components.find((c) => c.type === 'fx')?.props as Record<string, unknown> | undefined;
  return {
    nodeId,
    get kind() {
      const node = defaultSceneGraph.getNode(nodeId);
      return node ? readNodeKind(node) : undefined;
    },
    effectType: (id) => getNodeEffects(nodeId).find((e) => e.id === id)?.type,
    pathOpType: (id) => ((fxOf() as { pathOps?: Array<{ id?: string; type?: string }> } | undefined)?.pathOps ?? []).find((o) => o.id === id)?.type,
    paintStrokeName: (id) => {
      const strokes = (fxOf()?.paint as { strokes?: Array<{ id: string; mode: 'paint' | 'erase' | 'clone'; name?: string }> } | undefined)?.strokes;
      return Array.isArray(strokes) ? strokeDisplayNames(strokes).get(id) : undefined;
    },
    maskName: (id) => {
      const paths = (fxOf()?.mask as { paths?: Array<{ id: string; name?: string }> } | undefined)?.paths ?? [];
      const idx = paths.findIndex((p) => p.id === id);
      return idx >= 0 ? paths[idx]!.name ?? `Mask ${idx + 1}` : undefined;
    },
    animators: () => readAnimatorsForMeta(nodeId),
    strokeAt: (index) => storedStrokeAt(nodeId, index),
  };
}

function factsOf(node: MetaNode | undefined): MetaNodeFacts | undefined {
  if (node === undefined) return undefined;
  return typeof node === 'string' ? graphFacts(node) : node;
}

export type PropertyValueType =
  | 'number'
  | 'percent'
  | 'angle'
  | 'multiplier'
  | 'time'
  | 'color'
  | 'colorChannel'
  | 'boolean'
  | 'enum'
  | 'text'
  | 'path'
  | 'gradient'
  /** A synthesized row standing for several real tracks (AE's Position group). */
  | 'group';

export type PropertyGroup =
  | 'transform'
  | 'fill'
  | 'stroke'
  | 'effects'
  | 'trim'
  | 'repeater'
  | 'time'
  | 'text'
  | 'geometry'
  | 'controls'
  /** AE's Material Options — how a 3D layer answers lights and shadows. */
  | 'material'
  /** AE's Audio group. */
  | 'audio'
  /** AE's Camera Options — lens, orbit, point of interest, depth of field. */
  | 'camera'
  /** AE's Light Options — intensity, cone, falloff, shadow dials. */
  | 'light'
  | 'other';

export interface PropertyMeta {
  /** The canonical animation prop path this describes. */
  path: string;
  label: string;
  group: PropertyGroup;
  type: PropertyValueType;
  /** Unit suffix shown after the number. `''` when unitless. */
  unit: string;
  min?: number;
  max?: number;
  /** Value change per pixel of scrub / per arrow press. */
  step: number;
  /** Decimal places when displayed. */
  precision: number;
  /** The value a reset restores. `null` for non-numeric/unknown. */
  defaultValue: number | string | boolean | null;
  resettable: boolean;
  /**
   * FALSE for a property this registry describes but that cannot hold a
   * keyframe — the render path reads its stored value once, not per frame.
   *
   * No entry carries it today — Material Options did, until `readNodeMaterial`
   * learned to take the frame's animated values — but the seam stays: the
   * next property the render path reads once declares it HERE, on its entry,
   * and the timeline then lists it without a stopwatch. Absent means
   * keyframeable, which is everything at the moment.
   *
   * `animatablePropertyReaders.test.ts` reads this flag to decide whether a
   * property belongs in its sweep, which is why it is stated on the entry
   * rather than kept as a list of names in the test.
   */
  keyframeable?: false;
  /**
   * Multiply the STORED value by this to get the DISPLAYED one.
   *
   * The stored value is always canonical — `fillCenterX` is 0..1 because that
   * is what the renderer consumes — but the panel shows it as a percentage.
   * `min`/`max`/`step`/`defaultValue` above are all in STORED units; a surface
   * that displays scaled must scale them too. Absent/1 means they are the same.
   */
  displayScale?: number;
  /**
   * Sort position in a layer's property tree. AE's canonical Transform order
   * (Anchor 0 → Position 1 → Scale 2 → Rotation 3 → Orientation 4 → Opacity 5),
   * then everything else grouped after.
   */
  order: number;
}

/** Everything except `path`, which the table key supplies. */
type MetaSpec = Omit<PropertyMeta, 'path'>;

// ── Shared shapes ───────────────────────────────────────────────────

const PX = (label: string, group: PropertyGroup, order: number): MetaSpec => ({
  label, group, type: 'number', unit: 'px', step: 1, precision: 1, defaultValue: 0, resettable: true, order,
});

const DEG = (label: string, group: PropertyGroup, order: number): MetaSpec => ({
  label, group, type: 'angle', unit: '°', step: 1, precision: 1, defaultValue: 0, resettable: true, order,
});

/**
 * A multiplier. Deliberately UNBOUNDED below: a negative scale is how you flip
 * a layer, in this editor and in AE. Clamping it to 0 would silently delete
 * that, so anything that genuinely cannot go negative (a repeater's per-copy
 * scale, line height) states its own `min`.
 */
const MULT = (label: string, group: PropertyGroup, order: number): MetaSpec => ({
  label, group, type: 'multiplier', unit: 'x', step: 0.01, precision: 2, defaultValue: 1, resettable: true, order,
});

const PCT = (label: string, group: PropertyGroup, order: number, max = 100): MetaSpec => ({
  label, group, type: 'percent', unit: '%', min: 0, max, step: 1, precision: 1, defaultValue: max, resettable: true, order,
});

// ── Order slots (AE's Transform order, then the rest) ────────────────

export const ORDER = {
  anchor: 0,
  position: 1,
  scale: 2,
  rotation: 3,
  orientation: 4,
  skew: 5,
  opacity: 6,
  geometry: 7,
  fill: 8,
  stroke: 9,
  trim: 10,
  repeater: 11,
  effects: 12,
  time: 13,
  text: 14,
  controls: 15,
  other: 16,
  // Appended rather than slotted in beside `transform`, so no existing entry's
  // order number changes. The timeline groups these under their own headings
  // anyway; the number only orders rows WITHIN a group.
  material: 17,
  audio: 18,
  camera: 19,
  light: 20,
} as const;

// ── The static table ────────────────────────────────────────────────

const STATIC: Record<string, MetaSpec> = {
  // Transform — anchor
  anchorX: PX('Anchor Point X', 'transform', ORDER.anchor),
  anchorY: PX('Anchor Point Y', 'transform', ORDER.anchor),
  anchorZ: PX('Anchor Point Z', 'transform', ORDER.anchor),

  // Transform — position
  x: PX('Position X', 'transform', ORDER.position),
  y: PX('Position Y', 'transform', ORDER.position),
  z: PX('Position Z', 'transform', ORDER.position),

  // Transform — scale. `scale` is the legacy uniform prop; scaleX/Y/Z supersede it.
  scale: MULT('Scale', 'transform', ORDER.scale),
  scaleX: MULT('Scale X', 'transform', ORDER.scale),
  scaleY: MULT('Scale Y', 'transform', ORDER.scale),
  scaleZ: MULT('Scale Z', 'transform', ORDER.scale),

  // Transform — rotation / orientation
  rotation: DEG('Rotation', 'transform', ORDER.rotation),
  rotationX: DEG('Rotation X', 'transform', ORDER.rotation),
  rotationY: DEG('Rotation Y', 'transform', ORDER.rotation),
  orientationX: DEG('Orientation X', 'transform', ORDER.orientation),
  orientationY: DEG('Orientation Y', 'transform', ORDER.orientation),
  orientationZ: DEG('Orientation Z', 'transform', ORDER.orientation),

  // Transform — skew. Unbounded like rotation; the renderer clamps the shear
  // just short of 90 degrees, where tan explodes.
  skew: DEG('Skew', 'transform', ORDER.skew),
  skewAxis: DEG('Skew Axis', 'transform', ORDER.skew),

  // Transform — opacity (stored 0..100, matching the Style component)
  opacity: PCT('Opacity', 'transform', ORDER.opacity),
  // Fill opacity fades the layer's pixels but not its styles.
  fillOpacity: PCT('Fill Opacity', 'transform', ORDER.opacity),

  // Geometry. Size is NOT resettable — "reset" would mean 0×0, which is never
  // what anyone wants; there is no meaningful default width for a layer.
  width: { ...PX('Width', 'geometry', ORDER.geometry), min: 0, resettable: false },
  height: { ...PX('Height', 'geometry', ORDER.geometry), min: 0, resettable: false },
  cornerRadius: { ...PX('Corner Radius', 'geometry', ORDER.geometry), min: 0 },
  cornerRadiusTL: { ...PX('Corner TL', 'geometry', ORDER.geometry), min: 0 },
  cornerRadiusTR: { ...PX('Corner TR', 'geometry', ORDER.geometry), min: 0 },
  cornerRadiusBR: { ...PX('Corner BR', 'geometry', ORDER.geometry), min: 0 },
  cornerRadiusBL: { ...PX('Corner BL', 'geometry', ORDER.geometry), min: 0 },
  'path.points': {
    label: 'Path', group: 'geometry', type: 'path', unit: '',
    step: 1, precision: 0, defaultValue: null, resettable: false, order: ORDER.geometry,
  },

  // Fill — gradient geometry. STORED in 0..1 (renderer units); shown as %.
  fillAngle: DEG('Fill Angle', 'fill', ORDER.fill),
  fillCenterX: {
    label: 'Fill Center X', group: 'fill', type: 'percent', unit: '%',
    min: 0, max: 1, step: 0.01, precision: 0, defaultValue: 0.5, resettable: true,
    displayScale: 100, order: ORDER.fill,
  },
  fillCenterY: {
    label: 'Fill Center Y', group: 'fill', type: 'percent', unit: '%',
    min: 0, max: 1, step: 0.01, precision: 0, defaultValue: 0.5, resettable: true,
    displayScale: 100, order: ORDER.fill,
  },
  fillRadius: {
    label: 'Fill Radius', group: 'fill', type: 'percent', unit: '%',
    min: 0.01, max: 2, step: 0.01, precision: 0, defaultValue: 0.5, resettable: true,
    displayScale: 100, order: ORDER.fill,
  },
  'fill.stops': {
    label: 'Gradient Stops', group: 'fill', type: 'gradient', unit: '',
    step: 1, precision: 0, defaultValue: null, resettable: false, order: ORDER.fill,
  },
  // Text STROKE gradient geometry (`strokePaint` on the Text component) — the
  // fill's four, mirrored, in the same units. Sampled by `applyGradientTracks`.
  strokeAngle: DEG('Stroke Gradient Angle', 'stroke', ORDER.stroke),
  strokeCenterX: {
    label: 'Stroke Gradient Center X', group: 'stroke', type: 'percent', unit: '%',
    min: 0, max: 1, step: 0.01, precision: 0, defaultValue: 0.5, resettable: true,
    displayScale: 100, order: ORDER.stroke,
  },
  strokeCenterY: {
    label: 'Stroke Gradient Center Y', group: 'stroke', type: 'percent', unit: '%',
    min: 0, max: 1, step: 0.01, precision: 0, defaultValue: 0.5, resettable: true,
    displayScale: 100, order: ORDER.stroke,
  },
  strokeRadius: {
    label: 'Stroke Gradient Radius', group: 'stroke', type: 'percent', unit: '%',
    min: 0.01, max: 2, step: 0.01, precision: 0, defaultValue: 0.5, resettable: true,
    displayScale: 100, order: ORDER.stroke,
  },

  // Stroke
  strokeWidth: { ...PX('Stroke Width', 'stroke', ORDER.stroke), min: 0, defaultValue: 4 },
  // Arc length along the path, in the same px the dash pattern is measured in.
  // No min and no max on purpose: a negative offset slides the pattern the other
  // way, and drawing-on runs the offset across the whole path length, which
  // depends on the shape rather than on any bound expressible here.
  strokeDashOffset: { ...PX('Dash Offset', 'stroke', ORDER.stroke), defaultValue: 0 },

  // ── Taper and Wave (AE's Stroke group, CC 2018) ──
  //
  // Registered ONLY because `buildSnapshot` folds every one of them into the
  // resolved stroke. Registering a keyframeable property the renderer does not
  // sample is F34/F35, twice on this same board — and `animatablePropertyReaders`
  // now fails the build for it rather than leaving it to be found later.
  //
  // Stored as FRACTIONS with `displayScale: 100`, like `fillRadius`: the model
  // works in 0..1 and only the inspector says "%".
  strokeTaperStartWidth: {
    label: 'Taper Start Width', group: 'stroke', type: 'percent', unit: '%',
    min: 0, max: 1, step: 0.01, precision: 0, defaultValue: 1, resettable: true,
    displayScale: 100, order: ORDER.stroke,
  },
  strokeTaperEndWidth: {
    label: 'Taper End Width', group: 'stroke', type: 'percent', unit: '%',
    min: 0, max: 1, step: 0.01, precision: 0, defaultValue: 1, resettable: true,
    displayScale: 100, order: ORDER.stroke,
  },
  strokeTaperStartLength: {
    label: 'Taper Start Length', group: 'stroke', type: 'percent', unit: '%',
    min: 0, max: 1, step: 0.01, precision: 0, defaultValue: 0, resettable: true,
    displayScale: 100, order: ORDER.stroke,
  },
  strokeTaperEndLength: {
    label: 'Taper End Length', group: 'stroke', type: 'percent', unit: '%',
    min: 0, max: 1, step: 0.01, precision: 0, defaultValue: 0, resettable: true,
    displayScale: 100, order: ORDER.stroke,
  },
  // AE's range: −100% pointy … 0 straight … +100% round (strokeProfile.easeRamp).
  strokeTaperStartEase: {
    label: 'Taper Start Ease', group: 'stroke', type: 'percent', unit: '%',
    min: -1, max: 1, step: 0.01, precision: 0, defaultValue: 0, resettable: true,
    displayScale: 100, order: ORDER.stroke,
  },
  strokeTaperEndEase: {
    label: 'Taper End Ease', group: 'stroke', type: 'percent', unit: '%',
    min: -1, max: 1, step: 0.01, precision: 0, defaultValue: 0, resettable: true,
    displayScale: 100, order: ORDER.stroke,
  },
  // Wave amplitude and wavelength are ARC-LENGTH px, not fractions — a period
  // that scaled with the path would change the look on resize. (Units = Cycles
  // re-describes the wavelength per node — see `resolveStrokeUnits`.)
  strokeWaveAmount: { ...PX('Wave Amount', 'stroke', ORDER.stroke), defaultValue: 0 },
  strokeWaveWavelength: { ...PX('Wavelength', 'stroke', ORDER.stroke), min: 0, defaultValue: 0 },
  // The one that animates.
  strokeWavePhase: { ...DEG('Wave Phase', 'stroke', ORDER.stroke), defaultValue: 0 },

  // ── The rest of AE's Stroke group, keyframeable on strokes[0] ──
  // Same contract as everything above: each is folded by `resolveStrokeTracks`
  // (rendering/strokeTracks.ts), whose quoted table satisfies the G2 guard.
  // Strokes 2+ use `stroke.<i>.<param>`, resolved by `resolveStrokeStackParam`.
  strokeOpacity: {
    label: 'Stroke Opacity', group: 'stroke', type: 'percent', unit: '%',
    min: 0, max: 1, step: 0.01, precision: 0, defaultValue: 1, resettable: true,
    displayScale: 100, order: ORDER.stroke,
  },
  // A multiple of the stroke width, as Canvas2D and AE both define it; below 1
  // no miter exists, and 4 is the default the rasterizer has always run with.
  strokeMiterLimit: {
    label: 'Miter Limit', group: 'stroke', type: 'number', unit: '',
    min: 1, step: 0.1, precision: 1, defaultValue: 4, resettable: true, order: ORDER.stroke,
  },
  // AE's three Dash/Gap pairs, in pattern order. Arc-length px like the offset.
  strokeDash1: { ...PX('Dash', 'stroke', ORDER.stroke), min: 0, defaultValue: 10 },
  strokeGap1: { ...PX('Gap', 'stroke', ORDER.stroke), min: 0, defaultValue: 10 },
  strokeDash2: { ...PX('Dash 2', 'stroke', ORDER.stroke), min: 0, defaultValue: 10 },
  strokeGap2: { ...PX('Gap 2', 'stroke', ORDER.stroke), min: 0, defaultValue: 10 },
  strokeDash3: { ...PX('Dash 3', 'stroke', ORDER.stroke), min: 0, defaultValue: 10 },
  strokeGap3: { ...PX('Gap 3', 'stroke', ORDER.stroke), min: 0, defaultValue: 10 },
  // Gradient Stroke Start/End points, in the relative box units the fill's
  // radial centre uses (stored 0..1, shown as %). Unbounded: a point may sit
  // outside the layer, exactly as an AE gradient handle may.
  strokeGradientStartX: {
    label: 'Stroke Gradient Start X', group: 'stroke', type: 'percent', unit: '%',
    step: 0.01, precision: 0, defaultValue: 0.5, resettable: true, displayScale: 100, order: ORDER.stroke,
  },
  strokeGradientStartY: {
    label: 'Stroke Gradient Start Y', group: 'stroke', type: 'percent', unit: '%',
    step: 0.01, precision: 0, defaultValue: 0, resettable: true, displayScale: 100, order: ORDER.stroke,
  },
  strokeGradientEndX: {
    label: 'Stroke Gradient End X', group: 'stroke', type: 'percent', unit: '%',
    step: 0.01, precision: 0, defaultValue: 0.5, resettable: true, displayScale: 100, order: ORDER.stroke,
  },
  strokeGradientEndY: {
    label: 'Stroke Gradient End Y', group: 'stroke', type: 'percent', unit: '%',
    step: 0.01, precision: 0, defaultValue: 1, resettable: true, displayScale: 100, order: ORDER.stroke,
  },
  strokeHighlightLength: {
    label: 'Highlight Length', group: 'stroke', type: 'percent', unit: '%',
    min: -1, max: 1, step: 0.01, precision: 0, defaultValue: 0, resettable: true,
    displayScale: 100, order: ORDER.stroke,
  },
  strokeHighlightAngle: { ...DEG('Highlight Angle', 'stroke', ORDER.stroke), defaultValue: 0 },

  // Trim paths — matched by the `pathop.<id>.<param>` resolver below, not by a
  // literal key, since document version 1.4.0 made trim a chain entry with an
  // id-scoped keyframe path. Listing `trim.start` here would be a label for a
  // property path nothing writes any more.

  // Repeater — same story as trim, one version later. Document 1.5.0 made it a
  // chain entry with an id-scoped keyframe path, so it is matched by the
  // `pathop.<id>.<param>` resolver below. The five literal `rep.*` keys that
  // used to live here were labels for property paths nothing writes any more.

  // Time
  // Speed % retime (`core/animation/retime.ts`) — integrated, not sampled, by
  // the renderer; lives on the layer's ordinary keyframe axis.
  timeSpeed: {
    label: 'Speed', group: 'time', type: 'percent', unit: '%',
    min: -1000, max: 1000, step: 1, precision: 0, defaultValue: 100, resettable: false, order: ORDER.time,
  },
  timeRemap: {
    label: 'Time Remap', group: 'time', type: 'time', unit: 's',
    min: 0, step: 0.05, precision: 3, defaultValue: 0, resettable: false, order: ORDER.time,
  },
  precompTime: {
    label: 'Precomp Time', group: 'time', type: 'time', unit: 's',
    min: 0, step: 0.05, precision: 3, defaultValue: 0, resettable: false, order: ORDER.time,
  },

  // Text
  'text.source': {
    label: 'Source Text', group: 'text', type: 'text', unit: '',
    step: 1, precision: 0, defaultValue: null, resettable: false, order: ORDER.text,
  },
  fontSize: { ...PX('Font Size', 'text', ORDER.text), min: 1, defaultValue: 48 },
  // Variable-font weight, continuous 1–1000 (AE 26's keyframeable wght axis).
  // Canvas honours fractional numeric weights on variable fonts through the
  // ordinary font shorthand. Width/slant use font-variation-settings
  // (see textFontVariationSettings) so they survive rasterization.
  fontWeight: {
    label: 'Font Weight', group: 'text', type: 'number', unit: '',
    min: 1, max: 1000, step: 1, precision: 0, defaultValue: 400, resettable: true, order: ORDER.text,
  },
  // Variable-font wdth / slnt — rasterized via font-variation-settings.
  fontWidth: {
    label: 'Font Width', group: 'text', type: 'number', unit: '',
    min: 50, max: 200, step: 1, precision: 0, defaultValue: 100, resettable: true, order: ORDER.text,
  },
  fontSlant: {
    label: 'Font Slant', group: 'text', type: 'number', unit: '°',
    min: -15, max: 0, step: 0.5, precision: 1, defaultValue: 0, resettable: true, order: ORDER.text,
  },
  letterSpacing: PX('Letter Spacing', 'text', ORDER.text),
  lineHeight: { ...MULT('Line Height', 'text', ORDER.text), min: 0, defaultValue: 1.2, step: 0.01 },
  // Text ▸ More Options ▸ Grouping Alignment (textMoreOptions.ts): % of the
  // anchor group's box the transform origin is offset by.
  groupingAlignX: {
    label: 'Grouping Alignment X', group: 'text', type: 'percent', unit: '%',
    min: -100, max: 100, step: 1, precision: 1, defaultValue: 0, resettable: true, order: ORDER.text,
  },
  groupingAlignY: {
    label: 'Grouping Alignment Y', group: 'text', type: 'percent', unit: '%',
    min: -100, max: 100, step: 1, precision: 1, defaultValue: 0, resettable: true, order: ORDER.text,
  },

  // Material Options (3D). Stored as flat props on the Transform component;
  // `readNodeMaterial(node, av)` overrides each with its track when the
  // snapshot passes the frame's animated values, so these keyframe like any
  // transform property. `lightShading.ts` / the 3D shaders read the resolved
  // MaterialOptions, never the props, so the sample lands everywhere at once.
  ambient: PCT('Ambient', 'material', ORDER.material),
  // Unstored Diffuse renders at 50 % (material.ts MATERIAL_PCT_DEFAULTS); the registry default must agree, or the
  // API reports (and Reset writes) 100 for a layer that renders at 50 (B4: the Inspector now shows the API's value).
  diffuse: { ...PCT('Diffuse', 'material', ORDER.material), defaultValue: 50 },
  specular: { ...PCT('Specular Intensity', 'material', ORDER.material), defaultValue: 0 },
  shininess: { ...PCT('Shininess', 'material', ORDER.material, 200), defaultValue: 32, min: 1 },
  metal: { ...PCT('Metal', 'material', ORDER.material), defaultValue: 0 },
  lightTransmission: { ...PCT('Light Transmission', 'material', ORDER.material), defaultValue: 0 },
  roughness: { ...PCT('Roughness', 'material', ORDER.material), defaultValue: 50 },
  // Height displacement, px along the normal (B1); negative sinks.
  displacement: { ...PX('Displacement', 'material', ORDER.material), min: -2000, max: 2000 },
  // Advanced-3D reflection / transparency axes. Reflection Intensity's default
  // IS 100 (PCT's own) — the identity that reproduces today's IBL exactly; the
  // other four default 0. IOR is a bare number, 1–4, defaulting to AE's 1.52.
  reflectionIntensity: PCT('Reflection Intensity', 'material', ORDER.material),
  reflectionSharpness: { ...PCT('Reflection Sharpness', 'material', ORDER.material), defaultValue: 0 },
  reflectionRolloff: { ...PCT('Reflection Rolloff', 'material', ORDER.material), defaultValue: 0 },
  transparency: { ...PCT('Transparency', 'material', ORDER.material), defaultValue: 0 },
  transparencyRolloff: { ...PCT('Transparency Rolloff', 'material', ORDER.material), defaultValue: 0 },
  ior: {
    label: 'Index of Refraction', group: 'material', type: 'number', unit: '',
    min: 1, max: 4, step: 0.01, precision: 2, defaultValue: 1.52, resettable: true, order: ORDER.material,
  },
  // Hold tracks: 0/1 for Accepts Lights; 0=Off, 1=On, 2=Only for shadow switches.
  acceptsLights: {
    label: 'Accepts Lights', group: 'material', type: 'boolean', unit: '',
    min: 0, max: 1, step: 1, precision: 0, defaultValue: 0, resettable: true, order: ORDER.material,
  },
  castsShadows: {
    label: 'Casts Shadows', group: 'material', type: 'enum', unit: '',
    min: 0, max: 2, step: 1, precision: 0, defaultValue: 1, resettable: true, order: ORDER.material,
  },
  acceptsShadows: {
    label: 'Accepts Shadows', group: 'material', type: 'enum', unit: '',
    min: 0, max: 2, step: 1, precision: 0, defaultValue: 1, resettable: true, order: ORDER.material,
  },

  // Geometry Options (3D). Flat Transform props that buildSnapshot samples per
  // frame (`a.get('extrusionDepth' | 'bevelDepth' | 'holeBevelDepth')`), so
  // they keyframe like any transform property. Ranges match the inspector's.
  extrusionDepth: { ...PX('Extrusion Depth', 'geometry', ORDER.geometry), min: 0, max: 1000 },
  bevelDepth: { ...PX('Bevel Depth', 'geometry', ORDER.geometry), min: 0, max: 200 },
  holeBevelDepth: PCT('Hole Bevel Depth', 'geometry', ORDER.geometry),

  // Audio Levels, in decibels. `audioParams.ts` samples it per frame and
  // schedules the gain ramp; Pan rides the same seam into a StereoPannerNode.
  audioLevelDb: {
    label: 'Audio Levels', group: 'audio', type: 'number', unit: 'dB',
    min: -60, max: 12, step: 0.5, precision: 1, defaultValue: 0, resettable: true, order: ORDER.audio,
  },
  audioPan: {
    label: 'Pan', group: 'audio', type: 'number', unit: '%',
    min: -100, max: 100, step: 1, precision: 0, defaultValue: 0, resettable: true, order: ORDER.audio,
  },

  // ── Camera Options ──
  //
  // Every one of these was keyframeable from the inspector (CameraSection's
  // KeyframeRows) but invisible to the timeline, because the timeline's
  // generic component-prop scan admits only registered paths — so a fresh
  // camera showed Position + Orientation and nothing else, and a Zoom
  // animation could not be STARTED from the timeline at all. Ranges and
  // labels mirror CameraSection; stored units are comp px / degrees.
  // `poiX/Y/Z` are NOT here: lights share them, so a resolver below picks
  // the group by the node's kind.
  focalLength: {
    label: 'Zoom', group: 'camera', type: 'number', unit: 'px',
    // No reset target: the honest default depends on the comp (the New Camera
    // dialog derives it from a lens preset and the comp width).
    min: 50, step: 1, precision: 1, defaultValue: null, resettable: false, order: ORDER.camera,
  },
  orbitYaw: { ...DEG('Orbit Yaw', 'camera', ORDER.camera), min: -180, max: 180 },
  orbitPitch: { ...DEG('Orbit Pitch', 'camera', ORDER.camera), min: -89, max: 89 },
  dofStrength: {
    label: 'Blur Strength', group: 'camera', type: 'number', unit: 'px',
    min: 0, max: 60, step: 1, precision: 1, defaultValue: 0, resettable: true, order: ORDER.camera,
  },
  focusDistance: {
    // Defaults to the camera's focal length when absent — comp-dependent, so
    // no reset target.
    label: 'Focus Distance', group: 'camera', type: 'number', unit: 'px',
    min: 1, step: 1, precision: 1, defaultValue: null, resettable: false, order: ORDER.camera,
  },
  dofAperture: {
    label: 'Aperture', group: 'camera', type: 'number', unit: 'px',
    min: 0, step: 1, precision: 1, defaultValue: null, resettable: false, order: ORDER.camera,
  },
  fStop: {
    // 0 = the legacy symmetric ramp (see CameraSection's lens-model note);
    // resetting restores that, deliberately.
    label: 'F-Stop', group: 'camera', type: 'number', unit: '',
    min: 0, max: 32, step: 0.1, precision: 1, defaultValue: 0, resettable: true, order: ORDER.camera,
  },
  irisBlades: {
    label: 'Iris Blades', group: 'camera', type: 'number', unit: '',
    min: 0, max: 11, step: 1, precision: 0, defaultValue: 0, resettable: true, order: ORDER.camera,
  },
  irisRoundness: {
    label: 'Iris Roundness', group: 'camera', type: 'number', unit: '',
    min: 0, max: 1, step: 0.01, precision: 2, defaultValue: 0.65, resettable: true, order: ORDER.camera,
  },
  // AE's remaining iris/highlight exposes. Defaults are the render-identical
  // neutrals (rotation 0, aspect 1, threshold/saturation/fringe 0) — see
  // readNodeDof, which forwards each only at a non-neutral value.
  irisRotation: { ...DEG('Iris Rotation', 'camera', ORDER.camera), min: -180, max: 180 },
  irisAspect: {
    label: 'Iris Aspect Ratio', group: 'camera', type: 'number', unit: '',
    min: 0.25, max: 4, step: 0.05, precision: 2, defaultValue: 1, resettable: true, order: ORDER.camera,
  },
  highlightGain: {
    label: 'Highlight Gain', group: 'camera', type: 'number', unit: '',
    min: 0, max: 4, step: 0.05, precision: 2, defaultValue: 0, resettable: true, order: ORDER.camera,
  },
  highlightThreshold: {
    label: 'Highlight Threshold', group: 'camera', type: 'number', unit: '',
    min: 0, max: 1, step: 0.01, precision: 2, defaultValue: 0, resettable: true, order: ORDER.camera,
  },
  highlightSaturation: {
    label: 'Highlight Saturation', group: 'camera', type: 'number', unit: '',
    min: 0, max: 4, step: 0.05, precision: 2, defaultValue: 0, resettable: true, order: ORDER.camera,
  },
  diffractionFringe: {
    label: 'Diffraction Fringe', group: 'camera', type: 'number', unit: '',
    min: 0, max: 1, step: 0.01, precision: 2, defaultValue: 0, resettable: true, order: ORDER.camera,
  },

  // ── Light Options ──
  //
  // Same story as the camera set: LightSection keyframes all of these, the
  // timeline listed none of them. Defaults are LIGHT_DEFAULTS' values.
  // `intensity` and `radius` are NOT here — those names are not light-specific
  // (a circle shape can store `radius`), so a kind-checking resolver below
  // claims them only on light layers.
  falloffDistance: { ...PX('Falloff Distance', 'light', ORDER.light), min: 1, defaultValue: 500 },
  lightAngle: DEG('Direction', 'light', ORDER.light),
  lightCone: { ...DEG('Cone Angle', 'light', ORDER.light), min: 1, max: 179, defaultValue: 45 },
  lightConeFeather: { ...PCT('Cone Feather', 'light', ORDER.light), defaultValue: 50 },
  envRotation: DEG('Sky Rotation', 'light', ORDER.light),
  envReflections: { ...PCT('Reflections', 'light', ORDER.light), max: 200 },
  shadowDarkness: PCT('Shadow Darkness', 'light', ORDER.light),
  shadowDiffusion: { ...PX('Shadow Diffusion', 'light', ORDER.light), min: 0 },
  shadowBias: { ...PX('Shadow Bias', 'light', ORDER.light), min: 0, defaultValue: 3 },
  shadowSoftness: {
    label: 'Map Softness', group: 'light', type: 'number', unit: 'tx',
    min: 0, step: 0.1, precision: 1, defaultValue: 1, resettable: true, order: ORDER.light,
  },
};

// The synthesized Position group row the timeline shows when X/Y are not
// separated. Keyed off the engine's own pseudo-prop so the two cannot drift.
STATIC[POSITION_PSEUDO_PROP] = {
  label: 'Position', group: 'transform', type: 'group', unit: 'px',
  step: 1, precision: 1, defaultValue: 0, resettable: true, order: ORDER.position,
};

// ── Group placeholder rows (`__static:<key>`) ────────────────────────
//
// The timeline shows a layer's whole Transform group even before anything is
// keyframed. Each placeholder stands for several real tracks, so it borrows
// its unit and order from a representative member rather than inventing them.

/** Prefix for the timeline's un-keyframed group placeholder rows. */
export const GROUP_PLACEHOLDER_PREFIX = '__static:';

const GROUP_PLACEHOLDERS: Record<string, { label: string; representative: string }> = {
  anchor: { label: 'Anchor Point', representative: 'anchorX' },
  position: { label: 'Position', representative: 'x' },
  scale: { label: 'Scale', representative: 'scaleX' },
  rotation: { label: 'Rotation', representative: 'rotation' },
  orientation: { label: 'Orientation', representative: 'orientationX' },
  opacity: { label: 'Opacity', representative: 'opacity' },
};

/** Build the timeline's placeholder path for a transform group. */
export function groupPlaceholderPath(key: string): string {
  return `${GROUP_PLACEHOLDER_PREFIX}${key}`;
}

// ── Dynamic resolvers ───────────────────────────────────────────────

/** Colour channel suffixes used by decomposed colour tracks (`fill_r`, …). */
const CHANNEL_LABEL: Record<string, string> = { _r: 'Red', _g: 'Green', _b: 'Blue', _a: 'Alpha' };

/** Base labels for decomposed colour tracks whose base is not a static entry. */
const COLOR_BASE_LABEL: Record<string, string> = {
  fill: 'Fill Color',
  stroke: 'Stroke Color',
  color: 'Color',
};

function titleCase(s: string): string {
  return s
    .replace(/[._]/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** An effect parameter definition → metadata. */
function fromEffectParam(path: string, effectLabel: string, p: EffectParamDef): PropertyMeta {
  const base: PropertyMeta = {
    path,
    label: `${effectLabel} ${p.label}`,
    group: 'effects',
    type: 'number',
    unit: p.unit ?? '',
    min: p.min,
    max: p.max,
    step: 1,
    precision: p.precision ?? 0,
    defaultValue: typeof p.default === 'number' || typeof p.default === 'string' || typeof p.default === 'boolean'
      ? p.default
      : null,
    resettable: true,
    order: ORDER.effects,
  };
  if (p.type === 'color') return { ...base, type: 'color', defaultValue: String(p.default ?? '#000000') };
  if (p.type === 'checkbox') return { ...base, type: 'boolean', defaultValue: p.default === true };
  if (p.type === 'layer') return { ...base, type: 'enum', defaultValue: '', resettable: false };
  if (p.type === 'curve') return { ...base, type: 'path', defaultValue: null, resettable: true };
  // Step follows the DECLARED precision first: Levels' Gamma is 0.1..10 with
  // precision 2, a span wide enough to look integral while every useful value
  // sits between 0.4 and 2.5 — a step of 1 skips the whole band. Only when a
  // param declares no precision does the span decide.
  const span = (p.max ?? 1) - (p.min ?? 0);
  const step = base.precision > 0 ? 10 ** -base.precision : span > 0 && span <= 4 ? 0.01 : 1;
  return { ...base, step };
}

/**
 * Look up an effect parameter's definition for `effect.<effectId>.<key>`.
 *
 * The effect's TYPE lives on the node, so this needs `nodeId`. Without one we
 * fall back to searching every definition for a param with that key, which is
 * right often enough to beat showing the raw path — and is why the timeline no
 * longer prints `effect.fx_3.radius`.
 */
/**
 * `pluginUi.<plugin>.<panel>.<param>[.x|y|z]` — one parameter a plugin
 * contributes to the inspector of a layer it does not own.
 *
 * The plugin declares the label, the unit and the range; this is where they
 * reach every surface that describes a property, so the timeline, the graph
 * editor and the multi-selection rows all name it the way its author did
 * without any of them knowing plugins exist.
 *
 * ── `logarithmic`, implemented as a value-proportional step ──────────────────
 *
 * A log slider means "a pixel of drag is a constant RATIO, not a constant
 * amount" — which is what you want for a blur radius that is useful at both 0.5
 * and 500. `ValueField` scrubs linearly by `step`, so rather than teach it a
 * second gesture, the step is recomputed here from the parameter's CURRENT
 * value: 2% of it, floored at the parameter's own minimum. The result is the
 * behaviour a log axis is asked for (fine near the bottom, coarse near the top)
 * with no new mode in a control every panel in the editor shares.
 */
function resolvePluginParam(path: string, node?: MetaNode): PropertyMeta | null {
  const nodeId = factsOf(node)?.nodeId;
  const ref = findPluginParamByPath(path);
  if (!ref) return null;
  const { schema, axis } = ref;

  const label = schema.label ?? humaniseParamName(schema.name);
  const base = {
    path,
    // The plugin's name is NOT in the label: the section header already says
    // whose parameters these are, and "Acme Lab: Amount" in a pair row's
    // 90-pixel name cell is a truncated string that names nothing.
    label: axis ? `${label} ${axis.toUpperCase()}` : label,
    group: 'other' as const,
    type: 'number' as const,
    unit: schema.type === 'angle' ? '°' : (schema.unit ?? ''),
    precision: 2,
    resettable: true,
    order: ORDER.other,
  };

  const min = schema.min;
  const max = schema.max;
  let step = schema.step ?? 1;
  if (schema.logarithmic && nodeId) {
    const current = readPluginParam(nodeId, ref.pluginId, ref.panel.id, schema, axis);
    const magnitude = typeof current === 'number' ? Math.abs(current) : (min ?? 1);
    step = Math.max(magnitude * 0.02, (min ?? 0.01) || 0.01);
  }

  const fallback = axis
    ? (schema.default as Record<string, number> | undefined)?.[axis] ?? 0
    : schema.default;

  return {
    ...base,
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    step,
    defaultValue: typeof fallback === 'number' ? fallback : null,
  };
}

function resolveEffectParam(path: string, node?: MetaNode): PropertyMeta | null {
  const m = /^effect\.([^.]+)(?:\.(.+))?$/.exec(path);
  if (!m) return null;
  const [, effectId, rawKey] = m;
  if (!effectId) return null;

  const def = (() => {
    // A LAYER STYLE's effect is synthesised per frame by layerStylesToEffects
    // and never stored on the node, so getNodeEffects cannot find it. Resolve it
    // by style key instead — otherwise these fall through to the key-matching
    // fallback below, which would describe a Bevel's `size` using whichever
    // effect happens to declare a `size` first.
    const styleKey = styleKeyFromEffectId(effectId);
    if (styleKey) {
      const type = LAYER_STYLE_EFFECT_TYPE[styleKey];
      return type ? effectDefFor(type) : undefined;
    }
    const type = factsOf(node)?.effectType?.(effectId);
    // `effectDefFor`, not a scan of `EFFECT_DEFS` — that array is the built-ins
    // and a plugin's effect is not in it. Left as a scan, every parameter of a
    // plugin effect fell through to the key-matching fallback below and was
    // described by whichever BUILT-IN effect happened to declare the same key
    // first: a plugin's `radius` labelled and ranged as some other effect's.
    return type ? effectDefFor(type) : undefined;
  })();

  // AE's Compositing Options -> Effect Opacity. A reserved key rather than a
  // declared param (see EFFECT_OPACITY_KEY), so it resolves here or it falls
  // through to the key-matching scan below and gets described by whichever
  // effect declares `opacity` first — a Drop Shadow's shadow opacity standing
  // in for "how much of this effect survives", which are not the same dial.
  if (rawKey === EFFECT_OPACITY_KEY) {
    const styleKey = styleKeyFromEffectId(effectId);
    const owner = styleKey ? (LAYER_STYLE_LABEL[styleKey] ?? titleCase(styleKey)) : def?.label;
    return {
      path,
      label: owner ? `${owner} Effect Opacity` : 'Effect Opacity',
      group: 'effects',
      type: 'number',
      unit: '%',
      min: 0,
      max: 100,
      step: 1,
      precision: 0,
      defaultValue: 100,
      resettable: true,
      order: ORDER.effects,
    };
  }

  // `effect.<id>` with no key is the legacy "primary scalar" track.
  const key = rawKey ?? def?.params.find((p) => p.type === 'number')?.key;
  if (!key) {
    return {
      path, label: 'Effect', group: 'effects', type: 'number', unit: '',
      step: 1, precision: 0, defaultValue: 0, resettable: true, order: ORDER.effects,
    };
  }

  if (def) {
    const p = def.params.find((q) => q.key === key);
    if (p) {
      // A LAYER STYLE is named for the style the user switched on, and for the
      // FIELD they edited — not for the effect it happens to compile to. Left
      // to the effect's own naming, Outer Glow's Size read "Glow Radius" and
      // Gradient Overlay's Opacity read "Gradient Ramp Blend".
      const styleKey = styleKeyFromEffectId(effectId);
      if (styleKey) {
        const styleLabel = LAYER_STYLE_LABEL[styleKey] ?? titleCase(styleKey);
        const field = styleFieldForParam(styleKey, key);
        return {
          ...fromEffectParam(path, styleLabel, p),
          label: `${styleLabel} ${field ? titleCase(field) : p.label}`,
        };
      }
      return fromEffectParam(path, def.label, p);
    }
  }

  // No node context (or a stale effect id): match the key across all effects.
  // Built-ins first, so a plugin cannot change how an existing property is
  // labelled by declaring a param that collides with one — but plugin defs are
  // searched, because without them a plugin effect's keyframe track in the
  // timeline is labelled by `titleCase(key)` with no unit, range or precision.
  for (const d of [...EFFECT_DEFS, ...pluginEffectDefs()]) {
    const p = d.params.find((q) => q.key === key);
    if (p) return fromEffectParam(path, d.label, p);
  }
  return {
    path, label: titleCase(key), group: 'effects', type: 'number', unit: '',
    step: 1, precision: 0, defaultValue: 0, resettable: true, order: ORDER.effects,
  };
}

/**
 * `pathop.<opId>.<param>` — one path-operator parameter.
 *
 * Operators are id-scoped, so their keyframe paths carry an opaque id and the
 * static table cannot name them. Without this every path-op row in the timeline
 * and the graph editor read as "Pathop Op3 K4Xn Amount". Trim made it matter:
 * it used to have literal `trim.start` / `trim.end` / `trim.offset` entries and
 * proper labels, and folding it into the chain would have TAKEN THOSE AWAY.
 *
 * The label follows the operator's TYPE, so a Round Corners card's `amount`
 * reads "Radius" in the timeline exactly as it does in the inspector.
 */
const PATHOP_TYPE_LABEL: Record<string, string> = {
  zigzag: 'Zig-Zag', roundCorners: 'Round Corners', pucker: 'Pucker & Bloat',
  twist: 'Twist', offset: 'Offset Paths', roughen: 'Wiggle Paths', trim: 'Trim Paths',
  repeater: 'Repeater', wiggleTransform: 'Wiggle Transform', none: 'Path Operator',
};
const PATHOP_PARAM_LABEL: Record<string, Record<string, string>> = {
  roundCorners: { amount: 'Radius', detail: 'Steps' },
  pucker: { amount: 'Amount' },
  twist: { amount: 'Angle' },
  offset: { amount: 'Amount', miterLimit: 'Miter Limit' },
  roughen: { amount: 'Size', detail: 'Detail' },
  zigzag: { amount: 'Amount', detail: 'Ridges' },
  // The repeater's, matching the labels the inspector card shows — a timeline
  // row reading "Repeater Offsetrotation" is what titleCase would have given.
  repeater: {
    copies: 'Copies', offset: 'Offset', anchorX: 'Anchor X', anchorY: 'Anchor Y',
    offsetX: 'Position X', offsetY: 'Position Y', offsetRotation: 'Rotation',
    offsetScale: 'Scale', offsetOpacity: 'Opacity',
  },
  // Matching the inspector card, so the timeline never shows "Wiggletransform
  // Wigglerotation". `amount` is this operator's position amplitude.
  wiggleTransform: {
    amount: 'Position', wiggleRotation: 'Rotation', wiggleScale: 'Scale',
    anchorX: 'Anchor X', anchorY: 'Anchor Y',
    wigglesPerSecond: 'Wiggles/Second', correlation: 'Correlation',
  },
};
const PATHOP_PERCENT_PARAMS = new Set(['start', 'end', 'offset']);

/**
 * Bounds and granularity for the repeater's parameters, carried over from the
 * `rep.*` table this replaced.
 *
 * Without them a Scale row steps by 1 — from 1 straight to 2, skipping every
 * value anyone would use — and Opacity would drag past its own range. The
 * defaults matter too: a reset has to land on the no-op value (scale and
 * opacity 1), not on 0, which would make "reset" mean "make it disappear".
 */
const REPEATER_PARAM_META: Record<string, { unit?: string; min?: number; max?: number; step?: number; precision?: number; defaultValue?: number }> = {
  copies: { min: 1, max: 200, step: 1, precision: 0, defaultValue: 6 },
  offset: { step: 0.1, precision: 2, defaultValue: 0 },
  anchorX: { unit: 'px' },
  anchorY: { unit: 'px' },
  offsetX: { unit: 'px', defaultValue: 80 },
  offsetY: { unit: 'px' },
  offsetRotation: { unit: '°' },
  offsetScale: { min: 0, step: 0.02, precision: 2, defaultValue: 1 },
  offsetOpacity: { min: 0, max: 1, step: 0.02, precision: 2, defaultValue: 1 },
};

function resolvePathOpParam(path: string, node?: MetaNode): PropertyMeta | null {
  const m = /^pathop\.([^.]+)\.(.+)$/.exec(path);
  if (!m) return null;
  const [, opId, param] = m;
  if (!opId || !param) return null;

  const type = factsOf(node)?.pathOpType?.(opId) ?? 'none';
  const label = PATHOP_PARAM_LABEL[type]?.[param] ?? titleCase(param);
  // Trim's three are percentages of path length; `offset` wraps, so the range
  // is deliberately wider than 0..100 — that is how a chase runs past the end.
  const pct = type === 'trim' && PATHOP_PERCENT_PARAMS.has(param);
  // The repeater's rows keep the bounds they had as `rep.*` entries. Spread
  // LAST so they win over the generic defaults below, which is the whole point.
  // Offset Paths' miter cap: floored at 1 (no miter exists below it) and reset
  // to 4, the Canvas2D convention its renderer applies when the field is absent.
  const rep = type === 'repeater'
    ? REPEATER_PARAM_META[param]
    : type === 'offset' && param === 'miterLimit'
      ? { min: 1, step: 0.1, precision: 2, defaultValue: 4 }
      : undefined;
  return {
    path,
    label: `${PATHOP_TYPE_LABEL[type] ?? 'Path Operator'} ${label}`,
    // The existing 'trim' group is the shape-geometry bucket — it was named for
    // its only occupant. Every path operator belongs in it now that trim is one
    // of them; renaming the group would be churn in every consumer for nothing.
    // The repeater keeps its OWN group, which it already had as `rep.*`: it
    // fans a shape into copies rather than deforming one outline, and the two
    // read as different sections of the inspector.
    group: type === 'repeater' ? 'repeater' : 'trim',
    type: pct ? 'percent' : 'number',
    unit: pct ? '%' : '',
    ...(pct ? { min: -100, max: 200 } : {}),
    step: 1,
    precision: pct ? 1 : 2,
    defaultValue: param === 'end' ? 100 : 0,
    resettable: true,
    order: type === 'repeater' ? ORDER.repeater : ORDER.trim,
    ...rep,
  };
}

/**
 * `polystar.<param>` — one parameter of the parametric Polygon / Star.
 *
 * Plain keys (not id-scoped like `pathop.*`) because a layer has at most ONE
 * polystar — it IS the layer's geometry. Labels match the inspector section
 * (`polystarParamSpecs`), prefixed so a timeline row reads "Polystar Points"
 * rather than a bare "Points" among the transform rows.
 */
const POLYSTAR_PARAM_META: Record<string, { label: string; unit: string; min?: number; max?: number; step: number; precision: number; defaultValue: number }> = {
  points: { label: 'Points', unit: '', min: 3, max: 100, step: 1, precision: 0, defaultValue: 5 },
  rotation: { label: 'Rotation', unit: '°', step: 1, precision: 1, defaultValue: 0 },
  outerRadius: { label: 'Outer Radius', unit: 'px', min: 0, step: 1, precision: 1, defaultValue: 100 },
  innerRadius: { label: 'Inner Radius', unit: 'px', min: 0, step: 1, precision: 1, defaultValue: 50 },
  outerRoundness: { label: 'Outer Roundness', unit: '%', step: 1, precision: 1, defaultValue: 0 },
  innerRoundness: { label: 'Inner Roundness', unit: '%', step: 1, precision: 1, defaultValue: 0 },
};

function resolvePolystarParam(path: string): PropertyMeta | null {
  const m = /^polystar\.(.+)$/.exec(path);
  if (!m) return null;
  const meta = POLYSTAR_PARAM_META[m[1] ?? ''];
  if (!meta) return null;
  return {
    path,
    label: `Polystar ${meta.label}`,
    // The shape-geometry bucket, same as the path operators (see the group
    // note in resolvePathOpParam — 'trim' was named for its first occupant).
    group: 'trim',
    type: 'number',
    unit: meta.unit,
    ...(meta.min !== undefined ? { min: meta.min } : {}),
    ...(meta.max !== undefined ? { max: meta.max } : {}),
    step: meta.step,
    precision: meta.precision,
    defaultValue: meta.defaultValue,
    resettable: true,
    order: ORDER.trim,
  };
}

/**
 * `mask.<pathId>.<feather|opacity|expansion>` — one mask path's setting.
 *
 * Named for the path when the node is known ("Mask 2 Feather"), else by key.
 * Opacity is 0..100 here like every other opacity; the mask stores 0..1 and
 * `applyMaskPropertyTracks` scales.
 */
/**
 * `paint.<strokeId>.*` — AE's Effects ▸ Paint ▸ Brush N rows: Stroke Options,
 * the colour channels, the Path, the Transform. Named for the stroke when the
 * node is known ("Brush 2 Opacity"), in the units the timeline animates
 * (see `core/paint/paintProps.ts`).
 */
function resolvePaintProperty(path: string, node?: MetaNode): PropertyMeta | null {
  if (!path.startsWith('paint.')) return null;
  const num = parsePaintPropPath(path);
  const col = num ? null : parsePaintColorPath(path);
  const pathRow = !num && !col ? /^paint\.([^.]+)\.path$/.exec(path) : null;
  const strokeId = num?.strokeId ?? col?.strokeId ?? pathRow?.[1];
  if (!strokeId) return null;
  const name = factsOf(node)?.paintStrokeName?.(strokeId) ?? 'Paint';
  const base = { path, group: 'effects' as const, resettable: true, order: ORDER.effects };
  if (pathRow) {
    return { ...base, label: `${name} Path`, type: 'path', unit: '', step: 1, precision: 0, defaultValue: null, resettable: false };
  }
  if (col) {
    return { ...base, label: `${name} Color ${col.channel.toUpperCase()}`, type: 'colorChannel', unit: '', min: 0, max: 1, step: 0.01, precision: 3, defaultValue: 1 };
  }
  const key = num!.key;
  const label = `${name} ${PAINT_KEY_LABEL[key]}`;
  const unit = PAINT_KEY_UNIT[key];
  if (PAINT_PERCENT_KEYS.has(key)) {
    const dflt = key === 'start' ? 0 : key === 'spacing' ? 25 : 100;
    return { ...base, label, type: 'percent', unit, min: key === 'spacing' ? 1 : 0, ...(key === 'spacing' ? {} : { max: 100 }), step: 1, precision: 1, defaultValue: dflt };
  }
  if (key === 'angle' || key === 'rotation') {
    return { ...base, label, type: 'angle', unit, step: 1, precision: 1, defaultValue: 0 };
  }
  if (key === 'cloneTime' || key === 'cloneTimeShift') {
    return { ...base, label, type: 'time', unit, step: 0.01, precision: 2, defaultValue: 0 };
  }
  if (key === 'scale') {
    return { ...base, label, type: 'percent', unit, step: 1, precision: 1, defaultValue: 100 };
  }
  return { ...base, label, type: 'number', unit, ...(key === 'diameter' ? { min: 0.1 } : {}), step: 1, precision: 1, defaultValue: key === 'diameter' ? 12 : 0, resettable: key === 'diameter' };
}

function resolveMaskProperty(path: string, node?: MetaNode): PropertyMeta | null {
  const m = /^mask\.([^.]+)\.(feather|opacity|expansion)$/.exec(path);
  if (!m) return null;
  const [, pathId, key] = m as unknown as [string, string, 'feather' | 'opacity' | 'expansion'];
  const maskName = factsOf(node)?.maskName?.(pathId) ?? 'Mask';
  const base = { path, group: 'other' as const, resettable: true, order: ORDER.other };
  if (key === 'opacity') {
    return { ...base, label: `${maskName} Opacity`, type: 'percent', unit: '%', min: 0, max: 100, step: 1, precision: 1, defaultValue: 100 };
  }
  if (key === 'feather') {
    return { ...base, label: `${maskName} Feather`, type: 'number', unit: 'px', min: 0, step: 1, precision: 1, defaultValue: 0 };
  }
  return { ...base, label: `${maskName} Expansion`, type: 'number', unit: 'px', step: 1, precision: 1, defaultValue: 0 };
}

/** `<base>_r` / `_g` / `_b` / `_a` — one channel of a decomposed colour track. */
function resolveColorChannel(path: string, nodeId?: MetaNode): PropertyMeta | null {
  const m = /^(.+)(_[rgba])$/.exec(path);
  if (!m) return null;
  const [, base, suffix] = m;
  if (!base || !suffix) return null;
  const baseLabel =
    COLOR_BASE_LABEL[base] ??
    (base.startsWith('effect.') ? resolvePropertyMeta(base, nodeId).label : titleCase(base));
  // 0..1 on EVERY channel, alpha included: that is the scale the tracks are
  // stored in (`Color.fromHex` is what writes them, everywhere). The RGB
  // channels were declared 0..255 here, so the timeline row, the graph editor
  // and the slider all described a range 255× wider than the values in it —
  // dragging the row past 1 was a no-op because both readers clamp, and the
  // default of 255 offered to "reset" a channel to 255× full white.
  return {
    path,
    label: `${baseLabel} ${CHANNEL_LABEL[suffix]}`,
    group: base.startsWith('effect.') ? 'effects' : base.startsWith('stroke') ? 'stroke' : 'fill',
    type: 'colorChannel',
    unit: '',
    min: 0,
    max: 1,
    step: 0.01,
    precision: 3,
    defaultValue: 1,
    resettable: true,
    order: base.startsWith('effect.') ? ORDER.effects : ORDER.fill,
  };
}

/**
 * `intensity` / `radius` on a LIGHT layer — Light Options rows.
 *
 * Not STATIC entries because the names are not light-specific: a circle shape
 * can store `radius` (readGeometry reads it), and claiming the bare path
 * unconditionally would put a shape's radius row under a "Light Options"
 * heading. On any other kind these fall through to the raw-path fallback,
 * exactly as they did before lights were registered.
 */
function resolveLightOption(path: string, node?: MetaNode): PropertyMeta | null {
  if (path !== 'intensity' && path !== 'radius') return null;
  if (factsOf(node)?.kind !== 'light') return null;
  return path === 'intensity'
    ? {
        // Unbounded above on purpose: over-driving a light past 100% is a look.
        path, label: 'Intensity', group: 'light', type: 'percent', unit: '%',
        min: 0, step: 1, precision: 1, defaultValue: 100, resettable: true, order: ORDER.light,
      }
    : {
        path, label: 'Radius', group: 'light', type: 'number', unit: 'px',
        min: 1, step: 1, precision: 1, defaultValue: 500, resettable: true, order: ORDER.light,
      };
}

/**
 * `poiX` / `poiY` / `poiZ` — the Point of Interest of a two-node camera OR a
 * targeted light. A resolver rather than a STATIC entry because the group
 * (and so the timeline heading) depends on which kind of layer holds it:
 * "Camera Options" on a camera, "Light Options" on a light. Without a node
 * the camera reading wins — cameras are where a POI is most often keyframed.
 */
function resolvePointOfInterest(path: string, node?: MetaNode): PropertyMeta | null {
  const axis = path === 'poiX' ? 'X' : path === 'poiY' ? 'Y' : path === 'poiZ' ? 'Z' : null;
  if (!axis) return null;
  const kind = factsOf(node)?.kind;
  const group: PropertyGroup = kind === 'light' ? 'light' : 'camera';
  return {
    path,
    label: `Point of Interest ${axis}`,
    group,
    type: 'number',
    unit: 'px',
    step: 1,
    precision: 1,
    // The default is the comp centre — comp-dependent, so no reset target.
    defaultValue: null,
    resettable: false,
    order: group === 'light' ? ORDER.light : ORDER.camera,
  };
}

/** `ctrl_<name>` — a user-defined expression control slider. */
function resolveControl(path: string): PropertyMeta | null {
  if (!path.startsWith('ctrl_')) return null;
  return {
    path,
    label: `${titleCase(path.slice(5))} (Control)`,
    group: 'controls',
    type: 'number',
    unit: '',
    step: 1,
    precision: 2,
    defaultValue: 0,
    resettable: true,
    order: ORDER.controls,
  };
}

/** `__static:<key>` — a transform group placeholder row. */
function resolveGroupPlaceholder(path: string): PropertyMeta | null {
  if (!path.startsWith(GROUP_PLACEHOLDER_PREFIX)) return null;
  const key = path.slice(GROUP_PLACEHOLDER_PREFIX.length);
  const g = GROUP_PLACEHOLDERS[key];
  if (!g) return null;
  const rep = STATIC[g.representative];
  return {
    path,
    label: g.label,
    group: rep?.group ?? 'transform',
    type: 'group',
    unit: rep?.unit ?? '',
    min: rep?.min,
    max: rep?.max,
    step: rep?.step ?? 1,
    precision: rep?.precision ?? 1,
    defaultValue: rep?.defaultValue ?? null,
    resettable: rep?.resettable ?? true,
    ...(rep?.displayScale !== undefined ? { displayScale: rep.displayScale } : {}),
    order: rep?.order ?? ORDER.other,
  };
}

// ── Text animators ──────────────────────────────────────────────────

/** Per-parameter display metadata for animator and selector paths. */
const ANIMATOR_PARAM_META: Record<string, { label: string; unit: string; type: PropertyValueType }> = {
  // Selector window — the ones you actually keyframe.
  start: { label: 'Start', unit: '%', type: 'percent' },
  end: { label: 'End', unit: '%', type: 'percent' },
  offset: { label: 'Offset', unit: '%', type: 'percent' },
  amount: { label: 'Amount', unit: '%', type: 'percent' },
  smoothness: { label: 'Smoothness', unit: '%', type: 'percent' },
  easeHigh: { label: 'Ease High', unit: '%', type: 'percent' },
  easeLow: { label: 'Ease Low', unit: '%', type: 'percent' },
  // Wiggly selector.
  maxAmount: { label: 'Max Amount', unit: '%', type: 'percent' },
  minAmount: { label: 'Min Amount', unit: '%', type: 'percent' },
  wigglesPerSecond: { label: 'Wiggles/Second', unit: 'Hz', type: 'number' },
  wiggleFreq: { label: 'Wiggles/Second', unit: 'Hz', type: 'number' },
  correlation: { label: 'Correlation', unit: '%', type: 'percent' },
  temporalPhase: { label: 'Temporal Phase', unit: '°', type: 'angle' },
  spatialPhase: { label: 'Spatial Phase', unit: '°', type: 'angle' },
  // Animator properties.
  x: { label: 'Position X', unit: 'px', type: 'number' },
  y: { label: 'Position Y', unit: 'px', type: 'number' },
  z: { label: 'Position Z', unit: 'px', type: 'number' },
  scale: { label: 'Scale X', unit: '%', type: 'percent' },
  scaleY: { label: 'Scale Y', unit: '%', type: 'percent' },
  rotation: { label: 'Rotation', unit: '°', type: 'angle' },
  rotationX: { label: 'Rotation X', unit: '°', type: 'angle' },
  rotationY: { label: 'Rotation Y', unit: '°', type: 'angle' },
  skew: { label: 'Skew', unit: '°', type: 'angle' },
  opacity: { label: 'Opacity', unit: '%', type: 'percent' },
  fillOpacity: { label: 'Fill Opacity', unit: '%', type: 'percent' },
  tracking: { label: 'Tracking', unit: 'px', type: 'number' },
  lineSpacing: { label: 'Line Spacing', unit: 'px', type: 'number' },
  characterOffset: { label: 'Character Offset', unit: '', type: 'number' },
  blur: { label: 'Blur X', unit: 'px', type: 'number' },
  blurY: { label: 'Blur Y', unit: 'px', type: 'number' },
  strokeWidth: { label: 'Stroke Width', unit: 'px', type: 'number' },
  // Optional properties (Add ▸ Property).
  anchorX: { label: 'Anchor Point X', unit: 'px', type: 'number' },
  anchorY: { label: 'Anchor Point Y', unit: 'px', type: 'number' },
  anchorZ: { label: 'Anchor Point Z', unit: 'px', type: 'number' },
  skewAxis: { label: 'Skew Axis', unit: '°', type: 'angle' },
  lineAnchor: { label: 'Line Anchor', unit: '%', type: 'percent' },
  characterValue: { label: 'Character Value', unit: '', type: 'number' },
  fillHue: { label: 'Fill Hue', unit: '°', type: 'angle' },
  fillSaturation: { label: 'Fill Saturation', unit: '%', type: 'percent' },
  fillBrightness: { label: 'Fill Brightness', unit: '%', type: 'percent' },
  strokeOpacity: { label: 'Stroke Opacity', unit: '%', type: 'percent' },
  strokeHue: { label: 'Stroke Hue', unit: '°', type: 'angle' },
  strokeSaturation: { label: 'Stroke Saturation', unit: '%', type: 'percent' },
  strokeBrightness: { label: 'Stroke Brightness', unit: '%', type: 'percent' },
};

/** `text.axis.<tag>` and `textPath.<param>` — the Character panel's variable
 *  axes and Path Options, labelled like AE's Text ▸ Path Options group. */
function resolveTextOptionPath(path: string): PropertyMeta | null {
  const axis = /^text\.axis\.([A-Za-z0-9]{4})$/.exec(path);
  const tp = /^textPath\.(firstMargin|lastMargin|reversed|perpendicular|forceAlignment)$/.exec(path);
  if (!axis && !tp) return null;
  const base = { path, group: 'text' as const, resettable: true, order: ORDER.text, defaultValue: null };
  if (axis) {
    return { ...base, label: `Font Axis ${axis[1]}`, type: 'number', unit: '', step: 1, precision: 1 };
  }
  const param = tp![1]!;
  const LABELS: Record<string, string> = {
    firstMargin: 'First Margin', lastMargin: 'Last Margin', reversed: 'Reverse Path',
    perpendicular: 'Perpendicular To Path', forceAlignment: 'Force Alignment',
  };
  const flag = param === 'reversed' || param === 'perpendicular' || param === 'forceAlignment';
  return {
    ...base,
    label: `Path Options ${LABELS[param]}`,
    type: flag ? 'boolean' : 'number',
    unit: flag ? '' : 'px',
    ...(flag ? { min: 0, max: 1 } : {}),
    step: 1,
    precision: flag ? 0 : 1,
  };
}

/** Selector-0 parameters that kept their legacy flat path (`ta.0.offset`). */
const LEGACY_SELECTOR_PARAMS = new Set(['start', 'end', 'offset', 'wiggleFreq']);

/**
 * Text animator and selector paths → readable labels.
 *
 * `ta.0.offset` is the single most-keyframed path in the whole text system —
 * it is the parameter every reveal preset animates — and it was rendering in
 * the timeline as "Ta.0.offset" via the raw-path fallback. A user who applies
 * "Cascade" and opens the timeline should see what the row is.
 *
 * AE nests these as `Text > Animator 1 > Range Selector 1 > Offset`. A flat
 * timeline row cannot nest, so the parts are joined — but the selector part is
 * OMITTED when the animator has only one selector, which is almost always. A
 * row reading "Animator 1 Range Selector 1 Offset" when there is only one
 * selector is noise, not information.
 */
function resolveTextAnimator(path: string, node?: MetaNode): PropertyMeta | null {
  const m = /^ta\.(\d+)\.(?:s(\d+)\.)?([A-Za-z][A-Za-z0-9]*)$/.exec(path);
  if (!m) return null;
  const animIndex = Number(m[1]);
  const param = m[3]!;
  const meta = ANIMATOR_PARAM_META[param];

  // A selector index is explicit (`s2`) or implied by a legacy flat param.
  const explicit = m[2] !== undefined ? Number(m[2]) : undefined;
  const selIndex = explicit ?? (LEGACY_SELECTOR_PARAMS.has(param) ? 0 : undefined);

  const animators = factsOf(node)?.animators?.() ?? [];
  const animator = animators[animIndex];
  const animLabel = animator?.name ?? `Animator ${animIndex + 1}`;

  let selLabel = '';
  if (selIndex !== undefined) {
    const selectors = animator?.selectors ?? [];
    // Only name the selector when there is more than one to tell apart.
    if (selectors.length > 1) {
      const kind = selectors[selIndex]?.kind ?? 'range';
      const kindLabel = kind === 'wiggly' ? 'Wiggly' : kind === 'expression' ? 'Expression' : 'Range';
      selLabel = `${kindLabel} Selector ${selIndex + 1} `;
    }
  }

  const axisTag = /^axis([A-Za-z0-9]{4})$/.exec(param)?.[1];
  const paramLabel = meta?.label ?? (axisTag ? `Font Axis ${axisTag}` : titleCase(param));
  return {
    path,
    label: `${animLabel} ${selLabel}${paramLabel}`,
    group: 'text',
    type: meta?.type ?? 'number',
    unit: meta?.unit ?? '',
    step: 1,
    precision: meta?.unit === 'Hz' ? 2 : 1,
    defaultValue: null,
    resettable: true,
    order: ORDER.text,
  };
}

/** Animator metadata for labelling. Tolerant by design: the timeline must
 *  render a row even for a node that has gone away mid-update. */
function readAnimatorsForMeta(
  nodeId: string,
): Array<{ name?: string; selectors?: Array<{ kind?: string }> }> {
  try {
    const node = defaultSceneGraph.getNode(nodeId);
    return node ? (readAnimatorData(node) as Array<{ name?: string; selectors?: Array<{ kind?: string }> }>) : [];
  } catch {
    return [];
  }
}

/**
 * Order matters, and it is not arbitrary.
 *
 * `resolveColorChannel` MUST run before `resolveEffectParam`: an effect colour
 * track is `effect.<id>.color_r`, which the effect-param regex happily matches
 * with key `color_r` — a key no definition declares, so it fell through to the
 * raw-path fallback and rendered as "Color R" instead of "Drop Shadow Color
 * Red". The channel resolver strips the suffix and recurses, so the effect
 * still supplies the base label.
 *
 * `resolveControl` runs before the channel resolver so a control literally
 * named `a`/`r`/`g`/`b` isn't mistaken for a colour channel of `ctrl`.
 */
const RESOLVERS: ReadonlyArray<(path: string, node?: MetaNode) => PropertyMeta | null> = [
  // Before `resolveColorChannel`: `stroke.1.color_r` must be named for its
  // stroke, not title-cased as a channel of an unknown base.
  resolveStrokeStackParam,
  // Before `resolveColorChannel` too: `paint.<id>.color_r` is a stroke's colour.
  resolvePaintProperty,
  resolveMaskProperty,
  resolveGroupPlaceholder,
  resolveControl,
  resolveLightOption,
  resolvePointOfInterest,
  resolveColorChannel,
  resolveTextAnimator,
  resolveTextOptionPath,
  resolveEffectParam,
  // Before the fallback, like every other resolver here, and for the sharp
  // version of the reason `resolveEffectParam` gives: a contributed parameter
  // otherwise falls through to `titleCase(path)` and is labelled with the
  // track key — `PluginUi.Studio-acme.Lift.Amount` — in the timeline, the graph
  // editor and every row that names a property.
  resolvePluginParam,
  resolvePathOpParam,
  resolvePolystarParam,
];

// ── Strokes 2+ and stroke units ─────────────────────────────────────

/**
 * `stroke.<i>.<param>` (and `stroke.<i>.color_r|g|b|a`) — one parameter of a
 * stroke after the first.
 *
 * Described as the primary stroke's entry for the same parameter, renumbered:
 * "Stroke Width" on the second stroke reads "Stroke 2 Width", "Dash Offset"
 * reads "Stroke 2 Dash Offset". Deriving rather than duplicating the table is
 * what keeps a range or unit fix on the primary from missing its siblings.
 */
function resolveStrokeStackParam(path: string, nodeId?: MetaNode): PropertyMeta | null {
  if (!path.startsWith('stroke.')) return null;
  const parsed = parseStrokeTrackPath(path);
  if (!parsed || parsed.index === 0) return null;
  const primary = parsed.channel ? `stroke${parsed.channel}` : strokeTrackPath(0, parsed.param);
  const base = resolvePropertyMeta(primary);
  const n = parsed.index + 1;
  const label = base.label.startsWith('Stroke ') ? `Stroke ${n} ${base.label.slice(7)}` : `Stroke ${n} ${base.label}`;
  const meta: PropertyMeta = { ...base, path, label };
  return nodeId ? withStrokeUnits(meta, nodeId) : meta;
}

/** The STORED stroke at `index` of a node's stack, raw — enough to read its units. */
function storedStrokeAt(
  nodeId: string,
  index: number,
): { taper?: { lengthUnits?: string }; wave?: { units?: string } } | undefined {
  const fx = defaultSceneGraph.getNode(nodeId)?.components.find((c) => c.type === 'fx')?.props as
    | { strokes?: unknown; stroke?: unknown }
    | undefined;
  const stack = Array.isArray(fx?.strokes) && fx!.strokes.length > 0 ? fx!.strokes : fx?.stroke ? [fx.stroke] : [];
  return stack[index] as { taper?: { lengthUnits?: string }; wave?: { units?: string } } | undefined;
}

/**
 * The two stroke parameters whose UNIT belongs to the layer, not the property:
 * a taper length is a percentage or px (AE's Length Units), and a wavelength is
 * px or a cycle count (AE's Wave Units). Without this a pixel taper's row reads
 * "%" and scales by 100 — a field that means the wrong thing.
 */
function withStrokeUnits(meta: PropertyMeta, node: MetaNode): PropertyMeta {
  const parsed = parseStrokeTrackPath(meta.path);
  if (!parsed) return meta;
  const { param, index } = parsed;
  const strokeAt = (i: number): ReturnType<typeof storedStrokeAt> => factsOf(node)?.strokeAt?.(i);
  if (param === 'waveWavelength') {
    return strokeAt(index)?.wave?.units === 'cycles'
      ? { ...meta, label: meta.label.replace(/Wavelength$/, 'Cycles'), unit: '', min: 0, step: 0.1, precision: 1 }
      : meta;
  }
  if (param !== 'taperStartLength' && param !== 'taperEndLength') return meta;
  if (strokeAt(index)?.taper?.lengthUnits !== 'pixels') return meta;
  const { displayScale: _scale, max: _max, ...rest } = meta;
  return { ...rest, type: 'number', unit: 'px', min: 0, step: 1, precision: 1 };
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Metadata for an animation prop path. ALWAYS returns an entry — an unknown
 * path gets a title-cased label and neutral numeric metadata, which is still
 * strictly better than the raw path a local table would have missed.
 *
 * `nodeId` is optional and only sharpens paths whose meaning depends on the
 * layer (effect params resolve their effect's definition through it).
 */
export function resolvePropertyMeta(path: string, node?: MetaNode): PropertyMeta {
  const exact = STATIC[path];
  if (exact) {
    // A stroke entry's unit can depend on the layer (see withStrokeUnits).
    return node && exact.group === 'stroke' ? withStrokeUnits({ path, ...exact }, node) : { path, ...exact };
  }
  // Built once per call, not per resolver (a node id reads the graph lazily).
  const facts = factsOf(node);
  for (const r of RESOLVERS) {
    const hit = r(path, facts);
    if (hit) return hit;
  }
  return {
    path,
    label: titleCase(path),
    group: 'other',
    type: 'number',
    unit: '',
    step: 1,
    precision: 2,
    defaultValue: null,
    resettable: false,
    order: ORDER.other,
  };
}

/** Display label for a prop path. */
export function propertyLabel(path: string, nodeId?: MetaNode): string {
  return resolvePropertyMeta(path, nodeId).label;
}

/** Unit suffix for a prop path (`''` when unitless). */
export function propertyUnit(path: string, nodeId?: MetaNode): string {
  return resolvePropertyMeta(path, nodeId).unit;
}

/** Sort position of a prop path within a layer's property tree. */
export function propertyOrder(path: string, nodeId?: MetaNode): number {
  return resolvePropertyMeta(path, nodeId).order;
}

/** True when the registry describes this path explicitly (not via fallback). */
export function hasPropertyMeta(path: string, nodeId?: MetaNode): boolean {
  if (STATIC[path]) return true;
  const facts = factsOf(nodeId);
  return RESOLVERS.some((r) => r(path, facts) !== null);
}

/** Every statically-described path — the registry's own inventory, for tests. */
export function staticPropertyPaths(): string[] {
  return Object.keys(STATIC);
}
