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

/** Label suffix for a plugin the user cannot currently use. */
function stoppedNote(status: string): string {
  return status === 'error' ? ' (stopped — see its log)' : ' (disabled)';
}

export function buildPluginsMenuGroup(): MenuGroupModel {
  const installed = [...usePluginStore.getState().plugins].sort((a, b) =>
    a.manifest.name.localeCompare(b.manifest.name),
  );

  const items: MenuItemModel[] = [];

  for (const entry of installed) {
    const { manifest } = entry;
    const info = pluginHost.info(manifest.id);

    // `inactive` belongs with `running`, not with `stopped`. Its commands are
    // registered and invoking one starts it, so greying them out would hide a
    // working plugin behind a state the user never chose and cannot clear.
    if (info.status === 'stopped' || info.status === 'error') {
      // No commandId ⇒ the renderers draw it disabled. Present, but honest.
      items.push({ label: `${manifest.name}${stoppedNote(info.status)}` });
      items.push({ separator: true });
      continue;
    }

    for (const panel of manifest.contributes.panels) {
      items.push({ commandId: `plugin.${manifest.id}.panel.${panel.id}` });
    }
    // Declared commands come from the manifest, so they are listed whether or
    // not the worker has ever run. A plugin that also registers commands at
    // runtime adds those on top, once it is up.
    const declared = manifest.contributes.commands.map((c) => c.id);
    const runtimeOnly = info.commands.map((c) => c.id).filter((id) => !declared.includes(id));
    for (const id of [...declared, ...runtimeOnly]) {
      // No label override — the registry's label is already "Name: Label", and
      // duplicating that string here is how the two drift apart.
      items.push({ commandId: `plugin.${manifest.id}.${id}` });
    }
    // A plugin that contributes nothing is a real state (it may only react to
    // selection), and it should still be visible as installed.
    if (manifest.contributes.panels.length === 0 && declared.length === 0 && runtimeOnly.length === 0) {
      items.push({ label: `${manifest.name} (no commands)` });
    }
    items.push({ separator: true });
  }

  if (items.length === 0) {
    items.push({ label: 'No plugins installed' });
    items.push({ separator: true });
  }

  // One route in, because there is one surface. Finding, installing, managing,
  // adjusting permissions and reading a plugin's log all happen in the Plugins
  // panel and the plugin pages it opens. There is no second manager to offer,
  // and offering one was how the two of them drifted.
  items.push({ commandId: 'view.marketplace', label: 'Plugins' });

  return { id: 'plugins', label: 'Plugins', items };
}
