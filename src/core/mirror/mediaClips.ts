/**
 * The footage clips an interchange export lists (EDL, ALE, FCPXML, OTIO) —
 * every video / audio / image layer of a composition that has a clip bar,
 * with its bar in frames and the media it plays, read from the document
 * mirror (block 3: the exporters used to walk the page replica and the
 * TypeScript timeline controller's bars).
 */

import type { CompSettings, ItemInfo, LayerInfo } from '@motion/engine-api';
import { flattenCompLayers, type MirrorCompLayersRead } from './compLayers';
import { mirrorHasBar } from './clipBars';
import { settingsFps, timingBarFrames } from './compFacts';
import { uiKindOf } from './layerKinds';

/** What the collector reads from the mirror. `DocumentMirror` is one. */
export interface MirrorMediaRead extends MirrorCompLayersRead {
  layer(id: string): LayerInfo | undefined;
  comp(id: string): { readonly layers: readonly string[]; readonly settings?: CompSettings } | undefined;
  item(id: string): ItemInfo | undefined;
}

export interface MediaClip {
  /** The layer. */
  nodeId: string;
  name: string;
  kind: 'video' | 'audio' | 'image';
  /** The footage item's name (its file name), or null without a source item. */
  mediaName: string | null;
  /** The footage item, or null. */
  itemId: string | null;
  /** Bar start on the comp axis, frames. */
  start: number;
  duration: number;
  /** Source frame at the bar's start. */
  sourceIn: number;
}

/** The composition's footage clips, back to front, and the frame rate their frames count in. */
export function mirrorMediaClips(m: MirrorMediaRead, compId: string): { fps: number; clips: MediaClip[] } {
  const fps = settingsFps(m.comp(compId)?.settings) || 30;
  const clips: MediaClip[] = [];
  for (const id of flattenCompLayers(m, compId)) {
    const l = m.layer(id);
    const kind = uiKindOf(l);
    if (!l || (kind !== 'video' && kind !== 'audio' && kind !== 'image')) continue;
    // The bar's enabled flag mirrored the layer's visibility.
    if (!mirrorHasBar(m, id) || !l.switches.visible) continue;
    const bar = timingBarFrames(l.timing, fps);
    const item = l.source ? m.item(l.source) : undefined;
    clips.push({
      nodeId: id,
      name: l.name || id,
      kind,
      mediaName: item?.name ?? null,
      itemId: l.source ?? null,
      start: bar.start,
      duration: bar.duration,
      sourceIn: bar.sourceIn,
    });
  }
  return { fps, clips };
}
