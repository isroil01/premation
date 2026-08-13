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
import { allLayerKinds } from '@core/plugins/layerKindRegistry';
import { pluginsEnabled } from '@core/config/edition';

export function useAppMenuGroups(): MenuGroupModel[] {
  // Runtime status (running / stopped / crashed, contributed commands).
  const revision = useSyncExternalStore(
    (cb) => pluginHost.subscribe(cb),
    () => pluginHost.getRevision(),
  );
  // What is installed at all.
  const installed = usePluginStore((s) => s.plugins);

  return useMemo(() => {
    /*
      A build without plugins gets the app menu with no plugin group and no
      layer-kind entries — but still filtered, because `visibleItems` is what
      applies every OTHER edition gate in the menu. Returning `APP_MENU` raw
      here would hide the plugins and un-hide the cloud.

      Gated before anything is assembled rather than filtered afterwards. Both
      additions are built from registries that are empty in this edition, so the
      code below would produce the same answer today — and relying on that would
      make the real gate "nothing happens to be installed", which stops being
      true the moment something registers a kind for an unrelated reason.
    */
    if (!pluginsEnabled()) {
      return APP_MENU.map((g) => ({ ...g, items: visibleItems(g.items) }));
    }

    const plugins = buildPluginsMenuGroup();
    // Before Help, after Window — the same place After Effects puts it, and the
    // same place a user looks for "things that were added to this app".
    const helpAt = APP_MENU.findIndex((g) => g.id === 'help');
    const at = helpAt === -1 ? APP_MENU.length : helpAt;
    const groups = [...APP_MENU.slice(0, at), plugins, ...APP_MENU.slice(at)];

    /*
      Plugin layer kinds, in the LAYER menu rather than the Plugins menu.

      A user looking for "how do I add one of these" looks under Layer ▸ New,
      beside Text and Solid — not under a menu named after the mechanism that
      happens to provide it. The Plugins menu is for managing plugins; this is
      for making a layer.

      Built per render from the live registry, so enabling or disabling a plugin
      changes the menu without a reload — `revision` and `installed` above are
      already the dependencies that drive it.
    */
    const kinds = allLayerKinds();
    const withKinds = kinds.length === 0 ? groups : groups.map((g) => {
      if (g.id !== 'layer') return g;
      const entries: MenuItemModel[] = kinds.map((k) => ({
        commandId: `layer.new.${k.pluginId}.${k.kind.id}`,
        label: `New -> ${k.kind.label}`,
      }));
      // After the native New entries and before the separator that follows
      // them, so the list reads as one group of things you can create.
      const firstSeparator = g.items.findIndex((it) => it.separator);
      const at2 = firstSeparator === -1 ? g.items.length : firstSeparator;
      return { ...g, items: [...g.items.slice(0, at2), ...entries, ...g.items.slice(at2)] };
    });

    return withKinds.map((g) => ({ ...g, items: visibleItems(g.items) }));
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
