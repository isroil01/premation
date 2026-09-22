/**
 * The Plugins menu — built from what is actually installed and running.
 *
 * Every other group in `APP_MENU` is a static list of command ids, because
 * every other group's contents ship with the app. This one cannot be: the whole
 * point of a plugin is that the user adds it after the build. Until now that
 * meant an installed plugin's commands existed ONLY in the command palette —
 * you had to already know a plugin had contributed something in order to search
 * for it, which is the wrong way round for a feature whose first problem is
 * discovery.
 *
 * Shape (After Effects' own convention): one entry per installed plugin, its
 * panel and commands beneath it, then the manager.
 *
 * A plugin that is installed but not running still appears, disabled and
 * labelled with why. A menu that silently omits something the user installed is
 * how "did my plugin even install?" happens.
 *
 * ── Two ways it folds, and when ──────────────────────────────────────────────
 *
 * A menu group has a ceiling of 14 entries (`menuSubmenus.test.ts`), and this
 * one's length is decided by the user's install list rather than by us. So:
 *
 *  • A command may declare `submenu: "Heading"`, which groups it with its
 *    siblings under that heading inside its own plugin's block. That is the
 *    author saying "these fourteen verbs are really three families", and it is
 *    the only nesting a plugin gets — one level, never a tree.
 *  • Past the ceiling, EVERY plugin folds into a submenu of its own name. Which
 *    is the same fix `Window ▸ Panels` applies, and for the same reason: a menu
 *    that runs off the bottom of the window is a menu with entries nobody can
 *    reach at all.
 *
 * Neither fires for the ordinary case — one or two plugins with a handful of
 * commands each stays flat, which is what makes the common menu short.
 */

import pluginHost from '@core/plugins/PluginHost';
import { usePluginStore } from '@stores/pluginStore';
import type { MenuGroupModel, MenuItemModel } from './menuModel';

/** What a menu group will show before it starts folding plugins away. */
const MENU_CEILING = 14;

/** Label suffix for a plugin the user cannot currently use. */
function stoppedNote(status: string): string {
  return status === 'error' ? ' (stopped — see its log)' : ' (disabled)';
}

/** One plugin's own entries, already grouped by any `submenu` its commands declare. */
function itemsForPlugin(entry: ReturnType<typeof installedPlugins>[number]): MenuItemModel[] {
  const { manifest } = entry;
  const info = pluginHost.info(manifest.id);
  const items: MenuItemModel[] = [];

  // `inactive` belongs with `running`, not with `stopped`. Its commands are
  // registered and invoking one starts it, so greying them out would hide a
  // working plugin behind a state the user never chose and cannot clear.
  if (info.status === 'stopped' || info.status === 'error') {
    // No commandId ⇒ the renderers draw it disabled. Present, but honest.
    return [{ label: `${manifest.name}${stoppedNote(info.status)}` }];
  }

  for (const panel of manifest.contributes.panels) {
    items.push({ commandId: `plugin.${manifest.id}.panel.${panel.id}` });
  }
  // Tools, beside the panels: both are "a place this plugin lives" rather than
  // a verb, and a contributed tool is otherwise reachable only from the strip.
  for (const tool of manifest.contributes.tools) {
    items.push({ commandId: `plugin.${manifest.id}.tool.${tool.id}` });
  }

  // Declared commands come from the manifest, so they are listed whether or
  // not the worker has ever run. A plugin that also registers commands at
  // runtime adds those on top, once it is up.
  const declared = manifest.contributes.commands;
  const declaredIds = declared.map((c) => c.id);
  const runtimeOnly = info.commands.map((c) => c.id).filter((id) => !declaredIds.includes(id));

  const grouped = new Map<string, MenuItemModel[]>();
  for (const spec of declared) {
    // No label override — the registry's label is already "Name: Label", and
    // duplicating that string here is how the two drift apart.
    const item: MenuItemModel = { commandId: `plugin.${manifest.id}.${spec.id}` };
    if (!spec.submenu) { items.push(item); continue; }
    const list = grouped.get(spec.submenu) ?? [];
    list.push(item);
    grouped.set(spec.submenu, list);
  }
  for (const id of runtimeOnly) items.push({ commandId: `plugin.${manifest.id}.${id}` });
  // After the ungrouped run, in declaration order of their first member.
  for (const [label, children] of grouped) items.push({ label, children });

  // A plugin that contributes nothing is a real state (it may only react to
  // selection), and it should still be visible as installed.
  if (items.length === 0) items.push({ label: `${manifest.name} (no commands)` });
  return items;
}

function installedPlugins(): ReturnType<typeof usePluginStore.getState>['plugins'] {
  return [...usePluginStore.getState().plugins].sort((a, b) =>
    a.manifest.name.localeCompare(b.manifest.name),
  );
}

export function buildPluginsMenuGroup(): MenuGroupModel {
  const installed = installedPlugins();
  const blocks = installed.map((entry) => ({ entry, items: itemsForPlugin(entry) }));

  // +1 for the manager, which is always last and never folds.
  const flatCount = blocks.reduce((n, b) => n + b.items.length, 0) + 1;
  const fold = flatCount > MENU_CEILING && blocks.length > 1;

  const items: MenuItemModel[] = [];
  for (const { entry, items: own } of blocks) {
    if (fold) {
      items.push({ label: entry.manifest.name, children: own });
      continue;
    }
    items.push(...own);
    items.push({ separator: true });
  }

  if (items.length === 0) {
    items.push({ label: 'No plugins installed', labelKey: 'menu.plugins.none' });
    items.push({ separator: true });
  } else if (fold) {
    items.push({ separator: true });
  }

  // One route in, because there is one surface. Finding, installing, managing,
  // adjusting permissions and reading a plugin's log all happen in the Plugins
  // panel and the plugin pages it opens. There is no second manager to offer,
  // and offering one was how the two of them drifted.
  items.push({ commandId: 'view.marketplace', label: 'Plugins' });

  return { id: 'plugins', label: 'Plugins', items };
}
