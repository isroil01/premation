/**
 * Dragging a transition onto the timeline (2026-10-07).
 *
 * Transitions are added the way an editor adds them: from the Library's
 * Transitions list, dragged onto the timeline.
 *
 *   • A CUT transition (Cross Dissolve, Dip to Black / White, Wipe — an engine
 *     transition record between two adjacent bars) drops on a cut, the point
 *     where one bar ends and the next begins.
 *   • A LAYER transition (the Library's keyframe recipes) drops on one bar's
 *     start or end and becomes that layer's entrance or exit.
 *
 * The toolbar chips and the "Transitions ▾ at the nearest cut" menu that used
 * to sit in the timeline header are gone: the chips took the header's width
 * and the menu guessed the cut. Double-clicking a cut still adds a Cross
 * Dissolve, and the clip's right-click menu still has Add Transition.
 *
 * Native HTML5 drag: the payloads are private MIME types, so nothing else in
 * the app can be mistaken for them, and the TYPE list is readable during
 * `dragover` (the data is not) — which is how the lanes know what to light.
 */

import { TRANSITION_KINDS } from '@core/timeline/transitionModel';
import type { TransitionKind } from '@core/timeline/transitionModel';

/** A cut transition's drag payload type (the kind is the data). */
export const TRANSITION_DND_TYPE = 'application/x-premation-transition';

/** A Library layer transition's drag payload type (the item id is the data). */
export const LAYER_TRANSITION_DND_TYPE = 'application/x-premation-layer-transition';

/** Start dragging a cut transition (Library card). */
export function startCutTransitionDrag(dataTransfer: DataTransfer, kind: TransitionKind): void {
  dataTransfer.setData(TRANSITION_DND_TYPE, kind);
  dataTransfer.effectAllowed = 'copy';
}

/** Mark a Library recipe drag as a layer transition the timeline can take. */
export function markLayerTransitionDrag(dataTransfer: DataTransfer, transId: string): void {
  dataTransfer.setData(LAYER_TRANSITION_DND_TYPE, transId);
}

/** A dropped cut transition's kind, or null when the drop is not one. */
export function readTransitionDrag(dataTransfer: DataTransfer | null): TransitionKind | null {
  if (!dataTransfer) return null;
  const raw = dataTransfer.getData(TRANSITION_DND_TYPE);
  return (TRANSITION_KINDS as ReadonlyArray<string>).includes(raw) ? (raw as TransitionKind) : null;
}

/** True while a cut transition is being dragged (safe during `dragover`). */
export function isTransitionDrag(dataTransfer: DataTransfer | null): boolean {
  return !!dataTransfer && Array.from(dataTransfer.types).includes(TRANSITION_DND_TYPE);
}

/** A dropped layer transition's Library item id, or null. */
export function readLayerTransitionDrag(dataTransfer: DataTransfer | null): string | null {
  if (!dataTransfer) return null;
  const raw = dataTransfer.getData(LAYER_TRANSITION_DND_TYPE);
  return raw || null;
}

/** True while a Library layer transition is being dragged (safe during `dragover`). */
export function isLayerTransitionDrag(dataTransfer: DataTransfer | null): boolean {
  return !!dataTransfer && Array.from(dataTransfer.types).includes(LAYER_TRANSITION_DND_TYPE);
}
