/**
 * CMX 3600-style EDL export — timeline clip events as plain text for NLEs.
 *
 * Not a full AAF: no nested comps, no audio channel maps, no reel metadata
 * from camera cards. Reel names come from the asset file stem; source/record
 * times come from clip bars + fps.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { flattenScene, readNodeKind } from '@core/scene/sceneDerive';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useAssetStore } from '@stores/assetStore';
import { assetIdOf } from '@core/source/sourceInfo';

function pad2(n: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0');
}

/** Frames → HH:MM:SS:FF at the given fps (non-drop). */
export function framesToTimecode(frames: number, fps: number): string {
  const f = Math.max(0, Math.round(frames));
  const ff = f % Math.round(fps);
  const totalSec = Math.floor(f / Math.round(fps));
  const ss = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const mm = totalMin % 60;
  const hh = Math.floor(totalMin / 60);
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}:${pad2(ff)}`;
}

function reelName(assetName: string): string {
  const stem = assetName.replace(/\.[a-z0-9]+$/i, '') || assetName;
  // CMX reel is typically ≤8 chars, uppercase, no spaces.
  return stem.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase() || 'AX';
}

export interface EdlEvent {
  event: number;
  reel: string;
  track: 'V' | 'A';
  transition: 'C';
  sourceIn: string;
  sourceOut: string;
  recordIn: string;
  recordOut: string;
  comment?: string;
}

/**
 * Build CMX-style events for every video/audio clip bar in the active scene.
 */
export function buildEdlEvents(title = 'MOTION'): { title: string; fps: number; events: EdlEvent[] } {
  const controller = getTimelineController();
  const fps = controller.timeline.getFrameRate().fps || 30;
  const assets = useAssetStore.getState().assets;
  const events: EdlEvent[] = [];
  let eventNum = 1;

  for (const node of flattenScene(defaultSceneGraph)) {
    const kind = readNodeKind(node);
    if (kind !== 'video' && kind !== 'audio' && kind !== 'image') continue;
    const layers = controller.getLayersForNode(node.id);
    if (layers.length === 0) continue;
    const assetId = assetIdOf(node);
    const asset = assetId ? assets.find((a) => a.id === assetId) : undefined;
    const reel = reelName(asset?.name ?? node.name ?? 'CLIP');
    const track: 'V' | 'A' = kind === 'audio' ? 'A' : 'V';

    for (const layer of layers) {
      if (layer.enabled === false) continue;
      const srcIn = layer.clip.sourceIn;
      const srcOut = layer.clip.sourceIn + layer.clip.duration;
      const recIn = layer.clip.start;
      const recOut = layer.clip.start + layer.clip.duration;
      events.push({
        event: eventNum++,
        reel,
        track,
        transition: 'C',
        sourceIn: framesToTimecode(srcIn, fps),
        sourceOut: framesToTimecode(srcOut, fps),
        recordIn: framesToTimecode(recIn, fps),
        recordOut: framesToTimecode(recOut, fps),
        comment: `* FROM CLIP NAME: ${node.name}`,
      });
    }
  }

  return { title, fps, events };
}

/** Serialize events to a CMX 3600-ish .edl string. */
export function formatEdl(title: string, events: readonly EdlEvent[]): string {
  const lines: string[] = [`TITLE: ${title}`, 'FCM: NON-DROP FRAME', ''];
  for (const e of events) {
    const num = String(e.event).padStart(3, '0');
    lines.push(
      `${num}  ${e.reel.padEnd(8, ' ')} ${e.track}     ${e.transition}        `
      + `${e.sourceIn} ${e.sourceOut} ${e.recordIn} ${e.recordOut}`,
    );
    if (e.comment) lines.push(e.comment);
  }
  return `${lines.join('\n')}\n`;
}

export function exportEdlText(title = 'MOTION'): string {
  const { title: t, events } = buildEdlEvents(title);
  return formatEdl(t, events);
}
