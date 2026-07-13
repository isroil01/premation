/**
 * Preview render quality. "Draft" trades fidelity for speed during scrubbing /
 * playback — currently it disables the expensive motion-blur multi-sample pass.
 * The render hooks read this and skip work accordingly.
 */

import { create } from 'zustand';

interface RenderQualityStore {
  draft: boolean;
  setDraft: (v: boolean) => void;
  toggle: () => void;
  /** Stable string that changes when quality changes (render key). */
  key: () => string;
}

export const useRenderQualityStore = create<RenderQualityStore>((set, get) => ({
  draft: false,
  setDraft: (v) => set({ draft: v }),
  toggle: () => set((s) => ({ draft: !s.draft })),
  key: () => (get().draft ? 'd' : 'f'),
}));
