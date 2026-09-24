/**
 * A footage layer's SOURCE size over the document mirror (B4) — the twin of
 * `trackerSource.sourceDisplaySize` (footageSourceOf's display width: the
 * stored width stretched by the interpreted pixel aspect; height untouched).
 * Pure: takes a mirror reader, never touches the engine.
 */

import type { ItemInfo, LayerInfo } from '@motion/engine-api';

/** What this reader needs from the mirror. `DocumentMirror` is one. */
export interface MirrorSourceRead {
  layer(id: string): LayerInfo | undefined;
  item(id: string): ItemInfo | undefined;
}

/** The layer's footage display size (px, PAR applied), or null when it has no sized footage source. */
export function mirrorSourceDisplaySize(m: MirrorSourceRead, layerId: string): { width: number; height: number } | null {
  const src = m.layer(layerId)?.source;
  const item = src ? m.item(src) : undefined;
  if (!item || item.kind !== 'footage') return null;
  const par = item.interpretation?.pixelAspect ?? 1;
  const width = Math.round(item.width * par);
  const height = item.height;
  return width > 0 && height > 0 ? { width, height } : null;
}
