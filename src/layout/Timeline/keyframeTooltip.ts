/**
 * What a keyframe SAYS when you hover it or drag it.
 *
 *   hover:  0:00:01:04 · 34f · 320.5, 12 · eased in, linear out
 *   drag:   0:00:01:07  (+3f)      — time and how far it has travelled
 *           320.5, 12              — the value it holds
 *
 * The formatting is pure (`formatKeyframeLabel`, `keyframeDragLines`) so it is
 * testable; the one engine lookup (`keyframeValues`) is the only impure part
 * and is kept as small as a lookup can be. Values are read from the engine
 * rather than threaded through the model — a `TimelineKeyframeRef` is a
 * position, and adding the value to it would rebuild every row whenever a
 * value changed.
 */

import { defaultAnimation, expandKeyframeProp } from '@motion/animation';
import { parseUiKey } from './keyframeSelectionIds';
import { framesToTimecode } from '@core/time/timecode';

export interface KeyframeLabelInput {
  /** Comp seconds. */
  time: number;
  fps: number;
  startFrame?: number;
  /** Per-prop values in display order; empty when unknown. */
  values: ReadonlyArray<number>;
  unit?: string;
  ease?: string;
}

const fmtValue = (v: number): string => {
  const r = Math.round(v * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2).replace(/\.?0+$/, '');
};

export function formatValues(values: ReadonlyArray<number>, unit?: string): string {
  if (values.length === 0) return '';
  return values.map(fmtValue).join(', ') + (unit ? ` ${unit}` : '');
}

/** The hover line. */
export function formatKeyframeLabel(input: KeyframeLabelInput): string {
  const fps = input.fps > 0 ? input.fps : 30;
  const frame = Math.round(input.time * fps);
  const parts = [framesToTimecode(input.time, fps, input.startFrame ?? 0), `${frame}f`];
  const v = formatValues(input.values, input.unit);
  if (v) parts.push(v);
  if (input.ease) parts.push(input.ease);
  return parts.join(' · ');
}

/** The two-line drag read-out: where it is now and by how much, then the value. */
export function keyframeDragLines(input: {
  fromTime: number;
  toTime: number;
  fps: number;
  startFrame?: number;
  values: ReadonlyArray<number>;
  unit?: string;
}): string[] {
  const fps = input.fps > 0 ? input.fps : 30;
  const delta = Math.round((input.toTime - input.fromTime) * fps);
  const signed = `${delta > 0 ? '+' : ''}${delta}f`;
  const lines = [`${framesToTimecode(input.toTime, fps, input.startFrame ?? 0)}  (${signed})`];
  const v = formatValues(input.values, input.unit);
  if (v) lines.push(v);
  return lines;
}

/** The engine's values for a keyframe id, in the prop's display order. */
export function keyframeValues(kfId: string): number[] {
  const ref = parseUiKey(kfId);
  if (!ref) return [];
  const out: number[] = [];
  for (const prop of expandKeyframeProp(ref.prop)) {
    const kf = defaultAnimation.getTrackKeyframes(ref.nodeId, prop)?.find((k) => Math.abs(k.t - ref.t) < 1e-9);
    if (kf) out.push(kf.value);
  }
  return out;
}
