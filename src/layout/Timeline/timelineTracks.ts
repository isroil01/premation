/**
 * Document mirror → timeline track rows (B4, docs/B4_MIRROR.md).
 *
 * The timeline renders only from the mirror: the comp's stack order
 * (`MirrorComp.layers`, top first), each layer's header (`LayerInfo`:
 * switches, blend, matte, parent, timing, markers) and its keyframes
 * (`layerKeyframes`). Expanded layers add their property rows, built from their
 * retained property trees (`buildPropertyRows`).
 *
 * ── Nesting ─────────────────────────────────────────────────────────────
 * Parenting IS nesting in the TS engine, and the comp's order is the
 * depth-first, front-first walk of it (a parent before its children). A
 * GROUP's children are rows only while the group is expanded, one level
 * deeper; a non-group parent's children follow it at the same depth (AE's
 * parent/child link, not a folder).
 *
 * ── Caching ─────────────────────────────────────────────────────────────
 * Records are immutable and keep their identity when unchanged, so a track is
 * rebuilt only when its OWN inputs changed: the LayerInfo, the keyframe map,
 * the depth, the expanded flag and (expanded) the property tree. A property
 * drag on one of 2,000 layers rebuilds one track; the other 1,999 keep their
 * objects and their memoised rows skip.
 */

import type { KeyId, NodeId, TrackId } from '@app-types/common';
import { flicksToSeconds, type Keyframe, type LayerInfo, type Marker } from '@motion/engine-api';
import { LABEL_COLORS } from '@core/scene/labelColor';
import { KIND_COLOR, KIND_FILL, KIND_ICON } from '@core/scene/sceneDerive';
import type { SceneKind } from '@core/scene/seedDefaultScene';
import { uiKindOf } from '@core/mirror/layerKinds';
import type { MirrorTreeLike } from '@core/mirror/trackIndex';
import type { MirrorComp } from '@stores/documentMirror';
import { buildPropertyRows, timelineTracksOf } from './buildPropertyRows';
import { storedKeyIndex, storedKeyOf, uiKeyId } from './keyframeSelectionIds';
import type { TimelineKeyframeRef, TimelineMarker, TimelineModel, TimelineTrack } from './TimelineModel';

/** What the builder reads: a `DocumentMirror` is one. */
export interface TimelineMirrorRead {
  comp(id: string): MirrorComp | undefined;
  layer(id: string): LayerInfo | undefined;
  layerKeyframes(layer: string): ReadonlyMap<string, readonly Keyframe[]>;
  tree(layer: string): MirrorTreeLike | undefined;
}

const HEX = /^#[0-9a-fA-F]{3,8}$/;

/** The layer's label colour (hex) from its label index, or undefined (kind default). */
function labelHex(layer: LayerInfo): string | undefined {
  const i = layer.switches.label;
  return i > 0 ? LABEL_COLORS[i - 1]?.color : undefined;
}

/** A label colour OUTSIDE the palette (the Label menu's custom swatch): `switches.labelColor`, as stored. */
function customLabelHex(layer: LayerInfo): string | undefined {
  if (layer.switches.label !== 0) return undefined;
  const c = layer.switches.labelColor;
  return typeof c === 'string' && HEX.test(c) ? c : undefined;
}

const flicks = flicksToSeconds;

function markerView(m: Marker, offset: number): TimelineMarker {
  return {
    id: m.id,
    time: flicks(m.time + offset),
    label: m.name || 'Marker',
    ...(m.color ? { color: m.color } : {}),
  };
}

/**
 * A collapsed row's keyframe summary: every key of every animated property,
 * one diamond per property key (a vector property's key is one key).
 */
