/**
 * The transport row — ONE of everything.
 *
 * The complaint this pins against, verbatim: "the transport component has 2
 * rows instead of 1 and 2 play buttons and everything is duplicated". The
 * five transport buttons exist exactly once, the J/K/L and in/out buttons
 * that used to sit beside them are gone (they are chords and menu rows), and
 * what is left of the shuttle is a badge that exists only while one runs.
 */

import { render, screen, act, within } from '@testing-library/react';
import { TransportBar } from './TransportBar';
import { TRANSPORT_DEMOTE_ORDER } from './transportOverflow';
import { __resetCompositionShuttle, getCompositionShuttle } from '@core/timeline/transportController';

beforeEach(() => {
  __resetCompositionShuttle();
});

function bar(): HTMLElement {
  render(<TransportBar />);
  return screen.getByRole('toolbar', { name: 'Viewport transport and tools' });
}

it('has exactly one of each transport button', () => {
  const b = bar();
  for (const name of ['Go to Start', 'Previous Frame', 'Play', 'Next Frame', 'Go to End']) {
    expect(within(b).getAllByRole('button', { name })).toHaveLength(1);
  }
  expect(within(b).queryByRole('button', { name: 'Pause' })).toBeNull();
});

it('carries no shuttle or in/out buttons — those are keys and menu rows', () => {
  const b = bar();
  for (const name of ['Mark In', 'Mark Out', 'Go to In', 'Go to Out']) {
    expect(within(b).queryByRole('button', { name })).toBeNull();
  }
  expect(within(b).queryByRole('button', { name: /^Shuttle/ })).toBeNull();
  expect(within(b).queryByRole('button', { name: /^Stop the shuttle/ })).toBeNull();
});

it('carries the display controls, once each, and no View Options menu', () => {
  const b = bar();
  expect(within(b).getAllByRole('group', { name: 'Viewport display' })).toHaveLength(1);
  expect(within(b).getAllByRole('button', { name: 'Preview' })).toHaveLength(1);
  expect(within(b).getAllByRole('button', { name: /^Preview resolution/ })).toHaveLength(1);
  expect(within(b).getAllByRole('button', { name: 'Toggle Transparency Grid' })).toHaveLength(1);
  expect(within(b).getAllByRole('group', { name: 'Exposure' })).toHaveLength(1);
  expect(within(b).queryByRole('button', { name: 'View Options' })).toBeNull();
});

it('has none of the buttons that moved to their AE homes (2026-10-07)', () => {
  const b = bar();
  for (const name of [/^Pop out/, /^Viewer LUT/, /^Camera bookmarks/, /^Display mode/, 'Loop Playback', 'Auto-Keyframe mode', 'Zoom out', 'Zoom in', 'Fit comp in view']) {
    expect(within(b).queryByRole('button', { name })).toBeNull();
  }
});

it('keeps the display controls, then the one magnification field, right of play', () => {
  const b = bar();
  const play = within(b).getByRole('button', { name: 'Play' });
  const display = within(b).getByRole('group', { name: 'Viewport display' });
  expect(within(b).getAllByRole('group', { name: 'Viewport zoom' })).toHaveLength(1);
  const zoom = within(b).getByRole('group', { name: 'Viewport zoom' });
  // AE's one magnification popup: the field and its presets, no −, + or Fit buttons.
  expect(within(zoom).getAllByRole('button')).toHaveLength(1);
  expect(within(b).getByRole('button', { name: 'Magnification presets' })).toBeInTheDocument();
  expect(play.compareDocumentPosition(display) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(display.compareDocumentPosition(zoom) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('shows the shuttle rate beside play only while a shuttle runs', () => {
  const b = bar();
  expect(within(b).queryByRole('status')).toBeNull();
  act(() => { getCompositionShuttle().keyDown('l'); });
  const badge = within(b).getByRole('status');
  expect(badge).toHaveAccessibleName('Shuttle forward 1×');
  expect(badge.textContent).toContain('1×');
  act(() => { getCompositionShuttle().keyDown('k'); });
  expect(within(b).queryByRole('status')).toBeNull();
});

it('is the element the JKL chords treat as viewport focus', () => {
  expect(bar()).toHaveAttribute('data-transport-bar');
});

it('sheds groups in the documented order — the display controls first, zoom last', () => {
  expect(TRANSPORT_DEMOTE_ORDER[0]).toBe('exposure');
  expect(TRANSPORT_DEMOTE_ORDER[TRANSPORT_DEMOTE_ORDER.length - 1]).toBe('zoom');
});

it('balances controls across the left and right sides of the centered play button', () => {
  const b = bar();
  const buttons = within(b).getAllByRole('button');
  const playIdx = buttons.findIndex((btn) => btn.getAttribute('aria-label') === 'Play');
  expect(playIdx).toBeGreaterThan(-1);

  const leftButtons = buttons.slice(0, playIdx);
  const rightButtons = buttons.slice(playIdx + 1);

  // Left: AE's 3D View popup, layout, snapshot, compare, then go-to-start and
  // prev-frame = 6 buttons to the left of Play. No split / trim / marker, loop
  // or auto-key buttons (AE's Composition panel has none of them).
  expect(leftButtons.map((btn) => btn.getAttribute('aria-label'))).toEqual([
    expect.stringMatching(/^3D View:/),
    expect.stringMatching(/^Viewport layout:/),
    expect.stringMatching(/^Take Snapshot/),
    'Compare snapshots',
    'Go to Start',
    'Previous Frame',
  ]);

  // Right: next-frame, go-to-end, then AE's footer — resolution, preview,
  // transparency, overlays, channel, exposure (reset) — and the magnification
  // presets: 9 in all (the exposure value is a spinbutton, not a button).
  expect(rightButtons.map((btn) => btn.getAttribute('aria-label'))).toEqual([
    'Next Frame',
    'Go to End',
    expect.stringMatching(/^Preview resolution:/),
    'Preview',
    'Toggle Transparency Grid',
    expect.stringMatching(/^Overlays/),
    expect.stringMatching(/^Show channel:/),
    'Adjust Exposure',
    'Magnification presets',
  ]);
});

