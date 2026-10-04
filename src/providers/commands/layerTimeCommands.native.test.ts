/**
 * Layer ▸ Time commands over the engine: footage-only verbs target footage,
 * Time Stretch targets every layer, and each toggle is one entry that the
 * mirror reflects.
 */

import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { useSelectionStore } from '@stores/selectionStore';
import { buildLayerTimeCommands, stretchTargets, timeTargets } from './layerTimeCommands';

let h: Harness;
let s: Scene;

const settle = async (): Promise<void> => {
  await engineIdle();
  await documentMirror().whenIdle();
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
const byId = () => new Map(buildLayerTimeCommands().map((c) => [String(c.id), c]));
const run = async (id: string): Promise<void> => {
  void byId().get(id)!.execute({} as never);
  await settle();
};
const timing = () => documentMirror().layer(s.V)!.timing;

beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
  await settle();
  useSelectionStore.getState().set([s.V, s.B]);
});
afterEach(async () => {
  await h.dispose();
});

it('footage-only verbs target footage; Time Stretch every layer; Ctrl/Cmd+Alt+R is Time-Reverse Layer', async () => {
  expect(timeTargets()).toEqual([s.V]);
  expect(stretchTargets()).toEqual([s.V, s.B]);
  const cmds = byId();
  for (const id of ['time.reverseLayer', 'time.freezeFrame', 'time.freezeOnLastFrame', 'time.timeStretch', 'time.enableTimeRemap', 'time.frameBlend.mix']) {
    expect(cmds.get(id)?.enabled?.()).toBe(true);
  }
  expect(cmds.get('time.reverseLayer')?.shortcut).toEqual({ key: 'r', meta: true, alt: true });
  useSelectionStore.getState().set([s.B]);
  for (const c of cmds.values()) expect(c.enabled?.()).toBe(String(c.id) === 'time.timeStretch');
});

it('reverse, freeze, time remap and frame blend toggle through the engine, one entry each', async () => {
  await run('time.reverseLayer');
  expect(timing().stretch).toBeLessThan(0);
  expect((await historyLabels()).at(-1)).toBe('Time-Reverse Layer');
  await run('time.reverseLayer');
  expect(timing().stretch).toBeGreaterThan(0);

  await run('time.freezeFrame');
  expect(timing().freeze).toBeDefined();
  await run('time.freezeFrame');
  expect(timing().freeze).toBeUndefined();

  await run('time.enableTimeRemap');
  expect(timing().timeRemapEnabled).toBe(true);
  expect((await historyLabels()).at(-1)).toBe('Enable Time Remap');
  await run('time.enableTimeRemap');
  expect(timing().timeRemapEnabled).toBe(false);

  await run('time.frameBlend.pixelMotion');
  expect(documentMirror().layer(s.V)!.switches.frameBlend).toBe('pixelMotion');
  expect((await historyLabels()).at(-1)).toBe('Frame Blending');
});
