/**
 * The display controls live IN the transport row.
 *
 * There is no header strip above the stage, and the tabs row is tabs, the
 * lock and the panel menu — nothing else. The row under the stage holds AE's
 * Composition panel footer: 3D view, layout and snapshots left of play;
 * resolution, preview, transparency grid, overlays, channel and exposure
 * right of it, then the magnification. This pins that home, that the
 * Overlays menu absorbed the loose toggles, that LUT / display mode moved into
 * the Preview menu, and the shed ladder — the transport bar's own, which
 * these controls lead — that keeps the row from ever wrapping.
 */

import { render, screen, fireEvent, within } from '@testing-library/react';
import { EditorTabs } from './EditorTabs';
import { TransportBar } from '@layout/Workspace/TransportBar';
import { useGuidesStore } from '@stores/guidesStore';
import { useRenderQualityStore } from '@stores/renderQualityStore';
import { useViewportDisplayStore } from '@stores/viewportDisplayStore';
import {
  ViewportDisplayControls,
  DISPLAY_DEMOTE_ORDER,
  isDisplayShed,
} from '@layout/Workspace/ViewportDisplayControls';
import { TRANSPORT_DEMOTE_ORDER } from '@layout/Workspace/transportOverflow';

beforeEach(() => {
  localStorage.clear();
  useRenderQualityStore.getState().setResolution(1);
});

function bar(): HTMLElement {
  render(<TransportBar />);
  return screen.getByRole('toolbar', { name: 'Viewport transport and tools' });
}

/** Every element reports less client width than scroll width — see the note
 *  in `timelineToolbar.test.tsx`; the ladder then climbs to its top. */
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

it('renders the display controls inside the transport row, balanced across left and right of play', () => {
  const b = bar();
  for (const name of [
    /^Viewport layout:/, /^Show channel:/, /^Preview resolution:/, 'Preview', /^Overlays/,
    /^Take Snapshot/, 'Compare snapshots', 'Toggle Transparency Grid', 'Adjust Exposure',
  ]) {
    expect(within(b).getByRole('button', { name })).toBeInTheDocument();
  }
  // Layout and snapshots are on the left of play; display controls and zoom are on the right.
  const buttons = within(b).getAllByRole('button');
  const idx = (pred: (label: string) => boolean): number => buttons.findIndex((el) => pred(el.getAttribute('aria-label') ?? ''));
  const playIdx = idx((l) => l === 'Play');
  const layoutIdx = idx((l) => l.startsWith('Viewport layout:'));
  const exposureIdx = idx((l) => l === 'Adjust Exposure');
  const zoomIdx = idx((l) => l === 'Magnification presets');
  expect(playIdx).toBeGreaterThan(-1);
  expect(layoutIdx).toBeLessThan(playIdx);
  expect(exposureIdx).toBeGreaterThan(playIdx);
  expect(zoomIdx).toBeGreaterThan(exposureIdx);
  // And no strip of their own above the stage.
  expect(document.querySelector('[data-viewport-header]')).toBeNull();
});

it('the tabs row carries none of them — only the tabs, the lock and the panel menu', () => {
  render(<EditorTabs scene={<canvas />} />);
  const strip = screen.getByRole('tablist', { name: 'Editor tabs' });
  expect(within(strip).queryByRole('group', { name: 'Viewport display' })).toBeNull();
  for (const name of [/^Viewport layout:/, /^Preview resolution:/, 'Preview', /^Overlays/, /^Pop out/]) {
    expect(within(strip).queryByRole('button', { name })).toBeNull();
  }
  expect(within(strip).getAllByRole('tab')).toHaveLength(3);
  const buttons = within(strip).getAllByRole('button').filter((b) => b.getAttribute('role') !== 'tab');
  expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Lock view', 'Composition panel menu']);
});

it('has no loose overlay toggles — they are rows of the Overlays menu', () => {
  const b = bar();
  for (const name of [/^Viewport HUD/, /^Snap to Pixel/, /^Pixel Aspect/, 'Show Guides', 'Overlay opacity']) {
    expect(within(b).queryByRole('button', { name })).toBeNull();
    expect(within(b).queryByRole('slider', { name })).toBeNull();
  }
  fireEvent.click(within(b).getByRole('button', { name: /^Overlays/ }));
  for (const label of ['Grid', 'Rulers', 'Safe Areas', 'Smart Guides', 'Guides', 'Snap to Pixel', 'Pixel Aspect Correction']) {
    expect(screen.getByRole('menuitemcheckbox', { name: label })).toBeInTheDocument();
  }
  expect(screen.getByRole('menuitemcheckbox', { name: /^HUD/ })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: 'Motion Path Dots' })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: 'Clear Guides' })).toBeInTheDocument();
  // The slider is the last row, and is a real range input.
  expect(screen.getByLabelText('Overlay opacity')).toHaveAttribute('type', 'range');
  // A row writes the store the overlay reads.
  const before = useGuidesStore.getState().grid;
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Grid' }));
  expect(useGuidesStore.getState().grid).toBe(!before);
});

it('the viewer LUT and the display mode are rows of the Preview menu, not buttons', () => {
  const b = bar();
  for (const name of [/^Viewer LUT/, /^Display mode/, /^Camera bookmarks/, /^Pop out/]) {
    expect(within(b).queryByRole('button', { name })).toBeNull();
  }
  fireEvent.click(within(b).getByRole('button', { name: 'Preview' }));
  expect(screen.getByRole('menuitem', { name: /^Viewer LUT/ })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: /^Display: / })).toBeInTheDocument();
});

