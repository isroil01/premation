/**
 * SVG-related user preferences, read imperatively.
 *
 * A thin accessor so the conversion logic can ask the question without pulling
 * a React store hook into non-React code — and so a test can state the answer
 * it wants without standing up the store.
 */

import { usePreferenceStore, DEFAULT_PREFERENCES } from '@stores/preferenceStore';

/** Keep the original markup on a layer after Convert to Editable Shapes (§13). */
export function getRetainOriginalSvg(): boolean {
  try {
    return usePreferenceStore.getState().retainOriginalSvg;
  } catch {
    // Store not initialized (headless / unit test) — the default is the safe
    // answer, since losing the source is the irreversible direction.
    return DEFAULT_PREFERENCES.retainOriginalSvg;
  }
}
