/**
 * The Object Matte model's install state, as a store.
 *
 * Everything that actually moves bytes — URL checks, the main-process
 * installer that saves the model where the engine reads it — lives in
 * `@core/tracking/samModelInstall` and reports through a plain status callback.
 * This file is only the zustand shell around it, kept out of `src/core` so the
 * engine never imports zustand (docs/NATIVE_CORE_PLAN.md §4 T0). The module doc
 * over there explains why nothing here is ever automatic.
 */

import { create } from 'zustand';
import {
  cancelSamDownload,
  installSamModel,
  removeSamModel,
  restoreSamModel,
  type ModelStatus,
} from '@core/tracking/samModelInstall';

interface SamModelState {
  status: ModelStatus;
  /** Read what is installed. Safe to call repeatedly; no network. */
  restore: () => Promise<void>;
  /** Download and install for the engine. Rejects nothing — the status carries failure. */
  install: (encoderUrl: string, decoderUrl: string) => Promise<void>;
  /** Remove the installed model (the engine goes back to the bundled one). */
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
