/**
 * The engine vocabulary an author may use — derived, wherever it can be, from
 * the sources that already define it, so the card a model reads and the
 * schema a handler enforces cannot disagree.
 *
 * - Static properties come from the `create_layer` / `update_layer` schemas.
 * - Effects come from the engine catalog (`EFFECT_CATALOG`), filtered to the
 *   types `add_effect` admits.
 * - Text animator fields come from the `text_animator` schema.
 *
 * The animatable property list is the one hand-written part, because the gate
 * it mirrors (`isAnimatableProp`) lives in the app and a package cannot import
 * it. `src/core/ai/author/vocabularyDrift.test.ts` holds the two in step.
 */

import type { JsonSchema } from '@motion/ai-tools';
import { addEffectDef, createLayerDef, textAnimatorDef, updateLayerDef } from '@motion/ai-tools';
import { EFFECT_CATALOG, type CatalogEffect } from '@motion/engine-api';
import { EASES, LAYER_KINDS } from './types';

// ── Static properties ──────────────────────────────────────────────────

/** A static field's constraints, read off the tool schema. */
export interface FieldSpec {
  type: 'number' | 'string' | 'boolean';
  minimum?: number;
  maximum?: number;
  enum?: readonly string[];
  /** Which tool sets it. */
  via: 'create' | 'update';
}

/** Fields that are structure, not static look — handled by name elsewhere. */
const NOT_STATIC = new Set(['id', 'kind', 'name', 'parent', 'shape', 'text', 'nodeId', 'visible', 'locked', 'matte', 'removeMatte']);

function fieldsOf(schema: JsonSchema, via: FieldSpec['via']): Record<string, FieldSpec> {
  const out: Record<string, FieldSpec> = {};
  const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
  for (const [k, p] of Object.entries(props)) {
    if (NOT_STATIC.has(k)) continue;
    const t = p.type === 'integer' ? 'number' : p.type;
    if (t !== 'number' && t !== 'string' && t !== 'boolean') continue;
    out[k] = {
      type: t,
      ...(typeof p.minimum === 'number' ? { minimum: p.minimum } : {}),
      ...(typeof p.maximum === 'number' ? { maximum: p.maximum } : {}),
      ...(Array.isArray(p.enum) ? { enum: p.enum as string[] } : {}),
      via,
    };
  }
  return out;
}

/**
 * Every static property a layer's `props` may carry, with its constraints.
 *
 * `update_layer` wins where both tools take a name (x / y / width / height /
 * fill), because the compiler sends the create-time ones on `create_layer` and
 * that is a placement detail, not a different property.
 */
export const STATIC_FIELDS: Readonly<Record<string, FieldSpec>> = {
  ...fieldsOf(updateLayerDef.inputSchema, 'update'),
  ...fieldsOf(createLayerDef.inputSchema, 'create'),
  // A uniform scale is how people say it; the tool takes the two axes.
  scale: { type: 'number', via: 'update' },
};

/** Fields `create_layer` takes directly (the rest go on one `update_layer`). */
export const CREATE_FIELDS: ReadonlySet<string> = new Set(
  Object.entries(fieldsOf(createLayerDef.inputSchema, 'create')).map(([k]) => k),
);

/** Static fields that hold a colour (palette references resolve here). */
export const COLOUR_FIELDS: ReadonlySet<string> = new Set(['fill', 'stroke']);

// ── Animatable properties ──────────────────────────────────────────────

/**
 * Plain (unprefixed) property paths `set_keyframes` accepts on a layer.
 * Mirrors `isAnimatableProp` in src/core/ai/toolContext.ts — see the header.
 */
export const ANIMATABLE_PROPS: readonly string[] = [
  // transform
  'x', 'y', 'rotation', 'scale', 'scaleX', 'scaleY', 'opacity',
  // 3D (needs threeD: true)
  'z', 'rotationX', 'rotationY',
  // camera layers
  'focalLength', 'orbitYaw', 'orbitPitch', 'orientationX', 'orientationY', 'orientationZ',
  'poiX', 'poiY', 'poiZ', 'dofStrength', 'focusDistance', 'dofAperture',
  // layer extras (SAMPLED_LAYER_PROPS)
  'anchorX', 'anchorY', 'skew', 'skewAxis', 'fillOpacity',
  'strokeWidth', 'strokeOpacity', 'strokeDashOffset', 'letterSpacing',
  // gradient fill geometry (fractions of the layer box)
  'fillAngle', 'fillCenterX', 'fillCenterY', 'fillRadius',
  // parametric polygon / star
  'polystar.points', 'polystar.rotation', 'polystar.outerRadius', 'polystar.innerRadius',
  'polystar.outerRoundness', 'polystar.innerRoundness',
];

