/**
 * A layer's PROPERTY TREE — every property the timeline can show beneath it,
 * whether or not anything is keyframed yet.
 *
 * After Effects' timeline is not a list of animations; it is the layer's whole
 * property structure, and animation is something you START from it. Twirl a
 * layer open and Transform, Effects, Masks, Text, Contents, Layer Styles,
 * Material Options and Audio are all there with their stopwatches unlit. This
 * module answers "what is under this layer", so the timeline can be that.
 *
 * Before it, the timeline derived its sub-rows from `tracksFor(node)` — the
 * ANIMATED tracks — plus a hand-written Transform placeholder block. So a Glow's
 * radius simply did not exist in the timeline until it had been keyframed from
 * the inspector, which is backwards: the timeline is where you keyframe.
 *
 * ## What a row promises
 *
 * A row names REAL animation prop paths in `members`, and its stopwatch keys
 * exactly those. Which means a row is only emitted for something the engine can
 * actually animate — with one deliberate exception, Material Options, whose
 * values `readNodeMaterial` reads statically. Those rows carry no `members`, so
 * the timeline shows them with a value and no stopwatch rather than offering a
 * keyframe that the renderer would ignore. A dead stopwatch is worse than an
 * absent one: it reports success and changes nothing.
 *
 * ## What this module does NOT do
 *
 * It never reads keyframes. Rows come back static and ordered; the caller
 * (App's track model) merges the engine's tracks onto them. That split is what
 * lets a collapsed layer skip the whole thing — at 10k layers, building every
 * layer's tree per scene bump is the difference between a timeline and a
 * freeze.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import type { SceneNode } from '@core/types';
import { readNodeKind } from '@core/scene/sceneDerive';
import { is3DEnabled } from '@core/scene/threeD';
import { POSITION_PSEUDO_PROP } from '@motion/animation';
import {
  resolvePropertyMeta,
  propertyLabel,
  groupPlaceholderPath,
  hasPropertyMeta,
  GROUP_PLACEHOLDER_PREFIX,
} from '@core/inspector/propertyMeta';
import { getNodeEffects, effectDefFor, effectPropPath } from '@core/effects/effects';
import {
  getNodeLayerStyles,
  LAYER_STYLE_NUMBER_PARAMS,
  LAYER_STYLE_COLOR_PARAMS,
  LAYER_STYLE_LABEL,
  layerStyleEffectId,
  styleKeyFromEffectId,
  type LayerStyles,
} from '@core/effects/layerStyles';
import { readPathOps, pathOpParamSpecs, pathOpPropPath } from '@core/scene/pathOps';
import { readNodeMask, readNodeMaskAnim } from '@core/effects/mask';
import {
  readAnimatorData,
  animatorPropPath,
  selectorPropPath,
  type AnimatorParam,
  type SelectorParam,
} from '@core/text/textAnimators';
import { AUDIO_LEVEL_DB_PROP } from '@core/audio/audioParams';

/**
 * The sections a layer's properties fall into, in AE's own twirl order.
 *
 * Text and Contents come FIRST because that is where AE puts the thing the
 * layer is; Transform sits below Masks and Effects, which reads wrong until you
 * remember that masks and effects apply before the layer is placed.
 */
export type TimelineGroupKey =
  | 'text'
  | 'contents'
  | 'masks'
  | 'effects'
  | 'transform'
  | 'styles'
  | 'material'
  | 'audio'
  | 'time';

export const TIMELINE_GROUP_ORDER: Readonly<Record<TimelineGroupKey, number>> = {
  text: 0,
  contents: 1,
  masks: 2,
  effects: 3,
  transform: 4,
  styles: 5,
  material: 6,
  audio: 7,
  time: 8,
};

/** The synthetic path of the whole-mask keyframe row (see `maskRow` below). */
export const MASK_ANIM_PROP = '__mask:path';

