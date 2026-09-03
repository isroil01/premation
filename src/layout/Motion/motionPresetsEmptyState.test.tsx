/**
 * The preset library with a query nothing matches.
 *
 * The library always ships built-in presets, so the honest empty state here is
 * the SEARCH one — and it is the one the panel used to render as a lone grey
 * line with no way out but reaching back up to the field and deleting what you
 * typed.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { MotionPresetsPanel } from './MotionPresetsPanel';

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
});

it('shows an empty state with a way out when the search matches nothing', () => {
  render(<MotionPresetsPanel />);

  const search = screen.getByRole('searchbox', { name: 'Search presets' });
  fireEvent.change(search, { target: { value: 'zzzz-no-such-preset' } });

  expect(screen.getByText('No matching presets')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Show all presets' }));

  expect((search as HTMLInputElement).value).toBe('');
  expect(screen.queryByText('No matching presets')).toBeNull();
});
