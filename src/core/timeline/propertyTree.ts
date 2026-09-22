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
 * actually animate. A registry entry flagged `keyframeable: false` is the one
 * exception: it gets a value row with no `members`, so the timeline shows it
 * without a stopwatch rather than offering a keyframe the renderer would
 * ignore. A dead stopwatch is worse than an absent one: it reports success and
 * changes nothing. (Material Options were that case until `readNodeMaterial`
 * took the frame's animated values; nothing is today.)
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
import { POSITION_PSEUDO_PROP, defaultAnimation } from '@motion/animation';
import {
  resolvePropertyMeta,
  propertyLabel,
  groupPlaceholderPath,
  hasPropertyMeta,
  GROUP_PLACEHOLDER_PREFIX,
} from '@core/inspector/propertyMeta';
import { getNodeEffects, effectDefFor, effectPropPath, effectOpacityPath, effectHasOpacity } from '@core/effects/effects';
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
import { readNodePolystar, polystarParamSpecs, polystarPropPath } from '@core/scene/polystar';
import { readNodeMask, readNodeMaskAnim, maskPropPath, MASK_PROPERTY_KEYS } from '@core/effects/mask';
import { readNodePaint } from '@core/paint/paintStrokes';
import {
  PAINT_CLONE_KEYS,
  PAINT_TRANSFORM_KEYS,
  paintColorPath,
  paintPathProp,
  paintPropPath,
  strokeDisplayNames,
  type PaintNumericKey,
} from '@core/paint/paintProps';
import {
  readAnimatorData,
  animatorPropPath,
  animatorAxisPropPath,
  selectorPropPath,
  hasTextComponent,
  OPTIONAL_ANIMATOR_PROPERTIES,
  type AnimatorParam,
  type SelectorParam,
} from '@core/text/textAnimators';
import { readTextPathConfig, textPathPropPath, TEXT_PATH_PARAMS } from '@core/text/textPath';
import { readFontAxesProp, axisPropPath } from '@core/text/fontAxes';
import { AUDIO_LEVEL_DB_PROP, AUDIO_PAN_PROP } from '@core/audio/audioParams';
import { gradientGeometryPropsFor } from '@core/inspector/gradientGeometryProps';
import { readNodeStrokes } from '@core/paint/stroke';
import { isIdentityTaper, isIdentityWave } from '@core/scene/strokeProfile';
import { strokeTrackPath, dashParamAt, type StrokeTrackParam } from '@core/rendering/strokeTracks';

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
  | 'camera'
  | 'light'
  | 'geometry'
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
  // AE twirls Camera Options / Light Options right under Transform; a layer
  // only ever has one of the two, so they share the slot in spirit.
  camera: 6,
  light: 7,
  // AE's Geometry Options sits directly above Material Options.
  geometry: 8,
  material: 9,
  audio: 10,
  time: 11,
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
  'ambient', 'diffuse', 'specular', 'shininess', 'metal', 'lightTransmission', 'roughness',
  'acceptsLights', 'castsShadows', 'acceptsShadows',
  'reflectionIntensity', 'reflectionSharpness', 'reflectionRolloff',
  'transparency', 'transparencyRolloff', 'ior',
]);

/** AE Material Options rows for every 3D layer — always listed, even when
 *  Transform still holds only defaults (unstored). Stopwatches need a row. */
function materialRows(node: SceneNode, nodeId: string): StaticPropertyRow[] {
  if (!is3DEnabled(node)) return [];
  // Keep order aligned with MATERIAL_ANIMATABLE / the inspector panel.
  const props = [
    'acceptsLights', 'ambient', 'diffuse', 'specular', 'shininess', 'metal',
    'castsShadows', 'acceptsShadows', 'lightTransmission', 'roughness', 'displacement',
    // Advanced-3D axes, in the inspector's own order: Reflections, Transparency.
    'reflectionIntensity', 'reflectionSharpness', 'reflectionRolloff',
    'transparency', 'transparencyRolloff', 'ior',
  ] as const;
  return props.map((prop) => row(prop, 'material', [prop], { nodeId }));
}

