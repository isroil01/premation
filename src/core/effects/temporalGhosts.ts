/**
 * Temporal ghosts — the shared shape behind every effect that draws the layer
 * at OTHER points in time.
 *
 * Echo and Wide Time differ only in which times they pick and how bright each
 * copy is. The emission itself — resample the transform at t+dt, rebuild the
 * 3D matrix, strip the matte/motion-blur/adjustment flags, composite — is
 * identical, and it is forty lines of subtle code inside `buildSnapshot`. This
 * module is the part that differs, so the part that does not can stay written
 * once. `CompositionPass` already paid for the alternative: two copies of the
 * layer-effects chain, one of which silently erased any effect type it did not
 * know (see gotcha-motion-two-effect-chains).
 *
 * Everything here is a pure function of the animation and the clock — no frame
 * history — which is what keeps these effects scrub-stable and cacheable. That
 * is also the ceiling: AE's Time Displacement, Time Difference and Pixel Motion
 * Blur read previously RENDERED frames and cannot be expressed this way.
 */

import type { Effect } from './effects';
import { effectNumber } from './effects';
import { readEchoConfig, type EchoOperator } from './echo';

/** One ghost copy: how far from now, and how strongly it draws. */
export interface GhostStep {
  /** Seconds relative to the current frame. Negative = into the past. */
  dt: number;
  /** Opacity multiplier applied on top of the layer's own, 0..1. */
  opacity: number;
}

export interface GhostSpec {
  steps: GhostStep[];
  /** Blend mode the copies composite with. */
  blend: EchoOperator;
  /** True when the copies draw OVER the current frame. */
  inFront: boolean;
}

/** Ghosts too faint to see cost a full layer draw each. */
const MIN_VISIBLE = 0.002;

/**
 * Wide Time — AE's CC Wide Time: copies from BOTH directions, evenly weighted,
 * which reads as a temporal smear rather than as a trailing wake.
 *
 * Steps are whole frames because that is the unit AE's controls are in, so this
 * needs the comp's frame rate. Weighting is `1/(total + 1)` — the current frame
 * counts as one of the copies, so a 2-forward/2-back setting averages five
 * moments rather than blowing out to 5× brightness.
 */
function readWideTime(e: Effect, fps: number): GhostSpec | null {
  const fwd = Math.max(0, Math.min(64, Math.round(effectNumber(e, 'forwardSteps'))));
  const back = Math.max(0, Math.min(64, Math.round(effectNumber(e, 'backwardSteps'))));
  if (fwd + back === 0 || fps <= 0) return null;
  const weight = 1 / (fwd + back + 1);
  const steps: GhostStep[] = [];
  for (let k = 1; k <= back; k++) steps.push({ dt: -k / fps, opacity: weight });
  for (let k = 1; k <= fwd; k++) steps.push({ dt: k / fps, opacity: weight });
  // `normal` and behind: this is an average of moments, and adding them would
  // make a static layer brighter than it is.
  return { steps, blend: 'normal', inFront: false };
}

/** Echo's steps: a decaying run in ONE direction, the sign of `time`. */
function echoSteps(cfg: NonNullable<ReturnType<typeof readEchoConfig>>): GhostStep[] {
  const steps: GhostStep[] = [];
  for (let k = 1; k <= cfg.count; k++) {
    steps.push({ dt: k * cfg.time, opacity: cfg.startIntensity * Math.pow(cfg.decay, k - 1) });
  }
  return steps;
}

/**
 * The ghost copies this layer's effect stack asks for, or null for none.
 *
 * Echo wins when a layer carries both. They are the same mechanism pointed at
 * different times, and compounding them would emit `echo.count × wide.steps`
 * layers — a combinatorial cost from a stack the user would read as "two
 * effects", plus a picture neither effect describes.
 *
 * Ordered farthest-first, so nearer copies paint over more distant ones and the
 * current frame lands on top of all of them.
 */
export function readGhostSpec(effects: ReadonlyArray<Effect>, fps: number): GhostSpec | null {
  const echo = readEchoConfig(effects);
  if (echo && echo.count > 0 && echo.time !== 0) {
    return { steps: order(echoSteps(echo)), blend: echo.operator, inFront: echo.echoesInFront };
  }
  const wide = effects.find((x) => x.type === 'wide-time' && x.enabled !== false);
  if (wide) {
    const spec = readWideTime(wide, fps);
    if (spec) return { ...spec, steps: order(spec.steps) };
  }
  return null;
}

function order(steps: GhostStep[]): GhostStep[] {
  return steps
    .filter((s) => s.opacity > MIN_VISIBLE)
    .sort((a, b) => Math.abs(b.dt) - Math.abs(a.dt));
}
