import { create } from 'zustand';

interface RigSelectionState {
  nodeId: string | null;
  /** The primary bone: the LAST of `boneIds` (the weight heatmap, the bone card). */
  boneId: string | null;
  /**
   * The selected bones, in selection order, as `pinIds` is for pins: Shift-click
   * toggles, a marquee adds; "Key selected" and the pose tools read them.
   */
  boneIds: readonly string[];
  controllerId: string | null;
  /**
   * The selected puppet pins (C2 multi-select), in selection order; the LAST is
   * the primary pin (the gizmo, the motion path). Shift-click toggles, a marquee
   * adds; the Rig panel's "Key selected" reads them.
   */
  pinIds: readonly string[];
  selectBone(nodeId: string, boneId: string | null): void;
  /** Replace the bone selection (empty = none). */
  selectBones(nodeId: string, boneIds: readonly string[]): void;
  /** Shift-click: add the bone, or drop it when already selected. */
  toggleBone(nodeId: string, boneId: string): void;
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
  boneIds: [],
  controllerId: null,
  pinIds: [],
  selectBone: (nodeId, boneId) => set({ nodeId, boneId, boneIds: boneId ? [boneId] : [], controllerId: null }),
  selectBones: (nodeId, boneIds) =>
    set({ nodeId, boneId: boneIds[boneIds.length - 1] ?? null, boneIds: [...boneIds], controllerId: null }),
  toggleBone: (nodeId, boneId) => {
    const cur = get().nodeId === nodeId ? get().boneIds : [];
    get().selectBones(nodeId, cur.includes(boneId) ? cur.filter((b) => b !== boneId) : [...cur, boneId]);
  },
  selectPins: (nodeId, pinIds) => set({ nodeId, pinIds: [...pinIds] }),
  togglePin: (nodeId, pinId) => {
    const cur = get().nodeId === nodeId ? get().pinIds : [];
    set({ nodeId, pinIds: cur.includes(pinId) ? cur.filter((p) => p !== pinId) : [...cur, pinId] });
  },
  selectController: (nodeId, controllerId, boneId) => {
    if (boneId === undefined) {
      set({ nodeId, controllerId });
      return;
    }
    // A controller on a bone of a multi-selection keeps it; the bone becomes the primary.
    const cur = get().boneIds;
    const keep = boneId !== null && cur.includes(boneId);
    set({
      nodeId,
      controllerId,
      boneId,
      boneIds: keep ? [...cur.filter((b) => b !== boneId), boneId] : boneId ? [boneId] : [],
    });
  },
  clear: (nodeId) => {
    if (nodeId !== undefined && get().nodeId !== nodeId) return;
    set({ nodeId: null, boneId: null, boneIds: [], controllerId: null, pinIds: [] });
  },
}));

/** The selected pins of `nodeId` (none when the selection belongs to another layer). */
export function selectedRigPins(nodeId: string): readonly string[] {
  const state = useRigSelectionStore.getState();
  return state.nodeId === nodeId ? state.pinIds : [];
}

/** The selected bones of `nodeId` (none when the selection belongs to another layer). */
export function selectedRigBones(nodeId: string): readonly string[] {
  const state = useRigSelectionStore.getState();
  return state.nodeId === nodeId ? state.boneIds : [];
}

export function selectedRigBone(nodeId: string): string | null {
  const state = useRigSelectionStore.getState();
  return state.nodeId === nodeId ? state.boneId : null;
}
