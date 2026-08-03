/**
 * Time-scaling a keyframe selection — AE's Alt-drag on the first or last
 * keyframe of a multi-selection, which stretches or compresses the whole group
 * about its opposite end instead of sliding it.
 *
 * The timeline could already MOVE a selection; retiming one meant dragging each
 * keyframe individually and rebuilding the spacing by hand. `stretchTracks` in
 * keyframeAssistants does this for a whole layer, but there was nothing that
 * operated on the selected subset — which is the case that actually comes up
 * (tighten this one gesture, leave the rest of the animation alone).
 *
 * Pure and separately tested: the drag handler in Timeline.tsx is already long,
 * and a scale that silently reorders keyframes looks exactly like a scale that
 * doesn't until you inspect the times.
 */

/** Which end of the selection is being dragged, or null when it isn't an end. */
export type ScaleGrip = 'start' | 'end';

export interface SelectionSpan {
  min: number;
  max: number;
}

/** First/last time across a selection, or null when the selection is empty. */
export function selectionSpan(times: ReadonlyMap<string, number>): SelectionSpan | null {
  let min = Infinity;
  let max = -Infinity;
  for (const t of times.values()) {
    if (t < min) min = t;
    if (t > max) max = t;
  }
  return Number.isFinite(min) ? { min, max } : null;
}

/**
 * Whether `grabbedId` is an end of the selection, and which one.
 *
 * Returns null for an interior keyframe, for a selection of one, and for a
 * selection whose keyframes all sit at the same time — none of those has a
 * span to scale, and pretending otherwise would divide by zero.
 *
 * A tie at an end counts: several keyframes stacked on the first frame are all
 * legitimately "the start", and scaling anchors on the far end regardless.
 */
export function scaleGrip(times: ReadonlyMap<string, number>, grabbedId: string): ScaleGrip | null {
  if (times.size < 2) return null;
  const span = selectionSpan(times);
  if (!span || span.max === span.min) return null;
  const t = times.get(grabbedId);
  if (t === undefined) return null;
  if (t === span.max) return 'end';
  if (t === span.min) return 'start';
  return null;
}

/**
 * Scale a selection about the end opposite the one being dragged.
 *
 * `dtSec` is the pointer delta applied to the grabbed end. The factor is
 * clamped at zero so the moving end can collapse onto the anchor but never
 * cross it: allowing a negative factor would reverse the keyframe order
 * mid-drag, which renders as a plausible-looking animation played backwards
 * and is very hard to attribute afterwards.
 *
 * `minSpan` floors how far the selection can be squeezed. The caller passes one
 * frame: keyframes are committed one at a time, so a selection crushed to a
 * single instant would land several keyframes on the same time and the engine
 * would keep only the last — a drag that silently DELETES keyframes. A one-frame
 * floor keeps every keyframe addressable and still feels unbounded.
 */
export function scaleSelection(
  times: ReadonlyMap<string, number>,
  grabbedId: string,
  dtSec: number,
  minSpan = 0,
): Map<string, number> | null {
  const grip = scaleGrip(times, grabbedId);
  if (!grip) return null;
  const span = selectionSpan(times)!;
  const anchor = grip === 'end' ? span.min : span.max;
  const grabbed = grip === 'end' ? span.max : span.min;
  const width = Math.abs(grabbed - anchor);
  const floor = width > 0 ? Math.max(0, Math.min(1, minSpan / width)) : 0;
  const factor = Math.max(floor, (grabbed + dtSec - anchor) / (grabbed - anchor));

  const out = new Map<string, number>();
  for (const [id, t] of times) {
    // Times are clamped at 0 for the same reason the translate path clamps:
    // negative keyframe times are not addressable on the timeline.
    out.set(id, Math.max(0, anchor + (t - anchor) * factor));
  }
  // The anchor must not drift. Floating-point scaling about a non-zero anchor
  // can nudge it by an ulp, and a "fixed" end that moves by a hair is the kind
  // of thing that only shows up as an off-by-one-frame much later.
  for (const [id, t] of times) if (t === anchor) out.set(id, anchor);
  return out;
}
