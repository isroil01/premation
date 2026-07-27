/**
 * Scene revision store.
 *
 * The scene graph is a plain (non-reactive) data structure. UI that derives
 * from it (the Scene tree) subscribes to this revision counter and recomputes
 * when it changes. Any mutation to the graph should call `bumpScene()`.
 */

import { create } from 'zustand';
import { getEventBus } from '@core/events/EventBus';

interface SceneRevisionState {
  rev: number;
  bump(): void;
}

export const useSceneRevision = create<SceneRevisionState>((set) => ({
  rev: 0,
  bump: () => {
    set((s) => ({ rev: s.rev + 1 }));
    // Static import, emitted synchronously. This used to be a dynamic
    // `import(...).then(...)` per call: an extra promise allocation 30-60×/s
    // during a drag, and — worse — it made `SceneGraphChanged` land a microtask
    // AFTER the revision bump, so handlers that read `rev` saw an ordering that
    // lagged the event. EventBus imports nothing from the stores, so there is no
    // cycle to dodge.
    getEventBus().emit('SceneGraphChanged', undefined);
  },
}));

/** Non-hook helper to bump the revision from anywhere. */
export function bumpScene(): void {
  useSceneRevision.getState().bump();
}