function summaryKeys(layerId: string, keys: ReadonlyMap<string, readonly Keyframe[]>, tree: MirrorTreeLike | undefined): TimelineKeyframeRef[] {
  const out: TimelineKeyframeRef[] = [];
  if (keys.size === 0) return out;
  const stored = storedKeyIndex(layerId);
  for (const [path, list] of keys) {
    const info = tree?.nodes.get(path);
    // The row name when the key is not the TS engine's: the property's lead track (tree loaded) or its path.
    const track = info ? timelineTracksOf(info)[0]! : path;
    const text = path === 'text/sourceText' || info?.valueType === 'textDocument' || info?.valueType === 'string';
    for (const kf of list) {
      const at = storedKeyOf(stored, kf, track);
      out.push({
        id: uiKeyId(layerId, at.track, at.t) as KeyId,
        nodeId: layerId as NodeId,
        time: flicks(kf.time),
        roving: kf.roving || undefined,
        isHold: text || kf.easing === 'hold' || kf.easing === 'step' || undefined,
        easeOut: kf.easing,
      });
    }
  }
  return out;
}

interface CacheEntry {
  layer: LayerInfo;
  keys: ReadonlyMap<string, readonly Keyframe[]>;
  tree: MirrorTreeLike | undefined;
  depth: number;
  expanded: boolean;
  custom: string | undefined;
  track: TimelineTrack;
}

/** Per layer, the last track built for it and the inputs it came from. */
export type TimelineTrackCache = Map<string, CacheEntry>;

export function createTrackCache(): TimelineTrackCache {
  return new Map();
}

function buildTrack(
  layer: LayerInfo,
  kind: SceneKind,
  keys: ReadonlyMap<string, readonly Keyframe[]>,
  tree: MirrorTreeLike | undefined,
  depth: number,
  expanded: boolean,
  custom: string | undefined,
): TimelineTrack {
  const id = layer.id;
  const label = labelHex(layer) ?? custom;
  const properties = expanded ? buildPropertyRows(id, { layer, tree, keys }) : [];
  // The summary resolves member tracks through the tree when one is loaded
  // (expanded rows, or a tree some panel retains); without it the path stands in.
  const keyframes = expanded ? properties.flatMap((p) => p.keyframes) : summaryKeys(id, keys, tree);
  const { inPoint, outPoint, startTime } = layer.timing;
  const waveAssetId = (kind === 'audio' || kind === 'video') && layer.source ? layer.source : undefined;
  const sourceInSec = flicks(inPoint - startTime);
  const clipColor = label ?? KIND_FILL[kind];
  const s = layer.switches;
  return {
    id: id as TrackId,
    name: layer.name || id,
    kind,
    icon: KIND_ICON[kind],
    color: label ?? KIND_COLOR[kind],
    muted: !s.visible,
    audioMuted: !s.audioEnabled,
    // The API says whether the layer can make a sound (a video carries its own
    // track unless probed silent — unknown counts as "might").
    hasAudio: kind === 'audio' || (kind === 'video' && layer.hasAudio),
    locked: s.locked,
    solo: s.solo,
    blendMode: layer.blendMode,
    matteMode: layer.matte.mode === 'none' ? undefined : {
      mode: layer.matte.mode.startsWith('luma') ? 'luma' : 'alpha',
      inverted: layer.matte.mode.endsWith('Inverted'),
      ...(layer.matte.layer ? { sourceId: layer.matte.layer } : {}),
    },
    parent: layer.parent ?? null,
    nodeColor: label && HEX.test(label) ? label : (KIND_FILL[kind] ?? '#5282b8'),
    threeD: s.threeD,
    motionBlur: s.motionBlur,
    fxEnabled: s.effectsEnabled,
    // The fx switch is drawn only on a layer that carries an effect (AE).
    hasEffects: layer.effectCount > 0,
    adjustment: s.adjustment,
    guide: s.guide,
    preserveTransparency: s.preserveTransparency,
    shy: s.shy,
    collapse: s.collapse,
    keyframes,
    properties,
    // One bar per layer: its in/out in comp seconds, the source window from
    // the start time (source 0 plays at `startTime`).
    clips: [{
      id: `clip:${id}`,
      trackId: id as TrackId,
      nodeId: id as NodeId,
      start: flicks(inPoint),
      duration: flicks(outPoint - inPoint),
      label: layer.name || id,
      color: clipColor,
      ...(waveAssetId ? { assetId: waveAssetId } : {}),
      sourceInSec,
      sourceOutSec: sourceInSec + flicks(outPoint - inPoint),
    }],
    // Layer markers are in LAYER time; the TS engine anchors it at the bar's
    // in point (TimelineController.toAbsoluteTime), so comp time = in + time.
    markers: layer.markers.map((m) => markerView(m, inPoint)),
    depth,
    isGroup: kind === 'group',
    // Every visual layer has a Transform group to reveal; audio only when keyed.
    canExpand: kind === 'group' || kind !== 'audio' || keys.size > 0,
    expanded,
  };
}

