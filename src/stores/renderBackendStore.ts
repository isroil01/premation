/**
 * Render-backend selection (Canvas2D ↔ GPU). Wraps the persisted
 * `rendering.backend` setting so a UI control can flip it and the viewport
 * re-mounts onto the chosen backend. The choice is included in useWorkspace's
 * mount-effect deps, so changing it here rebuilds the backend live.
 *
 * NOTE: the GPU (WebGL2) path is EXPERIMENTAL — shapes + images render, but text
 * and video are placeholder quads and effects/masks/precomps are not composited
 * yet (staged swap S2b/S3). Canvas2D stays the default.
 */

import { create } from 'zustand';
import {
  resolveBackendChoice,
  setRenderBackendChoice,
  type BackendChoice,
} from '@core/rendering/createRenderBackend';

interface RenderBackendStore {
  choice: BackendChoice;
  setChoice: (c: BackendChoice) => void;
  /** Flip between the reference Canvas2D backend and the experimental GPU one. */
  toggle: () => void;
}

export const useRenderBackendStore = create<RenderBackendStore>((set, get) => ({
  choice: resolveBackendChoice(),
  setChoice: (c) => {
    setRenderBackendChoice(c); // persist via SettingsManager
    set({ choice: c });
  },
  toggle: () => {
    const next: BackendChoice = get().choice === 'canvas2d' ? 'webgl2' : 'canvas2d';
    get().setChoice(next);
  },
}));
