/**
 * The effects browser with nothing selected, and with a query that matches
 * nothing.
 *
 * The panel is a library, so "nothing here" is two different situations and
 * they need different sentences: you cannot add an effect because you have not
 * picked a layer, versus you can, but not that one.
 */

import { render, screen } from '@testing-library/react';
import { EffectsPanel } from './EffectsPanel';
import { useSelectionStore } from '@stores/selectionStore';

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
});

beforeEach(() => {
  useSelectionStore.getState().clear();
});

it('asks for a selection before it offers any effects', () => {
  render(<EffectsPanel />);

  expect(screen.getByText('No selection')).toBeTruthy();
  expect(screen.getByText(/Select a layer to add blurs/)).toBeTruthy();
  // …and the search box is not offered for a library you cannot use yet.
  expect(screen.queryByRole('searchbox', { name: 'Search effects' })).toBeNull();
});
