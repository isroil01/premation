/**
 * Ensure static editor commands are present in the command registry.
 *
 * In the editor, <Providers> boots the full Application core and registers
 * commands. Outside the editor (e.g. on the Dashboard Customize page or
 * settings dialog), this function ensures all built-in commands are registered
 * so users can search, configure, rebind, clear, and reset shortcuts without
 * having to visit the editor first.
 */

import { getCommandRegistry, BuiltinCommands } from '@core/commands/Command';
import { asCommandId } from '@app-types/common';
import { getShortcutManager } from '@core/commands/ShortcutManager';
import { buildStaticCommands } from '@providers/Providers';
import { performUndo, performRedo } from '@stores/historyStore';

let registered = false;

export function ensureCommandsRegistered(): void {
  const registry = getCommandRegistry();
  if (registered && registry.all().length > 10) return;

  try {
    const cmds = buildStaticCommands();
    for (const cmd of cmds) {
      if (!registry.get(cmd.id)) {
        registry.register(cmd);
      }
    }

    if (!registry.get(asCommandId(BuiltinCommands.Undo))) {
      registry.register({
        id: asCommandId(BuiltinCommands.Undo),
        label: 'Undo',
        shortcut: { key: 'z', meta: true },
        enabled: () => true,
        execute: () => performUndo(),
      });
    }

    if (!registry.get(asCommandId(BuiltinCommands.Redo))) {
      registry.register({
        id: asCommandId(BuiltinCommands.Redo),
        label: 'Redo',
        shortcut: { key: 'z', meta: true, shift: true },
        enabled: () => true,
        execute: () => performRedo(),
      });
    }

    getShortcutManager().rehydrateFromRegistry();
    getShortcutManager().applyOverrides();
    registered = true;
  } catch (err) {
    console.warn('[ensureCommandsRegistered] Could not pre-populate command registry:', err);
  }
}
