/**
 * Paint-specific Brush settings (AE's Paint panel) that the freehand-shape brush
 * doesn't have: paint-vs-erase mode, opacity, and edge hardness. Size and colour
 * are SHARED with the freehand brush and live on the engine's `drawToolOptions`
 * (`brushSize`/`brushColor`) so the one Tool Options bar drives both — no
 * duplicate size/colour source.
 */

import { create } from 'zustand';
import type { PaintMode } from '@core/paint/paintStrokes';

export interface PaintSettings {
  opacity: number; // 0..1
  hardness: number; // 0..1 — 1 = hard edge, <1 feathered
  mode: PaintMode;
}

interface PaintStore extends PaintSettings {
  set: (patch: Partial<PaintSettings>) => void;
}

export const usePaintStore = create<PaintStore>((set) => ({
  opacity: 1,
  hardness: 1,
  mode: 'paint',
  set: (patch) => set(patch),
}));
