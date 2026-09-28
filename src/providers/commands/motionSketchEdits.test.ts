/**
 * Motion Sketch's write over the engine: the take lands on Position as one
 * entry, one key per recorded sample at composition time, replacing the keys
 * inside the recorded span and keeping the ones outside it.
 */

import { flicksToSeconds, secondsToFlicks, type Command as EngineCommand } from '@motion/engine-api';
import { armMotionSketch, recordMotionSketchSample } from '@core/animation/motionSketch';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { numbersOfValue } from '@core/mirror/trackIndex';
import { documentMirror } from '@stores/documentMirror';
import { finishMotionSketchEdit } from './motionSketchEdits';

let h: Harness & { engine: LocalEngine };
let ID: string;

const settle = async (): Promise<void> => {
  await engineIdle();
  await documentMirror().whenIdle();
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

beforeEach(async () => {
  h = await setupAppEngine();
  ID = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'S', init: [] } as EngineCommand) as { layer: string }).layer;
  await h.run({
    type: 'addKeyframes',
    keys: [0.2, 5].map((t) => ({ prop: { layer: ID, path: 'transform/position' }, time: secondsToFlicks(t), value: { kind: 'vec2', value: { x: 1, y: 1 } }, spatialIn: [], spatialOut: [] })),
  } as EngineCommand);
  await settle();
  documentMirror().tree(ID);
  await settle();
});
afterEach(async () => {
  await h.dispose();
});

it('writes one key per sample on Position, one entry, replacing only the keys inside the span', async () => {
  armMotionSketch(ID);
  recordMotionSketchSample(ID, 10, 20, 0);
  recordMotionSketchSample(ID, 30, 40, 0.5);
  recordMotionSketchSample(ID, 50, 60, 1);
  const n = await finishMotionSketchEdit();
  await settle();
  expect(n).toBe(3);
  expect(historyLabels().at(-1)).toBe('Motion Sketch');
  const keys = documentMirror().keyframes(ID, 'transform/position').map((k) => [flicksToSeconds(k.time), ...numbersOfValue(k.value).slice(0, 2)]);
  expect(keys).toEqual([[0, 10, 20], [0.5, 30, 40], [1, 50, 60], [5, 1, 1]]);
});

it('writes nothing when nothing was recorded', async () => {
  armMotionSketch(ID);
  expect(await finishMotionSketchEdit()).toBe(0);
});
