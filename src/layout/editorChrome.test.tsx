/**
 * The three chrome rows of the editor body — one control, one home, one row.
 *
 *   tabs row  (EditorTabs: tabs + lock + menu)
 *   the stage
 *   transport row  (TransportBar: clip edits · timecode · transport ·
 *                   loop/marker · scene tools · display controls · zoom)
 *   …
 *   timeline toolbar  (BottomTimeline sub-header: buttons over the header
 *                      column, the navigator over the lanes)
 *
 * Two contracts, both of which previous rounds broke without any test going
 * red:
 *
 *  1. NO CONTROL APPEARS TWICE. Every accessible name across the three rows
 *     is unique. A second "Play", a second resolution picker or a second
 *     "Hide Shy Layers" is exactly the regression this exists to catch.
 *
 *  2. NO ROW WRAPS. jsdom has no layout engine, so the width contract is
 *     pinned on its source: each row is a `nowrap` flex run or a fixed-column
 *     grid with `overflow: hidden`, and its overflow is handled by shedding
 *     into a menu (`useTransportDemote`) rather than by a second line. The
 *     1100px-wide render below is the mechanism check that goes with it:
 *     every shed rung of every row exists and yields a single overflow
 *     trigger, so there is always a width at which the row fits on one line.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { computeAccessibleName } from 'dom-accessibility-api';
import { EditorTabs } from './Tabs/EditorTabs';
import { TransportBar } from './Workspace/TransportBar';
import { BottomTimeline } from './BottomTimeline/BottomTimeline';
import type { TimelineModel } from './Timeline/TimelineModel';

class NoopResizeObserver {
  observe(): void { /* no layout in jsdom */ }
  unobserve(): void { /* no layout in jsdom */ }
  disconnect(): void { /* no layout in jsdom */ }
}
beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver;
});

beforeEach(() => {
  localStorage.clear();
});

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

const ROW_SELECTORS = [
  ['tabs row', '[role="tablist"][aria-label="Editor tabs"]'],
  ['transport row', '[role="toolbar"][aria-label="Viewport transport and tools"]'],
  ['timeline toolbar', '[role="toolbar"][aria-label="Timeline tools"]'],
] as const;

function renderRows(): void {
  render(
    <>
      <EditorTabs scene={<canvas />} />
      <TransportBar />
      <BottomTimeline model={MODEL} />
    </>,
  );
}

/** Every named control in a row: buttons, radios, fields, sliders, groups. */
function namedControls(row: Element): Array<{ name: string; role: string }> {
  const nodes = row.querySelectorAll<HTMLElement>(
    'button, input, [role="radio"], [role="group"], [role="radiogroup"], [role="scrollbar"], [role="searchbox"], [role="status"]',
  );
  const out: Array<{ name: string; role: string }> = [];
  for (const el of Array.from(nodes)) {
    const name = computeAccessibleName(el).trim();
    if (!name) continue;
    out.push({ name, role: el.getAttribute('role') ?? el.tagName.toLowerCase() });
  }
  return out;
}

describe('one control, one home', () => {
  it('renders each of the three rows exactly once', () => {
    renderRows();
    for (const [, selector] of ROW_SELECTORS) {
      expect(document.querySelectorAll(selector)).toHaveLength(1);
    }
    // And no fourth row: the old header strip and the old in-timeline tool
    // row are both gone.
    expect(document.querySelector('[data-viewport-header]')).toBeNull();
    expect(screen.getAllByRole('toolbar')).toHaveLength(2);
  });

  it('gives every control across the three rows a unique accessible name', () => {
    renderRows();
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const [rowName, selector] of ROW_SELECTORS) {
      const row = document.querySelector(selector)!;
      for (const { name, role } of namedControls(row)) {
        const key = `${role}:${name}`;
        const prior = seen.get(key);
        if (prior) dupes.push(`"${name}" (${role}) in ${prior} and ${rowName}`);
        else seen.set(key, rowName);
      }
    }
    expect(dupes).toEqual([]);
    // Sanity: the sweep actually saw the controls it is guarding.
    expect(seen.has('button:Play')).toBe(true);
    expect(seen.has('button:Toggle Graph Editor')).toBe(true);
    expect([...seen.keys()].some((k) => k.startsWith('button:Preview resolution:'))).toBe(true);
    // And the resolution control's home is the transport row, not the tabs.
    expect(seen.get([...seen.keys()].find((k) => k.startsWith('button:Preview resolution:'))!)).toBe('transport row');
  });

  it('the tabs row holds only the tabs, the lock and the panel menu', () => {
    renderRows();
    const strip = document.querySelector(ROW_SELECTORS[0][1])!;
    const names = namedControls(strip).filter((c) => c.role !== 'tab').map((c) => c.name);
    expect(names).toEqual(['Lock view', 'Composition panel menu']);
  });

  it('has one play button, one resolution control and one shy toggle in the whole body', () => {
    renderRows();
    expect(screen.getAllByRole('button', { name: 'Play' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /^Preview resolution:/ })).toHaveLength(1);
    expect(screen.queryAllByRole('button', { name: 'Hide Shy Layers' })).toHaveLength(0);
    expect(screen.queryAllByRole('button', { name: 'View Options' })).toHaveLength(0);
    // The tour's anchors still resolve.
    expect(document.querySelector('[role="toolbar"][aria-label="Viewport transport and tools"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Toggle Graph Editor"]')).not.toBeNull();
    expect(document.querySelector('[data-tour="timeline"]')).not.toBeNull();
  });
});

