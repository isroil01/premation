/**
 * The tool-options row keeps its place when a tool has nothing to show: a row
 * that came and went with the tool moved the viewport, and its auto-fit then
 * re-zoomed the comp: a freshly drawn shape no longer matched its drag.
 */
import { render, act, cleanup } from '@testing-library/react';
import { ToolOptionsBar } from './ToolOptionsBar';
import { useUIStore } from '@stores/uiStore';

afterEach(() => {
  cleanup();
  act(() => useUIStore.getState().setActiveTool('select'));
});

it('the row is there, empty, for a tool without options, and filled for one with', () => {
  act(() => useUIStore.getState().setActiveTool('select'));
  const { container } = render(<ToolOptionsBar />);
  const empty = container.querySelector('[data-tool-options-empty]');
  expect(empty).not.toBeNull();
  expect(empty!.childElementCount).toBe(0);
  act(() => useUIStore.getState().setActiveTool('shape'));
  expect(container.querySelector('[data-tool-options-empty]')).toBeNull();
  const bar = container.querySelector('[role="toolbar"]');
  expect(bar).not.toBeNull();
  // Same element class (so the same fixed height) either way.
  expect(bar!.className).toBe(empty!.className);
});
