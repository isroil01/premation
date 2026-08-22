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
import { assetIdOf } from '@core/source/sourceInfo';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function rateXml(fps: number): string {
  const n = Math.round(fps);
  return `<frameDuration>1/${n}s</frameDuration>`;
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
export function buildFcpxml(clips: readonly FcpxmlClip[], fps: number, title: string): string {
  const n = Math.round(fps) || 30;
  const total = clips.reduce((m, c) => Math.max(m, c.recordIn + c.duration), 0);
  const assets = new Map<string, string>();
  for (const c of clips) {
    if (!assets.has(c.mediaName)) assets.set(c.mediaName, `r${assets.size + 1}`);
  }

  const assetXml = [...assets.entries()].map(([name, id]) => (
    `    <asset id="${id}" name="${esc(name)}" hasVideo="1" hasAudio="1" />`
  )).join('\n');

  const spine = clips
    .slice()
    .sort((a, b) => a.recordIn - b.recordIn)
    .map((c) => {
      const ref = assets.get(c.mediaName) ?? 'r1';
      const offset = `${c.recordIn}/${n}s`;
      const dur = `${c.duration}/${n}s`;
      const start = `${c.sourceIn}/${n}s`;
      return `        <asset-clip ref="${ref}" name="${esc(c.name)}" offset="${offset}" duration="${dur}" start="${start}" tcFormat="NDF" />`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
  <resources>
${assetXml}
  </resources>
  <library>
    <event name="${esc(title)}">
      <project name="${esc(title)}">
        <sequence format="r1" duration="${total}/${n}s" tcStart="0/1s" tcFormat="NDF">
          ${rateXml(n)}
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
  return buildFcpxml(clips, fps, title);
}
