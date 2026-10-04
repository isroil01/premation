/**
 * The multicam grid with fewer than two angles.
 *
 * Below two angles there is nothing to cut BETWEEN, so the panel has always
 * bailed out — but into a single grey sentence that named a menu item and
 * nothing else.
 */

import { render, screen } from '@testing-library/react';
import { MulticamViewerBody } from './MulticamViewer';

it('shows an empty state when the composition has no angles', () => {
  render(<MulticamViewerBody />);

  expect(screen.getByText('No multicam angles')).toBeTruthy();
});
