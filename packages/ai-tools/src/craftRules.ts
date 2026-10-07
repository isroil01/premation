/**
 * The craft floor, stated once.
 *
 * Two prompts teach a model to author motion: the direct tool loop's
 * `SYSTEM_PROMPT` (src/core/ai/buildContext.ts) and author mode's system
 * prompt (`@motion/author` prompts.ts). They used to be one copy in the
 * first; a second hand-written copy in the second would drift the first
 * time either was tuned. So the rules live here and both interpolate them.
 *
 * Plain strings, no tool-specific syntax beyond names every mode shares.
 */

/** Timing, easing, stagger and distance — what separates competent from good. */
export const CRAFT_RULES = `CRAFT — this is what separates competent from good
- A property needs at least TWO keyframes at different times to animate. One keyframe holds a constant.
- Almost nothing should be linear. Use easeOut for things arriving, easeIn for things leaving, easeInOut for moves between two rests. Reserve linear for continuous motion (rotation, drifting).
- Overshoot reads as life: easing "bezier" with [0.34, 1.56, 0.64, 1] gives a confident pop. Understated beats bouncy.
- Stagger. When several things enter together, offset each by ~0.06-0.12s. Simultaneous entrances look mechanical.
- Typical durations: a fade 0.3-0.5s, an entrance 0.4-0.8s, an emphasis pulse 0.2-0.3s. Multi-second moves feel broken unless asked for.
- Move a short distance. 20-60px of travel on an entrance reads better than 400px.
- Animate opacity AND a transform together. Opacity alone looks flat.
- Respect the composition duration — never author past it.`;

/** The failure modes past runs shipped, each phrased as a prohibition. */
export const NEVER_RULES = `NEVER DO THESE (they are why past attempts looked amateur)
- NEVER leave layers stacked on the same spot. Give EVERY layer an explicit x,y so the composition is laid out deliberately — a title high, a subtitle below it, elements spaced apart. Two things at the same position is a bug, not a design.
- NEVER let everything appear at the same instant. Every element that enters MUST have its own entrance keyframes (opacity 0→100 paired with a transform), and their START times MUST be staggered by ~0.06–0.15s. If five things appear together with no offset, you have failed.
- NEVER leave an element at full opacity from frame 0 when it is supposed to animate in — its first opacity keyframe must be 0 at its start time. A layer with no entrance keyframes is just on-screen the whole time.
- For a camera move to read as 3D (not a flat zoom), the content layers must be in 3D at different depths: call update_layer { threeD: true } on each, give them distinct z (e.g. background z≈300, subject z≈0, foreground z≈-200), THEN create and animate the camera. A camera over flat 2D layers does nothing worth doing.
- After you render and review, if the frames show overlap, empty space, or things appearing together — fix it. That is the whole point of looking.`;
