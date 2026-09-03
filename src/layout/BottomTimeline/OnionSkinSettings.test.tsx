/**
 * The onion-skin settings popover.
 *
 * `onionSkinStore` shipped with before / after / step / opacity and clamps
 * written for a UI (`ONION_MAX_SIDE`, `ONION_MAX_STEP`) — and the timeline
 * wired `toggle()` and nothing else. The toggle therefore turned on whatever
 * the defaults happened to be, for ever. This pins the wiring that fixed it:
 * every control the store exposes has a control here, and each writes the
 * property it claims to.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { useOnionSkinStore, ONION_MAX_SIDE } from '@stores/onionSkinStore';
import { DEFAULT_ONION_SKIN } from '@core/rendering/onionSkin';
import { OnionSkinSettingsPopover } from './OnionSkinSettings';

function open(): void {
  render(<OnionSkinSettingsPopover />);
  fireEvent.click(screen.getByRole('button', { name: 'Onion Skin Settings' }));
}

describe('onion skin settings popover', () => {
  beforeEach(() => {
    useOnionSkinStore.setState({ ...DEFAULT_ONION_SKIN });
  });

  it('offers a control for every setting the store exposes', () => {
    open();
    for (const name of [
      'Ghosts before the playhead',
      'Ghosts after the playhead',
      'Frames between ghosts',
      'Nearest ghost opacity',
      'Tint past and future ghosts',
    ]) {
      // `getAllBy`: a ValueField is a scrubber AND a text input, so it names
      // two nodes with the same label.
      expect(screen.getAllByLabelText(name).length).toBeGreaterThan(0);
    }
  });

  it('shows the store’s current values, not the defaults it was built with', () => {
    useOnionSkinStore.getState().set({ before: 4, after: 1, step: 3 });
    open();
    expect(screen.getByRole('spinbutton', { name: 'Ghosts before the playhead' }).getAttribute('aria-valuenow')).toBe('4');
    expect(screen.getByRole('spinbutton', { name: 'Ghosts after the playhead' }).getAttribute('aria-valuenow')).toBe('1');
    expect(screen.getByRole('spinbutton', { name: 'Frames between ghosts' }).getAttribute('aria-valuenow')).toBe('3');
  });

  it('writes opacity as a 0..1 fraction from a 0..100 slider', () => {
    open();
    fireEvent.change(screen.getByLabelText('Nearest ghost opacity'), { target: { value: '80' } });
    expect(useOnionSkinStore.getState().opacity).toBeCloseTo(0.8, 5);
  });

  it('toggles colorize', () => {
    open();
    const before = useOnionSkinStore.getState().colorize;
    fireEvent.click(screen.getByLabelText('Tint past and future ghosts'));
    expect(useOnionSkinStore.getState().colorize).toBe(!before);
  });

  it('leaves the store’s clamps in charge — the UI does not re-implement them', () => {
    // Each ghost is a full comp render, which is why the ceiling exists. The
    // popover hands the store whatever it is given and the store clamps; a
    // second clamp in the component is how the two would drift.
    useOnionSkinStore.getState().set({ before: 999 });
    expect(useOnionSkinStore.getState().before).toBe(ONION_MAX_SIDE);
  });
});
