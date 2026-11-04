/**
 * Which layers have Scale's Constrain Proportions switched off, read by the
 * timeline row and the inspector so both show and obey the same link.
 *
 * Editor state: it decides how an edit is applied and is not part of what
 * renders, so it stays out of the project document (CLAUDE.md, Layering). Only
 * the unlinked layers are kept, because linked is the default.
 *
 * Saved per project file by core/project/editorView.ts and replaced whenever a
 * project opens. Layer ids are only unique inside a project (every project has
 * a `layer_1`), so a list kept across projects would unlink the wrong layers.
 */

import { create } from 'zustand';

interface ScaleLinkState {
  unlinked: ReadonlySet<string>;
  toggle: (nodeId: string) => void;
  /** Swap in another project's list. */
  replace: (nodeIds: ReadonlyArray<string>) => void;
}

export const useScaleLinkStore = create<ScaleLinkState>((set) => ({
  unlinked: new Set<string>(),
  toggle: (nodeId) => set((s) => {
    const unlinked = new Set(s.unlinked);
    if (!unlinked.delete(nodeId)) unlinked.add(nodeId);
    return { unlinked };
  }),
  replace: (nodeIds) => set({ unlinked: new Set(nodeIds) }),
}));

/** Whether a layer's Scale dimensions move together. */
export function isScaleLinked(nodeId: string): boolean {
  return !useScaleLinkStore.getState().unlinked.has(nodeId);
}

/** The same, for a component that redraws when the link flips. */
export function useScaleLinked(nodeId: string): boolean {
  return useScaleLinkStore((s) => !s.unlinked.has(nodeId));
}
