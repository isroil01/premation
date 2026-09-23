/**
 * FIELD properties (G1): the static, non-numeric (and a few numeric) values a
 * layer carries outside its keyframe tracks, addressed as ordinary API
 * properties — `setProperty` / `resetProperty` / `getPropertyTree` / events /
 * undo work on them like on any other property; they are not animatable.
 *
 *   text/<key>                                      Text component fields (textFields.ts TEXT_FIELDS):
 *                                                   Character / Paragraph / box / More Options / OpenType
 *   text/styleRuns                                  the per-character style runs (json — ENGINE_API.md §14.2)
 *   text/pathOptions/path                           AE Path Options ▸ Path: one of the layer's masks ('' = none)
 *   text/animators/<a>/props/<key>                  animator fields (Tracking Type, Character Range) and the
 *                                                   optional Fill / Stroke Color once added
 *   text/animators/<a>/selectors/<s>/<key>          selector fields (kind, Based On, Mode, Units, Shape,
 *                                                   Randomize Order, Lock Dimensions, Random Seed, expression)
 *   layer/fill                                      the layer's own solid fill colour (keyed through
 *                                                   fill_r/_g/_b/_a) — AE's Solid Color / shape Fill Color
 *   layer/fillPaint, layer/fills, text/strokePaint  paint OBJECTS (solid / linear / radial with stops and
 *                                                   geometry) — json fields (ENGINE_API.md §14.2)
 *   layer/width, layer/height (text layers)         the box a text layer wraps within (Transform width/height)
 *
 * Plus the numeric bindings this block owns: an animator's Blur Y (always
 * addressable: absent = linked to Blur X, read as Blur X) and the registered
 * variable-font axes `text/axes/wght|wdth|slnt` (members fontWeight /
 * fontWidth / fontSlant — their static value is the Text component's, whatever
 * type it is stored as).
 *
 * The C++ engine ports this file (native/engine/src/core/fields.cpp); the
 * field SPECS both read are textFields.ts, generated into the C++ catalog data.
 */

import { defaultAnimation, type NodeAnimSnapshot } from '@motion/animation';
import type { Value, ValueType } from '@motion/engine-api';
import type { SceneNode } from '@core/types';
import {
  readAnimatorData,
  updateAnimator,
  updateSelector,
  animatorPropPath,
  selectorPropPath,
  SELECTOR_PARAMS,
  type TextAnimatorData,
  type SelectorParam,
} from '@core/text/textAnimators';
import {
  TEXT_FIELDS,
  ANIMATOR_FIELDS,
  ANIMATOR_OPTIONAL_FIELDS,
  SELECTOR_FIELDS,
  SELECTOR_KIND_PARAMS,
  strokeOverFillFor,
  type TextFieldSpec,
} from '@core/text/textFields';
import { readTextPathConfig, setTextPath, updateTextPath } from '@core/text/textPath';
import { readNodeMask } from '@core/effects/mask';
import { parseColorChannels, channelsToColor, getNodeEffects, writeNodeEffects } from '@core/effects/effects';
import { resolvePropertyMeta } from '@core/inspector/propertyMeta';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { is3DEnabled } from '@core/scene/threeD';
import { fail } from './errors';
import { hasStrokeHost, readStrokeStack, writeStrokeStack } from './strokeStack';
import { POI_PATH, readPointOfInterest, writePointOfInterest } from './pointOfInterest';
import type { PropBinding } from './props';
import { LAYER_FIELDS, type LayerFieldSpec, type LayerFieldStore } from './layerFieldSpecs';
import { EFFECT_FIELDS, STYLE_FIELDS, type EffectFieldSpec, type StyleFieldSpec } from './effectFieldSpecs';
import { PATHOP_FIELDS, POLYSTAR_FIELDS } from './shapeFieldSpecs';
import { readPathOps, updatePathOp, type PathOp } from '@core/scene/pathOps';
import { readNodePolystar, updateNodePolystar, type Polystar } from '@core/scene/polystar';
import { readPluginField, writePluginField } from './pluginProps';
import { getNodeLayerStyles, setLayerStyles, type LayerStyles } from '@core/effects/layerStyles';

/**
 * `layer`: a LAYER field (B3z, layerFieldSpecs.ts) — `key` is its API path.
 */
export type FieldOwner = 'text' | 'animator' | 'selector' | 'textPath' | 'styleRuns' | 'fillPaint' | 'fills' | 'strokes' | 'poi' | 'layer' | 'effect' | 'style'
  /** B3z (shapeFieldSpecs.ts): a path operator's field (`groupId` = the operator id) / the Polystar's. */
  | 'pathOp' | 'polystar'
  /** B3z (pluginProps.ts): a plugin's non-numeric stored value (`groupId` = the component TYPE, `key` its prop). */
  | 'plugin';

export interface FieldRef {
  owner: FieldOwner;
  /** Storage key on the owner ('' for textPath / styleRuns). */
  key: string;
  animatorId?: string;
  selectorId?: string;
  /** `effect`: the effect id; `style`: the style key (effectFieldSpecs.ts). The C++ port keeps it in `animatorId`. */
  groupId?: string;
}

const HEX = /^#?[0-9a-fA-F]{3,8}$/;

