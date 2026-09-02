/**
 * AppMenuBar — the classic desktop menu bar (File / Edit / Composition / Layer /
 * Effect / Animation / View / Window / Plugins / Help — the static groups come
 * from APP_MENU in menuModel, Plugins is built per render from what is
 * installed; see useAppMenuGroups).
 *
 * There is no Examples group. Demo scenes used to replace the open document
 * from the command palette; that path is gone.
 *
 * Purely a renderer over the menu model + CommandRegistry: labels, enabled
 * state and shortcuts come from the registered commands, activation goes
 * through the CommandSystem. Hovering between open groups switches menus, as
 * in a native menu bar.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Menu } from '@components/Menu';
import { useAppMenuGroups } from './useAppMenuGroups';
import { anchorMenuTo } from './menuAnchor';
import { MenuModelItems } from './MenuModelItems';
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
    // Shared with AppMenuButton: left-aligned under the group, clamped to the
    // window — the rightmost groups (Window, Help) would otherwise open past
    // the right edge on a narrow window.
    setAnchor(anchorMenuTo(btn.getBoundingClientRect()));
    setOpenGroup(groupId);
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
              <Menu noScroll onItemActivate={() => setOpenGroup(null)}>
                <MenuModelItems items={group.items} onActivate={() => setOpenGroup(null)} />
              </Menu>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
