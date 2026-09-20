/**
 * The CONNECTIONS for multi-row selection.
 *
 * `trackRangeSelect` has its own unit tests and they pass with the panel
 * unplugged — which is exactly how this folder has shipped tested modules with
 * no call sites before. What those tests cannot see is whether a Shift+click
 * on a layer row reaches them at all, whether the row ORDER handed to them is
 * the flattened list the user is looking at, and whether a host that only
 * wired the old per-row callback still works. That is what is here.
 *
 * Drag geometry is deliberately absent: jsdom has no layout behind
 * `getBoundingClientRect`, so a bar drag cannot be exercised here. The group
 * move's arithmetic lives in `clipGroupDrag.test.ts`.
 */

import { render, fireEvent } from '@testing-library/react';
import { Timeline } from './Timeline';
import type { TimelineModel } from './TimelineModel';
import { usePreferenceStore } from '@stores/preferenceStore';

class NoopResizeObserver {
  observe(): void { /* no layout in jsdom */ }
  unobserve(): void { /* no layout in jsdom */ }
  disconnect(): void { /* no layout in jsdom */ }
}
beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver;
});

const track = (id: string, name: string): TimelineModel['tracks'][number] => ({
  id: id as never,
  name,
  canExpand: true,
  clips: [{ id: `clip_${id}`, trackId: id as never, nodeId: id as never, start: 0, duration: 1 }],
});

const MODEL: TimelineModel = {
  tracks: [
    track('a', 'Layer A'),
    track('b', 'Layer B'),
    track('c', 'Layer C'),
    track('d', 'Layer D'),
    track('e', 'Layer E'),
  ],
  markers: [],
  duration: 5,
  frameRate: 30,
  currentTime: 0,
  pixelsPerSecond: 100,
};

beforeEach(() => {
  usePreferenceStore.getState().set('timelineSnap', true);
});

/** The layer rows in the header column, in display order. */
const rows = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="option"][data-track-id]'));

const rowFor = (name: string): HTMLElement => {
  const el = rows().find((r) => r.getAttribute('aria-label') === name);
  if (!el) throw new Error(`no row for ${name} — found ${rows().map((r) => r.getAttribute('aria-label')).join(', ')}`);
  return el;
};

describe('row selection wiring', () => {
  it('a plain click replaces the selection', () => {
    const onMany = jest.fn();
    render(<Timeline model={MODEL} onTrackSelectMany={onMany} selectedTrackIds={['a']} />);
    fireEvent.click(rowFor('Layer C'));
    expect(onMany).toHaveBeenCalledWith(['c']);
  });

  it('Shift+click selects the span from the previously clicked row', () => {
    const onMany = jest.fn();
    const { rerender } = render(
      <Timeline model={MODEL} onTrackSelectMany={onMany} selectedTrackIds={[]} />,
    );
    // Anchor with a plain click…
    fireEvent.click(rowFor('Layer B'));
    expect(onMany).toHaveBeenLastCalledWith(['b']);
    rerender(<Timeline model={MODEL} onTrackSelectMany={onMany} selectedTrackIds={['b']} />);
    // …then span to D.
    fireEvent.click(rowFor('Layer D'), { shiftKey: true });
    expect(onMany).toHaveBeenLastCalledWith(['b', 'c', 'd']);
  });

  it('spans upward too', () => {
    const onMany = jest.fn();
    const { rerender } = render(
      <Timeline model={MODEL} onTrackSelectMany={onMany} selectedTrackIds={[]} />,
    );
    fireEvent.click(rowFor('Layer D'));
    rerender(<Timeline model={MODEL} onTrackSelectMany={onMany} selectedTrackIds={['d']} />);
    fireEvent.click(rowFor('Layer B'), { shiftKey: true });
    expect(onMany).toHaveBeenLastCalledWith(['b', 'c', 'd']);
  });

  it('Ctrl+click toggles one row and leaves the rest', () => {
    const onMany = jest.fn();
    render(<Timeline model={MODEL} onTrackSelectMany={onMany} selectedTrackIds={['a', 'e']} />);
    fireEvent.click(rowFor('Layer C'), { ctrlKey: true });
    expect(onMany).toHaveBeenLastCalledWith(['a', 'c', 'e']);
  });

  it('Ctrl+click on a selected row deselects it', () => {
    const onMany = jest.fn();
    render(<Timeline model={MODEL} onTrackSelectMany={onMany} selectedTrackIds={['a', 'c']} />);
    fireEvent.click(rowFor('Layer C'), { ctrlKey: true });
    expect(onMany).toHaveBeenLastCalledWith(['a']);
  });

  it('Ctrl+Shift+click adds the span to what is already selected', () => {
    const onMany = jest.fn();
    const { rerender } = render(
      <Timeline model={MODEL} onTrackSelectMany={onMany} selectedTrackIds={[]} />,
    );
    fireEvent.click(rowFor('Layer A'));
    rerender(<Timeline model={MODEL} onTrackSelectMany={onMany} selectedTrackIds={['a']} />);
    fireEvent.click(rowFor('Layer E'), { ctrlKey: true });
    rerender(<Timeline model={MODEL} onTrackSelectMany={onMany} selectedTrackIds={['a', 'e']} />);
    // Anchor is E (the Ctrl+click moved it); span back to C, keeping A.
    fireEvent.click(rowFor('Layer C'), { ctrlKey: true, shiftKey: true });
    expect(onMany).toHaveBeenLastCalledWith(['a', 'c', 'd', 'e']);
  });

  it('does not re-publish a selection that did not change', () => {
    const onMany = jest.fn();
    render(<Timeline model={MODEL} onTrackSelectMany={onMany} selectedTrackIds={['c']} />);
    fireEvent.click(rowFor('Layer C'));
    expect(onMany).not.toHaveBeenCalled();
  });

  it('Shift+ArrowDown extends the span, matching Shift+click', () => {
    const onMany = jest.fn();
    const { rerender } = render(
      <Timeline model={MODEL} onTrackSelectMany={onMany} selectedTrackIds={[]} />,
    );
    fireEvent.click(rowFor('Layer B'));
    rerender(<Timeline model={MODEL} onTrackSelectMany={onMany} selectedTrackIds={['b']} />);
    fireEvent.keyDown(rowFor('Layer B'), { key: 'ArrowDown', shiftKey: true });
    expect(onMany).toHaveBeenLastCalledWith(['b', 'c']);
  });

  it('falls back to the per-row callback when the host has not wired the span one', () => {
    // A host that only knows `onTrackSelect` must keep working — this is the
    // compatibility path, and it is what every existing caller used.
    const onSelect = jest.fn();
    render(<Timeline model={MODEL} onTrackSelect={onSelect} selectedTrackIds={['a']} />);
    fireEvent.click(rowFor('Layer C'), { shiftKey: true });
    expect(onSelect).toHaveBeenCalledWith('c', true);
  });
});
