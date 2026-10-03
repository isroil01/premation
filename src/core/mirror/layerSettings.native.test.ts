/**
 * Layer / Solid Settings from the mirror (B4) equal the stored-record readers
 * they replaced (`readLayerSettings`, `nextSolidName`).
 */

import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { nextSolidName, readLayerSettings } from '@core/scene/layerSettings';
import { mirrorLayerSettings, mirrorNextSolidName } from './layerSettings';

let h: Harness;
beforeEach(async () => { h = await setupAppEngine(); });
afterEach(async () => { await h.dispose(); });

async function layer(kind: 'solid' | 'null' | 'text' | 'shape', name: string): Promise<string> {
  return (await h.run({ type: 'createLayer', comp: 'comp_root', kind, name, init: [] })).layer;
}

test('solid, sized null, plain text and a labelled layer read as the stored records do', async () => {
  const solid = await layer('solid', 'Matte');
  await h.run({ type: 'setProperty', prop: { layer: solid, path: 'layer/fill' }, value: { kind: 'color', value: { r: 0, g: 1, b: 0, a: 1 } } });
  const nul = await layer('null', 'Ctrl');
  const text = await layer('text', 'Title');
  await h.run({ type: 'setLayerSwitches', layers: [text], patch: { label: 3 } });
  const shape = await layer('shape', 'Box');
  await h.run({ type: 'setLayerSwitches', layers: [shape], patch: { labelColor: '#123456' } });
  await engineIdle();
  const m = documentMirror();
  for (const id of [solid, nul, text, shape]) {
    expect(mirrorLayerSettings(m, id)).toEqual(readLayerSettings(id));
  }
  expect(mirrorLayerSettings(m, 'nope')).toBeNull();
  expect(mirrorNextSolidName(m)).toBe(nextSolidName());
});
