/**
 * The Plugins menu (P7a): native plugin commands — AE's AEGP menu items — and
 * the dockable panels plugins ship (P7d), from the engine's plugin list
 * (core/nativePlugins/pluginContrib.ts). A disabled plugin contributes
 * nothing; the group is absent while no loaded plugin has a command or panel.
 *
 * Every command is also a registered COMMAND (`plugin.run.<plugin>/<id>`), so
 * the command palette lists it and Customize can bind a shortcut, exactly as
 * the Effect menu's built-ins. Plugin names are user data: never translated
 * (menuI18n.ts' runtime-entry rule).
 *
 * Running one: runPluginCommand with the selection (top first), the active
 * composition and the engine's playhead — the plugin runs in the engine and
 * its edits are ONE undo entry.
 */

import { asCommandId, type CommandId } from '@app-types/common';
import { t } from '@core/i18n';
import { getCommandRegistry } from '@core/commands/Command';
import { getShortcutManager } from '@core/commands/ShortcutManager';
import { engine } from '@core/engine/engineInstance';
import {
  createPluginLayer,
  pluginCommands,
  pluginLayerTypes,
  pluginName,
  pluginPanels,
  runPluginCommand,
  subscribePluginContrib,
} from '@core/nativePlugins/pluginContrib';
import type { PluginCommandInfo } from '@motion/engine-api';
import { useLayoutStore } from '@stores/layoutStore';
import { useProjectStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import type { MenuGroupModel, MenuItemModel } from './menuModel';

export function pluginCommandId(plugin: string, id: string): string {
  return `plugin.run.${plugin}/${id}`;
}

function activeComp(): string | undefined {
  const s = useProjectStore.getState();
  return s.activeTabId ? s.tabs[s.activeTabId]?.compositionId : undefined;
}

/** Run a plugin command on what the user has selected; the outcome as a toast. */
export async function runPluginCommandFromEditor(c: Pick<PluginCommandInfo, 'plugin' | 'id' | 'name'>): Promise<void> {
  const comp = activeComp();
  const res = await runPluginCommand(engine(), c.plugin, c.id, {
    ...(comp ? { comp } : {}),
    layers: [...useSelectionStore.getState().ids],
  });
  useUIStore.getState().notify(
    res.ok
      ? { level: 'success', message: res.message || c.name, durationMs: 2400 }
      : { level: 'error', message: `${c.name}: ${res.error}`, durationMs: 6000 },
  );
}

/** SDK 1.4: make a plugin layer in the active composition; a failure as a toast. */
export async function newPluginLayerFromEditor(type: string, name: string): Promise<void> {
  const comp = activeComp();
  if (!comp) {
    useUIStore.getState().notify({ level: 'error', message: t('menuBar.plugins.noComp', 'Open a composition to add a {name} layer.', { name }), durationMs: 4000 });
    return;
  }
  const res = await createPluginLayer(engine(), comp, type);
  if (res.ok) useSelectionStore.getState().set([res.layer]);
  else useUIStore.getState().notify({ level: 'error', message: `${name}: ${res.error}`, durationMs: 6000 });
}

/**
 * Layer ▸ New with the plugin layer types (SDK 1.4) after the built-in kinds — where menuModel.ts
 * says plugin layer kinds go. Unchanged when no loaded plugin has one.
 */
export function withPluginLayerTypes(groups: ReadonlyArray<MenuGroupModel>): MenuGroupModel[] {
  const types = pluginLayerTypes();
  if (types.length === 0) return [...groups];
  const extra: MenuItemModel[] = [
    { separator: true },
    ...types.map((lt) => ({ label: lt.name, onSelect: () => void newPluginLayerFromEditor(lt.type, lt.name) })),
  ];
  const children = (c: NonNullable<MenuItemModel['children']>) => (typeof c === 'function' ? c() : c);
  const withExtra = (c: NonNullable<MenuItemModel['children']>) => [...children(c), ...extra];
  return groups.map((g) =>
    g.id !== 'layer'
      ? g
      : {
          ...g,
          items: g.items.map((item) =>
            item.labelKey === 'menu.sub.new' && item.children
              ? { ...item, children: withExtra(item.children) }
              : item,
          ),
        },
  );
}

/** The Plugins group, or null when no loaded plugin offers a command or a panel. */
export function buildPluginMenuGroup(): MenuGroupModel | null {
  const commands = pluginCommands();
  const panels = pluginPanels();
  if (commands.length === 0 && panels.length === 0) return null;
  const items: MenuItemModel[] = [];
  // One submenu per `menu` name (the plugin's own name when it gives none), in first-seen order.
  const groups = new Map<string, PluginCommandInfo[]>();
  for (const c of commands) {
    const key = c.menu || pluginName(c.plugin);
    const list = groups.get(key);
    if (list) list.push(c);
    else groups.set(key, [c]);
  }
  for (const [menu, list] of groups) {
    items.push({ label: menu, children: list.map((c) => ({ commandId: pluginCommandId(c.plugin, c.id), label: c.name })) });
  }
  if (panels.length > 0) {
    if (items.length > 0) items.push({ separator: true });
    items.push({
      label: t('menuBar.plugins.panels', 'Panels'),
      children: panels.map((p) => ({
        // "Toolbar (Toolbar)" says nothing twice: the plugin's name only when it adds something.
        label: p.kind === 'effect' ? p.pluginName : p.panel.name === p.pluginName ? p.panel.name : `${p.panel.name} (${p.pluginName})`,
        onSelect: () => useLayoutStore.getState().openPanel(p.panelId),
      })),
    });
  }
  items.push({ separator: true }, { commandId: 'view.plugins', label: 'Manage Plugins…' });
  return { id: 'plugins', label: 'Plugins', items };
}

let registered: CommandId[] = [];

/** Register one command per plugin command (palette, shortcuts); the previous set is replaced. */
export function syncPluginCommands(): void {
  const registry = getCommandRegistry();
  for (const id of registered) registry.unregister(id);
  registered = [];
  for (const c of pluginCommands()) {
    const id = asCommandId(pluginCommandId(c.plugin, c.id));
    registry.register({
      id,
      label: `Plugins: ${c.name}`,
      description: `Run ${c.name} (${pluginName(c.plugin)}) on the selected layers.`,
      icon: 'plugin',
      enabled: () => true,
      execute: () => {
        void runPluginCommandFromEditor(c);
      },
    });
    registered.push(id);
  }
  getShortcutManager().rehydrateFromRegistry();
}

let installed = false;

/** Idempotent: keep the registered plugin commands in step with the plugin list. */
export function installPluginMenuCommands(): void {
  if (installed) return;
  installed = true;
  syncPluginCommands();
  subscribePluginContrib(syncPluginCommands);
}
