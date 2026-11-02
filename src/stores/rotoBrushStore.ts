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
  /**
   * Brush hardness when it was painted, 0…100 (100 = a hard edge, 0 = the
   * softest). Carried on the stroke for the engine's paint / refine edits;
   * the segmenter ignores it (a prompt has no edge).
   */
  hardness?: number;
}

/**
 * A box drawn with the Object Matte tool (AE's Rectangle marquee): layer-local
 * px, centre origin, like the strokes, on the frame at `time`.
 */
export interface RotoBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  time: number;
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
  /** Brush hardness, 0…100 (Selection Brush / Refine Edge footprint edge). */
  hardness: number;
  /** Soft edge on the produced matte, px. */
  featherPx: number;
  /** Id of the mask path the tool last wrote, so a re-segment REPLACES it. */
  maskPathId: string | null;
  /**
   * A SHORT foreground job is in flight (one click, one stroke, one
   * propagate pressed on the options bar). A press made meanwhile is queued
   * (`queuePress`) and runs when the job returns — never dropped.
   */
  busy: boolean;
  /** 0…1 while propagating forward. */
  progress: number;
  /**
   * A background walk (Follow / Re-track, subjectActions.ts) is running:
   * the overlays stay fully interactive and show a small progress chip.
   * Distinct from `busy`, which blocks nothing either but queues presses.
   */
  tracking: boolean;
  /** 0…1 of the walk. */
  trackingProgress: number;
  /** The one press waiting for `busy` to clear (the newest wins). */
  queued: (() => void) | null;
  status: string | null;
  /**
   * What the subject tools tell the user right now (the overlay's message: "Segmenting…",
   * "Click to select…", "Select one footage layer…"), shown in the editor's status bar —
   * never as a chip over the picture, where it hid the subject being selected.
   */
  notice: { text: string; busy: boolean } | null;
  engine: RotoEngine;
  refine: RotoRefine;
  /** The Object Matte tool's box prompt, if the selection started from one. */
  box: RotoBox | null;
  /** The Object Matte tool's drag: AE's Rectangle or Lasso marquee. */
  marquee: 'rect' | 'lasso';

  setEngine: (e: RotoEngine) => void;
  setRefine: (patch: Partial<RotoRefine>) => void;
  setNode: (nodeId: string | null) => void;
  setKind: (k: RotoStrokeKind) => void;
  setSize: (px: number) => void;
  setHardness: (pct: number) => void;
  setFeather: (px: number) => void;
  begin: (kind: RotoStrokeKind, p: { x: number; y: number }, time?: number) => void;
  extend: (p: { x: number; y: number }) => void;
  /** Commit the live stroke. Returns it (null when there was none). */
  end: () => RotoStroke | null;
  /**
   * Commit a whole stroke at once (the overlay keeps the stroke in flight in
   * a ref and hands it over on release: one store write per stroke, not one
   * per pointer sample). Carries the brush hardness of the moment.
   */
  addStroke: (kind: RotoStrokeKind, points: ReadonlyArray<{ x: number; y: number }>, time?: number) => RotoStroke;
  cancelLive: () => void;
  /** Take one committed stroke back out (a click that became a double-click). */
  removeStroke: (id: string) => void;
  clearStrokes: () => void;
  setMaskPathId: (id: string | null) => void;
  setBusy: (busy: boolean, progress?: number) => void;
  setTracking: (on: boolean, progress?: number) => void;
  /**
   * Run `press` now, or — while `busy` — hold it until the job in flight
   * returns (a second press meanwhile replaces it: the user corrected the
   * aim, not asked twice). Returns true when it ran at once.
   */
  queuePress: (press: () => void) => boolean;
  setStatus: (s: string | null) => void;
  setNotice: (n: { text: string; busy: boolean } | null) => void;
  setBox: (box: RotoBox | null) => void;
  setMarquee: (m: 'rect' | 'lasso') => void;
  /**
   * A lasso on the frame at `time` (layer-local polygon): the frame's selection
   * starts over from foreground points inside it and background points just
   * outside its edge, so the shape drawn is what is asked for (a box prompt
   * would win over points in the engine and throw the shape away).
   */
  setLasso: (polygon: ReadonlyArray<{ x: number; y: number }>, time: number, fps?: number) => boolean;
  /**
   * The Object Matte tool's click: one point prompt at `time`. `mode` 'new'
   * starts the selection over on that frame (strokes and box there go);
   * 'add' / 'subtract' keep it and add a foreground / background point.
   */
  addPoint: (p: { x: number; y: number }, time: number, mode: 'new' | 'add' | 'subtract', fps?: number) => RotoStroke;
}

let seq = 0;

