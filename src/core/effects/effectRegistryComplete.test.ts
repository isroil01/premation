/**
 * Every `EffectType` must have a DEFINITION, and the type system does not say so.
 *
 * ## The bug that produced this file
 *
 * Compound Blur was added type-first: `'compound-blur'` went into the
 * `EffectType` union, the shader, material, uniform packer, renderer branch and
 * scene all landed — and the entry in `EFFECT_DEFS` did not. `tsc` was clean,
 * the whole suite was green, and the effect rendered NOTHING.
 *
 * It failed silently because almost everything downstream is keyed off the
 * DEFINITION rather than the type:
 *
 *   `GPU_ONLY_EFFECTS`  is `EFFECT_DEFS.filter(d => d.gpuOnly)`, so an effect
 *                       with no def is not GPU-only, and `extractSpatialEffects`
 *                       skipped it on every baked layer.
 *   the effects browser  lists defs, so it could never be ADDED by a user.
 *   `params`             comes from the def, so it has no controls.
 *
 * Only one thing caught any part of it: `EFFECT_CATEGORY` in `EffectsPanel` is
 * typed `Record<EffectType, string>`, so the missing category was a compile
 * error. That is the pattern worth copying — an exhaustive record forces the
 * question — and it is why this file asserts the same thing about the registry
 * that the type system already asserts about the category map.
 *
 * ## Why a test and not a typed Record
 *
 * `EFFECT_DEFS` is an ARRAY, and deliberately: its order is the order effects
 * appear, which a `Record` would not preserve. So the exhaustiveness has to be
 * checked rather than declared, and this is where.
 */

import { EFFECT_DEFS, effectDefFor, isGpuOnlyEffect, type EffectType } from './effects';
import { EFFECT_CATEGORY } from '@/layout/Effects/EffectsPanel';

/**
 * Every member of the union — taken from the ONE place the compiler already
 * forces to be exhaustive.
 *
 * `EFFECT_CATEGORY` is declared `Record<EffectType, string>`, so a type added to
 * the union without a folder is a compile error, and its keys are therefore a
 * complete list of `EffectType` that no one has to maintain by hand.
 *
 * Deriving it from `EFFECT_DEFS` instead would make this file vacuous: it would
 * compare the defs against themselves and pass for precisely the effect that is
 * missing. Deriving it from a hand-written list was the first attempt here, and
 * that list was wrong within a minute of being written — sixty entries is past
 * what anyone will keep in step.
 */
const ALL_EFFECT_TYPES = Object.keys(EFFECT_CATEGORY) as EffectType[];

describe('the effect registry is complete', () => {
  it('has a definition for every type in the union', () => {
    const missing = ALL_EFFECT_TYPES.filter((t) => effectDefFor(t) === undefined);
    // Named rather than counted: the failure message has to say WHICH, or the
    // next person is back to bisecting a union of sixty entries.
    expect(missing).toEqual([]);
  });

  it('has no definition for a type the union does not contain', () => {
    // The other direction. A def whose type was renamed in the union but not
    // here would be unreachable — it would render, but nothing could name it.
    const known = new Set<string>(ALL_EFFECT_TYPES);
    const orphans = EFFECT_DEFS.map((d) => d.type).filter((t) => !known.has(t));
    expect(orphans).toEqual([]);
  });

  it('gives every definition a label and a params array', () => {
    // A def with no label shows as a blank row in the browser; one with no
    // params array throws when the inspector maps over it.
    for (const d of EFFECT_DEFS) {
      expect(typeof d.label).toBe('string');
      expect(d.label.length).toBeGreaterThan(0);
      expect(Array.isArray(d.params)).toBe(true);
    }
  });

  it('keeps `gpuOnly` reachable, since that flag decides a baked layer’s fate', () => {
    // `extractSpatialEffects(layer, true)` carries ONLY gpuOnly effects past a
    // CPU bake. An effect that should be GPU-only and is not flagged vanishes
    // the moment it shares a layer with anything that bakes — which is how the
    // Compound Blur bug presented, and it presented as "the effect does
    // nothing" rather than as a missing registry entry.
    for (const t of ['displacement-map', 'motion-tile', 'compound-blur'] as EffectType[]) {
      expect(isGpuOnlyEffect(t)).toBe(true);
    }
  });
});
