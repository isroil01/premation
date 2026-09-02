/**
 * The undo history with nothing in it.
 *
 * A history list is empty exactly once per session — at the moment a new user
 * first opens it — so it is the state least likely to be looked at while the
 * panel is being written, and the one most likely to still be a bare grey
 * sentence. It is also the one place in the panel where an action is possible
 * without any history existing: pinning the current state as the first entry.
 */

import { render, screen } from '@testing-library/react';
import { HistoryPanel } from './HistoryPanel';
import { CommandSystem, setCommandSystem } from '@core/commands/CommandSystem';
import type { CommandServices } from '@core/commands/Command';

beforeEach(() => {
  setCommandSystem(new CommandSystem({ services: {} as CommandServices, getState: () => ({}) }));
});

it('says there is nothing to undo yet, and offers the one thing that still works', () => {
  render(<HistoryPanel />);

  expect(screen.getByText('Nothing to undo yet')).toBeTruthy();
  // Two controls carry this label — the header's icon button and the empty
  // state's own — and that is the point: the action is reachable without
  // knowing which unlabelled glyph in the header does it.
  expect(screen.getAllByRole('button', { name: /snapshot current state/i }).length).toBeGreaterThan(1);
});
