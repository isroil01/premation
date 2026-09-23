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
 *                     catalog (props.ts `catalogFor`), so a panel and the engine
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
  type PropertyWrite,
  type Value,
  type ValueType,
} from '@motion/engine-api';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { apiUnitFactor, catalogFor, readStatic, vectorValue, type PropBinding } from './props';
import { readPropertyValue } from '@core/inspector/multiSelection';

// ── Pure path builders ─────────────────────────────────────────────────

/** AE's transform property names (ENGINE_API.md §3.4). */
export type TransformProp =
  | 'anchorPoint' | 'position' | 'scale' | 'rotation' | 'xRotation' | 'yRotation' | 'orientation' | 'opacity';

export type MaskProp = 'path' | 'feather' | 'opacity' | 'expansion' | 'mode' | 'inverted';

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

// ── Today's track names → PropRef (through the engine's catalog) ──────

export interface TrackRef {
  ref: PropRef;
  /** Which member of the property this track is (X of Position → 0); 0 for scalars. */
  member: number;
  /** Every member track of the property, in order. */
  members: readonly string[];
  valueType: ValueType;
  animatable: boolean;
}

function bindingFor(nodeId: string, track: string): PropBinding | null {
  if (!defaultSceneGraph.getNode(nodeId)) return null;
  const cat = catalogFor(nodeId);
  return cat.byMember.get(track) ?? cat.byPath.get(track) ?? null;
}

/**
 * The API property a legacy track name lives in on this layer, or null when
 * the layer has no such property (or the node is gone). Accepts an API path
 * too (returned as is), so callers can pass whichever they hold.
 */
export function propRefForTrack(nodeId: string, track: string): TrackRef | null {
  const b = bindingFor(nodeId, track);
  if (!b) return null;
  const member = Math.max(0, b.members.indexOf(track));
  return {
    ref: { layer: nodeId, path: b.path },
    member,
    members: b.members,
    valueType: b.valueType,
    animatable: b.animatable,
  };
}

/** Just the path (null when the layer has no such property). */
export function pathForTrack(nodeId: string, track: string): string | null {
  return propRefForTrack(nodeId, track)?.ref.path ?? null;
}

/**
 * Component id + prop key (what `updateNodeComponentProp` / `useNodeComponentProp`
 * callers hold) → PropRef. The engine catalog decides first (a key that is a
 * track member: `opacity` on Style, `zoom` on a camera); a key the catalog
 * does not list is addressed by its component's root: Camera → `camera/<k>`,
 * Light → `light/<k>`, Text → `text/<k>`, anything else → `layer/<k>`.
 */
export function propRefForComponentProp(nodeId: string, componentId: string, propKey: string): PropRef | null {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;
  const comp = node.components.find((c) => c.id === componentId);
  if (!comp) return null;
  const b = bindingFor(nodeId, propKey);
  if (b) return { layer: nodeId, path: b.path };
  const type = comp.type.toLowerCase();
  if (propKey === 'content' && type === 'text') return { layer: nodeId, path: paths.sourceText() };
  const safe = propKey.replace(/\//g, '_');
  if (type === 'camera') return { layer: nodeId, path: paths.camera(safe) };
  if (type === 'light') return { layer: nodeId, path: paths.light(safe) };
  if (type === 'text') return { layer: nodeId, path: paths.textProp(safe) };
  return { layer: nodeId, path: paths.layerParam(safe) };
}

/** Comp-time seconds (the UI's playhead) → API time. */
export function compTime(seconds: number): number {
  return secondsToFlicks(seconds);
}

/**
 * "Set member `track` of its property to `n` at comp time `seconds`" as ONE
 * whole-value write — the API writes Position as a vec2, not x then y. The
 * other members keep the value they have at that time (sampled when animated).
 * `time` is always sent: the engine ignores it on a static property and needs
 * it on an animated one (AE setValueAtTime).
 */
export function memberWrite(nodeId: string, track: string, n: number, seconds: number): PropertyWrite | null {
  const r = propRefForTrack(nodeId, track);
  if (!r) return null;
  const time = compTime(seconds);
  // `n` and the sampled members are STORED units; the API speaks After Effects
  // units (C3 parity: scale is %, stored as a multiplier). Convert per member.
  if (r.members.length <= 1) {
    return { prop: r.ref, value: valueOfNumbers(r.valueType, [n * apiUnitFactor(r.members[0])]), time };
  }
  const b = bindingFor(nodeId, track)!;
  // readStatic already returns API units; `n` and readPropertyValue are stored.
  const staticNums = numbersOfValue(readStatic(nodeId, b));
  const nums = r.members.map((m, i) => {
    const f = apiUnitFactor(m);
    if (i === r.member) return n * f;
    const sampled = readPropertyValue(nodeId, m, seconds);
    return sampled !== undefined ? sampled * f : staticNums[i] ?? 0;
  });
  return { prop: r.ref, value: valueOfNumbers(r.valueType, nums), time };
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
