/**
 * Named motion-physics curves — how things move, with weight and life.
 *
 * These lived in `core/ai/design.ts`, which is the design SYSTEM the AI
 * composes from (palettes, type scales, spacing). Easing curves are not that:
 * they are a property of motion itself, and the editor's own animation
 * commands need them without taking a dependency on the AI feature area.
 * `design.ts` re-exports them, so every existing import still resolves.
 */

/** A cubic-bezier easing curve [x1,y1,x2,y2]. */
export type Bezier = [number, number, number, number];

export const PHYSICS = {
  /** Confident pop with a little overshoot — entrances with character. */
  overshoot: [0.34, 1.56, 0.64, 1] as Bezier,
  /** Strong, smooth deceleration (easeOutQuint) — premium arrivals. */
  softOut: [0.22, 1, 0.36, 1] as Bezier,
  /** Snappy UI move. */
  snappy: [0.4, 0, 0.2, 1] as Bezier,
  /** Gentle in/out for holds and settles. */
  smooth: [0.45, 0, 0.55, 1] as Bezier,
  /** Anticipation pull-back before forward motion. */
  anticipate: [0.6, -0.28, 0.735, 0.045] as Bezier,
  /** Dynamic spring elasticity for kinetic motion. */
  elastic: [0.68, -0.55, 0.265, 1.55] as Bezier,
} as const;
