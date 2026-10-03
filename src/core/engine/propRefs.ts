/**
 * Property addressing for UI code (B3): from what a panel holds TODAY — a node
 * id plus a track name (`opacity`, `x`, `effect.fx_1.radius`, `mask.m1.feather`,
 * `ta.0.s1.start`), a component id + prop key, an effect id + param, a mask id,
 * a text animator id, a layer style key — to the API's `PropRef` and `/` paths
 * (ENGINE_API.md §3.4), plus the `Value` constructors a write needs.
 *
 * Two layers:
 *
 *   PATHS (pure)      `paths.effectParam('fx_1', 'radius')` → 'effects/fx_1/radius'.
 *                     For code that already knows WHICH property it edits.
 *   propRefForTrack   node id + today's track name → PropRef, member index and
 *                     value type, resolved through the engine's OWN property
 *                     tree (the document mirror), so a panel and the engine
 *                     can never disagree about what `x` means (merged Position
 *                     vs separated X Position) or which animator `ta.0` is.
 *
 * `memberWrite` turns "set member i of a vector property to n" (the UI's X/Y
 * fields, a colour channel) into a whole-value write, as the API requires.
 *
 * Reading values for DISPLAY stays direct until B4's mirror (see
 * docs/B3_PATTERNS.md) — this module only reads to compose a write.
 */

import {
  propPath,
  secondsToFlicks,
  type PropRef,
  type PropertyInfo,
  type PropertyWrite,
  type Value,
  type ValueType,
} from '@motion/engine-api';
import { apiUnitFactor, vectorValue } from './props';
import { LAYER_FIELDS } from './layerFieldSpecs';
import { PLUGIN_LAYER_COMPONENT_PREFIX } from './pluginProps';
import { documentMirror } from '@stores/documentMirror';
import { trackRefIn, type TrackRef as MirrorTrackRef } from '@core/mirror/trackIndex';
import { parseColorChannels } from '@core/effects/effects';

// ── Pure path builders ─────────────────────────────────────────────────

/** AE's transform property names (ENGINE_API.md §3.4). */
export type TransformProp =
  | 'anchorPoint' | 'position' | 'scale' | 'rotation' | 'xRotation' | 'yRotation' | 'orientation' | 'opacity';

export type MaskProp = 'path' | 'feather' | 'opacity' | 'expansion' | 'mode' | 'inverted' | 'rotoBezier';

export const paths = {
  transform: (p: TransformProp): string => propPath('transform', p),
  /** A separated Position dimension (`Separate Dimensions` on). */
  positionDimension: (dim: 'x' | 'y' | 'z'): string => propPath('transform', 'position', dim),
  effectGroup: (effectId: string): string => propPath('effects', effectId),
  effectParam: (effectId: string, param: string): string => propPath('effects', effectId, param),
  /** AE's Compositing Options › Effect Opacity (not the effect's own `opacity` param). */
  effectOpacity: (effectId: string): string => propPath('effects', effectId, 'compositing', 'opacity'),
  /** Expression controls are effects in the API (`ctrl_<name>` today). */
  expressionControl: (controlId: string, param: string): string => propPath('effects', controlId, param),
  maskGroup: (maskId: string): string => propPath('masks', maskId),
  mask: (maskId: string, p: MaskProp): string => propPath('masks', maskId, p),
  sourceText: (): string => propPath('text', 'sourceText'),
  /** A text-layer property that is not Source Text (`text/fontSize`, …). */
  textProp: (p: string): string => propPath('text', p),
  textAxis: (tag: string): string => propPath('text', 'axes', tag),
  animatorsGroup: (): string => propPath('text', 'animators'),
  animatorGroup: (animatorId: string): string => propPath('text', 'animators', animatorId),
  animatorProp: (animatorId: string, prop: string): string => propPath('text', 'animators', animatorId, 'props', prop),
  selectorGroup: (animatorId: string, selectorId: string): string => propPath('text', 'animators', animatorId, 'selectors', selectorId),
  selectorParam: (animatorId: string, selectorId: string, param: string): string =>
    propPath('text', 'animators', animatorId, 'selectors', selectorId, param),
  styleGroup: (styleKey: string): string => propPath('styles', styleKey),
  /** Layer style param (`styles/dropShadow/distance`); the key is the LayerStyles key. */
  styleParam: (styleKey: string, param: string): string => propPath('styles', styleKey, param),
  contents: (...segments: string[]): string => propPath('contents', ...segments),
  material: (p: string): string => propPath('material', p),
  geometry: (p: string): string => propPath('geometry', p),
  camera: (p: string): string => propPath('camera', p),
  light: (p: string): string => propPath('light', p),
  paintStroke: (strokeId: string): string => propPath('paint', strokeId),
  paintParam: (strokeId: string, p: string): string => propPath('paint', strokeId, p),
  puppetPin: (pinId: string): string => propPath('puppet', pinId),
  puppetParam: (pinId: string, p: string): string => propPath('puppet', pinId, p),
  audioLevels: (): string => propPath('audio', 'levels'),
  audioPan: (): string => propPath('audio', 'pan'),
  timeRemap: (): string => propPath('timeRemap'),
  timeSpeed: (): string => propPath('layer', 'timeSpeed'),
  /** Layer-level params: solid colour, generator/plugin-layer params stored on components. */
  layerParam: (p: string): string => propPath('layer', p),
  pluginParam: (p: string): string => propPath('plugin', p),
} as const;