// ── Specs ────────────────────────────────────────────────────────────

export function fieldSpec(f: FieldRef): TextFieldSpec | undefined {
  if (f.owner === 'text') return TEXT_FIELDS.find((s) => s.key === f.key);
  if (f.owner === 'animator') return ANIMATOR_FIELDS.find((s) => s.key === f.key) ?? ANIMATOR_OPTIONAL_FIELDS.find((s) => s.key === f.key);
  if (f.owner === 'selector') return SELECTOR_FIELDS.find((s) => s.key === f.key);
  if (f.owner === 'layer') return layerFieldSpec(f.key) as TextFieldSpec | undefined;
  if (f.owner === 'effect') return EFFECT_FIELDS.find((s) => s.key === f.key) as TextFieldSpec | undefined;
  if (f.owner === 'style') return STYLE_FIELDS.find((s) => s.style === f.groupId && s.key === f.key) as TextFieldSpec | undefined;
  if (f.owner === 'pathOp') return PATHOP_FIELDS.find((s) => s.key === f.key) as TextFieldSpec | undefined;
  if (f.owner === 'polystar') return POLYSTAR_FIELDS.find((s) => s.key === f.key) as TextFieldSpec | undefined;
  return undefined;
}

/** `effects/<id>/<spec.path>` — an applied effect's field (B3z, effectFieldSpecs.ts). */
export function effectFieldBinding(effectId: string, spec: EffectFieldSpec): PropBinding {
  return fieldBinding(`effects/${effectId}/${spec.path}`, spec as TextFieldSpec, { owner: 'effect', key: spec.key, groupId: effectId });
}

/** `styles/<style>/<key>` — a layer-style switch (B3z, effectFieldSpecs.ts). */
export function styleFieldBinding(spec: StyleFieldSpec): PropBinding {
  return fieldBinding(`styles/${spec.style}/${spec.key}`, spec as TextFieldSpec, { owner: 'style', key: spec.key, groupId: spec.style });
}

/** The layer field spec at an API path. */
export function layerFieldSpec(path: string): LayerFieldSpec | undefined {
  return LAYER_FIELDS.find((s) => s.path === path);
}

function valueTypeOf(spec: TextFieldSpec): ValueType {
  return spec.type;
}

function colorValue(hex: string): Value {
  const [r, g, b, a] = parseColorChannels(hex);
  return { kind: 'color', value: { r, g, b, a } };
}

/** A spec default (or a stored raw value) as an API Value of the spec's type. */
function specValue(spec: TextFieldSpec, raw: unknown): Value {
  const v = raw === undefined ? spec.default : raw;
  switch (spec.type) {
    case 'string': return { kind: 'string', value: typeof v === 'string' ? v : String(spec.default) };
    case 'choice': return { kind: 'choice', value: typeof v === 'string' ? v : String(spec.default) };
    case 'bool': return { kind: 'bool', value: typeof v === 'boolean' ? v : spec.default === true };
    case 'scalar': return { kind: 'scalar', value: typeof v === 'number' && Number.isFinite(v) ? v : (spec.default as number) };
    case 'color': return colorValue(typeof v === 'string' && HEX.test(v.trim()) ? v : String(spec.default));
    case 'scalars': return { kind: 'scalars', value: { values: Array.isArray(v) ? (v as unknown[]).filter((x): x is number => typeof x === 'number') : [] } };
    case 'json': return { kind: 'json', value: JSON.stringify(v ?? null) };
    default: return { kind: 'none' };
  }
}

// ── Bindings ─────────────────────────────────────────────────────────

function fieldBinding(path: string, spec: TextFieldSpec, field: FieldRef): PropBinding {
  return {
    path,
    name: spec.label,
    matchName: spec.key,
    valueType: valueTypeOf(spec),
    members: [],
    special: 'field',
    field,
    animatable: false,
    unit: '',
    ...(spec.min !== undefined ? { min: spec.min } : {}),
    ...(spec.max !== undefined ? { max: spec.max } : {}),
    ...(spec.choices ? { choices: [...spec.choices] } : {}),
    defaultValue: specValue(spec, undefined),
  };
}

const LEGACY_AXES: ReadonlyArray<[tag: string, member: string]> = [['wght', 'fontWeight'], ['wdth', 'fontWidth'], ['slnt', 'fontSlant']];

/**
 * Add this block's bindings, in their fixed order (both engines add them in
 * exactly this order — the property tree is compared across engines).
 */
