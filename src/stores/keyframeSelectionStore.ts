/**
 * Keyframe selection — the set of currently-selected keyframe ids
 * (`nodeId::prop@time`, from `makeKeyframeId`). Lifted out of Timeline's local
 * state so other surfaces (the timeline's easing pills, the graph editor) can
 * act on the same selection.
 */

import { create } from 'zustand';

interface KeyframeSelectionStore {
  ids: Set<string>;
  set: (ids: Set<string>) => void;
  clear: () => void;
}

export const useKeyframeSelectionStore = create<KeyframeSelectionStore>((set) => ({
  ids: new Set<string>(),
  set: (ids) => set({ ids: new Set(ids) }),
  clear: () => set({ ids: new Set<string>() }),
}));
