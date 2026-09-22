/**
 * Context-menu manager (store-backed). Open a menu at a point from anywhere:
 *
 *   onContextMenu={(e) => { e.preventDefault;
 *     openContextMenu(e.clientX, e.clientY, [
 *       { id: 'rename', label: 'Rename', onSelect: rename },
 *       { id: 'sep', separator: true },
 *       { id: 'delete', label: 'Delete', danger: true, onSelect: remove },
 *     ]);
 *   }}
 *
 * The <ContextMenuHost> renders it with the Menu component.
 *
 * An item may name a `commandId` instead of (or as well as) an `onSelect`.
 * The shortcut column then fills itself from the command registry — the
 * user's rebinds included — and a missing `onSelect` executes the command.
 * `shortcut` was a field almost nobody populated by hand, which is why the
 * column was nearly always empty.
 */

import { create } from 'zustand';
import type { ReactNode } from 'react';
import type { IconName } from '@components/Icon';
import { getCommandRegistry } from '@core/commands/Command';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { resolveChord, getShortcutOverrides } from '@core/commands/shortcutOverrides';
import { formatChord } from '@core/commands/formatChord';
import { asCommandId } from '@app-types/common';

export interface ContextMenuItem {
  id: string;
  label?: ReactNode;
  icon?: IconName;
  /** Explicit shortcut text. Left empty, it is resolved from `commandId`. */
  shortcut?: string;
  /** The registered command this item stands for: supplies the shortcut and, absent `onSelect`, the action. */
  commandId?: string;
  disabled?: boolean;
  danger?: boolean;
  /** Render a divider instead of an action. */
  separator?: boolean;
  onSelect?: () => void;
  /** Nested items — renders this entry as a submenu (opens to the right). */
  children?: ContextMenuItem[];
}

/**
 * Fill the shortcut column (and a default action) for every item carrying a
 * `commandId`, recursively. Pure over the registry; exported for the host
 * and for tests.
 */
export function resolveContextMenuItems(items: ReadonlyArray<ContextMenuItem>): ContextMenuItem[] {
  return items.map((it) => {
    let out = it;
    if (it.commandId) {
      const cmd = getCommandRegistry().get(asCommandId(it.commandId));
      const chord = cmd ? resolveChord(it.commandId, cmd.shortcut, getShortcutOverrides()) : undefined;
      const commandId = it.commandId;
      out = {
        ...it,
        ...(it.shortcut === undefined && chord ? { shortcut: formatChord(chord) } : {}),
        ...(it.label === undefined && cmd ? { label: cmd.label } : {}),
        ...(it.onSelect === undefined
          ? { onSelect: () => { void getCommandSystem().execute(asCommandId(commandId)); } }
          : {}),
        // An unregistered command reads as "not available", never as a
        // live-looking item that silently no-ops.
        ...(it.disabled === undefined && (!cmd || (cmd.enabled && !cmd.enabled()))
          ? { disabled: true }
          : {}),
      };
    }
    if (it.children && it.children.length > 0) out = { ...out, children: resolveContextMenuItems(it.children) };
    return out;
  });
}

interface ContextMenuState {
  open: boolean;
  x: number;
  y: number;
  items: ReadonlyArray<ContextMenuItem>;
  openMenu(x: number, y: number, items: ContextMenuItem[]): void;
  close(): void;
}

export const useContextMenuStore = create<ContextMenuState>((set) => ({
  open: false,
  x: 0,
  y: 0,
  items: [],
  openMenu: (x, y, items) => set({ open: true, x, y, items: resolveContextMenuItems(items) }),
  close: () => set({ open: false, items: [] }),
}));

export const openContextMenu = (x: number, y: number, items: ContextMenuItem[]): void =>
  useContextMenuStore.getState().openMenu(x, y, items);
export const closeContextMenu = (): void => useContextMenuStore.getState().close();
