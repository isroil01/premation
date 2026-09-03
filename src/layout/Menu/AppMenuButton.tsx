/**
 * AppMenuButton — a compact menu affordance for the minimal top strip.
 * Opens the full application menu (File / Edit / View / Help) as nested
 * submenus, so the menu system stays available without a visible menu bar.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Menu, MenuItem } from '@components/Menu';
import { IconButton } from '@components/IconButton';
import { Icon } from '@components/Icon';
import { useAppMenuGroups } from './useAppMenuGroups';
import { anchorMenuTo } from './menuAnchor';
import { MenuModelItems } from './MenuModelItems';
import styles from './AppMenuBar.module.css';

export function AppMenuButton(): JSX.Element {
  // Includes the dynamic Plugins group — see useAppMenuGroups.
  const menuGroups = useAppMenuGroups();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      if (document.getElementById('app-menu-dropdown')?.contains(target)) return;
      // Submenus render in their own portal on document.body (a sibling of the
      // dropdown, not a descendant), so contains misses them. Without this,
      // pressing a submenu item closes the menu before its click can fire.
      if ((target as Element).closest?.('[data-menu-portal]')) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const toggle = (e: React.MouseEvent<HTMLElement>): void => {
    if (open) { setOpen(false); return; }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // Was `left: r.right - 220` — right-aligned to the trigger, which put the
    // whole menu at left: -186px given where TopNav mounts this button. See
    // anchorMenuTo.
    setAnchor(anchorMenuTo(r));
    setOpen(true);
  };

  return (
    <div ref={ref} style={{ display: 'inline-flex' }}>
      <IconButton aria-label="Menu" size="md" active={open} onClick={toggle}>
        <Icon name="menu" size="md" />
      </IconButton>
      {open && anchor
        ? createPortal(
            <div id="app-menu-dropdown" className={styles.dropdown} style={{ left: anchor.left, top: anchor.top }}>
              <Menu noScroll onItemActivate={() => setOpen(false)}>
                {menuGroups.map((group) => (
                  <MenuItem key={group.id} id={group.id} label={group.label}>
                    <MenuModelItems
                      items={group.items}
                      onActivate={() => setOpen(false)}
                      keyPrefix={`${group.id}/`}
                    />
                  </MenuItem>
                ))}
              </Menu>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
