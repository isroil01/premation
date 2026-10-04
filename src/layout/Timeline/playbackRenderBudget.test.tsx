/**
 * The playback render budget: **N ticks of playback cost O(1) React renders
 * of the timeline panel and the inspector, not O(N).**
 *
 * The playhead moves 60×/s. Everything that has to follow it at that rate —
 * the playhead line, the ruler's progress fill, the timecode — is moved
 * imperatively from a `subscribeTime` subscription (the `KeyframeLane`
 * pattern), and everything that merely DISPLAYS a value at the playhead reads
 * `useThrottledTime`, which is exact while paused and refreshes at
 * `PLAYING_UI_REFRESH_MS` while playing. A component that selects the raw
 * clock in render instead re-renders once per tick, which is the regression
 * this file exists to catch.
 *
 * Counted with React's `<Profiler>`: its `onRender` fires once per commit that
 * touched the subtree, so the numbers are real React work, not a proxy.
 */

import { Profiler } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { BottomTimeline } from '@layout/BottomTimeline/BottomTimeline';
import { TransformSection } from '@layout/Inspector/TransformSection';
import type { TimelineModel } from './TimelineModel';

import { useProjectStore } from '@stores/projectStore';
import { setTime, getTime } from '@stores/playbackClockStore';

class NoopResizeObserver {
  observe(): void { /* no layout in jsdom */ }
  unobserve(): void { /* no layout in jsdom */ }
  disconnect(): void { /* no layout in jsdom */ }
}

const NODE = 'budget-node';

const MODEL: TimelineModel = {
  tracks: [
    {
      id: NODE as never,
      name: 'Layer A',
      canExpand: true,
      clips: [{ id: 'la', trackId: NODE as never, nodeId: NODE as never, start: 0, duration: 5 }],
    },
  ],
  markers: [],
  duration: 5,
  frameRate: 30,
  currentTime: 0,
  pixelsPerSecond: 100,
};

/** How many playback ticks each case drives. */
const TICKS = 120;
/**
 * The ceiling on commits for the whole burst. A handful covers the mirror to
 * the project store (≤4 Hz), the throttled display clock's leading and
 * trailing refresh, and the play-state flip itself — none of which scale with
 * the tick count. Anything per-tick blows straight through it.
 */
const BUDGET = 8;

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver;
});

beforeEach(() => {
  const ws = useProjectStore.getState();
  ws.actions.setPlaying(false);
  setTime(ws.activeTabId!, 0, 0);
});

afterEach(() => {
  cleanup();
  act(() => { useProjectStore.getState().actions.setPlaying(false); });
});

afterAll(() => {
});

function mountPanels(): { timeline: { n: number }; inspector: { n: number }; container: HTMLElement } {
  const timeline = { n: 0 };
  const inspector = { n: 0 };
  const view = render(
    <>
      <Profiler id="timeline" onRender={() => { timeline.n += 1; }}>
        <BottomTimeline model={MODEL} />
      </Profiler>
      <Profiler id="inspector" onRender={() => { inspector.n += 1; }}>
        <TransformSection nodeId={NODE} />
      </Profiler>
    </>,
  );
  return { timeline, inspector, container: view.container };
}

/** Play N frames the way the pump does: one clock write per tick. */
function playTicks(from: number): number {
  const tab = useProjectStore.getState().activeTabId!;
  let t = from;
  for (let i = 0; i < TICKS; i += 1) {
    t = from + (i + 1) / 60;
    act(() => { setTime(tab, t); });
  }
  return t;
}

describe('playback render budget', () => {
  it('N playing ticks re-render the timeline panel and the inspector O(1) times', () => {
    const { timeline, inspector } = mountPanels();
    act(() => { useProjectStore.getState().actions.setPlaying(true); });
    timeline.n = 0;
    inspector.n = 0;

    playTicks(0);

    // Reported so a regression shows its size, not just that it failed.
    // eslint-disable-next-line no-console
    console.log(`[render budget] ${TICKS} ticks → timeline ${timeline.n} commits, inspector ${inspector.n} commits`);
    expect(timeline.n).toBeLessThanOrEqual(BUDGET);
    expect(inspector.n).toBeLessThanOrEqual(BUDGET);
  });

  it('the playhead line still moves on every tick, without React', () => {
    const { container } = mountPanels();
    act(() => { useProjectStore.getState().actions.setPlaying(true); });
    const tab = useProjectStore.getState().activeTabId!;
    const playhead = container.querySelector<HTMLElement>('[role="slider"][aria-orientation="horizontal"]');
    expect(playhead).not.toBeNull();
    for (const t of [0.5, 1.25, 2]) {
      act(() => { setTime(tab, t); });
      // TIMELINE_LEFT_OFFSET (8) + t × pps — read back exactly as written.
      expect(playhead!.style.transform).toBe(`translateX(${8 + t * MODEL.pixelsPerSecond}px)`);
      expect(Number(playhead!.getAttribute('aria-valuenow'))).toBeCloseTo(t, 6);
    }
  });

  it('a paused seek is exact immediately — no throttle while not playing', () => {
    const { container } = mountPanels();
    const tab = useProjectStore.getState().activeTabId!;
    act(() => { setTime(tab, 1.5, 45); });
    expect(getTime()).toBe(1.5);
    // The timecode button is the panel's own readout of the playhead.
    const timecode = container.querySelector('[title^="Current timecode"]');
    expect(timecode?.textContent).toBe('00:01:15');
  });
});
