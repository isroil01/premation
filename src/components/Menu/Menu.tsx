/**
 * Menu — vertical list of actions. Used standalone or inside Dropdown/Popover.
 *
 * Supports:
 *   - MenuItem (button), with icon, label, shortcut, disabled, danger
 *   - MenuSeparator
 *   - MenuLabel (group title)
 *   - MenuCheckbox (toggle item)
 *   - Submenus (SubMenu opens a nested menu to the right)
 *
 * Keyboard:
 *   - Arrow Up/Down moves focus
 *   - Arrow Right opens submenu, Left closes
 *   - Enter/Space activates
 *   - Home/End jump to first/last
 *   - Escape closes the parent popover
 */

import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@utils/cn';
import { Icon, type IconName } from '@components/Icon';
import { positionPopover, type Placement } from '@hooks/positionPopover';
import styles from './Menu.module.css';

interface MenuContextValue {
  close: () => void;
  closeParent: () => void;
  openSubMenu: (id: string) => void;
  closeSubMenu: (id: string) => void;
  /** Inherited by portaled submenus so a context menu cannot grow a scrollbar
   *  on Arrange / Label Color / Merge Paths while the root stays un-scrolled. */
  noScroll: boolean;
  spacious: boolean;
}

const MenuContext = createContext<MenuContextValue | null>(null);

// ── Root Menu ──────────────────────────────────────────────────────

export interface MenuProps {
  children: ReactNode;
  className?: string;
  /** Called when an item activates. Useful for closing the parent popover. */
  onItemActivate?: () => void;
  /** Optional: take over the role/aria for menu (default true). */
  ariaLabel?: string;
  /** When true, removes the max-height cap and shows all items without scrolling. */
  noScroll?: boolean;
  /** Extra padding and row spacing. Context menus, not compact toolbar dropdowns. */
  spacious?: boolean;
}

export function Menu({ children, className, onItemActivate, ariaLabel, noScroll, spacious }: MenuProps): JSX.Element {
  const parent = useContext(MenuContext);
  const resolvedNoScroll = noScroll ?? parent?.noScroll ?? false;
  const resolvedSpacious = spacious ?? parent?.spacious ?? false;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const subMenuOpen = useRef<Set<string>>(new Set());
  const [, force] = useState(0);

  const close = (): void => onItemActivate?.();
  const closeParent = (): void => onItemActivate?.();

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!rootRef.current) return;
    /*
      Skip items that cannot take focus.

      This filtered on `aria-disabled` only — and nothing in this file ever SETS
      aria-disabled. `MenuItem` renders the native `disabled` attribute, so
      disabled entries stayed in this list, and `.focus()` on a natively
      disabled button is a silent no-op: arrow-key navigation STOPPED dead on
      the first greyed-out entry. In File that is "Sync Project…", which is
      disabled whenever no bundle project is open — so Export… and Close
      Project below it could not be reached by keyboard at all.

      Both selectors, so this stays correct if an item ever opts for the
      aria-disabled form (which stays focusable) instead.
    */
    const items = Array.from(
      rootRef.current.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([aria-disabled="true"]):not([disabled]),' +
        '[role="menuitemcheckbox"]:not([aria-disabled="true"]):not([disabled])',
      ),
    );
    if (items.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const i = active ? items.indexOf(active) : 0;
    const safe = (n: number): HTMLElement => items[Math.max(0, Math.min(n, items.length - 1))]!;
    if (e.key === 'ArrowDown') { e.preventDefault(); safe(i + 1).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); safe(i - 1).focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0]!.focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1]!.focus(); }
  };

  const ctx: MenuContextValue = {
    close,
    closeParent,
    openSubMenu: (id) => { subMenuOpen.current.add(id); force((n) => n + 1); },
    closeSubMenu: (id) => { subMenuOpen.current.delete(id); force((n) => n + 1); },
    noScroll: resolvedNoScroll,
    spacious: resolvedSpacious,
  };

  return (
    <MenuContext.Provider value={ctx}>
      <div
        ref={rootRef}
        role="menu"
        aria-label={ariaLabel}
        className={cn(
          styles.menu,
          resolvedNoScroll && styles.noScroll,
          resolvedSpacious && styles.spacious,
          className,
        )}
        onKeyDown={onKeyDown}
      >
        {Children.map(children, (child) => child)}
      </div>
    </MenuContext.Provider>
  );
}

