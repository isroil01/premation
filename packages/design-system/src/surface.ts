/**
 * Surface treatment: grain, vignette, light source, halation.
 *
 * ## Texture is the anti-CG lever
 *
 * Perfectly flat vector output is the clearest single signal that nobody touched
 * a piece. Not the layout, not the timing — the *cleanliness*. Real footage has
 * grain; real screens have a vignette from the lens; real scenes have a light
 * source somewhere. Adding a trace of all three costs one adjustment layer and
 * moves output from "drawn" to "shot" more reliably than anything else in this
 * package.
 *
 * The amounts are small on purpose. Grain at 15% is a stylistic choice; grain at
 * 3% is invisible until you toggle it off, at which point the frame looks dead.
 *
 * Pure.
 */

import { hexToOklch, oklchToHex, mix } from './color';

export interface SurfaceTreatment {
  /** Grain amount, percent. 2–5 is the useful band. */
  grain: number;
  /** Evolve the grain per frame. Static grain reads as a dirty lens. */
  grainAnimated: boolean;
  /** Vignette strength, percent. 4–8 typical. */
  vignette: number;
  /** Edge colour fringing, px. 0 for most work; 1–2 for a lens look. */
  chromaticAberration: number;
}

/** The defaults every composition should get. */
export const BASE_TREATMENT: SurfaceTreatment = {
  grain: 3,
  grainAnimated: true,
  vignette: 6,
  chromaticAberration: 0,
};

export type SurfaceStyle = 'clean' | 'film' | 'print' | 'screen' | 'crt';

/**
 * Per-style treatment.
 *
 * `clean` still has grain and a vignette — it is "clean" relative to the others,
 * not literally untreated. There is no zero option, because a genuinely flat
 * frame is the failure state the design linter's `NO_TEXTURE_LAYER` rule exists to
 * catch.
 */
export function treatment(style: SurfaceStyle): SurfaceTreatment {
  switch (style) {
    case 'film':
      return { grain: 5, grainAnimated: true, vignette: 9, chromaticAberration: 1.2 };
    case 'print':
      // Print has grain but no lens, so no vignette and no aberration — the
      // vignette is an optical artefact and putting one on a "printed" look is
      // the kind of mismatch that reads as generic-filter.
      return { grain: 6, grainAnimated: false, vignette: 0, chromaticAberration: 0 };
    case 'screen':
      return { grain: 2, grainAnimated: true, vignette: 4, chromaticAberration: 0.6 };
    case 'crt':
      return { grain: 7, grainAnimated: true, vignette: 14, chromaticAberration: 2.4 };
    case 'clean':
    default:
      return BASE_TREATMENT;
  }
}

// ── Background light ──────────────────────────────────────────────────

export interface BackgroundLight {
  /** Gradient stops, already OKLCH-interpolated. */
  stops: string[];
  /** Gradient angle, degrees. */
  angle: number;
  kind: 'linear' | 'radial' | 'corners';
}

/**
 * A background that is never a flat fill.
 *
 * Even a "solid black background" in real work has a light source: a lift in one
 * corner, a soft pool behind the subject, a vertical falloff. The lift here is
 * deliberately small — large enough to give the frame a direction, small enough
 * that nobody would call it a gradient.
 *
 * `accent` bleeds faintly into the lit end. That is what stops the background
 * reading as generic dark-grey and starts it reading as *this piece's* dark.
 */
export function backgroundLight(
  bg: string,
  accent: string,
  opts: { lift?: number; angle?: number; kind?: BackgroundLight['kind'] } = {},
): BackgroundLight {
  const base = hexToOklch(bg);
  const lift = opts.lift ?? 0.07;
  const dark = base.l < 0.5;

  const lit = oklchToHex({
    l: dark ? Math.min(0.95, base.l + lift) : Math.max(0.05, base.l - lift * 0.6),
    c: base.c,
    h: base.h,
  });
  // A trace of accent in the lit end, mixed in OKLCH so it tints rather than
  // muddies.
  const tinted = mix(lit, accent, 0.12);

  return {
    stops: [bg, tinted],
    angle: opts.angle ?? 115,
    kind: opts.kind ?? 'linear',
  };
}

/**
 * Halation — the soft bloom around bright elements on film.
 *
 * Returns glow parameters rather than applying anything. Only worth it on
 * genuinely bright elements against a dark field; on a light background it does
 * nothing but cost a render pass.
 */
export function halation(accent: string): { color: string; radius: number; intensity: number } {
  const a = hexToOklch(accent);
  return {
    // Halation is warmer and lighter than its source — it is scattered light,
    // not a copy of the object.
    color: oklchToHex({ l: Math.min(0.9, a.l + 0.18), c: a.c * 0.8, h: a.h }),
    radius: 26,
    intensity: 45,
  };
}

/** True when a treatment would leave the frame untextured. */
export function isUntreated(t: SurfaceTreatment): boolean {
  return t.grain <= 0 && t.vignette <= 0 && t.chromaticAberration <= 0;
}