it('exposure and the transparency grid write the viewer store (never the document)', () => {
  useViewportDisplayStore.setState({ exposure: 0, transparencyGrid: false });
  const b = bar();
  fireEvent.click(within(b).getByRole('button', { name: 'Toggle Transparency Grid' }));
  expect(useViewportDisplayStore.getState().transparencyGrid).toBe(true);
  const value = within(b).getByRole('spinbutton', { name: 'Exposure in stops' });
  fireEvent.keyDown(value, { key: 'ArrowUp' });
  expect(useViewportDisplayStore.getState().exposure).toBeCloseTo(0.1);
  // The icon resets it, as AE's does.
  fireEvent.click(within(b).getByRole('button', { name: /^Reset Exposure/ }));
  expect(useViewportDisplayStore.getState().exposure).toBe(0);
});

it('the resolution dropdown writes the store', () => {
  const b = bar();
  fireEvent.click(within(b).getByRole('button', { name: /^Preview resolution/ }));
  const items = screen.getAllByRole('menuitemcheckbox');
  expect(items).toHaveLength(4);
  fireEvent.click(items[1]!);
  expect(useRenderQualityStore.getState().resolution).toBe(2);
  // The Preview menu no longer carries a resolution row.
  fireEvent.click(within(b).getByRole('button', { name: 'Preview' }));
  expect(screen.queryByRole('menuitem', { name: /^Resolution:/ })).toBeNull();
  expect(screen.getByRole('menuitemcheckbox', { name: /^Auto resolution/ })).toBeInTheDocument();
});

describe('the shed ladder', () => {
  it('sheds one control per level, exposure first, layout last', () => {
    expect(DISPLAY_DEMOTE_ORDER[0]).toBe('exposure');
    expect(DISPLAY_DEMOTE_ORDER[DISPLAY_DEMOTE_ORDER.length - 1]).toBe('layout');
    for (let level = 0; level <= DISPLAY_DEMOTE_ORDER.length; level++) {
      const shed = DISPLAY_DEMOTE_ORDER.filter((g) => isDisplayShed(g, level));
      expect(shed).toEqual(DISPLAY_DEMOTE_ORDER.slice(0, level));
    }
  });

  it('leads the transport bar\'s ladder: all of them go before the bar\'s own zoom field', () => {
    expect([...TRANSPORT_DEMOTE_ORDER.slice(0, DISPLAY_DEMOTE_ORDER.length)]).toEqual([...DISPLAY_DEMOTE_ORDER]);
    expect(TRANSPORT_DEMOTE_ORDER[DISPLAY_DEMOTE_ORDER.length]).toBe('zoom');
  });

  it('standalone, at the top of the ladder every control is a row of its own overflow menu, none is merely hidden', () => {
    render(<ViewportDisplayControls level={DISPLAY_DEMOTE_ORDER.length} />);
    const group = screen.getByRole('group', { name: 'Viewport display' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName(/^More display controls/);
    fireEvent.click(buttons[0]!);
    // "Take Snapshot" carries its F5 shortcut in its accessible name.
    for (const name of [/^Layout:/, /^Channel:/, /^Resolution:/, 'Preview', 'Overlays', /^Exposure:/, /^Take Snapshot/, 'Compare']) {
      expect(screen.getByRole('menuitem', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('menuitemcheckbox', { name: 'Transparency Grid' })).toBeInTheDocument();
  });

  it('in the transport row the shed controls fold into the BAR\'s one ⋯, not a trigger of their own', () => {
    cramped(() => {
      const b = bar();
      const group = within(b).getByRole('group', { name: 'Viewport display' });
      expect(within(group).queryAllByRole('button')).toHaveLength(0);
      expect(within(b).queryByRole('button', { name: /^More display controls/ })).toBeNull();
      const more = within(b).getByRole('button', { name: /^More transport controls/ });
      // Play and its four neighbours never leave.
      for (const name of ['Go to Start', 'Previous Frame', 'Play', 'Next Frame', 'Go to End']) {
        expect(within(b).getByRole('button', { name })).toBeInTheDocument();
      }
      fireEvent.click(more);
      for (const name of [/^Layout:/, /^Channel:/, /^Resolution:/, 'Preview', 'Overlays', /^Exposure:/, /^Take Snapshot/, 'Compare']) {
        expect(screen.getByRole('menuitem', { name })).toBeInTheDocument();
      }
      // The display rows first, the zoom after them.
      const rows = screen.getAllByRole('menuitem').map((el) => el.textContent ?? '');
      const at = (re: RegExp): number => rows.findIndex((r) => re.test(r));
      expect(at(/^Layout:/)).toBeGreaterThanOrEqual(0);
      expect(at(/^Compare/)).toBeLessThan(at(/^Zoom:/));
    });
  });

  it('at level 0 shows every control and no overflow trigger', () => {
    render(<ViewportDisplayControls level={0} />);
    const group = screen.getByRole('group', { name: 'Viewport display' });
    expect(within(group).queryByRole('button', { name: /^More display controls/ })).toBeNull();
    expect(within(group).getByRole('button', { name: 'Adjust Exposure' })).toBeInTheDocument();
  });
});