export interface StaticPropertyRow {
  /** The row's identity: an animation path, or a synthetic placeholder path. */
  prop: string;
  label: string;
  group: TimelineGroupKey;
  /**
   * The real animation paths behind this row. The stopwatch keys all of them
   * at once (AE's Position keys X and Y together), and the row is considered
   * animated when ANY of them is.
   *
   * Empty means the property cannot hold a keyframe — the row is shown for its
   * value alone, with no stopwatch.
   */
  members: ReadonlyArray<string>;
  /**
   * Collapse the members into ONE row even once animated, under this pseudo
   * path. Only Position does this today; every other group splits into its real
   * per-axis rows the moment one of them is keyed, exactly as AE does.
   */
  merged?: string;
  /** Paths the row's value field edits. Empty → the row shows no value. */
  valueProps: ReadonlyArray<string>;
  valueUnit?: string;
  /** Keyframed as a whole-mask track rather than a numeric one. */
  maskTrack?: boolean;
}

// ── Which section does an arbitrary path belong to? ──────────────────

const MATERIAL_PROPS: ReadonlySet<string> = new Set([
  'ambient', 'diffuse', 'specular', 'shininess', 'metal', 'lightTransmission',
]);

/**
 * The section a path belongs to.
 *
 * Exported because the track model also has to place tracks this tree does not
 * describe — a legacy `effect.<id>` scalar, an expression-control slider, a
 * property from a plugin layer kind. Those still deserve the right heading.
 */
export function groupForProp(prop: string, nodeId?: string): TimelineGroupKey {
  if (prop === MASK_ANIM_PROP) return 'masks';
  if (prop.startsWith(GROUP_PLACEHOLDER_PREFIX) || prop === POSITION_PSEUDO_PROP) return 'transform';
  if (MATERIAL_PROPS.has(prop)) return 'material';
  if (prop === AUDIO_LEVEL_DB_PROP || prop === 'audioLevel') return 'audio';
  if (prop.startsWith('effect.')) {
    const id = prop.slice('effect.'.length).split('.')[0] ?? '';
    return styleKeyFromEffectId(id) ? 'styles' : 'effects';
  }
  if (prop.startsWith('pathop.')) return 'contents';
  if (prop.startsWith('ta.')) return 'text';

  switch (resolvePropertyMeta(prop, nodeId).group) {
    case 'transform':
      return 'transform';
    case 'text':
      return 'text';
    case 'time':
      return 'time';
    case 'effects':
    case 'controls':
      return 'effects';
    case 'material':
      return 'material';
    case 'audio':
      return 'audio';
    default:
      // geometry / fill / stroke / trim / repeater / other — the layer's own
      // shape and paint, which is what AE calls Contents.
      return 'contents';
  }
}

// ── Row helpers ─────────────────────────────────────────────────────

function row(
  prop: string,
  group: TimelineGroupKey,
  members: ReadonlyArray<string>,
  opts: { label?: string; nodeId?: string; valueProps?: ReadonlyArray<string>; merged?: string } = {},
): StaticPropertyRow {
  const meta = resolvePropertyMeta(prop, opts.nodeId);
  return {
    prop,
    label: opts.label ?? meta.label,
    group,
    members,
    valueProps: opts.valueProps ?? members,
    ...(meta.unit ? { valueUnit: meta.unit } : {}),
    ...(opts.merged ? { merged: opts.merged } : {}),
  };
}

/** A colour: one row, four channel tracks, no scrubbable single value. */
function colorRow(
  basePath: string,
  group: TimelineGroupKey,
  nodeId: string,
  label?: string,
): StaticPropertyRow {
  return {
    prop: basePath,
    label: label ?? propertyLabel(basePath, nodeId),
    group,
    members: ['_r', '_g', '_b', '_a'].map((s) => `${basePath}${s}`),
    valueProps: [],
  };
}

// ── Transform ───────────────────────────────────────────────────────

/**
 * AE's Transform group, present on every transformable layer whether or not
 * anything is keyed — the reason the timeline can start an animation at all.
 *
 * Cameras take a deliberately different set: no anchor, scale or 2D rotation
 * (a camera has none), but orientation stays, because tripod pan/tilt/roll is
 * the only camera rotation there is and excluding it by association with the
 * others left it unreachable from the timeline.
 */
