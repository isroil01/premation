/**
 * The timeline's tool controls (2026-10-07): AE's timeline has no edit-tool
 * row, so the tools are menu rows and only Snap stays a button.
 */

import { render, screen, fireEvent, renderHook, act } from '@testing-library/react';
import { usePreferenceStore } from '@stores/preferenceStore';
import { TimelineSnapButton, useTimelineToolsMenu } from './TimelineTools';
import { TIMELINE_EDIT_MODES, getTimelineEditMode, useTimelineEditModeStore } from './timelineEditMode';

beforeEach(() => {
  useTimelineEditModeStore.getState().reset();
});

it('the Snap button toggles the snap preference and says so', () => {
  const before = usePreferenceStore.getState().timelineSnap;
  render(<TimelineSnapButton />);
  const btn = screen.getByRole('button', { name: 'Snap in timeline' });
  expect(btn).toHaveAttribute('aria-pressed', String(before));
  fireEvent.click(btn);
  expect(usePreferenceStore.getState().timelineSnap).toBe(!before);
});

it('no tool radio row is drawn', () => {
  render(<TimelineSnapButton />);
  expect(screen.queryAllByRole('radio')).toHaveLength(0);
});

it('the menu lists every edit tool, with what it does, under one Timeline tool row', () => {
  const { result } = renderHook(() => useTimelineToolsMenu());
  const tool = result.current.items.find((i) => 'id' in i && i.id === 'tl-tool-edit') as unknown as { submenu: Array<{ id: string; label: string; onChange: () => void }> };
  expect(tool.submenu.map((r) => r.id)).toEqual(TIMELINE_EDIT_MODES.map((d) => `tl-tool-${d.mode}`));
  for (const [i, def] of TIMELINE_EDIT_MODES.entries()) expect(tool.submenu[i]!.label).toContain(def.description);
  act(() => tool.submenu.find((r) => r.id === 'tl-tool-razor')!.onChange());
  expect(getTimelineEditMode()).toBe('razor');
});
