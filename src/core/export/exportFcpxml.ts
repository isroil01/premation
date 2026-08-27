/**
 * Final Cut Pro X XML (FCPXML) export — editorial cuts for Premiere / FCP / Resolve.
 *
 * Same clip-bar mapping as EDL/OTIO: no nested comps, no effects. FCPXML is the
 * XML interchange NLEs actually open; AAF remains a separate binary project.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { flattenScene, readNodeKind } from '@core/scene/sceneDerive';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useAssetStore } from '@stores/assetStore';
import { useCompositionStore } from '@stores/compositionStore';
import { assetIdOf } from '@core/source/sourceInfo';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The frame duration as an exact FCPXML rational, seconds = num/den.
 *
 * FCP and Premiere REQUIRE the NTSC family as 1001-based rationals: rounding
 * 29.97 to `1/30s` shifted every cut by one frame per ~33 seconds of timeline
 * and made drop-frame material read as non-drop. Every time value in the
 * document must be an integer multiple of this fraction.
 */
export function fcpFrameDuration(fps: number): { num: number; den: number } {
  const ntsc: ReadonlyArray<{ fps: number; den: number }> = [
    { fps: 23.976, den: 24000 },
    { fps: 29.97, den: 30000 },
    { fps: 59.94, den: 60000 },
  ];
  for (const r of ntsc) {
    if (Math.abs(fps - r.fps) < 0.005) return { num: 1001, den: r.den };
  }
  if (Number.isInteger(fps) && fps > 0) return { num: 1, den: fps };
  // Arbitrary fractional rate: hundredths of a frame is exact for anything a
  // comp settings dialog accepts (two decimal places).
  const den = Math.round((fps || 30) * 100);
  return { num: 100, den: den > 0 ? den : 3000 };
}

export interface FcpxmlClip {
  name: string;
  mediaName: string;
  /** Source in, frames. */
  sourceIn: number;
  /** Record in, frames. */
  recordIn: number;
  duration: number;
  kind: 'video' | 'audio' | 'image';
}

/** Pure builder: clips → FCPXML 1.9 document string. */
export function buildFcpxml(
  clips: readonly FcpxmlClip[],
  fps: number,
  title: string,
  size?: { width: number; height: number },
): string {
  const { num, den } = fcpFrameDuration(fps || 30);
  /** `frames` frames as an FCPXML rational time string. */
  const t = (frames: number): string => `${frames * num}/${den}s`;
  const total = clips.reduce((m, c) => Math.max(m, c.recordIn + c.duration), 0);

  // r1 is the sequence's REAL <format> resource. It used to point at the first
  // asset — Resolve rejected the file and FCP guessed a rate.
  const FORMAT_ID = 'r1';
  const assets = new Map<string, { id: string; hasVideo: boolean; hasAudio: boolean }>();
  for (const c of clips) {
    const entry = assets.get(c.mediaName) ?? { id: `r${assets.size + 2}`, hasVideo: false, hasAudio: false };
    // Honest per-kind flags: an audio-only asset declared hasVideo="1" made
    // NLEs hunt for a video stream that does not exist.
    if (c.kind === 'audio') entry.hasAudio = true;
    else if (c.kind === 'image') entry.hasVideo = true;
    else { entry.hasVideo = true; entry.hasAudio = true; }
    assets.set(c.mediaName, entry);
  }

  const sizeAttrs = size ? ` width="${Math.round(size.width)}" height="${Math.round(size.height)}"` : '';
  const formatXml = `    <format id="${FORMAT_ID}" name="FFVideoFormatRateUndefined" frameDuration="${num}/${den}s"${sizeAttrs} />`;

  const assetXml = [...assets.entries()].map(([name, a]) => (
    `    <asset id="${a.id}" name="${esc(name)}"${a.hasVideo ? ' hasVideo="1"' : ''}${a.hasAudio ? ' hasAudio="1"' : ''} />`
  )).join('\n');

  const spine = clips
    .slice()
    .sort((a, b) => a.recordIn - b.recordIn)
    .map((c) => {
      const ref = assets.get(c.mediaName)?.id ?? 'r2';
      return `        <asset-clip ref="${ref}" name="${esc(c.name)}" offset="${t(c.recordIn)}" duration="${t(c.duration)}" start="${t(c.sourceIn)}" tcFormat="NDF" />`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
  <resources>
${formatXml}
${assetXml}
  </resources>
  <library>
    <event name="${esc(title)}">
      <project name="${esc(title)}">
        <sequence format="${FORMAT_ID}" duration="${t(total)}" tcStart="0/1s" tcFormat="NDF">
          <spine>
${spine}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}

export function collectFcpxmlClips(): { clips: FcpxmlClip[]; fps: number } {
  const controller = getTimelineController();
  const fps = controller.timeline.getFrameRate().fps || 30;
  const assets = useAssetStore.getState().assets;
  const clips: FcpxmlClip[] = [];

  for (const node of flattenScene(defaultSceneGraph)) {
    const kind = readNodeKind(node);
    if (kind !== 'video' && kind !== 'audio' && kind !== 'image') continue;
    const layers = controller.getLayersForNode(node.id);
    if (layers.length === 0) continue;
    const assetId = assetIdOf(node);
    const asset = assetId ? assets.find((a) => a.id === assetId) : undefined;
    const mediaName = asset?.name ?? `${node.name ?? node.id}.mov`;

    for (const layer of layers) {
      if (layer.enabled === false) continue;
      clips.push({
        name: node.name ?? node.id,
        mediaName,
        sourceIn: layer.clip.sourceIn,
        recordIn: layer.clip.start,
        duration: layer.clip.duration,
        kind: kind === 'audio' ? 'audio' : kind === 'image' ? 'image' : 'video',
      });
    }
  }
  return { clips, fps };
}

export function exportFcpxmlText(title = 'MOTION'): string {
  const { clips, fps } = collectFcpxmlClips();
  const comp = useCompositionStore.getState().comp();
  return buildFcpxml(clips, fps, title, { width: comp.width, height: comp.height });
}
