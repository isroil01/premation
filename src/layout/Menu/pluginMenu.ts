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
 */

import pluginHost from '@core/plugins/PluginHost';
import { usePluginStore } from '@stores/pluginStore';
import type { MenuGroupModel, MenuItemModel } from './menuModel';

/** Label suffix for a plugin that is installed but has no live worker. */
function stoppedNote(status: string): string {
  return status === 'error' ? ' (stopped — see Manage Plugins…)' : ' (disabled)';
}

export function buildPluginsMenuGroup(): MenuGroupModel {
  const installed = [...usePluginStore.getState().plugins].sort((a, b) =>
    a.manifest.name.localeCompare(b.manifest.name),
  );

  const items: MenuItemModel[] = [];

  for (const entry of installed) {
    const { manifest } = entry;
    const info = pluginHost.info(manifest.id);

    if (info.status !== 'running') {
      // No commandId ⇒ the renderers draw it disabled. Present, but honest.
      items.push({ label: `${manifest.name}${stoppedNote(info.status)}` });
      items.push({ separator: true });
      continue;
    }

    if (manifest.panel) {
      items.push({ commandId: `plugin.${manifest.id}.panel`, label: `${manifest.name}: Panel` });
    }
    for (const cmd of info.commands) {
      // No label override — the registry's label is already "Name: Label", and
      // duplicating that string here is how the two drift apart.
      items.push({ commandId: `plugin.${manifest.id}.${cmd.id}` });
    }
    // A running plugin that contributes nothing is a real state (it may only
    // react to selection), and it should still be visible as installed.
    if (!manifest.panel && info.commands.length === 0) {
      items.push({ label: `${manifest.name} (no commands)` });
    }
    items.push({ separator: true });
  }

  if (items.length === 0) {
    items.push({ label: 'No plugins installed' });
    items.push({ separator: true });
  }

  items.push({ commandId: 'view.plugins', label: 'Manage Plugins…' });

  return { id: 'plugins', label: 'Plugins', items };
}
