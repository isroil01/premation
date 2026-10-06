/**
 * How the Footage viewer shows its file: zoom and pan, exposure, rulers and
 * guides. Viewing aids of this session — never in the document, not persisted
 * — and started afresh for each file (`reset`).
 */

import { create } from 'zustand';

interface FootageViewState {
  /** Stage px per file px; null = Fit. */
  zoom: number | null;
  /** The picture's centre from the stage's centre, stage px (used when zoomed). */
  panX: number;
  panY: number;
  /** Exposure in stops — how the viewer shows the picture, not the file. */
  exposure: number;
  showRulers: boolean;
  /** Guides in the file's pixels from its top-left. */
  guides: { x: readonly number[]; y: readonly number[] };
  setZoom: (zoom: number | null, panX?: number, panY?: number) => void;
  setPan: (panX: number, panY: number) => void;
  setExposure: (stops: number) => void;
  setRulers: (on: boolean) => void;
  setGuides: (guides: { x: readonly number[]; y: readonly number[] }) => void;
  /** A different file: Fit, no guides. Exposure and the rulers switch are kept. */
  reset: () => void;
}

export const FOOTAGE_ZOOM_MIN = 0.02;
export const FOOTAGE_ZOOM_MAX = 64;

export const useFootageViewStore = create<FootageViewState>((set) => ({
  zoom: null,
  panX: 0,
  panY: 0,
  exposure: 0,
  showRulers: false,
  guides: { x: [], y: [] },
  setZoom: (zoom, panX = 0, panY = 0) =>
    set({ zoom: zoom === null ? null : Math.min(FOOTAGE_ZOOM_MAX, Math.max(FOOTAGE_ZOOM_MIN, zoom)), panX: zoom === null ? 0 : panX, panY: zoom === null ? 0 : panY }),
  setPan: (panX, panY) => set({ panX, panY }),
  setExposure: (stops) => set({ exposure: Math.max(-8, Math.min(8, Number.isFinite(stops) ? stops : 0)) }),
  setRulers: (showRulers) => set({ showRulers }),
  setGuides: (guides) => set({ guides }),
  reset: () => set({ zoom: null, panX: 0, panY: 0, guides: { x: [], y: [] } }),
}));