/** `{ layer, path }` */
export function ref(layer: string, path: string): PropRef {
  return { layer, path };
}

// ── Values ─────────────────────────────────────────────────────────────

export const values = {
  scalar: (value: number): Value => ({ kind: 'scalar', value }),
  bool: (value: boolean): Value => ({ kind: 'bool', value }),
  int: (value: number): Value => ({ kind: 'int', value: Math.round(value) }),
  vec2: (x: number, y: number): Value => ({ kind: 'vec2', value: { x, y } }),
  vec3: (x: number, y: number, z: number): Value => ({ kind: 'vec3', value: { x, y, z } }),
  /** Straight RGBA in the working space, 0..1 (may exceed 1). */
  color: (r: number, g: number, b: number, a = 1): Value => ({ kind: 'color', value: { r, g, b, a } }),
  string: (value: string): Value => ({ kind: 'string', value }),
  /** An enum member BY NAME (effect dropdowns: the option's label). */
  choice: (value: string): Value => ({ kind: 'choice', value }),
  layer: (value: string): Value => ({ kind: 'layer', value }),
  json: (value: unknown): Value => ({ kind: 'json', value: JSON.stringify(value) }),
} as const;

/** The numbers inside a numeric Value, in member order (x,y,z / r,g,b,a). */
export function numbersOfValue(v: Value): number[] {
  switch (v.kind) {
    case 'scalar':
    case 'int': return [v.value];
    case 'vec2': return [v.value.x, v.value.y];
    case 'vec3': return [v.value.x, v.value.y, v.value.z];
    case 'vec4': return [v.value.x, v.value.y, v.value.z, v.value.w];
    case 'color': return [v.value.r, v.value.g, v.value.b, v.value.a];
    case 'bool': return [v.value ? 1 : 0];
    default: return [];
  }
}

/** Build a numeric Value of `type` from members. */
export function valueOfNumbers(type: ValueType, nums: readonly number[]): Value {
  if (type === 'int') return values.int(nums[0] ?? 0);
  if (type === 'bool') return values.bool((nums[0] ?? 0) !== 0);
  return vectorValue(type, [...nums]);
}

// ── Today's track names → PropRef (through the engine's own property tree) ──
//
// Block 3: answered from the DOCUMENT MIRROR's property tree (trackIndex.ts
// `trackRefIn`, pinned against the TypeScript catalog by
// core/mirror/trackIndexParity.test.ts), not from the page replica. Over the
// pipe a layer's tree loads on first ask: a write composed before it landed
// answers null (the caller refuses visibly); `documentMirror().loadTree` is
// the await for code that cannot retry.

