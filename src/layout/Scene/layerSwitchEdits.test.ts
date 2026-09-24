/**
 * B3 reference migration: the Layers panel's eye / lock / solo / shy switches
 * are `setLayerSwitches` commands — anchored on the clicked row, one undo entry
 * for the whole selection, undone exactly by the engine's recorded inverse.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { useMotionBlurStore } from '@stores/motionBlurStore';
import { activeCompIdNow } from '@hooks/useMirror';
import { switchCommands, toggleLayerFlagsEdit, toggleLayerSwitchAnchored } from './layerSwitchEdits';

jest.useFakeTimers();

let h: Harness & { engine: LocalEngine };
let s: Scene;
beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
  useSelectionStore.getState().set([]);
});
afterEach(async () => { await h.dispose(); });

const node = (id: string): Record<string, unknown> => defaultSceneGraph.getNode(id) as unknown as Record<string, unknown>;

test('an unselected row toggles only itself — one entry, undoable', async () => {
  useSelectionStore.getState().set([s.A, s.B]);
  const doc = h.doc();
  await toggleLayerSwitchAnchored(s.T, 'visible');
  expect(node(s.T).visible).toBe(false);
  expect(node(s.A).visible).toBe(true);
  expect(historyLabels().at(-1)).toBe('Hide layer');
  await h.run({ type: 'undo' });
  expect(h.doc()).toBe(doc);
});

test('a selected row applies the CLICKED row\'s direction to the whole selection, as one entry', async () => {
  await h.run({ type: 'setLayerSwitches', layers: [s.A], patch: { locked: true } });
  useSelectionStore.getState().set([s.A, s.B]);
  const n = historyLabels().length;
  // B is unlocked → "Lock" for both (A stays locked, not inverted).
  await toggleLayerSwitchAnchored(s.B, 'locked');
  expect(node(s.A).locked).toBe(true);
  expect(node(s.B).locked).toBe(true);
  expect(historyLabels().length).toBe(n + 1);
  expect(historyLabels().at(-1)).toBe('Lock layer (2 layers)');
  await h.run({ type: 'undo' });
  expect(node(s.A).locked).toBe(true);
  expect(node(s.B).locked).toBe(false);
});

test('solo and shy round-trip through undo/redo; shy is document state (§2.5 #1)', async () => {
  await toggleLayerSwitchAnchored(s.A, 'solo');
  await toggleLayerSwitchAnchored(s.A, 'shy');
  expect(node(s.A).solo).toBe(true);
  expect(node(s.A).shy).toBe(true);
  expect(historyLabels().slice(-2)).toEqual(['Solo layer', 'Enable Shy']);
  await h.run({ type: 'undo' });
  expect(node(s.A).shy).not.toBe(true);
  await h.run({ type: 'redo' });
  expect(node(s.A).shy).toBe(true);
});

test('a composition root is not an API layer: its row keeps the legacy writer', async () => {
  const before = node(s.comp).locked;
  await toggleLayerSwitchAnchored(s.comp, 'locked');
  expect(node(s.comp).locked).toBe(!before);
  expect(switchCommands([s.comp, s.A], 'locked', true)).toHaveLength(1);
});

test('a vanished row does nothing', async () => {
  const n = historyLabels().length;
  await toggleLayerSwitchAnchored('ghost', 'visible');
  expect(historyLabels().length).toBe(n);
});

test('motion blur on a layer turns the composition master on in the same entry (AE dual gate)', async () => {
  const m = documentMirror();
  const comp = activeCompIdNow()!;
  const mb = m.comp(comp)!.settings.motionBlur;
  await h.run({ type: 'setCompositionSettings', comp, patch: { motionBlur: { ...mb, enabled: false } } });
  await engineIdle();
  await m.whenIdle();
  expect(useMotionBlurStore.getState().enabled).toBe(false);
  const n = historyLabels().length;
  await toggleLayerFlagsEdit([s.A], 'motionBlur');
  await engineIdle();
  expect(useMotionBlurStore.getState().enabled).toBe(true);
  expect(historyLabels().length).toBe(n + 1);
  await h.run({ type: 'undo' });
  expect(useMotionBlurStore.getState().enabled).toBe(false);
});
