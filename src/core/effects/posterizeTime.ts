/**
 * Posterize Time — quantize a layer's clock to a lower frame rate.
 *
 * Like Echo, this is NOT a pixel pass: it changes WHEN the layer is sampled,
 * which is why it lives beside the time plumbing in buildSnapshot rather than
 * in the effect chain. Sampling time is the right lever because it makes the
 * layer's transform, masks, paths and effect parameters all step together — a
 * pixel pass could only stutter the picture, leaving the motion smooth
 * underneath, which is not the look.
 *
 * This module is just the config reader; the quantization lives next to the
 * clip/stretch/precomp remapping it composes with.
 */

import type { Effect } from './effects';
import { effectNumber } from './effects';

/**
 * The posterized frame rate for a layer's effect stack, or null when it has no
 * (enabled) Posterize Time. Rates below 1 fps are ignored rather than clamped —
 * they would freeze the layer entirely, which the Freeze control already does
 * and says so.
 */
export function readPosterizeTimeFps(effects: ReadonlyArray<Effect>): number | null {
  const e = effects.find((x) => x.type === 'posterize-time' && x.enabled !== false);
  if (!e) return null;
  const fps = effectNumber(e, 'frameRate');
  return Number.isFinite(fps) && fps >= 1 ? fps : null;
}
