/**
 * The effects browser with nothing selected.
 *
 * The panel is a library, so "nothing here" is two different situations and
 * they need different sentences: you cannot add an effect because you have not
 * picked a layer, versus you can, but not that one (EffectsPanelBrowser).
 *
 * An empty state is ONE help line (the panel grammar, 2026-10) — not a tile, a
 * heading and a paragraph.
 */

import { render, screen } from '@testing-library/react';
import { TooltipProvider } from '@components/Tooltip';
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

it('asks for a selection in one line before it offers any effects', () => {
  const { container } = render(<TooltipProvider><EffectsPanel /></TooltipProvider>);

  expect(screen.getByText('Select a layer to add effects to it.')).toBeTruthy();
  // One line: no title above it, no second sentence under it.
  expect(screen.queryByText('No selection')).toBeNull();
  expect(container.querySelectorAll('p')).toHaveLength(1);
  // …and the search box is not offered for a library you cannot use yet.
  expect(screen.queryByRole('searchbox', { name: 'Search effects and presets' })).toBeNull();
});
