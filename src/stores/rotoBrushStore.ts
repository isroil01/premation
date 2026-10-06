/**
 * Roto Brush tool state — the strokes the user has painted on the viewport
 * and what they mean.
 *
 * A stroke is a polyline in the TARGET LAYER's local pixels (not screen px),
 * so it stays attached to the layer through a pan or zoom and can be handed
 * to the segmenter in source coordinates. Foreground strokes say "this is the
 * subject", background strokes say "this is not"; on release the whole set
 * is re-segmented and the result written as the layer's roto mask path.
 *
 * Session state, never project data: the MASK the strokes produce is what
 * persists (as an ordinary mask path on the layer).
 */

import { create } from 'zustand';

export type RotoStrokeKind = 'fg' | 'bg';

export interface RotoStroke {
  id: string;
  kind: RotoStrokeKind;
  /** Layer-local px, centre-origin (the mask path's own space). */
  points: Array<{ x: number; y: number }>;
  /** Composition seconds of the frame it was painted on (AE parity 3.1: a
   *  stroke on another frame is a correction for that frame). */
  time?: number;
}

/** How the matte is carried through the shot. */
export type RotoEngine = 'objectMatte' | 'classic';

/** Object Matte refinement (AE parity 3.2), the job's MatteRefine. */
export interface RotoRefine {
  edgeRadius: number;
  decontaminate: number;  // 0…100 %
  motionBlur: boolean;
  choke: number;          // −100…100 %
  reduceChatter: number;  // 0…100 %
}

interface RotoBrushStore {
  /** The layer the strokes belong to; strokes are dropped on a change. */
  nodeId: string | null;
  strokes: RotoStroke[];
  /** The stroke in flight, drawn live. */
  live: RotoStroke | null;
  /** Which kind the next stroke paints. Alt while painting flips it. */
  kind: RotoStrokeKind;
  /** Brush width in screen px (drawn only; segmentation is point-based). */
  size: number;
  /** Soft edge on the produced matte, px. */
  featherPx: number;
  /** Id of the mask path the tool last wrote, so a re-segment REPLACES it. */
  maskPathId: string | null;
  busy: boolean;
  /** 0…1 while propagating forward. */
  progress: number;
  status: string | null;
  engine: RotoEngine;
  refine: RotoRefine;

  setEngine: (e: RotoEngine) => void;
  setRefine: (patch: Partial<RotoRefine>) => void;
  setNode: (nodeId: string | null) => void;
  setKind: (k: RotoStrokeKind) => void;
  setSize: (px: number) => void;
  setFeather: (px: number) => void;
  begin: (kind: RotoStrokeKind, p: { x: number; y: number }, time?: number) => void;
  extend: (p: { x: number; y: number }) => void;
  /** Commit the live stroke. Returns it (null when there was none). */
  end: () => RotoStroke | null;
  cancelLive: () => void;
  /** Take one committed stroke back out (a click that became a double-click). */
  removeStroke: (id: string) => void;
  clearStrokes: () => void;
  setMaskPathId: (id: string | null) => void;
  setBusy: (busy: boolean, progress?: number) => void;
  setStatus: (s: string | null) => void;
}

let seq = 0;

export const useRotoBrushStore = create<RotoBrushStore>((set, get) => ({
  nodeId: null,
  strokes: [],
  live: null,
  kind: 'fg',
  size: 24,
  featherPx: 2,
  maskPathId: null,
  busy: false,
  progress: 0,
  status: null,
  engine: 'objectMatte',
  refine: { edgeRadius: 6, decontaminate: 50, motionBlur: false, choke: 0, reduceChatter: 30 },

  setEngine: (engine) => set({ engine }),
  setRefine: (patch) => set((s) => ({ refine: { ...s.refine, ...patch } })),
  setNode: (nodeId) =>
    set((s) => (s.nodeId === nodeId ? s : { nodeId, strokes: [], live: null, maskPathId: null, status: null })),
  setKind: (kind) => set({ kind }),
  setSize: (px) => set({ size: Math.max(2, Math.min(200, Math.round(px))) }),
  setFeather: (px) => set({ featherPx: Math.max(0, Math.min(64, Math.round(px))) }),
  begin: (kind, p, time) => set({ live: { id: `roto_${++seq}`, kind, points: [p], ...(time !== undefined ? { time } : {}) } }),
  extend: (p) =>
    set((s) => {
      if (!s.live) return s;
      const last = s.live.points[s.live.points.length - 1];
      // Skip sub-pixel jitter so a slow drag does not become a thousand points.
      if (last && Math.hypot(last.x - p.x, last.y - p.y) < 0.5) return s;
      return { live: { ...s.live, points: [...s.live.points, p] } };
    }),
  end: () => {
    const live = get().live;
    if (!live) return null;
    set((s) => ({ live: null, strokes: [...s.strokes, live] }));
    return live;
  },
  cancelLive: () => set({ live: null }),
  removeStroke: (id) => set((s) => ({ strokes: s.strokes.filter((x) => x.id !== id) })),
  clearStrokes: () => set({ strokes: [], live: null, status: null }),
  setMaskPathId: (id) => set({ maskPathId: id }),
  setBusy: (busy, progress = 0) => set({ busy, progress }),
  setStatus: (status) => set({ status }),
}));