/**
 * The comp's rows, top of the stack first. `cache` keeps each layer's track
 * while its inputs are unchanged (pass the same cache on every call).
 */
export function buildTimelineTracks(
  m: TimelineMirrorRead,
  compId: string | undefined,
  expandedIds: ReadonlyArray<string>,
  cache: TimelineTrackCache = createTrackCache(),
): TimelineTrack[] {
  const comp = compId ? m.comp(compId) : undefined;
  if (!comp) {
    cache.clear();
    return [];
  }
  const expandedSet = new Set(expandedIds);
  const out: TimelineTrack[] = [];
  /** Depth of each shown layer; absent = hidden (inside a collapsed group). */
  const depthOf = new Map<string, number>();
  const groups = new Set<string>();
  const seen = new Set<string>();
  for (const id of comp.layers) {
    const layer = m.layer(id);
    if (!layer) continue;
    let depth = 0;
    if (layer.parent) {
      const pd = depthOf.get(layer.parent);
      // The parent's row is hidden (a collapsed group, or inside one): so is this.
      if (pd === undefined) continue;
      if (groups.has(layer.parent)) {
        if (!expandedSet.has(layer.parent)) continue;
        depth = pd + 1;
      } else {
        depth = pd;
      }
    }
    const kind = uiKindOf(layer) ?? 'shape';
    if (kind === 'group') groups.add(id);
    depthOf.set(id, depth);
    seen.add(id);
    const expanded = expandedSet.has(id);
    const keys = m.layerKeyframes(id);
    // An expanded row needs its tree (the caller retains it); a collapsed one
    // uses it only if some panel already has it loaded.
    const tree = expanded ? m.tree(id) : undefined;
    const custom = customLabelHex(layer);
    const hit = cache.get(id);
    if (hit && hit.layer === layer && hit.keys === keys && hit.depth === depth && hit.expanded === expanded
      && hit.tree === tree && hit.custom === custom) {
      out.push(hit.track);
      continue;
    }
    const track = buildTrack(layer, kind, keys, tree, depth, expanded, custom);
    cache.set(id, { layer, keys, tree, depth, expanded, custom, track });
    out.push(track);
  }
  // Drop entries for layers no longer shown (deleted, hidden, another comp).
  for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id);
  return out;
}

/** The comp's markers (comp time), for the ruler. */
export function compMarkersOf(comp: MirrorComp | undefined): TimelineMarker[] {
  return comp ? comp.markers.map((mk) => markerView(mk, 0)) : [];
}

/**
 * The work area in comp seconds, or undefined when it is the whole comp (the
 * API always states one; the legacy "no work area" is the full duration).
 */
export function workAreaOf(comp: MirrorComp | undefined): TimelineModel['workArea'] {
  const wa = comp?.settings.workArea;
  if (!comp || !wa) return undefined;
  if (wa.start === 0 && wa.duration >= comp.settings.duration) return undefined;
  return { start: flicks(wa.start), end: flicks(wa.start + wa.duration) };
}
