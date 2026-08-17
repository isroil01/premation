/**
 * The SVG path for an ease-curve thumbnail, SAMPLED from the curve it previews.
 *
 * The existing interpolation-kind row above it draws each shape from a
 * hand-written `d` string (`EASE_PREVIEW`). That is fine for ten fixed kinds
 * that never change, and wrong for a library: a hand-drawn thumbnail is a
 * second copy of the curve, and the two drift the moment a control point is
 * corrected — you would be clicking a picture of a curve you are not applying.
 * Same failure the icon-size guard exists to catch, one layer up.
 *
 * So the path comes from `cubicBezierEase`, the function the interpolator runs.
 *
 * ── Geometry ────────────────────────────────────────────────────────────────
 *
 * Value 0 maps to the bottom of the inner box and 1 to the top, the SAME
 * mapping for every curve, so thumbnails are comparable at a glance and Back
 * visibly bulges past the guide rather than being renormalised to look like
 * everything else. The padding is what gives the overshoot somewhere to go.
 */

import { cubicBezierEase } from '@motion/animation';
import type { BezierHandles } from '@motion/animation';

export interface EaseCurveBox {
  width: number;
  height: number;
  /** Space reserved on all four sides — also the room an overshoot draws into. */
  pad: number;
  /** Points sampled along the curve. */
  samples: number;
}

export const EASE_THUMB: EaseCurveBox = { width: 44, height: 32, pad: 6, samples: 24 };

/**
 * `d` for the curve, in SVG coordinates (y down).
 *
 * Sampled uniformly in X (time) rather than in the bezier parameter: X is what
 * the interpolator solves for, so uniform-in-X is the curve as it will be felt.
 */
export function easeCurvePath(bezier: BezierHandles, box: EaseCurveBox = EASE_THUMB): string {
  const { width, height, pad, samples } = box;
  const spanX = width - pad * 2;
  const spanY = height - pad * 2;
  const pts: string[] = [];
  for (let i = 0; i <= samples; i++) {
    const x = i / samples;
    const y = cubicBezierEase(bezier, x);
    const px = pad + x * spanX;
    // y up in value space, down in SVG. Not clamped: an overshoot that drew
    // flat against the top of the box would hide the one property that makes
    // Back worth choosing.
    const py = pad + (1 - y) * spanY;
    pts.push(`${i === 0 ? 'M' : 'L'}${round(px)},${round(py)}`);
  }
  return pts.join(' ');
}

/** The 0 and 1 guide lines, so overshoot is visible AGAINST something. */
export function easeCurveGuides(box: EaseCurveBox = EASE_THUMB): { y0: number; y1: number; x0: number; x1: number } {
  const spanY = box.height - box.pad * 2;
  return {
    y0: round(box.pad + spanY),
    y1: round(box.pad),
    x0: box.pad,
    x1: round(box.width - box.pad),
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
