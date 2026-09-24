/**
 * "ID matte: <object>" through the engine: the baked PNG is imported from its
 * bytes, inserted directly above the EXR layer and set as its luma matte by
 * reference — and undo takes the matte layer and the matte away exactly.
 */

import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { layerIdsOfComp } from '@core/engine/doc';
import { useAssetStore } from '@stores/assetStore';
import { documentMirror } from '@stores/documentMirror';
import { createIdMatteLayerEdit } from './idMatteEdits';

jest.mock('@core/media/cryptomatte', () => ({
  getCryptomatteForAsset: () => ({ layers: [] }),
  idMattePngFile: async () => new File([new Uint8Array([137, 80, 78, 71])], 'EXR — ID matte (Car).png', { type: 'image/png' }),
}));

let h: Harness & { engine: LocalEngine };
let s: Scene;
beforeEach(async () => {
  h = await setupAppEngine();
  documentMirror().start();
  s = await buildScene(h);
  await documentMirror().whenIdle();
});
afterEach(async () => { await h.dispose(); });

test('imports the PNG, lands the matte above the layer and sets it as its luma matte', async () => {
  const beforeDoc = h.doc();
  const n = historyLabels().length;
  const matte = await createIdMatteLayerEdit(s.V, 'CryptoObject', ['Car']);
  await engineIdle();
  expect(matte).toBeTruthy();
  expect(historyLabels().slice(n)).toEqual(['Import ID Matte', 'ID Matte']);
  expect(useAssetStore.getState().assets.some((a) => a.name === 'EXR — ID matte (Car).png')).toBe(true);

  const stack = layerIdsOfComp(s.comp);
  expect(stack.indexOf(matte!)).toBe(stack.indexOf(s.V) - 1);
  const { layers: [info] } = await h.query({ type: 'getLayers', layers: [s.V] });
  expect(info?.matte).toMatchObject({ layer: matte, mode: 'luma' });

  await h.run({ type: 'undo' });
  await h.run({ type: 'undo' });
  expect(h.doc()).toBe(beforeDoc);
});
