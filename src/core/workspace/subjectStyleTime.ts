/**
 * A subject style shown over PART of the shot (an outline from 2 s to 5 s,
 * a glow that fades in on the beat) — as After Effects does it: keyframes on
 * the effect's own Effect Opacity (`effects/<id>/compositing/opacity`), so
 * the span is ordinary keys the user can see, move and ease in the timeline.
 *
 *   no fade   hold keys: 0 the frame before `start`, 100 at `start`, 0 the
 *             frame after `end` — the style is on from the first frame of
 *             the span through its last, exactly
 *   fade      linear keys: 0 at start − fade, 100 at start and at end, 0 at
 *             end + fade — fully on over the span, ramping either side
 *
 * readStyleSpan reads the span back from keys of that shape (a key the user
 * moved still reads; keys of any other shape answer null — the panel then
 * shows "Custom (keyframed)" and leaves them alone).
 */

import { flicksToSeconds, secondsToFlicks, type Keyframe } from '@motion/engine-api';

/** Composition seconds; `fade` seconds either side (0 = a hard cut). */
export interface StyleSpan {
  start: number;
  end: number;
  fade: number;
}

/** The effect property the span is keyed on. */
export function styleOpacityPath(effectId: string): string {
  return `effects/${effectId}/compositing/opacity`;
}

function key(time: number, value: number, easing: Keyframe['easing']): Keyframe {
  return {
    id: '',
    time: secondsToFlicks(time),
    value: { kind: 'scalar', value },
    easing,
    continuous: false,
    roving: false,
    spatialInterp: 'legacy',
    spatialIn: [],
    spatialOut: [],
    label: 0,
    dims: [],
  };
}

/**
 * The keys that show the style over `span` (frames at `fps`). `start` and
 * `end` are snapped to whole frames; an end before the start is the start.
 * Times before 0 are dropped (the style is simply on from the first frame).
 */
export function styleSpanKeys(span: StyleSpan, fps: number): Keyframe[] {
  const f = 1 / Math.max(1, fps);
  const snap = (t: number): number => Math.round(t / f) * f;
  const start = Math.max(0, snap(span.start));
  const end = Math.max(start, snap(span.end));
  const fade = Math.max(0, snap(span.fade));
  const keys: Keyframe[] = [];
  if (fade <= 0) {
    if (start - f >= -1e-9) keys.push(key(start - f, 0, 'hold'));
    keys.push(key(start, 100, 'hold'));
    keys.push(key(end + f, 0, 'hold'));
  } else {
    if (start - fade >= -1e-9) keys.push(key(start - fade, 0, 'linear'));
    keys.push(key(start, 100, 'linear'));
    if (end > start) keys.push(key(end, 100, 'linear'));
    keys.push(key(end + fade, 0, 'linear'));
  }
  // Distinct times (a 0-second span at frame 0 with no fade could repeat one).
  return keys.filter((k, i) => i === 0 || k.time !== keys[i - 1]!.time);
}

const scalar = (k: Keyframe): number | null => (k.value.kind === 'scalar' ? (k.value.value as number) : null);

/** The span keys of styleSpanKeys' shape describe, or null for any other keys (or none). */
export function readStyleSpan(keys: readonly Keyframe[], fps: number): StyleSpan | null {
  if (keys.length < 2) return null;
  const f = 1 / Math.max(1, fps);
  const pts = keys.map((k) => ({ t: flicksToSeconds(k.time), v: scalar(k), e: k.easing }));
  if (pts.some((p) => p.v !== 0 && p.v !== 100)) return null;
  const on = pts.filter((p) => p.v === 100);
  if (on.length === 0 || on.length > 2) return null;
  const first = on[0]!;
  const last = on[on.length - 1]!;
  const after = pts[pts.indexOf(last) + 1];
  if (!after || after.v !== 0 || pts.indexOf(last) + 2 !== pts.length) return null;
  const before = pts.indexOf(first) > 0 ? pts[pts.indexOf(first) - 1]! : null;
  if (pts.indexOf(first) > 1 || (before && before.v !== 0)) return null;
  if (first.e === 'hold') {
    if (on.length !== 1) return null;
    return { start: first.t, end: after.t - f, fade: 0 };
  }
  const fadeOut = after.t - last.t;
  const fadeIn = before ? first.t - before.t : fadeOut;
  return { start: first.t, end: last.t, fade: Math.max(0, Math.min(fadeIn, fadeOut)) };
}
