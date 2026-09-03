/**
 * Window ▸ Workspace — the saved dock layouts, as a menu.
 *
 * `WorkspaceManager` has shipped builtin presets, user-saved snapshots, apply,
 * save and delete since the layout store existed. The only door was Settings ▸
 * Customize… ▸ Workspaces: two clicks and a tab away from the menu bar, which
 * is where every other app puts this and where AE puts it exactly.
 *
 * Built per render rather than declared in `menuModel`, for the same reason the
 * Plugins group is: half these entries are USER data. Saving a layout while the
 * app runs has to make it appear without a reload, and a static list of command
 * ids cannot express "whatever the user has saved".
 *
 * Applying is therefore an `onSelect`, not a command id — a workspace the user
 * invents at runtime has no registration to point at. The two things that ARE
 * fixed (save-as, reset) stay commands so they are searchable in the palette.
 */

import { getWorkspaceManager } from '@core/layout/workspaceManager';
import { getSettingsManager } from '@core/services/coreServices';
import { BuiltinCommands } from '@core/commands/Command';
import type { MenuItemModel } from './menuModel';

/** Where `WorkspaceManager.applyWorkspace` records what it last applied. */
const ACTIVE_WORKSPACE_KEY = 'workspace.activeId';

function activeWorkspaceId(): string {
  try {
    return getSettingsManager().get<string>(ACTIVE_WORKSPACE_KEY, 'default');
  } catch {
    // The settings manager is absent on the pre-boot routes the TitleBar also
    // renders on (see `tryCoreServices` in menuModel). No active mark there.
    return 'default';
  }
}

export function buildWorkspaceMenuItems(): MenuItemModel[] {
  const manager = getWorkspaceManager();
  let layouts: ReturnType<typeof manager.listWorkspaces>;
  try {
    layouts = manager.listWorkspaces();
  } catch {
    layouts = [];
  }
  const active = activeWorkspaceId();

  const items: MenuItemModel[] = layouts.map((w) => ({
    label: w.name,
    // A radio mark, not a checkbox: exactly one layout is applied at a time.
    checked: () => w.id === active,
    onSelect: () => {
      manager.applyWorkspace(w.id);
    },
  }));

  if (items.length > 0) items.push({ separator: true });
  items.push({ commandId: 'workspace.saveAs', label: 'Save Layout as…' });
  // The SAME command the View menu offers. Two entries for one action is the
  // right call here — this submenu is where a user who is switching layouts is
  // already looking, and "put it back" is the other half of that thought.
  items.push({ commandId: BuiltinCommands.ResetLayout, label: 'Reset Layout' });
  return items;
}
