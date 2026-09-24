/**
 * A finished Paint-tool drag as engine commands — ONE undo step
 * (`commitPaintDrag`, @core/engine/paintEdits.ts, sends them).
 *
 * The comp viewer and the Layer panel map pointer samples into the layer's own
 * space differently (a full world inverse vs. the panel's fit), and then both
 * land here, so AE's stroke rules live in one place:
 *
 *  · a stroke selected in the Paint panel has its Path REPLACED (a new Path
 *    keyframe when the Path is animated);
 *  · Shift continues the layer's previous stroke of the same kind;
 *  · Duration sets the stroke's life (Write On adds End keyframes that replay
 *    the drawing speed);
 *  · Eraser honours Erase mode, Last Stroke Only targeting the previous
 *    non-eraser stroke;
 *  · Clone honours Source, Aligned, Lock Source Time and Source Time Shift.
 */

import { secondsToFlicks, type Command } from '@motion/engine-api';
import { drawToolOptions } from '@motion/workspace';
import { getRemappedTime, getTimelineController } from '@core/timeline/TimelineController';
import { usePaintStore } from '@stores/paintStore';
import { getNodePaint, type PaintMode, type PaintStroke } from './paintStrokes';
import { cloneOffsetFor, durationRange, smoothSamples, strokeOptionsFrom, writeOnEndKeys } from './paintCapture';

type Pt = { x: number; y: number };

export interface PaintDrag {
  nodeId: string;
  /** Decided when the drag STARTED (the eraser erases whatever the store says). */
  mode: PaintMode;
  /** Layer-local samples, already thinned. */
  points: ReadonlyArray<Pt>;
  /** Pointer timestamps (ms), parallel to `points`. */
  times: ReadonlyArray<number>;
  /** Pen input per sample, null for mouse/touch samples. */
  pen: ReadonlyArray<{ pressure: number; tiltX: number; tiltY: number } | null>;
  /** Brush diameter in LAYER px. */
  size: number;
  /** Comp seconds the stroke was drawn at. */
  compTime: number;
  /** Shift: continue the previous stroke. */
  continueStroke?: boolean;
  /** Ctrl+Shift eraser: Last Stroke Only for this drag. */
  lastStrokeOnly?: boolean;
}

export type PaintCommitResult = { ok: true; strokeId: string } | { ok: false; reason: string };

/** The drag's edit: one batch named `label`. `strokeId` is null when the batch adds the stroke (the engine mints it). */
export type PaintDragPlan =
  | { ok: true; label: string; commands: Command[]; strokeId: string | null }
  | { ok: false; reason: string };

const refuse = (reason: string): PaintDragPlan => ({ ok: false, reason });

/**
 * Decide what a drag does (AE's rules above) and return the commands. Reads
 * the layer's paint and the Paint settings; the only write is the Clone
 * Stamp's remembered Aligned offset (editor state on `paintStore`).
 */
