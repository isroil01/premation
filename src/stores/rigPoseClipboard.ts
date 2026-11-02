import { create } from 'zustand';
import type { RigPoseValues } from '@core/rig/poseMirror';

interface RigPoseClipboardState {
  /** The copied pose, by bone id, so it pastes at any time and onto any rig that shares the ids. */
  pose: RigPoseValues | null;
  copy(pose: RigPoseValues): void;
  clear(): void;
}

/** The Copy Pose clipboard: editor state, it never enters the project. */
export const useRigPoseClipboard = create<RigPoseClipboardState>((set) => ({
  pose: null,
  copy: (pose) => set({ pose }),
  clear: () => set({ pose: null }),
}));
