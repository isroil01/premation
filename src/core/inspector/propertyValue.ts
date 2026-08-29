/**
 * The STATIC (un-keyframed) value behind an animation prop path — read and
 * write, one implementation.
 *
 * Why this exists: a prop path is not always a flat component prop. `opacity`
 * is one, and scanning `node.components` for a number of that name answers it.
 * But `effect.fx_3.radius`, `pathop.op_2.amount`, `ta.0.tracking` and a layer
 * style's `effect.layerstyle:dropShadow.distance` are all STRUCTURED: the value
 * lives inside an array element on some component, keyed by an id the path
 * carries. The component scan finds nothing for those and answers 0.
 *
 * That was survivable while only the inspector edited them — every card knew
 * its own storage. It stopped being survivable when the timeline grew the full
 * property tree: a stopwatch on "Glow Radius" read 0 for a radius of 40 and
 * keyed the layer to black, and a value field on it wrote nowhere at all. The
 * fix belongs here rather than in each surface, for the reason `propertyMeta`
 * gives about metadata: three copies of a rule is three chances to disagree.
 *
 * Scope: NUMBERS only, because that is what a keyframe track holds. Colours
 * animate through their decomposed `_r/_g/_b/_a` channels, which are numbers
 * and resolve here; text, paths and gradients are data tracks and never come
 * through this seam.
 *
 * This does NOT sample animation. `defaultAnimation.sample` is the authority on
 * an ANIMATED value; this is the authority on the value underneath it.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { updateNodeComponentProp } from './InspectorAPI';
import {
  getNodeEffects,
  effectDefFor,
  paramsOf,
  updateEffectParam,
} from '@core/effects/effects';
import {
  LAYER_STYLE_NUMBER_PARAMS,
  LAYER_STYLE_COLOR_PARAMS,
  getNodeLayerStyles,
  setLayerStyles,
  styleKeyFromEffectId,
  styleFieldForParam,
  type LayerStyles,
} from '@core/effects/layerStyles';
import { readPathOps, updatePathOp, type PathOp, type PathOpParam } from '@core/scene/pathOps';
import {
  readAnimatorData,
  updateAnimator,
  updateSelector,
  type TextAnimatorData,
} from '@core/text/textAnimators';
import { resolvePropertyMeta } from './propertyMeta';
import { parseMaskPropPath, getNodeMask, updateMaskPath } from '@core/effects/mask';

/** `#rrggbb` (or `#rgb`) → the normalized channel a colour track carries. */
function channelOf(color: string, suffix: string): number | undefined {
  const hex = color.trim().replace('#', '');
  const full =
    hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex.length >= 6 ? hex.slice(0, 6) : null;
  if (!full) return undefined;
  const i = suffix === '_r' ? 0 : suffix === '_g' ? 2 : suffix === '_b' ? 4 : -1;
  // Alpha is not carried in a `#rrggbb`, and every colour param that has one
  // stores it separately — 100 % is the honest answer, not 0.
  if (i < 0) return 1;
  const v = Number.parseInt(full.slice(i, i + 2), 16);
  return Number.isFinite(v) ? v / 255 : undefined;
}

/** Split a decomposed-colour path into its base and channel suffix. */
function splitChannel(prop: string): { base: string; suffix: string } | null {
  const m = /^(.*)(_r|_g|_b|_a)$/.exec(prop);
  return m ? { base: m[1]!, suffix: m[2]! } : null;
}

// ── Effect params (including layer styles) ──────────────────────────

interface EffectRef {
  effectId: string;
  key: string;
  /** Set when the id names a layer style rather than a stored effect. */
  styleKey: string | null;
}

function parseEffectPath(prop: string): EffectRef | null {
  const m = /^effect\.([^.]+)\.(.+)$/.exec(prop);
  if (!m) return null;
  const effectId = m[1]!;
  return { effectId, key: m[2]!, styleKey: styleKeyFromEffectId(effectId) };
}

/**
 * A layer style stores its own field (`blur`), the renderer samples the
 * compiled effect's param (`softness`), and the two differ by a unit factor.
 * Both directions go through the binding so a keyframe and the slider that
 * created it mean the same number.
 */
function styleBinding(styleKey: string, param: string): { field: string; scale: number } | null {
  const field = styleFieldForParam(styleKey, param);
  if (!field) return null;
  const scale = LAYER_STYLE_NUMBER_PARAMS[styleKey]?.[field]?.scale ?? 1;
  return { field, scale };
}

