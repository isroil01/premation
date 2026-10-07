/**
 * The timeline panel's toolbar — ONE row between the comp tabs and the tracks,
 * in TWO columns that are the columns beneath it.
 *
 * The LEFT column is exactly the track-header column's width and holds After
 * Effects' timeline header: the timecode, Snap, the filter, Graph Editor and a
 * View menu that holds the timeline tool, playhead follow, the listing toggles
 * and the preview cache (2026-10-07: no edit-tool row, no transition chips —
 * transitions come from the Library). The RIGHT column is exactly the lanes and holds only the time
 * navigator. This pins that the row is the only tool row in the panel, that
 * the absorbed toggles still reach their stores from the menu, the two
 * columns' geometry, and the shed ladder that keeps the buttons on their side
 * of the seam.
 */

import { render, screen, fireEvent, within } from '@testing-library/react';
import { BottomTimeline, TIMELINE_TOOLBAR_DEMOTE_ORDER, isToolbarShed } from './BottomTimeline';
import { navigatorColumnFor } from './toolbarGeometry';
import type { TimelineModel } from '@layout/Timeline/TimelineModel';
import { headerWidthFor, TIMELINE_LEFT_OFFSET } from '@layout/Timeline/timelineShared';
import { setTimelineViewportWidth } from '@layout/Timeline/timelineViewport';
import { useUIStore } from '@stores/uiStore';
import { usePropertySelectionStore } from '@stores/propertySelectionStore';
import { usePreferenceStore } from '@stores/preferenceStore';

class NoopResizeObserver {
  observe(): void { /* no layout in jsdom */ }
  unobserve(): void { /* no layout in jsdom */ }
  disconnect(): void { /* no layout in jsdom */ }
}
beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver;
});
afterEach(() => setTimelineViewportWidth(0));

const MODEL: TimelineModel = {
  tracks: [
    { id: 'a' as never, name: 'Layer A', canExpand: true, clips: [{ id: 'la', trackId: 'a' as never, nodeId: 'a' as never, start: 1, duration: 2 }] },
  ],
  markers: [],
  duration: 5,
  frameRate: 30,
  currentTime: 0,
  pixelsPerSecond: 100,
};

function toolbar(model: TimelineModel = MODEL): HTMLElement {
  render(<BottomTimeline model={model} />);
  return screen.getByRole('toolbar', { name: 'Timeline tools' });
}

const toolsCol = (t: HTMLElement): HTMLElement => t.querySelector<HTMLElement>('[data-timeline-toolbar-tools]')!;
const navCol = (t: HTMLElement): HTMLElement => t.querySelector<HTMLElement>('[data-timeline-toolbar-navigator]')!;

/**
 * jsdom lays nothing out, so the width contract is exercised by faking the
 * one thing the ladder reads: every element reports a client width smaller
 * than its scroll width. `useTransportDemote` then climbs its ladder to the
 * top, one measured step per level, exactly as a too-narrow column would
 * drive it.
 */
function cramped(run: () => void): void {
  const proto = HTMLElement.prototype;
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => 100 });
  Object.defineProperty(proto, 'scrollWidth', { configurable: true, get: () => 400 });
  try {
    run();
  } finally {
    delete (proto as { clientWidth?: unknown }).clientWidth;
    delete (proto as { scrollWidth?: unknown }).scrollWidth;
  }
}

it('is the only tool row in the panel, with no edit-tool row or transition chips', () => {
  toolbar();
  expect(screen.getAllByRole('toolbar', { name: 'Timeline tools' })).toHaveLength(1);
  expect(screen.queryByRole('radiogroup', { name: 'Timeline edit tool' })).toBeNull();
  expect(screen.queryByRole('group', { name: 'Transitions' })).toBeNull();
  expect(screen.queryAllByRole('button', { name: /transition$/ })).toHaveLength(0);
});

