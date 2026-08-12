/**
 * AppMenuBar — the classic desktop menu bar (File / Edit / Composition / Layer /
 * Effect / Animation / View / Window / Plugins / Help — the static groups come
 * from APP_MENU in menuModel, Plugins is built per render from what is
 * installed; see useAppMenuGroups).
 *
 * There is no Examples group, though this list used to claim one. The two
 * example-scene commands (`scene.loadSaaSAd`, `scene.loadShowcase`) are
 * registered and reachable from the Command Palette; they stay off the menu bar
 * deliberately, because both REPLACE the current scene and a top-level menu is
 * a lot of prominence for two demo documents.
 *
 * Purely a renderer over the menu model + CommandRegistry: labels, enabled
 * state and shortcuts come from the registered commands, activation goes
 * through the CommandSystem. Hovering between open groups switches menus, as
 * in a native menu bar.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Menu, MenuItem, MenuSeparator } from '@components/Menu';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { getCommandRegistry } from '@core/commands/Command';
import { asCommandId } from '@app-types/common';
import { useAppMenuGroups } from './useAppMenuGroups';
import { formatChord } from './formatChord';
import { resolveChord, getShortcutOverrides } from '@core/commands/shortcutOverrides';
import styles from './AppMenuBar.module.css';

export function AppMenuBar(): JSX.Element {
  // Not the static APP_MENU: the Plugins group is assembled from what the user
  // installed and rebuilds as plugins start, stop and crash.
  const menuGroups = useAppMenuGroups();
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!openGroup) return;
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Node;
      if (barRef.current?.contains(target)) return;
      if (document.getElementById('app-menu-dropdown')?.contains(target)) return;
      setOpenGroup(null);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpenGroup(null);
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [openGroup]);

  const openAt = (groupId: string, btn: HTMLElement): void => {
    const r = btn.getBoundingClientRect();
    setAnchor({ left: r.left, top: r.bottom + 2 });
    setOpenGroup(groupId);
  };

  const run = (commandId: string): void => {
    void getCommandSystem().execute(asCommandId(commandId));
    setOpenGroup(null);
  };

  const group = menuGroups.find((g) => g.id === openGroup) ?? null;

  return (
    <div className={styles.bar} ref={barRef}>
      {menuGroups.map((g) => (
        <button
          key={g.id}
          type="button"
          className={openGroup === g.id ? styles.groupActive : styles.group}
          onClick={(e) => (openGroup === g.id ? setOpenGroup(null) : openAt(g.id, e.currentTarget))}
          onPointerEnter={(e) => {
            if (openGroup && openGroup !== g.id) openAt(g.id, e.currentTarget);
          }}
        >
          {g.label}
        </button>
      ))}

      {group && anchor
        ? createPortal(
            <div id="app-menu-dropdown" className={styles.dropdown} style={{ left: anchor.left, top: anchor.top }}>
              <Menu onItemActivate={() => setOpenGroup(null)}>
                {group.items.map((it, i) => {
                  if (it.separator) return <MenuSeparator key={`sep-${i}`} />;
                  const cmd = it.commandId ? getCommandRegistry().get(asCommandId(it.commandId)) : undefined;
                  // An UNREGISTERED command renders disabled — an enabled item
                  // whose click silently no-ops (execute on an unknown id)
                  // reads as broken; greyed-out reads as "not available".
                  const enabled = cmd ? (cmd.enabled ? cmd.enabled() : true) : false;
                  // A toggle's CURRENT state. `Command.isChecked` was declared
                  // on the interface and read by nothing, so "Show Grid" looked
                  // identical whether the grid was on or off — the menu could
                  // tell you an action existed but not what it would do.
                  // `undefined` for a non-toggle keeps role="menuitem".
                  const checked = cmd?.isChecked?.();
                  const label = it.label ?? cmd?.label ?? it.commandId ?? '';
                  const resolvedChord = cmd ? resolveChord(cmd.id as unknown as string, cmd.shortcut, getShortcutOverrides()) : undefined;
                  const shortcut = resolvedChord ? formatChord(resolvedChord) : undefined;
                  return (
                    <MenuItem
                      key={it.commandId ?? i}
                      id={it.commandId ?? String(i)}
                      label={label}
                      shortcut={shortcut}
                      disabled={!enabled}
                      checked={checked}
                      onSelect={() => it.commandId && run(it.commandId)}
                    />
                  );
                })}
              </Menu>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
