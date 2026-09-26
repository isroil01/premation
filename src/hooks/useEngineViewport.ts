/**
 * useEngineViewportActive — are the C++ engine's frames the viewport right now
 * (NATIVE_CORE_PLAN §5 D5: the owner flag is on and the process backend has
 * not fallen back)? Re-renders only when that changes (boot, a fallback).
 */

import { useSyncExternalStore } from 'react';
import { engineOwnsDocumentNow, engineViewportActive, subscribeEngineOwnership } from '@core/engine/engineOwnership';

export function useEngineViewportActive(): boolean {
  return useSyncExternalStore(subscribeEngineOwnership, engineViewportActive, () => false);
}

/** F2: does the C++ engine own the document (the owner flag, decided at boot)? */
export function useEngineOwnsDocument(): boolean {
  return useSyncExternalStore(subscribeEngineOwnership, engineOwnsDocumentNow, () => false);
}
