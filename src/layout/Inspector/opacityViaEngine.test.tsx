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
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getEventBus } from '@core/events/EventBus';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { TransformSection } from './TransformSection';
import { InspectorSelectionProvider } from './inspectorSelection';

jest.useFakeTimers();

let h: Harness & { engine: LocalEngine };
let s: Scene;
beforeEach(async () => {
  h = await setupAppEngine();
  defaultAnimation.setChangeListener((nodeId) => getEventBus().emit('AnimationChanged', { nodeId }));
  s = await buildScene(h);
  getCommandSystem().getHistory().clear();
});
afterEach(async () => {
  cleanup();
  await h.dispose();
});

const opacityOf = (id: string): number => {
  for (const c of defaultSceneGraph.getNode(id)!.components) {
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
  await act(async () => { await engineIdle(); });
}

const sets = (): number => historyLabels().filter((l) => l === 'Set Opacity').length;

function renderRow(ids: string[]): void {
  render(
    <InspectorSelectionProvider nodeIds={ids}>
      <TransformSection nodeId={ids[0]!} />
    </InspectorSelectionProvider>,
  );
}

test('a scrub of the Opacity field is ONE engine entry; undo/redo walk it exactly', async () => {
  renderRow([s.A]);
  const start = opacityOf(s.A);
  await scrub([-10, -20, -30, -40, -50]);
  const after = opacityOf(s.A);
  expect(after).toBeLessThan(start);
  expect(sets()).toBe(1);
  // The debounce recorder must not add a second entry for the same drag.
  act(() => { jest.advanceTimersByTime(2000); });
  expect(historyLabels()).toEqual(['Set Opacity']);

  await act(async () => { await h.run({ type: 'undo' }); });
  expect(opacityOf(s.A)).toBeCloseTo(start);
  await act(async () => { await h.run({ type: 'redo' }); });
  expect(opacityOf(s.A)).toBeCloseTo(after);
  // The field follows the engine's writes (legacy refresh).
  expect(Number(field().getAttribute('aria-valuenow'))).toBeCloseTo(after);
});

test('a typed value is one entry', async () => {
  renderRow([s.A]);
  fireEvent.keyDown(field(), { key: 'Enter' });
  const input = screen.getByRole('textbox', { name: 'Opacity' });
  fireEvent.change(input, { target: { value: '25' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await act(async () => { await engineIdle(); });
  expect(opacityOf(s.A)).toBeCloseTo(25); // stored 0..100, like AE
  expect(sets()).toBe(1);
});

test('the stopwatch animates through setAnimated (one entry), and a scrub then keys at the playhead', async () => {
  renderRow([s.A]);
  const stopwatch = screen.getAllByRole('button').find((b) => /animat/i.test(b.getAttribute('aria-label') ?? '') && /opacity/i.test(b.getAttribute('aria-label') ?? ''));
  expect(stopwatch).toBeDefined();
  await act(async () => { fireEvent.click(stopwatch!); await engineIdle(); });
  expect(defaultAnimation.isAnimated(s.A, 'opacity')).toBe(true);
  const keys = defaultAnimation.getTrackKeyframes(s.A, 'opacity')!.length;
  await scrub([-10, -20]);
  expect(defaultAnimation.getTrackKeyframes(s.A, 'opacity')!.length).toBe(keys);
  expect(sets()).toBe(1);
});

test('over a multi-selection a drag moves every layer, as one entry', async () => {
  renderRow([s.A, s.B]);
  const a0 = opacityOf(s.A);
  const b0 = opacityOf(s.B);
  await scrub([-10, -20, -30]);
  expect(opacityOf(s.A)).toBeLessThan(a0);
  expect(opacityOf(s.B)).toBeLessThan(b0);
  expect(sets()).toBe(1);
  await act(async () => { await h.run({ type: 'undo' }); });
  expect(opacityOf(s.A)).toBeCloseTo(a0);
  expect(opacityOf(s.B)).toBeCloseTo(b0);
});
