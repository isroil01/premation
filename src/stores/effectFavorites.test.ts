/**
 * Effect favourites are a preference (like library favourites): which effect
 * types you pin in Effects & Presets, not project data.
 */

import { DEFAULT_PREFERENCES, usePreferenceStore } from './preferenceStore';

describe('effectFavorites preference', () => {
  beforeEach(() => {
    usePreferenceStore.getState().reset();
  });

  it('defaults to an empty list', () => {
    expect(DEFAULT_PREFERENCES.effectFavorites).toEqual([]);
    expect(usePreferenceStore.getState().effectFavorites).toEqual([]);
  });

  it('round-trips set / remove', () => {
    usePreferenceStore.getState().set('effectFavorites', ['blur', 'glow']);
    expect(usePreferenceStore.getState().effectFavorites).toEqual(['blur', 'glow']);
    usePreferenceStore.getState().set(
      'effectFavorites',
      usePreferenceStore.getState().effectFavorites.filter((id) => id !== 'blur'),
    );
    expect(usePreferenceStore.getState().effectFavorites).toEqual(['glow']);
  });

  it('is a known preference key (survives setMany filtering)', () => {
    expect(Object.keys(DEFAULT_PREFERENCES)).toContain('effectFavorites');
    usePreferenceStore.getState().setMany({ effectFavorites: ['tint'] });
    expect(usePreferenceStore.getState().effectFavorites).toEqual(['tint']);
  });
});
