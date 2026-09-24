/**
 * A layer's timeline sub-rows: the static property tree with the document
 * MIRROR's keyframes merged onto it (B4, docs/B4_MIRROR.md).
 *
 * Two authorities meet here and neither is allowed to grow a copy of the other.
 * `buildStaticPropertyTree` says WHAT rows the timeline shows and in what
 * order; the mirror says which properties are keyframed and where (comp-time
 * flicks, engine ids), plus each property's label, unit and whether a value
 * field can write it. This file is the join, and nothing else — no property is
 * invented here that the tree did not name, and no keyframe is drawn that the
 * engine does not hold.
 *
 * ## The one rule worth stating
 *
 * A tree row stands for one or more tracks (`members`). While its property is
 * not keyed the row is a placeholder — one line, `animated: false`, a stopwatch
 * that keys every member at once. The moment the property is keyed the row
 * splits into its per-member rows, each drawing the PROPERTY's keys (the API
 * has one key per time per property, ENGINE_API.md §3.3: a diamond on Scale X
 * IS the Scale key at that time). Position is the exception AE also makes: X
 * and Y stay a single "Position" row, because a position keyframe is one
 * keyframe with two numbers.
 *
 * Called ONLY for expanded layers (their trees are retained). A collapsed layer
 * gets the cheap keyframe summary instead — see `timelineTracks.ts`.
 */

import type { KeyId, NodeId } from '@app-types/common';
import { POSITION_PSEUDO_PROP } from '@motion/animation';
import { flicksToSeconds, type Keyframe, type LayerInfo, type PropertyInfo } from '@motion/engine-api';
import { selectionKeyId, timelineTracksOf } from '@core/mirror/keySelection';
import { mirrorPropertyMeta } from '@core/mirror/metaFacts';
import { trackRefIn, type MirrorTreeLike } from '@core/mirror/trackIndex';
import {
  buildStaticPropertyTree,
  groupForProp,
  MASK_ANIM_PROP,
  type StaticPropertyRow,
} from '@core/timeline/propertyTree';
import { documentMirror } from '@stores/documentMirror';
import type { TimelinePropertyTrack, TimelineKeyframeRef } from './TimelineModel';

/** What the rows are built from: one layer's mirror records. */
export interface PropertyRowSources {
  layer: LayerInfo | undefined;
  tree: MirrorTreeLike | undefined;
  /** Every animated property's keys (path → keys), `DocumentMirror.layerKeyframes`. */
  keys: ReadonlyMap<string, readonly Keyframe[]>;
}

/** The session mirror's records for one layer (loads its tree on demand). */
export function mirrorRowSources(nodeId: string): PropertyRowSources {
  const m = documentMirror();
  return { layer: m.layer(nodeId), tree: m.tree(nodeId), keys: m.layerKeyframes(nodeId) };
}

const NUMERIC = new Set(['scalar', 'int', 'bool', 'choice', 'vec2', 'vec3', 'vec4']);
const MASK_PATH = /^masks\/[^/]+\/path$/;

/** The timeline track names a mirror property stands for (the selection adapter owns the mapping). */
export { timelineTracksOf };

/** Whether a property's keys are data keys (no numeric curve). */
export function isDataProperty(info: PropertyInfo): boolean {
  return !NUMERIC.has(info.valueType) && info.valueType !== 'color';
}

interface AnimatedTrack {
  /** Every track of the property (id lookups search them all). */
  tracks: readonly string[];
  keys: readonly Keyframe[];
  info: PropertyInfo;
}

/**
 * The diamonds of one row. Each is named by its ENGINE key id (the selection
 * adapter, core/mirror/keySelection.ts); a member row of a property drawn as
 * several rows (Scale X / Scale Y) adds its member index so the two rows'
 * diamonds stay apart. `member` is undefined for a whole-key row.
 */
