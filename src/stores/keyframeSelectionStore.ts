/**
 * Keyframe selection — the set of currently-selected keyframe ids: the
 * ENGINE's keyframe id of each selected diamond, with its layer and (for a
 * member row) its member index. The codec is `core/mirror/keySelection.ts`;
 * decode with it rather than splitting by hand. Lifted out of Timeline's local
 * state so other surfaces (the timeline's easing pills, the graph editor) can
 * act on the same selection.
 */

import { create } from 'zustand';
import { selectionLayerOf } from '@core/mirror/keySelection';

interface KeyframeSelectionStore {
  ids: Set<string>;
  set: (ids: Set<string>) => void;
  clear: () => void;
}

/** Same members, in any order. */
export function sameIdSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

export const useKeyframeSelectionStore = create<KeyframeSelectionStore>((set, get) => ({
  ids: new Set<string>(),
  // Identity changes ONLY when membership does. A marquee drag calls this at
  // pointer rate with the same members almost every time, and every row of
  // the timeline compares the Set by identity to decide whether to re-render
  // — so a fresh Set per move re-rendered every visible row per move.
  set: (ids) => {
    if (sameIdSet(get().ids, ids)) return;
    set({ ids: new Set(ids) });
  },
  clear: () => {
    if (get().ids.size === 0) return;
    set({ ids: new Set<string>() });
  },
}));

export function pruneKeyframeSelectionToNodes(nodeIds: ReadonlySet<string>): void {
  useKeyframeSelectionStore.setState((s) => {
    const ids = new Set(
      [...s.ids].filter((id) => {
        const layer = selectionLayerOf(id);
        return layer !== null && nodeIds.has(layer);
      }),
    );
    return ids.size === s.ids.size ? s : { ids };
  });
}
