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
import { APP_MENU, type MenuGroupModel } from './menuModel';
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
    return [...APP_MENU.slice(0, at), plugins, ...APP_MENU.slice(at)];
  }, [revision, installed]);
}