function readEffectValue(nodeId: string, ref: EffectRef): number | undefined {
  const channel = splitChannel(ref.key);

  if (ref.styleKey) {
    const styles = getNodeLayerStyles(nodeId) as Record<string, Record<string, unknown> | undefined>;
    const style = styles[ref.styleKey];
    if (!style) return undefined;
    if (channel) {
      const field = Object.entries(LAYER_STYLE_COLOR_PARAMS[ref.styleKey] ?? {})
        .find(([, param]) => param === channel.base)?.[0];
      const color = field ? style[field] : undefined;
      return typeof color === 'string' ? channelOf(color, channel.suffix) : undefined;
    }
    const b = styleBinding(ref.styleKey, ref.key);
    if (!b) return undefined;
    const raw = style[b.field];
    return typeof raw === 'number' ? raw * b.scale : undefined;
  }

  const effect = getNodeEffects(nodeId).find((e) => e.id === ref.effectId);
  if (!effect) return undefined;
  const params = paramsOf(effect) as Record<string, unknown>;
  if (channel) {
    const color = params[channel.base];
    return typeof color === 'string' ? channelOf(color, channel.suffix) : undefined;
  }
  const v = params[ref.key];
  if (typeof v === 'number') return v;
  // A checkbox param reads back as the 0/1 a track would hold.
  if (typeof v === 'boolean') return v ? 1 : 0;
  return undefined;
}

function writeEffectValue(nodeId: string, ref: EffectRef, value: number): boolean {
  // Colour CHANNELS are never written to the base: the stored value is a hex
  // string, and rewriting one channel of it from a scrub would quietly rewrite
  // the other three through the round trip. Channels are a keyframe-only view.
  if (splitChannel(ref.key)) return false;

  if (ref.styleKey) {
    const b = styleBinding(ref.styleKey, ref.key);
    if (!b) return false;
    const styles = getNodeLayerStyles(nodeId) as Record<string, Record<string, unknown> | undefined>;
    const style = styles[ref.styleKey];
    if (!style) return false;
    setLayerStyles(nodeId, {
      ...(styles as LayerStyles),
      [ref.styleKey]: { ...style, [b.field]: value / (b.scale || 1) },
    } as LayerStyles);
    return true;
  }

  const effect = getNodeEffects(nodeId).find((e) => e.id === ref.effectId);
  if (!effect) return false;
  const def = effectDefFor(effect.type);
  const param = def?.params.find((p) => p.key === ref.key);
  if (param && param.type !== 'number' && param.type !== 'checkbox' && param.type !== 'enum') return false;
  updateEffectParam(nodeId, ref.effectId, ref.key, param?.type === 'checkbox' ? value !== 0 : value);
  return true;
}

// ── Path operators ──────────────────────────────────────────────────

function parsePathOpPath(prop: string): { opId: string; param: PathOpParam } | null {
  const m = /^pathop\.([^.]+)\.(.+)$/.exec(prop);
  return m ? { opId: m[1]!, param: m[2]! as PathOpParam } : null;
}

// ── Text animators ──────────────────────────────────────────────────

/**
 * `ta.<i>.<param>` — the animator's own property, or `ta.<i>.s<j>.<param>` — a
 * selector's. Selector 0's window params keep the flat spelling (see
 * `selectorPropPath`), so a flat path is a selector param when the animator has
 * no property by that name.
 */
function parseAnimatorPath(
  prop: string,
): { index: number; selector: number | null; param: string } | null {
  const m = /^ta\.(\d+)\.(?:s(\d+)\.)?([A-Za-z][A-Za-z0-9]*)$/.exec(prop);
  if (!m) return null;
  return {
    index: Number(m[1]),
    selector: m[2] !== undefined ? Number(m[2]) : null,
    param: m[3]!,
  };
}

/** Selector-0 params that live under the animator's flat path. */
const FLAT_SELECTOR_PARAM: Record<string, string> = {
  start: 'start',
  end: 'end',
  offset: 'offset',
  wiggleFreq: 'wigglesPerSecond',
};

function animatorSlot(
  data: ReadonlyArray<TextAnimatorData>,
  parsed: { index: number; selector: number | null; param: string },
): { selector: number; param: string } | null {
  const animator = data[parsed.index];
  if (!animator) return null;
  if (parsed.selector !== null) return { selector: parsed.selector, param: parsed.param };
  const flat = FLAT_SELECTOR_PARAM[parsed.param];
  return flat ? { selector: 0, param: flat } : null;
}

// ── The seam ────────────────────────────────────────────────────────

/**
 * The value this property rests at, ignoring animation.
 *
 * `undefined` when the path names nothing on this node — a stale effect id, an
 * animator that was deleted. Callers fall back to the registry default rather
 * than treating that as zero.
 */
