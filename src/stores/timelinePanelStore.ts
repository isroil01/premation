/**
 * What the timeline panel shows: a composition's timeline, or the Render
 * Queue. As in After Effects the queue is a tab of the timeline panel, beside
 * the composition tabs — not a panel of the side docks.
 *
 * Editor state (CLAUDE.md): never in the project document, and not persisted —
 * a session opens on the timeline.
 */

import { create } from 'zustand';
import { useLayoutStore } from './layoutStore';

export type TimelinePanelView = 'timeline' | 'renderQueue';

interface TimelinePanelStore {
  view: TimelinePanelView;
  setView: (view: TimelinePanelView) => void;
}

export const useTimelinePanelStore = create<TimelinePanelStore>((set) => ({
  view: 'timeline',
  setView: (view) => set({ view }),
}));

/** Bring the Render Queue up in the timeline panel (opening the panel if it is closed). */
export function showRenderQueue(): void {
  const layout = useLayoutStore.getState();
  const region = layout.regions.bottomTimeline;
  if (region.collapsed) layout.toggleRegion('bottomTimeline');
  useTimelinePanelStore.getState().setView('renderQueue');
}

/** Window ▸ Render Queue (F6): show it, or go back to the timeline when it is already up. */
export function toggleRenderQueue(): void {
  const collapsed = useLayoutStore.getState().regions.bottomTimeline.collapsed;
  if (!collapsed && useTimelinePanelStore.getState().view === 'renderQueue') {
    useTimelinePanelStore.getState().setView('timeline');
    return;
  }
  showRenderQueue();
}