export const ANIMATABLE: ReadonlySet<string> = new Set(ANIMATABLE_PROPS);

/** Props that need the layer's 3D switch (cameras excepted). */
export const THREE_D_ONLY: ReadonlySet<string> = new Set(['z', 'rotationX', 'rotationY']);

/** Camera-only props. */
export const CAMERA_ONLY: ReadonlySet<string> = new Set([
  'focalLength', 'orbitYaw', 'orbitPitch', 'orientationX', 'orientationY', 'orientationZ',
  'poiX', 'poiY', 'poiZ', 'dofStrength', 'focusDistance', 'dofAperture',
]);

/**
 * Names a model reaches for that mean a real prop. A REPAIR table: each entry
 * is a spelling of exactly one existing property, never a substitution of a
 * different look.
 */
export const PROP_ALIASES: Readonly<Record<string, string>> = {
  positionX: 'x',
  positionY: 'y',
  positionZ: 'z',
  posX: 'x',
  posY: 'y',
  'position.x': 'x',
  'position.y': 'y',
  'position.z': 'z',
  'transform.x': 'x',
  'transform.y': 'y',
  'scale.x': 'scaleX',
  'scale.y': 'scaleY',
  alpha: 'opacity',
  rotate: 'rotation',
  rotationZ: 'rotation',
  tracking: 'letterSpacing',
  zoom: 'focalLength',
};

// ── Effects ────────────────────────────────────────────────────────────

/** Effect types `add_effect` admits. */
export const AI_EFFECT_TYPES: ReadonlySet<string> = new Set(
  ((addEffectDef.inputSchema.properties as Record<string, JsonSchema>).type!.enum ?? []) as string[],
);

/** The catalog entries an author may use, in catalog order. */
export const AUTHOR_EFFECTS: readonly CatalogEffect[] = EFFECT_CATALOG.filter((e) => AI_EFFECT_TYPES.has(e.type));

const EFFECT_BY_TYPE = new Map(AUTHOR_EFFECTS.map((e) => [e.type, e]));

export function authorEffect(type: string): CatalogEffect | undefined {
  return EFFECT_BY_TYPE.get(type);
}

// ── Text animators, blend modes, path operators ───────────────────────

const TA_STRUCTURAL = new Set(['nodeId', 'index', 'sweep', 'remove', 'basedOn', 'shape', 'color']);

/** Numeric text-animator fields (static, and keyable as `ta.<i>.<field>`). */
export const TEXT_ANIMATOR_FIELDS: readonly string[] = Object.entries(
  (textAnimatorDef.inputSchema.properties ?? {}) as Record<string, JsonSchema>,
)
  .filter(([k, p]) => !TA_STRUCTURAL.has(k) && p.type === 'number')
  .map(([k]) => k);

/** Blend modes `update_layer` takes. */
export const BLEND_MODES: readonly string[] =
  ((updateLayerDef.inputSchema.properties as Record<string, JsonSchema>).blendMode!.enum ?? []) as string[];

export const PATH_OPS: readonly string[] = ['zigzag', 'pucker', 'twist', 'roundCorners', 'offset', 'roughen', 'wiggleTransform'];

// ── The card ───────────────────────────────────────────────────────────

function effectLine(e: CatalogEffect): string {
  const params = e.params
    .filter((p) => p.type === 'number' || p.type === 'color' || p.type === 'checkbox' || p.type === 'enum')
    .map((p) => {
      if (p.type === 'number') {
        const range = p.min !== undefined || p.max !== undefined ? ` ${p.min ?? ''}..${p.max ?? ''}` : '';
        return `${p.key}${range}${p.unit ? p.unit : ''}`;
      }
      if (p.type === 'enum') return `${p.key}:${(p.options ?? []).map((o) => o.label).slice(0, 6).join('|')}`;
      return `${p.key}:${p.type}`;
    });
  return `${e.type} (${e.label}) — ${params.join(', ') || 'no params'}`;
}

