/**
 * Scene → timeline track rows.
 *
 * Shared by the editor shell and a popped-out timeline window so both draw
 * the same layer stack. The pop-out used to pass a hardcoded empty model and
 * rendered a blank panel.
 */

import type { TimelineTrack, TimelinePropertyTrack, TimelineClip, TimelineKeyframeRef } from './TimelineModel';
import type { TrackId, KeyId, NodeId } from '@app-types/common';
import { VIDEO_AUDIO_MUTED_PROP, videoHasAudioTrack } from '@core/audio/audioScene';
import { getNodeBlend } from '@core/effects/blendMode';
import { getNodeMatte } from '@core/effects/matte';
import { getNodeEffects, readNodeFxEnabled } from '@core/effects/effects';
import { readNodeMotionBlur } from '@core/effects/motionBlur';
import { readNodeAdjustment } from '@core/effects/adjustment';
import { readIsGuideLayer } from '@core/scene/guideLayer';
import { readNodePreserveTransparency } from '@core/effects/preserveTransparency';
import { is3DEnabled } from '@core/scene/threeD';
import { readNodeKind, stackOrderedChildren, KIND_COLOR, KIND_ICON, KIND_FILL } from '@core/scene/sceneDerive';
import type { SceneNode } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { uiKeyId } from './keyframeSelectionIds';
import { getTimelineController, keyframeToCompTime } from '@core/timeline/TimelineController';
import { buildPropertyRows } from './buildPropertyRows';

function getNodeColor(node: SceneNode | null): string | undefined {
  if (!node) return '#5282b8';
  if (typeof node.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(node.color)) {
    return node.color;
  }
  const kind = readNodeKind(node);
  return KIND_FILL[kind] ?? '#5282b8';
}

function isLayerAudioMuted(node: ReturnType<typeof defaultSceneGraph.getNode>): boolean {
  if (!node) return false;
  const kind = readNodeKind(node);
  if (kind === 'audio') {
    return node.components.find((c: { type: string }) => c.type === 'Audio')?.props?.__muted === true;
  }
  if (kind !== 'video') return false;
  return node.components.some(
    (c: { props?: Record<string, unknown> }) => c.props?.[VIDEO_AUDIO_MUTED_PROP] === true,
  );
}

export interface DeriveTimelineTracksArgs {
  activeCompId: string | undefined;
  compFps: number;
  expandedIds: ReadonlyArray<string>;
  /**
   * The caller's animation / clip / marker revision counters. With them, a
   * COLLAPSED node whose own state (`mutationSeq`), cheap view fields, clip
   * list and these counters are all unchanged gets its previous track object
   * back — same identity, so the memoised row components skip. Without them
   * every track is rebuilt, as before.
   */
  revs?: { anim: number; clip: number; marker: number };
}

interface TrackCacheEntry {
  key: string;
  track: TimelineTrack;
}

/**
 * Per node, the last track built for it and the inputs it was built from.
 *
 * Deriving the timeline is a walk of the whole comp building a fresh object
 * per node — 2,000 nodes on every scene change, each reading a dozen props
 * and the animation engine, to hand the rows 2,000 NEW objects that were
 * equal to the old ones. Expanded nodes are never cached: their property rows
 * carry values sampled at the playhead.
 */
const trackCache = new Map<string, TrackCacheEntry>();

/** Whether a node is even a cache candidate: a caller with revs, a collapsed row, a sequenced node. */
function cacheKey0(revs: DeriveTimelineTracksArgs['revs'], isExpanded: boolean, seq: unknown): boolean {
  return !!revs && !isExpanded && typeof seq === 'number';
}