function keyRefs(nodeId: string, a: AnimatedTrack, member: number | undefined): TimelineKeyframeRef[] {
  const keys = a.keys;
  // Source Text can never tween, so its keys are always hold.
  const text = a.info.valueType === 'textDocument' || a.info.valueType === 'string';
  const data = isDataProperty(a.info);
  return keys.map((kf, i) => {
    const hold = text || kf.easing === 'hold' || kf.easing === 'step';
    return {
      id: selectionKeyId(nodeId, kf.id, member) as KeyId,
      nodeId: nodeId as NodeId,
      // Comp time: where the renderer applies the key (the engine already
      // honoured trim / sourceIn / stretch / precomp remaps).
      time: flicksToSeconds(kf.time),
      ...(data ? {} : { roving: kf.roving }),
      // Both spellings: Easy Ease → Hold writes 'step' on a scalar track.
      isHold: data ? (hold || undefined) : hold,
      // The glyph is drawn as two halves, so it needs BOTH sides. Easing lives
      // on the segment that STARTS at a key, so the incoming side is the previous key's.
      easeIn: keys[i - 1]?.easing as TimelineKeyframeRef['easeIn'],
      easeOut: kf.easing as TimelineKeyframeRef['easeOut'],
      isFirst: i === 0,
      isLast: i === keys.length - 1,
    };
  });
}

/** The member index a row's diamonds carry: set when the property is drawn as several member rows. */
function rowMember(prop: string, a: AnimatedTrack): number | undefined {
  const i = a.tracks.indexOf(prop);
  return a.tracks.length > 1 && i >= 0 ? i : undefined;
}

/** An animated row, straight off one property (one of its member tracks). */
function animatedRow(nodeId: string, prop: string, a: AnimatedTrack, src: PropertyRowSources): TimelinePropertyTrack {
  // Label and unit from the property registry, resolved with this layer's
  // mirror facts so `effect.<id>.<key>` reads "Glow Radius", not its path.
  const meta = mirrorPropertyMeta(prop, src.layer, src.tree);
  if (isDataProperty(a.info)) {
    return { prop, label: meta.label || a.info.name, keyframes: keyRefs(nodeId, a, rowMember(prop, a)), stopwatchProps: [prop] };
  }
  return {
    prop,
    label: meta.label || a.info.name,
    keyframes: keyRefs(nodeId, a, rowMember(prop, a)),
    // A real (animated) row edits its own track — one field, so the value can
    // be changed here rather than only in the inspector.
    valueProps: [prop],
    valueUnit: meta.unit || undefined,
    // The row's stopwatch toggles exactly what its fields edit.
    stopwatchProps: [prop],
  };
}

/** X and Y (and Z) as AE's single Position row: the Position property's keys. */
function positionRow(nodeId: string, a: AnimatedTrack, src: PropertyRowSources): TimelinePropertyTrack {
  const members = [...a.tracks];
  const meta = mirrorPropertyMeta(POSITION_PSEUDO_PROP, src.layer, src.tree);
  return {
    prop: POSITION_PSEUDO_PROP,
    label: meta.label || a.info.name,
    keyframes: keyRefs(nodeId, a, undefined),
    // The merged Position row edits the real tracks behind it — Z included.
    valueProps: members,
    valueUnit: meta.unit || undefined,
    stopwatchProps: members,
  };
}

/** The Mask Shape row — whole-mask snapshots: one diamond per time across the masks. */
function maskRow(nodeId: string, spec: StaticPropertyRow, masks: ReadonlyArray<AnimatedTrack>): TimelinePropertyTrack {
  const byTime = new Map<number, Keyframe>();
  for (const a of masks) for (const kf of a.keys) if (!byTime.has(kf.time)) byTime.set(kf.time, kf);
  const list = [...byTime.values()].sort((x, y) => x.time - y.time);
  return {
    prop: MASK_ANIM_PROP,
    label: spec.label,
    group: spec.group,
    animated: list.length > 0 ? undefined : false,
    keyframes: list.map((kf, i) => ({
      // One diamond per time across the masks, named by the first mask's key there.
      id: selectionKeyId(nodeId, kf.id) as KeyId,
      nodeId: nodeId as NodeId,
      time: flicksToSeconds(kf.time),
      isFirst: i === 0,
      isLast: i === list.length - 1,
    })),
    // The stopwatch keys (or clears) the whole mask — App routes this prop to
    // `keyframeMask` / `clearMaskAnim` rather than to a numeric track.
    stopwatchProps: [MASK_ANIM_PROP],
  };
}

