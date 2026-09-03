/**
 * Whether the viewport draws the camera's focus plane, and what a live focus
 * pull currently reads.
 *
 * Its own store for the reason `effectHandleStore` is: this is a viewport
 * sub-selection state — which camera's focus is being manipulated — not a scene
 * selection, and folding a synthetic "the focus plane of node X" entry into
 * `selectionStore` breaks everything that assumes a selection id names a node.
 *
 * `visibility` is deliberately three-valued rather than a boolean:
 *
 *  • `selected` — the plane appears when a camera with DOF on is SELECTED. The
 *    conservative reading of "show me where focus is": you asked about this
 *    camera, so here is its focus.
 *  • `always` — also for the composition's ACTIVE camera, selected or not, so a
 *    Top/Left view stays a focus-pulling view while you keep a subject layer
 *    selected. This is the default, because in an ortho view the plane is the
 *    only thing on screen that says where focus is at all, and a camera with
 *    depth of field switched on has already opted into caring.
 *  • `off` — never.
 *
 * The plane is suppressed regardless for the camera a view looks THROUGH: its
 * cross-section there is exactly the comp frame and its axis projects to a
 * point, so it would draw a rectangle on the comp edges that cannot be dragged.
 */

import { create } from 'zustand';

export type FocusPlaneVisibility = 'off' | 'selected' | 'always';

interface FocusPlaneStore {
  visibility: FocusPlaneVisibility;
  setVisibility: (v: FocusPlaneVisibility) => void;
  /** Cycle off → selected → always → off, for a menu item or shortcut. */
  cycleVisibility: () => void;
  /**
   * Focus distance while a drag is in flight, for the HUD — null when idle.
   *
   * In the store rather than in the overlay's own state so anything else that
   * wants to show the live value (an inspector field lighting up, a future
   * readout in the transport) can read it without the overlay having to
   * publish it a second way.
   */
  dragDistance: number | null;
  setDragDistance: (d: number | null) => void;
}

const NEXT: Record<FocusPlaneVisibility, FocusPlaneVisibility> = {
  off: 'selected',
  selected: 'always',
  always: 'off',
};

export const useFocusPlaneStore = create<FocusPlaneStore>((set, get) => ({
  visibility: 'always',
  setVisibility: (visibility) => set({ visibility }),
  cycleVisibility: () => set({ visibility: NEXT[get().visibility] }),
  dragDistance: null,
  setDragDistance: (dragDistance) => set({ dragDistance }),
}));
