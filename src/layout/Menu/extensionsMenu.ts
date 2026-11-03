/**
 * Window ▸ Extensions — every installed plugin's panel, as After Effects lists
 * extension panels (docs/mockups/plugin-docking-ae.html, frame 3). A check
 * means the panel is docked; choosing one opens it, or brings it forward where
 * it is docked. Manage Plugins… opens the Plugins panel.
 *
 * Built per draw (a thunk in menuModel), like Window ▸ Workspace: the entries
 * are plugin data, and installing one has to make it appear without a reload.
 * Plugin names are user data and never translated (menuI18n.ts); the fixed
 * entries carry their own `labelKey`.
 *
 * The caption and the "No plugin panels" line have no action, so the in-app
 * menu draws them disabled and the native menu leaves them out
 * (nativeMenuTemplate.ts drops an entry with nothing to run).
 */

import { pluginInfo, pluginPanels } from '@core/nativePlugins/pluginContrib';
import { pluginPanelMenuTitle } from '@layout/Plugins/pluginDockRules';
import { useLayoutStore } from '@stores/layoutStore';
import type { MenuItemModel } from './menuModel';

/** Is this dock panel docked on any side right now? */
export function isPanelDocked(panelId: string): boolean {
  const order = useLayoutStore.getState().panelOrder as Readonly<Record<string, ReadonlyArray<string> | undefined>>;
  return Object.values(order).some((list) => list?.includes(panelId) ?? false);
}

/** A key for the docked state of every plugin panel, so a menu memo can follow it. */
export function dockedPluginPanelsKey(order: Readonly<Record<string, ReadonlyArray<string> | undefined>>): string {
  const ids = new Set(pluginPanels().map((p) => p.panelId));
  const docked: string[] = [];
  for (const list of Object.values(order)) for (const id of list ?? []) if (ids.has(id)) docked.push(id);
  return docked.sort().join('|');
}

export function buildExtensionsMenuItems(): MenuItemModel[] {
  const panels = pluginPanels();
  const items: MenuItemModel[] = [{ label: 'Installed plugins', labelKey: 'menu.extensions.installed' }];
  if (panels.length === 0) {
    items.push({ label: 'No plugin panels', labelKey: 'menu.extensions.none' });
  } else {
    for (const p of panels) {
      items.push({
        // The same name the dock's tab and Open Panel rows use (pluginDockRules.ts).
        label: pluginPanelMenuTitle(p, pluginInfo(p.plugin)),
        checked: () => isPanelDocked(p.panelId),
        onSelect: () => useLayoutStore.getState().openPanel(p.panelId),
      });
    }
  }
  items.push(
    { separator: true },
    { label: 'Manage Plugins…', labelKey: 'menu.extensions.manage', onSelect: () => useLayoutStore.getState().openPanel('plugins') },
  );
  return items;
}
