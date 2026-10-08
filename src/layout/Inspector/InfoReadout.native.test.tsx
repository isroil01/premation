/**
 * Info's selected-layer group: the name, then In, Out and Duration — read from
 * the document mirror's `LayerInfo.timing`, as timecode in the composition's
 * rate (the same In / Out the timeline's columns show). Nothing invented.
 */

import { act, cleanup, render, screen, within } from '@testing-library/react';
import { secondsToFlicks } from '@motion/engine-api';
import { useSelectionStore } from '@stores/selectionStore';
import { useProjectStore } from '@stores/projectStore';
import { documentMirror } from '@stores/documentMirror';
import { setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { InfoAudioPanel } from './InfoAudioPanel';

let h: Harness;

beforeEach(async () => {
  h = await setupAppEngine({ panels: true });
  const s = useProjectStore.getState();
  const comp = (s.activeTabId ? s.tabs[s.activeTabId]?.compositionId : undefined) ?? 'comp_root';
  await h.run({
    type: 'setCompositionSettings',
    comp,
    patch: { frameRate: { num: 30, den: 1 }, duration: secondsToFlicks(10) },
  });
});

afterEach(async () => {
  cleanup();
  act(() => { useSelectionStore.getState().clear(); });
  await h.dispose();
});

it('names the selected layer with its In, Out and Duration', async () => {
  const s = useProjectStore.getState();
  const comp = (s.activeTabId ? s.tabs[s.activeTabId]?.compositionId : undefined) ?? 'comp_root';
  const id = (await h.run({
    type: 'createLayer',
    comp,
    kind: 'solid',
    name: 'Info Probe',
    inPoint: secondsToFlicks(1),
    outPoint: secondsToFlicks(3),
    init: [],
  })).layer;
  await documentMirror().whenIdle();
  act(() => { useSelectionStore.getState().set([id]); });

  render(<InfoAudioPanel />);
  const group = screen.getByRole('region', { name: 'Selected layer' });
  expect(within(group).getByText('Info Probe')).toBeInTheDocument();
  const timing = documentMirror().layer(id)!.timing;
  // The fixture's own numbers, as the engine stored them.
  expect(timing.outPoint - timing.inPoint).toBe(secondsToFlicks(2));
  expect(within(group).getByText('In').nextElementSibling?.textContent).toBe('00:01:00');
  expect(within(group).getByText('Out').nextElementSibling?.textContent).toBe('00:03:00');
  expect(within(group).getByText('Duration').nextElementSibling?.textContent).toBe('00:02:00');
});
