/**
 * Face selection — which SIDE of an extruded 3D object is being edited.
 *
 * Kept separate from `selectionStore` on purpose: a face is not a scene node, it
 * is a sub-selection WITHIN the selected layer. Folding synthetic face ids into
 * the layer selection would break everything that assumes a selection id names a
 * real node (parenting, deletion, the timeline, undo).
 *
 * `enabled` is a MODE, not a persistent state: normal clicks must keep selecting
 * layers, exactly as in AE where sub-object editing is something you opt into.
 */

import { create } from 'zustand';
import type { FaceKind } from '@core/scene/faceMaterials';

interface FaceSelectionStore {
  /** Face-select mode is armed (clicks pick a face instead of a layer). */
  enabled: boolean;
  /** The layer whose face is selected — cleared when the layer selection moves. */
  nodeId: string | null;
  /** Which material group the picked face belongs to. */
  kind: FaceKind | null;
  /** Renderer face suffix, for highlighting the exact quad that was clicked. */
  suffix: string | null;
  setEnabled: (on: boolean) => void;
  toggle: () => void;
  select: (nodeId: string, kind: FaceKind, suffix: string) => void;
  clear: () => void;
}

export const useFaceSelectionStore = create<FaceSelectionStore>((set) => ({
  enabled: false,
  nodeId: null,
  kind: null,
  suffix: null,
  // Leaving the mode drops the sub-selection: a highlighted face with no way to
  // change it just looks broken.
  setEnabled: (on) => set(on ? { enabled: true } : { enabled: false, nodeId: null, kind: null, suffix: null }),
  toggle: () => set((s) => (s.enabled
    ? { enabled: false, nodeId: null, kind: null, suffix: null }
    : { enabled: true })),
  select: (nodeId, kind, suffix) => set({ nodeId, kind, suffix }),
  clear: () => set({ nodeId: null, kind: null, suffix: null }),
}));
