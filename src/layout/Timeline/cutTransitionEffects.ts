/**
 * The Transition effects a CUT can use (2026-10-07).
 *
 * A cut transition of kind `wipe` ramps one effect's Transition Completion on
 * the incoming layer (the engine's `addTransition{effect}`). Any effect in the
 * Transition category that HAS a Transition Completion param qualifies — Radial
 * Wipe, Iris Wipe, Venetian Blinds, Block Dissolve, Card Wipe … — so a new
 * transition effect is a registry entry, never a change here. Linear Wipe is
 * the plain "Wipe" kind itself, so it is not listed twice.
 */

import { EFFECT_DEFS } from '@core/effects/effects';
import { EFFECT_CATEGORY } from '@layout/Effects/effectCategory';

export interface CutTransitionEffect {
  type: string;
  label: string;
  /** The effect names a direction (wipe / start angle, or angle). */
  hasAngle: boolean;
  /** The effect names an edge softness (Feather or Softness). */
  hasSoftness: boolean;
}

let cache: CutTransitionEffect[] | null = null;

/** Every Transition-category effect with a Transition Completion, by label. */
export function cutTransitionEffects(): CutTransitionEffect[] {
  if (cache) return cache;
  cache = EFFECT_DEFS.filter(
    (d) =>
      d.type !== 'linear-wipe' &&
      (EFFECT_CATEGORY as Record<string, string | undefined>)[d.type] === 'Transition' &&
      d.params.some((p) => p.key === 'completion'),
  )
    .map((d) => ({
      type: d.type,
      label: d.label,
      hasAngle: d.params.some((p) => p.key === 'wipeAngle' || p.key === 'startAngle' || p.key === 'angle'),
      hasSoftness: d.params.some((p) => p.key === 'feather' || p.key === 'softness'),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return cache;
}

/** One effect's entry, or undefined (not a cut transition effect). */
export function cutTransitionEffect(type: string | undefined): CutTransitionEffect | undefined {
  return type ? cutTransitionEffects().find((e) => e.type === type) : undefined;
}

/** What a wipe transition is called: its effect's label, or plain "Wipe". */
export function wipeLabel(effect: string | undefined): string {
  return cutTransitionEffect(effect)?.label ?? 'Wipe';
}
