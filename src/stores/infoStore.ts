/**
 * Info readout (AE's Info panel) — the pixel colour + composition coordinate
 * under the pointer, sampled live from the content canvas as the cursor moves
 * over the viewport. The workspace pointer handler writes it; the StatusBar
 * reads it. `present` is false when the cursor is off the canvas (show " —").
 */

import { create } from 'zustand';

export interface InfoReadout {
  /** Composition-space cursor position (px), rounded. */
  x: number;
  y: number;
  /** Sampled pixel RGBA (0–255), or null when unreadable (e.g. GPU backend). */
  rgba: { r: number; g: number; b: number; a: number } | null;
  /** True while the cursor is over the viewport. */
  present: boolean;
}

interface InfoStore extends InfoReadout {
  set: (patch: Partial<InfoReadout>) => void;
  clear: () => void;
}

export const useInfoStore = create<InfoStore>((set) => ({
  x: 0,
  y: 0,
  rgba: null,
  present: false,
  set: (patch) => set(patch),
  clear: () => set({ present: false, rgba: null }),
}));
