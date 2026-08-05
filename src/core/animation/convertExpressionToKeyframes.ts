/**
 * Convert Expression to Keyframes — AE's keyframe assistant.
 *
 * Samples an expression-driven property once per frame, writes the results as
 * an ordinary keyframe track, and DISABLES the expression rather than deleting
 * it. The motion becomes editable — drag a keyframe, retime a section, ease a
 * segment — and the formula stays on the property so the whole thing can be
 * put back with one toggle.
 *
 * ## The invariant
 *
 * **For every comp frame in the baked range, the property's value after the
 * bake equals its value before.** That is the claim, it is what the tests
 * assert, and it is stronger than "the keyframes look right": a bake whose
 * seeding differs from the live expression by a hair produces a `wiggle` that
 * is a completely different wiggle, and nothing in the picture says so.
 *
 * ## SAMPLE EVERYTHING FIRST, THEN WRITE
 *
 * The single thing this module has to get right, and the one that is invisible
 * once wrong. An expression can read its own property — `value + 200`,
 * `valueAtTime(t)`, `loopOut()` all do — and `value` is the KEYFRAMED base.
 * Writing keyframes as the walk proceeds therefore changes the input of every
 * later sample: with `value + 200` on a property whose base is 0, frame 0 bakes
 * 200, and if that is written before frame 1 is sampled, frame 1 reads a base
 * of 200 and bakes 400. The output compounds, smoothly and plausibly.
 *
 * So the plan is a pure function that returns keyframes and writes nothing, and
 * the caller applies it in one go. Same shape as `planExponentialScale`, for a
 * sharper reason.
 *
 * ## THE RANGE: the layer's extent, not the work area
 *
 * Both were available and they are not equivalent.
 *
 * The work area is a PREVIEW scope — the region B/N define for playback and
 * render. Baking it would make the result depend on a control the user very
 * likely set for an unrelated reason (previewing two seconds of a ten-second
 * layer), and, worse, it would silently change the frames OUTSIDE it: a
 * keyframe track clamps to its endpoints, so a property that used to wiggle for
 * ten seconds would wiggle for two and then hold. That is a change to frames
 * the user did not ask about, produced by a command whose whole promise is that
 * the picture does not move.
 *
 * The layer's extent is exactly the set of comp times where this property
 * affects anything, so baking it is the range for which "nothing changed" can
 * be true. It is also self-limiting: the keyframe count is bounded by the
 * layer's own length rather than by the composition's.
 *
 * A node with no clip bar has no extent; it falls back to the composition
 * duration, because such a node still renders (the time axis is the identity
 * for it) and a bake over an empty range would silently do nothing.
 *
 * ## THE TIME AXIS
 *
 * Keyframes are stored on the axis `compToKeyframeTime` produces — the only
 * axis the renderer samples (see the doc on `toLayerTime`, which is NOT it).
 * The walk is over COMP frames because that is what "one keyframe per frame"
 * means to a user looking at the timeline, and each frame's comp time is mapped
 * through `getRemappedTime` to get both the sample time and the stored time.
 *
 * Mapping rather than walking layer time directly matters on a retimed layer,
 * where the two axes are not related by a constant. It also means two comp
 * frames can map to ONE layer time (a hold, a freeze, a stretch below 100%), so
 * the plan de-duplicates by stored time — keeping the first, which is the
 * earliest comp frame that reaches it.
 */

import { defaultAnimation, type Keyframe } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { getTimelineController, getRemappedTime } from '@core/timeline/TimelineController';

/**
 * A comp-time span in seconds, HALF-OPEN: `[start, end)`.
 *
 * Half-open because a clip bar's `end` is one frame past its last live frame —
 * `Layer.isActiveAt` rejects it — so a closed range bakes one frame the layer
 * does not occupy. On an offset clip that frame falls outside every clip, the
 * time axis passes it through unmapped, and the keyframe lands a whole clip
 * offset away from where it belongs. Found by the offset-clip fixture: with a
 * bar at 0 the two axes are the identity and the extra frame is invisible.
 */
export interface BakeRange {
  start: number;
  end: number;
}

export type BakeRefusal = 'no-expression' | 'expression-disabled' | 'empty-range';

export const BAKE_REFUSAL_TEXT: Record<BakeRefusal, string> = {
  'no-expression': 'Convert Expression to Keyframes needs a property with an expression on it.',
  'expression-disabled':
    'That expression is disabled, so it is not driving the property — enable it first, or use its keyframes as they are.',
  'empty-range': 'Convert Expression to Keyframes needs a layer with some duration to bake across.',
};

/**
 * The comp-time span to bake for `nodeId`: its clip bars' extent, or the
 * composition duration when it has none.
 *
 * The UNION across clips, not the first bar: a split layer is one node with
 * several bars, and baking only the first would leave the rest of its life to
 * the clamped endpoint.
 */
export function bakeRangeFor(nodeId: string): BakeRange {
  const ctrl = getTimelineController();
  const fps = ctrl.fpsForNode(nodeId) || 30;
  const clips = ctrl.getLayersForNode(nodeId);
  if (clips.length === 0) {
    return { start: 0, end: ctrl.durationFramesForNode(nodeId) / fps };
  }
  let start = Infinity;
  let end = -Infinity;
  for (const c of clips) {
    start = Math.min(start, c.start / fps);
    end = Math.max(end, c.end / fps);
  }
  return { start, end };
}