function staticLine(): string {
  return Object.entries(STATIC_FIELDS)
    .map(([k, f]) => {
      if (f.enum) return `${k}:${f.enum.join('|')}`;
      const range = f.minimum !== undefined || f.maximum !== undefined ? `${f.minimum ?? ''}..${f.maximum ?? ''}` : '';
      return range ? `${k} ${range}` : k;
    })
    .join(', ');
}

/**
 * The vocabulary as a compact card for a system prompt.
 *
 * One line per effect, with every numeric param's range — the model cannot
 * use what it cannot see, and a guessed param is a dropped param.
 */
export function vocabularyCard(): string {
  return [
    'ENGINE VOCABULARY — use these names exactly.',
    '',
    `Layer kinds: ${LAYER_KINDS.join(', ')}.`,
    '  shape: give `shape` (rect|ellipse|line|star|polygon) and width/height (polygon/star: outerRadius, points, innerRadius, roundness).',
    '  text: give `text`, then type props (fontFamily, fontSize, fontWeight, letterSpacing, lineHeight, align, fill, width for wrapping).',
    '  solid: a filled rectangle; adjustment: effects on it apply to everything below; null: an invisible parent.',
    '  camera: frames 3D layers (focalLength, poi*, orbit*, dof*); light: lights layers that have threeD and acceptsLights (set `light`).',
    '  gradient: full-frame gradient backdrop (set `gradient`: stops, kind linear|radial|corners, angle, centerX/centerY/radius in %).',
    '  image: a generated picture (set `image`: prompt = subject and look, aspect). svg: your own vector (set `svg`: markup).',
    '  video: a generated clip (set `video`: prompt = subject, light and camera with no text, durationSec, aspect, fit contain|cover, model optional) — b-roll or a background plate under authored type.',
    '  particle: a particle emitter with the engine default look — prefer effects (snowfall, rainfall, particle-systems, cc-bubbles) for styled particles.',
    '',
    `Static props (layer.props): ${staticLine()}.`,
    '  Units: opacity 0..100, rotation degrees, scale a multiplier (1 = 100%), x/y the layer centre in comp px, anchorX/anchorY layer px from the centre.',
    '  Colours are hex or $paletteName. z / rotationX / rotationY need threeD: true. Camera props only on camera layers.',
    '',
    `Animatable props (layer.keys): ${ANIMATABLE_PROPS.join(', ')}.`,
    '  Effect params animate under effects[i].keys; trim, repeater, path-op and text-animator params under their own keys.',
    `Easings: ${EASES.join(', ')}. bezier takes [x1,y1,x2,y2]. Ease applies to the segment starting at that key.`,
    `Blend modes: ${BLEND_MODES.join(', ')}.`,
    `Path operators (pathOps[].op): ${PATH_OPS.join(', ')} — amount keyable. trim: start/end/offset %, keyable. repeaters: copies, positionX/Y, rotation, scale, anchorX/Y, startOpacity/endOpacity; copies and offset keyable.`,
    `Text animators: basedOn characters|words|lines, shape square|rampUp|rampDown|triangle|round|smooth, numeric ${TEXT_ANIMATOR_FIELDS.join(', ')}, color; sweep {from,to,fromOffset,toOffset,ease} sweeps the range selector.`,
    'Masks: rectangle|ellipse, mode add|subtract|intersect, width, height, feather, opacity 0..1, expansion, inverted.',
    'Track matte: matte { mode alpha|luma|alpha-inv|luma-inv, source: <layer id> }.',
    'Expressions: expressions { <prop>: "<single JS expression>" } — wiggle(f,a), loopOut("cycle"), time, value, Math.',
    '',
    `Effects (effects[].type, params by key; ${AUTHOR_EFFECTS.length} available):`,
    ...AUTHOR_EFFECTS.map((e) => `  ${effectLine(e)}`),
  ].join('\n');
}
