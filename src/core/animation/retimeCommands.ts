/**
 * Retime, as edits: switch a layer between Normal / Speed % / Frame Number,
 * shape a speed curve, apply a velocity preset, fit the footage.
 *
 * The maths lives in `retime.ts` (the integral) and `speedRamp.ts` (the exact
 * Bézier for a linear speed change). This file decides what a person means:
 *
 *   - SWITCHING MODES CONVERTS, it does not discard. Speed → Frames bakes the
 *     integral into remap keys (exact Béziers for linear and hold segments,
 *     subdivided for eased ones); Frames → Speed turns each remap segment's
 *     average slope into a hold speed, which lands on every remap key exactly.
 *     Both are one undo step.
 *   - PRESETS span the clip's bar, because a velocity edit is a shape across a
 *     clip, not a value at the playhead.
 *   - SLOWING TURNS ON PIXEL MOTION when blending was off — the same rule the
 *     one-click ramps follow, for the same reason (see `speedRampCommands.ts`).
 *
 * Everything reads the clip bar the way the renderer does: the earliest bar is
 * the in-point, and keyframe times go through `compToKeyframeTime`.
 */

import {  type EasingKind } from '@motion/animation';
import {
  clampSpeedPercent,
  type RetimeClip,
  type RetimeMode,
} from './retime';

// ── The bar ────────────────────────────────────────────────────────────────

export interface RetimeBarInfo {
  /** Comp fps the bar is measured in. */
  fps: number;
  /** Comp seconds of the in-point and out-point (end exclusive). */
  inSec: number;
  outSec: number;
  /** The earliest bar's clip map. */
  clip: RetimeClip;
  /** Source seconds shown at the in-point. */
  sourceInSec: number;
  /** Source seconds available in the file, when known. */
  sourceDurationSec: number | null;
  /** The footage's own frame rate (falls back to the comp's). */
  sourceFps: number;
}

// ── Speed curve edits ──────────────────────────────────────────────────────

export type RampStyle = 'smooth' | 'linear' | 'instant';

export const RAMP_STYLE_EASING: Readonly<Record<RampStyle, EasingKind>> = {
  smooth: 'easeInOut',
  linear: 'linear',
  instant: 'step',
};

export function rampStyleOf(easing: EasingKind | undefined): RampStyle {
  if (easing === 'step' || easing === 'hold') return 'instant';
  if (easing === 'linear' || easing === undefined) return 'linear';
  return 'smooth';
}

// ── Presets ────────────────────────────────────────────────────────────────

export interface SpeedPreset {
  id: string;
  label: string;
  hint: string;
  /** [position across the bar 0..1, speed %, ramp]. */
  points: ReadonlyArray<readonly [number, number, RampStyle]>;
}

export const SPEED_PRESETS: ReadonlyArray<SpeedPreset> = [
  {
    id: 'velocity', label: 'Velocity', hint: 'Fast, a slow-motion hit in the middle, fast again',
    points: [[0, 250, 'smooth'], [0.36, 250, 'smooth'], [0.48, 20, 'smooth'], [0.66, 20, 'smooth'], [0.78, 250, 'smooth'], [1, 250, 'smooth']],
  },
  {
    id: 'hero', label: 'Hero', hint: 'Normal, then a long dramatic slow-motion moment',
    points: [[0, 100, 'smooth'], [0.28, 100, 'smooth'], [0.4, 15, 'smooth'], [0.74, 15, 'smooth'], [0.86, 100, 'smooth'], [1, 100, 'smooth']],
  },
  {
    id: 'bullet', label: 'Bullet', hint: 'Very fast into a near-freeze and out again',
    points: [[0, 300, 'smooth'], [0.34, 300, 'smooth'], [0.44, 8, 'smooth'], [0.6, 8, 'smooth'], [0.7, 300, 'smooth'], [1, 300, 'smooth']],
  },
  {
    id: 'montage', label: 'Montage', hint: 'Pulses between fast and slow',
    points: [[0, 100, 'smooth'], [0.2, 250, 'smooth'], [0.4, 40, 'smooth'], [0.6, 250, 'smooth'], [0.8, 40, 'smooth'], [1, 100, 'smooth']],
  },
  {
    id: 'flashIn', label: 'Flash In', hint: 'Rush in fast, settle to normal',
    points: [[0, 500, 'smooth'], [0.35, 100, 'smooth'], [1, 100, 'smooth']],
  },
  {
    id: 'flashOut', label: 'Flash Out', hint: 'Normal, then rush out fast',
    points: [[0, 100, 'smooth'], [0.65, 100, 'smooth'], [1, 500, 'smooth']],
  },
  {
    id: 'jumpCut', label: 'Jump Cut', hint: 'Hard cuts between normal and 4× — no ramps',
    points: [[0, 100, 'instant'], [0.3, 400, 'instant'], [0.55, 100, 'instant'], [0.8, 400, 'instant'], [1, 100, 'instant']],
  },
];

// ── Footage budget ─────────────────────────────────────────────────────────

export interface RetimeSummary {
  mode: RetimeMode;
  /** Source seconds the bar plays through. */
  usedSec: number;
  /** Source seconds after the in-point, when the file length is known. */
  availableSec: number | null;
  /** Comp time where the footage runs out (or before the head), when it does. */
  runsOutAtSec: number | null;
  /** Output (bar) seconds. */
  outputSec: number;
}

/** A speed key's value after Fit to Footage's scaling (clamped, 0.1 % steps). */
export function fittedSpeed(value: number, factor: number): number {
  return Math.round(clampSpeedPercent(value * factor) * 10) / 10;
}
