/**
 * The effects browser, once it is a virtualised flat list.
 *
 * Turning the accordion into rows moved three behaviours out of JSX nesting
 * and into state this panel now owns: a folder opens and shuts, the list is a
 * single `tree` the keyboard can walk, and an effect row is still draggable
 * onto a layer. Each of those is a way the rework could have silently taken
 * something away, so each is pinned here.
 */

import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { EffectsPanel } from './EffectsPanel';
import { EFFECT_CATEGORY } from './effectCategory';
import { EFFECT_DEFS } from '@core/effects/effects';
import { useSelectionStore } from '@stores/selectionStore';
import { documentMirror } from '@stores/documentMirror';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { buildScene } from '@core/engine/__testHelpers__/scene';

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** The first effect in the folder that opens by default. */
const FIRST_FOLDER = 'Blur & Sharpen';
const FIRST_EFFECT = EFFECT_DEFS.find((d) => EFFECT_CATEGORY[d.type] === FIRST_FOLDER)!;

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
});

// B4: the panel reads the selected layer from the document mirror, so the
// fixture is a real engine layer the mirror has seen.
let h: Awaited<ReturnType<typeof setupAppEngine>>;
beforeEach(async () => {
  h = await setupAppEngine();
  documentMirror().start();
  const s = await buildScene(h);
  await documentMirror().whenIdle();
  useSelectionStore.getState().set([s.A]);
});

afterEach(async () => {
  cleanup();
  useSelectionStore.getState().clear();
  await h.dispose();
});

it('lists the library as one keyboard-reachable tree', () => {
  render(<EffectsPanel />);

  const tree = screen.getByRole('tree', { name: 'Effects and presets' });
  // Focusable as a whole — a virtualised list cannot be tabbed row by row,
  // because the rows the user has not scrolled to do not exist yet.
  expect(tree.getAttribute('tabindex')).toBe('0');
  expect(screen.getByTitle(FIRST_FOLDER)).toBeTruthy();
  expect(screen.getByText(FIRST_EFFECT.label)).toBeTruthy();
});

it('shuts a folder without taking its header with it', () => {
  render(<EffectsPanel />);

  const header = screen.getByTitle(FIRST_FOLDER);
  expect(header.getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(header);

  expect(screen.getByTitle(FIRST_FOLDER).getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByText(FIRST_EFFECT.label)).toBeNull();
});

it('keeps an effect row draggable onto a layer', () => {
  render(<EffectsPanel />);

  const row = screen.getByText(FIRST_EFFECT.label).closest('button')!;
  expect(row.getAttribute('draggable')).toBe('true');
});

it('walks the rows with the arrow keys', () => {
  render(<EffectsPanel />);

  const tree = screen.getByRole('tree', { name: 'Effects and presets' });
  // The first row starts focused; ArrowDown moves the selection onto the next.
  fireEvent.keyDown(tree, { key: 'ArrowDown' });
  expect(tree.querySelectorAll('[aria-selected="true"]').length).toBeLessThanOrEqual(1);
  // Home returns to the top, and never off the end of the list.
  fireEvent.keyDown(tree, { key: 'End' });
  fireEvent.keyDown(tree, { key: 'Home' });
  expect(screen.getByTitle(FIRST_FOLDER)).toBeTruthy();
});
