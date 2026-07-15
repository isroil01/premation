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
import { Menu, MenuItem, MenuSeparator, MenuLabel, MenuCheckbox } from '@components/Menu';
import type { IconName } from '@components/Icon';

export type DropdownItem =
  | { type: 'item'; id: string; label: ReactNode; icon?: IconName; shortcut?: string; disabled?: boolean; danger?: boolean; onSelect?: () => void; submenu?: DropdownItem[] }
  | { type: 'separator' }
  | { type: 'label'; label: ReactNode }
  | { type: 'checkbox'; id: string; label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean };

export interface DropdownProps {
  trigger: ReactElement;
  items: ReadonlyArray<DropdownItem>;
  placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'right-start' | 'left-start';
  className?: string;
}

export function Dropdown({ trigger, items, placement = 'bottom-start', className }: DropdownProps): JSX.Element {
  const [open, setOpen] = useState(false);

  const handleSelect = (onSelect?: () => void) => {
    return () => {
      onSelect?.();
      setOpen(false);
    };
  };

  return (
    <Popover
      trigger={trigger}
      placement={placement}
      className={className}
      closeOnOutside
      closeOnEscape
      bare
      open={open}
      onOpenChange={setOpen}
    >
      <Menu>
        {items.map((item, idx) => {
          if (item.type === 'separator') return <MenuSeparator key={`sep_${idx}`} />;
          if (item.type === 'label') return <MenuLabel key={`label_${idx}`}>{item.label}</MenuLabel>;
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
