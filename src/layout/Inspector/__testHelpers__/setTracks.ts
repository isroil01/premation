/**
 * Test helper: write a layer's values by their legacy track names (`x`, `z`,
 * `focalLength`, `cornerRadius`…) through the engine — the writes the
 * Inspector composes (`trackWrites`, on the layer's property tree), sent as
 * one `setProperties`. What a fixture once wrote straight into the TypeScript
 * scene graph.
 */

import type { Command } from '@motion/engine-api';
import type { EngineRunner } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { trackWrites } from '../inspectorEdits';

export async function setTracks(h: EngineRunner, layer: string, values: Readonly<Record<string, number>>, seconds = 0): Promise<void> {
  await engineIdle();
  await documentMirror().loadTree(layer);
  const writes = trackWrites(layer, values, seconds);
  if (writes.length === 0) throw new Error(`setTracks: nothing to write for ${Object.keys(values).join(', ')} on ${layer}`);
  await h.run({ type: 'setProperties', writes } as Command & { type: 'setProperties' });
  await engineIdle();
  await documentMirror().whenIdle();
}