export function addFieldBindings(
  node: SceneNode,
  layerId: string,
  animators: readonly TextAnimatorData[],
  add: (b: PropBinding) => void,
  has: (path: string) => boolean,
): void {
  const text = node.components.find((c) => c.type === 'Text');
  if (text) {
    // The registered axes: one API path each, whatever their static storage.
    for (const [tag, member] of LEGACY_AXES) {
      const path = `text/axes/${tag}`;
      if (has(path)) continue;
      const meta = resolvePropertyMeta(member, layerId);
      add({
        path, name: meta.label, matchName: member, valueType: 'scalar', members: [member], animatable: true, unit: meta.unit ?? '',
        ...(meta.min !== undefined ? { min: meta.min } : {}),
        ...(meta.max !== undefined ? { max: meta.max } : {}),
        ...(typeof meta.defaultValue === 'number' ? { defaultValue: { kind: 'scalar', value: meta.defaultValue } as Value } : {}),
      });
    }
    for (const spec of TEXT_FIELDS) add(fieldBinding(`text/${spec.key}`, spec, { owner: 'text', key: spec.key }));
    add({
      path: 'text/styleRuns', name: 'Character Styles', matchName: 'styleRuns', valueType: 'json', members: [],
      special: 'field', field: { owner: 'styleRuns', key: '' }, animatable: false, unit: '',
      defaultValue: { kind: 'json', value: '[]' },
    });
    add({
      path: 'text/pathOptions/path', name: 'Path', matchName: 'ADBE Text Path', valueType: 'string', members: [],
      special: 'field', field: { owner: 'textPath', key: '' }, animatable: false, unit: '',
      defaultValue: { kind: 'string', value: '' },
    });
    // The layer box a text layer wraps within (the Transform's width / height;
    // a text layer stores none until one is set).
    for (const key of ['width', 'height'] as const) {
      const path = `layer/${key}`;
      if (has(path)) continue;
      const meta = resolvePropertyMeta(key, layerId);
      add({
        path, name: meta.label, matchName: key, valueType: 'scalar', members: [key], animatable: meta.keyframeable !== false, unit: meta.unit ?? '',
        ...(meta.min !== undefined ? { min: meta.min } : {}),
        ...(meta.max !== undefined ? { max: meta.max } : {}),
        ...(typeof meta.defaultValue === 'number' ? { defaultValue: { kind: 'scalar', value: meta.defaultValue } as Value } : {}),
      });
    }
  }
  animators.forEach((a, i) => {
    const base = `text/animators/${a.id}/props`;
    const blurY = `${base}/blurY`;
    if (!has(blurY)) {
      // AE's Blur is 2-D: Y is always there; unset it is linked to (reads as) Blur X.
      const m = animatorPropPath(i, 'blurY');
      const meta = resolvePropertyMeta(m, layerId);
      add({ path: blurY, name: meta.label || 'Blur Y', matchName: m, valueType: 'scalar', members: [m], animatable: true, unit: meta.unit ?? '' });
    }
    for (const spec of ANIMATOR_FIELDS) add(fieldBinding(`${base}/${spec.key}`, spec, { owner: 'animator', key: spec.key, animatorId: a.id }));
    const stored = a as unknown as Record<string, unknown>;
    for (const spec of ANIMATOR_OPTIONAL_FIELDS) {
      if (typeof stored[spec.key] !== 'string') continue;
      add(fieldBinding(`${base}/${spec.key}`, spec, { owner: 'animator', key: spec.key, animatorId: a.id }));
    }
    for (const s of a.selectors ?? []) {
      const sbase = `text/animators/${a.id}/selectors/${s.id}`;
      for (const spec of SELECTOR_FIELDS) {
        if (spec.kinds && !spec.kinds.includes(s.kind)) continue;
        add(fieldBinding(`${sbase}/${spec.key}`, spec, { owner: 'selector', key: spec.key, animatorId: a.id, selectorId: s.id }));
      }
    }
  });
  if (hasPaintHost(node)) {
    // The fill PAINT objects (fx.fill, the fx.fills stack): structured values,
    // json fields (ENGINE_API.md §14.2). A client computes the next paint (a
    // type switch, a stop, a gradient point) and sends it whole.
    add({
      path: 'layer/fillPaint', name: 'Fill Paint', matchName: 'fillPaint', valueType: 'json', members: [],
      special: 'field', field: { owner: 'fillPaint', key: '' }, animatable: false, unit: '', defaultValue: { kind: 'json', value: 'null' },
    });
    add({
      path: 'layer/fills', name: 'Fills', matchName: 'fills', valueType: 'json', members: [],
      special: 'field', field: { owner: 'fills', key: '' }, animatable: false, unit: '', defaultValue: { kind: 'json', value: '[]' },
    });
  }
  if (hasStrokeHost(node, hasPaintHost(node))) {
    // B3z: the shape STROKE stack (fx.stroke / fx.strokes) — strokeStack.ts.
    add({
      path: 'layer/strokes', name: 'Strokes', matchName: 'strokes', valueType: 'json', members: [],
      special: 'field', field: { owner: 'strokes', key: '' }, animatable: false, unit: '', defaultValue: { kind: 'json', value: '[]' },
    });
  }
  const kind = readNodeKind(node);
  if ((kind === 'camera' || kind === 'light') && node.components.some((c) => c.type === 'Transform')) {
    // B3z: AE's Auto-Orientation ▸ Orient Towards Point of Interest (pointOfInterest.ts).
    add({
      path: POI_PATH, name: 'Orient Towards Point of Interest', matchName: 'orientTowardsPointOfInterest', valueType: 'bool', members: [],
      special: 'field', field: { owner: 'poi', key: '' }, animatable: false, unit: '', defaultValue: { kind: 'bool', value: false },
    });
  }
  if (hasFillColor(node)) {
    add({
      path: 'layer/fill', name: 'Fill Color', matchName: 'ADBE Fill Color', valueType: 'color',
      members: ['fill_r', 'fill_g', 'fill_b', 'fill_a'], colorBase: 'fill', special: 'layerFill', animatable: true, unit: '',
    });
  }
  // B3z: the layer fields (layerFieldSpecs.ts), in table order.
  for (const spec of LAYER_FIELDS) {
    if (has(spec.path) || !layerFieldPresent(node, spec)) continue;
    add(fieldBinding(spec.path, spec as TextFieldSpec, { owner: 'layer', key: spec.path }));
  }
  // B3z: path-operator and Polystar fields (shapeFieldSpecs.ts), operators in chain order.
  for (const op of readPathOps(node)) {
    for (const spec of PATHOP_FIELDS) {
      const path = `contents/${op.id}/${spec.key}`;
      if (!spec.ops.includes(op.type) || has(path)) continue;
      add(fieldBinding(path, spec as TextFieldSpec, { owner: 'pathOp', key: spec.key, groupId: op.id }));
    }
  }
  if (readNodePolystar(node)) {
    for (const spec of POLYSTAR_FIELDS) {
      const path = `contents/polystar/${spec.path}`;
      if (has(path)) continue;
      add(fieldBinding(path, spec as TextFieldSpec, { owner: 'polystar', key: spec.key }));
    }
  }
}

