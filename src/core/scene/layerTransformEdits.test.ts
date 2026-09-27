/**
 * Flip and the numpad nudges as engine commands (B5 round 2): ONE entry each,
 * undone exactly by the engine, an animated Scale flipped on every key.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { flipLayersEdit, nudgeRotationEdit, nudgeScaleEdit } from './layerTransformOps';

let h: Harness & { engine: LocalEngine };
let s: Scene;
beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
});
afterEach(async () => { await h.dispose(); });

const stored = (id: string, prop: string): unknown =>
  defaultSceneGraph.getNode(id)!.components.find((c) => c.type === 'Transform')!.props[prop];

test('Flip Horizontal negates a static scale on one axis — one entry, exact undo', async () => {
  const before = h.doc();
  expect(await flipLayersEdit([s.B], 'horizontal')).toBe(true);
  expect(stored(s.B, 'scaleX')).toBe(-1);
  expect(stored(s.B, 'scaleY')).toBe(1);
  expect(historyLabels().at(-1)).toBe('Flip Horizontal');
  await h.run({ type: 'undo' });
  expect(h.doc()).toBe(before);
});

test('Flip on an animated Scale negates every key on the axis', async () => {
  await h.run({
    type: 'addKeyframes',
    keys: [
      { prop: { layer: s.B, path: 'transform/scale' }, time: 0, value: { kind: 'vec2', value: { x: 100, y: 100 } }, spatialIn: [], spatialOut: [] },
      { prop: { layer: s.B, path: 'transform/scale' }, time: 705_600_000, value: { kind: 'vec2', value: { x: 200, y: 100 } }, spatialIn: [], spatialOut: [] },
    ],
  });
  expect(await flipLayersEdit([s.B], 'horizontal')).toBe(true);
  expect(defaultAnimation.getTrackKeyframes(s.B, 'scaleX')!.map((k) => k.value)).toEqual([-1, -2]);
});

test('numpad rotate and scale are one entry each', async () => {
  const n = historyLabels().length;
  expect(await nudgeRotationEdit([s.B], 10)).toBe(true);
  expect(stored(s.B, 'rotation')).toBe(10);
  expect(await nudgeScaleEdit([s.B], 10)).toBe(true);
  expect(stored(s.B, 'scaleX')).toBeCloseTo(1.1);
  expect(historyLabels().slice(n)).toEqual(['Rotate', 'Scale']);
});