function insidePolygon(p: { x: number; y: number }, poly: ReadonlyArray<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * A lasso → point prompts: up to 9 foreground points on a grid inside the
 * polygon, and 12 background points on its outline pushed 6 % of its size
 * away from the centre. Null for a lasso with no inside (a line, a scribble).
 */
export function lassoPrompts(polygon: ReadonlyArray<{ x: number; y: number }>): { inside: Array<{ x: number; y: number }>; outside: Array<{ x: number; y: number }> } | null {
  if (polygon.length < 3) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, cx = 0, cy = 0;
  for (const p of polygon) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    cx += p.x; cy += p.y;
  }
  cx /= polygon.length; cy /= polygon.length;
  const w = x1 - x0, h = y1 - y0;
  if (w < 4 || h < 4) return null;
  const inside: Array<{ x: number; y: number }> = [];
  for (let gy = 1; gy <= 3; gy++) {
    for (let gx = 1; gx <= 3; gx++) {
      const p = { x: x0 + (w * gx) / 4, y: y0 + (h * gy) / 4 };
      if (insidePolygon(p, polygon)) inside.push(p);
    }
  }
  if (inside.length === 0 && insidePolygon({ x: cx, y: cy }, polygon)) inside.push({ x: cx, y: cy });
  if (inside.length === 0) return null;
  const outside: Array<{ x: number; y: number }> = [];
  const push = 0.06 * Math.max(w, h);
  for (let k = 0; k < 12; k++) {
    const p = polygon[Math.floor((k * polygon.length) / 12)]!;
    const dx = p.x - cx, dy = p.y - cy;
    const d = Math.hypot(dx, dy) || 1;
    outside.push({ x: p.x + (dx / d) * push, y: p.y + (dy / d) * push });
  }
  return { inside, outside };
}

export const useRotoBrushStore = create<RotoBrushStore>((set, get) => ({
  nodeId: null,
  strokes: [],
  live: null,
  kind: 'fg',
  size: 24,
  hardness: 100,
  featherPx: 2,
  maskPathId: null,
  busy: false,
  progress: 0,
  tracking: false,
  trackingProgress: 0,
  queued: null,
  status: null,
  notice: null,
  engine: 'objectMatte',
  refine: { edgeRadius: 6, decontaminate: 50, motionBlur: false, choke: 0, reduceChatter: 30 },
  box: null,
  marquee: 'rect',

  setEngine: (engine) => set({ engine }),
  setRefine: (patch) => set((s) => ({ refine: { ...s.refine, ...patch } })),
  setNode: (nodeId) =>
    set((s) => (s.nodeId === nodeId ? s : { nodeId, strokes: [], live: null, maskPathId: null, status: null, box: null, queued: null })),
  setKind: (kind) => set({ kind }),
  setSize: (px) => set({ size: Math.max(2, Math.min(200, Math.round(px))) }),
  setHardness: (pct) => set({ hardness: Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : 100 }),
  setFeather: (px) => set({ featherPx: Math.max(0, Math.min(64, Math.round(px))) }),
  begin: (kind, p, time) =>
    set((s) => ({ live: { id: `roto_${++seq}`, kind, points: [p], hardness: s.hardness, ...(time !== undefined ? { time } : {}) } })),
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
  addStroke: (kind, points, time) => {
    const stroke: RotoStroke = { id: `roto_${++seq}`, kind, points: points.map((p) => ({ x: p.x, y: p.y })), hardness: get().hardness, ...(time !== undefined ? { time } : {}) };
    set((s) => ({ strokes: [...s.strokes, stroke] }));
    return stroke;
  },
  cancelLive: () => set({ live: null }),
  removeStroke: (id) => set((s) => ({ strokes: s.strokes.filter((x) => x.id !== id) })),
  clearStrokes: () => set({ strokes: [], live: null, status: null, box: null }),
  setMaskPathId: (id) => set({ maskPathId: id }),
  setBusy: (busy, progress = 0) => {
    const queued = busy ? null : get().queued;
    set({ busy, progress, ...(queued ? { queued: null } : {}) });
    // The job returned: the press made meanwhile runs now (it may set busy again).
    if (queued) queued();
  },
  setTracking: (tracking, progress = 0) => set({ tracking, trackingProgress: tracking ? Math.max(0, Math.min(1, progress)) : 0 }),
  queuePress: (press) => {
    if (!get().busy) {
      press();
      return true;
    }
    set({ queued: press });
    return false;
  },
  setStatus: (status) => set({ status }),
  setNotice: (notice) => set((s) => (s.notice?.text === notice?.text && s.notice?.busy === notice?.busy ? s : { notice })),
  setBox: (box) => set({ box }),
  setMarquee: (marquee) => set({ marquee }),
  setLasso: (polygon, time, fps = 30) => {
    const prompts = lassoPrompts(polygon);
    if (!prompts) return false;
    const half = 0.5 / Math.max(1, fps);
    set((s) => ({
      box: null,
      strokes: [
        ...s.strokes.filter((x) => x.time !== undefined && Math.abs(x.time - time) > half),
        { id: `roto_${++seq}`, kind: 'fg', points: prompts.inside, time },
        { id: `roto_${++seq}`, kind: 'bg', points: prompts.outside, time },
      ],
    }));
    return true;
  },
  addPoint: (p, time, mode, fps = 30) => {
    const stroke: RotoStroke = { id: `roto_${++seq}`, kind: mode === 'subtract' ? 'bg' : 'fg', points: [p], time };
    const half = 0.5 / Math.max(1, fps);
    set((s) => {
      if (mode !== 'new') return { strokes: [...s.strokes, stroke] };
      // A new selection replaces this frame's prompts only: corrections on
      // other frames still belong to the subject being followed.
      const keep = s.strokes.filter((x) => x.time !== undefined && Math.abs(x.time - time) > half);
      return { strokes: [...keep, stroke], box: null };
    });
    return stroke;
  },
}));