// ── Layer fields (B3z) ───────────────────────────────────────────────

function componentTypes(store: LayerFieldStore): readonly string[] {
  if (store.component === undefined) return [];
  return typeof store.component === 'string' ? [store.component] : store.component;
}

/** The component a store names (the first of its types the layer carries). */
function storeComponent(node: SceneNode, store: LayerFieldStore): SceneNode['components'][number] | undefined {
  for (const t of componentTypes(store)) {
    const c = node.components.find((x) => x.type === t);
    if (c) return c;
  }
  return undefined;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function layerFieldPresent(node: SceneNode, spec: LayerFieldSpec): boolean {
  const w = spec.when;
  if (spec.store.component !== undefined && !storeComponent(node, spec.store)) return false;
  if (spec.store.fx !== undefined && spec.store.key !== undefined && !isPlainObject(fxOf(node)?.[spec.store.fx])) return false;
  if (!w) return true;
  if (w.component !== undefined && !node.components.some((c) => c.type === w.component)) return false;
  if (w.fx !== undefined && fxOf(node)?.[w.fx] === undefined) return false;
  if (w.threeD && !is3DEnabled(node)) return false;
  if (w.kinds || w.notKinds) {
    const kind = readNodeKind(node);
    if (w.kinds && !w.kinds.includes(kind)) return false;
    if (w.notKinds && w.notKinds.includes(kind)) return false;
  }
  return true;
}

function readStored(node: SceneNode, store: LayerFieldStore): unknown {
  if (store.fx !== undefined) {
    const v = fxOf(node)?.[store.fx];
    if (store.key === undefined) return v;
    return isPlainObject(v) ? v[store.key] : undefined;
  }
  return (storeComponent(node, store)?.props as Record<string, unknown> | undefined)?.[store.key!];
}

function writeStored(layerId: string, node: SceneNode, store: LayerFieldStore, raw: unknown, path: string): void {
  if (store.fx !== undefined) {
    if (store.key === undefined) {
      defaultSceneGraph.setFxKey(layerId, store.fx, raw);
      return;
    }
    const cur = fxOf(node)?.[store.fx];
    if (!isPlainObject(cur)) fail('notFound', `layer '${layerId}' has no ${store.fx}`, { layer: layerId, path });
    const next: Record<string, unknown> = { ...cur };
    if (raw === undefined) delete next[store.key];
    else next[store.key] = raw;
    defaultSceneGraph.setFxKey(layerId, store.fx, next);
    return;
  }
  const c = storeComponent(node, store);
  if (!c) fail('notFound', `layer '${layerId}' has no ${componentTypes(store).join(' / ')} component`, { layer: layerId, path });
  defaultSceneGraph.writeProp(layerId, c.id, store.key!, raw);
}

const sameRaw = (stored: unknown, raw: unknown): boolean =>
  (raw === null ? stored === undefined || stored === null : JSON.stringify(stored) === JSON.stringify(raw));

function readLayerField(node: SceneNode, spec: LayerFieldSpec): Value {
  const stored = readStored(node, spec.store);
  if (spec.encode) {
    const hit = spec.encode.find(([, raw]) => sameRaw(stored, raw));
    return specValue(spec as TextFieldSpec, hit ? hit[0] : undefined);
  }
  return specValue(spec as TextFieldSpec, stored === null ? undefined : stored);
}

function writeLayerField(layerId: string, node: SceneNode, b: PropBinding, spec: LayerFieldSpec, value: Value): void {
  let raw = storedValue(b, spec as TextFieldSpec, value);
  if (spec.json && raw !== undefined) {
    const ok = spec.json === 'array' ? Array.isArray(raw) : isPlainObject(raw);
    if (!ok) fail('invalidArgument', `'${b.path}' takes null or a JSON ${spec.json}`, { path: b.path });
  }
  if (spec.encode) {
    const api = raw === undefined ? spec.default : raw;
    const hit = spec.encode.find(([v]) => v === api);
    raw = hit ? (hit[1] === null ? undefined : hit[1]) : raw;
  }
  writeStored(layerId, node, spec.store, raw, b.path);
  if (spec.mirror) writeStored(layerId, node, spec.mirror, raw, b.path);
}

// ── The layer's fill colour ──────────────────────────────────────────

function fxOf(node: SceneNode): Record<string, unknown> | undefined {
  return node.components.find((c) => c.type === 'fx')?.props as Record<string, unknown> | undefined;
}

function paintType(v: unknown): string | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const t = (v as { type?: unknown }).type;
  return t === 'solid' || t === 'linear' || t === 'radial' ? t : undefined;
}

