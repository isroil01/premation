/**
 * The one place that knows how to write a transform property.
 *
 * ── THE AE KEYFRAMING CONTRACT ──────────────────────────────────────────────
 * A property with a lit stopwatch (an existing track) ALWAYS keyframes on
 * direct manipulation. The global Auto-Keyframe mode only decides whether
 * *un-animated* properties start recording.
 *
 * This is not a style preference, it is a correctness requirement: the renderer
 * reads animated values FIRST (`av.get(prop) ?? transform.prop`), so writing a
 * static value to a tracked property is silently discarded. The edit appears to
 * work — the store changes — and nothing moves on screen.
 *
 * ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────
 * The contract was implemented correctly in exactly one place, `workspace/ports`,
 * for canvas drags and the 3D gizmo — and `hasAnyTrack` was a private function
 * there, so nothing else could reuse it. Three user-facing features wrote
 * transform props directly and therefore broke on any animated layer:
 *
 *   • Anchor point       pan-behind compensated `x`/`y` with `writeProp`, so on
 *                        a layer with animated Position the compensation was
 *                        discarded and the layer JUMPED by the compensation
 *                        amount. Reproduced: anchorX 1 → 11 left Position X at
 *                        961 instead of 971.
 *   • Align & Distribute wrote `x`/`y` directly — aligning an animated layer
 *                        did nothing visible.
 *   • Fit to Comp / Fill / Native Size — same, for size and position.
 *
 * In a motion-design tool an animated layer is the NORMAL case, so all three
 * were broken most of the time. Route every transform write through here.
 */

export interface TransformWrite {
  prop: string;
  value: number;
}
