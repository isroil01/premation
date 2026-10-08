/**
 * The Align panel as After Effects': "Align Layers to" is a labelled select,
 * then the Align Layers, Distribute Layers and Distribute Spacing rows, each
 * under a label-role caption; tooltips, not paragraphs; one help line only
 * while nothing is selected.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { TooltipProvider } from '@components/Tooltip';
import { useSelectionStore } from '@stores/selectionStore';
import { AlignPanel } from './AlignPanel';

const renderPanel = (): ReturnType<typeof render> => render(<TooltipProvider><AlignPanel /></TooltipProvider>);

beforeEach(() => {
  useSelectionStore.getState().clear();
});

afterEach(() => {
  cleanup();
  act(() => { useSelectionStore.getState().clear(); });
});

it('labels the target select and captions each row of buttons', () => {
  renderPanel();
  const target = screen.getByLabelText('Align Layers to') as HTMLSelectElement;
  expect(target.tagName).toBe('SELECT');
  expect([...target.options].map((o) => o.text)).toEqual(['Selection', 'Composition']);
  // Not the old free-floating "Relative to" and its two segment buttons.
  expect(screen.queryByText('Relative to')).not.toBeInTheDocument();
  expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();

  expect(within(screen.getByRole('group', { name: 'Align Layers' })).getAllByRole('button')).toHaveLength(6);
  expect(within(screen.getByRole('group', { name: 'Distribute Layers' })).getAllByRole('button')).toHaveLength(6);
  expect(within(screen.getByRole('group', { name: 'Distribute Spacing' })).getAllByRole('button')).toHaveLength(2);
  // Nothing selected: one help line.
  expect(screen.getByText('Select layers to align them.')).toBeInTheDocument();
});

it('enables Align for one layer once it aligns to the composition', () => {
  act(() => { useSelectionStore.getState().set(['align_probe_layer']); });
  renderPanel();
  const alignLeft = screen.getByRole('button', { name: 'Align Left' });
  expect(alignLeft).toBeDisabled();
  expect(screen.queryByText('Select layers to align them.')).not.toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('Align Layers to'), { target: { value: 'composition' } });
  expect(screen.getByRole('button', { name: 'Align Left' })).toBeEnabled();
});