it('holds timecode · Snap · filter · Graph Editor · View in the left column, the navigator in the right', () => {
  const t = toolbar();
  const left = toolsCol(t);
  const order = [
    within(left).getByTitle(/^Current timecode/),
    within(left).getByRole('button', { name: 'Snap in timeline' }),
    within(left).getByRole('searchbox', { name: 'Search layers and properties' }),
    within(left).getByRole('button', { name: 'Toggle Graph Editor' }),
    within(left).getByRole('button', { name: 'Timeline view options' }),
  ];
  for (let i = 1; i < order.length; i++) {
    // DOCUMENT_POSITION_FOLLOWING: the previous element precedes this one.
    expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
  expect(within(left).queryByRole('group', { name: 'Preview cache' })).toBeNull();
  // The navigator is the right column's ONLY control, and no button is there.
  const right = navCol(t);
  expect(within(right).getByRole('scrollbar', { name: 'Time navigator' })).toBeInTheDocument();
  expect(within(right).queryAllByRole('button')).toHaveLength(0);
  expect(within(left).queryByRole('scrollbar')).toBeNull();
});

it('View holds the timeline tool, playhead follow and the preview cache', () => {
  const t = toolbar();
  fireEvent.click(within(t).getByRole('button', { name: 'Timeline view options' }));
  expect(screen.getByRole('menuitem', { name: /^Timeline tool:/ })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: /^Playhead follow:/ })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: 'Preview cache' })).toBeInTheDocument();
});

describe('the two columns are the columns beneath them', () => {
  it('the left column is exactly the track-header column width the model pins', () => {
    const t = toolbar({ ...MODEL, trackHeaderWidth: 333 });
    expect(toolsCol(t).style.width).toBe('333px');
    // The header column below resolves the same number from the same input.
    expect(document.querySelector<HTMLElement>('[data-tour="timeline"] > div')!.style.width).toBe('333px');
  });

  it('without a pinned width, both columns follow the header-width preference', () => {
    usePreferenceStore.getState().set('timelineHeaderWidth', 412);
    const t = toolbar();
    expect(toolsCol(t).style.width).toBe('412px');
    expect(document.querySelector<HTMLElement>('[data-tour="timeline"] > div')!.style.width).toBe('412px');
    usePreferenceStore.getState().set('timelineHeaderWidth', headerWidthFor('both'));
  });

  it('the navigator column is placed over the lanes from their measured geometry', () => {
    // The lanes report a 600px client width starting 500px into the window;
    // the toolbar row starts 20px in. The navigator then starts at the ruler's
    // time origin (500 - 20 + the 8px lane gutter) and spans the client width
    // less that gutter.
    const proto = HTMLElement.prototype;
    const rectOf = (el: HTMLElement): DOMRect => {
      const left = el.hasAttribute('data-timeline-lanes') ? 500 : el.hasAttribute('data-timeline-toolbar') ? 20 : 0;
      const width = el.hasAttribute('data-timeline-lanes') ? 600 : 0;
      return { left, right: left + width, width, top: 0, bottom: 0, height: 0, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
    };
    Object.defineProperty(proto, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) { return this.hasAttribute('data-timeline-lanes') ? 600 : 0; },
    });
    const originalRect = proto.getBoundingClientRect;
    proto.getBoundingClientRect = function (this: HTMLElement) { return rectOf(this); };
    try {
      const t = toolbar();
      const right = navCol(t);
      expect(right.style.left).toBe(`${500 - 20 + TIMELINE_LEFT_OFFSET}px`);
      expect(right.style.width).toBe(`${600 - TIMELINE_LEFT_OFFSET}px`);
    } finally {
      delete (proto as { clientWidth?: unknown }).clientWidth;
      proto.getBoundingClientRect = originalRect;
    }
  });

  it('with nothing measured, the navigator column is unpinned and takes the rest of the row', () => {
    const t = toolbar();
    const right = navCol(t);
    expect(right.style.left).toBe('');
    expect(right.style.width).toBe('');
  });

  it('navigatorColumnFor: time origin to the visible clips, minus any minimap gutter', () => {
    expect(navigatorColumnFor({ width: 600, left: 500, gutter: 0 }, 20)).toEqual({ left: 488, width: 592 });
    expect(navigatorColumnFor({ width: 600, left: 500, gutter: 12 }, 20)).toEqual({ left: 488, width: 580 });
    expect(navigatorColumnFor({ width: 0, left: 0, gutter: 0 }, 20)).toBeNull();
    // A lane area narrower than its own gutter is nothing to align to.
    expect(navigatorColumnFor({ width: 6, left: 500, gutter: 0 }, 20)).toBeNull();
  });
});

