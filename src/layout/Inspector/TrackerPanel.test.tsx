/**
 * B4: the Tracker panel lists its Motion Source layers from the MIRROR — the
 * active composition's footage layers — and follows renames without a scene
 * revision hook.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { useSelectionStore } from '@stores/selectionStore';
import { TrackerPanel } from './TrackerPanel';

jest.useFakeTimers();

let h: Harness & { engine: LocalEngine };
let s: Scene;
beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
  useSelectionStore.getState().set([]);
  await engineIdle();
});
afterEach(async () => {
  cleanup();
  await h.dispose();
});

test('Motion Source offers the active comp\'s footage layers and follows a rename', async () => {
  render(<TrackerPanel />);
  const options = (): string[] => screen.getAllByRole('option').map((o) => o.textContent?.trim() ?? '');
  expect(options()).toEqual(['V']);
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe(s.V);

  await act(async () => {
    await h.run({ type: 'renameLayer', layer: s.V, name: 'Clip' });
    await engineIdle();
  });
  expect(options()).toEqual(['Clip']);
});
