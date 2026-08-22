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
import { addEffect, type EffectType } from '@core/effects/effects';

export function revealEffectControls(): void {
  useLayoutStore.getState().openPanel('effectControls');
}

/** Add an effect to a layer and switch the left sidebar to its controls. */
export function addEffectAndReveal(nodeId: string, type: EffectType): void {
  addEffect(nodeId, type);
  revealEffectControls();
}
