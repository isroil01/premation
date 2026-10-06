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

/**
 * `planar` (AE parity 3.4): a REGION of a surface tracked as one homography
 * (Mocha class); 4 region handles, plus 4 surface handles with Surface
 * Adjust. `camera` (3.5): the automatic 3D camera tracker — no points.
 * `face` (3.3): face tracking inside the layer's face mask — no points.
 */
export type TrackerMode = 'follow' | 'transform' | 'stabilize' | 'smooth' | 'corner' | 'mask' | 'planar' | 'camera' | 'face';

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
  /** Shi-Tomasi corner strength — how well-defined the feature is; null = not measured. */
  strength: number | null;
  /**
   * 0..1; low means look-alikes nearby (see autoFeature.distinctnessAt); null
   * = not measured. The engine's one-click track does not measure it yet
   * (AE parity step 3 restores the feature picker), so the panel shows no
   * quality badge rather than a made-up one.
   */
  distinctness: number | null;
}

export function pointCountFor(mode: TrackerMode, stabTwoPoints = false, surface = false): number {
  if (mode === 'planar') return surface ? 8 : 4;
  if (mode === 'camera' || mode === 'face') return 0;
  // Smooth stabilize is DENSE — the flow grid is its points, so it places none.
  // Corner/planar seeds 4 corners + centre for an overdetermined LS fit.
  // Stabilize with rotation or scale reads them from a second point (AE).
  if (mode === 'stabilize' && stabTwoPoints) return 2;
  return mode === 'corner' ? 5 : mode === 'transform' ? 2 : mode === 'mask' || mode === 'smooth' ? 0 : 1;
}

export type TrackDirectionChoice = 'forward' | 'backward' | 'both';

/** Warp Stabilizer settings (AE parity 3.6). */
export interface WarpSettings {
  /** 0…100 %. */
  smoothness: number;
  method: 'position' | 'positionRotation' | 'positionRotationScale';
  framing: 'stabilizeOnly' | 'stabilizeCrop' | 'cropAutoScale';
  /** %, ≥ 100. */
  maxScale: number;
}

/** The samples of each track at `time` (nearest within half a frame at 24 fps), or null when any track has none there. */
export function samplesAt(result: TrackerResult, time: number): Array<{ x: number; y: number }> | null {
  const out: Array<{ x: number; y: number }> = [];
  for (const track of result.tracks) {
    let best: CompTrackSample | null = null;
    for (const smp of track) {
      if (Math.abs(smp.compTime - time) <= 0.021 && (!best || Math.abs(smp.compTime - time) < Math.abs(best.compTime - time))) best = smp;
    }
    if (!best) return null;
    out.push({ x: best.x, y: best.y });
  }
  return out;
}

/**
 * A new walk spliced into the held result (AE parity 3.6: track from a
 * corrected frame). Forward keeps what was before the origin, backward what
 * was after it; both ways replaces it. Point counts must match, else the new
 * result stands alone.
 */
export function spliceResult(
  held: TrackerResult | null,
  next: TrackerResult,
  direction: TrackDirectionChoice,
  origin: number,
): TrackerResult {
  if (!held || direction === 'both' || held.tracks.length !== next.tracks.length) return next;
  const eps = 1e-4;
  const tracks = next.tracks.map((fresh, i) => {
    const old = held.tracks[i] ?? [];
    const keep = direction === 'forward' ? old.filter((s) => s.compTime < origin - eps) : old.filter((s) => s.compTime > origin + eps);
    return [...keep, ...fresh].sort((a, b) => a.compTime - b.compTime);
  });
  return { ...next, tracks, status: next.status === 'completed' && held.status === 'completed' ? 'completed' : next.status };
}

/** Seed positions for a mode, in source px. Multi-point modes start spread
 *  out so every handle is visible and grabbable, not stacked. */