export interface TrackRef {
  ref: PropRef;
  /** Which member of the property this track is (X of Position → 0); 0 for scalars. */
  member: number;
  /** Every member track of the property, in order. */
  members: readonly string[];
  valueType: ValueType;
  animatable: boolean;
}

function mirrorRef(nodeId: string, track: string): MirrorTrackRef | null {
  const m = documentMirror();
  if (!m.layer(nodeId)) return null;
  const r = trackRefIn(m.tree(nodeId), track);
  // An API path, or a member of an ANIMATABLE property — as the catalog
  // answered. A static field's name (`noFill`, `fontFamily`, `boxWidth`) is a
  // FIELD, which the field writers address (`fieldBindingForComponentProp`).
  return r && (r.path === track || (r.info.animatable && r.members.includes(track))) ? r : null;
}

/**
 * The API property a legacy track name lives in on this layer, or null when
 * the layer has no such property (or the node is gone). Accepts an API path
 * too (returned as is), so callers can pass whichever they hold.
 */
export function propRefForTrack(nodeId: string, track: string): TrackRef | null {
  const r = mirrorRef(nodeId, track);
  if (!r) return null;
  return {
    ref: { layer: nodeId, path: r.path },
    member: r.member,
    members: r.members.length > 0 ? r.members : [track],
    valueType: r.info.valueType,
    animatable: r.info.animatable,
  };
}

/** Just the path (null when the layer has no such property). */
export function pathForTrack(nodeId: string, track: string): string | null {
  return propRefForTrack(nodeId, track)?.ref.path ?? null;
}

// ── Component refs ─────────────────────────────────────────────────────
//
// The API has no components. An Inspector row that still names one (a
// `useNodeComponentProp`-style row) names it by TYPE: `componentOfType`
// returns a type tag, and the helpers below read it back.

const TYPE_TAG = 'type:';

/** The tag a row hands the write seam for the layer's component of `type` (undefined when the layer is unknown). */
export function componentOfType(nodeId: string, type: string): string | undefined {
  return documentMirror().layer(nodeId) ? `${TYPE_TAG}${type}` : undefined;
}

/** The component type a ref names (a tag from `componentOfType`, or a bare type). */
function componentTypeOf(componentId: string): string {
  return componentId.startsWith(TYPE_TAG) ? componentId.slice(TYPE_TAG.length) : componentId;
}

/** Whether `componentId` is a plugin layer kind's component (its props are `plugin/<key>`, never bare keys). */
export function isPluginLayerComponent(_nodeId: string, componentId: string): boolean {
  return componentTypeOf(componentId).startsWith(PLUGIN_LAYER_COMPONENT_PREFIX);
}

/** The plugin layer kind's component tag of a layer (its props' write target), when it is a custom plugin layer. */
export function pluginLayerComponentOf(nodeId: string): string | undefined {
  const g = documentMirror().layer(nodeId)?.generator;
  return g ? `${TYPE_TAG}${PLUGIN_LAYER_COMPONENT_PREFIX}${g}` : undefined;
}

/**
 * Component id + prop key → PropRef: the property the key names on the layer
 * (the tree decides: a member track, `camera/<k>`, `light/<k>`, `text/<k>`,
 * `layer/<k>`), Source Text for a Text component's `content`.
 */
