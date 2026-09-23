/**
 * Open the left-sidebar Effect Controls panel.
 *
 * Adding an effect used to only mutate the layer, and the stack that lets you
 * actually edit it lived in the same right-sidebar browser you added from —
 * so the library scrolled away under a growing list of cards. The stack now
 * lives on the left (AE's Effect Controls). Calling this after an add is what
 * makes the new effect's parameters appear instead of leaving the user staring
 * at the browser they just clicked.
 *
 * `openPanel` is a no-op for an unknown id, so this is safe in tests that
 * never register the panel.
 */

import { useLayoutStore } from '@stores/layoutStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import type { EffectType } from '@core/effects/effects';
import { addEffectEdit } from './effectEdits';

export function revealEffectControls(): void {
  useLayoutStore.getState().openPanel('effectControls');
}

/**
 * Show the selected layer's effect stack where it now lives by default: the
 * Effects section of the Properties panel (2026-09-15). Effect Controls became
 * an on-demand panel, so opening it after every add would dock a panel the
 * user closed. The section's open state is the persisted `inspectorSections`
 * preference, so forcing it open survives the panel remounting.
 */
export function revealEffectsInProperties(): void {
  const prefs = usePreferenceStore.getState();
  prefs.set('inspectorSections', { ...prefs.inspectorSections, effects: true });
  useLayoutStore.getState().openPanel('properties');
}

/** Add an effect to a layer (ONE engine entry) and bring its parameters on screen in Properties. */
export function addEffectAndReveal(nodeId: string, type: EffectType): void {
  void addEffectEdit([nodeId], type);
  revealEffectsInProperties();
}
