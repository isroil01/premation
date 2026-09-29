/**
 * The Composition tab carries the unsaved-changes dot.
 *
 * Read off the SAME flag the discard prompt and ProjectStatus use
 * (`projectStore.tabs[active].dirty`), so a save that wrote nothing cannot
 * leave the tab clean while the title bar says otherwise.
 */

import { act, render, screen } from '@testing-library/react';
import { EditorTabs } from './EditorTabs';
import { useProjectStore } from '@stores/projectStore';

beforeEach(() => {
  localStorage.clear();
});

function activeTabId(): string {
  const st = useProjectStore.getState();
  if (st.activeTabId) return st.activeTabId;
  const first = Object.keys(st.tabs)[0];
  if (!first) throw new Error('project store has no tab to mark dirty');
  act(() => { useProjectStore.setState({ activeTabId: first }); });
  return first;
}

describe('Composition tab dirty dot', () => {
  it('appears when the active tab has unsaved edits and clears on save', () => {
    render(<EditorTabs scene={<canvas />} />);
    const id = activeTabId();
    act(() => { useProjectStore.getState().actions.markDirty(id, false); });
    expect(screen.queryByTestId('comp-dirty-dot')).toBeNull();
    expect(screen.getByRole('tab', { name: /^Composition/ }).title).not.toContain('unsaved');

    act(() => { useProjectStore.getState().actions.markDirty(id, true); });
    const dot = screen.getByTestId('comp-dirty-dot');
    expect(dot.getAttribute('aria-label')).toBe('Unsaved changes');
    expect(screen.getByRole('tab', { name: /^Composition/ }).title).toContain('unsaved changes');

    act(() => { useProjectStore.getState().actions.markDirty(id, false); });
    expect(screen.queryByTestId('comp-dirty-dot')).toBeNull();
  });
});
