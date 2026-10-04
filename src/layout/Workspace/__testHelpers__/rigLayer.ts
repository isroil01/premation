/**
 * A rig overlay test layer on the APP's engine (B3z WS-R): a real shape layer
 * in the root composition (so engine commands address it), at the comp origin,
 * with the box the overlay tests measure against and the starting rig (the
 * whole `layer/puppet` / `layer/skeleton`, as a rig preset writes it) set
 * through the engine.
 */

import type { Command } from '@motion/engine-api';
import { engineIdle } from '@core/engine/engineInstance';
import type { EngineRunner } from '@core/engine/__testHelpers__/appEngine';

export async function rigTestLayer(h: EngineRunner, opts: { width?: number; height?: number; puppet?: unknown; skeleton?: unknown } = {}): Promise<string> {
  const { layer } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name: 'Rig', init: [] });
  await h.run({ type: 'setProperty', prop: { layer, path: 'transform/position' }, value: { kind: 'vec2', value: { x: 0, y: 0 } } });
  await h.run({ type: 'setProperties', writes: [
    { prop: { layer, path: 'layer/width' }, value: { kind: 'scalar', value: opts.width ?? 200 } },
    { prop: { layer, path: 'layer/height' }, value: { kind: 'scalar', value: opts.height ?? 160 } },
  ] });
  for (const [path, v] of [['layer/puppet', opts.puppet], ['layer/skeleton', opts.skeleton]] as const) {
    if (v === undefined) continue;
    await h.run({ type: 'setProperty', prop: { layer, path }, value: { kind: 'json', value: JSON.stringify(v) } } as Command & { type: 'setProperty' });
  }
  await engineIdle();
  return layer;
}
