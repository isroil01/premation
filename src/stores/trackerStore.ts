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
 *   transform — 2 points (anchor, reference); Apply writes position +
 *               rotation + scale keyframes on a target layer.
 *   stabilize — 1 point; Apply writes inverse motion on the video layer.
 *   corner    — 4 points (TL, TR, BR, BL); Apply keyframes a Corner Pin
 *               effect on a target layer.
 *   mask      — 0 manual points; the layer's mask vertices ARE the points,
 *               and tracking applies directly as mask keyframes.
 */

import { create } from 'zustand';
import type { CompTrackSample } from '@core/tracking/trackVideoLayer';

export type TrackerMode = 'follow' | 'transform' | 'stabilize' | 'smooth' | 'corner' | 'mask';

export interface TrackerResult {
  /** One track per point, in point order. */
  tracks: CompTrackSample[][];
  /** Source-plane size the samples were tracked in — Apply needs it to map
   *  source px → layer px without re-decoding a frame. */
  sourceWidth: number;
  sourceHeight: number;
  status: 'completed' | 'lost' | 'cancelled';
}

/**
 * The one-click flow's three states.
 *
 * `picking` exists because a click on the viewport already means "select
 * that layer", and one gesture cannot mean two things. Arming makes the
 * intent explicit for exactly one click, and Escape or a second press of the
 * button disarms — so the tracker never quietly owns the pointer.
 */
export type AutoPhase = 'idle' | 'picking' | 'analyzing';

/** What the analysis measured, in source display px — drawn by the overlay
 *  and summarized in the panel, so the user can see WHY it chose that spot. */
export interface AutoPlanSummary {
  x: number;
  y: number;
  featureHalf: number;
  searchHalf: number;
  /** Measured px/frame at the feature; null when it could not be measured. */
  motionPerFrame: number | null;
  /** Shi-Tomasi corner strength — how well-defined the feature is. */
  strength: number;
  /** 0..1; low means look-alikes nearby (see autoFeature.distinctnessAt). */
  distinctness: number;
}

export function pointCountFor(mode: TrackerMode): number {
  // Smooth stabilize is DENSE — the flow grid is its points, so it places none.
  // Corner/planar seeds 4 corners + centre for an overdetermined LS fit.
  return mode === 'corner' ? 5 : mode === 'transform' ? 2 : mode === 'mask' || mode === 'smooth' ? 0 : 1;
}

/** Seed positions for a mode, in source px. Multi-point modes start spread
 *  out so every handle is visible and grabbable, not stacked. */
export function seedPointsFor(mode: TrackerMode, w: number, h: number): Array<{ x: number; y: number }> {
  if (mode === 'corner') {
    const ix = w * 0.25;
    const iy = h * 0.25;
    return [
      { x: ix, y: iy },
      { x: w - ix, y: iy },
      { x: w - ix, y: h - iy },
      { x: ix, y: h - iy },
      { x: w / 2, y: h / 2 }, // interior — tightens planar LS fit
    ];
  }
  if (mode === 'transform') {
    return [
      { x: w * 0.35, y: h / 2 },
      { x: w * 0.65, y: h / 2 },
    ];
  }
  if (mode === 'mask' || mode === 'smooth') return [];
  return [{ x: w / 2, y: h / 2 }];
}

/**
 * Is the viewport armed for the one-click target pick?
 *
 * Exported as a plain predicate because a GLOBAL shortcut has to consult it:
 * Escape is bound to Deselect, `ShortcutManager` listens on window in the
 * capture phase and is registered at app boot, and a panel-mounted listener
 * therefore loses the race no matter what it does — even with
 * `stopImmediatePropagation`. The supported way for a transient mode to take a
 * chord is for the competing COMMAND to report itself disabled, which is what
 * `BuiltinCommands.Deselect` does with this. Deselecting mid-pick unmounts the
 * panel that armed the pick, so the two are not merely both-firing, they are
 * contradictory.
 */
