/**
 * Project-level colour-management settings (working space, display transform,
 * intermediate bit depth). Render-affecting — must round-trip in the document.
 */

import { create } from 'zustand';
import { getEventBus } from '@core/events/EventBus';

/** Persisted + render-affecting: every setter must tell autosave AND the viewport. */
function touched(): void {
  try {
    getEventBus().emit('DocumentChanged', { source: 'render' });
    // Viewport listens to AnimationChanged, not DocumentChanged — without this,
    // flipping Display Transform / working space left the preview on the old ODT
    // until the next scrub or keyframe edit.
    getEventBus().emit('AnimationChanged', { nodeId: '__color__' });
  } catch {
    /* no bus in headless tests */
  }
}

export type WorkingSpace = 'srgb-linear' | 'aces-cg';
export type DisplayTransform = 'srgb' | 'aces' | 'pq' | 'hlg';
export type IntermediateBitDepth = 16 | 32;

export interface ColorManagementSettings {
  workingSpace: WorkingSpace;
  displayTransform: DisplayTransform;
  bitDepth: IntermediateBitDepth;
}

interface ColorManagementStore extends ColorManagementSettings {
  setWorkingSpace: (v: WorkingSpace) => void;
  setDisplayTransform: (v: DisplayTransform) => void;
  setBitDepth: (v: IntermediateBitDepth) => void;
  settings: () => ColorManagementSettings;
  restore: (s: Partial<ColorManagementSettings>) => void;
  key: () => string;
}

/** Matches shipped renderer defaults (linear Rec.709 working space, sRGB display). */
export const DEFAULT_COLOR_MANAGEMENT_SETTINGS: ColorManagementSettings = {
  workingSpace: 'srgb-linear',
  displayTransform: 'srgb',
  bitDepth: 16,
};

export const useColorManagementStore = create<ColorManagementStore>((set, get) => ({
  ...DEFAULT_COLOR_MANAGEMENT_SETTINGS,
  setWorkingSpace: (v) => { set({ workingSpace: v }); touched(); },
  setDisplayTransform: (v) => { set({ displayTransform: v }); touched(); },
  setBitDepth: (v) => { set({ bitDepth: v === 32 ? 32 : 16 }); touched(); },
  settings: () => {
    const { workingSpace, displayTransform, bitDepth } = get();
    return { workingSpace, displayTransform, bitDepth };
  },
  restore: (s) => {
    const g = get();
    if (s.workingSpace === 'srgb-linear' || s.workingSpace === 'aces-cg') {
      g.setWorkingSpace(s.workingSpace);
    }
    if (
      s.displayTransform === 'srgb'
      || s.displayTransform === 'aces'
      || s.displayTransform === 'pq'
      || s.displayTransform === 'hlg'
    ) {
      g.setDisplayTransform(s.displayTransform);
    }
    if (s.bitDepth === 16 || s.bitDepth === 32) g.setBitDepth(s.bitDepth);
  },
  key: () => {
    const s = get();
    return `${s.workingSpace}:${s.displayTransform}:${s.bitDepth}`;
  },
}));
