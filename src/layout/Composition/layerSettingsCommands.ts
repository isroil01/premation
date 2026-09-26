/**
 * Layer ▸ Layer Settings… (AE: Ctrl/Cmd+Shift+Y) as a first-class command.
 *
 * Registered from the feature's own module — the `timelineFitCommands` pattern
 * — and installed by the viewport (`Workspace.tsx`), so nothing in the app's
 * boot block has to change for the command and its shortcut to work. The
 * shortcut manager is asked to re-scan after registering.
 *
 * Menu rows (owned by menuModel.ts, not here): Layer ▸ Layer Settings…
 * → `layer.settings`. Layer ▸ New ▸ Solid… should call
 * `openSolidSettings({ mode: 'new' })` instead of the bare `insertSolid()`.
 */

import { asCommandId } from '@app-types/common';
import { getCommandRegistry, type Command } from '@core/commands/Command';
import { getShortcutManager } from '@core/commands/ShortcutManager';
import { useSelectionStore } from '@stores/selectionStore';
import { openLayerSettings } from './LayerSettingsDialog';

export const LAYER_SETTINGS_COMMAND = asCommandId('layer.settings');

export function buildLayerSettingsCommands(): ReadonlyArray<Command> {
  return [
    {
      id: LAYER_SETTINGS_COMMAND,
      label: 'Layer Settings…',
      description: 'Name, label colour and — for solids, nulls and adjustment layers — size (and a solid’s colour).',
      icon: 'settings',
      shortcut: { key: 'y', meta: true, shift: true },
      enabled: () => useSelectionStore.getState().ids.length === 1,
      execute: () => {
        openLayerSettings();
      },
    },
  ];
}

let installed = false;

/** Register the command and bind its shortcut. Idempotent. */
export function installLayerSettingsCommands(): void {
  if (installed) return;
  installed = true;
  const registry = getCommandRegistry();
  for (const command of buildLayerSettingsCommands()) registry.register(command);
  getShortcutManager().rehydrateFromRegistry();
}
