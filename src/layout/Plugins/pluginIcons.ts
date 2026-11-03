/**
 * Where an installed plugin's icon comes from: the manifest's `icon` (a
 * picture in the bundle's ui/, served as `plugin-ui://<id>/…`), else the store
 * listing's icon when the plugin was installed from the store. Shared by the
 * effect card header (Effects/PluginCardHeader.tsx) and the plugin's dock tab
 * (usePluginPanels.ts), so both show the same picture.
 */

import type { PluginInfo } from '@motion/engine-api';
import { api, storeMediaUrl } from '@core/api/client';
import { installedPlugins } from '@core/nativePlugins/pluginStore';

/** `plugin-ui://<id>/<path under ui/>` for a manifest icon ("ui/icon.png"); null when there is none. */
export function pluginIconUrl(plugin: Pick<PluginInfo, 'id' | 'icon'> | undefined): string | null {
  const icon = plugin?.icon;
  if (!plugin || !icon || !icon.startsWith('ui/')) return null;
  return `plugin-ui://${plugin.id.toLowerCase()}/${icon.slice(3).split('/').map(encodeURIComponent).join('/')}`;
}

/** Store icons by plugin id, asked once per session (null = none / not from the store). */
const storeIcons = new Map<string, Promise<string | null>>();

/** The store listing's icon URL for an installed plugin (asked once per session); null when there is none. */
export function storeIcon(id: string): Promise<string | null> {
  let p = storeIcons.get(id);
  if (!p) {
    p = installedPlugins()
      .then((state) => (state?.plugins[id] ? api.storePluginDetail(id).then((d) => storeMediaUrl(d.iconUrl)) : null))
      .catch(() => null);
    storeIcons.set(id, p);
  }
  return p;
}
