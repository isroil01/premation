/**
 * Where the timeline's footer controls draw: two elements inside the editor's
 * status bar, published here so the timeline panel can portal into them without
 * either knowing about the other's tree. Both null where no status bar is
 * mounted (a popped-out timeline), and the footer then draws in place.
 *
 * The timeline also publishes its two sideways scrollers here, for the
 * scrollbars the footer draws.
 */

import { create } from 'zustand';

interface TimelineStatusSlotState {
  left: HTMLElement | null;
  right: HTMLElement | null;
  setLeft: (el: HTMLElement | null) => void;
  setRight: (el: HTMLElement | null) => void;
  headerScroller: HTMLElement | null;
  lanesScroller: HTMLElement | null;
  setScrollers: (headerScroller: HTMLElement | null, lanesScroller: HTMLElement | null) => void;
}

export const useTimelineStatusSlotStore = create<TimelineStatusSlotState>((set) => ({
  left: null,
  right: null,
  setLeft: (left) => set({ left }),
  setRight: (right) => set({ right }),
  headerScroller: null,
  lanesScroller: null,
  setScrollers: (headerScroller, lanesScroller) => set({ headerScroller, lanesScroller }),
}));
