/**
 * `mirrorLayerStyles` (B4): the Layer Styles section's record read from the
 * mirror's `styles/<key>` groups equals the stored style set it replaced
 * (`getNodeLayerStyles`) — every field, in the record's units.
 */

import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { getNodeLayerStyles } from '@core/effects/layerStyles';
import { documentMirror } from '@stores/documentMirror';
import { engineIdle } from '@core/engine/engineInstance';
import { mirrorLayerStyles } from './layerFacts';

const STYLES = ['glass', 'dropShadow', 'outerGlow', 'innerShadow', 'innerGlow', 'satin', 'bevel', 'colorOverlay', 'gradientOverlay', 'stroke'];

let h: Harness;
beforeEach(async () => { h = await setupAppEngine(); });
afterEach(async () => { await h.dispose(); });

function expectSame(actual: unknown, expected: unknown): void {
  if (typeof expected === 'number') {
    expect(actual).toBeCloseTo(expected, 9);
    return;
  }
  if (expected && typeof expected === 'object') {
    expect(Object.keys(actual as object).sort()).toEqual(Object.keys(expected).sort());
    for (const [k, v] of Object.entries(expected)) expectSame((actual as Record<string, unknown>)[k], v);
    return;
  }
  expect(actual).toEqual(expected);
}

test('every style, with edited values and a disabled one, reads back as the stored record', async () => {
  const L = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name: 'S', init: [] })).layer;
  for (const k of STYLES) await h.run({ type: 'addPropertyGroup', layer: L, parent: 'styles', matchName: `style:${k}`, init: [] });
  await h.run({
    type: 'setProperties',
    writes: [
      { prop: { layer: L, path: 'styles/dropShadow/opacity' }, value: { kind: 'scalar', value: 30 } },
      { prop: { layer: L, path: 'styles/dropShadow/softness' }, value: { kind: 'scalar', value: 12 } },
      { prop: { layer: L, path: 'styles/gradientOverlay/colorB' }, value: { kind: 'color', value: { r: 1, g: 0, b: 0, a: 1 } } },
      { prop: { layer: L, path: 'styles/bevel/direction' }, value: { kind: 'choice', value: 'down' } },
      { prop: { layer: L, path: 'styles/glass/tintOpacity' }, value: { kind: 'scalar', value: 0.25 } },
    ],
  });
  await h.run({ type: 'setGroupEnabled', groups: [{ layer: L, path: 'styles/satin' }], enabled: false });
  documentMirror().tree(L);
  await engineIdle();
  const tree = documentMirror().tree(L);
  expect(tree).toBeDefined();
  expectSame(mirrorLayerStyles(tree), getNodeLayerStyles(L));
});

test('a layer with no styles reads as none', async () => {
  const L = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'S', init: [] })).layer;
  documentMirror().tree(L);
  await engineIdle();
  expect(mirrorLayerStyles(documentMirror().tree(L))).toEqual({});
});
