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
  EFFECT_DEFS, effectDefFor, getNodeEffects, type EffectParamDef,
} from '@core/effects/effects';
import { pluginEffectDefs } from '@core/effects/pluginEffectDefs';
import {
  LAYER_STYLE_EFFECT_TYPE,
  LAYER_STYLE_LABEL,
  styleKeyFromEffectId,
  styleFieldForParam,
} from '@core/effects/layerStyles';
import { POSITION_PSEUDO_PROP } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readAnimatorData } from '@core/text/textAnimators';

// ── Types ───────────────────────────────────────────────────────────

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
  strokeTaperStartEase: {
    label: 'Taper Start Ease', group: 'stroke', type: 'percent', unit: '%',
    min: 0, max: 1, step: 0.01, precision: 0, defaultValue: 0, resettable: true,
    displayScale: 100, order: ORDER.stroke,
  },
  strokeTaperEndEase: {
    label: 'Taper End Ease', group: 'stroke', type: 'percent', unit: '%',
    min: 0, max: 1, step: 0.01, precision: 0, defaultValue: 0, resettable: true,
    displayScale: 100, order: ORDER.stroke,
  },
  // Wave amplitude and wavelength are ARC-LENGTH px, not fractions — a period
  // that scaled with the path would change the look on resize.
  strokeWaveAmount: { ...PX('Wave Amount', 'stroke', ORDER.stroke), defaultValue: 0 },
  strokeWaveWavelength: { ...PX('Wavelength', 'stroke', ORDER.stroke), min: 0, defaultValue: 0 },
  // The one that animates.
  strokeWavePhase: { ...DEG('Wave Phase', 'stroke', ORDER.stroke), defaultValue: 0 },

  // Trim paths — matched by the `pathop.<id>.<param>` resolver below, not by a
  // literal key, since document version 1.4.0 made trim a chain entry with an
  // id-scoped keyframe path. Listing `trim.start` here would be a label for a
  // property path nothing writes any more.

  // Repeater — same story as trim, one version later. Document 1.5.0 made it a
  // chain entry with an id-scoped keyframe path, so it is matched by the
  // `pathop.<id>.<param>` resolver below. The five literal `rep.*` keys that
  // used to live here were labels for property paths nothing writes any more.

  // Time
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
  letterSpacing: PX('Letter Spacing', 'text', ORDER.text),
  lineHeight: { ...MULT('Line Height', 'text', ORDER.text), min: 0, defaultValue: 1.2, step: 0.01 },
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
function resolveEffectParam(path: string, nodeId?: string): PropertyMeta | null {
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
    if (!nodeId) return undefined;
    const fx = getNodeEffects(nodeId).find((e) => e.id === effectId);
    // `effectDefFor`, not a scan of `EFFECT_DEFS` — that array is the built-ins
    // and a plugin's effect is not in it. Left as a scan, every parameter of a
    // plugin effect fell through to the key-matching fallback below and was
    // described by whichever BUILT-IN effect happened to declare the same key
    // first: a plugin's `radius` labelled and ranged as some other effect's.
    return fx ? effectDefFor(fx.type) : undefined;
  })();

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
  repeater: 'Repeater', none: 'Path Operator',
};
const PATHOP_PARAM_LABEL: Record<string, Record<string, string>> = {
  roundCorners: { amount: 'Radius', detail: 'Steps' },
  pucker: { amount: 'Amount' },
  twist: { amount: 'Angle' },
  offset: { amount: 'Offset' },
  roughen: { amount: 'Size', detail: 'Detail' },
  zigzag: { amount: 'Amount', detail: 'Ridges' },
  // The repeater's, matching the labels the inspector card shows — a timeline
  // row reading "Repeater Offsetrotation" is what titleCase would have given.
  repeater: {
    copies: 'Copies', offset: 'Offset', anchorX: 'Anchor X', anchorY: 'Anchor Y',
    offsetX: 'Position X', offsetY: 'Position Y', offsetRotation: 'Rotation',
    offsetScale: 'Scale', offsetOpacity: 'Opacity',
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

function resolvePathOpParam(path: string, nodeId?: string): PropertyMeta | null {
  const m = /^pathop\.([^.]+)\.(.+)$/.exec(path);
  if (!m) return null;
  const [, opId, param] = m;
  if (!opId || !param) return null;

  let type = 'none';
  if (nodeId) {
    const node = defaultSceneGraph.getNode(nodeId);
    const ops = (node?.components.find((c) => c.type === 'fx')?.props as
      | { pathOps?: Array<{ id?: string; type?: string }> }
      | undefined)?.pathOps;
    type = ops?.find((o) => o.id === opId)?.type ?? 'none';
  }
  const label = PATHOP_PARAM_LABEL[type]?.[param] ?? titleCase(param);
  // Trim's three are percentages of path length; `offset` wraps, so the range
  // is deliberately wider than 0..100 — that is how a chase runs past the end.
  const pct = type === 'trim' && PATHOP_PERCENT_PARAMS.has(param);
  // The repeater's rows keep the bounds they had as `rep.*` entries. Spread
  // LAST so they win over the generic defaults below, which is the whole point.
  const rep = type === 'repeater' ? REPEATER_PARAM_META[param] : undefined;
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

/** `<base>_r` / `_g` / `_b` / `_a` — one channel of a decomposed colour track. */
function resolveColorChannel(path: string, nodeId?: string): PropertyMeta | null {
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
  blur: { label: 'Blur', unit: 'px', type: 'number' },
  strokeWidth: { label: 'Stroke Width', unit: 'px', type: 'number' },
};

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
function resolveTextAnimator(path: string, nodeId?: string): PropertyMeta | null {
  const m = /^ta\.(\d+)\.(?:s(\d+)\.)?([A-Za-z][A-Za-z0-9]*)$/.exec(path);
  if (!m) return null;
  const animIndex = Number(m[1]);
  const param = m[3]!;
  const meta = ANIMATOR_PARAM_META[param];

  // A selector index is explicit (`s2`) or implied by a legacy flat param.
  const explicit = m[2] !== undefined ? Number(m[2]) : undefined;
  const selIndex = explicit ?? (LEGACY_SELECTOR_PARAMS.has(param) ? 0 : undefined);

  const animators = nodeId ? readAnimatorsForMeta(nodeId) : [];
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

  const paramLabel = meta?.label ?? titleCase(param);
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
const RESOLVERS: ReadonlyArray<(path: string, nodeId?: string) => PropertyMeta | null> = [
  resolveGroupPlaceholder,
  resolveControl,
  resolveColorChannel,
  resolveTextAnimator,
  resolveEffectParam,
  resolvePathOpParam,
];

// ── Public API ──────────────────────────────────────────────────────

/**
 * Metadata for an animation prop path. ALWAYS returns an entry — an unknown
 * path gets a title-cased label and neutral numeric metadata, which is still
 * strictly better than the raw path a local table would have missed.
 *
 * `nodeId` is optional and only sharpens paths whose meaning depends on the
 * layer (effect params resolve their effect's definition through it).
 */
export function resolvePropertyMeta(path: string, nodeId?: string): PropertyMeta {
  const exact = STATIC[path];
  if (exact) return { path, ...exact };
  for (const r of RESOLVERS) {
    const hit = r(path, nodeId);
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
export function propertyLabel(path: string, nodeId?: string): string {
  return resolvePropertyMeta(path, nodeId).label;
}

/** Unit suffix for a prop path (`''` when unitless). */
export function propertyUnit(path: string, nodeId?: string): string {
  return resolvePropertyMeta(path, nodeId).unit;
}

/** Sort position of a prop path within a layer's property tree. */
export function propertyOrder(path: string, nodeId?: string): number {
  return resolvePropertyMeta(path, nodeId).order;
}

/** True when the registry describes this path explicitly (not via fallback). */
export function hasPropertyMeta(path: string, nodeId?: string): boolean {
  if (STATIC[path]) return true;
  return RESOLVERS.some((r) => r(path, nodeId) !== null);
}

/** Every statically-described path — the registry's own inventory, for tests. */
export function staticPropertyPaths(): string[] {
  return Object.keys(STATIC);
}
