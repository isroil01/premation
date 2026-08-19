/**
 * Track Motion's working state — the track point, the box sizes, the run, and
 * the last result awaiting Apply.
 *
 * Kept out of `selectionStore` for the reason `effectHandleStore` is: the
 * track point is not a scene node, it is a sub-selection WITHIN one video
 * layer, and folding synthetic ids into the layer selection breaks everything
 * that assumes a selection id names a real node.
 *
 * The point lives in SOURCE pixels (the decoded frame's grid), not layer or
 * comp pixels — that is the space the tracker actually matches in, and the
 * one space that does not move when the layer's transform animates. The
 * overlay converts to screen for drawing, and Apply converts to comp space
 * per-frame through the video layer's own transform.
 */

import { create } from 'zustand';
import type { CompTrackSample } from '@core/tracking/trackVideoLayer';

export interface TrackerResult {
  samples: CompTrackSample[];
  /** Source-plane size the samples were tracked in — Apply needs it to map
   *  source px → layer px without re-decoding a frame. */
  sourceWidth: number;
  sourceHeight: number;
  status: 'completed' | 'lost' | 'cancelled';
}

interface TrackerStore {
  /** The video layer being tracked, or null when the tracker is idle. */
  nodeId: string | null;
  /** Feature centre in source pixels. */
  point: { x: number; y: number } | null;
  /** Feature patch half-size in source px ((2h+1)² patch). */
  featureHalf: number;
  /** Search window half-size in source px. */
  searchHalf: number;
  tracking: boolean;
  /** 0..1 while tracking. */
  progress: number;
  result: TrackerResult | null;
  /** Human-readable outcome/error line for the section. */
  note: string | null;

  activate: (nodeId: string) => void;
  setPoint: (x: number, y: number) => void;
  setSizes: (featureHalf: number, searchHalf: number) => void;
  beginTracking: () => void;
  setProgress: (p: number) => void;
  finishTracking: (result: TrackerResult | null, note: string | null) => void;
  clear: () => void;
}

export const useTrackerStore = create<TrackerStore>((set, get) => ({
  nodeId: null,
  point: null,
  featureHalf: 10,
  searchHalf: 24,
  tracking: false,
  progress: 0,
  result: null,
  note: null,

  activate: (nodeId) => {
    // Switching layers drops the point and result — a track point positioned
    // on one clip's pixels means nothing on another clip.
    if (get().nodeId !== nodeId) {
      set({ nodeId, point: null, result: null, note: null, tracking: false, progress: 0 });
    }
  },
  setPoint: (x, y) => set({ point: { x, y }, result: null, note: null }),
  setSizes: (featureHalf, searchHalf) => set({ featureHalf, searchHalf }),
  beginTracking: () => set({ tracking: true, progress: 0, result: null, note: null }),
  setProgress: (p) => set({ progress: p }),
  finishTracking: (result, note) => set({ tracking: false, progress: 0, result, note }),
  clear: () =>
    set({ nodeId: null, point: null, result: null, note: null, tracking: false, progress: 0 }),
}));
