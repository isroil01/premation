/**
 * Scene revision store.
 *
 * The scene graph is a plain (non-reactive) data structure. UI that derives
 * from it (the Scene tree) subscribes to this revision counter and recomputes
 * when it changes. Any mutation to the graph should call `bumpScene()`.
 */

import { create } from 'zustand';

interface SceneRevisionState {
  rev: number;
  bump(): void;
}

export const useSceneRevision = create<SceneRevisionState>((set) => ({
  rev: 0,
  bump: () => set((s) => ({ rev: s.rev + 1 })),
}));

/** Non-hook helper to bump the revision from anywhere. */
export function bumpScene(): void {
  useSceneRevision.getState().bump();
}
