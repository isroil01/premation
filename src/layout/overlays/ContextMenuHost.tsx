/**
 * ContextMenuHost — renders the active context menu from contextMenuStore at
 * the requested point, using the Menu component. Closes on outside pointerdown,
 * Escape, or item activation. Clamps to the viewport.
 *
 * Scene / canvas right-click lists are long. The shared Menu defaults to a
 * 280px scroller; context menus opt out of that so every item is visible, and
 * we measure the real box after paint so a tall menu still stays on screen.
 */

import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Menu, MenuItem, MenuSeparator } from '@components/Menu';
import { useContextMenuStore, type ContextMenuItem } from '@stores/contextMenuStore';
import styles from './overlays.module.css';

const VIEW_PAD = 8;

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

function clampToViewport(el: HTMLElement, x: number, y: number): void {
  const menu = (el.querySelector('[role="menu"]') as HTMLElement | null) ?? el;
  menu.style.maxHeight = '';
  menu.style.overflowY = '';
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const maxH = vh - VIEW_PAD * 2;
  if (menu.scrollHeight > maxH) {
    menu.style.maxHeight = `${maxH}px`;
    menu.style.overflowY = 'auto';
  }
  const { width, height } = el.getBoundingClientRect();
  let left = x;
  let top = y;
  if (left + width > vw - VIEW_PAD) left = Math.max(VIEW_PAD, vw - width - VIEW_PAD);
  if (top + height > vh - VIEW_PAD) top = Math.max(VIEW_PAD, vh - height - VIEW_PAD);
  if (left < VIEW_PAD) left = VIEW_PAD;
  if (top < VIEW_PAD) top = VIEW_PAD;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

export function ContextMenuHost(): JSX.Element | null {
  const open = useContextMenuStore((s) => s.open);
  const x = useContextMenuStore((s) => s.x);
  const y = useContextMenuStore((s) => s.y);
  const items = useContextMenuStore((s) => s.items);
  const close = useContextMenuStore((s) => s.close);
  const ref = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    clampToViewport(ref.current, x, y);
  }, [open, x, y, items]);

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

  return createPortal(
    <div ref={ref} className={styles.contextMenu} style={{ left: x, top: y }}>
      <Menu noScroll spacious onItemActivate={close}>{renderItems(items)}</Menu>
    </div>,
    document.body,
  );
}
