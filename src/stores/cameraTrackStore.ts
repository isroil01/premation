/**
 * The 3D Camera Tracker's editor state (AE parity 3.5): the solve loaded from
 * the footage layer for the viewer, and which track points are selected.
 * Never part of the document — the solve itself is (setCameraSolve).
 */

import { create } from 'zustand';
import type { CameraSolveData } from '@core/tracking/cameraTrack';

interface CameraTrackState {
  layer: string | null;
  solve: CameraSolveData | null;
  selected: number[];
  /** The lens for the next solve, source px; 0 = solve it. */
  focalLength: number;
  setFocalLength(px: number): void;
  setSolve(layer: string, solve: CameraSolveData | null): void;
  /** Click: select only it; with `add`: toggle it. */
  pick(index: number, add: boolean): void;
  selectMany(indices: number[], add: boolean): void;
  clearSelection(): void;
}

export const useCameraTrackStore = create<CameraTrackState>((set) => ({
  layer: null,
  solve: null,
  selected: [],
  focalLength: 0,
  setFocalLength: (px) => set({ focalLength: Number.isFinite(px) && px > 0 ? px : 0 }),
  setSolve: (layer, solve) => set((s) => ({ layer, solve, selected: s.layer === layer ? s.selected.filter((i) => !!solve && i < solve.points.length) : [] })),
  pick: (index, add) =>
    set((s) => ({ selected: add ? (s.selected.includes(index) ? s.selected.filter((i) => i !== index) : [...s.selected, index]) : [index] })),
  selectMany: (indices, add) => set((s) => ({ selected: add ? [...new Set([...s.selected, ...indices])] : [...indices] })),
  clearSelection: () => set({ selected: [] }),
}));