export function isPickArmed(): boolean {
  return useTrackerStore.getState().autoPhase === 'picking';
}

interface TrackerStore {
  /** The video layer being tracked, or null when the tracker is idle. */
  nodeId: string | null;
  /**
   * True only while the Track Motion section is OPEN in the inspector. The
   * canvas overlay renders only when armed: merely selecting a video layer
   * must not put track-point chrome (and its hit targets) over the viewport.
   * Disarming keeps points/result, so closing the section loses nothing.
   */
  armed: boolean;
  mode: TrackerMode;
  /** Feature centres in source pixels — count depends on mode. */
  points: Array<{ x: number; y: number }>;
  /** Feature patch half-size in source px ((2h+1)² patch). */
  featureHalf: number;
  /** Search window half-size in source px. */
  searchHalf: number;
  /**
   * Corner mode only: densify the quad into an interior feature lattice at
   * track time (`densifyQuad`), so the planar fit is overdetermined and
   * RANSAC can outvote occluded features. The stored `points` stay the
   * user's 4+1 handles — the lattice is derived per run.
   */
  dense: boolean;
  tracking: boolean;
  /** 0..1 while tracking. */
  progress: number;
  result: TrackerResult | null;
  /** Human-readable outcome/error line for the section. */
  note: string | null;

  /** One-click tracking: waiting for a click, analysing, or neither. */
  autoPhase: AutoPhase;
  /** The last analysis's measurements, kept so the result stays explainable
   *  after the run finishes. Cleared when a new pick starts. */
  autoPlan: AutoPlanSummary | null;

  activate: (nodeId: string) => void;
  disarm: () => void;
  setMode: (mode: TrackerMode, sourceW: number, sourceH: number) => void;
  seedPoints: (sourceW: number, sourceH: number) => void;
  setPoint: (index: number, x: number, y: number) => void;
  setSizes: (featureHalf: number, searchHalf: number) => void;
  setDense: (dense: boolean) => void;
  beginTracking: () => void;
  setProgress: (p: number) => void;
  finishTracking: (result: TrackerResult | null, note: string | null) => void;
  /** Arm (or disarm) the viewport for the one-click target pick. */
  setAutoPhase: (phase: AutoPhase) => void;
  setAutoPlan: (plan: AutoPlanSummary | null) => void;
  clear: () => void;
}

export const useTrackerStore = create<TrackerStore>((set, get) => ({
  nodeId: null,
  armed: false,
  mode: 'follow',
  points: [],
  featureHalf: 10,
  searchHalf: 24,
  dense: false,
  tracking: false,
  progress: 0,
  result: null,
  note: null,
  autoPhase: 'idle',
  autoPlan: null,

  activate: (nodeId) => {
    // Switching layers drops the points and result — a track point positioned
    // on one clip's pixels means nothing on another clip.
    if (get().nodeId !== nodeId) {
      set({
        nodeId, armed: true, points: [], result: null, note: null,
        tracking: false, progress: 0, autoPhase: 'idle', autoPlan: null,
      });
    } else if (!get().armed) {
      set({ armed: true });
    }
  },
  // Closing the section must also drop the pointer arming: an overlay that
  // is no longer drawn cannot show a crosshair, and a viewport that still
  // swallows the next click would look like the app had frozen.
  disarm: () => set({ armed: false, autoPhase: 'idle' }),
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
  setDense: (dense) => set({ dense }),
  beginTracking: () => set({ tracking: true, progress: 0, result: null, note: null }),
  setProgress: (p) => set({ progress: p }),
  finishTracking: (result, note) =>
    set({ tracking: false, progress: 0, result, note, autoPhase: 'idle' }),
  setAutoPhase: (autoPhase) => set({ autoPhase }),
  setAutoPlan: (autoPlan) => set({ autoPlan }),
  clear: () =>
    set({
      nodeId: null, armed: false, points: [], result: null, note: null,
      tracking: false, progress: 0, autoPhase: 'idle', autoPlan: null,
    }),
}));
