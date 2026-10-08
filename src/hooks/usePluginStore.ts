/**
 * The plugin store for the Plugins page and panel: what the store lists, what
 * this machine has installed (Electron main's state), what the engine loaded,
 * and the updates between them. Every action goes through
 * core/nativePlugins/pluginStore.ts (main installs, the engine rescans).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type StorePluginSummary, type StorePluginUpdate } from '@core/api/client';
import { engine } from '@core/engine/engineInstance';
import {
  checkPremationCloud,
  installFromStore,
  installedPlugins,
  setPluginEnabled,
  uninstallPlugin,
} from '@core/nativePlugins/pluginStore';
import type { NativePluginStoreState } from '@/types/motionEditor';

export interface PluginStoreBrowse {
  items: StorePluginSummary[] | null;
  total: number;
  error: string | null;
  loading: boolean;
}

/** Search the store's native plugins (debounced by the caller's SearchField). */
export function useStoreBrowse(q: string): PluginStoreBrowse & { reload: () => void } {
  const [state, setState] = useState<PluginStoreBrowse>({ items: null, total: 0, error: null, loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    api.browseNativePlugins({ q: q.trim() || undefined, limit: 50 })
      .then((page) => { if (alive) setState({ items: page.items, total: page.total, error: null, loading: false }); })
      .catch((e: unknown) => {
        if (alive) setState({ items: null, total: 0, error: e instanceof Error ? e.message : 'The plugin store is unreachable.', loading: false });
      });
    return () => { alive = false; };
  }, [q, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

export interface InstalledState {
  installed: NativePluginStoreState | null;
  updates: Map<string, StorePluginUpdate>;
  busy: string | null;
  message: { text: string; error: boolean } | null;
  refresh: () => void;
  install: (id: string, version: string, owner?: boolean) => Promise<void>;
  uninstall: (id: string) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** Premation Cloud: refresh the entitlement now (a locked plugin's "Check plan"). */
  checkPlan: () => Promise<void>;
  clearMessage: () => void;
}

/** Main's installed set, store updates for it, and the install / uninstall / enable actions. */
export function useInstalledPlugins(onEngineChange?: () => void): InstalledState {
  const [installed, setInstalled] = useState<NativePluginStoreState | null>(null);
  const [updates, setUpdates] = useState<Map<string, StorePluginUpdate>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const alive = useRef(true);
  const onChange = useRef(onEngineChange);
  onChange.current = onEngineChange;

  const refresh = useCallback(() => {
    void installedPlugins().then(async (state) => {
      if (!alive.current) return;
      setInstalled(state);
      const list = state ? Object.entries(state.plugins).map(([id, p]) => ({ id, version: p.version })) : [];
      if (list.length === 0) {
        setUpdates(new Map());
        return;
      }
      try {
        const found = await api.checkPluginUpdates(list);
        if (!alive.current) return;
        const newer = new Map<string, StorePluginUpdate>();
        for (const u of found) {
          const mine = state?.plugins[u.id];
          if (mine && u.kind === 'native' && u.latestVersion !== mine.version) newer.set(u.id, u);
        }
        setUpdates(newer);
      } catch {
        // Signed out or offline: no update badges; installing still works where possible.
      }
    });
  }, []);

  useEffect(() => {
    alive.current = true;
    refresh();
    return () => { alive.current = false; };
  }, [refresh]);

  const run = useCallback(async (id: string, fn: () => Promise<{ text: string; error: boolean }>) => {
    setBusy(id);
    setMessage(null);
    const m = await fn();
    if (!alive.current) return;
    setBusy(null);
    setMessage(m);
    refresh();
    onChange.current?.();
  }, [refresh]);

  return {
    installed,
    updates,
    busy,
    message,
    refresh,
    clearMessage: () => setMessage(null),
    install: (id, version, owner) => run(id, async () => {
      const r = await installFromStore(engine(), { id, version, owner });
      return { text: r.message, error: !r.ok };
    }),
    uninstall: (id) => run(id, async () => {
      const err = await uninstallPlugin(engine(), id);
      return err ? { text: err, error: true } : { text: `${id} is disabled and will be removed when Premation restarts.`, error: false };
    }),
    checkPlan: () => run('premation-cloud', checkPremationCloud),
    setEnabled: (id, enabled) => run(id, async () => {
      const err = await setPluginEnabled(engine(), id, enabled);
      return err ? { text: err, error: true } : { text: `${id} ${enabled ? 'enabled' : 'disabled'}.`, error: false };
    }),
  };
}
