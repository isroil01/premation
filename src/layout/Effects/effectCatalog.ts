/**
 * The effect catalogue as React reads it — every addable effect type, and the
 * user's starred ones.
 *
 * Shared by the Effects browser (the library you browse) and the Properties
 * panel's "Add effect" menu (the quick add beside the stack you edit). Both
 * used to be one component's private hooks; a second copy of "which effects
 * exist" would drift the first time a plugin was installed while only one of
 * them was listening.
 */

import { useMemo } from 'react';
import { usePreferenceStore } from '@stores/preferenceStore';
import { EFFECT_DEFS, type EffectDef } from '@core/effects/effects';

/** Starred effect type ids — preference, same rationale as library favourites. */
export function useEffectFavorites(): {
  favorites: ReadonlySet<string>;
  toggle: (id: string) => void;
  isFavorite: (id: string) => boolean;
} {
  const list = usePreferenceStore((s) => s.effectFavorites);
  const setPref = usePreferenceStore((s) => s.set);
  const favorites = useMemo(() => new Set(list), [list]);
  return {
    favorites,
    isFavorite: (id) => favorites.has(id),
    toggle: (id) =>
      setPref('effectFavorites', favorites.has(id) ? list.filter((x) => x !== id) : [...list, id]),
  };
}

/** Every effect this build offers (the built-ins; JavaScript plugin effects are gone, G2). */
export function useAllEffectDefs(): ReadonlyArray<EffectDef> {
  return EFFECT_DEFS;
}
