/**
 * B3 reference migration: the Inspector's Opacity row writes through the
 * engine API (docs/B3_PATTERNS.md). Pinned through the real TransformSection
 * and ValueField:
 *
 *   • a scrub is ONE undo entry ("Set Opacity"), however many moves;
 *   • undo/redo walk it exactly (the engine recorded the inverse);
 *   • a typed value and the stopwatch are one entry each;
 *   • over a multi-selection a drag moves every layer, still one entry;
 *   • the legacy recorder adds nothing on top (no second entry after 700 ms).
 */

import { render, screen, act, cleanup, fireEvent } from '@testing-library/react';
import { defaultAnimation } from '@motion/animation';
import { getEventBus } from '@core/events/EventBus';
import { clearHistory, setupAppEngine, historyLabels, settleEdits } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { TransformSection } from './TransformSection';
import { InspectorSelectionProvider } from './inspectorSelection';

jest.useFakeTimers();

let h: Harness;
let s: Scene;
beforeEach(async () => {
  h = await setupAppEngine();
  defaultAnimation.setChangeListener((nodeId) => getEventBus().emit('AnimationChanged', { nodeId }));
  s = await buildScene(h);
  await clearHistory();
});
afterEach(async () => {
  cleanup();
  await h.dispose();
});

const opacityOf = async (id: string): Promise<number> => {
  for (const c of (await docView()).getNode(id)!.components) {
    const v = (c.props as Record<string, unknown>).opacity;
    if (typeof v === 'number') return v;
  }
  return 1;
};

const field = (): HTMLElement => screen.getByRole('spinbutton', { name: 'Opacity' });

function pointer(type: string, x: number, target: EventTarget = window): void {
  act(() => {
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
      clientX: x, clientY: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true,
    }));
  });
}

async function scrub(xs: number[]): Promise<void> {
  pointer('pointerdown', 0, field());
  for (const x of xs) pointer('pointermove', x);
  pointer('pointerup', xs[xs.length - 1]!);
  await act(async () => { await settleEdits(); });
}

const sets = async (): Promise<number> => (await historyLabels()).filter((l) => l === 'Set Opacity').length;

async function renderRow(ids: string[]): Promise<void> {
  render(
    <InspectorSelectionProvider nodeIds={ids}>
      <TransformSection nodeId={ids[0]!} />
    </InspectorSelectionProvider>,
  );
  // The rows draw once the layers' property trees land.
  await act(async () => {
    await documentMirror().loadTrees(ids);
    await settleEdits();
  });
}

test('a scrub of the Opacity field is ONE engine entry; undo/redo walk it exactly', async () => {
  await renderRow([s.A]);
  const start = (await opacityOf(s.A));
  await scrub([-10, -20, -30, -40, -50]);
  const after = (await opacityOf(s.A));
  expect(after).toBeLessThan(start);
  expect(await sets()).toBe(1);
  // The debounce recorder must not add a second entry for the same drag.
  act(() => { jest.advanceTimersByTime(2000); });
  expect((await historyLabels())).toEqual(['Set Opacity']);

  await act(async () => { await h.run({ type: 'undo' }); });
  expect((await opacityOf(s.A))).toBeCloseTo(start);
  await act(async () => { await h.run({ type: 'redo' }); });
  expect((await opacityOf(s.A))).toBeCloseTo(after);
  // The field follows the engine's writes (legacy refresh).
  expect(Number(field().getAttribute('aria-valuenow'))).toBeCloseTo(after);
});

test('a typed value is one entry', async () => {
  await renderRow([s.A]);
  fireEvent.keyDown(field(), { key: 'Enter' });
  const input = screen.getByRole('textbox', { name: 'Opacity' });
  fireEvent.change(input, { target: { value: '25' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await act(async () => { await engineIdle(); });
  expect((await opacityOf(s.A))).toBeCloseTo(25); // stored 0..100, like AE
  expect(await sets()).toBe(1);
});

test('the stopwatch animates through setAnimated (one entry), and a scrub then keys at the playhead', async () => {
  await renderRow([s.A]);
  const stopwatch = screen.getAllByRole('button').find((b) => /animat/i.test(b.getAttribute('aria-label') ?? '') && /opacity/i.test(b.getAttribute('aria-label') ?? ''));
  expect(stopwatch).toBeDefined();
  await act(async () => { fireEvent.click(stopwatch!); await engineIdle(); });
  expect((await docView()).isAnimated(s.A, 'opacity')).toBe(true);
  const keys = (await docView()).getTrackKeyframes(s.A, 'opacity')!.length;
  await scrub([-10, -20]);
  expect((await docView()).getTrackKeyframes(s.A, 'opacity')!.length).toBe(keys);
  expect(await sets()).toBe(1);
});

test('over a multi-selection a drag moves every layer, as one entry', async () => {
  await renderRow([s.A, s.B]);
  const a0 = (await opacityOf(s.A));
  const b0 = (await opacityOf(s.B));
  await scrub([-10, -20, -30]);
  expect((await opacityOf(s.A))).toBeLessThan(a0);
  expect((await opacityOf(s.B))).toBeLessThan(b0);
  expect(await sets()).toBe(1);
  await act(async () => { await h.run({ type: 'undo' }); });
  expect((await opacityOf(s.A))).toBeCloseTo(a0);
  expect((await opacityOf(s.B))).toBeCloseTo(b0);
});
