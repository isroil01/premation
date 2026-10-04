/**
 * Import 3D Model is ONE engine entry: the glTF layer tree laid into a
 * fragment and pasted, the root selected, undone exactly.
 */

import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { buildGltfModel } from '@core/scene/modelImport';
import { documentMirror } from '@stores/documentMirror';
import { useSelectionStore } from '@stores/selectionStore';
import { buildQuadGlb } from '@/__testHelpers__/buildTestGlb';
import { importModelEdit } from './modelImportEdits';

let h: Awaited<ReturnType<typeof setupAppEngine>>;
beforeEach(async () => { h = await setupAppEngine(); });
afterEach(async () => { await h.dispose(); });

it('pastes the model tree as one entry and selects its root', async () => {
  const before = (await h.doc());
  const n = (await historyLabels()).length;
  const bytes = buildQuadGlb();
  const r = await importModelEdit('Import quad.glb', (b, f) => buildGltfModel(b, f, bytes, 'quad.glb'));
  await engineIdle();
  expect(r?.layerCount).toBeGreaterThan(1);
  expect((await historyLabels()).slice(n)).toEqual(['Import quad.glb']);
  const [root] = useSelectionStore.getState().ids;
  expect(documentMirror().layer(root!)?.name).toBe('quad');
  // The root's children landed under it.
  expect(documentMirror().layerIds().some((id) => documentMirror().layer(id)?.parent === root)).toBe(true);
  await h.run({ type: 'undo' });
  expect((await h.doc())).toBe(before);
});
