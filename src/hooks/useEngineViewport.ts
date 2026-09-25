/**
 * useEngineViewportActive — are the C++ engine's frames the viewport right now
 * (NATIVE_CORE_PLAN §5 D5: the owner flag is on and the process backend has
 * not fallen back)? Re-renders only when that changes (boot, a fallback).
 */

import { useSyncExternalStore } from 'react';
import { engineViewportActive, subscribeEngineOwnership } from '@core/engine/engineOwnership';

export function useEngineViewportActive(): boolean {
  return useSyncExternalStore(subscribeEngineOwnership, engineViewportActive, () => false);
}
