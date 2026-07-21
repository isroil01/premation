/**
 * cloudProjectStore — the id of the motion-back project the editor is currently
 * bound to (set by EditorPage when a cloud project is opened at
 * /editor/:projectId).
 *
 * The editor's engines are global singletons, so features that need to know
 * "which cloud project am I editing?" — version history, AI conversation
 * persistence — read it from here rather than threading the route param through
 * the whole tree. It is null when running without a cloud project (e.g. the
 * local scratch editor).
 */

import { create } from 'zustand';

interface CloudProjectState {
  projectId: string | null;
  setProjectId: (id: string | null) => void;
}

export const useCloudProjectStore = create<CloudProjectState>((set) => ({
  projectId: null,
  setProjectId: (id) => set({ projectId: id }),
}));

/** Imperative accessor for non-React callers. */
export function getCloudProjectId(): string | null {
  return useCloudProjectStore.getState().projectId;
}
