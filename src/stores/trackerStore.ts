/**
 * Track Motion's working state — mode, track points, box sizes, the run, and
 * the last result awaiting Apply.
 *
 * Kept out of `selectionStore` for the reason `effectHandleStore` is: track
 * points are not scene nodes, they are a sub-selection WITHIN one video
 * layer, and folding synthetic ids into the layer selection breaks
 * everything that assumes a selection id names a real node.
 *
 * Points live in SOURCE pixels (the decoded frame's grid) — the space the
 * tracker matches in, and the one space that does not move when the layer's
 * transform animates. The overlay converts to screen for drawing; Apply
 * converts to comp space per-frame through the video layer's own transform.
 *
 * Modes and their point count:
 *   follow    — 1 point; Apply writes position keyframes on a target layer.
 *   stabilize — 1 point; Apply writes inverse motion on the video layer.
 *   corner    — 4 points (TL, TR, BR, BL); Apply keyframes a Corner Pin
 *               effect on a target layer.
 *   mask      — 0 manual points; the layer's mask vertices ARE the points,
 *               and tracking applies directly as mask keyframes.
 */

import { create } from 'zustand';
import type { CompTrackSample } from '@core/tracking/trackVideoLayer';

export type TrackerMode = 'follow' | 'stabilize' | 'corner' | 'mask';

export interface TrackerResult {
  /** One track per point, in point order. */
  tracks: CompTrackSample[][];
  /** Source-plane size the samples were tracked in — Apply needs it to map
   *  source px → layer px without re-decoding a frame. */
  sourceWidth: number;
  sourceHeight: number;
  status: 'completed' | 'lost' | 'cancelled';
}

export function pointCountFor(mode: TrackerMode): number {
  return mode === 'corner' ? 4 : mode === 'mask' ? 0 : 1;
}

/** Seed positions for a mode, in source px. Corner points start at an inset
 *  quad so all four handles are visible and grabbable, not stacked. */
export function seedPointsFor(mode: TrackerMode, w: number, h: number): Array<{ x: number; y: number }> {
  if (mode === 'corner') {
    const ix = w * 0.25;
    const iy = h * 0.25;
    return [
      { x: ix, y: iy },
      { x: w - ix, y: iy },
      { x: w - ix, y: h - iy },
      { x: ix, y: h - iy },
    ];
  }
  if (mode === 'mask') return [];
  return [{ x: w / 2, y: h / 2 }];
}

interface TrackerStore {
  /** The video layer being tracked, or null when the tracker is idle. */
  nodeId: string | null;
  mode: TrackerMode;
  /** Feature centres in source pixels — count depends on mode. */
  points: Array<{ x: number; y: number }>;
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
  setMode: (mode: TrackerMode, sourceW: number, sourceH: number) => void;
  seedPoints: (sourceW: number, sourceH: number) => void;
  setPoint: (index: number, x: number, y: number) => void;
  setSizes: (featureHalf: number, searchHalf: number) => void;
  beginTracking: () => void;
  setProgress: (p: number) => void;
  finishTracking: (result: TrackerResult | null, note: string | null) => void;
  clear: () => void;
}

export const useTrackerStore = create<TrackerStore>((set, get) => ({
  nodeId: null,
  mode: 'follow',
  points: [],
  featureHalf: 10,
  searchHalf: 24,
  tracking: false,
  progress: 0,
  result: null,
  note: null,

  activate: (nodeId) => {
    // Switching layers drops the points and result — a track point positioned
    // on one clip's pixels means nothing on another clip.
    if (get().nodeId !== nodeId) {
      set({ nodeId, points: [], result: null, note: null, tracking: false, progress: 0 });
    }
  },
  setMode: (mode, sourceW, sourceH) => {
    if (get().mode === mode) return;
    set({ mode, points: seedPointsFor(mode, sourceW, sourceH), result: null, note: null });
  },
  seedPoints: (sourceW, sourceH) => {
    if (get().points.length === pointCountFor(get().mode)) return;
    set({ points: seedPointsFor(get().mode, sourceW, sourceH) });
  },
  setPoint: (index, x, y) =>
    set((s) => {
      if (index < 0 || index >= s.points.length) return s;
      const points = s.points.slice();
      points[index] = { x, y };
      return { ...s, points, result: null, note: null };
    }),
  setSizes: (featureHalf, searchHalf) => set({ featureHalf, searchHalf }),
  beginTracking: () => set({ tracking: true, progress: 0, result: null, note: null }),
  setProgress: (p) => set({ progress: p }),
  finishTracking: (result, note) => set({ tracking: false, progress: 0, result, note }),
  clear: () =>
    set({ nodeId: null, points: [], result: null, note: null, tracking: false, progress: 0 }),
}));
