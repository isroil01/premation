/**
 * AppMenuButton — a compact menu affordance for the minimal top strip.
 * Opens the full application menu (File / Edit / View / Help) as nested
 * submenus, so the menu system stays available without a visible menu bar.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Menu, MenuItem, MenuSeparator } from '@components/Menu';
import { IconButton } from '@components/IconButton';
import { Icon } from '@components/Icon';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { getCommandRegistry } from '@core/commands/Command';
import { asCommandId } from '@app-types/common';
import { APP_MENU } from './menuModel';
import { formatChord } from './formatChord';
import styles from './AppMenuBar.module.css';

export function AppMenuButton(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      if (document.getElementById('app-menu-dropdown')?.contains(target)) return;
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
    setAnchor({ left: r.right - 220, top: r.bottom + 4 });
    setOpen(true);
  };

  const run = (commandId: string): void => {
    void getCommandSystem().execute(asCommandId(commandId));
    setOpen(false);
  };

  return (
    <div ref={ref} style={{ display: 'inline-flex' }}>
      <IconButton aria-label="Menu" size="md" active={open} onClick={toggle}>
        <Icon name="menu" size={14} />
      </IconButton>
      {open && anchor
        ? createPortal(
            <div id="app-menu-dropdown" className={styles.dropdown} style={{ left: anchor.left, top: anchor.top }}>
              <Menu onItemActivate={() => setOpen(false)}>
                {APP_MENU.map((group) => (
                  <MenuItem key={group.id} id={group.id} label={group.label}>
                    {group.items.map((it, i) => {
                      if (it.separator) return <MenuSeparator key={`sep-${i}`} />;
                      const cmd = it.commandId ? getCommandRegistry().get(asCommandId(it.commandId)) : undefined;
                      const enabled = cmd?.enabled ? cmd.enabled() : true;
                      const label = it.label ?? cmd?.label ?? it.commandId ?? '';
                      const shortcut = cmd?.shortcut ? formatChord(cmd.shortcut) : undefined;
                      return (
                        <MenuItem
                          key={it.commandId ?? i}
                          id={it.commandId ?? String(i)}
                          label={label}
                          shortcut={shortcut}
                          disabled={!enabled}
                          onSelect={() => it.commandId && run(it.commandId)}
                        />
                      );
                    })}
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
