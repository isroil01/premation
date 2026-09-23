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

import { defaultAnimation, type Keyframe } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import { AUDIO_LEVEL_DB_PROP, MIN_LEVEL_DB, percentToDb } from './audioParams';
import { audioComponent, readAudioClipTimings, VIDEO_AUDIO_LEVEL_PROP } from './audioScene';
import { readNodeKind } from '@core/scene/sceneDerive';

/** Default fade length. Long enough to hear as a fade, short enough to be a
 *  starting point rather than a decision. */
export const DEFAULT_FADE_SEC = 1;

export type FadeSide = 'in' | 'out';

export interface AudibleSpan {
  startSec: number;
  endSec: number;
}

/**
 * The comp-time span over which this layer is audible.
 *
 * A SPLIT layer has several bars; the span runs from the first bar's head to
 * the last bar's tail, because "fade this layer in" means the moment it first
 * becomes audible, not the head of whichever bar happened to be first in the
 * array.
 */
export function audibleSpan(nodeId: string): AudibleSpan | null {
  const timings = readAudioClipTimings(nodeId);
  if (timings.length > 0) {
    let start = Infinity;
    let end = -Infinity;
    for (const t of timings) {
      const barEnd = t.startSec + (t.outSec - t.inSec);
      if (t.startSec < start) start = t.startSec;
      if (barEnd > end) end = barEnd;
    }
    if (end > start) return { startSec: start, endSec: end };
    return null;
  }
  // No bar: the component's own props are what the engine reads.
  const node = defaultSceneGraph.getNode(nodeId);
  const comp = node ? audioComponent(node) : undefined;
  if (!comp) return null;
  const p = comp.props as Record<string, unknown>;
  const num = (v: unknown, d: number): number => (typeof v === 'number' ? v : d);
  const start = num(p.__start, 0);
  const duration = num(p.__duration, 0);
  const inSec = num(p.__in, 0);
  const outSec = num(p.__out, duration);
  const end = start + (outSec - inSec);
  return end > start ? { startSec: start, endSec: end } : null;
}

/** The layer's level right now, in dB, honouring both legacy percent props. */
export function staticLevelDbOf(nodeId: string): number {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return 0;
  const kind = readNodeKind(node);
  const comp =
    kind === 'audio' ? audioComponent(node) : node.components.find((c) => c.type === 'Transform');
  const p = (comp?.props ?? {}) as Record<string, unknown>;
  if (typeof p[AUDIO_LEVEL_DB_PROP] === 'number') return p[AUDIO_LEVEL_DB_PROP] as number;
  const legacy = kind === 'audio' ? p.__level : p[VIDEO_AUDIO_LEVEL_PROP];
  if (typeof legacy === 'number') return percentToDb(legacy);
  return 0;
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

/**
 * A fade as DATA (B3z): its two keys at COMPOSITION seconds — the engine
 * converts to the layer's keyframe axis. Empty when there is nothing to fade
 * (no audible span, or a retime maps both ends onto one layer time). The
 * Audio panel sends these as a splice of `audio/levels` (keys inside the fade
 * window dropped, the rest kept — {@link mergeFade}'s rule).
 */
export function planFadeKeys(nodeId: string, side: FadeSide, durationSec = DEFAULT_FADE_SEC): Array<{ seconds: number; value: number }> {
  const span = audibleSpan(nodeId);
  if (!span) return [];
  const keys = planFade(span, side, durationSec, staticLevelDbOf(nodeId), (t) => t);
  if (keys.length !== 2) return [];
  const axis = (t: number): number => compToKeyframeTime(nodeId, t, AUDIO_LEVEL_DB_PROP);
  if (axis(keys[0]!.t) === axis(keys[1]!.t)) return [];
  return keys.map((k) => ({ seconds: k.t, value: k.value as number }));
}

/**
 * Apply a fade to one layer. Returns false when the layer has no audible span
 * (so the caller can skip opening a history entry for a no-op).
 *
 * The caller owns the undo entry: fading a multi-layer selection is ONE undo,
 * not one per layer.
 */
export function applyFade(nodeId: string, side: FadeSide, durationSec = DEFAULT_FADE_SEC): boolean {
  const span = audibleSpan(nodeId);
  if (!span) return false;
  const fade = planFade(span, side, durationSec, staticLevelDbOf(nodeId), (t) =>
    compToKeyframeTime(nodeId, t, AUDIO_LEVEL_DB_PROP),
  );
  if (fade.length === 0) return false;

  const track = defaultAnimation.tracksFor(nodeId).find((t) => t.prop === AUDIO_LEVEL_DB_PROP);
  const merged = mergeFade(track?.keyframes ?? [], fade);
  // An expression on the level would multiply against the fade and produce a
  // level matching neither — the rule ducking and the audio driver both follow.
  defaultAnimation.setExpression(nodeId, AUDIO_LEVEL_DB_PROP, '');
  defaultAnimation.setKeyframes(nodeId, AUDIO_LEVEL_DB_PROP, merged);
  return true;
}
