/**
 * The native SDK plugins the engine found, for the Plugins page and panel.
 *
 * Asks the engine (`listPlugins`) on mount and on `refresh()` — after the user
 * copies a plugin into the folder and restarts, or presses Refresh. Loaded or
 * not, every plugin the engine saw is listed, with the reason when one failed.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { engine } from '@core/engine/engineInstance';
import {
  isRegistryNoticeDismissed,
  listNativePlugins,
  subscribeRegistryNotice,
  type NativePlugin,
} from '@core/nativePlugins/nativePlugins';

export interface NativePluginsState {
  /** Null until the first answer. */
  plugins: NativePlugin[] | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

export function useNativePlugins(): NativePluginsState {
  const [plugins, setPlugins] = useState<NativePlugin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);

  const refresh = useCallback(() => {
    setLoading(true);
    void listNativePlugins(engine()).then((res) => {
      if (!alive.current) return;
      if (res.ok) {
        setPlugins(res.plugins);
        setError(null);
      } else {
        setError(res.error);
      }
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    alive.current = true;
    refresh();
    return () => { alive.current = false; };
  }, [refresh]);

  return { plugins, error, loading, refresh };
}

/** Whether the "registry plugins aren't supported yet" notice was closed (per user, persisted). */
export function useRegistryNoticeDismissed(): boolean {
  return useSyncExternalStore(subscribeRegistryNotice, isRegistryNoticeDismissed, () => false);
}
