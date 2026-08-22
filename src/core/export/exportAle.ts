/**
 * Avid Log Exchange (ALE) — text interchange Avid Media Composer actually imports.
 *
 * Binary AAF remains out of scope (CFB + object model). ALE carries the same
 * cut list as EDL/OTIO in a format Avid's importer eats without adapters.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { flattenScene, readNodeKind } from '@core/scene/sceneDerive';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useAssetStore } from '@stores/assetStore';
import { assetIdOf } from '@core/source/sourceInfo';
import { framesToTimecode } from './exportEdl';

export interface AleEvent {
  name: string;
  tracks: string;
  start: string;
  end: string;
  duration: string;
  tape: string;
  sourceFile: string;
}

function fpsOf(): number {
  return getTimelineController().timeline.getFrameRate().fps || 30;
}

/** Collect ALE rows from the active timeline clip bars. */
export function collectAleEvents(): { events: AleEvent[]; fps: number } {
  const controller = getTimelineController();
  const fps = fpsOf();
  const assets = useAssetStore.getState().assets;
  const events: AleEvent[] = [];
  let v = 0;
  let a = 0;

  for (const node of flattenScene(defaultSceneGraph)) {
    const kind = readNodeKind(node);
    if (kind !== 'video' && kind !== 'audio' && kind !== 'image') continue;
    const layers = controller.getLayersForNode(node.id);
    if (layers.length === 0) continue;
    const assetId = assetIdOf(node);
    const asset = assetId ? assets.find((x) => x.id === assetId) : undefined;
    const trackKind = kind === 'audio' ? 'A' : 'V';
    const trackNum = kind === 'audio' ? ++a : ++v;

    for (const layer of layers) {
      if (layer.enabled === false) continue;
      const start = layer.clip.start;
      const dur = layer.clip.duration;
      events.push({
        name: node.name ?? node.id,
        tracks: `${trackKind}${trackNum}`,
        start: framesToTimecode(start, fps),
        end: framesToTimecode(start + dur, fps),
        duration: framesToTimecode(dur, fps),
        tape: asset?.name?.replace(/\.[^.]+$/, '') || 'AX',
        sourceFile: asset?.name ?? '',
      });
    }
  }
  return { events, fps };
}

/** Pure ALE document builder. */
export function formatAle(events: readonly AleEvent[], fps: number): string {
  const heading = [
    'Heading',
    `FIELD_DELIM\tTABS`,
    `VIDEO_FORMAT\t${fps >= 29.97 && fps < 30 ? '1080' : '1080'}`,
    `FPS\t${fps}`,
    '',
    'Column',
    'Name\tTracks\tStart\tEnd\tDuration\tTape\tSource File',
    '',
    'Data',
  ];
  const rows = events.map(
    (e) =>
      `${e.name}\t${e.tracks}\t${e.start}\t${e.end}\t${e.duration}\t${e.tape}\t${e.sourceFile}`,
  );
  return [...heading, ...rows, ''].join('\n');
}

export function exportAleText(): string {
  const { events, fps } = collectAleEvents();
  return formatAle(events, fps);
}
