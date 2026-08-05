/**
 * Motion Sketch — draw a layer's position in real time, keep it as keyframes.
 *
 * AE's assistant: arm it, then drag the layer while the comp plays. The path
 * you draw becomes the layer's animation.
 *
 * ## What is NOT here, on purpose
 *
 * The sample→keyframe reduction is NOT reimplemented. `core/rig/puppetSketch`
 * already holds it — Douglas–Peucker on the spatial path, time-thinning,
 * same-instant collapse, easing of the survivors — written for Puppet Sketch,
 * tested in `rig/phase3.test.ts`, and entirely generic: it works on
 * `{x, y, t}` and knows nothing about pins. A second copy tuned for layers
 * would be the §2·0 shape with the two implementations drifting on exactly the
 * cases nobody re-tests (the paused drag, the doubled sample).
 *
 * So this module owns only what is genuinely different:
 *
 *   * CAPTURE SPEED, which Puppet Sketch has no equivalent of;
 *   * the fan-out from one path to the TWO scalar tracks a layer transform
 *     keeps (`x` and `y`), where a pin keeps one point-valued track.
 *
 * ## Coordinate space: deliberately not computed here
 *
 * The samples this module receives are already the layer's own `x`/`y` values,
 * because the recorder is fed from inside `moveNodes` — the one place that
 * converts a viewport drag into layer-local translation, through the parent's
 * inverse world matrix. Recomputing that conversion here would be a second
 * reader of the rule F23 was about, and it would be wrong in exactly the same
 * way: right for an unparented layer, silently wrong under a moving parent.
 */

import { defaultAnimation, type Keyframe } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import {
  sketchToKeyframes,
  SketchRecorder,
  DEFAULT_SKETCH_TOLERANCE,
  type SketchSample,
} from '@core/rig/puppetSketch';

export interface MotionSketchOptions {
  /**
   * Smoothing, as a Douglas–Peucker tolerance in layer px. **0 means keep
   * every captured sample**, which is AE's default and this one: Motion Sketch
   * records one keyframe per frame, and smoothing is a pass you ask for.
   *
   * That default is not laziness, and the reason is worth stating because the
   * reduction is spatial ONLY. Douglas–Peucker measures a point's distance
   * from the chord, so any sample lying on the straight line between its
   * neighbours is dropped no matter how much TIME it accounts for. A layer
   * held still for a second and then moved is, spatially, one straight path
   * from the start position to the end — every sample of the hold sits exactly
   * on that chord, so the whole pause is discarded and a one-second wait
   * becomes a slow drift. Even a tolerance of 0 does this, since the test is
   * `distance > tol`.
   *
   * For Puppet Sketch, where the reduction came from, that is an acceptable
   * trade: pins are dragged more or less continuously. For Motion Sketch the
   * timing IS the content, so reduction is off unless asked for, and asking
   * for it means accepting that holds along a straight path go with it.
   */
  tolerance: number;
  /**
   * AE's capture speed, as a percentage. 100 plays the motion back at the
   * speed it was drawn; 50 stretches it to twice the duration; 200 halves it.
   */
  captureSpeedPct: number;
}

export const DEFAULT_MOTION_SKETCH_OPTIONS: MotionSketchOptions = {
  tolerance: 0,
  captureSpeedPct: 100,
};

/** What the smoothing control offers when a user does turn it on. */
export const SUGGESTED_SMOOTHING = DEFAULT_SKETCH_TOLERANCE;

/**
 * Rescale sample times around the FIRST sample for capture speed.
 *
 * Anchored to the first sample rather than to zero, because the recording
 * starts wherever the playhead was. Scaling absolute times would drag the
 * whole take toward t=0 as speed rose — the motion would both play faster and
 * jump backwards in the comp, and only the second of those was asked for.
 *
 * A speed of zero or less is treated as 100 rather than refused: it would
 * divide by zero or run time backwards, and there is no sensible partial
 * result to hand back mid-gesture.
 */
export function applyCaptureSpeed(
  samples: readonly SketchSample[],
  captureSpeedPct: number,
): SketchSample[] {
  const pct = captureSpeedPct > 0 ? captureSpeedPct : 100;
  if (samples.length === 0 || pct === 100) return samples.slice();
  const t0 = samples[0]!.t;
  const factor = 100 / pct;
  return samples.map((s) => ({ x: s.x, y: s.y, t: t0 + (s.t - t0) * factor }));
}

export interface MotionSketchTracks {
  x: Keyframe[];
  y: Keyframe[];
}

