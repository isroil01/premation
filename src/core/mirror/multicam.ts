/**
 * Multicam angles over the document mirror (B4 round 5): the layers of a
 * composition tagged as angles (`LayerInfo.multicamAngle`), by angle number,
 * and the media each one plays (`ItemInfo.mediaUrl` of its source). Pure: takes
 * a mirror reader, never touches the engine.
 */

import type { ItemInfo, LayerInfo } from '@motion/engine-api';

/** What this reader needs from the mirror. `DocumentMirror` is one. */
export interface MirrorMulticamRead {
  layerIds(): readonly string[];
  layer(id: string): LayerInfo | undefined;
  item(id: string): ItemInfo | undefined;
}

export interface MulticamAngle {
  id: string;
  angle: number;
  name: string;
  /** The playable media URL of the angle's footage, null when it has none. */
  src: string | null;
}

/** The angle layers of `comp` (every depth), sorted by angle number (stable). */
export function mirrorMulticamAngles(m: MirrorMulticamRead, comp: string): MulticamAngle[] {
  const out: MulticamAngle[] = [];
  for (const id of m.layerIds()) {
    const l = m.layer(id);
    if (!l || l.comp !== comp || l.multicamAngle === undefined) continue;
    const item = l.source ? m.item(l.source) : undefined;
    out.push({ id, angle: l.multicamAngle, name: l.name || id, src: item?.mediaUrl ?? null });
  }
  return out.sort((a, b) => a.angle - b.angle);
}