it('the listing toggles are rows of the View menu; Hide Shy is AE\'s header switch', () => {
  const t = toolbar();
  expect(within(t).getByRole('button', { name: 'Hide Shy Layers' })).toBeInTheDocument();
  expect(within(t).getByRole('button', { name: 'Enable Motion Blur' })).toBeInTheDocument();
  expect(within(t).getByRole('button', { name: 'Auto-Keyframe mode' })).toBeInTheDocument();
  // Draft 3D is the Composition panel's button (AE 2022+), not a timeline switch.
  expect(within(t).queryByRole('button', { name: 'Draft 3D' })).toBeNull();
  for (const name of [
    'Proportional Scrubbing', 'Highlight what changed', 'Transcript lane',
    'Toggle Switches / Modes', 'Timeline columns', 'Change timeline row height',
  ]) {
    expect(within(t).queryByRole('button', { name })).toBeNull();
  }
  fireEvent.click(within(t).getByRole('button', { name: 'Timeline view options' }));
  expect(screen.queryByRole('menuitemcheckbox', { name: 'Hide Shy Layers' })).toBeNull();
  expect(screen.getByRole('menuitemcheckbox', { name: /^Proportional Scrubbing/ })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: /^Highlight what changed/ })).toBeInTheDocument();
  expect(screen.getByRole('menuitemcheckbox', { name: /^Transcript lane/ })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: /^Switches \/ Modes/ })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: /^Columns/ })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: /^Row height/ })).toBeInTheDocument();
});

it('the View menu rows write the same stores the buttons did', () => {
  const t = toolbar();
  const shyBefore = useUIStore.getState().globalShy;
  const propBefore = usePropertySelectionStore.getState().proportional;
  // Checkbox rows keep the menu open (a checkbox that closed the menu would
  // make flipping two settings cost four clicks); a submenu row closes it.
  fireEvent.click(within(t).getByRole('button', { name: 'Hide Shy Layers' }));
  expect(useUIStore.getState().globalShy).toBe(!shyBefore);
  useUIStore.getState().setGlobalShy(shyBefore);
  fireEvent.click(within(t).getByRole('button', { name: 'Timeline view options' }));
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /^Proportional Scrubbing/ }));
  expect(usePropertySelectionStore.getState().proportional).toBe(!propBefore);

  fireEvent.click(screen.getByRole('menuitem', { name: /^Row height/ }));
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /^Tall/ }));
  expect(usePreferenceStore.getState().timelineRowHeight).toBe(46);
});

it('keeps the Graph Editor toggle visible, with the label the tour anchors on', () => {
  const t = toolbar();
  const btn = within(t).getByRole('button', { name: 'Toggle Graph Editor' });
  expect(btn).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(btn);
  expect(useUIStore.getState().graphEditorOpen).toBe(true);
  useUIStore.getState().setGraphEditorOpen(false);
});

describe('the shed ladder', () => {
  it('has one rung: View folds into a ⋯', () => {
    expect(TIMELINE_TOOLBAR_DEMOTE_ORDER).toEqual(['more']);
    expect(isToolbarShed('more', 0)).toBe(false);
    expect(isToolbarShed('more', 1)).toBe(true);
  });

  it('when the header column is too narrow, the left column ends as timecode · Snap · filter · Graph Editor · ⋯ — nothing crosses the seam', () => {
    cramped(() => {
      const t = toolbar();
      const left = toolsCol(t);
      expect(within(left).queryByRole('button', { name: 'Timeline view options' })).toBeNull();
      // What stays, and the one trigger that holds the rest.
      expect(within(left).getByTitle(/^Current timecode/)).toBeInTheDocument();
      expect(within(left).getByRole('searchbox', { name: 'Search layers and properties' })).toBeInTheDocument();
      expect(within(left).getByRole('button', { name: 'Toggle Graph Editor' })).toBeInTheDocument();
      expect(within(left).getByRole('button', { name: 'Snap in timeline' })).toBeInTheDocument();
      const more = within(left).getByRole('button', { name: 'More timeline tools' });
      expect(within(left).getAllByRole('button')).toHaveLength(7); // timecode, snap, shy, motion blur, draft 3D, graph editor, ⋯
      // The navigator never leaves its own column.
      expect(within(navCol(t)).getByRole('scrollbar', { name: 'Time navigator' })).toBeInTheDocument();

      // View's rows are the ⋯'s rows, reaching the same stores.
      fireEvent.click(more);
      expect(screen.getByRole('menuitem', { name: /^Timeline tool:/ })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: /^Row height/ })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Preview cache' })).toBeInTheDocument();
      const propBefore = usePropertySelectionStore.getState().proportional;
      fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /^Proportional Scrubbing/ }));
      expect(usePropertySelectionStore.getState().proportional).toBe(!propBefore);
    });
  });
});