export function seedPointsFor(mode: TrackerMode, w: number, h: number, surface = false): Array<{ x: number; y: number }> {
  if (mode === 'planar') {
    const quad = [
      { x: w * 0.3, y: h * 0.3 }, { x: w * 0.7, y: h * 0.3 }, { x: w * 0.7, y: h * 0.7 }, { x: w * 0.3, y: h * 0.7 },
    ];
    // The surface starts as the region, slightly inset so both are grabbable.
    const inset = [
      { x: w * 0.35, y: h * 0.35 }, { x: w * 0.65, y: h * 0.35 }, { x: w * 0.65, y: h * 0.65 }, { x: w * 0.35, y: h * 0.65 },
    ];
    return surface ? [...quad, ...inset] : quad;
  }
  if (mode === 'camera' || mode === 'face') return [];
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

  /**
   * True while the "Advanced tracking" disclosure is open. The overlay keys
   * manual chrome (seeded handles, feature/search boxes) off this: a person
   * in the one-click flow has placed nothing, and a crosshair-in-a-box
   * floating mid-footage before they act reads as a glitch, not a tool.
   */
  advancedOpen: boolean;
  /**
   * What an armed pick MEANS: 'track' runs the one-click tracker on the
   * click/box; 'object' segments the click/box into a mask path
   * (objectMask.ts). One crosshair, two verbs — the panel arms the intent,
   * the overlay only reports the gesture.
   */
  pickIntent: 'track' | 'object';
  /** One-click tracking: waiting for a click, analysing, or neither. */
  autoPhase: AutoPhase;
  /** The last analysis's measurements, kept so the result stays explainable
   *  after the run finishes. Cleared when a new pick starts. */
  autoPlan: AutoPlanSummary | null;
  /** Attach point per point, as an offset from the feature centre (source px; AE's attach point). */
  attach: Array<{ x: number; y: number }>;
  /** Analyse at full resolution (the job's analysisMaxEdge 0) instead of the 960 px tier. */
  fullResolution: boolean;
  /** Stabilize mode: also stabilize rotation / scale (two points). */
  stabRotation: boolean;
  stabScale: boolean;
  warp: WarpSettings;
  /** Follow mode's property on the target: '' = its position, else `effects/<id>/<param>` (an effect point). */
  applyPath: string;
  /** The playhead the handles were last synced to (a held result's samples there). */
  cursorTime: number | null;
  /** Times where the user corrected a sample by hand, since the last walk. */
  corrections: number[];
  /** Planar mode: separate surface corners (AE / Mocha Surface Adjust). */
  planarSurface: boolean;
  /** Planar mode: mask ids whose area is never tracked. */
  excludeMasks: string[];
  /** Face mode: Outline Only or Detailed Features, and the face mask ('' = the first). */
  faceMode: 'outline' | 'detailed';
  faceMask: string;

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
  setAdvancedOpen: (open: boolean) => void;
  setAutoPhase: (phase: AutoPhase, intent?: 'track' | 'object') => void;
  setAutoPlan: (plan: AutoPlanSummary | null) => void;
  setAttach: (index: number, x: number, y: number) => void;
  setFullResolution: (on: boolean) => void;
  setStabilize: (rotation: boolean, scale: boolean, sourceW: number, sourceH: number) => void;
  setWarp: (patch: Partial<WarpSettings>) => void;
  setApplyPath: (path: string) => void;
  setPlanarSurface: (on: boolean, sourceW: number, sourceH: number) => void;
  setExcludeMasks: (ids: string[]) => void;
  setFace: (patch: { faceMode?: 'outline' | 'detailed'; faceMask?: string }) => void;
  /** Move the handles to the held result's samples at `time` (keeps the result). */
  syncToTime: (time: number) => void;
  /** Restore a saved tracker (the layer's `getLayerTrackers`). */
  restore: (s: { mode: TrackerMode; points: Array<{ x: number; y: number }>; attach: Array<{ x: number; y: number }>; featureHalf: number; searchHalf: number; result: TrackerResult | null }) => void;
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
  advancedOpen: false,
  pickIntent: 'track',
  autoPhase: 'idle',
  autoPlan: null,
  attach: [],
  fullResolution: false,
  stabRotation: false,
  stabScale: false,
  warp: { smoothness: 50, method: 'positionRotationScale', framing: 'stabilizeOnly', maxScale: 150 },
  applyPath: '',
  cursorTime: null,
  corrections: [],
  planarSurface: false,
  excludeMasks: [],
  faceMode: 'outline',
  faceMask: '',

  activate: (nodeId) => {
    // Switching layers drops the points and result — a track point positioned
    // on one clip's pixels means nothing on another clip.
    if (get().nodeId !== nodeId) {
      set({
        nodeId, armed: true, points: [], result: null, note: null,
        tracking: false, progress: 0, autoPhase: 'idle', autoPlan: null,
        attach: [], applyPath: '', cursorTime: null, corrections: [], excludeMasks: [], faceMask: '',
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
    const points = seedPointsFor(mode, sourceW, sourceH, get().planarSurface);
    if (mode === 'stabilize' && (get().stabRotation || get().stabScale)) points.push({ x: sourceW * 0.65, y: sourceH / 2 });
    set({ mode, points, attach: [], result: null, note: null, corrections: [] });
  },
  seedPoints: (sourceW, sourceH) => {
    const s = get();
    if (s.points.length === pointCountFor(s.mode, s.stabRotation || s.stabScale, s.planarSurface)) return;
    const points = seedPointsFor(s.mode, sourceW, sourceH, s.planarSurface);
    if (s.mode === 'stabilize' && (s.stabRotation || s.stabScale)) points.push({ x: sourceW * 0.65, y: sourceH / 2 });
    set({ points });
  },
  setPoint: (index, x, y) =>
    set((s) => {
      if (index < 0 || index >= s.points.length) return s;
      const points = s.points.slice();
      points[index] = { x, y };
      // With a held track, moving a handle CORRECTS that frame's sample (AE:
      // fix the frame, then track on from it) instead of discarding the track.
      if (s.result && s.cursorTime !== null && s.result.tracks[index]) {
        const t = s.cursorTime;
        const track = s.result.tracks[index]!;
        let hit = -1;
        for (let i = 0; i < track.length; i++) {
          if (Math.abs(track[i]!.compTime - t) <= 0.021 && (hit < 0 || Math.abs(track[i]!.compTime - t) < Math.abs(track[hit]!.compTime - t))) hit = i;
        }
        if (hit >= 0) {
          const fixed = track.slice();
          fixed[hit] = { ...fixed[hit]!, x, y, confidence: 1, coasted: false };
          const tracks = s.result.tracks.slice();
          tracks[index] = fixed;
          const corrections = s.corrections.includes(t) ? s.corrections : [...s.corrections, t];
          return {
            ...s, points, result: { ...s.result, tracks }, corrections,
            note: 'Corrected this frame. Track forward or backward to re-track from here.',
          };
        }
      }
      return { ...s, points, result: null, note: null, corrections: [] };
    }),
  setSizes: (featureHalf, searchHalf) => set({ featureHalf, searchHalf }),
  setDense: (dense) => set({ dense }),
  beginTracking: () => set({ tracking: true, progress: 0, result: null, note: null }),
  setProgress: (p) => set({ progress: p }),
  finishTracking: (result, note) =>
    set({ tracking: false, progress: 0, result, note, autoPhase: 'idle' }),
  setAdvancedOpen: (advancedOpen) => set({ advancedOpen }),
  // Intent defaults to 'track' whenever a pick is armed WITHOUT naming one:
  // a stale 'object' intent surviving into the next plain pick would silently
  // turn "track this" into "mask this".
  setAutoPhase: (autoPhase, intent) =>
    set((s) => ({ autoPhase, pickIntent: intent ?? (autoPhase === 'picking' ? 'track' : s.pickIntent) })),
  setAutoPlan: (autoPlan) => set({ autoPlan }),
  setAttach: (index, x, y) =>
    set((s) => {
      const attach = s.points.map((_, i) => s.attach[i] ?? { x: 0, y: 0 });
      if (index < 0 || index >= attach.length) return s;
      attach[index] = { x, y };
      return { ...s, attach };
    }),
  setFullResolution: (fullResolution) => set({ fullResolution }),
  setStabilize: (stabRotation, stabScale, sourceW, sourceH) =>
    set((s) => {
      const two = stabRotation || stabScale;
      let points = s.points;
      if (s.mode === 'stabilize') {
        if (two && points.length < 2) points = [...points, { x: sourceW * 0.65, y: sourceH / 2 }];
        if (!two && points.length > 1) points = points.slice(0, 1);
      }
      const changedCount = points.length !== s.points.length;
      return { ...s, stabRotation, stabScale, points, ...(changedCount ? { result: null, note: null } : {}) };
    }),
  setWarp: (patch) => set((s) => ({ warp: { ...s.warp, ...patch } })),
  setApplyPath: (applyPath) => set({ applyPath }),
  setPlanarSurface: (planarSurface, sourceW, sourceH) =>
    set((s) => {
      if (s.mode !== 'planar') return { ...s, planarSurface };
      // Surface corners start on the region's, inset: the user then drags them where the insert goes.
      const region = s.points.slice(0, 4);
      if (region.length < 4) return { ...s, planarSurface, points: seedPointsFor('planar', sourceW, sourceH, planarSurface), result: null };
      const cx = region.reduce((a, p) => a + p.x, 0) / 4;
      const cy = region.reduce((a, p) => a + p.y, 0) / 4;
      const surface = region.map((p) => ({ x: cx + (p.x - cx) * 0.8, y: cy + (p.y - cy) * 0.8 }));
      return { ...s, planarSurface, points: planarSurface ? [...region, ...surface] : region, result: null, note: null };
    }),
  setExcludeMasks: (excludeMasks) => set({ excludeMasks, result: null }),
  setFace: (patch) => set((s) => ({ ...s, ...patch })),
  syncToTime: (time) => {
    const s = get();
    if (!s.result || s.tracking) return;
    // A one-click track holds a companion track beyond the one handle: the
    // handles take the first samples.
    const all = samplesAt(s.result, time);
    if (!all || all.length < s.points.length || s.points.length === 0) {
      if (s.cursorTime !== null) set({ cursorTime: null });
      return;
    }
    const at = all.slice(0, s.points.length);
    const same = at.every((p, i) => p.x === s.points[i]?.x && p.y === s.points[i]?.y);
    if (same && s.cursorTime === time) return;
    set({ points: at, cursorTime: time });
  },
  restore: ({ mode, points, attach, featureHalf, searchHalf, result }) =>
    set({ mode, points, attach, featureHalf, searchHalf, result, note: result ? 'Restored the track saved on this layer.' : null, corrections: [], cursorTime: null }),
  clear: () =>
    set({
      nodeId: null, armed: false, points: [], result: null, note: null,
      tracking: false, progress: 0, autoPhase: 'idle', autoPlan: null,
    }),
}));
