/**
 * Dropdown — a button that opens a Menu in a popover.
 *
 *   <Dropdown
 *     trigger={<Button>File</Button>}
 *     items={[
 *       { type: 'item', id: 'open', label: 'Open', icon: 'folder', onSelect: open },
 *       { type: 'separator' },
 *       { type: 'item', id: 'quit', label: 'Quit', onSelect: quit },
 *     ]}
 *   />
 */

import { type ReactElement, type ReactNode, useState } from 'react';
import { Popover } from '@components/Popover';
import { Menu, MenuItem, MenuSeparator, MenuLabel, MenuCheckbox, MenuCustomRow, type MenuSelectModifiers } from '@components/Menu';
import type { IconName } from '@components/Icon';

export type DropdownItem =
  | { type: 'item'; id: string; label: ReactNode; icon?: IconName; shortcut?: string; disabled?: boolean; danger?: boolean; onSelect?: (modifiers: MenuSelectModifiers) => void; submenu?: DropdownItem[] }
  | { type: 'separator' }
  | { type: 'label'; label: ReactNode }
  | { type: 'checkbox'; id: string; label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }
  /**
   * A row that is not a command: a slider, a swatch strip, a readout. The
   * node is rendered as-is inside the menu's padding, so it should size
   * itself like a row (`--control-height-row`) and carry its own label.
   * Not focusable by the menu's arrow keys unless the node itself is.
   */
  | { type: 'custom'; id: string; render: ReactNode };

export interface DropdownProps {
  trigger: ReactElement;
  /**
   * The menu, or a function that builds it. Either way the rows are only
   * turned into elements while the menu is OPEN: a closed dropdown used to
   * create every item element on each render, and a timeline row carries a
   * Parent menu listing every layer in the comp — 2,000 layers × 40 visible
   * rows made adding one layer take seconds. A function defers building the
   * list itself as well.
   */
  items: ReadonlyArray<DropdownItem> | (() => ReadonlyArray<DropdownItem>);
  placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'right-start' | 'left-start';
  offset?: { x: number; y: number };
  className?: string;
  /** When true, removes the max-height cap so all items show without scrolling. */
  noScroll?: boolean;
}

const NO_ITEMS: ReadonlyArray<DropdownItem> = [];

export function Dropdown({ trigger, items: itemsProp, placement = 'bottom-start', offset, className, noScroll }: DropdownProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const items = open ? (typeof itemsProp === 'function' ? itemsProp() : itemsProp) : NO_ITEMS;

  const handleSelect = (onSelect?: (modifiers: MenuSelectModifiers) => void) => {
    return (modifiers: MenuSelectModifiers) => {
      onSelect?.(modifiers);
      setOpen(false);
    };
  };

  return (
    <Popover
      trigger={trigger}
      placement={placement}
      offset={offset}
      className={className}
      closeOnOutside
      closeOnEscape
      bare
      open={open}
      onOpenChange={setOpen}
    >
      <Menu noScroll={noScroll}>
        {items.map((item, idx) => {
          if (item.type === 'separator') return <MenuSeparator key={`sep_${idx}`} />;
          if (item.type === 'label') return <MenuLabel key={`label_${idx}`}>{item.label}</MenuLabel>;
          if (item.type === 'custom') return <MenuCustomRow key={item.id} id={item.id}>{item.render}</MenuCustomRow>;
          if (item.type === 'checkbox') {
            return (
              <MenuCheckbox
                key={item.id}
                id={item.id}
                label={item.label}
                checked={item.checked}
                onChange={item.onChange}
                disabled={item.disabled}
              />
            );
          }
          if (item.submenu) {
            return (
              <MenuItem key={item.id} id={item.id} label={item.label} icon={item.icon} shortcut={item.shortcut} disabled={item.disabled} danger={item.danger} onSelect={handleSelect(item.onSelect)}>
                {item.submenu.map((sub, subIdx) => {
                  if (sub.type === 'separator') return <MenuSeparator key={`sep_${item.id}_${subIdx}`} />;
                  if (sub.type === 'label') return <MenuLabel key={`label_${item.id}_${subIdx}`}>{sub.label}</MenuLabel>;
                  if (sub.type === 'custom') return <MenuCustomRow key={sub.id} id={sub.id}>{sub.render}</MenuCustomRow>;
                  if (sub.type === 'checkbox') {
                    return (
                      <MenuCheckbox key={sub.id} id={sub.id} label={sub.label} checked={sub.checked} onChange={sub.onChange} disabled={sub.disabled} />
                    );
                  }
                  return (
                    <MenuItem key={sub.id} id={sub.id} label={sub.label} icon={sub.icon} shortcut={sub.shortcut} disabled={sub.disabled} danger={sub.danger} onSelect={handleSelect(sub.onSelect)} />
                  );
                })}
              </MenuItem>
            );
          }
          return (
            <MenuItem
              key={item.id}
              id={item.id}
              label={item.label}
              icon={item.icon}
              shortcut={item.shortcut}
              disabled={item.disabled}
              danger={item.danger}
              onSelect={handleSelect(item.onSelect)}
            />
          );
        })}
      </Menu>
    </Popover>
  );
}
