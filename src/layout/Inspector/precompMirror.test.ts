/**
 * B4: the Pre-composition section's reads come from the MIRROR
 * (core/mirror/compOverrides.ts, core/mirror/continuousRaster.ts). Pinned on
 * the app engine against the scene readers they replace.
 */

import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { supportsContinuousRaster } from '@core/scene/continuousRaster';
import { documentMirror } from '@stores/documentMirror';
import { mirrorSupportsContinuousRaster } from '@core/mirror/continuousRaster';
import { inheritedOverrideValue, overrideSourceLayers } from '@core/mirror/compOverrides';
import { childOrderOf } from '@core/mirror/layerTree';

jest.useFakeTimers();

let h: Harness & { engine: LocalEngine };
let s: Scene;
beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
  await engineIdle();
});
afterEach(async () => {
  await h.dispose();
});

test('the Continuous Rasterization switch is offered where supportsContinuousRaster offers it', async () => {
  const { layer: ellipse } = await h.run({ type: 'createLayer', comp: s.comp, kind: 'ellipse', name: 'E', init: [] });
  await engineIdle();
  const m = documentMirror();
  for (const id of [s.A, s.B, s.T, s.V, s.P, ellipse]) {
    m.tree(id);
    expect([id, mirrorSupportsContinuousRaster(m, id)]).toEqual([id, supportsContinuousRaster(defaultSceneGraph.getNode(id))]);
  }
  expect(mirrorSupportsContinuousRaster(m, s.T)).toBe(true);
  expect(mirrorSupportsContinuousRaster(m, ellipse)).toBe(true);
});

test('a placed composition: its source layers and their inherited values', async () => {
  await h.run({ type: 'createLayer', comp: s.comp, kind: 'precomp', name: 'C2', source: s.comp2, init: [] });
  await engineIdle();
  const m = documentMirror();
  // The referenced comp's layers, in the scene graph's child order.
  expect(childOrderOf(m, s.comp2)).toEqual(defaultSceneGraph.getChildren(s.comp2).map((n) => n.id));
  expect(overrideSourceLayers(m, s.comp2).map((l) => l.id)).toEqual([s.c2layer]);

  // Inherited values: stored units (scale 1 = 100 %, opacity in %), static here.
  m.tree(s.c2layer);
  expect(inheritedOverrideValue(m, s.c2layer, 'scaleX', 0)).toBeCloseTo(1, 9);
  expect(inheritedOverrideValue(m, s.c2layer, 'opacity', 0)).toBeCloseTo(100, 9);
  expect(typeof inheritedOverrideValue(m, s.c2layer, 'x', 0)).toBe('number');
});
