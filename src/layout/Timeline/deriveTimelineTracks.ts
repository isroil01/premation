/**
 * Scene → timeline track rows.
 *
 * Shared by the editor shell and a popped-out timeline window so both draw
 * the same layer stack. The pop-out used to pass a hardcoded empty model and
 * rendered a blank panel.
 */

import type { TimelineTrack, TimelinePropertyTrack, TimelineClip, TimelineKeyframeRef } from './TimelineModel';
import type { TrackId, KeyId, NodeId } from '@app-types/common';
import { VIDEO_AUDIO_MUTED_PROP } from '@core/audio/audioScene';
import { getNodeBlend } from '@core/effects/blendMode';
import { getNodeMatte } from '@core/effects/matte';
import { readNodeFxEnabled } from '@core/effects/effects';
import { readNodeMotionBlur } from '@core/effects/motionBlur';
import { readNodeAdjustment } from '@core/effects/adjustment';
import { readIsGuideLayer } from '@core/scene/guideLayer';
import { readNodePreserveTransparency } from '@core/effects/preserveTransparency';
import { is3DEnabled } from '@core/scene/threeD';
import { readNodeKind, KIND_COLOR, KIND_ICON, KIND_FILL } from '@core/scene/sceneDerive';
import type { SceneNode } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation, makeKeyframeId } from '@motion/animation';
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
}

export function deriveTimelineTracks(args: DeriveTimelineTracksArgs): TimelineTrack[] {
  const { activeCompId, compFps, expandedIds } = args;
  const controller = getTimelineController();
  const compId = activeCompId || 'comp_root';
  const result: TimelineTrack[] = [];

  const traverse = (parentId: string, depth: number): void => {
    const nodes = [...defaultSceneGraph.getChildren(parentId)].reverse();
    for (const node of nodes) {
      const kind = readNodeKind(node);
      const isExpanded = expandedIds.includes(node.id);
      const properties: TimelinePropertyTrack[] = isExpanded ? buildPropertyRows(node.id) : [];
      const keyframes: TimelineKeyframeRef[] = isExpanded
        ? properties.flatMap((p) => p.keyframes)
        : (() => {
            const out: TimelineKeyframeRef[] = [];
            for (const track of defaultAnimation.tracksFor(node.id)) {
              for (const kf of track.keyframes) {
                out.push({
                  id: makeKeyframeId(node.id, track.prop, kf.t) as KeyId,
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
                  id: makeKeyframeId(node.id, dt.prop, kf.t) as KeyId,
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
        locked: node.locked === true,
        solo: node.solo === true,
        blendMode: getNodeBlend(node.id),
        matteMode: getNodeMatte(node.id),
        parent: node.parent ?? null,
        nodeColor: getNodeColor(node),
        threeD: is3DEnabled(node),
        motionBlur: readNodeMotionBlur(node),
        fxEnabled: readNodeFxEnabled(node),
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
        expanded: expandedIds.includes(node.id),
      };

      result.push(track);

      if (kind === 'group') {
        if (expandedIds.includes(node.id)) traverse(node.id, depth + 1);
      } else {
        traverse(node.id, depth);
      }
    }
  };

  traverse(compId, 0);
  return result;
}