/** The keyframeable Geometry Options — the depths buildSnapshot samples per frame. */
const GEOMETRY_PROPS: ReadonlySet<string> = new Set(['extrusionDepth', 'bevelDepth', 'holeBevelDepth']);

/**
 * AE Geometry Options rows for a 3D layer that can have a body — listed before
 * anything is keyed, so extrusion can be animated from the timeline and not
 * only from the inspector's stopwatches. Hole Bevel Depth only where there are
 * counters to bevel (text and free paths). Cameras, lights and nulls have no
 * geometry.
 */
function geometryRows(node: SceneNode, nodeId: string): StaticPropertyRow[] {
  if (!is3DEnabled(node)) return [];
  const kind = readNodeKind(node);
  if (kind === 'camera' || kind === 'light' || kind === 'null' || kind === 'group' || kind === 'audio') return [];
  const shapeType = node.components.find((c) => c.type === 'Transform')?.props.shapeType;
  const hasHoles = kind === 'text' || (kind === 'shape' && typeof shapeType === 'string' && shapeType !== 'rect' && shapeType !== 'ellipse');
  const props = hasHoles ? ['bevelDepth', 'holeBevelDepth', 'extrusionDepth'] : ['bevelDepth', 'extrusionDepth'];
  return props.map((prop) => row(prop, 'geometry', [prop], { nodeId }));
}

/**
 * The section a path belongs to.
 *
 * Exported because the track model also has to place tracks this tree does not
 * describe — a legacy `effect.<id>` scalar, an expression-control slider, a
 * property from a plugin layer kind. Those still deserve the right heading.
 */
