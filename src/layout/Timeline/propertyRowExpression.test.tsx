/**
 * AE's expression `=` beside a timeline property: only on a row that has an
 * expression, dim when disabled, red (with the engine's message) when it
 * fails, and a click opens the editor without selecting the row.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { PropertyHeader } from './TrackHeaderColumn';

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
});

const row = (extra: Partial<Parameters<typeof PropertyHeader>[0]>) => (
  <PropertyHeader label="Opacity" style={{}} keyframes={[]} currentTime={0} {...extra} />
);

it('shows no badge on a row without an expression', () => {
  render(row({}));
  expect(screen.queryByRole('button', { name: /^Edit expression/ })).toBeNull();
});

it('opens the editor from the badge, without selecting the row', () => {
  const onEdit = jest.fn();
  const onSelect = jest.fn();
  render(row({ expression: { enabled: true, error: null }, onEditExpression: onEdit, onSelect }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit expression on Opacity' }));
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(onSelect).not.toHaveBeenCalled();
});

it('says when the expression fails, with the engine message', () => {
  render(row({ expression: { enabled: true, error: 'value is not defined' } }));
  expect(screen.getByRole('button', { name: 'Edit expression on Opacity' })).toHaveAttribute('title', expect.stringContaining('value is not defined'));
});