function transformRows(node: SceneNode, nodeId: string): StaticPropertyRow[] {
  const kind = readNodeKind(node);
  const transform = node.components.find((c) => c.type === 'Transform');
  if (!transform || kind === 'audio') return [];

  const is3D = is3DEnabled(node);
  const isCamera = kind === 'camera';
  const separated = (transform.props as Record<string, unknown>).separateDimensions === true;
  const hasStyle = node.components.some((c) => c.type === 'Style' || c.type === 'Text');
  const out: StaticPropertyRow[] = [];

  const placeholder = (key: string, members: string[], valueProps = members): void => {
    const path = groupPlaceholderPath(key);
    out.push(row(path, 'transform', members, { valueProps }));
  };

  if (!isCamera) {
    placeholder('anchor', is3D ? ['anchorX', 'anchorY', 'anchorZ'] : ['anchorX', 'anchorY']);
  }

  const posMembers = is3D || isCamera ? ['x', 'y', 'z'] : ['x', 'y'];
  if (separated) {
    // AE's "Separate Dimensions": each axis is its own property, with its own
    // stopwatch and its own curve. No merged row, by the user's request.
    for (const p of posMembers) out.push(row(p, 'transform', [p], { nodeId }));
  } else {
    out.push(
      row(groupPlaceholderPath('position'), 'transform', posMembers, {
        valueProps: posMembers.slice(0, 2),
        merged: POSITION_PSEUDO_PROP,
      }),
    );
  }

  if (!isCamera) {
    placeholder('scale', is3D ? ['scaleX', 'scaleY', 'scaleZ'] : ['scaleX', 'scaleY']);
    placeholder('rotation', is3D ? ['rotation', 'rotationX', 'rotationY'] : ['rotation']);
  }
  if (is3D || isCamera) {
    placeholder('orientation', ['orientationX', 'orientationY', 'orientationZ']);
  }
  if (hasStyle && !isCamera) placeholder('opacity', ['opacity']);

  return out;
}

// ── Effects, and layer styles (which compile to effects) ────────────

/**
 * One row per keyframeable parameter of every applied effect.
 *
 * Only `number` and `colour` params appear, because those are the only two the
 * renderer samples from the animation engine (`resolveEffectParams`): a number
 * through its own path, a colour through four decomposed channel tracks. An
 * effect's menus and checkboxes are edited in the Effect Controls panel, where
 * the control matches the value; listing them here with a stopwatch would offer
 * an animation the render path does not read.
 */
function effectRows(nodeId: string): StaticPropertyRow[] {
  const out: StaticPropertyRow[] = [];
  for (const effect of getNodeEffects(nodeId)) {
    const def = effectDefFor(effect.type);
    if (!def) continue;
    for (const param of def.params) {
      const path = effectPropPath(effect.id, param.key);
      if (param.type === 'number') out.push(row(path, 'effects', [path], { nodeId }));
      else if (param.type === 'color') out.push(colorRow(path, 'effects', nodeId));
    }
  }
  return out;
}

/**
 * Layer styles animate exactly like effects — they ARE effects, synthesised per
 * frame — but their parameters are named for the style's own fields and bound
 * to the compiled effect's params by a table. The bindings are the inventory:
 * a field with no binding is not keyframeable and does not get a row.
 */
function layerStyleRows(nodeId: string): StaticPropertyRow[] {
  const styles = getNodeLayerStyles(nodeId) as Record<string, { enabled?: boolean } | undefined>;
  const out: StaticPropertyRow[] = [];

  for (const styleKey of Object.keys(styles)) {
    const style = styles[styleKey];
    if (!style || style.enabled === false) continue;
    const effectId = layerStyleEffectId(styleKey as keyof LayerStyles);
    const label = LAYER_STYLE_LABEL[styleKey] ?? styleKey;

    for (const binding of Object.values(LAYER_STYLE_NUMBER_PARAMS[styleKey] ?? {})) {
      const path = effectPropPath(effectId, binding.param);
      out.push(row(path, 'styles', [path], { nodeId }));
    }
    for (const param of Object.values(LAYER_STYLE_COLOR_PARAMS[styleKey] ?? {})) {
      const path = effectPropPath(effectId, param);
      out.push(colorRow(path, 'styles', nodeId, `${label} ${propertyLabel(path, nodeId).replace(`${label} `, '')}`));
    }
  }
  return out;
}

