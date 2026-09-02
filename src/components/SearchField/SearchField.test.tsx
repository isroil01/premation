/**
 * SearchField — the four behaviours the panels used to each get wrong.
 *
 * Escape semantics are the reason this component exists at all: in the panels
 * that had no Escape handler, the key bubbled to the global shortcut layer and
 * closed the panel the user was typing in. "Clear first, leave second" is the
 * contract, and it is the one thing a per-panel reimplementation always
 * missed, so it is pinned here.
 */

import { render, fireEvent, act } from '@testing-library/react';
import { useState } from 'react';
import { SearchField } from './SearchField';

/** Controlled wrapper — the component is controlled, so the tests need state. */
function Harness(props: {
  debounceMs?: number;
  onChange?: (v: string) => void;
  initial?: string;
}): JSX.Element {
  const [value, setValue] = useState(props.initial ?? '');
  return (
    <SearchField
      value={value}
      placeholder="Search effects…"
      debounceMs={props.debounceMs ?? 0}
      onChange={(next) => {
        setValue(next);
        props.onChange?.(next);
      }}
    />
  );
}

it('names itself from the placeholder and reports what is typed', () => {
  const onChange = jest.fn();
  const { getByRole } = render(<Harness onChange={onChange} />);

  const input = getByRole('searchbox', { name: 'Search effects' });
  fireEvent.change(input, { target: { value: 'blur' } });

  expect(onChange).toHaveBeenCalledWith('blur');
  expect((input as HTMLInputElement).value).toBe('blur');
});

it('shows a clear button only once there is text, and clearing empties the field', () => {
  const onChange = jest.fn();
  const { getByRole, queryByRole } = render(<Harness onChange={onChange} />);

  expect(queryByRole('button', { name: /clear/i })).toBeNull();

  const input = getByRole('searchbox');
  fireEvent.change(input, { target: { value: 'glow' } });
  fireEvent.click(getByRole('button', { name: /clear/i }));

  expect(onChange).toHaveBeenLastCalledWith('');
  expect((input as HTMLInputElement).value).toBe('');
  expect(queryByRole('button', { name: /clear/i })).toBeNull();
});

it('Escape clears while there is text, keeps focus, and does not escape the field', () => {
  const onChange = jest.fn();
  const onPanelEscape = jest.fn();
  const { getByRole } = render(
    <div onKeyDown={onPanelEscape}>
      <Harness onChange={onChange} />
    </div>,
  );

  const input = getByRole('searchbox') as HTMLInputElement;
  input.focus();
  fireEvent.change(input, { target: { value: 'levels' } });
  fireEvent.keyDown(input, { key: 'Escape' });

  expect(onChange).toHaveBeenLastCalledWith('');
  expect(input.value).toBe('');
  expect(document.activeElement).toBe(input);
  // The panel above must never see this Escape — that is how the search box
  // used to close the panel out from under the user.
  expect(onPanelEscape).not.toHaveBeenCalled();
});

it('Escape on an already-empty field blurs and lets the panel have the key', () => {
  const onPanelEscape = jest.fn();
  const { getByRole } = render(
    <div onKeyDown={onPanelEscape}>
      <Harness />
    </div>,
  );

  const input = getByRole('searchbox') as HTMLInputElement;
  input.focus();
  fireEvent.keyDown(input, { key: 'Escape' });

  expect(document.activeElement).not.toBe(input);
  expect(onPanelEscape).toHaveBeenCalledTimes(1);
});

describe('debounce', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('renders every keystroke but reports only the last one, once', () => {
    const onChange = jest.fn();
    const { getByRole } = render(<Harness debounceMs={150} onChange={onChange} />);
    const input = getByRole('searchbox') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'b' } });
    fireEvent.change(input, { target: { value: 'bl' } });
    fireEvent.change(input, { target: { value: 'blu' } });

    // The field is never laggy — only the callback is delayed.
    expect(input.value).toBe('blu');
    expect(onChange).not.toHaveBeenCalled();

    act(() => { jest.advanceTimersByTime(150); });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('blu');
  });

  it('flushes a clear immediately rather than leaving it pending', () => {
    const onChange = jest.fn();
    const { getByRole } = render(<Harness debounceMs={150} onChange={onChange} />);
    const input = getByRole('searchbox') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'blur' } });
    act(() => { jest.advanceTimersByTime(150); });
    onChange.mockClear();

    fireEvent.change(input, { target: { value: 'blurr' } });
    fireEvent.click(getByRole('button', { name: /clear/i }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('');

    // …and the superseded keystroke must not arrive late and un-clear it.
    act(() => { jest.advanceTimersByTime(500); });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

it('renders a shortcut hint while the field is empty', () => {
  const { getByRole, getByText } = render(
    <SearchField value="" onChange={() => {}} shortcut="⌘F" ariaLabel="Search commands" />,
  );

  expect(getByText('⌘F')).toBeTruthy();
  expect(getByRole('searchbox', { name: 'Search commands' })).toBeTruthy();
});

it('swaps the shortcut hint for the clear button once there is a query', () => {
  const { getByRole, queryByText } = render(
    <SearchField value="x" onChange={() => {}} shortcut="⌘F" ariaLabel="Search commands" />,
  );

  expect(queryByText('⌘F')).toBeNull();
  expect(getByRole('button', { name: /clear/i })).toBeTruthy();
});

it('renders a result count slot', () => {
  const { getByText } = render(
    <SearchField value="a" onChange={() => {}} resultCount="3 of 40" ariaLabel="Search" />,
  );
  expect(getByText('3 of 40')).toBeTruthy();
});
