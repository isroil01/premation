/**
 * Graph curve-click: pick the keyframe on a track nearest the click's
 * horizontal position (comp time). Pure so the hit rule is unit-tested without
 * mounting the SVG editor.
 */

export interface CurveClickKeyframe {
  t: number;
  tAbs: number;
}

/** Keyframe whose abs time is closest to `compT`. Empty track → null. */
export function nearestKeyframeOnCurve(
  keyframes: ReadonlyArray<CurveClickKeyframe>,
  compT: number,
): CurveClickKeyframe | null {
  if (keyframes.length === 0) return null;
  let best = keyframes[0]!;
  let bestDist = Math.abs(best.tAbs - compT);
  for (let i = 1; i < keyframes.length; i++) {
    const k = keyframes[i]!;
    const d = Math.abs(k.tAbs - compT);
    if (d < bestDist) {
      best = k;
      bestDist = d;
    }
  }
  return best;
}
