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

import { act, render, screen, fireEvent, cleanup } from '@testing-library/react';
import { GraphEditor } from './GraphEditor';
import { defaultAnimation } from '@motion/animation';
import { rowSelectionId } from '@core/engine/__testHelpers__/selectionIds';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { useEaseClipboardStore } from '@stores/easeClipboardStore';
import { easePresetById } from '@core/animation/easePresets';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { getEventBus } from '@core/events/EventBus';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { sec, type Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';

// The tools write through the engine API (B3): a real layer in the app engine
// with three linear Opacity keys (0 → 50 → 100 over 0..2 s), keyed through the
// engine. Opacity is one scalar track, so the canvas has exactly three diamonds.
let NODE = '';
const PROP = 'opacity';
let keyIds: string[] = [];
let h: Harness & { engine: LocalEngine };

class NoopResizeObserver {
  observe(): void { /* no layout in jsdom */ }
  unobserve(): void { /* no layout in jsdom */ }
  disconnect(): void { /* no layout in jsdom */ }
}

beforeAll(() => {
  globalThis.ResizeObserver ??= NoopResizeObserver as unknown as typeof ResizeObserver;
});

beforeEach(async () => {
  h = await setupAppEngine();
  // Providers binds this at boot; without it nothing tells React the engine moved.
  defaultAnimation.setChangeListener((nodeId) => getEventBus().emit('AnimationChanged', { nodeId }));
  useKeyframeSelectionStore.getState().clear();
  useEaseClipboardStore.setState({ easing: 'linear', bezier: undefined, copied: false });
  NODE = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'G', init: [] })).layer;
  keyIds = (await h.run({
    type: 'addKeyframes',
    keys: [0, 1, 2].map((t) => ({
      prop: { layer: NODE, path: 'transform/opacity' }, time: sec(t),
      value: { kind: 'scalar' as const, value: t * 50 }, easing: 'linear' as const, spatialIn: [], spatialOut: [],
    })),
  })).ids;
  getCommandSystem().getHistory().clear();
});

afterEach(async () => {
  cleanup();
  useKeyframeSelectionStore.getState().clear();
  await h.dispose();
});

let view: ReturnType<typeof render>;

/** Let the engine apply the edit a tool sent (it resolves engine key ids first, B3). */
async function settle(): Promise<void> {
  await act(async () => { await engineIdle(); await engineIdle(); });
}

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
  defaultAnimation.getTrackKeyframes(NODE, PROP)!.find((k) => Math.abs(k.t - t) < 1e-6)!;

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

  it('applies to the WHOLE selection, not just the focused keyframe', async () => {
    renderGraph();
    pick(0);
    pick(1, true);
    fireEvent.change(screen.getByLabelText('Easing kind'), { target: { value: 'easeOut' } });
    await settle();
    expect(kfAt(0).easing).toBe('easeOut');
    expect(kfAt(1).easing).toBe('easeOut');
    // Untouched: it was never selected.
    expect(kfAt(2).easing).toBe('linear');
    // Both keys in ONE undo entry, and undo puts both back.
    expect(historyLabels()).toHaveLength(1);
    await act(async () => { await h.run({ type: 'undo' }); });
    expect(kfAt(0).easing).toBe('linear');
    expect(kfAt(1).easing).toBe('linear');
  });

  it('reads back the kind it wrote — the selector never lies about state', async () => {
    renderGraph();
    pick(0);
    fireEvent.change(screen.getByLabelText('Easing kind'), { target: { value: 'hold' } });
    await settle();
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

  it('carries a curve from one keyframe onto every selected one', async () => {
    await h.run({
      type: 'updateKeyframes',
      patches: [{ id: keyIds[0]!, easing: 'bezier', bezier: { x1: 0.9, y1: 0.02, x2: 0.1, y2: 0.98 }, spatialIn: [], spatialOut: [] }],
    });
    getCommandSystem().getHistory().clear();
    renderGraph();
    pick(0);
    fireEvent.click(screen.getByRole('button', { name: 'Copy ease' }));

    pick(1);
    pick(2, true);
    fireEvent.click(screen.getByRole('button', { name: 'Paste ease' }));
    await settle();

    expect(kfAt(1).bezier).toEqual([0.9, 0.02, 0.1, 0.98]);
    expect(kfAt(2).bezier).toEqual([0.9, 0.02, 0.1, 0.98]);
    expect(historyLabels()).toEqual(['Paste keyframe easing']);
  });
});

describe('rove across time', () => {
  it('roves an interior keyframe', async () => {
    renderGraph();
    pick(1);
    const rove = screen.getByRole('button', { name: 'Rove across time' });
    expect(rove).not.toBeDisabled();
    fireEvent.click(rove);
    await settle();
    // 0 → 50 → 100 is already constant speed, so roving leaves it at 1 s.
    expect(kfAt(1).roving).toBe(true);
    expect(historyLabels()).toEqual(['Enable roving keyframe']);
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
  it('opens, applies a named curve to the selection, and closes on Escape', async () => {
    renderGraph();
    pick(0);
    pick(1, true);

    fireEvent.click(screen.getByRole('button', { name: 'Ease library' }));
    expect(screen.getByRole('dialog', { name: 'Ease library' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Expo Out' }));
    await settle();
    expect(kfAt(0).bezier).toEqual(easePresetById('expo-out')!.bezier);
    expect(kfAt(1).bezier).toEqual(easePresetById('expo-out')!.bezier);
    expect(kfAt(0).easing).toBe('bezier');
    expect(historyLabels()).toEqual(['Set keyframe easing: expo-out']);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Ease library' })).toBeNull();
  });

  it('applies through the shared keyframe ids, so the selection is the target', async () => {
    renderGraph();
    pick(2);
    expect([...useKeyframeSelectionStore.getState().ids]).toEqual([
      rowSelectionId(NODE, PROP, 2),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Ease library' }));
    fireEvent.click(screen.getByRole('button', { name: 'Quint In' }));
    await settle();
    expect(kfAt(2).bezier).toEqual(easePresetById('quint-in')!.bezier);
    expect(kfAt(0).bezier).toBeUndefined();
  });
});
