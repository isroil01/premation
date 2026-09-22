/**
 * The Object Matte model's install state, as a store.
 *
 * Everything that actually moves bytes — URL checks, the main-process download
 * bridge, the ONNX sniff, the cache round-trip — lives in
 * `@core/tracking/samModelInstall` and reports through a plain status callback.
 * This file is only the zustand shell around it, kept out of `src/core` so the
 * engine never imports zustand (docs/NATIVE_CORE_PLAN.md §4 T0). The module doc
 * over there explains why nothing here is ever automatic.
 */

import { create } from 'zustand';
import { ModelCache } from '@core/tracking/samModelCache';
import {
  cancelSamDownload,
  installSamModel,
  removeSamModel,
  restoreSamModel,
  type ModelStatus,
} from '@core/tracking/samModelInstall';

interface SamModelState {
  status: ModelStatus;
  /** Restore a cached pair and register it. Safe to call repeatedly. */
  restore: () => Promise<void>;
  /** Fetch, cache and register. Rejects nothing — the status carries failure. */
  install: (encoderUrl: string, decoderUrl: string) => Promise<void>;
  /** Forget the cached model and unregister the session. */
  remove: () => Promise<void>;
  /** Abort a download in flight. */
  cancel: () => void;
}

export const useSamModelStore = create<SamModelState>((set) => {
  const setStatus = (status: ModelStatus): void => set({ status });
  return {
    status: { kind: 'absent' },
    restore: () => restoreSamModel(setStatus),
    install: (encoderUrl, decoderUrl) => installSamModel(encoderUrl, decoderUrl, setStatus),
    remove: () => removeSamModel(setStatus),
    cancel: () => cancelSamDownload(),
  };
});

/**
 * Restore a cached model at boot, if there is one.
 *
 * Fire-and-forget and completely silent when nothing is cached: a build that
 * has never installed a model must not pay for this, log about it, or touch the
 * network because of it.
 */
export function restoreSamModelAtBoot(): Promise<void> {
  return ModelCache.get()
    .then((cached) => {
      if (cached) return useSamModelStore.getState().restore();
      return undefined;
    })
    // The boot sequence awaits this to decide whether the bundled model should
    // load instead; a cache read that throws must answer "no user model", not
    // reject the whole chain.
    .catch(() => undefined);
}
