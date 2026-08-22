/**
 * OpenTimelineIO export — editorial interchange one rung above the CMX EDL.
 *
 * OTIO is the industry's open interchange schema (JSON): DaVinci Resolve
 * reads it natively, and the OTIO adapter ecosystem converts it to AAF/FCPXML
 * for Avid/Premiere round-trips. Emitting it directly gets real NLE handoff
 * without this app implementing AAF's compound-file container — which stays
 * a separate project (binary CFB + the AAF object model).
 *
 * Mapping: this editor is layer-based, so each media layer becomes its OWN
 * OTIO track (V1…Vn top-down, A1…An), each a gap to the bar's start followed
 * by the clip — which preserves overlaps that a single flattened track would
 * have to discard. Effects, transforms and keyframes stay behind: interchange
 * carries the CUT, not the comp.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { flattenScene, readNodeKind } from '@core/scene/sceneDerive';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useAssetStore } from '@stores/assetStore';
import { assetIdOf } from '@core/source/sourceInfo';

export interface OtioClipSpec {
  name: string;
  /** Media file name/url the clip cuts from. */
  mediaName: string | null;
  /** Frames into the source where the clip begins. */
  sourceIn: number;
  /** Timeline frame the bar starts at. */
  recordIn: number;
  duration: number;
}

export interface OtioTrackSpec {
  kind: 'Video' | 'Audio';
  name: string;
  clips: OtioClipSpec[];
}

const rt = (value: number, rate: number): Record<string, unknown> => ({
  OTIO_SCHEMA: 'RationalTime.1',
  rate,
  value,
});

const timeRange = (start: number, duration: number, rate: number): Record<string, unknown> => ({
  OTIO_SCHEMA: 'TimeRange.1',
  start_time: rt(start, rate),
  duration: rt(duration, rate),
});

/** Pure builder: track specs → an OTIO Timeline.1 document (plain object). */
export function otioTimeline(
  tracks: readonly OtioTrackSpec[],
  fps: number,
  title: string,
): Record<string, unknown> {
  return {
    OTIO_SCHEMA: 'Timeline.1',
    name: title,
    global_start_time: rt(0, fps),
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      children: tracks.map((track) => ({
        OTIO_SCHEMA: 'Track.1',
        kind: track.kind,
        name: track.name,
        children: track.clips
          .slice()
          .sort((a, b) => a.recordIn - b.recordIn)
          .flatMap((clip, i, sorted) => {
            const prevEnd = i === 0 ? 0 : sorted[i - 1]!.recordIn + sorted[i - 1]!.duration;
            const gap = clip.recordIn - prevEnd;
            const items: Array<Record<string, unknown>> = [];
            if (gap > 0) {
              items.push({ OTIO_SCHEMA: 'Gap.1', source_range: timeRange(0, gap, fps) });
            }
            items.push({
              OTIO_SCHEMA: 'Clip.1',
              name: clip.name,
              source_range: timeRange(clip.sourceIn, clip.duration, fps),
              media_reference: clip.mediaName
                ? { OTIO_SCHEMA: 'ExternalReference.1', target_url: clip.mediaName }
                : { OTIO_SCHEMA: 'MissingReference.1' },
            });
            return items;
          }),
      })),
    },
  };
}

/** Collect the active scene's clip bars into per-layer track specs. */
export function collectOtioTracks(): { tracks: OtioTrackSpec[]; fps: number } {
  const controller = getTimelineController();
  const fps = controller.timeline.getFrameRate().fps || 30;
  const assets = useAssetStore.getState().assets;
  const video: OtioTrackSpec[] = [];
  const audio: OtioTrackSpec[] = [];

  for (const node of flattenScene(defaultSceneGraph)) {
    const kind = readNodeKind(node);
    if (kind !== 'video' && kind !== 'audio' && kind !== 'image') continue;
    const layers = controller.getLayersForNode(node.id);
    if (layers.length === 0) continue;
    const assetId = assetIdOf(node);
    const asset = assetId ? assets.find((a) => a.id === assetId) : undefined;

    const clips: OtioClipSpec[] = [];
    for (const layer of layers) {
      if (layer.enabled === false) continue;
      clips.push({
        name: node.name ?? node.id,
        mediaName: asset?.name ?? null,
        sourceIn: layer.clip.sourceIn,
        recordIn: layer.clip.start,
        duration: layer.clip.duration,
      });
    }
    if (clips.length === 0) continue;
    const bucket = kind === 'audio' ? audio : video;
    bucket.push({
      kind: kind === 'audio' ? 'Audio' : 'Video',
      name: `${kind === 'audio' ? 'A' : 'V'}${bucket.length + 1} ${node.name ?? ''}`.trim(),
      clips,
    });
  }
  // Video tracks top-down (topmost layer = V1), matching how editors read.
  video.reverse();
  video.forEach((t, i) => { t.name = t.name.replace(/^V\d+/, `V${i + 1}`); });
  return { tracks: [...video, ...audio], fps };
}

export function exportOtioText(title = 'MOTION'): string {
  const { tracks, fps } = collectOtioTracks();
  return `${JSON.stringify(otioTimeline(tracks, fps, title), null, 2)}\n`;
}
