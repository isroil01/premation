/**
 * Preview render quality — two orthogonal levers, both trading fidelity for
 * playback speed:
 *
 *  - `draft`      skips the expensive motion-blur multi-sample pass.
 *  - `resolution` renders fewer pixels (Full/Half/Third/Quarter), the way
 *                 After Effects' viewer resolution does — the content canvas is
 *                 sized down by this divisor and the browser upscales it. This
 *                 is the lever users reach for when preview drops frames; it was
 *                 the one thing missing, so `draft` (motion blur only) was the
 *                 whole quality story.
 */

import { create } from 'zustand';

/** 1 = Full, 2 = Half, 3 = Third, 4 = Quarter. */
export type PreviewResolution = 1 | 2 | 3 | 4;

export const RESOLUTION_LABELS: Record<PreviewResolution, string> = {
  1: 'Full',
  2: 'Half',
  3: 'Third',
  4: 'Quarter',
};

/** The pixel fraction each resolution renders — shown next to the label so it's
 *  clear this is a quality/speed lever, not a size change. */
export const RESOLUTION_PERCENT: Record<PreviewResolution, string> = {
  1: '100%',
  2: '50%',
  3: '33%',
  4: '25%',
};

interface RenderQualityStore {
  draft: boolean;
  resolution: PreviewResolution;
  setDraft: (v: boolean) => void;
  toggle: () => void;
  setResolution: (r: PreviewResolution) => void;
  /** Stable string that changes when quality changes (render key). */
  key: () => string;
}

export const useRenderQualityStore = create<RenderQualityStore>((set, get) => ({
  draft: false,
  resolution: 1,
  setDraft: (v) => set({ draft: v }),
  toggle: () => set((s) => ({ draft: !s.draft })),
  setResolution: (r) => set({ resolution: r }),
  key: () => `${get().draft ? 'd' : 'f'}${get().resolution}`,
}));
