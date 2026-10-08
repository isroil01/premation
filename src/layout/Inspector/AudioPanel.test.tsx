/**
 * The Audio panel's options are its ≡ menu's (2026-10) — AE's Audio Options:
 * Units and Slider Minimum, each a submenu with its current choice ticked —
 * and the panel draws no title of its own (the tab is the title) and no
 * pointer readout (that is the Info panel's).
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { DockPanelHeaderContext } from '@components/DockPanel';
import type { DropdownItem } from '@components/Dropdown';
import { useSelectionStore } from '@stores/selectionStore';
import { AudioPanel } from './AudioPanel';

type Row = Extract<DropdownItem, { type: 'item' }>;
type Check = Extract<DropdownItem, { type: 'checkbox' }>;

let handed: DropdownItem[] = [];
const header = { target: null, setCustomMenuItems: (rows: DropdownItem[]) => { handed = rows; } };

const submenu = (id: string): Check[] => ((handed.find((r) => r.type === 'item' && r.id === id) as Row | undefined)?.submenu ?? []) as Check[];
const ticked = (id: string): string[] => submenu(id).filter((r) => r.checked).map((r) => String(r.label));

beforeEach(() => {
  handed = [];
  useSelectionStore.getState().clear();
});

afterEach(() => {
  cleanup();
});

it('hands Units and Slider Minimum to the dock ≡ menu, the current choice ticked', () => {
  render(
    <DockPanelHeaderContext.Provider value={header}>
      <AudioPanel />
    </DockPanelHeaderContext.Provider>,
  );
  expect(handed.map((r) => (r.type === 'item' ? r.label : r.type))).toEqual(['Units', 'Slider Minimum']);
  expect(ticked('audio-units')).toEqual(['Decibels']);
  expect(ticked('audio-slider-minimum')).toEqual(['-48 dB']);

  // Picking a row re-hands the menu with the new tick.
  act(() => { submenu('audio-units').find((r) => r.id === 'audio-units-percent')!.onChange(true); });
  expect(ticked('audio-units')).toEqual(['Percentage']);
  act(() => { submenu('audio-slider-minimum').find((r) => r.id === 'audio-floor-96')!.onChange(true); });
  expect(ticked('audio-slider-minimum')).toEqual(['-96 dB']);
});

it('draws no title, no options popover and no pointer readout', () => {
  render(<AudioPanel />);
  expect(screen.queryByText('Audio')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Audio panel options' })).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Info' })).not.toBeInTheDocument();
  // The faders are there, idle until a layer with sound is selected.
  expect(screen.getByRole('slider', { name: 'Left level' })).toBeDisabled();
  expect(screen.getByText('Select a layer with sound to set its level and pan.')).toBeInTheDocument();
});