/**
 * Reduce a recorded path to the two scalar tracks a layer transform keeps.
 *
 * Both tracks get the SAME times and the same easing, taken from one spatial
 * reduction. Reducing x and y independently is the tempting alternative and it
 * is wrong: Douglas–Peucker on each axis separately keeps different survivors,
 * so the axes get different keyframe times and the path between them is no
 * longer the path that was drawn — it bulges wherever one axis kept a point
 * the other dropped.
 */
export function motionSketchTracks(
  samples: readonly SketchSample[],
  opts: MotionSketchOptions = DEFAULT_MOTION_SKETCH_OPTIONS,
): MotionSketchTracks {
  const timed = applyCaptureSpeed(samples, opts.captureSpeedPct);
  // `tolerance <= 0` skips the SPATIAL reduction rather than passing 0 through:
  // Douglas–Peucker at tolerance 0 still drops every point lying on its chord,
  // which is the whole of a stationary hold. `dedupeByTime` still runs either
  // way, because two samples at one instant are not a curve.
  const reduced = sketchToKeyframes(timed, {
    tolerance: opts.tolerance,
    simplify: opts.tolerance > 0,
  });
  const x: Keyframe[] = [];
  const y: Keyframe[] = [];
  for (const k of reduced) {
    const p = k.value[0];
    if (!p) continue;
    x.push({ t: k.t, value: p.x, easing: k.easing ?? 'linear' });
    y.push({ t: k.t, value: p.y, easing: k.easing ?? 'linear' });
  }
  return { x, y };
}

/**
 * Splice a recorded range into an existing track, keeping everything outside it.
 *
 * `setKeyframes` replaces a whole track, which for Motion Sketch would delete
 * any animation the layer already had before or after the take — a recording
 * over the middle of an existing move would silently discard both ends. So the
 * old keyframes strictly inside the recorded span are dropped and the rest
 * survive, which is what "record over this part" means.
 *
 * The span is taken from the RECORDED keyframes, after capture speed, so a
 * take at 50% correctly clears the whole stretched span rather than the
 * unscaled one it was drawn in.
 */
export function spliceRecordedRange(
  existing: readonly Keyframe[],
  recorded: readonly Keyframe[],
): Keyframe[] {
  if (recorded.length === 0) return existing.slice();
  const t0 = recorded[0]!.t;
  const t1 = recorded[recorded.length - 1]!.t;
  const kept = existing.filter((k) => k.t < t0 - 1e-9 || k.t > t1 + 1e-9);
  return [...kept, ...recorded].sort((a, b) => a.t - b.t);
}

interface SketchSession {
  nodeId: string;
  recorder: SketchRecorder;
  opts: MotionSketchOptions;
}

let session: SketchSession | null = null;

/** Arm a recording for `nodeId`. Replaces any session already armed. */
export function armMotionSketch(
  nodeId: string,
  opts: MotionSketchOptions = DEFAULT_MOTION_SKETCH_OPTIONS,
): void {
  session = { nodeId, recorder: new SketchRecorder(), opts };
}

/** The node currently recording, or null. */
export function motionSketchNodeId(): string | null {
  return session?.nodeId ?? null;
}

export function motionSketchSampleCount(): number {
  return session?.recorder.count ?? 0;
}

/**
 * Record one position, in the layer's OWN x/y — see the module header for why
 * the conversion is not done here. Ignores nodes other than the armed one, so
 * a multi-select drag records only the layer the user armed.
 */
export function recordMotionSketchSample(nodeId: string, x: number, y: number, t: number): void {
  if (!session || session.nodeId !== nodeId) return;
  session.recorder.add(x, y, t);
}

/** Discard the take without writing. */
export function cancelMotionSketch(): void {
  session = null;
}

/**
 * End the recording and write it as ONE undo step.
 *
 * Returns the number of keyframes written per axis, or 0 when nothing was
 * recorded. `runAnimEdit` wraps the whole write exactly as `PuppetEditCommand`
 * does, so a gesture undoes in one go rather than one keyframe at a time —
 * which is the difference between an undoable feature and an unusable one.
 */
export function finishMotionSketch(): number {
  if (!session) return 0;
  const { nodeId, recorder, opts } = session;
  session = null;
  const tracks = motionSketchTracks(recorder.raw(), opts);
  recorder.reset();
  if (tracks.x.length === 0) return 0;

  const existingOf = (prop: string): readonly Keyframe[] =>
    defaultAnimation.tracksFor(nodeId).find((t) => t.prop === prop)?.keyframes ?? [];

  runAnimEdit('Motion Sketch', () => {
    defaultAnimation.batch(() => {
      defaultAnimation.setKeyframes(nodeId, 'x', spliceRecordedRange(existingOf('x'), tracks.x));
      defaultAnimation.setKeyframes(nodeId, 'y', spliceRecordedRange(existingOf('y'), tracks.y));
    });
  });
  return tracks.x.length;
}
