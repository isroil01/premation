/**
 * Keyframe selection — the set of currently-selected keyframe ids
 * (`nodeId::prop::t`, from `makeKeyframeId`; decode with `parseKeyframeId`
 * rather than splitting by hand). Lifted out of Timeline's local
 * state so other surfaces (the timeline's easing pills, the graph editor) can
 * act on the same selection.
 */

import { create } from 'zustand';
import { parseKeyframeId } from '@motion/animation';

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

export function pruneKeyframeSelectionToNodes(nodeIds: ReadonlySet<string>): void {
  useKeyframeSelectionStore.setState((s) => {
    const ids = new Set(
      [...s.ids].filter((id) => {
        const ref = parseKeyframeId(id);
        return ref !== null && nodeIds.has(ref.nodeId);
      }),
    );
    return ids.size === s.ids.size ? s : { ids };
  });
}
