/**
 * The shortcut editor when nothing matches.
 *
 * Two things are pinned. The list has a real empty state rather than a bare
 * grey line — and its escape hatch actually clears the query, which matters
 * because the same query lives in the shared <SearchField> above and the two
 * would otherwise be able to disagree about what is filtered.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { ShortcutsTab } from './CustomizeDialog';

it('shows an empty state whose action clears the query', () => {
  render(<ShortcutsTab />);

  const search = screen.getByRole('searchbox', { name: 'Search shortcuts' });
  fireEvent.change(search, { target: { value: 'zzzz-no-such-command' } });

  expect(screen.getByText('No matching shortcuts found')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

  expect((search as HTMLInputElement).value).toBe('');
});
