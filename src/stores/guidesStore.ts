/**
 * Canvas guides (spec §Canvas — "Guides, rulers, smart snapping, Safe areas").
 * Toggle rulers, a grid, and broadcast/action safe-area overlays. The renderer
 * reads these and draws them over the composition.
 */

import { create } from 'zustand';

interface GuidesStore {
  rulers: boolean;
  grid: boolean;
  /** Grid cells per axis (2..64). 3 = classic rule-of-thirds. */
  gridDivisions: number;
  safeArea: boolean;
  camera3dMode: 'active' | 'front';
  toggleRulers: () => void;
  toggleGrid: () => void;
  setGridDivisions: (n: number) => void;
  toggleSafeArea: () => void;
  toggleCamera3dMode: () => void;
  /** Stable string that changes whenever any guide toggles (render key). */
  key: () => string;
}

export const useGuidesStore = create<GuidesStore>((set, get) => ({
  rulers: false,
  grid: false,
  gridDivisions: 3,
  safeArea: false,
  camera3dMode: 'active',
  toggleRulers: () => set((s) => ({ rulers: !s.rulers })),
  toggleGrid: () => set((s) => ({ grid: !s.grid })),
  setGridDivisions: (n) => set({ gridDivisions: Math.max(2, Math.min(64, Math.round(n))) }),
  toggleSafeArea: () => set((s) => ({ safeArea: !s.safeArea })),
  toggleCamera3dMode: () => set((s) => ({ camera3dMode: s.camera3dMode === 'active' ? 'front' : 'active' })),
  key: () => {
    const s = get();
    return `${s.rulers ? 1 : 0}${s.grid ? 1 : 0}:${s.gridDivisions}:${s.safeArea ? 1 : 0}${s.camera3dMode === 'active' ? 'a' : 'f'}`;
  },
}));
