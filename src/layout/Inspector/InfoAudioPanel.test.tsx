/**
 * The Info panel is After Effects' Info readout and nothing else (2026-10):
 * R G B A and X Y under the pointer — no Audio group, no master meter, no
 * volume slider. The Audio panel is the one meter, beside the faders.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { useInfoStore } from '@stores/infoStore';
import { useSelectionStore } from '@stores/selectionStore';
import { InfoAudioPanel } from './InfoAudioPanel';

beforeEach(() => {
  useSelectionStore.getState().clear();
  useInfoStore.setState({ x: 0, y: 0, rgba: null, present: false });
});

afterEach(() => {
  cleanup();
});

it('draws no audio group, meter or master volume', () => {
  render(<InfoAudioPanel />);

  expect(screen.queryByRole('region', { name: 'Audio' })).not.toBeInTheDocument();
  expect(screen.queryByText('Audio')).not.toBeInTheDocument();
  expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Master volume')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /mute audio/i })).not.toBeInTheDocument();
  expect(screen.queryByText('-48')).not.toBeInTheDocument();
});

it('reads R G B A and X Y under the pointer, a dash while it is elsewhere', () => {
  render(<InfoAudioPanel />);
  const pointer = screen.getByRole('region', { name: 'Pointer' });
  for (const key of ['R', 'G', 'B', 'A', 'X', 'Y']) expect(screen.getByText(key)).toBeInTheDocument();
  expect(pointer.textContent).not.toMatch(/\d/);

  act(() => {
    useInfoStore.getState().set({ x: 640, y: 360, rgba: { r: 255, g: 128, b: 7, a: 200 }, present: true });
  });
  for (const value of ['255', '128', '7', '200', '640', '360']) expect(screen.getByText(value)).toBeInTheDocument();
  // Nothing selected: no layer group under the pointer's.
  expect(screen.queryByRole('region', { name: 'Selected layer' })).not.toBeInTheDocument();
});
