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
 * The same property has a consequence worth stating rather than discovering:
 * RE-ENABLING a `value`-reading expression after a bake does not restore the
 * original motion, it COMPOUNDS — the expression now reads the baked track
 * where it used to read the static value. The invariant above is about the
 * DISABLED state and holds exactly; undo, not the toggle, is what puts things
 * back, which is why the command is a single undo step.
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

export interface BakeResult {
  /** Keyframes written, per prop. Empty when nothing happened. */
  written: Map<string, number>;
  /** Why nothing happened, when nothing did. */
  refusal: BakeRefusal | null;
}