/** A layer that carries a fill: a Style or Text component, or a paint on its fx. */
function hasPaintHost(node: SceneNode): boolean {
  const fx = fxOf(node);
  return node.components.some((c) => c.type === 'Style' || c.type === 'Text') || fx?.fill !== undefined || fx?.fills !== undefined;
}

function parseJsonOrFail(b: PropBinding, text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return fail('invalidArgument', 'invalid json', { path: b.path });
  }
}

/** fill.ts `setNodeFill`: the primary fill; with a stack, its first entry (undefined drops it from the stack). */
export function setPrimaryFill(layerId: string, node: SceneNode, paint: unknown): void {
  const stack = fxOf(node)?.fills;
  const valid = Array.isArray(stack) ? stack.filter((p) => paintType(p) !== undefined) : [];
  if (valid.length > 0) {
    setFillStack(layerId, paint !== undefined ? [paint, ...valid.slice(1)] : valid.slice(1));
    return;
  }
  defaultSceneGraph.setFill(layerId, paint);
}

/** fill.ts `setNodeFills`: the stack (kept only when > 1) and its mirror in the single slot. */
function setFillStack(layerId: string, fills: unknown[]): void {
  defaultSceneGraph.setFills(layerId, fills.length > 1 ? fills : undefined);
  defaultSceneGraph.setFill(layerId, fills[0]);
}

function stringFill(node: SceneNode): { componentId: string; hex: string } | undefined {
  for (const c of node.components) {
    const f = (c.props as Record<string, unknown>).fill;
    if (typeof f === 'string') return { componentId: c.id, hex: f };
  }
  return undefined;
}

/**
 * The layer has ONE fill colour: its paint is solid (`readNodeFill(node)?.type
 * === 'solid'`, fill.ts), or it is a text layer with no paint object (an unset
 * text fill is white — the painter's default).
 */
function hasFillColor(node: SceneNode): boolean {
  const t = paintType(fxOf(node)?.fill);
  if (t) return t === 'solid';
  return stringFill(node) !== undefined || node.components.some((c) => c.type === 'Text');
}

function readLayerFill(node: SceneNode): Value {
  const paint = fxOf(node)?.fill;
  if (paintType(paint) === 'solid') {
    const c = (paint as { color?: unknown }).color;
    return colorValue(typeof c === 'string' ? c : '#ffffff');
  }
  const s = stringFill(node);
  if (s) return colorValue(s.hex);
  const text = node.components.find((c) => c.type === 'Text');
  const legacy = (text?.props as Record<string, unknown> | undefined)?.color;
  return colorValue(typeof legacy === 'string' && HEX.test(legacy.trim()) ? legacy : '#ffffff');
}

function writeLayerFill(layerId: string, node: SceneNode, hex: string): void {
  const fx = fxOf(node);
  const paint = fx?.fill;
  if (paintType(paint) === 'solid') {
    const next = { ...(paint as Record<string, unknown>), color: hex };
    const stack = fx?.fills;
    // A fill stack mirrors its first entry into the single slot (fill.ts setNodeFills).
    if (Array.isArray(stack) && stack.length > 1) defaultSceneGraph.setFills(layerId, [next, ...stack.slice(1)]);
    defaultSceneGraph.setFill(layerId, next);
    return;
  }
  if (paintType(paint)) fail('invalidArgument', `layer '${layerId}' has a gradient fill; its colour is a gradient`, { layer: layerId, path: 'layer/fill' });
  const s = stringFill(node);
  if (s) {
    defaultSceneGraph.writeProp(layerId, s.componentId, 'fill', hex);
    return;
  }
  const text = node.components.find((c) => c.type === 'Text');
  if (!text) fail('notFound', `layer '${layerId}' has no fill`, { layer: layerId, path: 'layer/fill' });
  defaultSceneGraph.writeProp(layerId, text.id, 'fill', hex);
}

// ── Reads ────────────────────────────────────────────────────────────

function locateAnimator(node: SceneNode, f: FieldRef): { data: TextAnimatorData[]; index: number; sel: number } {
  const data = readAnimatorData(node);
  const index = data.findIndex((a) => a.id === f.animatorId);
  const sel = index >= 0 && f.selectorId !== undefined ? (data[index]!.selectors ?? []).findIndex((s) => s.id === f.selectorId) : -1;
  return { data, index, sel };
}