export function planPaintDrag(d: PaintDrag): PaintDragPlan {
  if (d.points.length === 0) return refuse('');
  const s = usePaintStore.getState();
  const layerT = getRemappedTime(d.nodeId, d.compTime);
  const fps = getTimelineController().fps || 30;
  const points = smoothSamples(d.points, s.smoothing);
  const label = d.mode === 'erase' ? 'Erase' : 'Paint Stroke';
  const existing = getNodePaint(d.nodeId)?.strokes ?? [];
  const layer = d.nodeId;

  const withPen = d.pen.length === points.length && points.length > 0 && d.pen.every((p) => p !== null);
  const pen = withPen
    ? {
        pressure: d.pen.map((p) => p!.pressure),
        tiltX: d.pen.map((p) => p!.tiltX),
        tiltY: d.pen.map((p) => p!.tiltY),
      }
    : {};

  // A selected stroke: the drag is its new Path (a Path key when the Path is animated).
  const sel = s.selectedStroke;
  if (sel && sel.nodeId === d.nodeId && !d.continueStroke && existing.some((x) => x.id === sel.strokeId)) {
    return {
      ok: true,
      label: 'Replace Paint Path',
      strokeId: sel.strokeId,
      commands: [{ type: 'setPaintStrokePath', layer, stroke: sel.strokeId, points: JSON.stringify(points), time: secondsToFlicks(d.compTime) }],
    };
  }

  if (d.continueStroke) {
    const prev = [...existing].reverse().find((x) => x.mode === d.mode);
    if (prev) {
      // AE joins the previous stroke's end to the new samples. Pen arrays extend
      // in step; a side that lacks them is padded so they stay parallel.
      const more = pen as { pressure?: number[]; tiltX?: number[]; tiltY?: number[] };
      const cat = (a: ReadonlyArray<number> | undefined, b: ReadonlyArray<number> | undefined, fill: number): number[] | null => {
        if (!a && !b) return null;
        return [...(a ?? new Array<number>(prev.points.length).fill(fill)), ...(b ?? new Array<number>(points.length).fill(fill))];
      };
      const patch = {
        points: [...prev.points, ...points],
        pressure: cat(prev.pressure, more.pressure, 1),
        tiltX: cat(prev.tiltX, more.tiltX, 0),
        tiltY: cat(prev.tiltY, more.tiltY, 0),
      };
      return { ok: true, label, strokeId: prev.id, commands: [{ type: 'updatePaintStroke', layer, stroke: prev.id, patch: JSON.stringify(patch) }] };
    }
  }

  const stroke: Partial<PaintStroke> & { points: ReadonlyArray<Pt> } = {
    points,
    ...pen,
    ...strokeOptionsFrom({
      color: drawToolOptions.brushColor,
      size: d.size,
      opacity: s.opacity,
      flow: s.flow,
      hardness: s.hardness,
      angle: s.angle,
      roundness: s.roundness,
      spacing: s.spacing,
      blend: d.mode === 'paint' ? s.blend : 'normal',
      channels: s.channels,
      dynamics: s.dynamics,
    }),
    mode: d.mode,
    ...durationRange(s.duration, layerT, fps, s.customFrames),
  };

  if (d.mode === 'erase') {
    const eraseMode = d.lastStrokeOnly ? 'lastStroke' : s.eraseMode;
    if (eraseMode !== 'layerAndPaint') stroke.eraseMode = eraseMode;
    if (eraseMode === 'lastStroke') {
      const target = [...existing].reverse().find((x) => x.mode !== 'erase');
      if (!target) return refuse('There is no stroke for Last Stroke Only to erase.');
      stroke.eraseTargetId = target.id;
    }
  }

  if (d.mode === 'clone') {
    const src = s.cloneSource;
    // Another layer's point is honoured only when the Paint panel's Source
    // names that layer — otherwise it is a stale aim from a different target.
    const cross = !!src && src.nodeId !== d.nodeId && src.nodeId === s.cloneSourceLayerId;
    if (!src || (src.nodeId !== d.nodeId && !cross)) return refuse('Alt-click to set the clone source first.');
    const remembered = s.alignedOffset && s.alignedOffset.nodeId === d.nodeId ? s.alignedOffset : null;
    const { offset, remember } = cloneOffsetFor(s.cloneAligned, src, points[0]!, remembered);
    Object.assign(stroke, {
      cloneOffsetX: offset.x,
      cloneOffsetY: offset.y,
      cloneAligned: s.cloneAligned,
      ...(cross ? { cloneSourceId: src.nodeId } : {}),
      ...(s.cloneLockTime ? { cloneLockTime: true, cloneSourceTime: s.cloneSourceTime } : {}),
      ...(s.cloneTimeShift ? { cloneTimeShift: s.cloneTimeShift } : {}),
    });
    usePaintStore.getState().set({ alignedOffset: remember ? { nodeId: d.nodeId, x: remember.x, y: remember.y } : null });
  }

  // Write On: End keys (in %) that replay the drawing speed — at layer seconds, the axis of inPoint.
  const keys = s.duration === 'writeOn'
    ? writeOnEndKeys(points, d.times, layerT, fps).map((k) => ({ param: 'end', time: k.t, value: k.value }))
    : [];
  return { ok: true, label, strokeId: null, commands: [{ type: 'addPaintStroke', layer, stroke: JSON.stringify(stroke), keys }] };
}
