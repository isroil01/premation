/**
 * Shape language — a vocabulary, not primitives.
 *
 * A radius scale and a stroke scale, plus a per-pack shape vocabulary. The point
 * of a scale is *consistency*: three cards with radii 8, 12 and 10 look like a
 * mistake, and three at 12 look like a decision. The point of a per-pack
 * vocabulary is that "Swiss" and "cyberpunk" are not the same shapes at different
 * colours — Swiss is hard 0-radius rectangles and thick rules; cyberpunk is
 * clipped corners and angular cuts.
 *
 * Pure.
 */

/**
 * The radius scale. Not arbitrary values.
 *
 * Doubling steps because radius is perceived roughly logarithmically — 4 and 6
 * are indistinguishable in situ, 6 and 12 are clearly different.
 */
export const RADIUS_SCALE = [0, 2, 6, 12, 24, 9999] as const;
export type RadiusStep = 0 | 1 | 2 | 3 | 4 | 5;

/** `5` is the pill/circle case; it is clamped to half the smaller dimension. */
export function radius(step: RadiusStep, forSize?: { width: number; height: number }): number {
  const r = RADIUS_SCALE[step];
  if (r === 9999 && forSize) return Math.min(forSize.width, forSize.height) / 2;
  return r === 9999 ? 9999 : r;
}

/**
 * Stroke weights, tied to the type scale rather than invented separately.
 *
 * A hairline that is thinner than the thinnest stem of the body font looks
 * broken at small sizes and disappears entirely on a low-DPI render — so the
 * scale is anchored to the base font size.
 */
export function strokeScale(baseFontPx: number): { hairline: number; thin: number; regular: number; thick: number; rule: number } {
  const u = baseFontPx / 16;
  return {
    hairline: Math.max(1, Math.round(u * 1)),
    thin: Math.max(1, Math.round(u * 1.5)),
    regular: Math.max(2, Math.round(u * 2)),
    thick: Math.max(3, Math.round(u * 4)),
    // A "rule" is the heavy Swiss horizontal line, deliberately much heavier
    // than any stroke used for outlining.
    rule: Math.max(4, Math.round(u * 8)),
  };
}

export type ShapeVocabulary = 'hard' | 'soft' | 'pill' | 'clipped' | 'organic';

export interface ShapeLanguage {
  vocabulary: ShapeVocabulary;
  /** Default radius step for cards and panels. */
  cardRadius: RadiusStep;
  /** Default radius step for small controls — chips, buttons, badges. */
  controlRadius: RadiusStep;
  /** Whether the pack uses heavy horizontal rules as structure. */
  usesRules: boolean;
  /** Whether the pack outlines rather than fills. */
  prefersOutline: boolean;
  /**
   * Target negative-space range for the pack, as a fraction of frame.
   *
   * Luxury wants a lot; a data-dense SaaS explainer legitimately wants less.
   * Having it per-pack is what stops the design linter's space rule being either
   * useless or wrong for half the packs.
   */
  negativeSpace: [number, number];
}

export function shapeLanguage(vocabulary: ShapeVocabulary): ShapeLanguage {
  switch (vocabulary) {
    case 'hard':
      // Swiss / editorial: no radius anywhere, heavy rules doing the structural work.
      return { vocabulary, cardRadius: 0, controlRadius: 0, usesRules: true, prefersOutline: false, negativeSpace: [0.45, 0.65] };
    case 'pill':
      return { vocabulary, cardRadius: 3, controlRadius: 5, usesRules: false, prefersOutline: false, negativeSpace: [0.35, 0.55] };
    case 'clipped':
      // Cyberpunk: angular cuts. The engine has no chamfer, so this reads as
      // zero-radius plus stroke accents — honest about what it can render.
      return { vocabulary, cardRadius: 0, controlRadius: 0, usesRules: false, prefersOutline: true, negativeSpace: [0.3, 0.5] };
    case 'organic':
      return { vocabulary, cardRadius: 4, controlRadius: 5, usesRules: false, prefersOutline: false, negativeSpace: [0.4, 0.6] };
    case 'soft':
    default:
      return { vocabulary, cardRadius: 2, controlRadius: 3, usesRules: false, prefersOutline: false, negativeSpace: [0.38, 0.58] };
  }
}

/**
 * Does a set of shapes use one uniform radius across everything?
 *
 * A single radius everywhere is a mild tell (the design linter warns rather than
 * errors): real systems differentiate a card from a chip. But it is much better
 * than a random radius on each, so this is only worth reporting when the set is
 * big enough for the uniformity to be a choice rather than a coincidence.
 */
export function hasUniformRadius(radii: readonly number[]): boolean {
  if (radii.length < 3) return false;
  return new Set(radii.map((r) => Math.round(r))).size === 1;
}
