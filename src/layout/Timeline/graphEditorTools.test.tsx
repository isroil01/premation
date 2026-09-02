/**
 * The graph editor's keyframe tools — the ones that came over from the Motion
 * panel when the two curve editors were merged.
 *
 * These are worth a rendered test rather than a unit one because the bug they
 * replace was never in the maths. The panel's versions applied to the ONE
 * keyframe the panel had focused, while the timeline, F9 and the easing pills
 * applied to the shared keyframe SELECTION — so "select four keyframes, set
 * them to Ease Out" did one of them, silently, and no pure function was wrong.
 * Every assertion below therefore selects MORE THAN ONE keyframe and checks
 * that all of them moved.
 *
 * jsdom has no layout, so the pointer coordinates in these events are zero.
 * That is fine: selecting a diamond does not depend on where the pointer is,
 * only on which element it hit — and nothing here drags.
 */

import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { GraphEditor } from './GraphEditor';
import { defaultAnimation, makeKeyframeId } from '@motion/animation';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { useEaseClipboardStore } from '@stores/easeClipboardStore';
import { easePresetById } from '@core/animation/easePresets';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';

const NODE = 'graph-tools';

class NoopResizeObserver {
  observe(): void { /* no layout in jsdom */ }
  unobserve(): void { /* no layout in jsdom */ }
  disconnect(): void { /* no layout in jsdom */ }
}

beforeAll(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  globalThis.ResizeObserver ??= NoopResizeObserver as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  defaultAnimation.clear();
  useKeyframeSelectionStore.getState().clear();
  useEaseClipboardStore.setState({ easing: 'linear', bezier: undefined, copied: false });
  defaultAnimation.setKeyframe(NODE, 'x', 0, 0, 'linear');
  defaultAnimation.setKeyframe(NODE, 'x', 1, 100, 'linear');
  defaultAnimation.setKeyframe(NODE, 'x', 2, 200, 'linear');
});

afterEach(() => {
  cleanup();
  useKeyframeSelectionStore.getState().clear();
  defaultAnimation.clear();
});

let view: ReturnType<typeof render>;

const renderGraph = (): ReturnType<typeof render> => {
  view = render(
    <GraphEditor
      selectedNodeIds={[NODE]}
      currentTime={0}
      duration={3}
      pixelsPerSecond={60}
      scrollLeft={0}
    />,
  );
  return view;
};

/**
 * The nth keyframe diamond's hit target, in track order.
 *
 * By index rather than by its <title>: testing-library's `getByTitle` only
 * looks at `[title]` attributes and `svg > title` DIRECT children, and these
 * titles hang off the <circle> they describe. In value mode the diamonds' hit
 * circles are the only <circle>s on the canvas until one is selected, and the
 * bezier handles then render after them — so these indices are stable.
 */
const diamond = (index: number): Element => view.container.querySelectorAll('circle')[index]!;

/** Click a diamond (shift to add it to the selection) and end the press. */
function pick(index: number, shiftKey = false): void {
  fireEvent.pointerDown(diamond(index), { button: 0, shiftKey });
  fireEvent.pointerUp(window);
}

const kfAt = (t: number) =>
  defaultAnimation.getTrackKeyframes(NODE, 'x')!.find((k) => Math.abs(k.t - t) < 1e-6)!;

describe('the tools appear only with a keyframe in hand', () => {
  it('shows nothing until one is selected, then the whole set', () => {
    renderGraph();
    expect(screen.queryByLabelText('Easing kind')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ease library' })).toBeNull();

    pick(0);

    expect(screen.getByLabelText('Easing kind')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rove across time' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy ease' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Paste ease' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ease library' })).toBeTruthy();
  });
});

describe('the easing-kind selector', () => {
  it('offers every kind and reports the selected keyframe’s own', () => {
    renderGraph();
    pick(0);
    const select = screen.getByLabelText('Easing kind') as HTMLSelectElement;
    expect(select.options).toHaveLength(10);
    expect(select.value).toBe('linear');
  });

  it('applies to the WHOLE selection, not just the focused keyframe', () => {
    renderGraph();
    pick(0);
    pick(1, true);
    fireEvent.change(screen.getByLabelText('Easing kind'), { target: { value: 'easeOut' } });
    expect(kfAt(0).easing).toBe('easeOut');
    expect(kfAt(1).easing).toBe('easeOut');
    // Untouched: it was never selected.
    expect(kfAt(2).easing).toBe('linear');
  });

  it('reads back the kind it wrote — the selector never lies about state', () => {
    renderGraph();
    pick(0);
    fireEvent.change(screen.getByLabelText('Easing kind'), { target: { value: 'hold' } });
    expect((screen.getByLabelText('Easing kind') as HTMLSelectElement).value).toBe('hold');
  });
});

describe('ease copy / paste', () => {
  it('is disabled until something has been copied', () => {
    renderGraph();
    pick(0);
    expect(screen.getByRole('button', { name: 'Paste ease' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Copy ease' }));
    expect(screen.getByRole('button', { name: 'Paste ease' })).not.toBeDisabled();
  });

  it('carries a curve from one keyframe onto every selected one', () => {
    defaultAnimation.setBezier(NODE, 'x', 0, [0.9, 0.02, 0.1, 0.98]);
    renderGraph();
    pick(0);
    fireEvent.click(screen.getByRole('button', { name: 'Copy ease' }));

    pick(1);
    pick(2, true);
    fireEvent.click(screen.getByRole('button', { name: 'Paste ease' }));

    expect(kfAt(1).bezier).toEqual([0.9, 0.02, 0.1, 0.98]);
    expect(kfAt(2).bezier).toEqual([0.9, 0.02, 0.1, 0.98]);
  });
});

describe('rove across time', () => {
  it('roves an interior keyframe', () => {
    renderGraph();
    pick(1);
    const rove = screen.getByRole('button', { name: 'Rove across time' });
    expect(rove).not.toBeDisabled();
    fireEvent.click(rove);
    expect(kfAt(1).roving).toBe(true);
  });

  it('is disabled on an end keyframe — there is nothing to rove between', () => {
    renderGraph();
    pick(0);
    expect(screen.getByRole('button', { name: 'Rove across time' })).toBeDisabled();
    pick(2);
    expect(screen.getByRole('button', { name: 'Rove across time' })).toBeDisabled();
  });
});

describe('the ease library popover', () => {
  it('opens, applies a named curve to the selection, and closes on Escape', () => {
    renderGraph();
    pick(0);
    pick(1, true);

    fireEvent.click(screen.getByRole('button', { name: 'Ease library' }));
    expect(screen.getByRole('dialog', { name: 'Ease library' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Expo Out' }));
    expect(kfAt(0).bezier).toEqual(easePresetById('expo-out')!.bezier);
    expect(kfAt(1).bezier).toEqual(easePresetById('expo-out')!.bezier);
    expect(kfAt(0).easing).toBe('bezier');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Ease library' })).toBeNull();
  });

  it('applies through the shared keyframe ids, so the selection is the target', () => {
    renderGraph();
    pick(2);
    expect([...useKeyframeSelectionStore.getState().ids]).toEqual([
      makeKeyframeId(NODE, 'x', 2),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Ease library' }));
    fireEvent.click(screen.getByRole('button', { name: 'Quint In' }));
    expect(kfAt(2).bezier).toEqual(easePresetById('quint-in')!.bezier);
    expect(kfAt(0).bezier).toBeUndefined();
  });
});
