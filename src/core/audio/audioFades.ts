/**
 * Fade In / Fade Out on a layer's sound.
 *
 * The gesture every editor reaches for first, and the one thing the level track
 * could not do without hand-placing two keyframes and remembering that silence
 * is −60 dB, not 0. It writes ordinary `audioLevelDb` keyframes — not a private
 * fade property — so a fade is editable in the graph editor afterwards, survives
 * export through the same ramp builder as everything else, and composes with
 * ducking rather than fighting it.
 *
 * ## Where the fade is anchored
 *
 * At the CLIP, not at the composition. A layer's audible span is its timeline
 * bar (see `audioScene`), so "fade in" means "from where this bar starts",
 * which is the only reading that stays correct after the bar is slid. A layer
 * with no bar — audio nested in a plain group — falls back to the component's
 * own start/out props, which is what the engine reads for it too.
 *
 * ## Why the existing level is preserved
 *
 * The fade ends at whatever the layer is already set to, not at 0 dB. A music
 * bed trimmed to −8 dB that faded up to unity would jump 8 dB at the end of its
 * own fade — audible, and exactly the kind of bug that only shows up on export.
 */

import {  type Keyframe } from '@motion/animation';
import {  MIN_LEVEL_DB } from './audioParams';

/** Default fade length. Long enough to hear as a fade, short enough to be a
 *  starting point rather than a decision. */
export const DEFAULT_FADE_SEC = 1;

export type FadeSide = 'in' | 'out';

export interface AudibleSpan {
  startSec: number;
  endSec: number;
}

/**
 * The two keyframes a fade adds, on the layer's own keyframe axis.
 *
 * Pure, so the geometry is testable without a scene: the interesting cases are
 * a fade longer than the clip and a clip with no length at all, and neither is
 * pleasant to reproduce by hand.
 */
export function planFade(
  span: AudibleSpan,
  side: FadeSide,
  durationSec: number,
  levelDb: number,
  toKeyframeTime: (compSec: number) => number,
): Keyframe[] {
  const spanLen = span.endSec - span.startSec;
  if (!(spanLen > 0)) return [];
  // A fade cannot be longer than the sound it is fading. Clamping rather than
  // refusing: dropping a 5 s fade on a 2 s clip should give a 2 s fade, which
  // is obviously what was meant.
  const d = Math.min(Math.max(0, durationSec), spanLen);
  if (!(d > 0)) return [];

  const [silentAt, fullAt] =
    side === 'in'
      ? [span.startSec, span.startSec + d]
      : [span.endSec, span.endSec - d];

  const silent = { t: toKeyframeTime(silentAt), value: MIN_LEVEL_DB, easing: 'linear' as const };
  const full = { t: toKeyframeTime(fullAt), value: levelDb, easing: 'linear' as const };
  // A retimed layer can map two distinct comp times onto one layer time (a
  // freeze). Two keyframes at one time is not a fade, it is a step.
  if (silent.t === full.t) return [];
  return side === 'in' ? [silent, full] : [full, silent];
}

/**
 * Merge a fade into whatever level track the layer already has.
 *
 * Existing keyframes INSIDE the fade window are dropped — they described the
 * level over exactly the stretch the fade is now describing, and keeping them
 * would leave the fade fighting them. Keyframes outside are untouched, so
 * fading in a layer that was already ducked keeps the duck.
 */
export function mergeFade(existing: readonly Keyframe[], fade: readonly Keyframe[]): Keyframe[] {
  if (fade.length === 0) return [...existing];
  const lo = Math.min(...fade.map((k) => k.t));
  const hi = Math.max(...fade.map((k) => k.t));
  const kept = existing.filter((k) => k.t < lo || k.t > hi);
  return [...kept, ...fade].sort((a, b) => a.t - b.t);
}
