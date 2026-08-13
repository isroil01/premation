/**
 * Which effect's on-canvas handles are showing.
 *
 * Kept out of `selectionStore` for the reason `faceSelectionStore` is: an
 * effect is not a scene node, it is a sub-selection WITHIN the selected layer,
 * and folding synthetic ids into the layer selection breaks everything that
 * assumes a selection id names a real node.
 *
 * The overlay appears ONLY when an effect with handles is selected in the
 * stack, which is the AE behaviour and, more practically, the only way twelve
 * Bezier Warp points and four Corner Pin points can coexist on one layer
 * without the canvas becoming unusable.
 */

import { create } from 'zustand';

interface EffectHandleStore {
  /** The layer whose effect is selected. */
  nodeId: string | null;
  /** The effect within that layer. */
  effectId: string | null;
  select: (nodeId: string, effectId: string) => void;
  clear: () => void;
  /** True when this exact effect owns the visible handles. */
  isActive: (nodeId: string, effectId: string) => boolean;
}

export const useEffectHandleStore = create<EffectHandleStore>((set, get) => ({
  nodeId: null,
  effectId: null,
  select: (nodeId, effectId) => set({ nodeId, effectId }),
  clear: () => set({ nodeId: null, effectId: null }),
  isActive: (nodeId, effectId) => {
    const s = get();
    return s.nodeId === nodeId && s.effectId === effectId;
  },
}));
