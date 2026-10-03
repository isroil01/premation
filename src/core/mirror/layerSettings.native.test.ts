/**
 * Layer / Solid Settings from the mirror (B4): what each kind of layer reads
 * as, and the next solid's name.
 */

import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
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
  for (const id of [solid, nul, text, shape]) await m.loadTree(id);
  // A solid: comp-sized, its fill. A null: its box. Text and shapes: plain, a palette label read as its colour.
  expect(mirrorLayerSettings(m, solid)).toEqual({ kind: 'solid', values: { name: 'Matte', width: 1920, height: 1080, color: '#00ff00' } });
  expect(mirrorLayerSettings(m, nul)).toEqual({ kind: 'sized', values: { name: 'Ctrl', width: 100, height: 100 } });
  expect(mirrorLayerSettings(m, text)).toEqual({ kind: 'plain', values: { name: 'Title', labelColor: '#d0705a' } });
  expect(mirrorLayerSettings(m, shape)).toEqual({ kind: 'plain', values: { name: 'Box', labelColor: '#123456' } });
  expect(mirrorLayerSettings(m, 'nope')).toBeNull();
  // One solid in the document: the next is "Solid 2".
  expect(mirrorNextSolidName(m)).toBe('Solid 2');
});
