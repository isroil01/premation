import { create } from 'zustand';

interface RigSelectionState {
  nodeId: string | null;
  boneId: string | null;
  controllerId: string | null;
  selectBone(nodeId: string, boneId: string | null): void;
  selectController(nodeId: string, controllerId: string | null, boneId?: string | null): void;
  clear(nodeId?: string): void;
}

/**
 * Shared selection for canvas rig handles and the Rig inspector.
 *
 * BoneOverlay previously kept both ids in local React state, so selecting a
 * joint on canvas could not focus its inspector row and selecting a row could
 * not reveal the corresponding canvas handle.
 */
export const useRigSelectionStore = create<RigSelectionState>((set, get) => ({
  nodeId: null,
  boneId: null,
  controllerId: null,
  selectBone: (nodeId, boneId) => set({ nodeId, boneId, controllerId: null }),
  selectController: (nodeId, controllerId, boneId) =>
    set({
      nodeId,
      controllerId,
      boneId: boneId === undefined ? get().boneId : boneId,
    }),
  clear: (nodeId) => {
    if (nodeId !== undefined && get().nodeId !== nodeId) return;
    set({ nodeId: null, boneId: null, controllerId: null });
  },
}));

export function selectedRigBone(nodeId: string): string | null {
  const state = useRigSelectionStore.getState();
  return state.nodeId === nodeId ? state.boneId : null;
}
