/**
 * Taper and Wave — the two stroke PROFILES, as After Effects models them.
 *
 * ## Why these are one module
 *
 * AE does not ship Taper as a feature and Wave as another. They arrived together
 * in CC 2018 as one property group on the shape-layer Stroke, and they are
 * grouped because they share machinery: both walk the path by ARC LENGTH, take
 * the local normal, and displace. The only difference is what they do with the
 * two sides — taper moves them OPPOSITELY (it varies the width), wave moves them
 * TOGETHER (it displaces the centreline).
 *
 * Building taper alone would build most of wave and then stop, which is the
 * cheap-half-first trap that produced F34 one item earlier on this board.
 *
 * ## Policy here, geometry elsewhere (DECISION D4)
 *
 * This file is the AE MODEL: what a taper ramp means, how ease bends it, what a
 * wavelength is measured in. The geometric half — offsetting a polyline along
 * its normals by a per-vertex distance — is `offsetAlongNormals` in
 * `@motion/scene`, shared with the brush and with variable-width mask feather.
 * Keeping policy out of the primitive is what lets three features use it.
 *
 * ## Units, which differ between the two and are easy to get wrong
 *
 *   • Taper lengths are a FRACTION OF PATH LENGTH (0..1). "Taper the first 20%"
 *     is resolution- and scale-independent, which is what makes a tapered stroke
 *     survive a resize.
 *   • Wave's wavelength is ABSOLUTE ARC LENGTH IN PX. A wave whose period
 *     scaled with the path would change its look when the shape is resized,
 *     which is not what a wave is for.
 *
 * Both are pure: no clock, no randomness, no engine access.
 */

/** AE's Taper group. Widths are FRACTIONS of the stroke's own width. */
export interface StrokeTaper {
  /** Fraction of the path the start ramp occupies, 0..1. */
  startLength: number;
  /** Fraction of the path the end ramp occupies, 0..1. */
  endLength: number;
  /** Width at the very start, as a fraction of stroke width (0 = a point). */
  startWidth: number;
  /** Width at the very end, as a fraction of stroke width. */
  endWidth: number;
  /** 0 = a straight ramp, 1 = fully smoothed. */
  startEase: number;
  /** 0 = a straight ramp, 1 = fully smoothed. */
  endEase: number;
}

/** AE's Wave group. `phase` is the one that animates. */
export interface StrokeWave {
  /** Peak displacement from the centreline, in px. */
  amount: number;
  /** Period along the path, in PX of arc length. */
  wavelength: number;
  /** Degrees. Advancing it travels the wave along the path. */
  phase: number;
}

export const IDENTITY_TAPER: StrokeTaper = {
  startLength: 0, endLength: 0,
  startWidth: 1, endWidth: 1,
  startEase: 0, endEase: 0,
};

export const IDENTITY_WAVE: StrokeWave = { amount: 0, wavelength: 0, phase: 0 };

/**
 * True when the profile cannot change a single pixel.
 *
 * The renderer short-circuits on these rather than running a taper that happens
 * to compute 1 everywhere. That is what makes "uniform width is byte-identical
 * to no taper" a STRUCTURAL property instead of a numerical coincidence — the
 * tapered path is not taken at all, so there is no float arithmetic to differ
 * in the last bit (§2·0: prefer making the state unrepresentable).
 */
export function isIdentityTaper(t: StrokeTaper | undefined): boolean {
  if (!t) return true;
  // A ramp of zero length cannot ramp, whatever width it names; and full width
  // at both ends is no taper however long the ramps are.
  const noRamp = t.startLength <= 0 && t.endLength <= 0;
  const fullWidth = t.startWidth === 1 && t.endWidth === 1;
  return noRamp || fullWidth;
}

export function isIdentityWave(w: StrokeWave | undefined): boolean {
  // Wavelength 0 is not "an infinitely fast wave", it is a division by zero —
  // treated as off, which is also what a freshly-added Wave group looks like.
  return !w || w.amount === 0 || w.wavelength <= 0;
}

/**
 * Bend a 0..1 ramp by an ease amount.
 *
 * `ease` 0 leaves it straight; 1 gives smoothstep, which is flat at both ends.
 * Intermediate values are a straight blend of the two, so the control is
 * monotonic in feel rather than switching curve families partway.
 *
 * Derived rather than tuned: smoothstep is 3u²−2u³, its derivative is 6u(1−u),
 * which is 0 at both ends — that is exactly the "eases out of the ramp" look,
 * and it needs no magic constants.
 */
export function easeRamp(u: number, ease: number): number {
  const x = u < 0 ? 0 : u > 1 ? 1 : u;
  const e = ease < 0 ? 0 : ease > 1 ? 1 : ease;
  const smooth = x * x * (3 - 2 * x);
  return x + (smooth - x) * e;
}

/**
 * The stroke's width MULTIPLIER at arc fraction `s` (0 = path start, 1 = end).
 *
 * Shape, on paper:
 *
 *      s < startLength          ramp startWidth → 1, eased by startEase
 *      s > 1 − endLength        ramp 1 → endWidth, eased by endEase
 *      between                  1 (full width)
 *
 * The two ramps are independent, which is what lets a stroke taper at one end
 * only — AE's common case, and the reason start and end carry separate widths
 * AND separate eases rather than one shared pair.
 *
 * OVERLAPPING RAMPS are resolved by taking the MINIMUM of the two, not by
 * letting the later one win. With `startLength + endLength > 1` the two ramps
 * cover the same middle, and min() keeps the result continuous and ≤ 1 there;
 * last-one-wins would step discontinuously at the crossover and read as a nick
 * in the stroke.
 */
export function taperWidthFactorAt(taper: StrokeTaper, s: number): number {
  if (isIdentityTaper(taper)) return 1;
  const x = s < 0 ? 0 : s > 1 ? 1 : s;

  let factor = 1;
  if (taper.startLength > 0 && x < taper.startLength) {
    const u = easeRamp(x / taper.startLength, taper.startEase);
    factor = Math.min(factor, taper.startWidth + (1 - taper.startWidth) * u);
  }
  if (taper.endLength > 0 && x > 1 - taper.endLength) {
    const u = easeRamp((1 - x) / taper.endLength, taper.endEase);
    factor = Math.min(factor, taper.endWidth + (1 - taper.endWidth) * u);
  }
  return factor < 0 ? 0 : factor;
}

/**
 * The centreline's perpendicular displacement at `arcLength` px along the path.
 *
 *      offset = amount · sin( 2π · arcLength / wavelength + phase )
 *
 * `phase` is in DEGREES at the boundary because that is what the UI shows and
 * what AE animates; radians only exist inside this function.
 *
 * DIRECTION, stated because it is the thing a symmetric amplitude cannot show:
 * a crest sits where `2πs/λ + φ = π/2`, i.e. at `s = λ(π/2 − φ)/2π`. So
 * ADVANCING THE PHASE MOVES CRESTS TOWARD s = 0 — the wave travels backward
 * along the path as phase increases. That is derived from the formula, not read
 * off an implementation, and it is what the guard anchors to.
 */
export function waveOffsetAt(wave: StrokeWave, arcLength: number): number {
  if (isIdentityWave(wave)) return 0;
  const phaseRad = (wave.phase * Math.PI) / 180;
  return wave.amount * Math.sin((2 * Math.PI * arcLength) / wave.wavelength + phaseRad);
}
