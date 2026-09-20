/**
 * `AepProject` → an import plan.
 *
 * Pure. No scene, no stores, no DOM — the whole translation from After Effects'
 * conventions to this editor's happens here, which is what makes it testable
 * against fixtures and what keeps `aepApply.ts` down to "do what the plan says".
 *
 * ## The conventions that actually differ
 *
 * Most of AE lines up with this editor: pixels, degrees, seconds, top-left
 * composition origin, y downward, top layer first. Four things do not, and all
 * four are corrected here rather than anywhere else:
 *
 *  • **Anchor point.** AE measures it from the layer's top-left corner; this
 *    editor measures it from the layer's centre. So `ours = theirs − size/2`,
 *    and the same shift applies to mask vertices, which live in that same
 *    centre-origin layer space.
 *
 *  • **Scale.** AE is a percentage, the engine is a multiplier.
 *
 *  • **Stacking.** AE's layer 1 is the TOP layer; this scene graph paints later
 *    siblings over earlier ones. The plan is emitted in AE order and the applier
 *    walks it backwards — the same inversion the Lottie importer makes, for the
 *    same reason.
 *
 *  • **Defaults are absent, not written.** AE omits a property that is both
 *    un-keyframed and at its default, so "no `ADBE Position` in the file" means
 *    "centred in the comp", not "at 0,0". Reading a missing transform as zero
 *    piles every layer into the top-left corner, which is the single most
 *    visible way an AE importer can be wrong.
 */

import type { Keyframe } from '@motion/animation';
import { toKeyframeTrack } from './aepEase';
import { mapEffect, type AeParam } from './aepEffects';
import {
  findGroup,
  findLeaf,
  scalarOf,
  type AepComp,
  type AepFootage,
  type AepLayer,
  type AepProject,
  type AepProperty,
  type AepPropertyGroup,
  type AepTextDocument,
} from './aepModel';

// ── The plan ────────────────────────────────────────────────────────

export type PlannedLayerKind =
  | 'shape'
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'null'
  | 'solid'
  | 'camera'
  | 'light'
  | 'adjustment'
  | 'comp'
  | 'group';

export interface PlannedTrack {
  prop: string;
  keyframes: Keyframe[];
}

export interface PlannedMaskPoint {
  x: number;
  y: number;
  inX: number;
  inY: number;
  outX: number;
  outY: number;
}

export interface PlannedMask {
  name: string;
  mode: string;
  inverted: boolean;
  closed: boolean;
  points: PlannedMaskPoint[];
  feather: number;
  opacity: number;
  expansion: number;
}

export interface PlannedEffect {
  type: string;
  params: Record<string, number | string>;
  tracks: PlannedTrack[];
  /** Added at its own defaults because its parameters are not mapped. */
  defaultsOnly: boolean;
}

export interface PlannedLayer {
  /** Stable within the plan — how parenting and mattes refer to each other. */
  uid: string;
  name: string;
  kind: PlannedLayerKind;
  parentUid?: string;
  /** The source this layer draws, when it has one. */
  source?: { kind: 'footage' | 'comp'; aepId: number };
  staticProps: Record<string, number | string | boolean>;
  tracks: PlannedTrack[];
  timing: { inSec: number; outSec: number; startSec: number; stretch: number };
  flags: {
    enabled: boolean;
    solo: boolean;
    shy: boolean;
    locked: boolean;
    threeD: boolean;
    adjustment: boolean;
    guide: boolean;
    motionBlur: boolean;
    collapse: boolean;
  };
  blendMode: string;
  label: number;
  matte?: { mode: 'alpha' | 'luma'; inverted: boolean; sourceUid?: string };
  masks: PlannedMask[];
  effects: PlannedEffect[];
  text?: AepTextDocument;
  /** Solid colour as `#rrggbb`, for a layer whose source is an AE solid. */
  solidColor?: string;
  /** Expressions that came across as text, for the report. */
  expressions: Array<{ prop: string; source: string }>;
}

export interface PlannedComp {
  aepId: number;
  name: string;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  background: string;
  folder: readonly string[];
  motionBlur: boolean;
  shutterAngle: number;
  shutterPhase: number;
  samplesPerFrame: number;
  workAreaStart: number;
  workAreaEnd: number;
  /** AE order — layer 1 first. The applier reverses it. */
  layers: PlannedLayer[];
}