/** Whether a value field can write `track` (the mirror twin of `canWriteStaticPropertyValue`). */
function canWriteValue(tree: MirrorTreeLike | undefined, track: string): boolean {
  const r = trackRefIn(tree, track);
  // A colour channel has no single scrubbable value; a data property has no number.
  return !!r && r.info.kind === 'property' && NUMERIC.has(r.info.valueType);
}

/** A tree row with nothing keyed yet: one line, unlit stopwatch. */
function placeholderRow(spec: StaticPropertyRow, src: PropertyRowSources): TimelinePropertyTrack {
  // A static row is still editable — AE lets you set a value before keyframing
  // — but only where the value has somewhere to land. An effect param whose
  // effect has gone, or a colour channel, gets a label and a stopwatch and no
  // field, rather than a field that swallows edits.
  const valueProps = spec.valueProps.filter((p) => canWriteValue(src.tree, p));
  return {
    prop: spec.prop,
    label: spec.label,
    group: spec.group,
    keyframes: [],
    animated: false,
    ...(spec.members.length > 0 ? { stopwatchProps: [...spec.members] } : {}),
    ...(valueProps.length > 0 ? { valueProps, valueUnit: spec.valueUnit } : {}),
  };
}

/**
 * Every sub-row of an expanded layer, in AE's order.
 *
 * Keyed properties the static tree does not describe are appended rather than
 * dropped: a legacy `effect.<id>` scalar from a pre-multi-param project, a
 * plugin layer kind's own property, an expression control. They are animated —
 * the engine is holding their keys — so hiding them would hide real work.
 */
export function buildPropertyRows(nodeId: string, src: PropertyRowSources = mirrorRowSources(nodeId)): TimelinePropertyTrack[] {
  // track name → the animated property behind it
  const animated = new Map<string, AnimatedTrack>();
  const masks: AnimatedTrack[] = [];
  for (const [path, keys] of src.keys) {
    if (keys.length === 0) continue;
    const info = src.tree?.nodes.get(path);
    if (!info) continue;
    const a: AnimatedTrack = { tracks: timelineTracksOf(info), keys, info };
    if (MASK_PATH.test(path)) {
      masks.push(a);
      continue;
    }
    for (const t of a.tracks) if (!animated.has(t)) animated.set(t, a);
  }

  const out: TimelinePropertyTrack[] = [];
  // B4-gap: the timeline's AE row projection (sections, order, placeholder rows, the legacy track names row writes use) — the mirror tree lists the catalog in another order and with more properties (Width/Height under `layer`, not Contents); moving the projection onto the tree is its own parity-checked step.
  for (const spec of buildStaticPropertyTree(nodeId)) {
    if (spec.maskTrack) {
      out.push(maskRow(nodeId, spec, masks));
      continue;
    }
    const keyed = spec.members.filter((p) => animated.has(p));
    if (keyed.length === 0) {
      out.push(placeholderRow(spec, src));
      continue;
    }
    const lead = animated.get(keyed[0]!)!;
    if (spec.merged === POSITION_PSEUDO_PROP) {
      for (const p of lead.tracks) animated.delete(p);
      out.push({ ...positionRow(nodeId, lead, src), group: spec.group });
      continue;
    }
    // Every member of the keyed property draws the property's keys.
    for (const p of spec.members) {
      const a = animated.get(p);
      if (!a) continue;
      animated.delete(p);
      out.push({ ...animatedRow(nodeId, p, a, src), group: spec.group });
    }
  }

  for (const [prop, a] of animated) out.push({ ...animatedRow(nodeId, prop, a, src), group: groupForProp(prop, nodeId) });
  return out;
}
