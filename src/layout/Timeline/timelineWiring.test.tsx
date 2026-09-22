/**
 * The wiring, not the arithmetic.
 *
 * Every helper in this folder has a unit test that passes with the panel
 * unplugged: `playheadFollow` computes a scroll nobody applies, `expandCollapse`
 * plans toggles nobody replays, `snapCommands` flips a preference no drag reads.
 * Two rounds of this work shipped exactly that — modules with tests and zero
 * call sites — so this file asserts the CONNECTIONS instead: that mounting
 * `<Timeline>` registers what the out-of-panel commands need, that the chords
 * the root claims are the ones it handles, and that the switches reach the
 * preference the drags read.
 *
 * Deliberately shallow on behaviour. Drag geometry cannot be exercised through
 * jsdom (no layout behind `getBoundingClientRect`), and it is covered where it
 * lives; what cannot be covered anywhere else is whether the panel asks.
 */

import { render, screen, fireEvent, act } from '@testing-library/react';
import { Timeline } from './Timeline';
import { BottomTimeline } from '@layout/BottomTimeline/BottomTimeline';
import type { TimelineModel } from './TimelineModel';
import { getTimelineFitSource } from './fitSelection';
import { usePreferenceStore } from '@stores/preferenceStore';
import { BuiltinCommands, getCommandRegistry } from '@core/commands/Command';
import { CommandSystem, setCommandSystem } from '@core/commands/CommandSystem';
import { useSelectionStore } from '@stores/selectionStore';
import { asCommandId } from '@app-types/common';

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
      canExpand: true,
      clips: [{ id: 'la', trackId: 'a' as never, nodeId: 'a' as never, start: 1, duration: 2 }],
    },
    {
      id: 'b' as never,
      name: 'Layer B',
      canExpand: true,
      depth: 1,
      clips: [{ id: 'lb', trackId: 'b' as never, nodeId: 'b' as never, start: 0, duration: 1 }],
    },
  ],
  markers: [],
  duration: 5,
  frameRate: 30,
  currentTime: 0,
  pixelsPerSecond: 100,
};

beforeEach(() => {
  usePreferenceStore.getState().set('timelineSnap', true);
  usePreferenceStore.getState().set('timelineExtraColumns', []);
});

describe('fit selection', () => {
  it('publishes what it is showing, so `timeline.fitSelection` can measure it', () => {
    // The command runs from a chord (Shift+;) with no access to the component.
    // Without this registration it is permanently `enabled: false`.
    expect(getTimelineFitSource()).toBeNull();
    render(<Timeline model={MODEL} selectedTrackIds={['a']} />);
    const src = getTimelineFitSource();
    expect(src).not.toBeNull();
    expect(src!().selectedTrackIds).toEqual(['a']);
    expect(src!().tracks).toHaveLength(2);
  });
});