export function groupForProp(prop: string, nodeId?: string): TimelineGroupKey {
  if (prop === MASK_ANIM_PROP || prop.startsWith('mask.')) return 'masks';
  // AE lists Paint as an effect: Effects ▸ Paint ▸ Brush N.
  if (prop.startsWith('paint.')) return 'effects';
  if (prop.startsWith(GROUP_PLACEHOLDER_PREFIX) || prop === POSITION_PSEUDO_PROP) return 'transform';
  if (MATERIAL_PROPS.has(prop)) return 'material';
  if (GEOMETRY_PROPS.has(prop)) return 'geometry';
  if (prop === AUDIO_LEVEL_DB_PROP || prop === AUDIO_PAN_PROP || prop === 'audioLevel') return 'audio';
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
    case 'camera':
      return 'camera';
    case 'light':
      return 'light';
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
        // All of them. This was `slice(0, 2)`, so a 3D layer's — and every
        // camera's — Position row showed X and Y and no Z: the one axis a dolly
        // or a parallax depth is made of could not be read or typed in the
        // timeline. Anchor and Scale already show three.
        valueProps: posMembers,
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
    // Compositing Options -> Effect Opacity, LAST, matching where AE draws the
    // section. Conditional because it is the one row here that is not part of
    // every effect's inventory: listing it unconditionally would add a row to
    // all of a layer's effects the moment the layer had any, for a dial almost
    // none of them are using. Present once touched — and `setEffectOpacity`
    // clears the field at 100, so the row retires when the author is done with
    // it, the same way the field does.
    if (effectHasOpacity(effect)) {
      const path = effectOpacityPath(effect.id);
      out.push(row(path, 'effects', [path], { nodeId }));
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
/**
 * AE's Effects ▸ Paint ▸ Brush N / Eraser N / Clone N — one block per stroke,
 * in document order: Path, Stroke Options (Start, End, Color, Diameter, Angle,
 * Hardness, Roundness, Spacing, Opacity, Flow; Clone Position / Time / Time
 * Shift on clones), then Transform. Colour is absent on erasers and clones,
 * which paint no colour of their own.
 *
 * Path is a `points` DATA track. The timeline's stopwatch keys numeric tracks
 * only, so an un-animated Path row carries no members (label only, no
 * stopwatch that would write a scalar keyframe onto a path); once the Paint
 * panel's Path stopwatch has keyed it, the row names the track and the engine's
 * data row — diamonds, move, delete — merges onto it.
 */
function paintRows(node: SceneNode, nodeId: string): StaticPropertyRow[] {
  const paint = readNodePaint(node);
  if (!paint) return [];
  const names = strokeDisplayNames(paint.strokes);
  const out: StaticPropertyRow[] = [];
  for (const s of paint.strokes) {
    const pathProp = paintPathProp(s.id);
    const pathKeyed = defaultAnimation.isDataAnimated(nodeId, pathProp);
    out.push(row(pathProp, 'effects', pathKeyed ? [pathProp] : [], { nodeId, valueProps: [] }));
    const num = (key: PaintNumericKey): void => {
      const p = paintPropPath(s.id, key);
      out.push(row(p, 'effects', [p], { nodeId }));
    };
    num('start');
    num('end');
    if (s.mode === 'paint') out.push(colorRow(paintColorPath(s.id), 'effects', nodeId, `${names.get(s.id)} Color`));
    for (const key of ['diameter', 'angle', 'hardness', 'roundness', 'spacing', 'opacity', 'flow'] as const) num(key);
    if (s.mode === 'clone') for (const key of PAINT_CLONE_KEYS) num(key);
    for (const key of PAINT_TRANSFORM_KEYS) num(key);
  }
  return out;
}

function maskRows(node: SceneNode, nodeId: string): StaticPropertyRow[] {
  const mask = readNodeMask(node);
  const animated = readNodeMaskAnim(node).length > 0;
  if (!mask && !animated) return [];
  const count = mask?.paths.length ?? 0;
  const out: StaticPropertyRow[] = [
    {
      prop: MASK_ANIM_PROP,
      label: count > 1 ? `Mask Shape (${count} paths)` : 'Mask Shape',
      group: 'masks',
      members: [],
      valueProps: [],
      maskTrack: true,
    },
  ];
  // Then AE's other three mask properties, per path, as ordinary numeric
  // tracks — Feather, Opacity, Expansion — layered over the shape at render.
  for (const p of mask?.paths ?? []) {
    for (const key of MASK_PROPERTY_KEYS) {
      const path = maskPropPath(p.id, key);
      out.push(row(path, 'masks', [path], { nodeId }));
    }
  }
  return out;
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
      // Node-aware: `intensity`/`radius` are properties only on a light, and
      // the resolver that says so needs to see which layer is asking.
      if (!hasPropertyMeta(key, nodeId)) continue;
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

/** The parametric polystar's rows (points, rotation, radii, roundness) —
 *  present only on a layer that IS a polystar, under Contents like the path
 *  operators. One list (`polystarParamSpecs`) feeds this AND the inspector
 *  section, so the two cannot disagree about which parameters exist. */
function polystarRows(node: SceneNode, nodeId: string): StaticPropertyRow[] {
  const ps = readNodePolystar(node);
  if (!ps) return [];
  return polystarParamSpecs(ps.starType).map((spec) => {
    const path = polystarPropPath(spec.param);
    return row(path, 'contents', [path], { nodeId });
  });
}

/**
 * AE's Contents ▸ Stroke N — every ENABLED stroke of a shape's stack, each with
 * its own stopwatches.
 *
 * Rows follow the stroke's STRUCTURE, the way AE's twirl does: Miter Limit only
 * on a miter join, a row per dash slot the pattern actually has (plus Offset),
 * the Taper and Wave rows only once the group does something, the gradient
 * points only on a gradient paint. A row for a parameter the stroke cannot use
 * would be a stopwatch whose keyframes change nothing — the F34 shape.
 *
 * Shape layers only: a text/image stroke is the compiled silhouette outline,
 * which reads width/colour/opacity alone.
 */
function strokeRows(node: SceneNode, nodeId: string): StaticPropertyRow[] {
  if (readNodeKind(node) !== 'shape') return [];
  const out: StaticPropertyRow[] = [];
  readNodeStrokes(node).forEach((s, i) => {
    if (!s.enabled) return;
    const one = (param: StrokeTrackParam): void => {
      const path = strokeTrackPath(i, param);
      out.push(row(path, 'contents', [path], { nodeId }));
    };
    out.push(colorRow(strokeTrackPath(i, 'color'), 'contents', nodeId, i === 0 ? 'Stroke Color' : `Stroke ${i + 1} Color`));
    one('opacity');
    one('width');
    if (s.join === 'miter') one('miterLimit');
    s.dash.forEach((_, k) => {
      const slot = dashParamAt(k);
      if (slot) one(slot);
    });
    if (s.dash.length > 0) one('dashOffset');
    if (!isIdentityTaper(s.taper)) {
      for (const p of ['taperStartLength', 'taperEndLength', 'taperStartWidth', 'taperEndWidth', 'taperStartEase', 'taperEndEase'] as const) one(p);
    }
    if (!isIdentityWave(s.wave)) {
      for (const p of ['waveAmount', 'waveWavelength', 'wavePhase'] as const) one(p);
    }
    if (s.paint && s.paint.type !== 'solid') {
      for (const p of ['gradientStartX', 'gradientStartY', 'gradientEndX', 'gradientEndY'] as const) one(p);
      if (s.paint.type === 'radial') { one('highlightLength'); one('highlightAngle'); }
    }
  });
  return out;
}

/**
 * A shape layer's Path, as ONE row keyed on its whole-path `path.points` track.
 *
 * Like the Mask Shape row: the track holds whole-outline snapshots, so the
 * stopwatch keys the entire path at once (App routes `path.points` to
 * `togglePathAnimation`). Only a layer with a DRAWN outline — a primitive
 * rectangle has no vertices to snapshot until it is converted.
 */
function shapePathRows(node: SceneNode): StaticPropertyRow[] {
  if (readNodeKind(node) !== 'shape') return [];
  const points = node.components.find((c) => c.type === 'Geometry')?.props.points;
  if (!Array.isArray(points) || points.length < 2) return [];
  return [{ prop: 'path.points', label: 'Path', group: 'contents', members: ['path.points'], valueProps: [] }];
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
    const params: AnimatorParam[] = is3D ? [...ANIMATOR_ROWS, ...ANIMATOR_ROWS_3D] : [...ANIMATOR_ROWS];
    // 2-D Blur: the Y row exists once the animator stores its own blurY —
    // the optional-property rule, so an older document's row set is unchanged.
    if (animator.blurY !== undefined) params.splice(params.indexOf('blur') + 1, 0, 'blurY');
    for (const param of params) {
      const path = animatorPropPath(index, param);
      out.push(row(path, 'text', [path], { nodeId }));
    }
    // Optional properties exist on the animator only once added (AE's
    // Add ▸ Property), so they get rows only then.
    const stored = animator as unknown as Record<string, unknown>;
    for (const o of OPTIONAL_ANIMATOR_PROPERTIES) {
      if (stored[o.param] === undefined || (o.param === 'anchorZ' && !is3D)) continue;
      const path = animatorPropPath(index, o.param);
      out.push(row(path, 'text', [path], { nodeId }));
    }
    for (const tag of Object.keys(animator.axes ?? {})) {
      const path = animatorAxisPropPath(index, tag);
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

/**
 * AE's Text group above the animators: variable-font axes (beyond the
 * wght/wdth/slnt props the component scan already lists), Path Options when
 * the layer rides a mask, and More Options' keyframeable Grouping Alignment
 * once the layer has an animator for it to act on.
 */
function textOptionRows(node: SceneNode, nodeId: string): StaticPropertyRow[] {
  if (!hasTextComponent(node)) return [];
  const out: StaticPropertyRow[] = [];
  for (const tag of Object.keys(readFontAxesProp(node))) {
    const path = axisPropPath(tag);
    out.push(row(path, 'text', [path], { nodeId }));
  }
  if (readTextPathConfig(node)) {
    for (const param of TEXT_PATH_PARAMS) {
      const path = textPathPropPath(param);
      out.push(row(path, 'text', [path], { nodeId }));
    }
  }
  if (readAnimatorData(node).length > 0) {
    out.push(row('groupingAlignX', 'text', ['groupingAlignX'], { nodeId }));
    out.push(row('groupingAlignY', 'text', ['groupingAlignY'], { nodeId }));
  }
  return out;
}

// ── Audio ───────────────────────────────────────────────────────────

/**
 * The WAVEFORM row under the Audio group — AE's `LL`.
 *
 * A pseudo-row, like `POSITION_PSEUDO_PROP`: it has no keyframes and no
 * stopwatch, because a waveform is not a property, it is a picture of the
 * source. It exists so the timeline has somewhere to draw the peaks at the
 * layer's own time, under the level it belongs to — the clip bar can show them
 * too, but the bar is also the drag target and cannot be made taller just to
 * read the sound.
 */
export const AUDIO_WAVEFORM_ROW = '__audioWaveform';

/** Audio Levels + Waveform, for anything that makes a sound: an audio layer, or
 *  a video layer carrying its own track. */
function audioRows(node: SceneNode, nodeId: string): StaticPropertyRow[] {
  const kind = readNodeKind(node);
  if (kind !== 'audio' && kind !== 'video') return [];
  return [
    row(AUDIO_LEVEL_DB_PROP, 'audio', [AUDIO_LEVEL_DB_PROP], { nodeId }),
    row(AUDIO_PAN_PROP, 'audio', [AUDIO_PAN_PROP], { nodeId }),
    // Empty `members` is what marks a row unkeyable — the stopwatch is drawn
    // only for rows that name a real animation path, and a waveform names none.
    row(AUDIO_WAVEFORM_ROW, 'audio', [], { nodeId, label: 'Waveform' }),
  ];
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

  const text = [...textOptionRows(node, nodeId), ...textAnimatorRows(node, nodeId)];
  const contents = [
    // A drawn path's Path property first, as AE lists it in the shape group.
    ...shapePathRows(node),
    // The layer's own parametric geometry precedes the operators that deform
    // it — the same top-down order the chain evaluates in.
    ...polystarRows(node, nodeId),
    // Paint, then the operators — AE lists Stroke/Fill beside the path.
    ...strokeRows(node, nodeId),
    ...pathOpRows(node, nodeId),
    // A text layer's gradient geometry — fill, then stroke. Keyframeable
    // scalars whose static value lives inside a paint (gradientGeometryProps).
    ...gradientGeometryPropsFor(node).map((p) => row(p, 'contents', [p], { nodeId })),
  ];
  // A layer with no Transform group has no Transform section either — an audio
  // layer that happens to carry a Style component must not sprout an Opacity
  // row under a heading it does not have.
  const scanned = componentPropRows(node, nodeId, taken).filter(
    (r) => transform.length > 0 || r.group !== 'transform',
  );

  // A camera or a light has no Contents. Its Transform component carries a
  // width/height like every node's, and those fell through `groupOf`'s default
  // into "Contents ▸ Width, Height" — the FIRST thing a twirled-open camera
  // showed, above the Position and Point of Interest the user opened it for.
  const kindOfNode = readNodeKind(node);
  const hasContents = kindOfNode !== 'camera' && kindOfNode !== 'light';

  const rows = [
    ...scanned.filter((r) => r.group === 'text'),
    ...text,
    ...(hasContents ? scanned.filter((r) => r.group === 'contents') : []),
    ...(hasContents ? contents : []),
    ...maskRows(node, nodeId),
    ...effectRows(nodeId),
    ...paintRows(node, nodeId),
    ...scanned.filter((r) => r.group === 'effects'),
    ...transform,
    ...scanned.filter((r) => r.group === 'transform'),
    // Camera Options / Light Options — right under Transform, AE's twirl
    // order. Only the layer's own kind produces props in these groups.
    ...scanned.filter((r) => r.group === 'camera'),
    ...scanned.filter((r) => r.group === 'light'),
    ...layerStyleRows(nodeId),
    ...geometryRows(node, nodeId),
    ...scanned.filter((r) => r.group === 'geometry'),
    ...materialRows(node, nodeId),
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