describe('no row wraps', () => {
  const css = (rel: string): string => readFileSync(join(__dirname, rel), 'utf8').replace(/\r\n/g, '\n');
  const block = (source: string, selector: string): string => {
    const at = source.indexOf(selector);
    expect(at).toBeGreaterThan(-1);
    return source.slice(at, source.indexOf('}', at));
  };

  it('the tabs row is a nowrap flex run that clips', () => {
    const strip = block(css('Tabs/EditorTabs.module.css'), '.strip {');
    expect(strip).toContain('flex-wrap: nowrap;');
    expect(strip).toContain('overflow: hidden;');
    // The tab run is the column that overflows first, and its tabs do not
    // shrink — that is what makes the deficit measurable.
    expect(block(css('Tabs/EditorTabs.module.css'), '.tabs {')).toContain('flex-wrap: nowrap;');
    expect(block(css('Tabs/EditorTabs.module.css'), '.tab {')).toContain('flex: 0 0 auto;');
  });

  it('the transport row is a fixed three-column grid whose runs are nowrap', () => {
    const bar = block(css('Workspace/TransportBar.module.css'), '.bar {');
    expect(bar).toContain('display: grid;');
    expect(bar).toContain('grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);');
    expect(bar).toContain('overflow: hidden;');
    expect(block(css('Workspace/TransportBar.module.css'), '.sideLeft,\n.sideRight {')).toContain('flex-wrap: nowrap;');
    expect(block(css('Workspace/TransportBar.module.css'), '.cluster {')).toContain('flex-wrap: nowrap;');
  });

  it('the timeline toolbar is a nowrap flex run that clips at the row edge only, with a fixed-width left column', () => {
    const source = css('BottomTimeline/BottomTimeline.module.css');
    const row = block(source, '.subHeaderRow {');
    expect(row).toContain('flex-wrap: nowrap;');
    expect(row).toContain('overflow: hidden;');
    // No row padding: the left column's outer width IS the header width.
    expect(row).toContain('padding: 0 0 2px;');
    // The left column does not shrink and does not clip — a control past its
    // width is a deficit the ladder reads, not something cut off.
    const col = block(source, '.toolsCol {');
    expect(col).toContain('flex: none;');
    expect(col).toContain('box-sizing: border-box;');
    expect(col).not.toContain('overflow: hidden;');
    // The navigator's pinned form is placed absolutely over the lanes.
    expect(block(source, '.navigatorColPinned {')).toContain('position: absolute;');
  });

  it('at 1100px every row has a shed rung that ends in one overflow trigger', () => {
    // jsdom cannot lay the rows out, so this exercises the mechanism the
    // width contract rests on: with every element reporting less client
    // width than content, each row climbs its ladder to the top and ends as
    // a single trigger plus the controls that cannot leave, and nothing wraps
    // because nothing is left to wrap.
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1100 });
    const proto = HTMLElement.prototype;
    Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => 100 });
    Object.defineProperty(proto, 'scrollWidth', { configurable: true, get: () => 400 });
    try {
      renderRows();
      const transport = document.querySelector(ROW_SELECTORS[1][1])!;
      expect(within(transport as HTMLElement).getAllByRole('button', { name: /^More transport controls/ })).toHaveLength(1);
      expect(within(transport as HTMLElement).queryByRole('button', { name: /^More display controls/ })).toBeNull();
      expect(within(transport as HTMLElement).queryByRole('button', { name: /^Preview resolution:/ })).toBeNull();
      expect(within(transport as HTMLElement).getByRole('button', { name: 'Play' })).toBeInTheDocument();
      const timeline = document.querySelector(ROW_SELECTORS[2][1])!;
      expect(within(timeline as HTMLElement).getAllByRole('button', { name: 'More timeline tools' })).toHaveLength(1);
      expect(within(timeline as HTMLElement).getByRole('button', { name: 'Toggle Graph Editor' })).toBeInTheDocument();
      // Play is still centred: the grid is the same three columns whatever
      // the right side has shed.
      expect(block(css('Workspace/TransportBar.module.css'), '.bar {')).toContain('grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);');
    } finally {
      delete (proto as { clientWidth?: unknown }).clientWidth;
      delete (proto as { scrollWidth?: unknown }).scrollWidth;
    }
  });
});