export function readField(node: SceneNode, b: PropBinding): Value {
  if (b.special === 'layerFill') return readLayerFill(node);
  const f = b.field!;
  const text = node.components.find((c) => c.type === 'Text');
  const tp = (text?.props ?? {}) as Record<string, unknown>;
  switch (f.owner) {
    case 'styleRuns':
      return { kind: 'json', value: JSON.stringify(Array.isArray(tp.__runs) ? tp.__runs : []) };
    case 'fillPaint': {
      const paint = fxOf(node)?.fill;
      return { kind: 'json', value: JSON.stringify(paintType(paint) ? paint : null) };
    }
    case 'fills': {
      const stack = fxOf(node)?.fills;
      return { kind: 'json', value: JSON.stringify(Array.isArray(stack) ? stack : []) };
    }
    case 'strokes':
      return readStrokeStack(node);
    case 'poi':
      return readPointOfInterest(node);
    case 'plugin':
      return readPluginField(node, b);
    case 'textPath': {
      const cfg = readTextPathConfig(node);
      if (!cfg) return { kind: 'string', value: '' };
      return { kind: 'string', value: cfg.pathId || (readNodeMask(node)?.paths[0]?.id ?? '') };
    }
    case 'text':
      return specValue(fieldSpec(f)!, tp[f.key]);
    case 'animator': {
      const { data, index } = locateAnimator(node, f);
      return specValue(fieldSpec(f)!, (data[index] as unknown as Record<string, unknown> | undefined)?.[f.key]);
    }
    case 'selector': {
      const { data, index, sel } = locateAnimator(node, f);
      const s = index >= 0 && sel >= 0 ? (data[index]!.selectors![sel] as unknown as Record<string, unknown>) : undefined;
      return specValue(fieldSpec(f)!, s?.[f.key]);
    }
    case 'layer': {
      const spec = layerFieldSpec(f.key);
      return spec ? readLayerField(node, spec) : { kind: 'none' };
    }
    case 'effect': {
      const spec = fieldSpec(f);
      const e = getNodeEffects(node.id).find((x) => x.id === f.groupId) as unknown as Record<string, unknown> | undefined;
      const raw = e?.[f.key];
      return spec ? specValue(spec, typeof raw === 'string' ? raw : undefined) : { kind: 'none' };
    }
    case 'style': {
      const spec = fieldSpec(f);
      const st = (getNodeLayerStyles(node.id) as Record<string, Record<string, unknown> | undefined>)[f.groupId!];
      return spec ? specValue(spec, st?.[f.key]) : { kind: 'none' };
    }
    case 'pathOp': {
      const spec = fieldSpec(f);
      const op = readPathOps(node).find((o) => o.id === f.groupId) as unknown as Record<string, unknown> | undefined;
      return spec ? specValue(spec, op?.[f.key]) : { kind: 'none' };
    }
    case 'polystar': {
      const spec = fieldSpec(f);
      const ps = readNodePolystar(node) as unknown as Record<string, unknown> | null;
      return spec ? specValue(spec, ps?.[f.key]) : { kind: 'none' };
    }
    default:
      return { kind: 'none' };
  }
}

// ── Writes ───────────────────────────────────────────────────────────

/** A value checked against the field's spec, as the raw value to store (undefined = clear). */
function storedValue(b: PropBinding, spec: TextFieldSpec, value: Value): unknown {
  const mismatch = (): never => fail('typeMismatch', `'${b.path}' takes a ${spec.type}, got ${value.kind}`, { path: b.path, detail: JSON.stringify({ expected: spec.type }) });
  let raw: unknown;
  switch (spec.type) {
    case 'string':
      if (value.kind !== 'string') mismatch();
      raw = (value as { value: string }).value;
      break;
    case 'choice': {
      if (value.kind !== 'choice') mismatch();
      const v = (value as { value: string }).value;
      if (!spec.choices!.includes(v)) {
        fail('outOfRange', `'${v}' is not a choice of '${b.path}'`, { path: b.path, detail: JSON.stringify({ choices: spec.choices }) });
      }
      raw = v;
      break;
    }
    case 'bool':
      if (value.kind !== 'bool') mismatch();
      raw = (value as { value: boolean }).value;
      break;
    case 'scalar': {
      if (value.kind !== 'scalar') mismatch();
      const v = (value as { value: number }).value;
      if (!Number.isFinite(v)) fail('invalidArgument', `'${b.path}': value must be finite`, { path: b.path });
      if ((spec.min !== undefined && v < spec.min) || (spec.max !== undefined && v > spec.max)) {
        fail('outOfRange', `'${b.path}': ${v} is outside ${spec.min ?? '-∞'}..${spec.max ?? '∞'}`, { path: b.path });
      }
      raw = v;
      break;
    }
    case 'color': {
      if (value.kind !== 'color') mismatch();
      const c = (value as { value: { r: number; g: number; b: number; a: number } }).value;
      if (![c.r, c.g, c.b, c.a].every(Number.isFinite)) fail('invalidArgument', `'${b.path}': value must be finite`, { path: b.path });
      raw = channelsToColor(c.r, c.g, c.b, c.a);
      break;
    }
    case 'scalars': {
      if (value.kind !== 'scalars') mismatch();
      const xs = (value as { value: { values: number[] } }).value.values;
      if (!xs.every(Number.isFinite)) fail('invalidArgument', `'${b.path}': values must be finite`, { path: b.path });
      raw = [...xs];
      break;
    }
    case 'json': {
      if (value.kind !== 'json') mismatch();
      raw = parseJsonOrFail(b, (value as { value: string }).value);
      if (raw === null) raw = undefined;
      break;
    }
    default:
      mismatch();
  }
  if (spec.clearAtDefault && raw !== undefined && JSON.stringify(raw) === JSON.stringify(spec.default)) return undefined;
  return raw;
}

