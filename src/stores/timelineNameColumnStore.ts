/**
 * Which name the timeline's name column shows — After Effects' Layer Name /
 * Source Name toggle (click the column head). View state, not the document.
 */

import { create } from 'zustand';

export type TimelineNameColumn = 'layer' | 'source';

interface TimelineNameColumnStore {
  mode: TimelineNameColumn;
  toggle: () => void;
}

export const useTimelineNameColumnStore = create<TimelineNameColumnStore>((set, get) => ({
  mode: 'layer',
  toggle: () => set({ mode: get().mode === 'layer' ? 'source' : 'layer' }),
}));
