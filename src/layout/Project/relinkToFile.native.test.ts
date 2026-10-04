/**
 * Relink a missing layer source to a picked File through the engine: the file
 * is imported (its own entry), then the layer is repointed ("Relink") — both
 * undoable, the layer keeping its size.
 */

import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { buildScene } from '@core/engine/__testHelpers__/scene';
import { engineIdle } from '@core/engine/engineInstance';
import { relinkToFileEdit } from './RelinkAssetsDialog';

let h: Harness;
beforeEach(async () => { h = await setupAppEngine(); });
afterEach(async () => { await h.dispose(); });

const transform = async (id: string): Promise<Record<string, unknown>> =>
  (await docView()).getNode(id)!.components.find((c) => c.type === 'Transform')!.props as Record<string, unknown>;

it('imports the file and repoints the layer, keeping its size', async () => {
  const s = await buildScene(h);
  const size = [(await transform(s.V)).width, (await transform(s.V)).height];
  const before = (await h.doc());
  const n = (await historyLabels()).length;
  const ok = await relinkToFileEdit(s.V, new File([new Uint8Array([1, 2, 3])], 'found.mp4', { type: 'video/mp4' }));
  await engineIdle();
  expect(ok).toBe(true);
  expect((await historyLabels()).slice(n)).toEqual(['Import File', 'Relink']);
  expect((await transform(s.V)).assetId).not.toBe(s.footage);
  expect([(await transform(s.V)).width, (await transform(s.V)).height]).toEqual(size);
  await h.run({ type: 'undo' });
  await h.run({ type: 'undo' });
  expect((await h.doc())).toBe(before);
});