export interface PlannedFootage {
  aepId: number;
  name: string;
  kind: 'file' | 'solid' | 'placeholder';
  path?: string;
  width: number;
  height: number;
  durationSeconds: number;
  frameRate: number;
  isStill: boolean;
  hasAudio: boolean;
  missingAtSave: boolean;
  solidColor?: string;
  folder: readonly string[];
}

export interface AepImportPlan {
  comps: PlannedComp[];
  footage: PlannedFootage[];
  warnings: string[];
  /** Counts for the post-import report. */
  summary: {
    comps: number;
    layers: number;
    keyframes: number;
    effects: number;
    masks: number;
    expressions: number;
    unmappedEffects: string[];
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

const clamp255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

const hex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((c) => clamp255(c).toString(16).padStart(2, '0')).join('')}`;

/** An AE colour (`[r, g, b, a]` in 0–1) as this editor's `#rrggbb`. */
const colorHex = (rgba: readonly number[] | undefined, fallback = '#000000'): string =>
  rgba && rgba.length >= 3 ? hex(rgba[0]! * 255, rgba[1]! * 255, rgba[2]! * 255) : fallback;

/** A layer's source: a piece of footage or another composition. */
type AepSource = AepFootage | AepComp;

/** AE's layer kinds → the kinds `makeNode` understands. */
function layerKind(layer: AepLayer, source: AepSource | undefined): PlannedLayerKind {
  if (layer.kind === 'camera') return 'camera';
  if (layer.kind === 'light') return 'light';
  if (layer.kind === 'text') return 'text';
  // A shape layer's contents are a vector tree this planner does not walk yet;
  // it lands as a group so its transform, effects and children survive.
  if (layer.kind === 'shape') return 'group';
  if (layer.adjustment) return 'adjustment';
  if (layer.nullLayer) return 'null';
  if (!source) return 'null';
  if (source.kind === 'comp') return 'comp';
  if (source.footageKind === 'solid') return 'solid';
  if (source.width === 0 && source.height === 0 && source.hasAudio) return 'audio';
  return source.isStill ? 'image' : 'video';
}

/** AE's blending-mode label → this editor's mode id. */
const blendModeId = (label: string): string =>
  label
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const MATTE_MODES: Record<string, { mode: 'alpha' | 'luma'; inverted: boolean } | undefined> = {
  alpha: { mode: 'alpha', inverted: false },
  'alpha-inverted': { mode: 'alpha', inverted: true },
  luma: { mode: 'luma', inverted: false },
  'luma-inverted': { mode: 'luma', inverted: true },
};

interface PlanContext {
  comp: AepComp;
  layer: AepLayer;
  /** The layer's own pixel size — its source's, or the comp's. */
  width: number;
  height: number;
  warnings: string[];
  summary: AepImportPlan['summary'];
}

/**
 * Emit a scalar track for one dimension of an AE property, and its static value.
 *
 * A property with keyframes still gets its static value written: the engine
 * samples the track, but the stored prop is what the Inspector shows before
 * anything has been evaluated, and what a non-sampling consumer reads.
 */
function emitScalar(
  group: AepPropertyGroup | undefined,
  matchName: string,
  dim: number,
  prop: string,
  fallback: number,
  transform: (v: number) => number = (v) => v,
): { value: number; track?: PlannedTrack } {
  const source = findLeaf(group, matchName);
  if (!source) return { value: fallback };

  const raw = source.value[dim];
  const value = raw === undefined ? fallback : transform(raw);
  if (source.keyframes.length === 0) return { value };

  // The transform is a scale-and-shift, so it can be handed to the keyframe
  // converter as such rather than mapped over the result — which matters
  // because the converter has to apply the same scale to the tangents.
  const zero = transform(0);
  const one = transform(1);
  const keyframes = toKeyframeTrack(source.keyframes, dim, { scale: one - zero, offset: zero });
  return { value: transform(source.keyframes[0]!.value[dim] ?? raw ?? fallback), track: { prop, keyframes } };
}

/**
 * The layer's transform, as static props plus tracks.
 *
 * AE keeps position as one 3-dimensional property unless the user separated the
 * dimensions, in which case `ADBE Position_0/_1/_2` hold the axes and the
 * combined property is inert. Both forms are read, with the separated one
 * winning when it carries keyframes, because that is the one AE is sampling.
 */
function planTransform(ctx: PlanContext): { props: Record<string, number>; tracks: PlannedTrack[] } {
  const { layer, comp, width, height } = ctx;
  const group = findGroup(layer.properties, 'ADBE Transform Group');
  const props: Record<string, number> = {};
  const tracks: PlannedTrack[] = [];

  /**
   * `fallback` is in THIS EDITOR's units, not AE's — it is what the property
   * becomes when the file does not mention it, and the file not mentioning it
   * is the common case. So Scale's fallback is 1 (a multiplier) and the anchor
   * point's is 0 (already centre-relative), even though AE's own defaults for
   * those are 100 % and half the layer.
   */
  const take = (
    matchName: string,
    dim: number,
    prop: string,
    fallback: number,
    transform?: (v: number) => number,
  ): void => {
    const { value, track } = emitScalar(group, matchName, dim, prop, fallback, transform);
    props[prop] = value;
    if (track) tracks.push(track);
  };

  // Position. A layer AE never moved has no `ADBE Position` at all, and its
  // real position is the comp's centre — not the origin.
  const separated = findLeaf(group, 'ADBE Position_0');
  const useSeparated = (separated?.keyframes.length ?? 0) > 0;
  if (useSeparated) {
    take('ADBE Position_0', 0, 'x', comp.width / 2);
    take('ADBE Position_1', 0, 'y', comp.height / 2);
    take('ADBE Position_2', 0, 'z', 0);
  } else {
    take('ADBE Position', 0, 'x', comp.width / 2);
    take('ADBE Position', 1, 'y', comp.height / 2);
    take('ADBE Position', 2, 'z', 0);
  }

  // Anchor: AE's top-left origin → this editor's centre origin.
  take('ADBE Anchor Point', 0, 'anchorX', 0, (v) => v - width / 2);
  take('ADBE Anchor Point', 1, 'anchorY', 0, (v) => v - height / 2);

  take('ADBE Scale', 0, 'scaleX', 1, (v) => v / 100);
  take('ADBE Scale', 1, 'scaleY', 1, (v) => v / 100);

  take('ADBE Rotate Z', 0, 'rotation', 0);
  take('ADBE Rotate X', 0, 'rotationX', 0);
  take('ADBE Rotate Y', 0, 'rotationY', 0);
  take('ADBE Opacity', 0, 'opacity', 100);

  // Orientation is a resting facing composed before the animatable rotation —
  // the same meaning this editor gives `orientationX/Y/Z`, so it carries over
  // as-is rather than being folded into the rotations (which would be wrong
  // the moment either is keyframed).
  const orientation = findLeaf(group, 'ADBE Orientation');
  if (orientation && orientation.value.some((v) => v !== 0)) {
    props.orientationX = orientation.value[0] ?? 0;
    props.orientationY = orientation.value[1] ?? 0;
    props.orientationZ = orientation.value[2] ?? 0;
  }

  if (!layer.threeD) {
    // A 2-D layer in AE has no depth at all. Leaving a z or an x-rotation on it
    // would make `is3DEnabled` true here and quietly promote the layer.
    delete props.z;
    delete props.rotationX;
    delete props.rotationY;
    return { props, tracks: tracks.filter((t) => !['z', 'rotationX', 'rotationY'].includes(t.prop)) };
  }
  return { props, tracks };
}

/** Masks: AE's layer space (top-left) → ours (centre), handles absolute. */
function planMasks(ctx: PlanContext): PlannedMask[] {
  const { layer, width, height } = ctx;
  const out: PlannedMask[] = [];
  for (const mask of layer.masks) {
    if (!mask.shape || mask.shape.vertices.length === 0) continue;
    const feather = findLeaf(mask.properties, 'ADBE Mask Feather');
    const opacity = findLeaf(mask.properties, 'ADBE Mask Opacity');
    const expansion = findLeaf(mask.properties, 'ADBE Mask Offset');
    out.push({
      name: mask.name,
      mode: mask.mode,
      inverted: mask.inverted,
      closed: mask.shape.closed,
      points: mask.shape.vertices.map((v) => {
        const x = v.x - width / 2;
        const y = v.y - height / 2;
        // AE stores tangents as offsets from the vertex; this editor stores the
        // handle positions themselves.
        return { x, y, inX: x + v.inX, inY: y + v.inY, outX: x + v.outX, outY: y + v.outY };
      }),
      // AE's mask feather is two-dimensional (x and y soften independently);
      // this editor's is one diameter, so the horizontal one stands for both.
      feather: scalarOf(feather, 0),
      // AE's mask opacity is a percentage; the engine's is 0–1.
      opacity: (opacity ? scalarOf(opacity, 100) : 100) / 100,
      expansion: scalarOf(expansion, 0),
    });
    ctx.summary.masks += 1;
  }
  return out;
}

/** Effects, in AE's order — the order they composite in. */
function planEffects(ctx: PlanContext): PlannedEffect[] {
  const parade = findGroup(ctx.layer.properties, 'ADBE Effect Parade');
  if (!parade) return [];
  const out: PlannedEffect[] = [];

  for (const entry of parade.children) {
    if (entry.node !== 'group') continue;
    // The parameters as the reader found them, labels included — that is what
    // the mapping matches on, so it has to travel with the match name.
    const declared: AeParam[] = entry.children
      .filter((c): c is AepProperty => c.node === 'property')
      .map((c) => ({
        matchName: c.matchName,
        ...(c.name ? { label: c.name } : {}),
        ...(c.controlType !== undefined ? { controlType: c.controlType } : {}),
      }));

    const mapped = mapEffect(entry.matchName, declared);
    if (mapped.length === 0) {
      const label = entry.name || entry.matchName;
      if (!ctx.summary.unmappedEffects.includes(label)) ctx.summary.unmappedEffects.push(label);
      continue;
    }
    for (const target of mapped) {
      const params: Record<string, number | string> = {};
      const tracks: PlannedTrack[] = [];

      for (const [key, aeName] of Object.entries(target.params)) {
        const prop = findLeaf(entry, aeName);
        if (!prop) continue;
        if (prop.isColor) {
          params[key] = colorHex(prop.value);
          continue;
        }
        params[key] = prop.value[0] ?? 0;
        if (prop.keyframes.length > 0) tracks.push({ prop: key, keyframes: toKeyframeTrack(prop.keyframes, 0) });
      }

      // A point is one AE parameter and two of ours, so it splits here: the
      // reader has already turned it from a fraction of the layer into pixels.
      for (const { keyX, keyY, from } of Object.values(target.points)) {
        const prop = findLeaf(entry, from);
        if (!prop) continue;
        params[keyX] = prop.value[0] ?? 0;
        params[keyY] = prop.value[1] ?? 0;
        if (prop.keyframes.length > 0) {
          tracks.push({ prop: keyX, keyframes: toKeyframeTrack(prop.keyframes, 0) });
          tracks.push({ prop: keyY, keyframes: toKeyframeTrack(prop.keyframes, 1) });
        }
      }

      out.push({ type: target.type, params, tracks, defaultsOnly: target.defaultsOnly });
      ctx.summary.effects += 1;
    }
  }
  return out;
}

/** Every expression on the layer, for the report. */
function collectExpressions(group: AepPropertyGroup, path: string, out: PlannedLayer['expressions']): void {
  for (const child of group.children) {
    const here = path ? `${path} ▸ ${child.name ?? child.matchName}` : child.name ?? child.matchName;
    if (child.node === 'group') {
      collectExpressions(child, here, out);
    } else if (child.expression) {
      out.push({ prop: here, source: child.expression });
    }
  }
}

function planLayer(
  layer: AepLayer,
  comp: AepComp,
  sources: Map<number, AepSource>,
  warnings: string[],
  summary: AepImportPlan['summary'],
): PlannedLayer {
  const source = sources.get(layer.sourceId);
  const width = source?.width || comp.width;
  const height = source?.height || comp.height;
  const ctx: PlanContext = { comp, layer, width, height, warnings, summary };

  const { props, tracks } = planTransform(ctx);
  const expressions: PlannedLayer['expressions'] = [];
  collectExpressions(layer.properties, '', expressions);
  summary.expressions += expressions.length;

  const textProp = findLeaf(findGroup(layer.properties, 'ADBE Text Properties'), 'ADBE Text Document');
  const text = textProp?.text;
  if (text && text.styleRuns > 1) {
    warnings.push(`"${layer.name}" mixes character styles; the first one was applied to the whole layer`);
  }

  const matte = MATTE_MODES[layer.trackMatte];

  return {
    uid: `${comp.id}:${layer.id}`,
    // A layer AE never renamed carries an empty name and shows its source's.
    name: layer.name || source?.name || `Layer ${layer.index}`,
    kind: layerKind(layer, source),
    ...(layer.parentId ? { parentUid: `${comp.id}:${layer.parentId}` } : {}),
    ...(source ? { source: { kind: source.kind, aepId: source.id } } : {}),
    // Text is NOT folded in here: `content` lives on the layer's Text
    // component and a transform prop by that name is read by nothing. The
    // applier routes `text` to the right component.
    staticProps: props,
    tracks,
    timing: { inSec: layer.inPoint, outSec: layer.outPoint, startSec: layer.startTime, stretch: layer.stretch },
    flags: {
      enabled: layer.enabled,
      solo: layer.solo,
      shy: layer.shy,
      locked: layer.locked,
      threeD: layer.threeD,
      adjustment: layer.adjustment,
      guide: layer.guide,
      motionBlur: layer.motionBlur,
      collapse: layer.collapseTransformation,
    },
    blendMode: blendModeId(layer.blendingMode),
    label: layer.label,
    ...(matte
      ? {
          matte: {
            ...matte,
            // AE 23+ names the matte layer; before that the convention is "the
            // layer directly above", which the applier resolves positionally.
            ...(layer.matteLayerId ? { sourceUid: `${comp.id}:${layer.matteLayerId}` } : {}),
          },
        }
      : {}),
    masks: planMasks(ctx),
    effects: planEffects(ctx),
    ...(text ? { text } : {}),
    ...(source?.kind === 'footage' && source.solidColor
      ? { solidColor: hex(source.solidColor.r * 255, source.solidColor.g * 255, source.solidColor.b * 255) }
      : {}),
    expressions,
  };
}

/**
 * Turn a decoded project into a plan.
 *
 * Every composition comes across, including ones no other comp references —
 * an AE project is a library as much as a timeline, and dropping the unused
 * half would lose work the user can see in their Project panel.
 */
export function planAepImport(project: AepProject): AepImportPlan {
  const warnings = [...project.warnings];
  const summary: AepImportPlan['summary'] = {
    comps: project.comps.length,
    layers: 0,
    keyframes: 0,
    effects: 0,
    masks: 0,
    expressions: 0,
    unmappedEffects: [],
  };

  const sources = new Map<number, AepSource>();
  for (const item of project.items) {
    if (item.kind !== 'folder') sources.set(item.id, item);
  }

  const comps: PlannedComp[] = project.comps.map((comp) => {
    const layers = comp.layers.map((layer) => planLayer(layer, comp, sources, warnings, summary));
    summary.layers += layers.length;
    // Counted from the tracks that survived rather than from every dimension
    // read: a 2-D layer's Position is still stored with three, and the z track
    // is dropped — counting at read time reported keyframes nothing would play.
    for (const layer of layers) {
      for (const track of layer.tracks) summary.keyframes += track.keyframes.length;
      for (const effect of layer.effects) {
        for (const track of effect.tracks) summary.keyframes += track.keyframes.length;
      }
    }
    return {
      aepId: comp.id,
      name: comp.name || 'Composition',
      width: comp.width,
      height: comp.height,
      fps: comp.fps,
      durationSeconds: comp.durationSeconds,
      background: hex(comp.background.r, comp.background.g, comp.background.b),
      folder: comp.folder,
      motionBlur: comp.motionBlur,
      shutterAngle: comp.shutterAngle,
      shutterPhase: comp.shutterPhase,
      samplesPerFrame: comp.motionBlurSamplesPerFrame,
      workAreaStart: comp.workAreaStart,
      // AE's open-ended work area means "to the end of the comp".
      workAreaEnd: Number.isFinite(comp.workAreaEnd) ? comp.workAreaEnd : comp.durationSeconds,
      layers,
    };
  });

  const footage: PlannedFootage[] = project.footage.map((item) => ({
    aepId: item.id,
    name: item.name || 'Footage',
    kind: item.footageKind,
    ...(item.path ? { path: item.path } : {}),
    width: item.width,
    height: item.height,
    durationSeconds: item.durationSeconds,
    frameRate: item.frameRate,
    isStill: item.isStill,
    hasAudio: item.hasAudio,
    missingAtSave: item.missingAtSave,
    ...(item.solidColor
      ? { solidColor: hex(item.solidColor.r * 255, item.solidColor.g * 255, item.solidColor.b * 255) }
      : {}),
    folder: item.folder,
  }));

  if (summary.unmappedEffects.length > 0) {
    warnings.push(
      `${summary.unmappedEffects.length} effect${summary.unmappedEffects.length === 1 ? '' : 's'} had no equivalent here and ` +
        `${summary.unmappedEffects.length === 1 ? 'was' : 'were'} skipped: ${summary.unmappedEffects.join(', ')}`,
    );
  }

  return { comps, footage, warnings, summary };
}
