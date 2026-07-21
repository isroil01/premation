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
}

/** Read the (enabled) Echo effect's config off a resolved effect stack, or null
 *  when the layer has no Echo. */
export function readEchoConfig(effects: ReadonlyArray<Effect>): EchoConfig | null {
  const e = effects.find((x) => x.type === 'echo' && x.enabled !== false);
  if (!e) return null;
  return {
    time: effectNumber(e, 'echoTime'),
    count: Math.max(0, Math.min(64, Math.round(effectNumber(e, 'numEchoes')))),
    startIntensity: clamp01(effectNumber(e, 'startIntensity') / 100),
    decay: clamp01(effectNumber(e, 'decay') / 100),
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