export function readStaticPropertyValue(nodeId: string, prop: string): number | undefined {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return undefined;

  const effect = parseEffectPath(prop);
  if (effect) return readEffectValue(nodeId, effect);

  const mk = parseMaskPropPath(prop);
  if (mk) {
    const path = getNodeMask(nodeId).paths.find((p) => p.id === mk.pathId);
    if (!path) return undefined;
    // Opacity is stored 0..1 and animated 0..100, like every other opacity.
    return mk.key === 'opacity' ? path.opacity * 100 : path[mk.key];
  }

  const op = parsePathOpPath(prop);
  if (op) {
    const found = readPathOps(node).find((o) => o.id === op.opId) as
      | (PathOp & Record<string, unknown>)
      | undefined;
    const v = found?.[op.param];
    return typeof v === 'number' ? v : undefined;
  }

  const ta = parseAnimatorPath(prop);
  if (ta) {
    const data = readAnimatorData(node);
    const slot = animatorSlot(data, ta);
    if (slot) {
      const sel = data[ta.index]?.selectors?.[slot.selector] as Record<string, unknown> | undefined;
      const v = sel?.[slot.param];
      return typeof v === 'number' ? v : undefined;
    }
    const v = (data[ta.index] as Record<string, unknown> | undefined)?.[ta.param];
    return typeof v === 'number' ? v : undefined;
  }

  // Flat component prop — the ordinary case, and the one the transform,
  // geometry, fill, stroke and audio-level rows all take.
  for (const c of node.components) {
    const v = (c.props as Record<string, unknown>)[prop];
    if (typeof v === 'number') return v;
  }
  if (prop === 'x') return node.transform.position.x;
  if (prop === 'y') return node.transform.position.y;
  return undefined;
}

/**
 * Write the static value, returning whether anything could take it.
 *
 * False is a real answer, not a failure to report: a colour channel has no
 * writable base, and a path naming a deleted effect has nowhere to land. The
 * caller decides what to do — the timeline simply offers no value field on a
 * row whose base cannot be written.
 */
export function writeStaticPropertyValue(nodeId: string, prop: string, value: number): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return false;

  const effect = parseEffectPath(prop);
  if (effect) return writeEffectValue(nodeId, effect, value);

  const mk = parseMaskPropPath(prop);
  if (mk) {
    if (!getNodeMask(nodeId).paths.some((p) => p.id === mk.pathId)) return false;
    updateMaskPath(nodeId, mk.pathId, { [mk.key]: mk.key === 'opacity' ? value / 100 : value });
    return true;
  }

  const op = parsePathOpPath(prop);
  if (op) {
    if (!readPathOps(node).some((o) => o.id === op.opId)) return false;
    updatePathOp(nodeId, op.opId, { [op.param]: value } as Partial<PathOp>);
    return true;
  }

  const ta = parseAnimatorPath(prop);
  if (ta) {
    const data = readAnimatorData(node);
    if (!data[ta.index]) return false;
    const slot = animatorSlot(data, ta);
    if (slot) updateSelector(nodeId, ta.index, slot.selector, { [slot.param]: value } as never);
    else updateAnimator(nodeId, ta.index, { [ta.param]: value } as Partial<TextAnimatorData>);
    return true;
  }

  const comp = node.components.find((c) => typeof (c.props as Record<string, unknown>)[prop] === 'number');
  if (comp) {
    updateNodeComponentProp(defaultSceneGraph, nodeId, comp.id, prop, value);
    return true;
  }
  return false;
}

/** True when {@link writeStaticPropertyValue} has somewhere to put a value. */
export function canWriteStaticPropertyValue(nodeId: string, prop: string): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return false;

  const effect = parseEffectPath(prop);
  if (effect) {
    if (splitChannel(effect.key)) return false;
    if (effect.styleKey) {
      const styles = getNodeLayerStyles(nodeId) as Record<string, unknown>;
      return styleBinding(effect.styleKey, effect.key) !== null && styles[effect.styleKey] !== undefined;
    }
    const stored = getNodeEffects(nodeId).find((e) => e.id === effect.effectId);
    if (!stored) return false;
    const param = effectDefFor(stored.type)?.params.find((p) => p.key === effect.key);
    return !param || param.type === 'number' || param.type === 'checkbox' || param.type === 'enum';
  }

  const mk = parseMaskPropPath(prop);
  if (mk) return getNodeMask(nodeId).paths.some((p) => p.id === mk.pathId);

  const op = parsePathOpPath(prop);
  if (op) return readPathOps(node).some((o) => o.id === op.opId);

  const ta = parseAnimatorPath(prop);
  if (ta) return readAnimatorData(node)[ta.index] !== undefined;

  if (node.components.some((c) => typeof (c.props as Record<string, unknown>)[prop] === 'number')) return true;
  return prop === 'x' || prop === 'y';
}

/**
 * The number a keyframe should be born holding: the animated value if there is
 * one, else the static value, else what the registry says the property rests
 * at. The last fallback is why a stopwatch on an effect param the node has
 * never stored keys its DEFAULT rather than zero.
 */
export function staticOrDefaultValue(nodeId: string, prop: string): number {
  const v = readStaticPropertyValue(nodeId, prop);
  if (v !== undefined) return v;
  const meta = resolvePropertyMeta(prop, nodeId);
  return typeof meta.defaultValue === 'number' ? meta.defaultValue : 0;
}
