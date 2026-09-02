/**
 * The font list when the query matches nothing.
 *
 * Also the smallest end-to-end check that the shared <SearchField> is wired
 * up: type into it, and the list that used to be filtered by a hand-rolled
 * input is still filtered.
 */

import { render, screen, fireEvent, act } from '@testing-library/react';
import { FontPicker } from './FontPicker';

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
});

it('says nothing matches, and offers to clear the query', async () => {
  render(<FontPicker value="Arial" onChange={() => {}} />);

  fireEvent.click(screen.getByRole('button', { name: /arial/i }));

  const search = await screen.findByRole('searchbox', { name: 'Search fonts' });
  await act(async () => {
    fireEvent.change(search, { target: { value: 'zzzzzzzz-no-such-family' } });
  });

  expect(screen.getByText(/No fonts match/)).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Show all fonts' }));
  expect((search as HTMLInputElement).value).toBe('');
});
