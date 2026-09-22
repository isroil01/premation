/**
 * The stagger SETTINGS — the pattern a multi-row offset uses, and how coarse
 * the live drag gesture is.
 *
 * ## Why a store rather than an argument
 *
 * A stagger is reachable two ways, and they have to agree. The dialog
 * ("Stagger Selected…") is where you set a pattern deliberately and type an
 * exact amount; the Ctrl-drag over a group of selected bars is where you dial
 * one by feel. If the drag hard-coded a pattern, choosing "Zigzag" in the
 * dialog and then reaching for the drag would silently give you a cascade, and
 * the two entry points would be two features that happen to share a name.
 *
 * So the MODE lives here and both read it: the dialog writes it when you pick
 * one, the drag renders it in its badge, and whatever you used last is what the
 * gesture does next time. The AMOUNT deliberately does NOT live here — the drag
 * takes it from the pointer and the dialog takes it from a field, and
 * remembering it across the two would make the gesture start from a number the
 * user cannot see.
 *
 * ## Why its own store rather than the preference store
 *
 * `preferenceStore` is persisted user settings. This is a working mode, like
 * the timeline's edit mode next door: it should survive a panel re-render and
 * a comp switch, and it is not something anyone wants restored from disk three
 * weeks later having forgotten they ever set it.
 */

import { create } from 'zustand';
import type { StaggerMode } from '@core/animation/staggerOffsets';

/**
 * Vertical pointer travel, in pixels, worth one frame of stagger step.
 *
 * Tuned to the same feel as the row-height grip next door: enough travel that
 * a flick does not cross the whole useful range, little enough that a common
 * 2–6 frame trail is reachable without dragging off the panel. A full row
 * height (28px) is about two frames, which is also a usable mental model —
 * "one row down per two frames of delay".
 */
export const STAGGER_PX_PER_FRAME = 14;

interface StaggerStore {
  mode: StaggerMode;
  /** Walk the rows bottom-to-top instead of top-to-bottom. */
  reverse: boolean;
  setMode: (mode: StaggerMode) => void;
  setReverse: (reverse: boolean) => void;
}

export const useStaggerStore = create<StaggerStore>((set) => ({
  mode: 'cascade',
  reverse: false,
  setMode: (mode) => set({ mode }),
  setReverse: (reverse) => set({ reverse }),
}));

/** Read outside React — drag handlers run in listeners, not in render. */
export function getStaggerSettings(): { mode: StaggerMode; reverse: boolean } {
  const { mode, reverse } = useStaggerStore.getState();
  return { mode, reverse };
}
