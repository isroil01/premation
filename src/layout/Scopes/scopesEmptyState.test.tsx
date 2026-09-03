/**
 * Scopes with no signal.
 *
 * The graticule stays — `accumulateFor` returns an empty accumulator rather
 * than nothing precisely so a scope with no frame still draws its graduated
 * frame, and `ScopesPanel.test.tsx` pins that. What this file pins is the
 * other half: that the panel also SAYS what is missing. An empty graticule
 * tells you there is no signal; it never told you how to get one.
 */

import { render, screen } from '@testing-library/react';
import { ScopesPanel } from './ScopesPanel';

it('says there is no signal yet while no frame has arrived', () => {
  render(<ScopesPanel />);

  expect(screen.getByText('No signal yet')).toBeTruthy();
  // The plots are still mounted underneath — the overlay is a scrim, not a
  // replacement, and swapping it for one would be a regression.
  expect(screen.getByRole('group', { name: 'Scope' })).toBeTruthy();
});
