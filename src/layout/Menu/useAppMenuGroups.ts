/**
 * The menu groups the two menu renderers draw: `APP_MENU` with every edition
 * gate applied (`visibleItems`), localized. A hook so an open menu follows a
 * change of UI language. The Plugins group is the native plugins' commands and
 * panels (P7a, pluginMenu.ts); the JavaScript plugin system's is gone (G2).
 */

import { useEffect, useMemo } from 'react';
import { APP_MENU, type MenuGroupModel, type MenuItemModel } from './menuModel';
import { useCatalogueRevision } from '@hooks/useLocale';
import { localizeMenuGroups } from './menuI18n';
import { usePluginContrib } from '@hooks/usePluginContrib';
import { buildPluginMenuGroup, installPluginMenuCommands, withPluginLayerTypes } from './pluginMenu';
import { dockedPluginPanelsKey } from './extensionsMenu';
import { useLayoutStore } from '@stores/layoutStore';
import { useScriptsStore } from '@stores/scriptsStore';

export function useAppMenuGroups(): MenuGroupModel[] {
  const i18nRevision = useCatalogueRevision();
  // P7a: the native plugins' commands and panels (pluginMenu.ts) — a new revision on every
  // install, rescan or enable / disable, so the native menu is re-sent too.
  const pluginRevision = usePluginContrib();
  // Window ▸ Extensions checks the docked plugin panels: a new key when one is
  // docked or closed, so the native menu's checks are re-sent (the in-app menu
  // reads `checked()` per draw anyway).
  const dockedPanels = useLayoutStore((s) => dockedPluginPanelsKey(s.panelOrder));
  // File ▸ Scripts lists the Scripts folder (scriptsMenu.ts): a new revision when
  // the listing changes, so the native menu is re-sent with it.
  const scriptsRevision = useScriptsStore((s) => s.revision);
  useEffect(() => installPluginMenuCommands(), []);
  return useMemo(
    () => {
      const plugins = buildPluginMenuGroup();
      // SDK 1.4: plugin layer types join Layer ▸ New.
      const base = withPluginLayerTypes(APP_MENU);
      const groups = plugins ? withPluginGroup(base, plugins) : base;
      return localizeMenuGroups(groups.map((g) => ({ ...g, items: visibleItems(g.items) })));
    },
    // The catalogue is read by `t()` inside, not by this closure — hence the rule.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [i18nRevision, pluginRevision, dockedPanels, scriptsRevision],
  );
}

/** The Plugins group sits before Window, as After Effects' third-party menus do. */
function withPluginGroup(groups: ReadonlyArray<MenuGroupModel>, plugins: MenuGroupModel): MenuGroupModel[] {
  const at = groups.findIndex((g) => g.id === 'window');
  const out = [...groups];
  out.splice(at < 0 ? out.length : at, 0, plugins);
  return out;
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
