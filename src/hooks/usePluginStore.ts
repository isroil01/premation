/**
 * The plugin store for the Plugins page and panel: what the store lists, what
 * this machine has installed (Electron main's state), what the engine loaded,
 * and the updates between them. Every action goes through
 * core/nativePlugins/pluginStore.ts (main installs, the engine rescans).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@core/i18n';
import { invalidate } from '@core/api/cache';
import { api, type StorePluginSummary, type StorePluginUpdate } from '@core/api/client';
import { useCachedQuery } from './useCachedQuery';
import { hasSession } from '@core/api/session';
import { pluginEngine } from '@core/engine/engineInstance';
import {
  checkPremationCloud,
  compareVersions,
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
  /** Ids listed from the signed-in publisher's own private plugins: they install (and read) as the owner. */
  owned: ReadonlySet<string>;
}

const NONE: ReadonlySet<string> = new Set();

export interface StoreMessage {
  text: string;
  error: boolean;
  upgrade?: boolean;
}

/** Does a summary match the search the way the registry's browse does (name, id, description)? */
function matches(p: StorePluginSummary, q: string): boolean {
  const n = q.trim().toLowerCase();
  return !n || [p.name, p.id, p.description].some((v) => (v ?? '').toLowerCase().includes(n));
}

/**
 * The signed-in publisher's own PRIVATE native plugins (docs/PLUGIN_STORE.md: "private means only
 * the owner can see it in browse"). The registry's browse is the public, cacheable marketplace and
 * never lists them, so the page adds them from `/plugins/mine/list`. Signed out / offline: none.
 */
async function ownPrivatePlugins(q: string): Promise<StorePluginSummary[]> {
  if (!hasSession()) return [];
  try {
    const mine = await api.myPlugins();
    return mine.filter((p) => p.kind === 'native' && p.visibility === 'private' && matches(p, q));
  } catch {
    return [];
  }
}

/** The registry's browse orders (motion-back plugins.service browse): installs, then newest first. */
export type StoreSort = 'installs' | 'new' | 'updated';

/**
 * The store's native plugins in `sort` order — the whole catalogue with an
 * empty `q`, a search otherwise (debounced by the caller's SearchField) — the
 * publisher's private ones first.
 */
export function useStoreBrowse(q: string, sort: StoreSort = 'installs'): PluginStoreBrowse & { reload: () => void } {
  const term = q.trim();
  // Remembered per search + sort (useCachedQuery), so reopening the store lists
  // the catalogue at once instead of an empty card while it reloads.
  const query = useCachedQuery(
    `plugins:browse:${sort}:${term}`,
    async () => {
      const [page, own] = await Promise.all([
        api.browseNativePlugins({ q: term || undefined, sort, limit: 50 }),
        ownPrivatePlugins(q),
      ]);
      const listed = new Set(page.items.map((p) => p.id));
      const extra = own.filter((p) => !listed.has(p.id));
      return { items: [...extra, ...page.items], total: page.total + extra.length, owned: new Set(extra.map((p) => p.id)) as ReadonlySet<string> };
    },
    { tags: ['plugins'] },
  );
  const data = query.data;
  return {
    items: data?.items ?? null,
    total: data?.total ?? 0,
    owned: data?.owned ?? NONE,
    loading: query.loading,
    error: data || !query.error ? null : t('hooks.pluginStore.unreachable', 'The plugin store is unreachable.'),
    // Refresh means "ask the registry", not "re-read what we have".
    reload: () => invalidate('plugins'),
  };
}

export interface InstalledState {
  installed: NativePluginStoreState | null;
  updates: Map<string, StorePluginUpdate>;
  busy: string | null;
  /** `upgrade`: the store refused for want of Premation Cloud (402): the page offers Upgrade. */
  message: StoreMessage | null;
  refresh: () => void;
  install: (id: string, version: string, owner?: boolean) => Promise<void>;
  uninstall: (id: string) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** Premation Cloud: refresh the entitlement now (a locked plugin's "Check plan"). */
  checkPlan: () => Promise<void>;
  clearMessage: () => void;
}

/**
 * Every mounted useInstalledPlugins, so an action taken in one (a plugin's
 * page in the main body) refreshes the others (the Plugins sidebar): each
 * keeps its own state, and main's installed set is the one truth they re-read.
 */
const instances = new Set<() => void>();

/** Main's installed set, store updates for it, and the install / uninstall / enable actions. */
export function useInstalledPlugins(onEngineChange?: () => void): InstalledState {
  const [installed, setInstalled] = useState<NativePluginStoreState | null>(null);
  const [updates, setUpdates] = useState<Map<string, StorePluginUpdate>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<StoreMessage | null>(null);
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
          if (mine && u.kind === 'native' && compareVersions(u.latestVersion, mine.version) > 0) newer.set(u.id, u);
        }
        setUpdates(newer);
      } catch {
        // Signed out or offline: no update badges; installing still works where possible.
      }
    });
  }, []);

  // The other instances' refresh runs after this one's action; the engine
  // change reaches them through their own onEngineChange.
  const others = useRef<() => void>(() => {});
  others.current = () => {
    refresh();
    onChange.current?.();
  };
  const self = useRef<() => void>(() => others.current());

  useEffect(() => {
    alive.current = true;
    refresh();
    const mine = self.current;
    instances.add(mine);
    return () => {
      alive.current = false;
      instances.delete(mine);
    };
  }, [refresh]);

  const run = useCallback(async (id: string, fn: () => Promise<StoreMessage>) => {
    setBusy(id);
    setMessage(null);
    const m = await fn();
    for (const other of [...instances]) if (other !== self.current) other();
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
      const r = await installFromStore(pluginEngine(), { id, version, owner });
      return r.ok ? { text: r.message, error: false } : { text: r.message, error: true, ...(r.upgrade ? { upgrade: true } : {}) };
    }),
    uninstall: (id) => run(id, async () => {
      const err = await uninstallPlugin(pluginEngine(), id);
      return err ? { text: err, error: true } : { text: t('hooks.pluginStore.uninstalled', '{id} is disabled and will be removed when Premation restarts.', { id }), error: false };
    }),
    checkPlan: () => run('premation-cloud', checkPremationCloud),
    setEnabled: (id, enabled) => run(id, async () => {
      const err = await setPluginEnabled(pluginEngine(), id, enabled);
      return err ? { text: err, error: true } : { text: enabled ? t('hooks.pluginStore.enabled', '{id} enabled.', { id }) : t('hooks.pluginStore.disabled', '{id} disabled.', { id }), error: false };
    }),
  };
}
