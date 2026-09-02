/**
 * One renderer for a list of `MenuItemModel`s, shared by the two menu surfaces.
 *
 * `AppMenuBar` and `AppMenuButton` each carried their own copy of this loop —
 * identical down to the comments, including the one explaining why an
 * unregistered command renders disabled. Adding submenus to both copies is
 * exactly how they would start to differ, so there is now one.
 *
 * Three kinds of entry, and the order of the checks matters:
 *
 *   1. `separator`
 *   2. `children` — a submenu. Never disabled for lacking a `commandId`: the
 *      parent is not an action, it is a container.
 *   3. everything else — command-backed (label / enabled / shortcut / checked
 *      all come from the registry) or, failing that, a bare `onSelect` for the
 *      entries that cannot be commands (see `MenuItemModel.onSelect`).
 */

import { MenuItem, MenuSeparator } from '@components/Menu';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { getCommandRegistry } from '@core/commands/Command';
import { asCommandId } from '@app-types/common';
import { formatChord } from './formatChord';
import { resolveChord, getShortcutOverrides } from '@core/commands/shortcutOverrides';
import { visibleItems } from './useAppMenuGroups';
import type { MenuItemModel } from './menuModel';

export interface MenuModelItemsProps {
  items: ReadonlyArray<MenuItemModel>;
  /** Called after any activation, so the owning surface can close itself. */
  onActivate: () => void;
  /** Distinguishes keys between the two nesting levels of AppMenuButton. */
  keyPrefix?: string;
}

export function MenuModelItems({ items, onActivate, keyPrefix = '' }: MenuModelItemsProps): JSX.Element {
  return (
    <>
      {items.map((it, i) => {
        const key = `${keyPrefix}${it.commandId ?? it.label ?? i}-${i}`;
        if (it.separator) return <MenuSeparator key={`sep-${key}`} />;

        if (it.children) {
          // Thunk children are evaluated HERE, on every draw — that is what
          // lets a workspace saved a second ago appear without a reload.
          const resolved = typeof it.children === 'function' ? it.children() : it.children;
          return (
            <MenuItem key={key} id={key} label={it.label ?? ''}>
              <MenuModelItems
                items={visibleItems(resolved)}
                onActivate={onActivate}
                keyPrefix={`${key}/`}
              />
            </MenuItem>
          );
        }

        const cmd = it.commandId ? getCommandRegistry().get(asCommandId(it.commandId)) : undefined;
        // An UNREGISTERED command renders disabled — an enabled item whose
        // click silently no-ops (execute on an unknown id) reads as broken;
        // greyed-out reads as "not available". An `onSelect` entry has no
        // registry to consult and is always live.
        const enabled = cmd ? (cmd.enabled ? cmd.enabled() : true) : !!it.onSelect;
        // A toggle's CURRENT state. `undefined` for a non-toggle keeps
        // role="menuitem" rather than menuitemcheckbox.
        const checked = cmd ? cmd.isChecked?.() : it.checked?.();
        const label = it.label ?? cmd?.label ?? it.commandId ?? '';
        const resolvedChord = cmd
          ? resolveChord(cmd.id as unknown as string, cmd.shortcut, getShortcutOverrides())
          : undefined;
        const shortcut = resolvedChord ? formatChord(resolvedChord) : undefined;

        return (
          <MenuItem
            key={key}
            id={it.commandId ?? key}
            label={label}
            shortcut={shortcut}
            disabled={!enabled}
            checked={checked}
            onSelect={() => {
              if (it.commandId) void getCommandSystem().execute(asCommandId(it.commandId));
              else it.onSelect?.();
              onActivate();
            }}
          />
        );
      })}
    </>
  );
}
