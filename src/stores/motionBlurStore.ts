/**
 * Composition-level motion-blur settings. Enables motion blur for the
 * comp and sets the shutter angle + sample count; individual layers still opt in
 * via their own toggle. The render hooks read this and pass it to buildSnapshot.
 */

import { create } from 'zustand';
import { getEventBus } from '@core/events/EventBus';

/** Persisted + render-affecting: every setter must tell autosave. */
function touched(): void {
  try {
    getEventBus().emit('DocumentChanged', { source: 'render' });
  } catch {
    /* no bus in headless tests */
  }
}

/** The persisted half of the store — render-affecting, so it must round-trip. */
export interface MotionBlurSettings {
  enabled: boolean;
  shutterAngle: number;
  shutterPhase: number;
  samples: number;
  adaptiveSampleLimit: number;
}

interface MotionBlurStore extends MotionBlurSettings {
  setEnabled: (v: boolean) => void;
  setShutterAngle: (v: number) => void;
  setShutterPhase: (v: number) => void;
  setSamples: (v: number) => void;
  setAdaptiveSampleLimit: (v: number) => void;
  /** Plain settings for the project file. */
  settings: () => MotionBlurSettings;
  /** Load settings from a project file, re-clamping through the setters. */
  restore: (s: Partial<MotionBlurSettings>) => void;
  /** Stable string that changes whenever any setting changes (render key). */
  key: () => string;
}

/**
 * Render-affecting defaults, named so a NEW project can get back to them:
 * `restore` only applies the keys a document carries, so a blank document used
 * to leave the previous project's shutter settings in place — and these change
 * what an export looks like.
 */
export const DEFAULT_MOTION_BLUR_SETTINGS: MotionBlurSettings = {
  enabled: true,
  shutterAngle: 180,
  shutterPhase: -90,
  samples: 8,
  adaptiveSampleLimit: 128,
};

export const useMotionBlurStore = create<MotionBlurStore>((set, get) => ({
  ...DEFAULT_MOTION_BLUR_SETTINGS,
  setEnabled: (v) => { set({ enabled: v }); touched(); },
  setShutterAngle: (v) => { set({ shutterAngle: Math.max(0, Math.min(360, v)) }); touched(); },
  setShutterPhase: (v) => { set({ shutterPhase: Math.max(-360, Math.min(360, v)) }); touched(); },
  setSamples: (v) => { set({ samples: Math.max(2, Math.min(32, Math.round(v))) }); touched(); },
  setAdaptiveSampleLimit: (v) => { set({ adaptiveSampleLimit: Math.max(2, Math.min(128, Math.round(v))) }); touched(); },
  settings: () => {
    const { enabled, shutterAngle, shutterPhase, samples, adaptiveSampleLimit } = get();
    return { enabled, shutterAngle, shutterPhase, samples, adaptiveSampleLimit };
  },
  restore: (s) => {
    const g = get();
    if (typeof s.enabled === 'boolean') g.setEnabled(s.enabled);
    if (typeof s.shutterAngle === 'number') g.setShutterAngle(s.shutterAngle);
    if (typeof s.shutterPhase === 'number') g.setShutterPhase(s.shutterPhase);
    if (typeof s.samples === 'number') g.setSamples(s.samples);
    if (typeof s.adaptiveSampleLimit === 'number') g.setAdaptiveSampleLimit(s.adaptiveSampleLimit);
  },
  key: () => {
    const s = get();
    return `${s.enabled ? 1 : 0}:${s.shutterAngle}:${s.shutterPhase}:${s.samples}:${s.adaptiveSampleLimit}`;
  },
}));
