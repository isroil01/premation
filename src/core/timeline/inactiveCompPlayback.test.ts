/**
 * Only the composition you are LOOKING at may hold the transport.
 *
 * There is one playback pump (`usePlaybackClock`) and it ticks
 * `controller.tick()`, which resolves through the ACTIVE tab's composition. So
 * switching tabs mid-playback silently re-aimed the pump at the new comp and
 * left the old one asserting `playing` with nothing driving it — and nothing
 * ever cleared it, because `pause()` also resolves through the active comp (so
 * it paused the wrong engine) and `setPlaying` only writes the active tab.
 *
 * The user-visible result was a composition that started playing on its own the
 * moment you switched back to its tab, which is indistinguishable from the
 * editor deciding to play by itself.
 */

import { getTimelineController } from './TimelineController';
import { useWorkspaceStore } from '@stores/projectStore';

describe('pauseInactiveComps', () => {
  it('stops the engine and clears the tab flag for every non-active comp', () => {
    const ws = useWorkspaceStore.getState();
    const firstTabId = ws.activeTabId!;
    const ctrl = getTimelineController();

    // Tab A (the default) starts playing.
    ctrl.play();
    ws.actions.setPlaying(true);
    expect(ctrl.isPlaying).toBe(true);

    // Open a second composition and switch to it — the pump now follows it.
    const secondTabId = useWorkspaceStore.getState().actions.openTab('comp_second');
    useWorkspaceStore.getState().actions.setActiveTab(secondTabId);
    expect(secondTabId).not.toBe(firstTabId);

    // Before the fix this was the bug: comp A's engine and tab flag were both
    // still asserting playback that nothing was driving.
    getTimelineController().pauseInactiveComps();

    const after = useWorkspaceStore.getState();
    expect(after.tabs[firstTabId]?.playing).toBe(false);
    // The active comp is untouched — it was never playing, and stopping it
    // would be a different bug (a tab switch that kills a running preview).
    expect(getTimelineController().isPlaying).toBe(false);

    // Returning to tab A must NOT resume: its engine is genuinely paused now,
    // so the clock has nothing to pick back up.
    useWorkspaceStore.getState().actions.setActiveTab(firstTabId);
    expect(getTimelineController().isPlaying).toBe(false);
    expect(useWorkspaceStore.getState().tabs[firstTabId]?.playing).toBe(false);
  });

  it('leaves the active tab alone', () => {
    const ws = useWorkspaceStore.getState();
    const activeId = ws.activeTabId!;
    const ctrl = getTimelineController();
    ctrl.play();
    ws.actions.setPlaying(true);

    ctrl.pauseInactiveComps();

    expect(ctrl.isPlaying).toBe(true);
    expect(useWorkspaceStore.getState().tabs[activeId]?.playing).toBe(true);
    ctrl.pause();
  });
});
