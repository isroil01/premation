/**
 * Force Motion Blur — AE's CC Force Motion Blur.
 *
 * Motion blur normally needs THREE things to be true: the composition's motion
 * blur is on, the layer's own motion-blur switch is on, and the layer actually
 * moves. This effect is the override for the first two, which is what "force"
 * means in its name — you want this one layer blurred without turning the comp
 * switch on for everything, or you want a heavier shutter on one element than
 * the comp uses.
 *
 * It deliberately does NOT override the third. `moves()` asks whether any
 * transform channel is animated, and sampling a layer that does not move
 * returns the same transform at every sub-time — an identical image for N times
 * the cost. Forcing blur there would be a control that visibly does nothing
 * while making the frame slower, which is the worst of both.
 *
 * The samples themselves come from `sampleMotion`, unchanged: this only decides
 * WHETHER it runs and with WHAT shutter, so there is no second motion-blur
 * implementation to drift from the first.
 */

import type { Effect } from './effects';
import { effectNumber } from './effects';

/** The subset of MotionBlurConfig an effect is allowed to override. */
export interface ForcedMotionBlur {
  /** Degrees of shutter, AE's 0..720. */
  shutterAngle: number;
  /** Sub-frame samples across that shutter. */
  samples: number;
}

/**
 * The forced shutter for this layer, or null when the effect is absent or
 * disabled — in which case the comp's own settings and switches decide, exactly
 * as before this effect existed.
 */
export function readForceMotionBlur(effects: ReadonlyArray<Effect>): ForcedMotionBlur | null {
  const e = effects.find((x) => x.type === 'force-motion-blur' && x.enabled !== false);
  if (!e) return null;
  // Clamped to the same ranges the composition's own motion blur accepts, so a
  // forced layer cannot ask the sampler for something the comp could not.
  const shutterAngle = Math.max(0, Math.min(720, effectNumber(e, 'shutterAngle')));
  const samples = Math.max(2, Math.min(32, Math.round(effectNumber(e, 'samples'))));
  // A zero-degree shutter is an open-for-no-time camera: no blur, and sampling
  // it would produce N copies of one instant.
  if (shutterAngle <= 0) return null;
  return { shutterAngle, samples };
}
