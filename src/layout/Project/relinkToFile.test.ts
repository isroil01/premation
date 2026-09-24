/**
 * Relink a missing layer source to a picked File through the engine: the file
 * is imported (its own entry), then the layer is repointed ("Relink") — both
 * undoable, the layer keeping its size.
 */

import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import { buildScene } from '@core/engine/__testHelpers__/scene';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { relinkToFileEdit } from './RelinkAssetsDialog';

let h: Harness & { engine: LocalEngine };
beforeEach(async () => { h = await setupAppEngine(); });
afterEach(async () => { await h.dispose(); });

const transform = (id: string): Record<string, unknown> =>
  defaultSceneGraph.getNode(id)!.components.find((c) => c.type === 'Transform')!.props as Record<string, unknown>;

it('imports the file and repoints the layer, keeping its size', async () => {
  const s = await buildScene(h);
  const size = [transform(s.V).width, transform(s.V).height];
  const before = h.doc();
  const n = historyLabels().length;
  const ok = await relinkToFileEdit(s.V, new File([new Uint8Array([1, 2, 3])], 'found.mp4', { type: 'video/mp4' }));
  await engineIdle();
  expect(ok).toBe(true);
  expect(historyLabels().slice(n)).toEqual(['Import File', 'Relink']);
  expect(transform(s.V).assetId).not.toBe(s.footage);
  expect([transform(s.V).width, transform(s.V).height]).toEqual(size);
  await h.run({ type: 'undo' });
  await h.run({ type: 'undo' });
  expect(h.doc()).toBe(before);
});
