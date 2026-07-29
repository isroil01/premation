/**
 * BEHAVIOURS — presets that install an expression instead of keyframes.
 *
 * The distinction is not cosmetic. A keyframed preset says what happens at
 * fixed times: it has a fixed length, it ends, and it has to be retimed by hand
 * when the layer it lands on is a different length. A behaviour states a RULE —
 * "fade over the first and last fifteen percent", "drift continuously" — so it
 * adapts to the composition by itself and never runs out.
 *
 * That makes them disproportionately useful per line of code, because the
 * expression evaluator already exists and is already wired to real composition
 * metadata (`thisComp.duration/width/height/fps`, via the providers in
 * Providers.tsx). These are content on top of machinery that was already paid
 * for.
 *
 * ── What is available inside these expressions ──────────────────────
 *
 *   time            seconds, composition time
 *   value           the property's own value before the expression
 *   thisComp        width / height / duration / fps / numLayers  (real, wired)
 *   thisLayer       name / width / height
 *   wiggle(f, amp)  seeded per (node, property) — deterministic across runs
 *   audio           live amplitude, 0..1
 *   linear / ease / clamp / Math
 *
 * NOT available, and worth knowing before authoring more: `thisLayer` has no
 * `inPoint`/`outPoint`. AE's canonical "Fade In+Out" works against the layer's
 * own in and out points; ours works against the COMPOSITION duration, which is
 * the closest honest equivalent until layer timing is exposed to expressions.
 *
 * Every entry is a mechanism the keyframed library cannot express: a
 * duration-adaptive envelope, an unbounded constant velocity, seeded noise, a
 * parametric path, and live audio. None of them can be authored as keyframes.
 */

import type { AnimationPreset } from './animationPresets';

const FOLDER = 'Behaviors';

interface BehaviorSpec {
  name: string;
  description: string;
  expressions: Array<{ prop: string; expr: string }>;
}

const behavior = (s: BehaviorSpec): AnimationPreset => ({
  name: s.name,
  builtin: true,
  folder: FOLDER,
  category: FOLDER,
  description: s.description,
  requires: 'any',
  tracks: [],
  expressions: s.expressions,
});

export const BEHAVIOR_PRESETS: ReadonlyArray<AnimationPreset> = [
  behavior({
    name: 'Fade In+Out',
    description:
      'Fades up at the start and down at the end, sized to the composition — retime the comp and it still fits.',
    // The canonical behaviour, and the clearest demonstration of why the class
    // exists: no keyframed preset can do this, because it does not know how
    // long it is supposed to be until it is applied.
    expressions: [
      {
        prop: 'opacity',
        expr:
          'Math.min(' +
          'linear(time, 0, thisComp.duration * 0.15, 0, 100), ' +
          'linear(time, thisComp.duration * 0.85, thisComp.duration, 100, 0)' +
          ')',
      },
    ],
  }),

  behavior({
    name: 'Auto-Scroll',
    description: 'Travels at a constant speed forever — for credits, tickers and marquees.',
    // Unbounded constant velocity. A keyframed version has an end; this does
    // not, which is the entire point for a credit roll.
    expressions: [{ prop: 'y', expr: 'value - time * thisComp.height * 0.12' }],
  }),

  behavior({
    name: 'Drift',
    description: 'Slow continuous wander on both axes. Seeded, so it replays identically every time.',
    // `wiggle` is seeded per (node, property), so x and y wander independently
    // and the same layer produces the same motion on every render — which is
    // what makes it safe in the render path at all.
    expressions: [
      { prop: 'x', expr: 'wiggle(0.35, thisComp.width * 0.02)' },
      { prop: 'y', expr: 'wiggle(0.35, thisComp.height * 0.02)' },
    ],
  }),

  behavior({
    name: 'Pendulum',
    description: 'Endless pendulum rotation, like something hanging in a draught.',
    // Was a hand-written `applyFn` in the keyframed library ("Wind Sway"). Same
    // expression, now declared as data alongside every other behaviour instead
    // of being the one preset that needed code to apply itself.
    expressions: [{ prop: 'rotation', expr: 'value + Math.sin(time * 1.8) * 6' }],
  }),

  behavior({
    name: 'Orbit',
    description: 'Circles a point on a parametric path — no keyframes, no drift over time.',
    // A circle from keyframes is four keyframes and a visible polygon; from a
    // parametric path it is exact and endless.
    expressions: [
      { prop: 'x', expr: 'value + Math.cos(time * 1.2) * thisComp.width * 0.06' },
      { prop: 'y', expr: 'value + Math.sin(time * 1.2) * thisComp.width * 0.06' },
    ],
  }),

  behavior({
    name: 'Audio Throb',
    description: 'Scales with the live audio level. Impossible to keyframe — it depends on the soundtrack.',
    // The clearest case for behaviours: the value is not known at authoring
    // time, or at any time, until the audio is played.
    expressions: [{ prop: 'scale', expr: 'value * (1 + clamp(audio, 0, 1) * 0.35)' }],
  }),
];

export default BEHAVIOR_PRESETS;