/** Drop every track, expression and data track of `props` on the layer (a switched selector kind's params). */
export function dropTrackProps(layerId: string, props: ReadonlySet<string>): void {
  const snap = defaultAnimation.snapshotNode(layerId);
  if (!snap) return;
  const keep = <V>(section: Record<string, V>): { out: Record<string, V>; dropped: boolean } => {
    const out: Record<string, V> = {};
    let dropped = false;
    for (const [p, v] of Object.entries(section)) {
      if (props.has(p)) dropped = true;
      else out[p] = v;
    }
    return { out, dropped };
  };
  const t = keep(snap.tracks);
  const e = keep(snap.expressions);
  const d = keep(snap.data);
  if (!t.dropped && !e.dropped && !d.dropped) return;
  const next: NodeAnimSnapshot = { tracks: t.out, expressions: e.out, data: d.out };
  defaultAnimation.restoreNode(layerId, next);
}

export function writeField(layerId: string, node: SceneNode, b: PropBinding, value: Value): void {
  if (b.special === 'layerFill') {
    if (value.kind !== 'color') fail('typeMismatch', `'${b.path}' takes a color, got ${value.kind}`, { path: b.path, detail: JSON.stringify({ expected: 'color' }) });
    const c = value.value;
    if (![c.r, c.g, c.b, c.a].every(Number.isFinite)) fail('invalidArgument', `'${b.path}': value must be finite`, { path: b.path });
    writeLayerFill(layerId, node, channelsToColor(c.r, c.g, c.b, c.a));
    return;
  }
  const f = b.field!;
  const text = node.components.find((c) => c.type === 'Text');
  switch (f.owner) {
    case 'styleRuns': {
      if (value.kind !== 'json') fail('typeMismatch', `'${b.path}' takes json, got ${value.kind}`, { path: b.path, detail: JSON.stringify({ expected: 'json' }) });
      let runs: unknown;
      try { runs = JSON.parse(value.value); } catch { fail('invalidArgument', 'invalid json', { path: b.path }); }
      if (!Array.isArray(runs)) fail('invalidArgument', `'${b.path}' takes a JSON array of runs`, { path: b.path });
      if (!text) fail('notFound', 'not a text layer', { layer: layerId });
      // richText.ts writeRuns: grapheme-indexed from now on.
      defaultSceneGraph.writeProp(layerId, text.id, '__runsIndex', 'grapheme');
      defaultSceneGraph.writeProp(layerId, text.id, '__runs', runs);
      return;
    }
    case 'strokes':
      writeStrokeStack(layerId, node, b.path, value);
      return;
    case 'poi':
      writePointOfInterest(layerId, node, value);
      return;
    case 'plugin':
      writePluginField(layerId, node, b, value);
      return;
    case 'fillPaint':
    case 'fills': {
      if (value.kind !== 'json') fail('typeMismatch', `'${b.path}' takes json, got ${value.kind}`, { path: b.path, detail: JSON.stringify({ expected: 'json' }) });
      const v = parseJsonOrFail(b, value.value);
      if (f.owner === 'fillPaint') {
        if (v !== null && paintType(v) === undefined) fail('invalidArgument', `'${b.path}' takes null or a paint {type: solid | linear | radial}`, { path: b.path });
        setPrimaryFill(layerId, node, v === null ? undefined : v);
        return;
      }
      if (!Array.isArray(v) || !v.every((p) => paintType(p) !== undefined)) {
        fail('invalidArgument', `'${b.path}' takes an array of paints {type: solid | linear | radial}`, { path: b.path });
      }
      setFillStack(layerId, v as unknown[]);
      return;
    }
    case 'textPath': {
      if (value.kind !== 'string') fail('typeMismatch', `'${b.path}' takes a string, got ${value.kind}`, { path: b.path, detail: JSON.stringify({ expected: 'string' }) });
      const id = value.value;
      if (id === '') {
        setTextPath(layerId, null);
        return;
      }
      if (!(readNodeMask(node)?.paths ?? []).some((p) => p.id === id)) {
        fail('notFound', `layer '${layerId}' has no mask '${id}'`, { layer: layerId, path: b.path });
      }
      updateTextPath(layerId, { pathId: id });
      return;
    }
    case 'text': {
      const spec = fieldSpec(f)!;
      const raw = storedValue(b, spec, value);
      if (!text) fail('notFound', 'not a text layer', { layer: layerId });
      defaultSceneGraph.writeProp(layerId, text.id, f.key, raw);
      // The legacy boolean older readers (extrusion trace key, Create Shapes From Text) use.
      if (f.key === 'strokeOrder') defaultSceneGraph.writeProp(layerId, text.id, 'strokeOverFill', strokeOverFillFor(raw as string));
      return;
    }
    case 'animator': {
      const spec = fieldSpec(f)!;
      const raw = storedValue(b, spec, value);
      const { index } = locateAnimator(node, f);
      if (index < 0) fail('notFound', `no animator '${f.animatorId}'`, { layer: layerId, path: b.path });
      updateAnimator(layerId, index, { [f.key]: raw } as Partial<TextAnimatorData>);
      return;
    }
    case 'selector': {
      const spec = fieldSpec(f)!;
      const raw = storedValue(b, spec, value);
      const { data, index, sel } = locateAnimator(node, f);
      if (index < 0 || sel < 0) fail('notFound', `no selector '${f.selectorId}'`, { layer: layerId, path: b.path });
      const cur = data[index]!.selectors![sel]!;
      if (f.key === 'kind') {
        if (raw === cur.kind) return;
        // A kind switch in place keeps the selector's id, Based On, Mode and
        // enable (textAnimators.ts updateSelector); the params the new kind does
        // not have lose their keyframes and expressions with the fields.
        const keepParams = new Set(SELECTOR_KIND_PARAMS[raw as string] ?? []);
        const drop = new Set<string>();
        for (const p of SELECTOR_PARAMS) if (!keepParams.has(p)) drop.add(selectorPropPath(index, sel, p as SelectorParam));
        dropTrackProps(layerId, drop);
      }
      updateSelector(layerId, index, sel, { [f.key]: raw });
      return;
    }
    case 'layer': {
      const spec = layerFieldSpec(f.key);
      if (!spec) fail('unsupported', `'${b.path}' has no writer`, { path: b.path });
      writeLayerField(layerId, node, b, spec, value);
      return;
    }
    case 'effect':
      writeEffectField(layerId, node, b, f, value);
      return;
    case 'style': {
      const spec = fieldSpec(f);
      if (!spec) fail('unsupported', `'${b.path}' has no writer`, { path: b.path });
      const raw = storedValue(b, spec, value);
      const styles = getNodeLayerStyles(layerId) as Record<string, Record<string, unknown> | undefined>;
      const st = styles[f.groupId!];
      if (!st) fail('notFound', `layer '${layerId}' has no ${f.groupId} style`, { layer: layerId, path: b.path });
      setLayerStyles(layerId, { ...styles, [f.groupId!]: { ...st, [f.key]: raw } } as LayerStyles);
      return;
    }
    case 'pathOp': {
      // The chain re-validated whole, as the editor's picker wrote it (pathOps.ts updatePathOp).
      const spec = fieldSpec(f);
      if (!spec) fail('unsupported', `'${b.path}' has no writer`, { path: b.path });
      const raw = storedValue(b, spec, value);
      if (!readPathOps(node).some((o) => o.id === f.groupId)) fail('notFound', `layer '${layerId}' has no path operator '${f.groupId}'`, { layer: layerId, path: b.path });
      updatePathOp(layerId, f.groupId!, { [f.key]: raw } as Partial<PathOp>);
      return;
    }
    case 'polystar': {
      const spec = fieldSpec(f);
      if (!spec) fail('unsupported', `'${b.path}' has no writer`, { path: b.path });
      const raw = storedValue(b, spec, value);
      if (!readNodePolystar(node)) fail('notFound', `layer '${layerId}' has no polystar`, { layer: layerId, path: b.path });
      updateNodePolystar(layerId, { [f.key]: raw } as Partial<Polystar>);
      return;
    }
    default:
      fail('unsupported', `'${b.path}' has no writer`, { path: b.path });
  }
}

