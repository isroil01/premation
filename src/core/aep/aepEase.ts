/**
 * After Effects easing → this editor's bezier handles.
 *
 * AE does not store a curve. It stores, per keyframe and per dimension, a
 * **speed** (value units per second) and an **influence** (how far along the
 * segment the handle reaches, 0–1 in the file and 0–100 % in the UI). The curve
 * is what those imply, and recovering it is a small piece of algebra that is
 * worth writing down because getting it subtly wrong produces animation that
 * plays but feels wrong — which is far harder to notice than an import that
 * visibly fails.
 *
 * For a segment from keyframe A to keyframe B, with `dt = tB − tA` and
 * `dv = vB − vA`, the normalised cubic bezier is:
 *
 *     x1 = A.outInfluence
 *     y1 = A.outSpeed · dt / dv · A.outInfluence
 *     x2 = 1 − B.inInfluence
 *     y2 = 1 − B.inSpeed · dt / dv · B.inInfluence
 *
 * The `dt / dv` normalises AE's real-world speed into the unit square, and
 * multiplying by the influence is what converts a tangent DIRECTION into a
 * control-point POSITION. This is the same conversion Lottie exporters perform,
 * which is a useful cross-check: a file exported from AE to Lottie and one
 * imported here from the `.aep` should ease identically.
 *
 * ## The degenerate case is not an error
 *
 * When `dv` is zero the segment holds a constant value and the vertical
 * component is meaningless — there is no value change for a speed to be a
 * fraction of. The handles collapse to a straight ramp, which is what AE draws
 * for that segment too. Dividing anyway yields ±Infinity and then NaN, and a
 * NaN in a bezier handle propagates into the sampled value and blanks the
 * layer, so the guard is load-bearing rather than defensive.
 */

import type { BezierHandles, EasingKind, Keyframe, SpatialInterp } from '@motion/animation';
import type { AepKeyframe } from './aepModel';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** A handle component AE could produce but the engine cannot sample. */
const finite = (v: number): number => (Number.isFinite(v) ? v : 0);

/**
 * The bezier handles for the segment leaving `from` and arriving at `to`, on
 * dimension `dim`.
 *
 * Both keyframes are needed because a segment's shape is authored from both
 * ends: AE's "ease out" of one keyframe and "ease in" of the next are the two
 * control points of the same curve.
 */
export function segmentBezier(from: AepKeyframe, to: AepKeyframe, dim: number): BezierHandles {
  const dt = to.time - from.time;
  const dv = (to.value[dim] ?? 0) - (from.value[dim] ?? 0);

  const outInfluence = clamp01(from.outInfluence[dim] ?? from.outInfluence[0] ?? 0);
  const inInfluence = clamp01(to.inInfluence[dim] ?? to.inInfluence[0] ?? 0);

  const x1 = outInfluence;
  const x2 = 1 - inInfluence;

  if (dv === 0 || dt === 0) {
    // No value change: the curve's vertical shape is undefined. A straight
    // ramp between the two horizontal positions keeps the timing the ease
    // implies without inventing an overshoot.
    return [x1, x1, x2, x2];
  }

  const outSpeed = from.outSpeed[dim] ?? from.outSpeed[0] ?? 0;
  const inSpeed = to.inSpeed[dim] ?? to.inSpeed[0] ?? 0;
  const y1 = finite((outSpeed * dt) / dv) * outInfluence;
  const y2 = 1 - finite((inSpeed * dt) / dv) * inInfluence;

  return [x1, finite(y1), x2, finite(y2)];
}

/**
 * How AE's spatial-interpolation flags map onto the engine's.
 *
 * `linear` is inferred rather than stored: AE marks a corner vertex by leaving
 * both tangents at zero, and the engine has an explicit mode for it that stops
 * the stored (zero) tangents being used as real ones.
 */
function spatialInterpOf(kf: AepKeyframe, dim: number): SpatialInterp | undefined {
  if (!kf.inTangent && !kf.outTangent) return undefined;
  if (kf.spatialAutoBezier) return 'auto';
  const si = kf.inTangent?.[dim] ?? 0;
  const so = kf.outTangent?.[dim] ?? 0;
  if (si === 0 && so === 0) return 'linear';
  return kf.spatialContinuous ? 'continuous' : 'bezier';
}

/**
 * The easing kind for the segment leaving `from`.
 *
 * Hold wins outright: AE's hold keyframe freezes the value until the next one
 * regardless of what the next keyframe's "in" says, so there is no curve to
 * build. Linear on both sides stays linear rather than becoming a bezier with
 * straight handles, because the engine's timeline draws the two differently
 * and a file full of linear keyframes should look linear when it arrives.
 */
function easingOf(from: AepKeyframe, to: AepKeyframe | undefined): EasingKind {
  if (from.outInterpolation === 'hold') return 'hold';
  if (!to) return 'linear';
  if (from.outInterpolation === 'linear' && to.inInterpolation === 'linear') return 'linear';
  return 'bezier';
}

export interface ConvertOptions {
  /** Added to every keyframe time — AE comp time → this layer's time. */
  timeOffset?: number;
  /** Multiplies every value, for the unit differences the planner knows about. */
  scale?: number;
  /** Added to every value after scaling (AE's top-left origin → ours). */
  offset?: number;
}

/**
 * One dimension of an AE property → an engine keyframe track.
 *
 * AE keeps a multi-dimensional property as one property with vector values;
 * the engine keeps one scalar track per axis. So this is called once per axis,
 * and each call pulls its own dimension out of every keyframe — which is also
 * why the ease has to be computed per dimension rather than shared: a 2-D
 * scale can genuinely ease differently on x and y.
 */
export function toKeyframeTrack(
  keyframes: readonly AepKeyframe[],
  dim: number,
  opts: ConvertOptions = {},
): Keyframe[] {
  const { timeOffset = 0, scale = 1, offset = 0 } = opts;
  return keyframes.map((kf, i) => {
    const next = keyframes[i + 1];
    const easing = easingOf(kf, next);
    const spatial = spatialInterpOf(kf, dim);
    const out: Keyframe = {
      t: kf.time + timeOffset,
      value: (kf.value[dim] ?? 0) * scale + offset,
      easing,
    };
    if (easing === 'bezier' && next) out.bezier = segmentBezier(kf, next, dim);
    if (kf.temporalContinuous) out.continuous = true;
    // An end keyframe cannot rove — AE will not let you, and the engine's
    // rover would have no anchor on one side if it could.
    if (kf.roving && i > 0 && next) out.roving = true;
    if (spatial) {
      out.spatialInterp = spatial;
      // Tangents are value-space offsets, so they scale with the value but do
      // NOT take the origin offset: an offset is a translation and a tangent
      // is a difference.
      if (kf.inTangent) out.si = (kf.inTangent[dim] ?? 0) * scale;
      if (kf.outTangent) out.so = (kf.outTangent[dim] ?? 0) * scale;
    }
    return out;
  });
}