/**
 * Sample `prop` once per frame across `range` and return the keyframes.
 *
 * PURE — reads the engine, writes nothing. See the module header: an expression
 * that reads its own property makes write-as-you-go compound.
 *
 * The loop is COUNTED rather than accumulated, so no value of `fps` can make it
 * fail to advance and no amount of walking accumulates float error (frame 600
 * is `600 · step`, not 600 additions of it). Rule 8a.
 */
export function planExpressionBake(
  nodeId: string,
  prop: string,
  range: BakeRange,
  fps: number,
): Keyframe[] {
  const step = 1 / Math.max(1, fps);
  const frames = Math.max(0, Math.round((range.end - range.start) / step));
  if (frames === 0) return [];

  const out: Keyframe[] = [];
  const seen = new Set<number>();
  // STRICT `<`: the range is half-open, so the last frame emitted is
  // `end - 1 frame`, which is the clip's last LIVE frame. `<=` would bake the
  // bar's exclusive end — a frame the layer does not occupy, which on an offset
  // clip is outside every bar and maps through the axis unchanged.
  for (let i = 0; i < frames; i++) {
    const compT = range.start + i * step;
    // Both the sample time AND the stored time — the engine samples on this
    // axis, so writing the value it returned at the time it was asked for is
    // what makes the round trip exact.
    const t = getRemappedTime(nodeId, compT);
    // Two comp frames can land on one layer time (hold, freeze, stretch < 100%).
    // Keep the first: it is the earliest comp frame that reaches it, which is
    // the same tie-break `keyframeToCompTime` uses inverting.
    if (seen.has(t)) continue;
    const value = defaultAnimation.sample(nodeId, prop, t);
    if (value === undefined || !Number.isFinite(value)) continue;
    seen.add(t);
    // Linear, because the samples ARE the curve: any easing between two
    // adjacent frames would bend a segment that already has a value at each end
    // and change the picture the bake promises to preserve.
    out.push({ t, value, easing: 'linear' });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * Props on `nodeId` that this command could bake: those carrying an ENABLED
 * expression.
 *
 * Exported so the command's `enabled()` and its `execute()` ask the SAME
 * question. Two predicates is the §2·0 shape and shows up as a command that
 * greys itself out for a property it would have handled, or the reverse.
 *
 * Disabled expressions are excluded on purpose rather than by oversight: the
 * property is already reading its keyframes, so there is nothing to bake and
 * the honest answer is a refusal that says why.
 */
export function eligibleExpressionProps(nodeId: string): string[] {
  return defaultAnimation
    .animatedProps(nodeId)
    .filter((prop) => defaultAnimation.isExpressionEnabled(nodeId, prop));
}

export interface BakeResult {
  /** Keyframes written, per prop. Empty when nothing happened. */
  written: Map<string, number>;
  /** Why nothing happened, when nothing did. */
  refusal: BakeRefusal | null;
}

/**
 * Bake `props` (default: every eligible prop on the layer) and disable their
 * expressions.
 *
 * ONE undo step for the whole operation, including the disable — `runAnimEdit`
 * captures a before/after pair around the entire mutation, so undo restores the
 * tracks AND re-enables the expressions together. Two commands would let a user
 * land between them, on a layer with baked keyframes and a live expression on
 * top of them, which renders as the expression alone and looks like the bake
 * did nothing.
 */
export function convertExpressionToKeyframes(nodeId: string, props?: readonly string[]): BakeResult {
  const targets = props ? [...props] : eligibleExpressionProps(nodeId);
  if (targets.length === 0) {
    // Say WHICH refusal — "nothing happened" is not an explanation.
    const anyExpression = defaultAnimation
      .animatedProps(nodeId)
      .some((p) => defaultAnimation.hasExpression(nodeId, p));
    return { written: new Map(), refusal: anyExpression ? 'expression-disabled' : 'no-expression' };
  }
  for (const prop of targets) {
    if (!defaultAnimation.hasExpression(nodeId, prop)) {
      return { written: new Map(), refusal: 'no-expression' };
    }
    if (!defaultAnimation.isExpressionEnabled(nodeId, prop)) {
      return { written: new Map(), refusal: 'expression-disabled' };
    }
  }

  const ctrl = getTimelineController();
  const fps = ctrl.fpsForNode(nodeId) || 30;
  const range = bakeRangeFor(nodeId);

  // PLAN FIRST, ALL OF IT. Interleaving plan and write would let one property's
  // new keyframes change what a later property's expression reads — `layer()`
  // and `thisLayer` make that reachable across props on the same node, not just
  // within one.
  const plans = new Map<string, Keyframe[]>();
  for (const prop of targets) {
    const kfs = planExpressionBake(nodeId, prop, range, fps);
    if (kfs.length > 0) plans.set(prop, kfs);
  }
  if (plans.size === 0) return { written: new Map(), refusal: 'empty-range' };

  const written = new Map<string, number>();
  runAnimEdit('Convert Expression to Keyframes', () => {
    defaultAnimation.batch(() => {
      for (const [prop, kfs] of plans) {
        defaultAnimation.setKeyframes(nodeId, prop, kfs);
        // Disabled, not removed: the formula stays for the user to re-enable,
        // which is the whole reason the enabled-state exists.
        defaultAnimation.setExpressionEnabled(nodeId, prop, false);
        written.set(prop, kfs.length);
      }
    });
  });
  return { written, refusal: null };
}
