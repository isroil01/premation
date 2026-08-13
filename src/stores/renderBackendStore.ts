/**
 * Render-backend runtime state (Phase 5: unified GPU engine).
 *
 * There is no longer a user-selectable backend. This store tracks only the
 * ACTIVE engine kind — useful for the "Software rendering" badge in
 * ViewportHeader — and handles automatic fallback when GPU context init fails.
 *
 * Fallback order (automatic, never user-selectable):
 *   WebGPU → WebGL2 → WebGL2 retry after 250ms
 *
 * There is NO CPU fallback tier. This block used to claim one ("canvas2d software
 * fallback", "rasterizer-only software path"), but `MotionRendererBackend` says the
 * opposite in as many words: NullBackend produces no pixels, so it is deliberately
 * not a tier, and total failure is reported via `initFailed`. Canvas2DBackend was
 * removed in Phase 5. So the `'software'` tier does not mean "slower but working" —
 * it means the viewport cannot paint at all, which is why the badge that surfaces
 * it must not promise a CPU renderer.
 */

import { create } from 'zustand';
import { getEventBus } from '@core/events/EventBus';

/** The active rendering tier, resolved at init and after EngineError fallbacks.
 *  'pending' = attach has not reported an EngineReady/EngineError yet. */
export type ActiveRenderTier = 'pending' | 'webgpu' | 'webgl2' | 'null' | 'software';

interface RenderBackendStore {
  /** Current rendering tier.  'software' means GPU unavailable — badge shown. */
  activeTier: ActiveRenderTier;
  /** True when GPU context creation has failed and we are running in software. */
  isSoftwareFallback: boolean;
  _setTier: (t: ActiveRenderTier) => void;
}

export const useRenderBackendStore = create<RenderBackendStore>((set) => ({
  // 'pending', NOT 'webgl2'. WebGPU is the primary engine and the one the
  // backend attempts first, so seeding the store with the FALLBACK tier stated
  // the opposite of what the app does — and it is indistinguishable from a real
  // resolved answer, so anything reading the tier before EngineReady lands (a
  // badge, telemetry, a bug report) was told "WebGL2" on a machine that then
  // ran WebGPU. An explicit unresolved state can't be mistaken for a result.
  activeTier: 'pending',
  isSoftwareFallback: false,
  _setTier: (t) => set({ activeTier: t, isSoftwareFallback: t === 'software' }),
}));

// Automatic tier fallback on EngineError events emitted by MotionRendererBackend.
// The backend itself now performs the ACTUAL recovery (disposing the failed
// backend and re-initializing on the next tier, incl. a delayed WebGL2 retry);
// this store just mirrors the state for the ViewportHeader badge.
getEventBus().on('EngineError', (payload) => {
  // Only the MAIN viewport may set this badge. `role` is optional in the event
  // contract, so test it for the positive case — treating an omitted role as
  // "viewport" is how thumbnails, exports and secondary panes flipped a global
  // badge while the main viewport was happily on hardware WebGL2.
  if (payload.role !== 'viewport') return;
  const store = useRenderBackendStore.getState();
  if (payload.engine === 'motion-webgpu') {

    console.warn('[renderBackendStore] WebGPU init failed, noting WebGL2 tier.');
    store._setTier('webgl2');
  } else if (payload.engine === 'motion-webgl2') {

    console.warn('[renderBackendStore] WebGL2 init failed, showing software badge.');
    store._setTier('software');
  }
});

// A successful init (including a fallback tier or the delayed WebGL2 retry
// coming up AFTER an EngineError already flipped the badge) reports the tier
// that actually rendered — this un-sticks a premature 'software' badge.
getEventBus().on('EngineReady', (payload) => {
  if (payload.role !== 'viewport') return;
  const store = useRenderBackendStore.getState();
  if (payload.engine === 'motion-webgpu') store._setTier('webgpu');
  else if (payload.engine === 'motion-webgl2') store._setTier('webgl2');
  else if (payload.engine === 'motion-null') store._setTier('null');
});
