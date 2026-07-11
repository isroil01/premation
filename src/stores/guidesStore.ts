/**
 * Canvas guides (spec §Canvas — "Guides, rulers, smart snapping, Safe areas").
 * Toggle rulers, a grid, and broadcast/action safe-area overlays. The renderer
 * reads these and draws them over the composition.
 */

import { create } from 'zustand';

interface GuidesStore {
  rulers: boolean;
  grid: boolean;
  safeArea: boolean;
  toggleRulers: () => void;
  toggleGrid: () => void;
  toggleSafeArea: () => void;
  /** Stable string that changes whenever any guide toggles (render key). */
  key: () => string;
}

export const useGuidesStore = create<GuidesStore>((set, get) => ({
  rulers: false,
  grid: false,
  safeArea: false,
  toggleRulers: () => set((s) => ({ rulers: !s.rulers })),
  toggleGrid: () => set((s) => ({ grid: !s.grid })),
  toggleSafeArea: () => set((s) => ({ safeArea: !s.safeArea })),
  key: () => {
    const s = get();
    return `${s.rulers ? 1 : 0}${s.grid ? 1 : 0}${s.safeArea ? 1 : 0}`;
  },
}));