// ── MenuItem ───────────────────────────────────────────────────────

export interface MenuItemProps {
  id: string;
  label: ReactNode;
  icon?: IconName;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  /**
   * Toggle state, for an item that turns something on and off.
   *
   * `undefined` = not a toggle, and the item keeps `role="menuitem"`. A boolean
   * makes it a `menuitemcheckbox` with `aria-checked`, so the state is
   * announced rather than only drawn — a tick that exists solely as a glyph is
   * invisible to a screen reader.
   *
   * The tick occupies the ICON gutter, replacing the command's own icon while
   * checked. Menus already reserve that gutter for every item (see
   * `itemIconSpacer`), so nothing shifts as the state changes.
   */
  checked?: boolean;
  onSelect?: () => void;
  /** Submenu children render in a portal anchored to this item. */
  children?: ReactNode;
}

export function MenuItem({
  id,
  label,
  icon,
  shortcut,
  disabled = false,
  danger = false,
  checked,
  onSelect,
  children,
}: MenuItemProps): JSX.Element {
  const ctx = useContext(MenuContext);
  const ref = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const subRef = useRef<HTMLDivElement | null>(null);
  const [subCoords, setSubCoords] = useState<{ top: number; left: number; placement: Placement } | null>(null);
  const [subOpen, setSubOpen] = useState(false);

  // Closing the submenu on a bare pointer-leave is too eager: there's a small
  // gap between the trigger and the submenu (see positionPopover GAP), and
  // crossing it fires pointerleave before the cursor reaches the submenu.
  // Defer the close so an incoming pointer (on the item OR the submenu) cancels it.
  const closeTimer = useRef<number | null>(null);
  const cancelClose = (): void => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const openSub = (): void => { cancelClose(); setSubOpen(true); };
  const scheduleCloseSub = (): void => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setSubOpen(false), 140);
  };
  useEffect(() => cancelClose, []);

  useEffect(() => {
    if (!subOpen || !triggerRef.current || !subRef.current) return;
    setSubCoords(positionPopover(triggerRef.current, subRef.current, 'right-start'));
    const onScroll = (): void => {
      if (triggerRef.current && subRef.current) {
        setSubCoords(positionPopover(triggerRef.current, subRef.current, 'right-start'));
      }
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [subOpen]);

  const onClick = (): void => {
    if (disabled) return;
    if (children) {
      setSubOpen((s) => !s);
      return;
    }
    onSelect?.();
    ctx?.closeParent();
  };

  const onKey = (e: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (disabled) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    } else if (e.key === 'ArrowRight' && children) {
      e.preventDefault();
      setSubOpen(true);
    } else if (e.key === 'ArrowLeft' && children) {
      e.preventDefault();
      setSubOpen(false);
    }
  };

  return (
    <>
      <button
        ref={(el) => { ref.current = el; triggerRef.current = el; }}
        id={id}
        type="button"
        role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
        aria-checked={checked}
        aria-haspopup={children ? 'menu' : undefined}
        aria-expanded={children ? subOpen : undefined}
        disabled={disabled}
        className={cn(styles.item, danger && styles.danger, subOpen && styles.subOpen)}
        onClick={onClick}
        onKeyDown={onKey}
        onPointerEnter={() => { if (children) openSub(); }}
        onPointerLeave={() => { if (children) scheduleCloseSub(); }}
      >
        {checked
          ? <Icon name="check" size="md" className={styles.itemIcon} />
          : icon ? <Icon name={icon} size="md" className={styles.itemIcon} /> : <span className={styles.itemIconSpacer} />}
        <span className={styles.itemLabel}>{label}</span>
        {shortcut ? <span className={styles.itemShortcut}>{shortcut}</span> : null}
        {children ? <Icon name="chevron-right" size="sm" className={styles.itemChevron} /> : null}
      </button>
      {subOpen && children ? createPortal(
        <div
          ref={subRef}
          className={styles.subMenuWrapper}
          data-menu-portal=""
          data-placement={subCoords?.placement ?? 'right-start'}
          style={subCoords ? { top: subCoords.top, left: subCoords.left } : undefined}
          onPointerEnter={openSub}
          onPointerLeave={scheduleCloseSub}
        >
          <Menu
            ariaLabel={typeof label === 'string' ? label : undefined}
            onItemActivate={() => { setSubOpen(false); ctx?.closeParent(); }}
          >
            {children}
          </Menu>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

// ── MenuSeparator ──────────────────────────────────────────────────

export function MenuSeparator(): JSX.Element {
  return <div role="separator" className={styles.separator} />;
}

// ── MenuLabel ──────────────────────────────────────────────────────

export function MenuLabel({ children }: { children: ReactNode }): JSX.Element {
  return <div className={styles.label}>{children}</div>;
}

// ── MenuCheckbox ───────────────────────────────────────────────────

export interface MenuCheckboxProps {
  id: string;
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function MenuCheckbox({ id, label, checked, onChange, disabled = false }: MenuCheckboxProps): JSX.Element {
  const onKey = (e: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (disabled) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onChange(!checked);
    }
  };
  return (
    <button
      id={id}
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      disabled={disabled}
      className={cn(styles.item, checked && styles.checked, disabled && styles.disabled)}
      onClick={() => { if (!disabled) onChange(!checked); }}
      onKeyDown={onKey}
    >
      <span className={cn(styles.itemIconSpacer, checked && styles.itemIconActive)}>
        {checked ? <Icon name="check" size="sm" /> : null}
      </span>
      <span className={cn(styles.itemLabel, checked && styles.itemLabelActive)}>{label}</span>
    </button>
  );
}

// ── ContextMenu (right-click) ──────────────────────────────────────

export interface ContextMenuProps {
  /** When the user right-clicks on the children. */
  children: ReactElement;
  menu: (close: () => void) => ReactNode;
  className?: string;
}

export function ContextMenu({ children, menu, className }: ContextMenuProps): JSX.Element {
  const [coords, setCoords] = useState<{ x: number; y: number } | null>(null);
  const subRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!coords) return;
    requestAnimationFrame(() => {
      if (!subRef.current) return;
      const w = subRef.current.offsetWidth;
      const h = subRef.current.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let x = coords.x;
      let y = coords.y;
      if (x + w > vw) x = vw - w - 4;
      if (y + h > vh) y = vh - h - 4;
      setPos({ top: y, left: x });
    });
  }, [coords]);

  useEffect(() => {
    if (!coords) return;
    const onDown = (e: PointerEvent): void => {
      if (subRef.current?.contains(e.target as Node)) return;
      setCoords(null);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setCoords(null);
    };
    const id = window.setTimeout(() => {
      window.addEventListener('pointerdown', onDown);
      window.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [coords]);

  const cloned = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        onContextMenu: (e: React.MouseEvent) => {
          e.preventDefault();
          setCoords({ x: e.clientX, y: e.clientY });
        },
      })
    : children;

  return (
    <>
      {cloned}
      {coords ? createPortal(
        <div
          ref={subRef}
          data-menu-portal=""
          className={cn(styles.contextWrapper, className)}
          style={pos ? { top: pos.top, left: pos.left } : { top: coords.y, left: coords.x, visibility: 'hidden' }}
        >
          <Menu noScroll spacious onItemActivate={() => setCoords(null)}>
            {menu(() => setCoords(null))}
          </Menu>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
