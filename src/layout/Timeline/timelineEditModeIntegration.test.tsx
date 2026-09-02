/**
 * The edit modes, mounted inside the real `<Timeline>`.
 *
 * The unit tests around this feature all pass with the wiring cut: the store
 * works, the geometry works, the cut search works, the button row works — and
 * none of that proves the panel ever asks any of them anything. This mounts the
 * component and drives it through the DOM, which is the only place the three
 * pieces meet.
 *
 * Deliberately narrow. It asserts that the row is present, that arming a mode
 * reaches the panel (the `data-edit-mode` attribute every cursor rule hangs
 * off), and that the razor draws its aim — not the drag arithmetic, which is
 * covered where it lives and cannot be exercised through jsdom's pointer
 * events without a layout engine behind `getBoundingClientRect`.
 */

import { render, screen, fireEvent, act } from '@testing-library/react';
import { Timeline } from './Timeline';
import type { TimelineModel } from './TimelineModel';
import { useTimelineEditModeStore } from './timelineEditMode';

// jsdom ships no ResizeObserver, and the panel measures its own lane area to
// size the virtualized rows. Same stub the other panel tests use.
class NoopResizeObserver {
  observe(): void { /* no layout in jsdom */ }
  unobserve(): void { /* no layout in jsdom */ }
  disconnect(): void { /* no layout in jsdom */ }
}
beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver;
});

const MODEL: TimelineModel = {
  tracks: [
    {
      id: 'a' as never,
      name: 'Layer A',
      clips: [{ id: 'la', trackId: 'a' as never, nodeId: 'a' as never, start: 0, duration: 2 }],
    },
  ],
  markers: [],
  duration: 5,
  frameRate: 30,
  currentTime: 0,
  pixelsPerSecond: 100,
};

beforeEach(() => {
  useTimelineEditModeStore.getState().reset();
});

function panel(): HTMLElement {
  const { container } = render(<Timeline model={MODEL} />);
  const root = container.firstElementChild;
  if (!(root instanceof HTMLElement)) throw new Error('Timeline rendered no root element');
  return root;
}

it('mounts the edit-tool row inside the timeline', () => {
  panel();
  expect(screen.getByRole('radiogroup', { name: 'Timeline edit tool' })).toBeInTheDocument();
  expect(screen.getAllByRole('radio')).toHaveLength(5);
});

it('publishes the armed mode on the panel root, where the cursor rules read it', () => {
  // Every clip bar's cursor is driven by this attribute rather than by a prop,
  // so that a tool change repaints hundreds of virtualized bars without
  // re-rendering any of them. If it stops being written the tools still work
  // and the pointer silently stops saying which one is armed.
  const root = panel();
  expect(root).toHaveAttribute('data-edit-mode', 'select');
  fireEvent.click(screen.getByRole('radio', { name: 'Razor tool' }));
  expect(root).toHaveAttribute('data-edit-mode', 'razor');
});

it('arming a mode from the keyboard reaches the panel too', () => {
  const root = panel();
  act(() => useTimelineEditModeStore.getState().setMode('roll'));
  expect(root).toHaveAttribute('data-edit-mode', 'roll');
});

it('leaving the razor drops its guide line', () => {
  // The line is drawn from state the pointer sets; without the mode-change
  // effect it would be stranded at the last position the pointer had, over a
  // timeline where clicking now does something else entirely.
  const store = useTimelineEditModeStore.getState();
  panel();
  act(() => store.setMode('razor'));
  act(() => store.reset());
  expect(document.querySelectorAll('[class*="razorLine"]')).toHaveLength(0);
});
