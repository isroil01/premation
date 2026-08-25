/**
 * Session-only viewer LUT (monitor look).
 *
 * Like AE's viewer/monitor LUT: applied after the display transform on the
 * viewport only. Never persisted in the document and never used by auxiliary
 * (export / thumbnail) backends — grade and delivery stay untouched.
 */

import { create } from 'zustand';
import { getEventBus } from '@core/events/EventBus';
import { parseCubeLut, type CubeLut } from '@core/effects/cubeLut';

export const VIEWER_LUT_TEXTURE_KEY = 'viewer-lut';

interface ViewerLutState {
  lut: CubeLut | null;
  /** Display name (usually the file name). */
  name: string | null;
  /** Cache key for the GPU strip upload. */
  signature: string;
  loadFromText: (text: string, filename: string) => boolean;
  clear: () => void;
}

function bumpViewport(): void {
  try {
    // Viewport-only refresh — do NOT emit DocumentChanged (not project data).
    getEventBus().emit('AnimationChanged', { nodeId: '__viewerLut__' });
  } catch {
    /* no bus in headless tests */
  }
}

function signatureFor(lut: CubeLut, name: string): string {
  return `${name}|${lut.title ?? ''}|${lut.size}|${lut.size1d}|${lut.domainMin.join(',')}|${lut.domainMax.join(',')}`;
}

export const useViewerLutStore = create<ViewerLutState>((set) => ({
  lut: null,
  name: null,
  signature: 'none',
  loadFromText: (text, filename) => {
    const lut = parseCubeLut(text);
    if (!lut) return false;
    const name = filename.replace(/^.*[\\/]/, '') || 'viewer.cube';
    set({ lut, name, signature: signatureFor(lut, name) });
    bumpViewport();
    return true;
  },
  clear: () => {
    set({ lut: null, name: null, signature: 'none' });
    bumpViewport();
  },
}));
