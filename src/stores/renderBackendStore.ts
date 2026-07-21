/**
 * Render-backend runtime state (Phase 5: unified GPU engine).
 *
 * There is no longer a user-selectable backend. This store tracks only the
 * ACTIVE engine kind — useful for the "Software rendering" badge in
 * ViewportHeader — and handles automatic fallback when GPU context init fails.
 *
 * Fallback order (automatic, never user-selectable):
 *   WebGPU → WebGL2 → canvas2d software fallback (badge shown)
 *
 * The 'canvas2d' state here means the GPU failed and the engine fell back to a
 * best-effort CPU compositor path with a visible warning badge.  It is NOT the
 * full Canvas2DBackend (which has been removed); it is the MotionRendererBackend
 * operating with a NullBackend + rasterizer-only software path.
 */

import { create } from 'zustand';
import { getEventBus } from '@core/events/EventBus';

/** The active rendering tier, resolved at init and after EngineError fallbacks. */
export type ActiveRenderTier = 'webgpu' | 'webgl2' | 'null' | 'software';

interface RenderBackendStore {
  /** Current rendering tier.  'software' means GPU unavailable — badge shown. */
  activeTier: ActiveRenderTier;
  /** True when GPU context creation has failed and we are running in software. */
  isSoftwareFallback: boolean;
  _setTier: (t: ActiveRenderTier) => void;
}

export const useRenderBackendStore = create<RenderBackendStore>((set) => ({
  activeTier: 'webgl2',
  isSoftwareFallback: false,
  _setTier: (t) => set({ activeTier: t, isSoftwareFallback: t === 'software' }),
}));

// Automatic tier fallback on EngineError events emitted by MotionRendererBackend.
getEventBus().on('EngineError', (payload) => {
  const store = useRenderBackendStore.getState();
  if (payload.engine === 'motion-webgpu') {
    // eslint-disable-next-line no-console
    console.warn('[renderBackendStore] WebGPU init failed, noting WebGL2 tier.');
    store._setTier('webgl2');
  } else if (payload.engine === 'motion-webgl2') {
    // eslint-disable-next-line no-console
    console.warn('[renderBackendStore] WebGL2 init failed, showing software badge.');
    store._setTier('software');
  }
});
