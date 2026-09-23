/**
 * useGesture: every way a drag stops closes the gesture exactly once — pointer
 * up, lost capture, pointercancel, window blur, Escape (reverts), unmount.
 * An open gesture refuses undo, so a leaked one would break Ctrl+Z.
 */

import { act, renderHook } from '@testing-library/react';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import type { Command } from '@motion/engine-api';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { useGesture } from './useGesture';

jest.useFakeTimers();

let h: Harness & { engine: LocalEngine };
let s: Scene;
beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
});
afterEach(async () => { await h.dispose(); });

const setOpacity = (v: number): Command => ({
  type: 'setProperty', prop: { layer: s.A, path: 'transform/opacity' }, value: { kind: 'scalar', value: v }, time: 0,
});
const opacity = (): number => {
  for (const c of defaultSceneGraph.getNode(s.A)!.components) {
    const v = (c.props as Record<string, unknown>).opacity;
    if (typeof v === 'number') return v;
  }
  return 1;
};

/** A capture-capable element (jsdom has no pointer capture). */
function target(): HTMLElement & { captured: Set<number> } {
  const el = document.createElement('div') as unknown as HTMLElement & { captured: Set<number> };
  el.captured = new Set();
  el.setPointerCapture = (id: number) => { el.captured.add(id); };
  el.releasePointerCapture = (id: number) => { el.captured.delete(id); };
  el.hasPointerCapture = (id: number) => el.captured.has(id);
  document.body.appendChild(el);
  return el;
}

function pointerEvent(type: string, pointerId: number): Event {
  const e = new Event(type, { bubbles: true });
  Object.defineProperty(e, 'pointerId', { value: pointerId });
  return e;
}

async function drag(g: ReturnType<typeof useGesture>, el?: HTMLElement, vals: number[] = [0.8, 0.6, 0.4]): Promise<void> {
  act(() => {
    g.begin('Set Opacity', el ? { pointerId: 7, currentTarget: el } : undefined);
    for (const v of vals) g.send(setOpacity(v));
  });
  await act(async () => { await engineIdle(); });
}

const entries = (): number => historyLabels().filter((l) => l === 'Set Opacity').length;

test('begin / send / end → one undo entry; the pointer is captured and released', async () => {
  const el = target();
  const { result } = renderHook(() => useGesture());
  await drag(result.current, el);
  expect(el.captured.has(7)).toBe(true);
  expect(result.current.isActive()).toBe(true);
  await act(async () => { await result.current.end(); });
  expect(el.captured.has(7)).toBe(false);
  expect(opacity()).toBeCloseTo(0.4);
  expect(entries()).toBe(1);
  expect(h.engine.isGestureOpen).toBe(false);
});

test('lost pointer capture ends (commits) the drag', async () => {
  const el = target();
  const { result } = renderHook(() => useGesture());
  await drag(result.current, el);
  await act(async () => { el.dispatchEvent(pointerEvent('lostpointercapture', 7)); await engineIdle(); });
  expect(result.current.isActive()).toBe(false);
  expect(h.engine.isGestureOpen).toBe(false);
  expect(entries()).toBe(1);
  expect(opacity()).toBeCloseTo(0.4);
});

test('capture loss of ANOTHER pointer is ignored', async () => {
  const el = target();
  const { result } = renderHook(() => useGesture());
  await drag(result.current, el);
  act(() => { el.dispatchEvent(pointerEvent('lostpointercapture', 99)); });
  expect(result.current.isActive()).toBe(true);
  await act(async () => { await result.current.end(); });
});

test('pointercancel ends (commits) the drag', async () => {
  const el = target();
  const { result } = renderHook(() => useGesture());
  await drag(result.current, el);
  await act(async () => { el.dispatchEvent(pointerEvent('pointercancel', 7)); await engineIdle(); });
  expect(h.engine.isGestureOpen).toBe(false);
  expect(entries()).toBe(1);
});

test('Escape cancels: the document returns exactly, nothing is recorded', async () => {
  const doc = h.doc();
  const { result } = renderHook(() => useGesture());
  await drag(result.current);
  expect(opacity()).toBeCloseTo(0.4);
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await engineIdle(); });
  expect(h.engine.isGestureOpen).toBe(false);
  expect(h.doc()).toBe(doc);
  expect(entries()).toBe(0);
});

test('window blur ends (commits) the drag', async () => {
  const { result } = renderHook(() => useGesture());
  await drag(result.current);
  await act(async () => { window.dispatchEvent(new Event('blur')); await engineIdle(); });
  expect(h.engine.isGestureOpen).toBe(false);
  expect(entries()).toBe(1);
});

test('unmount mid-drag commits', async () => {
  const { result, unmount } = renderHook(() => useGesture());
  await drag(result.current);
  unmount();
  await act(async () => { await engineIdle(); });
  expect(h.engine.isGestureOpen).toBe(false);
  expect(entries()).toBe(1);
});

test('begin while one is open ends the previous one first (two entries, no leak)', async () => {
  const { result } = renderHook(() => useGesture());
  await drag(result.current);
  await drag(result.current, undefined, [0.3, 0.2]);
  await act(async () => { await result.current.end(); });
  expect(h.engine.isGestureOpen).toBe(false);
  expect(entries()).toBe(2);
});

test('send without begin does nothing; end without begin is harmless', async () => {
  const { result } = renderHook(() => useGesture());
  const doc = h.doc();
  act(() => { result.current.send(setOpacity(0.1)); });
  await act(async () => { await result.current.end(); await engineIdle(); });
  expect(h.doc()).toBe(doc);
});
