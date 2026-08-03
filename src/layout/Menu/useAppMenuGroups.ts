/**
 * The menu groups the two menu renderers draw.
 *
 * Both `AppMenuBar` and `AppMenuButton` used to read `APP_MENU` — a module
 * constant — directly, which is fine for groups whose contents ship with the
 * app and wrong for the one group that cannot: Plugins is assembled from what
 * the user installed, and it has to change while the app is running (a plugin
 * finishes booting, crashes, is disabled). Hence a hook: it subscribes to both
 * sources of truth, so an open menu is never stale.
 */

import { useMemo, useSyncExternalStore } from 'react';
import pluginHost from '@core/plugins/PluginHost';
import { usePluginStore } from '@stores/pluginStore';
import { APP_MENU, type MenuGroupModel, type MenuItemModel } from './menuModel';
import { buildPluginsMenuGroup } from './pluginMenu';

export function useAppMenuGroups(): MenuGroupModel[] {
  // Runtime status (running / stopped / crashed, contributed commands).
  const revision = useSyncExternalStore(
    (cb) => pluginHost.subscribe(cb),
    () => pluginHost.getRevision(),
  );
  // What is installed at all.
  const installed = usePluginStore((s) => s.plugins);

  return useMemo(() => {
    const plugins = buildPluginsMenuGroup();
    // Before Help, after Window — the same place After Effects puts it, and the
    // same place a user looks for "things that were added to this app".
    const helpAt = APP_MENU.findIndex((g) => g.id === 'help');
    const at = helpAt === -1 ? APP_MENU.length : helpAt;
    const groups = [...APP_MENU.slice(0, at), plugins, ...APP_MENU.slice(at)];
    return groups.map((g) => ({ ...g, items: visibleItems(g.items) }));
  }, [revision, installed]);
}

/**
 * Drop items whose `visible()` says no, then tidy the separators they leave.
 *
 * Hiding an edition-gated entry between two separators would otherwise leave a
 * double rule, and hiding the last entry a trailing one — which reads as a
 * rendering bug rather than as an absent feature.
 */
export function visibleItems(items: ReadonlyArray<MenuItemModel>): MenuItemModel[] {
  const kept = items.filter((it) => it.visible === undefined || it.visible());
  const out: MenuItemModel[] = [];
  for (const item of kept) {
    // Collapse runs, and never open with one.
    if (item.separator && (out.length === 0 || out[out.length - 1]?.separator)) continue;
    out.push(item);
  }
  while (out.length > 0 && out[out.length - 1]?.separator) out.pop();
  return out;
}