// ── Effect fields (B3z) ──────────────────────────────────────────────

const LABEL_HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Effect Mask ('' = whole layer; else one of the layer's mask ids, notFound
 * otherwise) and the label colour ('' = none; else a #rrggbb hex). '' removes
 * the stored key, as setEffectMaskId / setEffectLabelColor did.
 */
function writeEffectField(layerId: string, node: SceneNode, b: PropBinding, f: FieldRef, value: Value): void {
  if (value.kind !== 'string') fail('typeMismatch', `'${b.path}' takes a string, got ${value.kind}`, { path: b.path, detail: JSON.stringify({ expected: 'string' }) });
  const v = value.value;
  const effects = getNodeEffects(layerId);
  if (!effects.some((e) => e.id === f.groupId)) fail('notFound', `layer '${layerId}' has no effect '${f.groupId}'`, { layer: layerId, path: b.path });
  if (v !== '' && f.key === 'maskId' && !(readNodeMask(node)?.paths ?? []).some((p) => p.id === v)) {
    fail('notFound', `layer '${layerId}' has no mask '${v}'`, { layer: layerId, path: b.path });
  }
  if (v !== '' && f.key === 'labelColor' && !LABEL_HEX.test(v)) {
    fail('invalidArgument', `'${b.path}' takes '' or a #rrggbb colour`, { path: b.path });
  }
  writeNodeEffects(layerId, effects.map((e) => {
    if (e.id !== f.groupId) return e;
    const next = { ...e } as unknown as Record<string, unknown>;
    if (v === '') delete next[f.key];
    else next[f.key] = v;
    return next as unknown as typeof e;
  }));
}

/** The fields' storage never takes keys: a field is static by definition. */
export function isFieldBinding(b: PropBinding): boolean {
  return b.special === 'field';
}
