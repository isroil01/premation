/**
 * Plugin Developer Mode, page side (W2, docs/PLUGIN_SDK.md "Hot reload"). Main keeps the settings
 * and watches the dev folders (electron/pluginDevMode.ts); a settled rebuild arrives here and the
 * engine swaps the new build in (`reloadPlugin`). Editor state: never the document.
 */

import type { EngineClient } from '@motion/engine-api';
import { t } from '@core/i18n';
import { reloadPlugin } from './pluginStore';

type PluginsBridge = NonNullable<NonNullable<Window['motionEditor']>['plugins']>;

export interface PluginDevSettings {
  enabled: boolean;
  folders: string[];
}

function bridge(): PluginsBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.motionEditor?.plugins;
}

/** Whether this build has Developer Mode (the desktop app). */
export function hasPluginDevMode(): boolean {
  return typeof bridge()?.devSettings === 'function';
}

export async function devSettings(): Promise<PluginDevSettings> {
  try {
    return (await bridge()?.devSettings?.()) ?? { enabled: false, folders: [] };
  } catch {
    return { enabled: false, folders: [] };
  }
}

/** Save; null when main refused them. Changing the folders or the switch restarts the engine. */
export async function saveDevSettings(s: PluginDevSettings): Promise<PluginDevSettings | null> {
  try {
    return (await bridge()?.setDevSettings?.(s)) ?? null;
  } catch {
    return null;
  }
}

export async function pickDevFolder(): Promise<string | null> {
  try {
    return (await bridge()?.pickDevFolder?.()) ?? null;
  } catch {
    return null;
  }
}

export interface DevReloadNotice {
  level: 'success' | 'error';
  message: string;
  detail?: string;
}

/**
 * Reload each dev plugin main reports rebuilt; `notice` says how it went. Returns the unsubscribe
 * (a no-op outside the desktop app).
 */
export function followDevRebuilds(client: () => Pick<EngineClient, 'execute' | 'query'>, notice: (n: DevReloadNotice) => void): () => void {
  const off = bridge()?.onDevChanged?.((id) => {
    void reloadPlugin(client(), id).then((r) => {
      if (r.ok) {
        const name = r.plugins.find((p) => p.id === id)?.name ?? id;
        notice({ level: 'success', message: t('plugins.dev.reloaded', 'Reloaded {name}', { name }) });
      } else {
        notice({ level: 'error', message: t('plugins.dev.reloadFailed', 'Kept the previous build of {id}', { id }), detail: r.message });
      }
    });
  });
  return off ?? (() => {});
}