export function deriveTimelineTracks(args: DeriveTimelineTracksArgs): TimelineTrack[] {
  const { activeCompId, compFps, expandedIds, revs } = args;
  const controller = getTimelineController();
  const compId = activeCompId || 'comp_root';
  const result: TimelineTrack[] = [];
  const expandedSet = new Set(expandedIds);
  const seen = new Set<string>();

  const traverse = (parentId: string, depth: number): void => {
    // Front-most first — the same projection of the graph's child array the
    // Scene tree uses, so the two panels can never disagree about the stack.
    const nodes = stackOrderedChildren(defaultSceneGraph, parentId);
    for (const node of nodes) {
      const kind = readNodeKind(node);
      const isExpanded = expandedSet.has(node.id);
      // ── Cache probe (collapsed nodes only) ──────────────────────────
      const seq = (node as unknown as { mutationSeq?: number }).mutationSeq;
      const hasAudioNow = kind === 'audio' || (kind === 'video' && videoHasAudioTrack(node) !== false);
      // Clips and markers are keyed per NODE, not by the global clip/marker
      // counters: adding a layer bumps those counters, which would miss the
      // cache for every other row on the one edit this exists to speed up.
      const layersRef = cacheKey0(revs, isExpanded, seq) ? controller.getLayersForNode(node.id) : null;
      const cacheKey = layersRef
        ? [seq, node.name ?? '', (node as { color?: string }).color ?? '', node.solo === true ? 1 : 0, node.visible === false ? 0 : 1,
           node.locked === true ? 1 : 0, (node as { shy?: boolean }).shy === true ? 1 : 0, node.parent ?? '', depth, compFps,
           revs!.anim, hasAudioNow ? 1 : 0,
           layersRef.map((l) => `${l.id}:${l.start}:${l.duration}:${l.clip.sourceIn}:${l.clip.duration}`).join(','),
           controller.getLayerMarkers(node.id).map((m) => `${m.id}:${m.time}:${m.label}:${m.color ?? ''}`).join(',')].join('|')
        : null;
      if (cacheKey !== null) {
        const hit = trackCache.get(node.id);
        // The key carries every clip's geometry; `getLayersForNode` returns a
        // fresh sorted copy per call, so its identity is never a valid test.
        if (hit && hit.key === cacheKey) {
          seen.add(node.id);
          result.push(hit.track);
          if (kind === 'group') {
            if (expandedSet.has(node.id)) traverse(node.id, depth + 1);
          } else {
            traverse(node.id, depth);
          }
          continue;
        }
      }
      const properties: TimelinePropertyTrack[] = isExpanded ? buildPropertyRows(node.id) : [];
      const keyframes: TimelineKeyframeRef[] = isExpanded
        ? properties.flatMap((p) => p.keyframes)
        : (() => {
            const out: TimelineKeyframeRef[] = [];
            for (const track of defaultAnimation.tracksFor(node.id)) {
              for (const kf of track.keyframes) {
                out.push({
                  id: uiKeyId(node.id, track.prop, kf.t) as KeyId,
                  nodeId: node.id as NodeId,
                  time: keyframeToCompTime(node.id, kf.t, track.prop),
                  roving: kf.roving,
                  isHold: kf.easing === 'hold' || kf.easing === 'step',
                  easeOut: kf.easing,
                });
              }
            }
            for (const dt of defaultAnimation.dataTracksFor(node.id)) {
              for (const kf of dt.keyframes) {
                out.push({
                  id: uiKeyId(node.id, dt.prop, kf.t) as KeyId,
                  nodeId: node.id as NodeId,
                  time: keyframeToCompTime(node.id, kf.t, dt.prop),
                  isHold: dt.kind === 'text' || kf.easing === 'hold' || kf.easing === 'step' || undefined,
                  easeOut: kf.easing,
                });
              }
            }
            return out;
          })();
      const audioComp = node.components.find((c) => c.type === 'Audio');
      const mediaAssetId =
        (audioComp?.props?.__assetId as string | undefined) ??
        (node.components.find((c) => typeof (c.props as Record<string, unknown>)?.assetId === 'string')
          ?.props as Record<string, unknown> | undefined)?.assetId as string | undefined;
      const waveAssetId = kind === 'audio' || kind === 'video' ? mediaAssetId : undefined;
      const clips: TimelineClip[] = controller.getLayersForNode(node.id).map((l) => ({
        id: l.id,
        trackId: node.id as TrackId,
        nodeId: node.id as NodeId,
        start: l.start / compFps,
        duration: l.duration / compFps,
        label: node.name ?? node.id,
        color: (node as { color?: string }).color ?? KIND_FILL[kind],
        ...(waveAssetId ? { assetId: waveAssetId } : {}),
        sourceInSec: l.clip.sourceIn / compFps,
        sourceOutSec: (l.clip.sourceIn + l.clip.duration) / compFps,
      }));
      const canExpand =
        kind === 'group' ||
        (kind !== 'audio' && node.components.some((c) => c.type === 'Transform')) ||
        defaultAnimation.tracksFor(node.id).length > 0 ||
        defaultAnimation.dataTracksFor(node.id).length > 0;
      const track: TimelineTrack = {
        id: node.id as TrackId,
        name: node.name ?? node.id,
        kind,
        icon: KIND_ICON[kind],
        color: (node as { color?: string }).color ?? KIND_COLOR[kind],
        muted: node.visible === false,
        audioMuted: isLayerAudioMuted(node),
        // `videoHasAudioTrack` returns null while the probe is still running;
        // treat unknown as "might" so the switch does not pop in late.
        hasAudio: kind === 'audio' || (kind === 'video' && videoHasAudioTrack(node) !== false),
        locked: node.locked === true,
        solo: node.solo === true,
        blendMode: getNodeBlend(node.id),
        matteMode: getNodeMatte(node.id),
        parent: node.parent ?? null,
        nodeColor: getNodeColor(node),
        threeD: is3DEnabled(node),
        motionBlur: readNodeMotionBlur(node),
        fxEnabled: readNodeFxEnabled(node),
        hasEffects: getNodeEffects(node.id).length > 0,
        adjustment: readNodeAdjustment(node),
        guide: readIsGuideLayer(node),
        preserveTransparency: readNodePreserveTransparency(node),
        shy: (node as { shy?: boolean }).shy === true,
        keyframes,
        properties,
        clips,
        markers: controller.getLayerMarkers(node.id).map((m) => ({
          id: m.id,
          time: m.time,
          label: m.label,
          ...(m.color ? { color: m.color } : {}),
        })),
        depth,
        isGroup: kind === 'group',
        canExpand,
        expanded: expandedSet.has(node.id),
      };

      if (cacheKey !== null) {
        trackCache.set(node.id, { key: cacheKey, track });
        seen.add(node.id);
      }
      result.push(track);

      if (kind === 'group') {
        if (expandedSet.has(node.id)) traverse(node.id, depth + 1);
      } else {
        traverse(node.id, depth);
      }
    }
  };

  traverse(compId, 0);
  // Drop entries for nodes no longer in this walk (deleted, or another comp).
  if (revs) for (const id of trackCache.keys()) if (!seen.has(id)) trackCache.delete(id);
  return result;
}
