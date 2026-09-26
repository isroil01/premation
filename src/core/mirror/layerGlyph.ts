/**
 * A layer's GLYPH from a mirror `LayerInfo` (B4) — the mirror twin of
 * `sceneDerive.nodeIconName`: the kind's mark, narrowed to the solid mark and
 * to the shape primitive (`LayerInfo.shapeType`), and replaced by a plugin
 * layer kind's own icon when the caller supplies one. Pure.
 */

import type { LayerInfo } from '@motion/engine-api';
import { KIND_ICON, SHAPE_TYPE_ICON } from '@core/scene/sceneDerive';
import { uiKindOf } from './layerKinds';

export function mirrorIconName(
  layer: Pick<LayerInfo, 'kind' | 'source' | 'shapeType' | 'generator'>,
  customIconOf?: (generator: string) => string | undefined,
): string {
  if (layer.generator) {
    const custom = customIconOf?.(layer.generator);
    if (custom) return custom;
  }
  const kind = uiKindOf(layer) ?? 'shape';
  if (kind !== 'shape') return KIND_ICON[kind];
  if (layer.kind === 'solid') return 'solid';
  return (layer.shapeType && SHAPE_TYPE_ICON[layer.shapeType]) || KIND_ICON.shape;
}