// ── Masks ───────────────────────────────────────────────────────────

/**
 * The layer's mask shape, as ONE row.
 *
 * Not four (Mask Path / Feather / Opacity / Expansion) and not one per path,
 * because a mask is not keyframed per property here: `setMaskAnim` stores whole
 * mask SNAPSHOTS, so every path and every one of its settings moves on the same
 * keyframe. Drawing four rows off one track would claim four independent curves
 * that do not exist. The row says what the engine actually holds.
 */
function maskRows(node: SceneNode): StaticPropertyRow[] {
  const mask = readNodeMask(node);
  const animated = readNodeMaskAnim(node).length > 0;
  if (!mask && !animated) return [];
  const count = mask?.paths.length ?? 0;
  return [
    {
      prop: MASK_ANIM_PROP,
      label: count > 1 ? `Mask Shape (${count} paths)` : 'Mask Shape',
      group: 'masks',
      members: [],
      valueProps: [],
      maskTrack: true,
    },
  ];
}

// ── Contents: the layer's own geometry, paint and path operators ────

/**
 * Numeric component props the registry describes.
 *
 * Data-driven rather than a per-kind list: a layer's editable geometry and
 * paint ARE its numeric component props, and the registry's static table is the
 * whitelist of which of those are properties rather than internals. A shape
 * layer yields Width/Height/Corner Radius/Stroke Width, a text layer Font Size
 * and Letter Spacing, and neither needs a branch here to say so.
 */
function componentPropRows(
  node: SceneNode,
  nodeId: string,
  taken: ReadonlySet<string>,
): StaticPropertyRow[] {
  const out: StaticPropertyRow[] = [];
  const seen = new Set<string>();
  for (const c of node.components) {
    for (const [key, value] of Object.entries(c.props as Record<string, unknown>)) {
      if (typeof value !== 'number') continue;
      if (key.startsWith('_') || seen.has(key) || taken.has(key)) continue;
      if (!hasPropertyMeta(key)) continue;
      seen.add(key);
      const group = groupForProp(key, nodeId);
      // A property the registry marks `keyframeable: false` is read once by the
      // render path, not sampled per frame — so it gets a value row and NO
      // stopwatch. The registry states it; this does not re-derive it from the
      // group, which would be a second opinion on the same fact.
      const keyable = resolvePropertyMeta(key, nodeId).keyframeable !== false;
      out.push(
        keyable
          ? row(key, group, [key], { nodeId })
          : row(key, group, [], { nodeId, valueProps: [key] }),
      );
    }
  }
  return out;
}

/** One row per parameter of every path operator in the chain. */
function pathOpRows(node: SceneNode, nodeId: string): StaticPropertyRow[] {
  const out: StaticPropertyRow[] = [];
  for (const op of readPathOps(node)) {
    for (const spec of pathOpParamSpecs(op.type)) {
      const path = pathOpPropPath(op.id, spec.param);
      out.push(row(path, 'contents', [path], { nodeId }));
    }
  }
  return out;
}

// ── Text animators ──────────────────────────────────────────────────

/** An animator's own properties, in AE's order. The 3D three appear only on a
 *  3D text layer, where per-character 3D can act on them. */
const ANIMATOR_ROWS: ReadonlyArray<AnimatorParam> = [
  'x', 'y', 'scale', 'scaleY', 'skew', 'rotation', 'opacity', 'fillOpacity',
  'strokeWidth', 'tracking', 'lineSpacing', 'characterOffset', 'blur',
];
const ANIMATOR_ROWS_3D: ReadonlyArray<AnimatorParam> = ['z', 'rotationX', 'rotationY'];

