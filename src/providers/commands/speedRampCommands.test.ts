/**
 * Speed ramps over the engine: a ramp writes Speed % keys from the playhead
 * (current speed → target over the transition), composes with an earlier one,
 * keeps the keys before the playhead, refuses when there is no room, keeps a
 * Frame Number layer on its remap curve, and slowing turns Pixel Motion on.
 */

import { flicksToSeconds, secondsToFlicks, type Command as EngineCommand } from '@motion/engine-api';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { SPEED_PATH, REMAP_PATH } from '@core/mirror/retime';
import { numbersOfValue } from '@core/mirror/trackIndex';
import { documentMirror } from '@stores/documentMirror';
import { setTime } from '@stores/playbackClockStore';
import { useProjectStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { buildSpeedRampCommands, rampTargets } from './speedRampCommands';

let h: Harness & { engine: LocalEngine };
let s: Scene;

const settle = async (): Promise<void> => {
  await engineIdle();
  await documentMirror().whenIdle();
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
const ramp = async (suffix: string): Promise<void> => {
  void buildSpeedRampCommands().find((c) => String(c.id) === `time.speedRamp.${suffix}`)!.execute({} as never);
  for (let i = 0; i < 3; i++) await settle();
};
const playhead = (t: number): void => {
  const tab = useProjectStore.getState().activeTabId!;
  setTime(tab, t);
};
const speedKeys = () => documentMirror().keyframes(s.V, SPEED_PATH).map((k) => [flicksToSeconds(k.time), numbersOfValue(k.value)[0]]);

beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
  const actions = useProjectStore.getState().actions;
  actions.resetTabs();
  actions.openTab(s.comp, [s.comp], 'Main');
  await settle();
  useSelectionStore.getState().set([s.V, s.B]);
  playhead(0);
});
afterEach(async () => {
  await h.dispose();
});

it('targets layers with a source to retime', () => {
  expect(rampTargets()).toEqual([s.V]);
});

it('eases from full speed to the target at the playhead, and a second ramp starts where the first left', async () => {
  await ramp('quarter');
  expect(speedKeys()).toEqual([[0, 100], [0.5, 25]]);
  expect(historyLabels().at(-1)).toBe('Speed ramp to 25%');
  expect(documentMirror().layer(s.V)!.switches.frameBlend).toBe('pixelMotion');

  playhead(2);
  await ramp('normal');
  const keys = speedKeys();
  expect(keys.slice(0, 2)).toEqual([[0, 100], [0.5, 25]]);
  expect(keys[2]![0]).toBeCloseTo(2, 5);
  expect(keys[2]![1]).toBeCloseTo(25, 3);
  expect(keys[3]).toEqual([2.5, 100]);
});

it('does nothing when there is no room left for a ramp', async () => {
  const end = flicksToSeconds(documentMirror().comp(s.comp)!.settings.duration);
  playhead(end - 0.1);
  const n = historyLabels().length;
  await ramp('quarter');
  expect(historyLabels().length).toBe(n);
  expect(speedKeys()).toEqual([]);
});

it('keeps ramping the remap curve of a layer already in Frame Number mode', async () => {
  await h.run({ type: 'setRetime', layer: s.V, mode: 'frames' } as EngineCommand);
  await h.run({
    type: 'setKeyframes', prop: { layer: s.V, path: REMAP_PATH },
    keys: [0, 4].map((t) => ({ id: '', time: secondsToFlicks(t), value: { kind: 'scalar', value: t }, easing: 'linear', continuous: false, roving: false, spatialInterp: 'legacy', spatialIn: [], spatialOut: [], label: 0, dims: [] })),
  } as EngineCommand);
  await settle();
  playhead(1);
  await ramp('half');
  expect(documentMirror().layer(s.V)!.timing.retime).toBe('frames');
  expect(speedKeys()).toEqual([]);
  const remap = documentMirror().keyframes(s.V, REMAP_PATH);
  expect(remap.length).toBeGreaterThan(2);
  expect(flicksToSeconds(remap[0]!.time)).toBeCloseTo(0, 5);
});
