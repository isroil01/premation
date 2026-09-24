/**
 * Whether a timeline row's Reset has somewhere to go, over the document MIRROR
 * (B4) — the twin of `layerTransformOps.canResetProperties`. Pure: it takes a
 * mirror reader and never touches the engine.
 *
 * Reset is available when the layer is unlocked and EVERY prop behind the row
 * has a numeric rest value: a Transform default (`resetTransformWrites` — the
 * position is the comp centre, whose value does not matter for availability)
 * or the property registry's default.
 */

import type { LayerInfo } from '@motion/engine-api';
import { resetTransformWrites } from '@core/scene/layerTransformOps';
import { uiKindOf } from './layerKinds';
import { mirrorPropertyMeta } from './metaFacts';
import { trackRefIn, type MirrorTreeLike } from './trackIndex';

/** What the check reads. `DocumentMirror` is one. */
export interface MirrorResetRead {
  layer(id: string): LayerInfo | undefined;
  tree(id: string): MirrorTreeLike | undefined;
}

/** True when every prop behind a row has a numeric rest value to reset to (the twin of `canResetProperties`). */
export function mirrorCanResetProperties(m: MirrorResetRead, nodeId: string, props: ReadonlyArray<string>): boolean {
  const layer = m.layer(nodeId);
  if (!layer || layer.switches.locked || props.length === 0) return false;
  const tree = m.tree(nodeId);
  const defaults = resetTransformWrites({
    kind: uiKindOf(layer) ?? 'shape',
    is3D: layer.switches.threeD,
    hasOpacity: trackRefIn(tree, 'opacity') !== null,
    centre: { x: 0, y: 0 },
  });
  return props.every((p) => {
    if (defaults.some((w) => w.prop === p)) return true;
    return typeof mirrorPropertyMeta(p, layer, tree).defaultValue === 'number';
  });
}
