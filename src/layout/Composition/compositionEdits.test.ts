/**
 * The composition dialogs' edits through the engine (B3): one undo entry per
 * dialog OK, undo exact, and the editor state around it (tab, selection) the
 * UI's.
 */

import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeFill } from '@core/paint/fill';
import { readAutoOrientMode } from '@core/scene/autoOrient';
import { repairNestedTabs } from '@core/composition/compNavigation';
import { LABEL_COLORS } from '@core/scene/labelColor';
import { useProjectStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import {
  createCompositionEdit,
  layerSettingsEdit,
  precomposeEdit,
  rateOf,
  setActiveCompFrameRateEdit,
  setAutoOrientEdit,
} from './compositionEdits';

let h: Harness & { engine: LocalEngine };
let s: Scene;

beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
  useProjectStore.getState().actions.updateComp(s.comp, { pristine: undefined });
  useProjectStore.getState().actions.openTab(s.comp, [s.comp], 'Main');
});
afterEach(async () => {
  await h.dispose();
});

async function oneEntry(label: string, act: () => Promise<unknown>): Promise<void> {
  const before = h.doc();
  const n = historyLabels().length;
  await act();
  await engineIdle();
  const after = h.doc();
  expect(historyLabels().length).toBe(n + 1);
  expect(historyLabels().at(-1)).toBe(label);
  await h.run({ type: 'undo' });
  expect(h.doc()).toBe(before);
  await h.run({ type: 'redo' });
  expect(h.doc()).toBe(after);
}

it('rateOf keeps a typed rate exactly (29.97 stays 29.97)', () => {
  const r = rateOf(29.97);
  expect(r.num / r.den).toBe(29.97);
  expect(rateOf(24)).toEqual({ num: 24, den: 1 });
});

it('New Composition: one entry; undo takes the comp away and the tab repair closes its tab', async () => {
  let id: string | null = null;
  await oneEntry('New Composition', async () => {
    id = await createCompositionEdit({ name: 'Promo', width: 1280, height: 720, fps: 25, durationSeconds: 4, background: '#000000', transparent: true });
  });
  expect(useProjectStore.getState().comps[id!]).toMatchObject({ name: 'Promo', width: 1280, height: 720, fps: 25, durationSeconds: 4, transparent: true });
  const tabFor = () => Object.values(useProjectStore.getState().tabs).find((t) => t.compositionId === id);
  expect(tabFor()).toBeDefined();
  await h.run({ type: 'undo' });
  repairNestedTabs();
  expect(tabFor()).toBeUndefined();
  expect(useProjectStore.getState().tabs[useProjectStore.getState().activeTabId!]?.compositionId).toBe(s.comp);
});

it('Pre-compose: one entry, the new layer selected; undo restores the layers exactly', async () => {
  let r: Awaited<ReturnType<typeof precomposeEdit>> | null = null;
  await oneEntry('Pre-compose', async () => {
    r = await precomposeEdit([s.A, s.B], { name: 'Pre-comp 1', mode: 'move', adjustDuration: false, openNew: false });
  });
  expect(r && 'layer' in r!).toBe(true);
  const made = r as unknown as { comp: string; layer: string };
  expect(useSelectionStore.getState().ids).toEqual([made.layer]);
  expect(useProjectStore.getState().comps[made.comp]?.name).toBe('Pre-comp 1');
  expect(defaultSceneGraph.getNode(s.A)?.parent).toBe(made.comp);
});

it('Pre-compose refusals come back as a message, not a half edit', async () => {
  const before = h.doc();
  const r = await precomposeEdit([s.A, s.B], { name: 'x', mode: 'leave', adjustDuration: false, openNew: false });
  expect('error' in r).toBe(true);
  expect(h.doc()).toBe(before);
});

it('Auto-Orient: one entry over the layers that can take the mode', async () => {
  await oneEntry('Auto-Orient', () => setAutoOrientEdit([s.A, s.B], 'path'));
  expect(readAutoOrientMode(defaultSceneGraph.getNode(s.A)!)).toBe('path');
  expect(readAutoOrientMode(defaultSceneGraph.getNode(s.B)!)).toBe('path');
});

it('Solid Settings: name, label, size and colour (layer/fill) as one entry', async () => {
  const label = LABEL_COLORS[2]!.color;
  let r: string | null = null;
  await oneEntry('Solid Settings', async () => {
    r = await layerSettingsEdit(s.A, { name: 'Backdrop', labelColor: label, width: 640, height: 360, color: '#4f7ea8' });
  });
  expect(r).toBe('ok');
  const node = defaultSceneGraph.getNode(s.A)!;
  expect(node.name).toBe('Backdrop');
  expect(node.color).toBe(label);
  const t = node.components.find((c) => c.type === 'Transform')!.props;
  expect([t.width, t.height]).toEqual([640, 360]);

  const n = historyLabels().length;
  expect(await layerSettingsEdit(s.A, { name: 'Backdrop', color: '#ff0000' })).toBe('ok');
  expect(readNodeFill(defaultSceneGraph.getNode(s.A)!)).toMatchObject({ type: 'solid', color: '#ff0000' });
  expect(historyLabels().length).toBe(n + 1);
  expect(await layerSettingsEdit('nope', { name: 'x' })).toBe('gone');
  expect(historyLabels().length).toBe(n + 1);
});

it('Start from a Video conform: the active comp takes the probed rate as one entry', async () => {
  await oneEntry('Conform to Footage', () => setActiveCompFrameRateEdit(23.976));
  expect(useProjectStore.getState().comps[s.comp]?.fps).toBe(23.976);
});
