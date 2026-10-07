/**
 * Native SDK plugins, as the editor's Plugins page and panel see them.
 *
 * Premation 0.9 removed the JavaScript/WGSL plugin system and its registry
 * (G2). Native SDK plugins (docs/PLUGIN_SDK.md) run inside the C++ engine
 * process. They install from the plugin store (pluginStore.ts,
 * docs/PLUGIN_STORE.md) or by hand into the plugins folder
 * (`<userData>/native-plugins`, see electron/ipc/nativePlugins.ts). What the engine found there, loaded or not, is its own answer to
 * `listPlugins`; this module never keeps a second list.
 *
 * Also here: the one per-user preference these surfaces have — whether the
 * plugin store notice was dismissed. localStorage,
 * every access wrapped (a sandboxed or full store must never break the page),
 * and never the project document.
 *
 * No React (src/core). The hook is src/hooks/useNativePlugins.ts.
 */

import type { EngineClient, PluginInfo } from '@motion/engine-api';

export type NativePlugin = PluginInfo;

export type NativePluginList =
  | { ok: true; plugins: NativePlugin[] }
  | { ok: false; error: string };

/** Ask the engine which native plugins it found. Never throws. */
export async function listNativePlugins(client: Pick<EngineClient, 'query'>): Promise<NativePluginList> {
  try {
    const res = await client.query({ type: 'listPlugins' });
    if (!res.ok) return { ok: false, error: res.error.message || 'The engine could not list plugins.' };
    return { ok: true, plugins: res.value.plugins };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'The engine could not list plugins.' };
  }
}

/** One status word per plugin, as a person would say it. */
export function nativePluginStatusLabel(status: NativePlugin['status']): string {
  switch (status) {
    case 'loaded': return 'Loaded';
    case 'disabled': return 'Disabled';
    case 'failed': return 'Failed';
    case 'quarantined': return 'Quarantined';
    case 'revoked': return 'Revoked';
  }
}

type PluginsBridge = NonNullable<NonNullable<Window['motionEditor']>['plugins']>;

function pluginsBridge(): PluginsBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.motionEditor?.plugins;
}

/** Whether this build can open the plugins folder (the desktop app; not a browser). */
export function canOpenNativePluginFolder(): boolean {
  return typeof pluginsBridge()?.openNativeFolder === 'function';
}

/** Open the plugins folder in Explorer / Finder. Resolves the error to show, or null. */
export async function openNativePluginFolder(): Promise<string | null> {
  const open = pluginsBridge()?.openNativeFolder;
  if (!open) return 'The plugins folder is only available in the desktop app.';
  try {
    const res = await open();
    return res.ok ? null : `Could not open the plugins folder${res.error ? `: ${res.error}` : ''}.`;
  } catch (err) {
    return err instanceof Error ? err.message : 'Could not open the plugins folder.';
  }
}

/** The plugins folder's path, or null when this build has none. */
export async function nativePluginFolderPath(): Promise<string | null> {
  const get = pluginsBridge()?.nativeFolderPath;
  if (!get) return null;
  try {
    return await get();
  } catch {
    return null;
  }
}

// ── The dismissible notice ─────────────────────────────────────────────────

/** Versioned: a later notice about a later change gets a new key and shows again. */
export const REGISTRY_NOTICE_KEY = 'premation.notice.pluginStore.v0_10.dismissed';

const noticeListeners = new Set<() => void>();
let noticeCache: boolean | null = null;

export function isRegistryNoticeDismissed(): boolean {
  if (noticeCache !== null) return noticeCache;
  try {
    noticeCache = globalThis.localStorage?.getItem(REGISTRY_NOTICE_KEY) === '1';
  } catch {
    noticeCache = false;
  }
  return noticeCache;
}

export function dismissRegistryNotice(): void {
  noticeCache = true;
  try {
    globalThis.localStorage?.setItem(REGISTRY_NOTICE_KEY, '1');
  } catch {
    // Quota or a blocked store: hidden for this session, back next launch.
  }
  for (const l of noticeListeners) l();
}

export function subscribeRegistryNotice(listener: () => void): () => void {
  noticeListeners.add(listener);
  return () => { noticeListeners.delete(listener); };
}

/** Test seam: forget the cached answer so the next read goes back to storage. */
export function resetRegistryNoticeCacheForTest(): void {
  noticeCache = null;
}
