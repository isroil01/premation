/**
 * Which layer's gradient is being edited ON CANVAS, and which of its stops is
 * selected.
 *
 * Kept out of `selectionStore` for the reason `effectHandleStore` and
 * `faceSelectionStore` are: a colour stop is not a scene node, it is a
 * sub-selection WITHIN the selected layer, and folding a synthetic id into the
 * layer selection breaks everything that assumes a selection id names a real
 * node.
 *
 * ARMED, not automatic. A gradient gizmo that appeared for every selected
 * gradient layer would put a draggable axis across the artwork the moment you
 * clicked a background — and gradient layers are usually the backgrounds. So
 * the editor is switched on deliberately (the "Edit on canvas" toggle in the
 * Appearance panel, or a double-click on the small swatch chip the overlay
 * shows at the layer's centre) and switched off with Escape, the same shape
 * `textEditStore` gives on-canvas text editing.
 *
 * It lives beside the overlay rather than in `src/stores` because it is one
 * view's interaction state — nothing outside this overlay and the one inspector
 * toggle reads it, and it is deliberately NOT part of the document.
 */

import { create } from 'zustand';

interface GradientEditStore {
  /** The layer whose gradient axis is showing, or null when disarmed. */
  nodeId: string | null;
  /**
   * Which fill of the layer's stack is being edited (0 = primary).
   *
   * Multi-fill layers get a numbered chip on the canvas; the index is kept here
   * so switching fills survives a re-render and so the inspector toggle can arm
   * a specific one.
   */
  fillIndex: number;
  /** The stop the next Delete would remove, or null. */
  selectedStopId: string | null;
  arm: (nodeId: string, fillIndex?: number) => void;
  disarm: () => void;
  setFillIndex: (fillIndex: number) => void;
  selectStop: (stopId: string | null) => void;
  /** True when this exact layer owns the visible gradient gizmo. */
  isArmed: (nodeId: string) => boolean;
}

export const useGradientEditStore = create<GradientEditStore>((set, get) => ({
  nodeId: null,
  fillIndex: 0,
  selectedStopId: null,
  // Arming a DIFFERENT layer (or a different fill) drops the stop selection:
  // stop ids are only meaningful inside one fill's list, and a stale one would
  // arm Delete against a stop that is no longer on screen.
  arm: (nodeId, fillIndex = 0) => set({ nodeId, fillIndex, selectedStopId: null }),
  disarm: () => set({ nodeId: null, fillIndex: 0, selectedStopId: null }),
  setFillIndex: (fillIndex) => set({ fillIndex, selectedStopId: null }),
  selectStop: (stopId) => set({ selectedStopId: stopId }),
  isArmed: (nodeId) => get().nodeId === nodeId,
}));
