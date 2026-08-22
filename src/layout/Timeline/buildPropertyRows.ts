/**
 * A layer's timeline sub-rows: the static property tree with the engine's
 * keyframes merged onto it.
 *
 * Two authorities meet here and neither is allowed to grow a copy of the other.
 * `buildStaticPropertyTree` says WHAT properties a layer has and in what order;
 * `defaultAnimation` says which of them are keyframed and where. This file is
 * the join, and nothing else — no property is invented here that the tree did
 * not name, and no keyframe is drawn that the engine does not hold.
 *
 * ## The one rule worth stating
 *
 * A tree row stands for one or more real props (`members`). While NONE of them
 * is keyed the row is a placeholder — one line, `animated: false`, a stopwatch
 * that keys every member at once. The moment any member is keyed the row splits
 * into its real per-prop rows, each with its own curve. Position is the
 * exception AE also makes: X and Y stay a single "Position" row even while
 * animated, because a position keyframe is one keyframe with two numbers, not
 * two keyframes that happen to share a time.
 *
 * Called ONLY for expanded layers. A collapsed layer gets the cheap keyframe
 * summary instead — see the `tracks` memo in App.tsx.
 */

import type { KeyId, NodeId } from '@app-types/common';
import { defaultAnimation, makeKeyframeId, parseKeyframeId, POSITION_PSEUDO_PROP } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { keyframeToCompTime, compToKeyframeTime } from '@core/timeline/TimelineController';
import { propertyLabel, resolvePropertyMeta } from '@core/inspector/propertyMeta';
import { canWriteStaticPropertyValue } from '@core/inspector/propertyValue';
import {
  buildStaticPropertyTree,
  groupForProp,
  MASK_ANIM_PROP,
  type StaticPropertyRow,
} from '@core/timeline/propertyTree';
import { readNodeMaskAnim } from '@core/effects/mask';
import type { TimelinePropertyTrack, TimelineKeyframeRef } from './TimelineModel';

/** An animated row, straight off one engine track. */
function scalarRow(nodeId: string, prop: string, keyframes: ReadonlyArray<{
  t: number; easing?: string; roving?: boolean;
}>): TimelinePropertyTrack {
  return {
    prop,
    // Label and unit both come from the property registry, resolved with this
    // node so `effect.<id>.<key>` reads "Glow Radius" and not its raw path.
    label: propertyLabel(prop, nodeId),
    keyframes: keyframes.map((kf, i, all) => ({
      id: makeKeyframeId(nodeId, prop, kf.t) as KeyId,
      nodeId: nodeId as NodeId,
      // Diamonds draw at the comp time where the renderer actually applies the
      // keyframe — the canonical inverse, which honors trim/sourceIn, the
      // active clip, stretch and precomp remaps.
      time: keyframeToCompTime(nodeId, kf.t, prop),
      roving: kf.roving,
      // Both spellings: Easy Ease → Hold writes 'step' on a scalar track, so
      // checking only 'hold' meant a held keyframe never drew as one.
      isHold: kf.easing === 'hold' || kf.easing === 'step',
      // The glyph is drawn as two halves, so it needs BOTH sides. The engine
      // stores easing on the segment that STARTS at a keyframe, so the incoming
      // side is the previous keyframe's.
      easeIn: all[i - 1]?.easing as TimelineKeyframeRef['easeIn'],
      easeOut: kf.easing as TimelineKeyframeRef['easeOut'],
      isFirst: i === 0,
      isLast: i === all.length - 1,
    })),
    // A real (animated) row edits its own prop — one field, so the value can be
    // changed here rather than only in the inspector.
    valueProps: [prop],
    valueUnit: resolvePropertyMeta(prop, nodeId).unit || undefined,
    // The row's stopwatch toggles exactly what its fields edit.
    stopwatchProps: [prop],
  };
}

/** Non-scalar (data) tracks: Source Text, gradient stops, path points, pins. */
function dataRow(
  nodeId: string,
  prop: string,
  kind: string,
  keyframes: ReadonlyArray<{ t: number; easing?: string }>,
): TimelinePropertyTrack {
  return {
    prop,
    label: propertyLabel(prop, nodeId),
    keyframes: keyframes.map((kf, i, all) => ({
      id: makeKeyframeId(nodeId, prop, kf.t) as KeyId,
      nodeId: nodeId as NodeId,
      time: keyframeToCompTime(nodeId, kf.t, prop),
      // `text` can never tween, so its rows are always hold. Otherwise report
      // the keyframe's own curve — data keyframes carry easing exactly like
      // scalar ones, so the diamond must draw it or Easy Ease on a puppet pin
      // would apply with no visible feedback.
      isHold: kind === 'text' || kf.easing === 'hold' || kf.easing === 'step' || undefined,
      easeIn: all[i - 1]?.easing as TimelineKeyframeRef['easeIn'],
      easeOut: kf.easing as TimelineKeyframeRef['easeOut'],
      isFirst: i === 0,
      isLast: i === all.length - 1,
    })),
    stopwatchProps: [prop],
  };
}

