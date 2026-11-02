import { create } from 'zustand';

interface RigSelectionState {
  nodeId: string | null;
  boneId: string | null;
  controllerId: string | null;
  /**
   * The selected puppet pins (C2 multi-select), in selection order; the LAST is
   * the primary pin (the gizmo, the motion path). Shift-click toggles, a marquee
   * adds; the Rig panel's "Key selected" reads them.
   */
  pinIds: readonly string[];
  selectBone(nodeId: string, boneId: string | null): void;
  /** Replace the pin selection (empty = none). */
  selectPins(nodeId: string, pinIds: readonly string[]): void;
  /** Shift-click: add the pin, or drop it when already selected. */
  togglePin(nodeId: string, pinId: string): void;
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
  pinIds: [],
  selectBone: (nodeId, boneId) => set({ nodeId, boneId, controllerId: null }),
  selectPins: (nodeId, pinIds) => set({ nodeId, pinIds: [...pinIds] }),
  togglePin: (nodeId, pinId) => {
    const cur = get().nodeId === nodeId ? get().pinIds : [];
    set({ nodeId, pinIds: cur.includes(pinId) ? cur.filter((p) => p !== pinId) : [...cur, pinId] });
  },
  selectController: (nodeId, controllerId, boneId) =>
    set({
      nodeId,
      controllerId,
      boneId: boneId === undefined ? get().boneId : boneId,
    }),
  clear: (nodeId) => {
    if (nodeId !== undefined && get().nodeId !== nodeId) return;
    set({ nodeId: null, boneId: null, controllerId: null, pinIds: [] });
  },
}));

/** The selected pins of `nodeId` (none when the selection belongs to another layer). */
export function selectedRigPins(nodeId: string): readonly string[] {
  const state = useRigSelectionStore.getState();
  return state.nodeId === nodeId ? state.pinIds : [];
}

export function selectedRigBone(nodeId: string): string | null {
  const state = useRigSelectionStore.getState();
  return state.nodeId === nodeId ? state.boneId : null;
}
