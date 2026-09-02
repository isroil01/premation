/**
 * The smart-guide overlay: what reaches the screen, and what reaches the engine.
 *
 * The measuring itself is pinned in `packages/workspace/src/__tests__/
 * smartGuides.test.ts` — pure functions, exact numbers. What cannot be tested
 * there is the WIRING, which is where viewport chrome fails in this repo: a
 * layer that draws but is never fed, or a preference that flips a boolean
 * nothing reads. So this file asserts the three ends:
 *
 *  • the GATE — nothing drawn when the engine reports no measurement, and
 *    nothing drawn when the user has turned smart guides off;
 *  • the DRAWING — a badge per measured distance, hatch bars for the equal
 *    runs, an outline per equal-size neighbour;
 *  • the KEY and the PREFERENCE — Alt reaches `setMeasureHover`, and the store's
 *    toggle reaches `setSnap`, which is what makes the menu row turn off the
 *    equal-spacing MAGNET and not just its chrome.
 */

import { render, act, fireEvent } from '@testing-library/react';
import type { SmartGuideOverlayData } from '@motion/workspace';
import { SmartGuideOverlay } from './SmartGuideOverlay';
import { useGuidesStore } from '@stores/guidesStore';

let overlayData: SmartGuideOverlayData | null = null;
const setMeasureHover = jest.fn();
const setSnap = jest.fn();
let tick: (() => void) | null = null;

jest.mock('@core/workspace/WorkspaceController', () => ({
  getWorkspaceController: () => ({
    onRender: (cb: () => void) => {
      tick = cb;
      return () => {
        tick = null;
      };
    },
    requestRender: () => undefined,
    ws: {
      overlay: () => ({ smartGuides: overlayData }),
      setMeasureHover: (v: boolean) => setMeasureHover(v),
      setSnap: (p: unknown) => setSnap(p),
    },
  }),
}));

const span = (over: Partial<SmartGuideOverlayData['spans'][number]> = {}): SmartGuideOverlayData['spans'][number] => ({
  axis: 'x',
  from: 100,
  to: 160,
  cross: 200,
  label: '60',
  equal: false,
  ...over,
});

beforeEach(() => {
  overlayData = null;
  tick = null;
  setMeasureHover.mockClear();
  setSnap.mockClear();
  useGuidesStore.getState().setSmartGuides(true);
});

describe('SmartGuideOverlay', () => {
  it('draws nothing when the engine reports no measurement', () => {
    const { container } = render(<SmartGuideOverlay />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('draws a badge carrying the composition-pixel distance', () => {
    overlayData = { spans: [span()], sizeMatches: [], measuring: false };
    const { container } = render(<SmartGuideOverlay />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('data-smart-guides')).toBe('gesture');
    expect(container.querySelectorAll('text')).toHaveLength(1);
    expect(container.querySelector('text')?.textContent).toBe('60');
    // A plain measurement is a dimension LINE with two end ticks — never a bar.
    // (`defs line` is the hatch pattern's own stroke, always present.)
    expect(container.querySelectorAll('g line')).toHaveLength(3);
  });

  it('draws an equal-spacing run as a bar rather than a line', () => {
    overlayData = {
      spans: [span({ equal: true }), span({ equal: true, from: 200, to: 260 })],
      sizeMatches: [],
      measuring: false,
    };
    const { container } = render(<SmartGuideOverlay />);
    // Two hatch bars + two badge pills, and no dimension lines at all (the
    // pattern's own hatch line lives inside <defs>).
    expect(container.querySelectorAll('rect')).toHaveLength(4);
    expect(container.querySelectorAll('defs line')).toHaveLength(1);
    expect(container.querySelectorAll('g line')).toHaveLength(0);
  });

  it('outlines every equal-size neighbour', () => {
    overlayData = {
      spans: [span()],
      sizeMatches: [{ x: 10, y: 20, width: 100, height: 50 }],
      measuring: false,
    };
    const { container } = render(<SmartGuideOverlay />);
    const outline = container.querySelector('rect[width="100"]');
    expect(outline).not.toBeNull();
    expect(outline?.getAttribute('height')).toBe('50');
  });

  it('marks an Alt-hover measurement as such', () => {
    overlayData = { spans: [span()], sizeMatches: [], measuring: true };
    const { container } = render(<SmartGuideOverlay />);
    expect(container.querySelector('svg')?.getAttribute('data-smart-guides')).toBe('measuring');
  });

  it('draws nothing while the preference is off', () => {
    overlayData = { spans: [span()], sizeMatches: [], measuring: false };
    const { container } = render(<SmartGuideOverlay />);
    expect(container.querySelector('svg')).not.toBeNull();
    act(() => {
      useGuidesStore.getState().setSmartGuides(false);
    });
    expect(container.querySelector('svg')).toBeNull();
  });

  it('pushes the preference to the engine, so the magnet goes off with the chrome', () => {
    render(<SmartGuideOverlay />);
    expect(setSnap).toHaveBeenLastCalledWith({ smartGuides: true });
    act(() => {
      useGuidesStore.getState().setSmartGuides(false);
    });
    expect(setSnap).toHaveBeenLastCalledWith({ smartGuides: false });
  });

  it('turns measuring on with Alt and off when it is released', () => {
    render(<SmartGuideOverlay />);
    fireEvent.keyDown(window, { key: 'Alt', altKey: true });
    expect(setMeasureHover).toHaveBeenLastCalledWith(true);
    fireEvent.keyUp(window, { key: 'Alt', altKey: false });
    expect(setMeasureHover).toHaveBeenLastCalledWith(false);
  });

  it('does not measure on Alt while the preference is off', () => {
    act(() => {
      useGuidesStore.getState().setSmartGuides(false);
    });
    render(<SmartGuideOverlay />);
    setMeasureHover.mockClear();
    fireEvent.keyDown(window, { key: 'Alt', altKey: true });
    expect(setMeasureHover).toHaveBeenLastCalledWith(false);
  });

  it('picks up new geometry on a render tick', () => {
    render(<SmartGuideOverlay />);
    overlayData = { spans: [span({ label: '12' })], sizeMatches: [], measuring: false };
    act(() => {
      tick?.();
    });
    expect(document.querySelector('text')?.textContent).toBe('12');
  });

  it('stops measuring when the window loses focus mid-Alt', () => {
    render(<SmartGuideOverlay />);
    fireEvent.keyDown(window, { key: 'Alt', altKey: true });
    setMeasureHover.mockClear();
    fireEvent.blur(window);
    expect(setMeasureHover).toHaveBeenLastCalledWith(false);
  });
});
