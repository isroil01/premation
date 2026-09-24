/**
 * A rig overlay test layer on the APP's engine (B3z WS-R): a real shape layer
 * in the root composition (so engine commands address it), at the comp origin,
 * with the box the overlay tests measure against (set through the engine). The
 * starting rig is written directly — setup, not a UI write.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { engineIdle } from '@core/engine/engineInstance';
import type { Harness } from '@core/engine/__testHelpers__/harness';

export async function rigTestLayer(h: Harness, opts: { width?: number; height?: number; puppet?: unknown; skeleton?: unknown } = {}): Promise<string> {
  const { layer } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name: 'Rig', init: [] });
  await h.run({ type: 'setProperty', prop: { layer, path: 'transform/position' }, value: { kind: 'vec2', value: { x: 0, y: 0 } } });
  await h.run({ type: 'setProperties', writes: [
    { prop: { layer, path: 'layer/width' }, value: { kind: 'scalar', value: opts.width ?? 200 } },
    { prop: { layer, path: 'layer/height' }, value: { kind: 'scalar', value: opts.height ?? 160 } },
  ] });
  if (opts.puppet !== undefined) defaultSceneGraph.setPuppet(layer, opts.puppet);
  if (opts.skeleton !== undefined) defaultSceneGraph.setSkeleton(layer, opts.skeleton);
  await engineIdle();
  return layer;
}
