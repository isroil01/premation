/**
 * The selected rig VERTEX — shared between the canvas and the Rigging panel.
 *
 * Vertex selection has to be a store rather than component state because the two
 * halves of the numeric weight editor live in different trees: you pick the
 * vertex on the canvas (`BoneOverlay`), and you read and edit its per-bone
 * weights in the inspector (`BoneControls`). `selectedBoneId` next door is local
 * `useState` precisely because nothing outside the overlay needs it.
 *
 * The node id is stored WITH the index, and that pairing is the point. A vertex
 * index is meaningless on its own: index 40 addresses a different part of the
 * artwork on every layer, and a different part of the SAME layer once the mesh
 * density changes. Keeping them together means a stale selection can be detected
 * (`isVertexSelected`) instead of silently editing weights on the wrong layer.
 */

import { create } from 'zustand';

interface RigVertexStore {
  nodeId: string | null;
  vertexIndex: number | null;
  select: (nodeId: string, vertexIndex: number) => void;
  clear: () => void;
}

export const useRigVertexStore = create<RigVertexStore>((set) => ({
  nodeId: null,
  vertexIndex: null,
  select: (nodeId, vertexIndex) => set({ nodeId, vertexIndex }),
  clear: () => set({ nodeId: null, vertexIndex: null }),
}));

export const selectRigVertex = (nodeId: string, vertexIndex: number): void =>
  useRigVertexStore.getState().select(nodeId, vertexIndex);

export const clearRigVertex = (): void => useRigVertexStore.getState().clear();

/**
 * The selected index FOR THIS NODE, or null.
 *
 * Returns null for a selection belonging to another layer rather than the raw
 * index, so a panel cannot read a neighbour's selection as its own — the guard
 * is in the reader, where every caller gets it, rather than at each call site.
 */
export function useRigVertexSelection(nodeId: string): number | null {
  const sel = useRigVertexStore((s) => (s.nodeId === nodeId ? s.vertexIndex : null));
  return sel;
}

/** Non-reactive variant, for event handlers and tests. */
export function rigVertexSelection(nodeId: string): number | null {
  const s = useRigVertexStore.getState();
  return s.nodeId === nodeId ? s.vertexIndex : null;
}
