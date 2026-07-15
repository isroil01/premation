/**
 * ContextMenuHost — renders the active context menu from contextMenuStore at
 * the requested point, using the Menu component. Closes on outside pointerdown,
 * Escape, or item activation. Clamps to the viewport.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Menu, MenuItem, MenuSeparator } from '@components/Menu';
import { useContextMenuStore, type ContextMenuItem } from '@stores/contextMenuStore';
import styles from './overlays.module.css';

const MENU_MIN_WIDTH = 200;
const MENU_EST_ROW = 30;

/** Render items (recursively for submenus — Menu handles nesting/portals). */
function renderItems(items: ReadonlyArray<ContextMenuItem>): ReactNode {
  return items.map((it) =>
    it.separator ? (
      <MenuSeparator key={it.id} />
    ) : (
      <MenuItem
        key={it.id}
        id={it.id}
        label={it.label}
        icon={it.icon}
        shortcut={it.shortcut}
        disabled={it.disabled}
        danger={it.danger}
        onSelect={it.onSelect}
      >
        {it.children && it.children.length > 0 ? renderItems(it.children) : undefined}
      </MenuItem>
    ),
  );
}

export function ContextMenuHost(): JSX.Element | null {
  const open = useContextMenuStore((s) => s.open);
  const x = useContextMenuStore((s) => s.x);
  const y = useContextMenuStore((s) => s.y);
  const items = useContextMenuStore((s) => s.items);
  const close = useContextMenuStore((s) => s.close);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      // Submenus portal to document.body (outside `ref`), so also keep the
      // menu open for pointerdowns inside any open menu popup.
      const t = e.target as Element | null;
      if (ref.current && !ref.current.contains(e.target as Node) && !t?.closest('[role="menu"]')) {
        close();
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, close]);

  if (!open) return null;

  const left = Math.min(x, window.innerWidth - MENU_MIN_WIDTH - 8);
  const estHeight = items.length * MENU_EST_ROW + 12;
  const top = Math.min(y, Math.max(8, window.innerHeight - estHeight - 8));

  return createPortal(
    <div ref={ref} className={styles.contextMenu} style={{ left, top }}>
      <Menu onItemActivate={close}>{renderItems(items)}</Menu>
    </div>,
    document.body,
  );
}
