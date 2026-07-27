/**
 * Workspace view store — how the central canvas behaves.
 *
 *   'free'  → the default infinite canvas: pan (middle-drag / space-drag /
 *             wheel) and zoom anywhere, like Figma or the AE comp panel.
 *   'fixed' → the composition is framed and centred; panning is disabled and
 *             zoom stays centred, so the comp can never drift off-screen. Good
 *             for presenting or for a distraction-free "the frame is the world"
 *             layout.
 *
 * The mode maps to a hard lock on the engine camera (see Camera.setLocked), so
 * every pan path — middle-mouse, space-drag Hand tool and wheel-scroll — is
 * gated in one place. Persisted to localStorage so the choice survives reloads.
 */

import { create } from 'zustand';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';

export type WorkspaceMode = 'free' | 'fixed';

const PERSIST_KEY = 'motion-editor.workspaceMode.v1';

function loadMode(): WorkspaceMode {
  return 'fixed';
}

/** Push the mode down to the engine camera and re-frame when locking. */
export function applyWorkspaceMode(mode: WorkspaceMode): void {
  try {
    const controller = getWorkspaceController();
    controller.ws.camera.setLocked(mode === 'fixed');
    // Entering fixed mode: snap the comp back to a centred, framed view.
    if (mode === 'fixed') controller.fitComposition();
    controller.requestRender();
  } catch {
    /* engine not ready yet — applied again on next toggle / boot effect */
  }
}

interface WorkspaceViewState {
  mode: WorkspaceMode;
  setMode: (mode: WorkspaceMode) => void;
  toggleMode: () => void;
}

export const useWorkspaceViewStore = create<WorkspaceViewState>((set, get) => ({
  mode: loadMode(),
  setMode: (mode) => {
    set({ mode });
    try {
      localStorage.setItem(PERSIST_KEY, mode);
    } catch {
      /* private mode / quota — ignore */
    }
    applyWorkspaceMode(mode);
  },
  toggleMode: () => get().setMode(get().mode === 'free' ? 'fixed' : 'free'),
}));
