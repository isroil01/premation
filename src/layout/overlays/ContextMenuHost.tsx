/**
 * ContextMenuHost — renders the active context menu from contextMenuStore at
 * the requested point, using the Menu component. Closes on outside pointerdown,
 * Escape, or item activation. Clamps to the viewport.
 */

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Menu, MenuItem, MenuSeparator } from '@components/Menu';
import { useContextMenuStore } from '@stores/contextMenuStore';
import styles from './overlays.module.css';

const MENU_MIN_WIDTH = 200;
const MENU_EST_ROW = 30;

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
      if (ref.current && !ref.current.contains(e.target as Node)) close();
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
      <Menu onItemActivate={close}>
        {items.map((it) =>
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
            />
          ),
        )}
      </Menu>
    </div>,
    document.body,
  );
}