/**
 * X and Y (and Z) collapsed into AE's single Position row.
 *
 * One diamond per DISTINCT time across the axes: a position keyframe is one
 * keyframe holding several numbers, and drawing one diamond per axis would
 * stack two glyphs on the same pixel and make "delete this keyframe" ambiguous.
 */
function mergedPositionRow(
  nodeId: string,
  axisRows: ReadonlyArray<TimelinePropertyTrack>,
): TimelinePropertyTrack {
  const merged = new Map<number, TimelineKeyframeRef>();
  for (const axis of axisRows) {
    for (const kf of axis.keyframes) {
      if (merged.has(kf.time)) continue;
      // The id must carry the STORED keyframe time, like every per-property row
      // — `kf.time` is absolute. The source row's id already encodes the exact
      // stored time, so lift it from there rather than round-tripping through
      // the (frame-quantizing) inverse conversion.
      const layerT = parseKeyframeId(kf.id)?.t ?? compToKeyframeTime(nodeId, kf.time);
      merged.set(kf.time, { ...kf, id: makeKeyframeId(nodeId, POSITION_PSEUDO_PROP, layerT) as KeyId });
    }
  }
  const members = axisRows.map((r) => r.prop);
  return {
    prop: POSITION_PSEUDO_PROP,
    label: propertyLabel(POSITION_PSEUDO_PROP),
    keyframes: [...merged.values()].sort((a, b) => a.time - b.time),
    // The merged Position row edits the two real props behind it.
    valueProps: members.filter((p) => p !== 'z'),
    valueUnit: resolvePropertyMeta(POSITION_PSEUDO_PROP).unit || undefined,
    stopwatchProps: members,
  };
}

/** The Mask Shape row — whole-mask snapshots, not a numeric track. */
function maskRow(nodeId: string, spec: StaticPropertyRow): TimelinePropertyTrack {
  const node = defaultSceneGraph.getNode(nodeId);
  const anim = node ? readNodeMaskAnim(node) : [];
  return {
    prop: MASK_ANIM_PROP,
    label: spec.label,
    group: spec.group,
    animated: anim.length > 0 ? undefined : false,
    keyframes: anim.map((kf, i, all) => ({
      id: makeKeyframeId(nodeId, MASK_ANIM_PROP, kf.t) as KeyId,
      nodeId: nodeId as NodeId,
      time: keyframeToCompTime(nodeId, kf.t, MASK_ANIM_PROP),
      isFirst: i === 0,
      isLast: i === all.length - 1,
    })),
    // The stopwatch keys (or clears) the whole mask — App routes this prop to
    // `keyframeMask` / `clearMaskAnim` rather than to the animation engine.
    stopwatchProps: [MASK_ANIM_PROP],
  };
}

/** A tree row with nothing keyed yet: one line, unlit stopwatch. */
function placeholderRow(nodeId: string, spec: StaticPropertyRow): TimelinePropertyTrack {
  // A static row is still editable — AE lets you set a value before keyframing
  // — but only where the value has somewhere to land. An effect param whose
  // effect has gone, or a colour channel (whose base is a hex string), gets a
  // label and a stopwatch and no field, rather than a field that swallows edits.
  const valueProps = spec.valueProps.filter((p) => canWriteStaticPropertyValue(nodeId, p));
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
 * Rows the tree does not describe are appended rather than dropped: a legacy
 * `effect.<id>` scalar from a pre-multi-param project, a plugin layer kind's
 * own property, an expression control. They are animated — the engine is
 * holding their keyframes — so hiding them would hide real work.
 */
export function buildPropertyRows(nodeId: string): TimelinePropertyTrack[] {
  const scalars = new Map<string, TimelinePropertyTrack>();
  for (const track of defaultAnimation.tracksFor(nodeId)) {
    scalars.set(track.prop, scalarRow(nodeId, track.prop, track.keyframes));
  }
  for (const dt of defaultAnimation.dataTracksFor(nodeId)) {
    if (dt.keyframes.length === 0) continue;
    scalars.set(dt.prop, dataRow(nodeId, dt.prop, dt.kind, dt.keyframes));
  }

  const out: TimelinePropertyTrack[] = [];
  for (const spec of buildStaticPropertyTree(nodeId)) {
    if (spec.maskTrack) {
      out.push(maskRow(nodeId, spec));
      continue;
    }
    const animated = spec.members.filter((p) => scalars.has(p));
    if (animated.length === 0) {
      out.push(placeholderRow(nodeId, spec));
      continue;
    }
    const rows = animated.map((p) => scalars.get(p)!);
    for (const p of animated) scalars.delete(p);
    if (spec.merged === POSITION_PSEUDO_PROP) {
      out.push({ ...mergedPositionRow(nodeId, rows), group: spec.group });
    } else {
      for (const r of rows) out.push({ ...r, group: spec.group });
    }
  }

  for (const [prop, r] of scalars) out.push({ ...r, group: groupForProp(prop, nodeId) });
  return out;
}
