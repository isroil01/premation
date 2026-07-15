/**
 * Composition-level motion-blur settings (Prompt 6). Enables motion blur for the
 * comp and sets the shutter angle + sample count; individual layers still opt in
 * via their own toggle. The render hooks read this and pass it to buildSnapshot.
 */

import { create } from 'zustand';

interface MotionBlurStore {
  enabled: boolean;
  shutterAngle: number;
  shutterPhase: number;
  samples: number;
  adaptiveSampleLimit: number;
  setEnabled: (v: boolean) => void;
  setShutterAngle: (v: number) => void;
  setShutterPhase: (v: number) => void;
  setSamples: (v: number) => void;
  setAdaptiveSampleLimit: (v: number) => void;
  /** Stable string that changes whenever any setting changes (render key). */
  key: () => string;
}

export const useMotionBlurStore = create<MotionBlurStore>((set, get) => ({
  enabled: true,
  shutterAngle: 180,
  shutterPhase: -90,
  samples: 8,
  adaptiveSampleLimit: 128,
  setEnabled: (v) => set({ enabled: v }),
  setShutterAngle: (v) => set({ shutterAngle: Math.max(0, Math.min(360, v)) }),
  setShutterPhase: (v) => set({ shutterPhase: Math.max(-360, Math.min(360, v)) }),
  setSamples: (v) => set({ samples: Math.max(2, Math.min(32, Math.round(v))) }),
  setAdaptiveSampleLimit: (v) => set({ adaptiveSampleLimit: Math.max(2, Math.min(128, Math.round(v))) }),
  key: () => {
    const s = get();
    return `${s.enabled ? 1 : 0}:${s.shutterAngle}:${s.shutterPhase}:${s.samples}:${s.adaptiveSampleLimit}`;
  },
}));
