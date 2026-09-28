/**
 * Smart Animate over the engine: a transition composition is built from a copy
 * of the FROM board (neither board changes), matched layers tween toward the
 * TO board, and the whole build is one history entry.
 */

import type { Command as EngineCommand } from '@motion/engine-api';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { useProjectStore } from '@stores/projectStore';
import { smartAnimateBetweenEdit, transitionTargets } from './smartAnimateCommands';

let h: Harness & { engine: LocalEngine };
const A = 'comp_root';
let B: string;

const settle = async (): Promise<void> => {
  await engineIdle();
  await documentMirror().whenIdle();
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
const solid = async (comp: string, x: number): Promise<string> =>
  (await h.run({
    type: 'createLayer', comp, kind: 'solid', name: 'Card',
    init: [{ path: 'transform/position', value: { kind: 'vec2', value: { x, y: 100 } } }],
  } as EngineCommand) as { layer: string }).layer;

beforeEach(async () => {
  h = await setupAppEngine();
  await solid(A, 100);
  B = (await h.run({ type: 'createComposition', settings: { name: 'Board B', width: 1920, height: 1080 }, fromItems: [] } as EngineCommand) as { item: string }).item;
  await solid(B, 900);
  const actions = useProjectStore.getState().actions;
  actions.resetTabs();
  actions.openTab(A, [A], 'Main');
  await settle();
});
afterEach(async () => {
  await h.dispose();
});

it('offers the other boards as targets', () => {
  expect(transitionTargets().map((t) => t.id)).toEqual([B]);
});

it('builds the transition in a copy, tweening the matched layer, as one entry', async () => {
  const before = historyLabels().length;
  const r = await smartAnimateBetweenEdit(A, B, { startTime: 0, durationSec: 0.8, name: 'A to B' });
  await settle();
  expect(r).not.toBeNull();
  expect(r!.matched).toBe(1);
  expect(r!.keyframes).toBeGreaterThan(0);
  expect(historyLabels().length).toBe(before + 1);
  const m = documentMirror();
  expect(m.comp(r!.compId)?.settings.name).toBe('A to B');
  const layer = m.comp(r!.compId)!.layers[0]!;
  expect(m.keyframes(layer, 'transform/position').length).toBe(2);
  // The boards themselves are untouched.
  expect(m.keyframes(m.comp(A)!.layers[0]!, 'transform/position')).toEqual([]);
});
