/**
 * A layer's paint strokes over the document MIRROR (B4 round 6): the
 * `paint/<id>` groups of its property tree — the stroke's AE name ("Brush 1",
 * "Eraser 2"), its mode (`paint:<mode>` match name), its video switch
 * (`enabled`) — whether its Path is keyed, and Paint on Transparent
 * (`layer/paintOnTransparent`). Pure over a mirror reader.
 */

import type { Keyframe, PropertyInfo } from '@motion/engine-api';
import { plainValue, type MirrorTreeLike } from './trackIndex';

export interface MirrorPaintStroke {
  id: string;
  name: string;
  mode: string;
  visible: boolean;
  /** The Path has keyframes (the stopwatch is on). */
  pathKeyed: boolean;
}

export interface MirrorPaintRead {
  tree(layer: string): MirrorTreeLike | undefined;
  keyframes(layer: string, path: string): readonly Keyframe[];
}

/** The layer's strokes, stored order; [] when it has none (or the tree has not arrived). */
export function mirrorPaintStrokes(m: MirrorPaintRead, layer: string): MirrorPaintStroke[] {
  const tree = m.tree(layer);
  const root = tree?.nodes.get('paint');
  if (!tree || !root) return [];
  const out: MirrorPaintStroke[] = [];
  for (const path of root.children) {
    const g: PropertyInfo | undefined = tree.nodes.get(path);
    if (!g) continue;
    const id = path.slice('paint/'.length);
    out.push({
      id,
      name: g.name,
      mode: g.matchName.startsWith('paint:') ? g.matchName.slice('paint:'.length) : 'paint',
      visible: g.enabled,
      pathKeyed: tree.nodes.get(`${path}/path`)?.animated === true || m.keyframes(layer, `${path}/path`).length > 0,
    });
  }
  return out;
}

/** Paint on Transparent (`layer/paintOnTransparent`); false when the layer has no paint. */
export function mirrorPaintOnTransparent(tree: MirrorTreeLike | undefined): boolean {
  return plainValue(tree?.nodes.get('layer/paintOnTransparent')?.value) === true;
}
