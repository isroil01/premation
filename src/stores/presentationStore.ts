/**
 * Presentation mode (spec §Collaboration V1) — a distraction-free, full-bleed
 * playback of the composition for client review. Enter from Preview; Esc exits.
 */

import { create } from 'zustand';

interface PresentationStore {
  active: boolean;
  enter: () => void;
  exit: () => void;
}

export const usePresentationStore = create<PresentationStore>((set) => ({
  active: false,
  enter: () => set({ active: true }),
  exit: () => set({ active: false }),
}));
