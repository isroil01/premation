/**
 * Strokes 2+ are full citizens in the Stroke panel.
 *
 * Before 2026-09-15 a second stroke got a width field and a colour swatch —
 * while the model carried cap, join, dashes, taper, wave and a gradient for it
 * that no control could reach, and its width could not be keyframed at all.
 *
 * The observable is the rendered controls, read back through `aria-label`, and
 * the stored stack / engine tracks they write. Two strokes with different
 * values, so a write landing on the wrong index is visible.
 */

import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { AppearanceSection } from './AppearanceSection';
import { useSelectionStore } from '@stores/selectionStore';
import { getNodeStrokes, defaultStroke } from '@core/paint/stroke';
import { defaultAnimation } from '@motion/animation';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { strokesCommands } from './appearance/paintEdits';

jest.useFakeTimers();

let h: Harness & { engine: LocalEngine };
let ID: string;

beforeEach(async () => {
  h = await setupAppEngine();
  ({ layer: ID } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name: 'stroke_stack_rows', init: [] }));
  // Two strokes with different values, seeded through the engine as the panel writes them.
  await h.batch('seed', strokesCommands(ID, [
    { ...defaultStroke('#ff0000'), width: 8 },
    { ...defaultStroke('#00ff00'), width: 3 },
  ]));
  getCommandSystem().getHistory().clear();
  useSelectionStore.setState({ ids: [ID] } as never);
});
afterEach(async () => {
  cleanup();
  await h.dispose();
});

const idle = async (): Promise<void> => { await act(async () => { await engineIdle(); }); };
/** No second entry from the 700 ms recorder on top of the engine's. */
const settle = (): void => { act(() => { jest.advanceTimersByTime(2000); }); };
const undo = async (): Promise<void> => { await act(async () => { await h.run({ type: 'undo' }); }); };

const labels = (c: HTMLElement): string[] =>
  [...c.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label') ?? '');

describe('stroke 2 offers the whole AE Stroke group', () => {
  it('composite, blend, align, cap, join, dashes and paint — the controls it never had', () => {
    const { container } = render(<AppearanceSection nodeId={ID} />);
    const found = labels(container);
    for (const want of [
      'Stroke 2 composite', 'Stroke 2 blend mode', 'Stroke 2 align', 'Stroke 2 cap', 'Stroke 2 join',
      'Add dash or gap to stroke 2', 'Stroke 2 paint type', 'Remove stroke 2',
    ]) {
      expect({ want, found: found.includes(want) }).toEqual({ want, found: true });
    }
  });

  it('its blend mode writes stroke 2 and leaves stroke 1 alone — one undo entry', async () => {
    const { container } = render(<AppearanceSection nodeId={ID} />);
    const before = h.doc();
    const select = container.querySelector('[aria-label="Stroke 2 blend mode"]') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'screen' } });
    await idle();
    expect(getNodeStrokes(ID).map((s) => s.blendMode)).toEqual([undefined, 'screen']);
    settle();
    expect(historyLabels()).toHaveLength(1);
    await undo();
    expect(h.doc()).toBe(before);
  });

  it('"+" adds a Dash, then a Gap; "−" removes the last — one undo entry per click', async () => {
    const { container, rerender } = render(<AppearanceSection nodeId={ID} />);
    const click = async (label: string): Promise<void> => {
      fireEvent.click(container.querySelector(`[aria-label="${label}"]`) as HTMLElement);
      await idle();
      rerender(<AppearanceSection nodeId={ID} />);
    };
    await click('Add dash or gap to stroke 2');
    expect(getNodeStrokes(ID)[1]!.dash).toEqual([10]);
    await click('Add dash or gap to stroke 2');
    expect(getNodeStrokes(ID)[1]!.dash).toEqual([10, 10]);
    await click('Remove last dash or gap from stroke 2');
    expect(getNodeStrokes(ID)[1]!.dash).toEqual([10]);
    // Stroke 1's pattern never moved.
    expect(getNodeStrokes(ID)[0]!.dash).toEqual([]);
    settle();
    expect(historyLabels()).toHaveLength(3);
    await undo();
    expect(getNodeStrokes(ID)[1]!.dash).toEqual([10, 10]);
  });

  it('its Width stopwatch keys stroke 2’s own track, not the primary’s — one undo entry', async () => {
    const { container } = render(<AppearanceSection nodeId={ID} />);
    const toggles = [...container.querySelectorAll('[aria-label="Enable Width animation"]')] as HTMLElement[];
    expect(toggles.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(toggles[1]!);
    await idle();
    expect(defaultAnimation.isAnimated(ID, 'stroke.1.width')).toBe(true);
    expect(defaultAnimation.isAnimated(ID, 'strokeWidth')).toBe(false);
    settle();
    expect(historyLabels()).toHaveLength(1);
    await undo();
    expect(defaultAnimation.isAnimated(ID, 'stroke.1.width')).toBe(false);
  });

  it('Remove stroke 2 removes it — one undo entry; undo restores it', async () => {
    const { container } = render(<AppearanceSection nodeId={ID} />);
    const before = h.doc();
    fireEvent.click(container.querySelector('[aria-label="Remove stroke 2"]') as HTMLElement);
    await idle();
    expect(getNodeStrokes(ID)).toHaveLength(1);
    settle();
    expect(historyLabels()).toEqual(['Remove Stroke 2']);
    await undo();
    expect(getNodeStrokes(ID)).toHaveLength(2);
    expect(h.doc()).toBe(before);
  });
});
