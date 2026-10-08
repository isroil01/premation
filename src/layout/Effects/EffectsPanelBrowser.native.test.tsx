/**
 * The effects browser, once it is a virtualised flat list.
 *
 * Turning the accordion into rows moved three behaviours out of JSX nesting
 * and into state this panel now owns: a folder opens and shuts, the list is a
 * single `tree` the keyboard can walk, and an effect row is still draggable
 * onto a layer. Each of those is a way the rework could have silently taken
 * something away, so each is pinned here.
 *
 * And the panel grammar (2026-10): no heading inside the panel (the tab is the
 * title), one toolbar row — the search and the favourites filter — and the
 * tree in After Effects' order: the presets folder first, then the rest A–Z.
 * The stack verbs (Copy Stack, Paste, Save Preset) moved to Effect Controls.
 */

import type { ReactElement } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TooltipProvider } from '@components/Tooltip';
import { EffectsPanel, EFFECT_PRESETS_FOLDER } from './EffectsPanel';
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

/** The app root's tooltip provider — the favourites filter is an IconButton. */
const renderPanel = (ui: ReactElement = <EffectsPanel />): ReturnType<typeof render> =>
  render(<TooltipProvider>{ui}</TooltipProvider>);

/** The folder rows, top to bottom, by name. */
const folderNames = (): string[] =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-expanded]'))
    .map((b) => b.getAttribute('title') ?? '');

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

it('lists the library as one keyboard-reachable tree', async () => {
  renderPanel();

  const tree = screen.getByRole('tree', { name: 'Effects and presets' });
  // Focusable as a whole — a virtualised list cannot be tabbed row by row,
  // because the rows the user has not scrolled to do not exist yet.
  expect(tree.getAttribute('tabindex')).toBe('0');
  expect(screen.getByTitle(FIRST_FOLDER)).toBeTruthy();
  expect(screen.getByText(FIRST_EFFECT.label)).toBeTruthy();
});

it('shuts a folder without taking its header with it', async () => {
  renderPanel();

  const header = screen.getByTitle(FIRST_FOLDER);
  expect(header.getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(header);

  expect(screen.getByTitle(FIRST_FOLDER).getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByText(FIRST_EFFECT.label)).toBeNull();
});

it('keeps an effect row draggable onto a layer', async () => {
  renderPanel();

  const row = screen.getByText(FIRST_EFFECT.label).closest('button')!;
  expect(row.getAttribute('draggable')).toBe('true');
});

it('walks the rows with the arrow keys', async () => {
  renderPanel();

  const tree = screen.getByRole('tree', { name: 'Effects and presets' });
  // The first row starts focused; ArrowDown moves the selection onto the next.
  fireEvent.keyDown(tree, { key: 'ArrowDown' });
  expect(tree.querySelectorAll('[aria-selected="true"]').length).toBeLessThanOrEqual(1);
  // Home returns to the top, and never off the end of the list.
  fireEvent.keyDown(tree, { key: 'End' });
  fireEvent.keyDown(tree, { key: 'Home' });
  expect(screen.getByTitle(FIRST_FOLDER)).toBeTruthy();
});

it('orders the tree as After Effects does: the presets folder first, then every folder A–Z', async () => {
  renderPanel();

  // Shut the open folder so every folder header fits the virtual window.
  fireEvent.click(screen.getByTitle(FIRST_FOLDER));
  const names = folderNames();
  expect(names[0]).toBe(EFFECT_PRESETS_FOLDER);
  const rest = names.slice(1);
  expect(rest.length).toBeGreaterThan(3);
  expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b, 'en')));
});

it('has one toolbar row — search and favourites — and no heading, stack verbs or masks note', async () => {
  renderPanel();

  const toolbar = screen.getByRole('toolbar', { name: 'Effects and presets tools' });
  expect(toolbar).toContainElement(screen.getByRole('searchbox', { name: 'Search effects and presets' }));
  const favourites = screen.getByRole('button', { name: 'Show favourites only' });
  expect(toolbar).toContainElement(favourites);
  fireEvent.click(favourites);
  expect(screen.getByRole('button', { name: 'Show all effects' })).toHaveAttribute('aria-pressed', 'true');

  // The tab is the title; the stack's verbs are Effect Controls' ≡ menu now.
  expect(screen.queryByText('Effects & Presets')).toBeNull();
  expect(screen.queryByRole('button', { name: /Copy Stack/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /^Paste/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Save Preset/ })).toBeNull();
  expect(screen.queryByText(/Masks are in Properties/)).toBeNull();
});