export function propRefForComponentProp(nodeId: string, componentId: string, propKey: string): PropRef | null {
  const m = documentMirror();
  if (!m.layer(nodeId)) return null;
  const type = componentTypeOf(componentId).toLowerCase();
  if (propKey === 'content' && type === 'text') return { layer: nodeId, path: paths.sourceText() };
  const r = mirrorRef(nodeId, propKey);
  if (r) return { layer: nodeId, path: r.path };
  const safe = propKey.replace(/\//g, '_');
  if (type === 'camera') return { layer: nodeId, path: paths.camera(safe) };
  if (type === 'light') return { layer: nodeId, path: paths.light(safe) };
  if (type === 'text') return { layer: nodeId, path: paths.textProp(safe) };
  return { layer: nodeId, path: paths.layerParam(safe) };
}

// ── Static fields (G1, fields.ts) ──────────────────────────────────────

/** What a field write needs to know about its property (a PropBinding is one). */
export interface FieldTarget {
  path: string;
  valueType: ValueType;
  choices?: string[];
  defaultValue?: Value;
  /** A plugin layer kind's param: a non-numeric one also takes any json. */
  field?: { owner?: string };
}

function targetOf(info: PropertyInfo, plugin: boolean): FieldTarget {
  return {
    path: info.path,
    valueType: info.valueType,
    choices: info.choices,
    ...(info.defaultValue !== undefined ? { defaultValue: info.defaultValue } : {}),
    ...(plugin ? { field: { owner: 'plugin' } } : {}),
  };
}

/**
 * The API FIELD property a component prop is (a Text component's
 * `fontFamily` → `text/fontFamily`, `align` → `text/align`, a layer's own
 * `fill` → `layer/fill`, a light's `lightType` → `light/lightType`), or null
 * when the layer's property tree has none.
 */
export function fieldBindingForComponentProp(nodeId: string, componentId: string, key: string): FieldTarget | null {
  const m = documentMirror();
  if (!m.layer(nodeId)) return null;
  const tree = m.tree(nodeId);
  if (!tree) return null;
  const type = componentTypeOf(componentId);
  const at = (path: string): PropertyInfo | undefined => {
    const n = tree.nodes.get(path);
    return n && n.kind === 'property' ? n : undefined;
  };
  // B3z: a plugin layer kind's prop is `plugin/<key>` (pluginProps.ts) — any binding kind.
  if (type.startsWith(PLUGIN_LAYER_COMPONENT_PREFIX)) {
    const n = at(`plugin/${key}`);
    return n ? targetOf(n, true) : null;
  }
  if (key === 'fill') {
    const n = at('layer/fill');
    return n ? targetOf(n, false) : null;
  }
  if (type === 'Text') {
    const n = at(`text/${key}`);
    // A static field (strings, choices, switches, box / paragraph numbers); an
    // animatable one (Font Size, Tracking) is a track.
    if (n && !n.animatable) return targetOf(n, false);
  }
  // B3z: a LAYER field stored as this component's prop (a light's type, a
  // material's shading model, a primitive's shape…, layerFieldSpecs.ts).
  for (const spec of LAYER_FIELDS) {
    const s = spec.store;
    if (s.fx !== undefined || s.key !== key || s.component === undefined) continue;
    const types = typeof s.component === 'string' ? [s.component] : s.component;
    if (!types.includes(type)) continue;
    const n = at(spec.path);
    if (n) return targetOf(n, false);
  }
  return null;
}

/**
 * A raw UI value (what `updateNodeComponentProp` was handed) as the Value a
 * field binding takes, or null when it cannot be one. `undefined` — the UI's
 * "back to the default" for clear-at-default fields — is the default value.
 */
export function fieldValue(b: Omit<FieldTarget, 'path'>, raw: unknown): Value | null {
  const typed = typedFieldValue(b, raw);
  // A plugin's non-numeric param also takes ANY json value (its arbitrary data:
  // an asset slot going from null to an id) — pluginProps.ts.
  if (!typed && b.field?.owner === 'plugin' && raw !== undefined) return values.json(raw);
  return typed;
}

function typedFieldValue(b: Omit<FieldTarget, 'path'>, raw: unknown): Value | null {
  if (raw === undefined) return b.defaultValue ?? null;
  switch (b.valueType) {
    case 'string': return typeof raw === 'string' ? values.string(raw) : null;
    case 'choice': return typeof raw === 'string' && (b.choices ?? []).includes(raw) ? values.choice(raw) : null;
    case 'bool': return typeof raw === 'boolean' ? values.bool(raw) : null;
    case 'scalar': return typeof raw === 'number' && Number.isFinite(raw) ? values.scalar(raw) : null;
    case 'scalars': return Array.isArray(raw) && raw.every((x) => typeof x === 'number' && Number.isFinite(x)) ? { kind: 'scalars', value: { values: [...raw] as number[] } } : null;
    case 'color': {
      if (typeof raw !== 'string' || !/^#?[0-9a-fA-F]{3,8}$/.test(raw.trim())) return null;
      const [r, g, b2, a] = parseColorChannels(raw);
      return values.color(r, g, b2, a);
    }
    case 'json': return values.json(raw);
    default: return null;
  }
}

/** "Component prop `key` := `raw`" as ONE field write (time = the playhead, for a keyed `layer/fill`), or null. */
export function fieldWrite(nodeId: string, componentId: string, key: string, raw: unknown, seconds: number): PropertyWrite | null {
  const b = fieldBindingForComponentProp(nodeId, componentId, key);
  if (!b) return null;
  const value = fieldValue(b, raw);
  return value ? { prop: { layer: nodeId, path: b.path }, value, time: compTime(seconds) } : null;
}

/** Comp-time seconds (the UI's playhead) → API time. */
export function compTime(seconds: number): number {
  return secondsToFlicks(seconds);
}

/**
 * "Set member `track` of its property to `n` at comp time `seconds`" as ONE
 * whole-value write — the API writes Position as a vec2, not x then y. The
 * other members keep the value they have at that time (the mirror's value at
 * that time, the property's default where it has none). `time` is always
 * sent: the engine ignores it on a static property and needs it on an
 * animated one (AE setValueAtTime).
 */
export function memberWrite(nodeId: string, track: string, n: number, seconds: number): PropertyWrite | null {
  const r = propRefForTrack(nodeId, track);
  if (!r) return null;
  const time = compTime(seconds);
  // `n` is in STORED units; the API speaks After Effects units (scale is %,
  // stored as a multiplier). The mirror's values are API units already.
  if (r.members.length <= 1) {
    return { prop: r.ref, value: valueOfNumbers(r.valueType, [n * apiUnitFactor(r.members[0])]), time };
  }
  const m = documentMirror();
  const current = numbersOfValue(m.valueAt(nodeId, r.ref.path, time) ?? m.property(nodeId, r.ref.path)?.defaultValue ?? values.scalar(0));
  const nums = r.members.map((mem, i) => (i === r.member ? n * apiUnitFactor(mem) : current[i] ?? 0));
  return { prop: r.ref, value: valueOfNumbers(r.valueType, nums), time };
}

/**
 * Several member tracks of ONE layer (`{ 'ta.0.x': 10, 'ta.0.y': 4 }`) as
 * whole-value writes — members of the same property merge into ONE write (two
 * `memberWrite`s of X and Y would each carry the other's OLD value). Null when
 * any track is not a member of an addressed property.
 */
export function memberWrites(nodeId: string, patch: Readonly<Record<string, number>>, seconds: number): PropertyWrite[] | null {
  const byPath = new Map<string, { w: PropertyWrite; type: ValueType }>();
  for (const [track, n] of Object.entries(patch)) {
    if (!Number.isFinite(n)) return null;
    const r = propRefForTrack(nodeId, track);
    if (!r || !r.members.includes(track)) return null;
    const e = byPath.get(r.ref.path);
    if (!e) {
      const w = memberWrite(nodeId, track, n, seconds);
      if (!w) return null;
      byPath.set(r.ref.path, { w, type: r.valueType });
      continue;
    }
    const nums = numbersOfValue(e.w.value);
    nums[r.member] = n * apiUnitFactor(track);
    e.w = { ...e.w, value: valueOfNumbers(e.type, nums) };
  }
  return [...byPath.values()].map((e) => e.w);
}

/** The same scalar written on several layers as ONE `setProperties` command. */
export function scalarWrites(nodeIds: readonly string[], track: string, value: number | ((nodeId: string) => number), seconds: number): PropertyWrite[] {
  const out: PropertyWrite[] = [];
  for (const id of nodeIds) {
    const v = typeof value === 'function' ? value(id) : value;
    if (!Number.isFinite(v)) continue;
    const w = memberWrite(id, track, v, seconds);
    if (w) out.push(w);
  }
  return out;
}