const RANGE_SELECTOR_ROWS: ReadonlyArray<SelectorParam> = [
  'start', 'end', 'offset', 'amount', 'smoothness', 'easeHigh', 'easeLow',
];
const WIGGLY_SELECTOR_ROWS: ReadonlyArray<SelectorParam> = [
  'maxAmount', 'minAmount', 'wigglesPerSecond', 'correlation', 'temporalPhase', 'spatialPhase',
];

function textAnimatorRows(node: SceneNode, nodeId: string): StaticPropertyRow[] {
  const animators = readAnimatorData(node);
  if (animators.length === 0) return [];
  const is3D = is3DEnabled(node);
  const out: StaticPropertyRow[] = [];

  animators.forEach((animator, index) => {
    const params = is3D ? [...ANIMATOR_ROWS, ...ANIMATOR_ROWS_3D] : ANIMATOR_ROWS;
    for (const param of params) {
      const path = animatorPropPath(index, param);
      out.push(row(path, 'text', [path], { nodeId }));
    }
    (animator.selectors ?? []).forEach((selector, selectorIndex) => {
      // An expression selector has no numeric window to key — its shape IS the
      // expression — so it contributes no rows.
      const rows =
        selector.kind === 'wiggly' ? WIGGLY_SELECTOR_ROWS : selector.kind === 'range' ? RANGE_SELECTOR_ROWS : [];
      for (const param of rows) {
        const path = selectorPropPath(index, selectorIndex, param);
        out.push(row(path, 'text', [path], { nodeId }));
      }
    });
  });
  return out;
}

// ── Audio ───────────────────────────────────────────────────────────

/** Audio Levels, for anything that makes a sound: an audio layer, or a video
 *  layer carrying its own track. */
function audioRows(node: SceneNode, nodeId: string): StaticPropertyRow[] {
  const kind = readNodeKind(node);
  if (kind !== 'audio' && kind !== 'video') return [];
  return [row(AUDIO_LEVEL_DB_PROP, 'audio', [AUDIO_LEVEL_DB_PROP], { nodeId })];
}

// ── The tree ────────────────────────────────────────────────────────

/**
 * Every property row this layer has, ordered as AE orders them.
 *
 * Rows are STATIC: no keyframes are read and none are implied. The caller
 * merges the engine's tracks onto `members`, and appends any animated path this
 * tree did not describe (`groupForProp` places those).
 */
export function buildStaticPropertyTree(nodeId: string): StaticPropertyRow[] {
  const node = defaultSceneGraph.getNode(nodeId) as SceneNode | undefined;
  if (!node) return [];

  const transform = transformRows(node, nodeId);
  // Transform owns its axes; the generic component scan must not list `x` a
  // second time under Contents because some component happens to store it.
  const taken = new Set<string>(transform.flatMap((r) => [r.prop, ...r.members]));

  const text = textAnimatorRows(node, nodeId);
  const contents = [...pathOpRows(node, nodeId)];
  // A layer with no Transform group has no Transform section either — an audio
  // layer that happens to carry a Style component must not sprout an Opacity
  // row under a heading it does not have.
  const scanned = componentPropRows(node, nodeId, taken).filter(
    (r) => transform.length > 0 || r.group !== 'transform',
  );

  const rows = [
    ...scanned.filter((r) => r.group === 'text'),
    ...text,
    ...scanned.filter((r) => r.group === 'contents'),
    ...contents,
    ...maskRows(node),
    ...effectRows(nodeId),
    ...scanned.filter((r) => r.group === 'effects'),
    ...transform,
    ...scanned.filter((r) => r.group === 'transform'),
    ...layerStyleRows(nodeId),
    ...scanned.filter((r) => r.group === 'material'),
    ...audioRows(node, nodeId),
    ...scanned.filter((r) => r.group === 'time'),
  ];

  // A path can be described twice — a layer style's colour is both a style row
  // and (through the scan) nothing, but an effect param and a component prop
  // CAN collide on a plugin layer. First description wins: it is the one that
  // knew which section the row belongs in.
  const byProp = new Set<string>();
  return rows.filter((r) => (byProp.has(r.prop) ? false : (byProp.add(r.prop), true)));
}
