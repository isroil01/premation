/**
 * Echo — AE's temporal Echo effect. Unlike every other effect it is NOT a
 * per-layer pixel pass: it composites the layer at several points in time, so it
 * is resolved in `buildSnapshot` by emitting decaying ghost copies at past
 * (or future) sampled transforms. That makes it deterministic and scrub-stable
 * (a pure function of the animation — no frame cache), and it renders on BOTH
 * backends for free, since the ghosts are ordinary render layers.
 *
 * This module is just the pure config reader; the emission lives in buildSnapshot
 * next to the motion-blur / repeater sampling it reuses.
 */

import type { Effect } from './effects';
import { effectNumber } from './effects';
import { clamp01 } from '@utils/lang';

/**
 * How the echo copies combine — AE's Echo Operator.
 *
 * The ghosts are ordinary render layers, so an operator is just the blend mode
 * they carry. `inFront` is the one bit that is NOT a blend mode: Composite In
 * Back and In Front are both `normal` and differ only in whether the ghosts
 * draw under or over the current frame.
 */
export type EchoOperator = 'add' | 'lighten' | 'darken' | 'screen' | 'normal';

/** Menu order must match the `echoOperator` options in `EFFECT_DEFS`. */
const ECHO_OPERATORS: ReadonlyArray<{ blend: EchoOperator; inFront: boolean }> = [
  { blend: 'add', inFront: false },      // 0 Add (AE default)
  { blend: 'lighten', inFront: false },  // 1 Maximum
  { blend: 'darken', inFront: false },   // 2 Minimum
  { blend: 'screen', inFront: false },   // 3 Screen
  { blend: 'normal', inFront: false },   // 4 Composite In Back
  { blend: 'normal', inFront: true },    // 5 Composite In Front
];

export interface EchoConfig {
  /** Seconds between echoes. Negative (default) = a trailing wake into the past;
   *  positive = an anticipatory lead into the future. */
  time: number;
  /** Number of echo copies (beyond the current frame). */
  count: number;
  /** Opacity multiplier of the first echo, 0..1 (AE Starting Intensity /100). */
  startIntensity: number;
  /** Per-echo opacity falloff, 0..1 (AE Decay /100). */
  decay: number;
  /** Blend mode the ghost copies composite with. */
  operator: EchoOperator;
  /** True when the ghosts draw OVER the current frame (Composite In Front). */
  echoesInFront: boolean;
}

/** Read the (enabled) Echo effect's config off a resolved effect stack, or null
 *  when the layer has no Echo. */
export function readEchoConfig(effects: ReadonlyArray<Effect>): EchoConfig | null {
  const e = effects.find((x) => x.type === 'echo' && x.enabled !== false);
  if (!e) return null;
  // Falls back to Add (AE's default) for a value naming no operator, rather
  // than to index 0 by clamping — a project written by a build with more
  // operators must not silently become a different one.
  const op = ECHO_OPERATORS[Math.round(effectNumber(e, 'echoOperator'))] ?? ECHO_OPERATORS[0]!;
  return {
    time: effectNumber(e, 'echoTime'),
    count: Math.max(0, Math.min(64, Math.round(effectNumber(e, 'numEchoes')))),
    startIntensity: clamp01(effectNumber(e, 'startIntensity') / 100),
    decay: clamp01(effectNumber(e, 'decay') / 100),
    operator: op.blend,
    echoesInFront: op.inFront,
  };
}

