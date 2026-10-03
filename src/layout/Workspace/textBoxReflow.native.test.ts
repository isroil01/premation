/**
 * The paragraph box handles' write side over the engine (B4: the pose from the
 * mirror, the parent matrix from getLayerTransforms): one drag is one entry,
 * the box widens and Position moves so the opposite edge stays put.
 */

import { waitFor } from '@testing-library/react';
import { clearHistory, setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { readTrack } from '@core/mirror/selection';
import { mirrorParagraphBox } from '@layout/Text/textMirror';
import { beginBoxReflow } from './textBoxReflow';

let h: Harness;
let T = '';
beforeEach(async () => {
  h = await setupAppEngine();
  T = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'text', name: 'T', init: [] })).layer;
  await h.run({
    type: 'setProperties',
    writes: [
      { prop: { layer: T, path: 'text/boxWidth' }, value: { kind: 'scalar', value: 200 } },
      { prop: { layer: T, path: 'text/boxHeight' }, value: { kind: 'scalar', value: 100 } },
      { prop: { layer: T, path: 'transform/position' }, value: { kind: 'vec2', value: { x: 400, y: 300 } } },
    ],
  });
  await documentMirror().loadTree(T);
  await engineIdle();
  await clearHistory();
});
afterEach(async () => { await h.dispose(); });

test('dragging the right handle widens a fixed box, keeps the left edge, one entry', async () => {
  expect(mirrorParagraphBox(documentMirror(), T)?.fixedHeight).toBe(true);
  const s = beginBoxReflow(T, 'e');
  expect(s).not.toBeNull();
  s!.update({ x: 30, y: 0 });
  s!.update({ x: 50, y: 0 });
  s!.end();
  await engineIdle();
  await new Promise((r) => setTimeout(r, 0));
  await engineIdle();
  const m = documentMirror();
  expect(mirrorParagraphBox(m, T)?.boxWidth).toBe(250);
  expect(readTrack(m, T, 'x', 0)).toBeCloseTo(425);
  // The gesture closes a few promise turns after end(): wait for its entry.
  await waitFor(async () => expect(await historyLabels()).toEqual(['Resize Text Box']));
});

test('a locked or point text layer takes no drag', async () => {
  const P = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'text', name: 'P', init: [] })).layer;
  await engineIdle();
  expect(beginBoxReflow(P, 'e')).toBeNull();
  await h.run({ type: 'setLayerSwitches', layers: [T], patch: { locked: true } });
  await engineIdle();
  expect(beginBoxReflow(T, 'e')).toBeNull();
});
