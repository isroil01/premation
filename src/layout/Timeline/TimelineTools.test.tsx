/**
 * The tool row.
 *
 * What is worth asserting about five buttons is the part that makes them a
 * TOOL row rather than five toggles: exactly one is checked, clicking one
 * un-checks the rest, and each button says out loud what it does and which key
 * arms it. That last one is the whole reason the row exists — slip and slide
 * already worked and went unused because nothing anywhere named them.
 */

import { render, screen, fireEvent, act } from '@testing-library/react';
import { TimelineTools } from './TimelineTools';
import {
  TIMELINE_EDIT_MODES,
  getTimelineEditMode,
  useTimelineEditModeStore,
} from './timelineEditMode';

beforeEach(() => {
  useTimelineEditModeStore.getState().reset();
});

it('renders one radio per mode, with exactly one checked', () => {
  render(<TimelineTools />);
  const radios = screen.getAllByRole('radio');
  expect(radios).toHaveLength(TIMELINE_EDIT_MODES.length);
  expect(radios.filter((r) => r.getAttribute('aria-checked') === 'true')).toHaveLength(1);
});

it('arms the mode that was clicked, and only that one', () => {
  render(<TimelineTools />);
  fireEvent.click(screen.getByRole('radio', { name: 'Razor tool' }));
  expect(getTimelineEditMode()).toBe('razor');
  const checked = screen.getAllByRole('radio').filter((r) => r.getAttribute('aria-checked') === 'true');
  expect(checked).toHaveLength(1);
  expect(checked[0]).toHaveAttribute('aria-label', 'Razor tool');
});

it('follows the store when the mode is armed from a shortcut', () => {
  // The buttons and the keyboard are two doors into one piece of state; a row
  // that only updated on its own clicks would show the wrong tool for the rest
  // of the session after one keypress.
  render(<TimelineTools />);
  act(() => useTimelineEditModeStore.getState().setMode('roll'));
  expect(screen.getByRole('radio', { name: 'Roll tool' })).toHaveAttribute('aria-checked', 'true');
});

it('every button advertises its shortcut and what it does', () => {
  render(<TimelineTools />);
  for (const def of TIMELINE_EDIT_MODES) {
    const btn = screen.getByRole('radio', { name: `${def.label} tool` });
    const title = btn.getAttribute('title') ?? '';
    expect(title).toContain(def.chord);
    expect(title).toContain(def.description);
  }
});

it('names the armed tool in words, not only as a lit glyph', () => {
  render(<TimelineTools />);
  expect(screen.getByText('Selection')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('radio', { name: 'Slip tool' }));
  expect(screen.getByText('Slip')).toBeInTheDocument();
});