describe('expand / collapse', () => {
  it('registers the expand-all and collapse-all commands', () => {
    render(<Timeline model={MODEL} />);
    const registry = getCommandRegistry();
    expect(registry.get(asCommandId('timeline.expandAll'))).toBeDefined();
    expect(registry.get(asCommandId('timeline.collapseAll'))).toBeDefined();
  });

  it('Alt+click on a disclosure toggles the layer AND its descendants', () => {
    const onToggle = jest.fn();
    render(<Timeline model={MODEL} expandedTrackIds={[]} onTrackToggleExpand={onToggle} />);
    fireEvent.click(screen.getAllByLabelText('Reveal animated properties')[0]!, { altKey: true });
    // `b` is nested under `a` (depth 1), so a recursive open reaches both.
    expect(onToggle.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
  });

  it('a plain click toggles only the layer clicked', () => {
    const onToggle = jest.fn();
    render(<Timeline model={MODEL} expandedTrackIds={[]} onTrackToggleExpand={onToggle} />);
    fireEvent.click(screen.getAllByLabelText('Reveal animated properties')[0]!);
    expect(onToggle.mock.calls.map((c) => c[0])).toEqual(['a']);
  });
});

describe('snap', () => {
  it('claims `s` on the root, so the global `S` (reveal Scale) is not stolen', () => {
    const { container } = render(<Timeline model={MODEL} />);
    const root = container.firstElementChild as HTMLElement;
    // The claim and the handler have to name the same chord: a claim without a
    // handler swallows the key, a handler without a claim fights the global.
    expect(root.getAttribute('data-shortcut-claim')?.split(/\s+/)).toContain('s');
  });

  it('`s` inside the panel flips the persisted switch', () => {
    const { container } = render(<Timeline model={MODEL} />);
    const root = container.firstElementChild as HTMLElement;
    expect(usePreferenceStore.getState().timelineSnap).toBe(true);
    act(() => {
      fireEvent.keyDown(root, { key: 's' });
    });
    expect(usePreferenceStore.getState().timelineSnap).toBe(false);
  });

  it('leaves `s` alone while a field has focus', () => {
    const { container } = render(<Timeline model={MODEL} />);
    const root = container.firstElementChild as HTMLElement;
    const input = document.createElement('input');
    root.appendChild(input);
    act(() => {
      fireEvent.keyDown(input, { key: 's', bubbles: true });
    });
    expect(usePreferenceStore.getState().timelineSnap).toBe(true);
  });

  it('offers the switch as a button, not only as a chord', () => {
    // In the PANEL's toolbar row, not inside <Timeline>: the timeline's tools
    // have one home, the row between the comp tabs and the tracks.
    render(<BottomTimeline model={MODEL} />);
    const btn = screen.getByLabelText('Snap in timeline');
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(btn);
    expect(usePreferenceStore.getState().timelineSnap).toBe(false);
  });
});

describe('playhead follow', () => {
  it('offers the three modes as one cycling control', () => {
    usePreferenceStore.getState().set('timelineFollowMode', 'off');
    render(<BottomTimeline model={MODEL} />);
    fireEvent.click(screen.getByLabelText('Playhead follow: Off'));
    expect(usePreferenceStore.getState().timelineFollowMode).toBe('page');
    fireEvent.click(screen.getByLabelText('Playhead follow: Page'));
    expect(usePreferenceStore.getState().timelineFollowMode).toBe('continuous');
    fireEvent.click(screen.getByLabelText('Playhead follow: Continuous'));
    expect(usePreferenceStore.getState().timelineFollowMode).toBe('off');
  });
});

describe('the layer rows as a listbox', () => {
  const rows = (): HTMLElement[] => screen.getAllByRole('option');

  it('is one tab stop, not one per layer', () => {
    render(<Timeline model={MODEL} />);
    const tabbable = rows().filter((r) => r.getAttribute('tabindex') === '0');
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toHaveAttribute('aria-label', 'Layer A');
  });

  it('Down moves the active row and selects it', () => {
    const onSelect = jest.fn();
    render(<Timeline model={MODEL} onTrackSelect={onSelect} />);
    fireEvent.keyDown(rows()[0]!, { key: 'ArrowDown' });
    expect(onSelect).toHaveBeenCalledWith('b', false);
    expect(rows()[1]).toHaveAttribute('tabindex', '0');
    expect(rows()[0]).toHaveAttribute('tabindex', '-1');
  });

  it('Shift+Down extends instead of replacing', () => {
    const onSelect = jest.fn();
    render(<Timeline model={MODEL} onTrackSelect={onSelect} />);
    fireEvent.keyDown(rows()[0]!, { key: 'ArrowDown', shiftKey: true });
    expect(onSelect).toHaveBeenCalledWith('b', true);
  });

  it('End goes to the last row, Home back to the first', () => {
    const onSelect = jest.fn();
    render(<Timeline model={MODEL} onTrackSelect={onSelect} />);
    fireEvent.keyDown(rows()[0]!, { key: 'End' });
    expect(onSelect).toHaveBeenLastCalledWith('b', false);
    fireEvent.keyDown(rows()[1]!, { key: 'Home' });
    expect(onSelect).toHaveBeenLastCalledWith('a', false);
  });

  it('Enter toggles the disclosure and Space the visibility', () => {
    const onToggleExpand = jest.fn();
    const onToggleVisible = jest.fn();
    render(
      <Timeline
        model={MODEL}
        expandedTrackIds={[]}
        onTrackToggleExpand={onToggleExpand}
        onTrackToggleVisible={onToggleVisible}
      />,
    );
    fireEvent.keyDown(rows()[0]!, { key: 'Enter' });
    expect(onToggleExpand).toHaveBeenCalledWith('a');
    fireEvent.keyDown(rows()[0]!, { key: ' ' });
    expect(onToggleVisible).toHaveBeenCalledWith('a');
  });
});

/**
 * Delete from the row you just clicked.
 *
 * The root CLAIMS `delete` / `backspace` so a keyframe selection can have them,
 * and a claim makes `ShortcutManager` skip the chord whatever is selected. With
 * no keyframes selected nothing picked the key back up — and clicking a layer's
 * name, the ordinary way to select one, is exactly what puts focus on a row
 * inside the claim. So the medium is a keydown ON THE ROW: the global command
 * being correct is the reason this went unnoticed.
 */
describe('Delete / Backspace on a focused layer row', () => {
  const rows = (): HTMLElement[] => screen.getAllByRole('option');
  const execute = jest.fn();

  beforeEach(() => {
    execute.mockClear();
    setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
    const registry = getCommandRegistry();
    if (registry.get(BuiltinCommands.DeleteSelected)) registry.unregister(BuiltinCommands.DeleteSelected);
    // The REAL id with a spy behind it: what is under test is that the panel
    // routes to the command the global chord runs, not what that command does.
    registry.register({
      id: BuiltinCommands.DeleteSelected,
      label: 'Delete Selected',
      enabled: () => useSelectionStore.getState().count() > 0,
      execute,
    });
    useSelectionStore.getState().set(['a']);
  });

  it('POSITIVE CONTROL: the root claims both keys, so the global chord cannot fire here', () => {
    const { container } = render(<Timeline model={MODEL} />);
    const claim = (container.firstElementChild as HTMLElement).getAttribute('data-shortcut-claim')!.split(/\s+/);
    expect(claim).toEqual(expect.arrayContaining(['delete', 'backspace']));
  });

  it.each(['Delete', 'Backspace'])('%s runs the Delete Selected command', (key) => {
    render(<Timeline model={MODEL} selectedTrackIds={['a']} />);
    const notCancelled = fireEvent.keyDown(rows()[0]!, { key });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(notCancelled).toBe(false); // preventDefault — Backspace must not navigate
  });

  it('does nothing, and leaves the key alone, with no layer selected', () => {
    useSelectionStore.getState().set([]);
    render(<Timeline model={MODEL} />);
    expect(fireEvent.keyDown(rows()[0]!, { key: 'Delete' })).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('leaves Backspace to a text field inside the panel', () => {
    const { container } = render(<Timeline model={MODEL} />);
    const input = document.createElement('input');
    (container.firstElementChild as HTMLElement).appendChild(input);
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('Ctrl+Backspace is not a delete', () => {
    render(<Timeline model={MODEL} />);
    fireEvent.keyDown(rows()[0]!, { key: 'Backspace', ctrlKey: true });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('J / K', () => {
  it('are claimed on the root, where they mean previous / next keyframe', () => {
    // `useTimelineKeys` reads this same claim to decide whether J / K are its
    // own, so the claim is the single switch for both halves of the rule.
    const { container } = render(<Timeline model={MODEL} />);
    const claim = (container.firstElementChild as HTMLElement).getAttribute('data-shortcut-claim')!.split(/\s+/);
    expect(claim).toEqual(expect.arrayContaining(['j', 'k']));
  });
});

describe('In / Out / Duration columns', () => {
  it('ships none of them by default', () => {
    render(<Timeline model={MODEL} />);
    expect(screen.queryByText('Duration')).not.toBeInTheDocument();
  });

  it('adds a head and a per-layer cell for each column the preference names', () => {
    usePreferenceStore.getState().set('timelineExtraColumns', ['in', 'duration']);
    render(<Timeline model={MODEL} />);
    expect(screen.getByText('In')).toBeInTheDocument();
    expect(screen.getByText('Duration')).toBeInTheDocument();
    // Layer A spans 1s → 3s at 30fps: in 30, duration 60. Read off the CELLS
    // by title — a bare `getByText('30')` also matches a ruler tick.
    expect(screen.getAllByTitle('In (frames)')[0]).toHaveTextContent('30');
    expect(screen.getAllByTitle('Duration (frames)')[0]).toHaveTextContent('60');
  });

  it('never offers Stretch — there is no time-stretch API behind it', () => {
    usePreferenceStore.getState().set('timelineExtraColumns', ['stretch']);
    render(<Timeline model={MODEL} />);
    expect(screen.queryByText('Stretch')).not.toBeInTheDocument();
  });
});
